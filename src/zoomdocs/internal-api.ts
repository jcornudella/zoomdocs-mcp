import { unzipSync } from 'node:zlib';

export const ROOT_PARENT_ID = 'my-docs';
export const DOC_TARGET_TYPE = 1;
export const MARKDOWN_SOURCE_TYPE = 4;

export interface ZoomDocsNode {
  id: string;
  title: string;
  fileType: string;
  fileLink?: string;
  parentId?: string;
  fileClusterApiPrefix?: string;
}

export interface ParsedModocContent {
  text: string;
  raw: string;
  format: 'markdown' | 'modoc-json' | 'plain-text';
}

export interface EncodedContentPayload {
  content?: {
    data?: string;
    gzip?: boolean;
  };
}

export function extractFileId(value: string): string {
  const normalized = value.trim();
  if (!normalized) return normalized;

  try {
    const url = new URL(normalized);
    if (url.hostname.endsWith('zoom.us')) {
      const parts = url.pathname.split('/').filter(Boolean);
      return parts.at(-1) || normalized;
    }
  } catch {
    // raw file ids are fine
  }

  return normalized;
}

export function buildSyncCreatePayload({
  title,
  markdown,
  parentId = ROOT_PARENT_ID,
}: {
  title: string;
  markdown: string;
  parentId?: string;
}) {
  return {
    parentId,
    filename: title,
    targetType: DOC_TARGET_TYPE,
    sourceData: markdown,
    sourceType: MARKDOWN_SOURCE_TYPE,
  };
}

function normalizeNode(node: Record<string, unknown>): ZoomDocsNode {
  return {
    id: String(node.id),
    title: String(node.title ?? ''),
    fileType: String(node.fileType ?? 'unknown'),
    fileLink: typeof node.fileLink === 'string' ? node.fileLink : undefined,
    parentId: typeof node.parentId === 'string' ? node.parentId : undefined,
    fileClusterApiPrefix:
      typeof node.fileClusterApiPrefix === 'string' ? node.fileClusterApiPrefix : undefined,
  };
}

export function normalizeBatchGetChildrenResult(payload: {
  successItems?: Array<{ parentId?: string; children?: Array<Record<string, unknown>> }>;
}): ZoomDocsNode[] {
  return (payload.successItems || []).flatMap((item) => (item.children || []).map(normalizeNode));
}

export function normalizeBatchGetNodesResult(payload: {
  successItems?: Array<Record<string, unknown>>;
}): ZoomDocsNode | null {
  const first = payload.successItems?.[0];
  return first ? normalizeNode(first) : null;
}

export function collectRememberableNodes(payload: unknown): ZoomDocsNode[] {
  if (!payload || typeof payload !== 'object') return [];

  const successItems = (payload as { successItems?: unknown }).successItems;
  if (!Array.isArray(successItems)) return [];

  return successItems.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];

    const record = item as Record<string, unknown>;
    if (Array.isArray(record.children)) {
      return record.children
        .filter((child): child is Record<string, unknown> => Boolean(child) && typeof child === 'object' && !Array.isArray(child) && 'id' in child)
        .map(normalizeNode);
    }

    if ('id' in record) {
      return [normalizeNode(record)];
    }

    return [];
  });
}

export function parseModocContent(raw: string): ParsedModocContent {
  try {
    const parsed = JSON.parse(raw) as { text?: unknown };
    if (typeof parsed.text === 'string') {
      return {
        text: parsed.text,
        raw,
        format: 'modoc-json',
      };
    }
  } catch {
    // treat as raw text
  }

  return {
    text: raw,
    raw,
    format: 'plain-text',
  };
}

export function decodeContentData(data: string, gzip: boolean): string {
  const buffer = Buffer.from(data, 'base64');
  return gzip ? unzipSync(buffer).toString('utf8') : buffer.toString('utf8');
}
