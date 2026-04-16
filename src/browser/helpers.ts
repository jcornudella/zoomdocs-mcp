const API_REPLAY_HEADER_NAMES = [
  'authorization',
  'x-zm-device-tracking-id',
  'x-zm-docs-container',
  'x-zm-docs-loading',
  'x-zm-cluster-id',
  'origin',
  'referer',
  'x-requested-with',
] as const;

function isDocsHostname(hostname: string): boolean {
  return hostname === 'docs.zoom.us' || hostname.endsWith('docs.zoom.us');
}

function normalizeDocsOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    return isDocsHostname(url.hostname) ? url.origin : null;
  } catch {
    const domain = trimmed.replace(/^\./, '');
    return isDocsHostname(domain) ? `https://${domain}` : null;
  }
}

export function buildApiReplayHeaders(headers: Record<string, string>): Record<string, string> {
  return API_REPLAY_HEADER_NAMES.reduce<Record<string, string>>((acc, name) => {
    const value = headers[name];
    if (value) acc[name] = value;
    return acc;
  }, {});
}

export function buildCandidateDocsOrigins({
  baseUrl,
  pageUrls,
  cookieDomains,
  rememberedOrigins,
}: {
  baseUrl: string;
  pageUrls: string[];
  cookieDomains: string[];
  rememberedOrigins: string[];
}): string[] {
  const candidates = [
    ...pageUrls,
    ...rememberedOrigins,
    ...cookieDomains,
    baseUrl,
  ]
    .map(normalizeDocsOrigin)
    .filter((value): value is string => Boolean(value));

  return [...new Set(candidates)];
}

export function toAbsoluteUrl(baseUrl: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return new URL(path.startsWith('/') ? path : `/${path}`, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

export function parseCsrfTokenResponse(responseText: string): string {
  const [, token = ''] = responseText.split(':');
  return token;
}
