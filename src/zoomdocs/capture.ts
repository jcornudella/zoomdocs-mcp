import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_REDACTED_HEADER_NAMES = [
  'cookie',
  'set-cookie',
  'authorization',
  'proxy-authorization',
] as const;

export const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
export const DEFAULT_REQUEST_FILTER = '/api/';

export interface CaptureRequestInput {
  method: string;
  url: string;
  resourceType?: string;
  headers: Record<string, string>;
  body: string | null;
  fromPageUrl?: string;
}

export interface CaptureResponseInput {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface CaptureRecord {
  kind: 'http';
  timestamp: string;
  method: string;
  url: string;
  pathWithQuery: string;
  resourceType?: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  status: number | null;
  statusText: string | null;
  responseHeaders: Record<string, string>;
  responseBody: string | null;
  failure: string | null;
  fromPageUrl?: string;
}

export type WebSocketDirection = 'open' | 'sent' | 'received' | 'close';

export interface WebSocketCaptureRecord {
  kind: 'websocket';
  timestamp: string;
  url: string;
  direction: WebSocketDirection;
  payload: string | null;
  payloadEncoding: 'text' | 'base64' | 'none';
  payloadBytes: number;
  closeCode?: number;
  closeReason?: string;
  fromPageUrl?: string;
}

export function redactHeaders(
  headers: Record<string, string>,
  names: readonly string[] = DEFAULT_REDACTED_HEADER_NAMES
): Record<string, string> {
  const lowercased = new Set(names.map((name) => name.toLowerCase()));
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      lowercased.has(key.toLowerCase()) ? '<redacted>' : value,
    ])
  );
}

export function shouldRecordRequest(url: string, filter: string | RegExp = DEFAULT_REQUEST_FILTER): boolean {
  if (filter instanceof RegExp) return filter.test(url);
  return url.includes(filter);
}

export function truncateBody(body: string | null, maxBytes: number): string | null {
  if (body == null) return null;
  const byteLength = Buffer.byteLength(body, 'utf8');
  if (byteLength <= maxBytes) return body;
  const truncated = Buffer.from(body, 'utf8').subarray(0, maxBytes).toString('utf8');
  return `${truncated}\n<truncated ${byteLength - maxBytes} bytes>`;
}

function extractPathWithQuery(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

export function buildCaptureRecord({
  timestamp,
  request,
  response,
  failure,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
}: {
  timestamp: string;
  request: CaptureRequestInput;
  response?: CaptureResponseInput;
  failure?: string;
  maxBodyBytes?: number;
}): CaptureRecord {
  return {
    kind: 'http',
    timestamp,
    method: request.method,
    url: request.url,
    pathWithQuery: extractPathWithQuery(request.url),
    resourceType: request.resourceType,
    requestHeaders: redactHeaders(request.headers),
    requestBody: truncateBody(request.body, maxBodyBytes),
    status: response?.status ?? null,
    statusText: response?.statusText ?? null,
    responseHeaders: response ? redactHeaders(response.headers) : {},
    responseBody: truncateBody(response?.body ?? null, maxBodyBytes),
    failure: failure ?? null,
    fromPageUrl: request.fromPageUrl,
  };
}

export interface WebSocketFrameInput {
  url: string;
  direction: WebSocketDirection;
  payload: string | Buffer | null;
  fromPageUrl?: string;
  closeCode?: number;
  closeReason?: string;
}

export function buildWebSocketRecord({
  timestamp,
  frame,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
}: {
  timestamp: string;
  frame: WebSocketFrameInput;
  maxBodyBytes?: number;
}): WebSocketCaptureRecord {
  let payload: string | null = null;
  let payloadEncoding: 'text' | 'base64' | 'none' = 'none';
  let payloadBytes = 0;

  if (typeof frame.payload === 'string') {
    payloadBytes = Buffer.byteLength(frame.payload, 'utf8');
    payload = truncateBody(frame.payload, maxBodyBytes);
    payloadEncoding = 'text';
  } else if (frame.payload && Buffer.isBuffer(frame.payload)) {
    payloadBytes = frame.payload.byteLength;
    const encoded = frame.payload.toString('base64');
    payload = truncateBody(encoded, maxBodyBytes);
    payloadEncoding = 'base64';
  }

  return {
    kind: 'websocket',
    timestamp,
    url: frame.url,
    direction: frame.direction,
    payload,
    payloadEncoding,
    payloadBytes,
    ...(frame.closeCode !== undefined ? { closeCode: frame.closeCode } : {}),
    ...(frame.closeReason !== undefined ? { closeReason: frame.closeReason } : {}),
    ...(frame.fromPageUrl !== undefined ? { fromPageUrl: frame.fromPageUrl } : {}),
  };
}

export function defaultCaptureFilePath({
  capturesDir,
  now = new Date(),
}: {
  capturesDir: string;
  now?: Date;
}): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return path.join(capturesDir, `capture-${stamp}.jsonl`);
}

export class CaptureRecorder {
  private entryCount = 0;
  private writeChain: Promise<void> = Promise.resolve();
  private initialized = false;

  constructor(
    public readonly outputPath: string,
    private readonly options: { maxBodyBytes?: number } = {}
  ) {}

  get count(): number {
    return this.entryCount;
  }

  async record(input: {
    timestamp?: string;
    request: CaptureRequestInput;
    response?: CaptureResponseInput;
    failure?: string;
  }): Promise<void> {
    if (!shouldRecordRequest(input.request.url)) return;

    const record = buildCaptureRecord({
      timestamp: input.timestamp ?? new Date().toISOString(),
      request: input.request,
      response: input.response,
      failure: input.failure,
      maxBodyBytes: this.options.maxBodyBytes,
    });

    await this.writeLine(record);
  }

  async recordWebSocket(input: {
    timestamp?: string;
    frame: WebSocketFrameInput;
  }): Promise<void> {
    const record = buildWebSocketRecord({
      timestamp: input.timestamp ?? new Date().toISOString(),
      frame: input.frame,
      maxBodyBytes: this.options.maxBodyBytes,
    });

    await this.writeLine(record);
  }

  private async writeLine(record: CaptureRecord | WebSocketCaptureRecord): Promise<void> {
    const line = `${JSON.stringify(record)}\n`;
    this.entryCount += 1;
    this.writeChain = this.writeChain.then(async () => {
      if (!this.initialized) {
        await mkdir(path.dirname(this.outputPath), { recursive: true });
        await writeFile(this.outputPath, '', 'utf8');
        this.initialized = true;
      }
      await appendFile(this.outputPath, line, 'utf8');
    });
    await this.writeChain;
  }

  async close(): Promise<void> {
    await this.writeChain.catch(() => undefined);
  }
}
