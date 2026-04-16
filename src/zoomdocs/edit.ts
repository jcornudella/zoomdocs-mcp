export const OP_INSERT = 0;
export const OP_DELETE = 1;
export const OP_RETAIN = 2;

export type DeltaOp =
  | [typeof OP_INSERT, string, string]
  | [typeof OP_DELETE, number]
  | [typeof OP_RETAIN, number];

export function buildAuthorAttribution(userId: string): string {
  return `26:${JSON.stringify(userId)}`;
}

export function computeBlockTextLength(titleDelta: unknown): number {
  if (typeof titleDelta !== 'string' || !titleDelta.trim().startsWith('[')) {
    return typeof titleDelta === 'string' ? titleDelta.length : 0;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(titleDelta);
  } catch {
    return 0;
  }

  if (!Array.isArray(parsed)) return 0;

  let total = 0;
  for (const entry of parsed) {
    if (!Array.isArray(entry)) continue;
    if (entry[0] !== OP_INSERT) continue;
    const value = entry[1];
    if (typeof value === 'string') {
      total += value.length;
    } else if (value && typeof value === 'object') {
      total += 1;
    }
  }
  return total;
}

export function buildAppendDelta({
  currentLength,
  text,
  userId,
}: {
  currentLength: number;
  text: string;
  userId: string;
}): string {
  const ops: DeltaOp[] = [];
  if (currentLength > 0) ops.push([OP_RETAIN, currentLength]);
  ops.push([OP_INSERT, text, buildAuthorAttribution(userId)]);
  return JSON.stringify(ops);
}

export function buildReplaceDelta({
  currentLength,
  text,
  userId,
}: {
  currentLength: number;
  text: string;
  userId: string;
}): string {
  const ops: DeltaOp[] = [];
  if (currentLength > 0) ops.push([OP_DELETE, currentLength]);
  if (text.length > 0) ops.push([OP_INSERT, text, buildAuthorAttribution(userId)]);
  return JSON.stringify(ops);
}

export interface BlockTransactionRequest {
  reqId: string;
  clientId: string;
  baseVersion: number;
  transactions: Array<{
    id: string;
    ops: Array<{
      command: 'COMMAND_TYPE_UPDATE';
      blockId: string;
      args: { delta: string };
    }>;
  }>;
  extra: { fromFileId: string };
}

export function buildBlockTransactionRequest({
  fileId,
  clientId,
  baseVersion,
  blockId,
  delta,
  reqId,
  transactionId,
}: {
  fileId: string;
  clientId: string;
  baseVersion: number;
  blockId: string;
  delta: string;
  reqId: string;
  transactionId: string;
}): BlockTransactionRequest {
  return {
    reqId,
    clientId,
    baseVersion,
    transactions: [
      {
        id: transactionId,
        ops: [
          {
            command: 'COMMAND_TYPE_UPDATE',
            blockId,
            args: { delta },
          },
        ],
      },
    ],
    extra: { fromFileId: fileId },
  };
}

export interface RawBlockSummary {
  id: string;
  type?: string;
  parentId?: string;
  seq?: string;
  createdAt?: string;
  version?: number;
  content?: {
    title?: unknown;
  };
}

export interface BlockSummary {
  id: string;
  type: string;
  parentId: string | null;
  seq: string | null;
  version: number;
  text: string;
}

export function extractPlainTextFromTitle(titleDelta: unknown): string {
  if (typeof titleDelta !== 'string') return '';
  if (!titleDelta.trim().startsWith('[')) return titleDelta;

  try {
    const parsed = JSON.parse(titleDelta);
    if (!Array.isArray(parsed)) return '';
    return parsed
      .map((entry) => {
        if (!Array.isArray(entry) || entry[0] !== OP_INSERT) return '';
        const value = entry[1];
        return typeof value === 'string' ? value : '';
      })
      .join('');
  } catch {
    return '';
  }
}

function toBlockSummary(block: RawBlockSummary): BlockSummary {
  return {
    id: String(block.id),
    type: String(block.type ?? 'unknown'),
    parentId: typeof block.parentId === 'string' ? block.parentId : null,
    seq: typeof block.seq === 'string' ? block.seq : null,
    version: typeof block.version === 'number' ? block.version : 0,
    text: extractPlainTextFromTitle(block.content?.title),
  };
}

function compareBySeqThenCreatedAt(left: RawBlockSummary, right: RawBlockSummary): number {
  const seqCompare = String(left.seq ?? '').localeCompare(String(right.seq ?? ''));
  if (seqCompare !== 0) return seqCompare;
  return String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? ''));
}

export function summarizeBlocks(
  blocks: Record<string, RawBlockSummary> | undefined,
  options: { rootId?: string } = {}
): BlockSummary[] {
  if (!blocks) return [];

  const all = Object.values(blocks);
  const childrenByParent = new Map<string, RawBlockSummary[]>();
  for (const block of all) {
    if (typeof block.parentId !== 'string') continue;
    if (block.parentId === block.id) continue;
    const siblings = childrenByParent.get(block.parentId) ?? [];
    siblings.push(block);
    childrenByParent.set(block.parentId, siblings);
  }
  for (const siblings of childrenByParent.values()) {
    siblings.sort(compareBySeqThenCreatedAt);
  }

  const ordered: BlockSummary[] = [];
  const visited = new Set<string>();

  const visit = (block: RawBlockSummary): void => {
    if (visited.has(block.id)) return;
    visited.add(block.id);
    ordered.push(toBlockSummary(block));
    for (const child of childrenByParent.get(block.id) ?? []) {
      visit(child);
    }
  };

  const rootId = options.rootId;
  if (rootId) {
    const root =
      blocks[rootId] ?? all.find((block) => block.id === rootId) ?? all.find((block) => block.type === 'BLOCK_TYPE_PAGE');
    if (root) visit(root);
  } else {
    const pageBlock = all.find((block) => block.type === 'BLOCK_TYPE_PAGE');
    if (pageBlock) visit(pageBlock);
  }

  for (const block of all) {
    if (!visited.has(block.id)) visit(block);
  }

  return ordered;
}
