import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  parseSingletonLockTarget,
  removeSingletonLockIfExists,
  resolveSingletonLockState,
  singletonLockPath,
} from '../src/browser/profile-lock.js';

describe('parseSingletonLockTarget', () => {
  it('splits hostname and pid at the last dash', () => {
    expect(parseSingletonLockTarget('mymac.local-12345')).toEqual({
      hostname: 'mymac.local',
      pid: 12345,
    });
  });

  it('handles hostnames that contain dashes', () => {
    expect(parseSingletonLockTarget('joan-mbp-work.local-42')).toEqual({
      hostname: 'joan-mbp-work.local',
      pid: 42,
    });
  });

  it('returns null when the target is malformed', () => {
    expect(parseSingletonLockTarget('')).toBeNull();
    expect(parseSingletonLockTarget('nohostdash')).toBeNull();
    expect(parseSingletonLockTarget('host-')).toBeNull();
    expect(parseSingletonLockTarget('host-abc')).toBeNull();
    expect(parseSingletonLockTarget('host-0')).toBeNull();
  });
});

describe('resolveSingletonLockState', () => {
  async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'zoomdocs-lock-test-'));
    try {
      return await run(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('reports missing when no lock file exists', async () => {
    await withTempDir(async (dir) => {
      const state = await resolveSingletonLockState({ lockPath: singletonLockPath(dir) });
      expect(state).toEqual({ kind: 'missing' });
    });
  });

  it('reports stale when the pid is no longer running', async () => {
    await withTempDir(async (dir) => {
      const lock = singletonLockPath(dir);
      await symlink('some-host-9999999', lock);
      const state = await resolveSingletonLockState({
        lockPath: lock,
        kill: () => {
          const err = new Error('no such process') as NodeJS.ErrnoException;
          err.code = 'ESRCH';
          throw err;
        },
      });
      expect(state).toEqual({
        kind: 'stale',
        target: 'some-host-9999999',
        pid: 9999999,
        hostname: 'some-host',
      });
    });
  });

  it('reports live when the pid is still running', async () => {
    await withTempDir(async (dir) => {
      const lock = singletonLockPath(dir);
      await symlink('some-host-4242', lock);
      const state = await resolveSingletonLockState({
        lockPath: lock,
        kill: () => undefined,
      });
      expect(state).toEqual({
        kind: 'live',
        target: 'some-host-4242',
        pid: 4242,
        hostname: 'some-host',
      });
    });
  });

  it('treats EPERM as live (process owned by another user)', async () => {
    await withTempDir(async (dir) => {
      const lock = singletonLockPath(dir);
      await symlink('some-host-77', lock);
      const state = await resolveSingletonLockState({
        lockPath: lock,
        kill: () => {
          const err = new Error('perm') as NodeJS.ErrnoException;
          err.code = 'EPERM';
          throw err;
        },
      });
      expect(state.kind).toBe('live');
    });
  });

  it('reports unparsable when the lock target does not match the expected shape', async () => {
    await withTempDir(async (dir) => {
      const lock = singletonLockPath(dir);
      await symlink('garbage', lock);
      const state = await resolveSingletonLockState({ lockPath: lock });
      expect(state).toEqual({ kind: 'unparsable', target: 'garbage' });
    });
  });
});

describe('removeSingletonLockIfExists', () => {
  async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'zoomdocs-lock-rm-test-'));
    try {
      return await run(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('returns false when nothing is there', async () => {
    await withTempDir(async (dir) => {
      expect(await removeSingletonLockIfExists(singletonLockPath(dir))).toBe(false);
    });
  });

  it('removes symlink locks and returns true', async () => {
    await withTempDir(async (dir) => {
      const lock = singletonLockPath(dir);
      await symlink('anything-1', lock);
      expect(await removeSingletonLockIfExists(lock)).toBe(true);
      expect(await removeSingletonLockIfExists(lock)).toBe(false);
    });
  });

  it('removes regular-file locks too', async () => {
    await withTempDir(async (dir) => {
      const lock = singletonLockPath(dir);
      await writeFile(lock, 'notASymlink', 'utf8');
      expect(await removeSingletonLockIfExists(lock)).toBe(true);
    });
  });
});
