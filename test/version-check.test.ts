import { describe, expect, it, vi } from 'vitest';

import {
  compareSemver,
  fetchLatestVersion,
  formatUpdateNotice,
  isOutdated,
  parseSemver,
  runVersionCheck,
} from '../src/version-check.js';

describe('parseSemver', () => {
  it('parses major.minor.patch', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: '' });
  });

  it('strips a leading v', () => {
    expect(parseSemver('v0.2.0')).toEqual({ major: 0, minor: 2, patch: 0, prerelease: '' });
  });

  it('captures prerelease tags', () => {
    expect(parseSemver('0.2.0-beta.1')).toEqual({
      major: 0,
      minor: 2,
      patch: 0,
      prerelease: 'beta.1',
    });
  });

  it('returns null for malformed input', () => {
    expect(parseSemver('not a version')).toBeNull();
    expect(parseSemver('1.2')).toBeNull();
  });
});

describe('compareSemver / isOutdated', () => {
  it('orders by major, minor, then patch', () => {
    expect(compareSemver('0.1.9', '0.2.0')).toBe(-1);
    expect(compareSemver('0.2.0', '0.2.0')).toBe(0);
    expect(compareSemver('1.0.0', '0.99.99')).toBe(1);
  });

  it('treats prereleases as lower than stable', () => {
    expect(compareSemver('0.2.0-beta.1', '0.2.0')).toBe(-1);
    expect(compareSemver('0.2.0', '0.2.0-beta.1')).toBe(1);
  });

  it('flags outdated when current < latest', () => {
    expect(isOutdated('0.1.1', '0.2.0')).toBe(true);
    expect(isOutdated('0.2.0', '0.2.0')).toBe(false);
    expect(isOutdated('0.3.0', '0.2.0')).toBe(false);
  });
});

describe('formatUpdateNotice', () => {
  it('includes both versions and the upgrade hint', () => {
    const notice = formatUpdateNotice({
      current: '0.1.1',
      latest: '0.2.0',
      packageName: '@jcornudella/zoomdocs-mcp',
    });
    expect(notice).toContain('0.1.1');
    expect(notice).toContain('0.2.0');
    expect(notice).toContain('@jcornudella/zoomdocs-mcp');
    expect(notice).toContain('Claude Desktop');
  });
});

describe('fetchLatestVersion', () => {
  it('returns the version field from the /latest registry endpoint', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ version: '0.2.0' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    const version = await fetchLatestVersion({
      packageName: '@jcornudella/zoomdocs-mcp',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(version).toBe('0.2.0');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://registry.npmjs.org/@jcornudella/zoomdocs-mcp/latest',
      expect.objectContaining({ headers: { accept: 'application/json' } })
    );
  });

  it('returns null when the registry responds with an error', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }));
    const version = await fetchLatestVersion({
      packageName: 'pkg',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(version).toBeNull();
  });

  it('returns null when fetch throws (network / timeout)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    const version = await fetchLatestVersion({
      packageName: 'pkg',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(version).toBeNull();
  });

  it('returns null when the body does not contain a version string', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ notVersion: true }), { status: 200 })
    );
    const version = await fetchLatestVersion({
      packageName: 'pkg',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(version).toBeNull();
  });
});

describe('runVersionCheck', () => {
  it('produces a notice when outdated', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ version: '0.2.0' }), { status: 200 })
    );
    const result = await runVersionCheck({
      packageName: '@jcornudella/zoomdocs-mcp',
      currentVersion: '0.1.1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({
      current: '0.1.1',
      latest: '0.2.0',
      outdated: true,
      notice: expect.stringContaining('0.2.0'),
    });
  });

  it('produces no notice when up to date', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ version: '0.2.0' }), { status: 200 })
    );
    const result = await runVersionCheck({
      packageName: '@jcornudella/zoomdocs-mcp',
      currentVersion: '0.2.0',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.outdated).toBe(false);
    expect(result.notice).toBeNull();
  });

  it('produces no notice when the registry is unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    });
    const result = await runVersionCheck({
      packageName: '@jcornudella/zoomdocs-mcp',
      currentVersion: '0.1.1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({
      current: '0.1.1',
      latest: null,
      outdated: false,
      notice: null,
    });
  });
});
