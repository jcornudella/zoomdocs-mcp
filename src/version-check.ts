export const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 1500;
export const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org';

export interface SemverTuple {
  major: number;
  minor: number;
  patch: number;
  prerelease: string;
}

export function parseSemver(version: string): SemverTuple | null {
  const trimmed = version.trim().replace(/^v/, '');
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(trimmed);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? '',
  };
}

export function compareSemver(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return 0;
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

export function isOutdated(current: string, latest: string): boolean {
  return compareSemver(current, latest) < 0;
}

export interface UpdateNotice {
  current: string;
  latest: string;
  packageName: string;
}

export function formatUpdateNotice({ current, latest, packageName }: UpdateNotice): string {
  return (
    `zoomdocs-mcp ${current} is installed, but ${latest} is available. ` +
    `To upgrade, quit Claude Desktop and relaunch it (package mode picks up the latest via npx), ` +
    `or run: npm install -g ${packageName}@${latest}`
  );
}

export interface FetchLatestOptions {
  packageName: string;
  registry?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export async function fetchLatestVersion({
  packageName,
  registry = DEFAULT_NPM_REGISTRY,
  timeoutMs = DEFAULT_VERSION_CHECK_TIMEOUT_MS,
  fetchImpl = fetch,
}: FetchLatestOptions): Promise<string | null> {
  const url = `${registry.replace(/\/$/, '')}/${packageName}/latest`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { version?: unknown };
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface VersionCheckResult {
  current: string;
  latest: string | null;
  outdated: boolean;
  notice: string | null;
}

export async function runVersionCheck({
  packageName,
  currentVersion,
  fetchImpl,
  registry,
  timeoutMs,
}: {
  packageName: string;
  currentVersion: string;
  fetchImpl?: typeof fetch;
  registry?: string;
  timeoutMs?: number;
}): Promise<VersionCheckResult> {
  const latest = await fetchLatestVersion({ packageName, fetchImpl, registry, timeoutMs });
  if (!latest) {
    return { current: currentVersion, latest: null, outdated: false, notice: null };
  }
  const outdated = isOutdated(currentVersion, latest);
  return {
    current: currentVersion,
    latest,
    outdated,
    notice: outdated ? formatUpdateNotice({ current: currentVersion, latest, packageName }) : null,
  };
}
