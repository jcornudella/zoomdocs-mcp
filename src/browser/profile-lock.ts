import { exec } from 'node:child_process';
import { readlink, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export interface ParsedSingletonLock {
  hostname: string;
  pid: number;
}

export type CommandLookup = (pid: number) => Promise<string | null>;

const defaultCommandLookup: CommandLookup = async (pid) => {
  try {
    const { stdout } = await execAsync(`ps -p ${pid} -o command=`, { timeout: 1500 });
    const trimmed = stdout.trim();
    return trimmed || null;
  } catch {
    return null;
  }
};

export function isChromeProcessCommand(command: string | null): boolean {
  if (!command) return false;
  const lower = command.toLowerCase();
  return (
    lower.includes('chrome') ||
    lower.includes('chromium') ||
    lower.includes('playwright')
  );
}

export function parseSingletonLockTarget(target: string): ParsedSingletonLock | null {
  const trimmed = target.trim();
  if (!trimmed) return null;
  const lastDash = trimmed.lastIndexOf('-');
  if (lastDash <= 0 || lastDash === trimmed.length - 1) return null;
  const hostname = trimmed.slice(0, lastDash);
  const pidPart = trimmed.slice(lastDash + 1);
  if (!/^\d+$/.test(pidPart)) return null;
  const pid = Number(pidPart);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  return { hostname, pid };
}

export function isPidAlive(
  pid: number,
  kill: (pid: number, signal: number) => void = process.kill.bind(process)
): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    return false;
  }
}

export type SingletonLockState =
  | { kind: 'missing' }
  | { kind: 'stale'; target: string; pid: number; hostname: string }
  | {
      kind: 'recycled';
      target: string;
      pid: number;
      hostname: string;
      command: string | null;
    }
  | { kind: 'live'; target: string; pid: number; hostname: string; command: string }
  | { kind: 'unparsable'; target: string };

export async function resolveSingletonLockState({
  lockPath,
  kill,
  readLink = readlink,
  lookupCommand = defaultCommandLookup,
}: {
  lockPath: string;
  kill?: (pid: number, signal: number) => void;
  readLink?: (p: string) => Promise<string>;
  lookupCommand?: CommandLookup;
}): Promise<SingletonLockState> {
  let target: string;
  try {
    target = await readLink(lockPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'missing' };
    throw error;
  }

  const parsed = parseSingletonLockTarget(target);
  if (!parsed) return { kind: 'unparsable', target };

  if (!isPidAlive(parsed.pid, kill)) {
    return { kind: 'stale', target, pid: parsed.pid, hostname: parsed.hostname };
  }

  const command = await lookupCommand(parsed.pid);
  if (!isChromeProcessCommand(command)) {
    return {
      kind: 'recycled',
      target,
      pid: parsed.pid,
      hostname: parsed.hostname,
      command,
    };
  }

  return {
    kind: 'live',
    target,
    pid: parsed.pid,
    hostname: parsed.hostname,
    command: command as string,
  };
}

export function singletonLockPath(userDataDir: string): string {
  return path.join(userDataDir, 'SingletonLock');
}

export async function removeSingletonLockIfExists(lockPath: string): Promise<boolean> {
  try {
    await unlink(lockPath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false;
    throw error;
  }
}

export async function userDataDirExists(
  userDataDir: string,
  statFn: typeof stat = stat
): Promise<boolean> {
  try {
    await statFn(userDataDir);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false;
    throw error;
  }
}
