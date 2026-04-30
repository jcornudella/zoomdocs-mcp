export interface CaptureAnalysisExample {
  pathWithQuery: string;
  requestBody: string | null;
  responseBody: string | null;
}

export interface CaptureAnalysisGroup {
  key: string;
  method: string;
  normalizedPath: string;
  count: number;
  statuses: Record<string, number>;
  examples: CaptureAnalysisExample[];
}

export interface CaptureAnalysisResult {
  groups: CaptureAnalysisGroup[];
  httpCount: number;
  websocketCount: number;
  invalidLineCount: number;
}

interface CaptureHttpRecord {
  kind?: string;
  method?: unknown;
  pathWithQuery?: unknown;
  status?: unknown;
  requestBody?: unknown;
  responseBody?: unknown;
}

const ID_QUERY_RE = /([?&][A-Za-z0-9_\-]*(?:file|page|block|database|parent|thread)?Id(?:s%5B%5D)?=)[^&]+/gi;
const TOKEN_QUERY_RE = /([?&](?:auth|token|access_token|refresh_token|id_token|sessionId|signature|zak|zm_aid|zm_haid)=)[^&]+/gi;

function normalizePath(pathWithQuery: string): string {
  return pathWithQuery
    .replace(/\/api\/file\/files\/(?!action\b|title(?:[/?]|$)|user(?:[/?]|$))([^/?]+)/g, '/api/file/files/{id}')
    .replace(/\/api\/(?:page|database|block)\/([^/?]+)/g, (match) => {
      const [prefix] = match.match(/^\/api\/(?:page|database|block)/) ?? [match];
      return `${prefix}/{id}`;
    })
    .replace(/\/api\/user\/file\/([^/?]+)/g, '/api/user/file/{id}')
    .replace(/\/api\/notification\/file\/([^/?]+)/g, '/api/notification/file/{id}')
    .replace(/\/api\/comment\/(?:threads|comments)\/([^/?]+)/g, (match) => {
      const [prefix] = match.match(/^\/api\/comment\/(?:threads|comments)/) ?? [match];
      return `${prefix}/{id}`;
    })
    .replace(ID_QUERY_RE, '$1{id}')
    .replace(TOKEN_QUERY_RE, '$1<redacted>');
}

function toBodyPreview(value: unknown): string | null {
  if (typeof value === 'string') return value.slice(0, 2000);
  if (value == null) return null;
  return JSON.stringify(value).slice(0, 2000);
}

export function analyzeCaptureLines(lines: string[], options: { maxExamplesPerGroup?: number } = {}): CaptureAnalysisResult {
  const maxExamplesPerGroup = options.maxExamplesPerGroup ?? 1;
  const groupsByKey = new Map<string, CaptureAnalysisGroup>();
  let httpCount = 0;
  let websocketCount = 0;
  let invalidLineCount = 0;

  for (const line of lines) {
    if (!line.trim()) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as CaptureHttpRecord;
    } catch {
      invalidLineCount += 1;
      continue;
    }

    if (!parsed || typeof parsed !== 'object') {
      invalidLineCount += 1;
      continue;
    }

    const record = parsed as CaptureHttpRecord;
    if (record.kind === 'websocket') {
      websocketCount += 1;
      continue;
    }

    const method = typeof record.method === 'string' ? record.method : undefined;
    const pathWithQuery = typeof record.pathWithQuery === 'string' ? record.pathWithQuery : undefined;
    if (!method || !pathWithQuery) {
      invalidLineCount += 1;
      continue;
    }

    httpCount += 1;
    const normalizedPath = normalizePath(pathWithQuery);
    const key = `${method} ${normalizedPath}`;
    const group = groupsByKey.get(key) ?? {
      key,
      method,
      normalizedPath,
      count: 0,
      statuses: {},
      examples: [],
    };

    group.count += 1;
    const statusKey = record.status == null ? 'null' : String(record.status);
    group.statuses[statusKey] = (group.statuses[statusKey] ?? 0) + 1;
    if (group.examples.length < maxExamplesPerGroup) {
      group.examples.push({
        pathWithQuery,
        requestBody: toBodyPreview(record.requestBody),
        responseBody: toBodyPreview(record.responseBody),
      });
    }

    groupsByKey.set(key, group);
  }

  return {
    groups: Array.from(groupsByKey.values()).sort((left, right) => {
      if (right.count !== left.count) return right.count - left.count;
      return left.key.localeCompare(right.key);
    }),
    httpCount,
    websocketCount,
    invalidLineCount,
  };
}

export function formatCaptureAnalysis(result: CaptureAnalysisResult): string {
  const lines = [
    `HTTP records: ${result.httpCount}`,
    `WebSocket records: ${result.websocketCount}`,
    `Invalid lines: ${result.invalidLineCount}`,
    `Endpoint groups: ${result.groups.length}`,
  ];

  for (const group of result.groups) {
    const requestLabel = group.count === 1 ? 'request' : 'requests';
    const statuses = Object.entries(group.statuses)
      .map(([status, count]) => `${status}:${count}`)
      .join(', ');
    lines.push('', `${group.key} — ${group.count} ${requestLabel}${statuses ? ` — statuses ${statuses}` : ''}`);

    for (const example of group.examples) {
      lines.push(`  example: ${example.pathWithQuery}`);
      if (example.requestBody != null) lines.push(`  request: ${example.requestBody}`);
      if (example.responseBody != null) lines.push(`  response: ${example.responseBody}`);
    }
  }

  return `${lines.join('\n')}\n`;
}
