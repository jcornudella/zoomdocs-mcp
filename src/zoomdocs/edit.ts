export const OP_INSERT = 0;
export const OP_DELETE = 1;
export const OP_RETAIN = 2;

export type DeltaOp =
  | [typeof OP_INSERT, string, string]
  | [typeof OP_DELETE, number]
  | [typeof OP_RETAIN, number];

export type SafeStructuralBlockType =
  | 'BLOCK_TYPE_PARAGRAPH'
  | 'BLOCK_TYPE_BULLET'
  | 'BLOCK_TYPE_TODO_LIST'
  | 'BLOCK_TYPE_HEADING1'
  | 'BLOCK_TYPE_HEADING2'
  | 'BLOCK_TYPE_HEADING3'
  | 'BLOCK_TYPE_HEADING4'
  | 'BLOCK_TYPE_HEADING5'
  | 'BLOCK_TYPE_HEADING6';

export interface StructuralBlockSpec {
  type: SafeStructuralBlockType;
  text: string;
  style?: Record<string, unknown>;
}

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

export type BlockTransactionOp =
  | {
      command: 'COMMAND_TYPE_UPDATE';
      blockId: string;
      args: { delta: string };
    }
  | {
      command: 'COMMAND_TYPE_CREATE';
      blockId: string;
      args: {
        type: string;
        parentBlockId: string;
        afterBlockId?: string;
        content?: { title?: string };
        style?: Record<string, unknown>;
      };
    }
  | {
      command: 'COMMAND_TYPE_DELETE';
      blockId: string;
    }
  | {
      command: 'COMMAND_TYPE_MOVE';
      blockId: string;
      args: {
        fromParentBlockId: string;
        toParentBlockId: string;
        afterBlockId?: string;
      };
    };

export interface BlockTransactionRequest {
  reqId: string;
  clientId: string;
  baseVersion: number;
  transactions: Array<{
    id: string;
    ops: BlockTransactionOp[];
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
  return buildBlockOpsTransactionRequest({
    fileId,
    clientId,
    baseVersion,
    ops: [
      {
        command: 'COMMAND_TYPE_UPDATE',
        blockId,
        args: { delta },
      },
    ],
    reqId,
    transactionId,
  });
}

export function buildBlockOpsTransactionRequest({
  fileId,
  clientId,
  baseVersion,
  ops,
  reqId,
  transactionId,
}: {
  fileId: string;
  clientId: string;
  baseVersion: number;
  ops: BlockTransactionOp[];
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
        ops,
      },
    ],
    extra: { fromFileId: fileId },
  };
}

export function buildCreateBlockOp({
  blockId,
  type,
  parentBlockId,
  afterBlockId,
  text,
  userId,
  style,
}: {
  blockId: string;
  type: string;
  parentBlockId: string;
  afterBlockId?: string;
  text: string;
  userId: string;
  style?: Record<string, unknown>;
}): BlockTransactionOp {
  return {
    command: 'COMMAND_TYPE_CREATE',
    blockId,
    args: {
      type,
      parentBlockId,
      ...(afterBlockId ? { afterBlockId } : {}),
      ...(text ? { content: { title: buildReplaceDelta({ currentLength: 0, text, userId }) } } : {}),
      ...(style ? { style } : {}),
    },
  };
}

export function buildDeleteBlockOp({ blockId }: { blockId: string }): BlockTransactionOp {
  return {
    command: 'COMMAND_TYPE_DELETE',
    blockId,
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
  style?: Record<string, unknown>;
}

export interface BlockSummary {
  id: string;
  type: string;
  parentId: string | null;
  seq: string | null;
  version: number;
  text: string;
}

export interface EditableBlockSnapshot extends BlockSummary {
  heading?: string;
  headingLevel?: number;
  hasInlineContentRisk: boolean;
  raw: RawBlockSummary;
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

function isPlainAuthorAttribution(attribute: unknown): boolean {
  if (attribute == null || attribute === '') return true;
  return typeof attribute === 'string' && /^26:"[^"]*"$/.test(attribute);
}

export function titleHasInlineContentRisk(titleDelta: unknown): boolean {
  if (typeof titleDelta !== 'string' || !titleDelta.trim().startsWith('[')) return false;

  try {
    const parsed = JSON.parse(titleDelta);
    if (!Array.isArray(parsed)) return false;
    return parsed.some((entry) => {
      if (!Array.isArray(entry) || entry[0] !== OP_INSERT) return false;
      if (typeof entry[1] !== 'string') return true;
      return !isPlainAuthorAttribution(entry[2]);
    });
  } catch {
    return false;
  }
}

export function headingLevelForBlockType(type: string): number | undefined {
  const match = type.match(/^BLOCK_TYPE_HEADING_?(\d*)$/);
  if (!match) return undefined;
  const level = match[1] ? Number(match[1]) : 1;
  return Number.isFinite(level) ? level : 1;
}

export function parseStructuralMarkdown(markdown: string): StructuralBlockSpec[] {
  const specs: StructuralBlockSpec[] = [];

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading?.[1] && heading[2]) {
      specs.push({
        type: `BLOCK_TYPE_HEADING${heading[1].length}` as SafeStructuralBlockType,
        text: heading[2].trim(),
      });
      continue;
    }

    const todo = line.match(/^-\s+\[([ xX])]\s*(.*)$/);
    if (todo) {
      specs.push({
        type: 'BLOCK_TYPE_TODO_LIST',
        text: (todo[2] ?? '').trim(),
        style: { checked: todo[1]?.toLowerCase() === 'x' },
      });
      continue;
    }

    const bullet = line.match(/^-\s*(.*)$/);
    if (bullet) {
      specs.push({ type: 'BLOCK_TYPE_BULLET', text: (bullet[1] ?? '').trim() });
      continue;
    }

    specs.push({ type: 'BLOCK_TYPE_PARAGRAPH', text: line });
  }

  return specs;
}

export function isHeadingBlockType(type: string): boolean {
  return headingLevelForBlockType(type) !== undefined;
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

export function buildEditableBlockSnapshots(
  blocks: Record<string, RawBlockSummary> | undefined,
  options: { rootId?: string } = {}
): EditableBlockSnapshot[] {
  const ordered = summarizeBlocks(blocks, options);
  let currentHeading: { text: string; level: number } | undefined;

  return ordered.flatMap((block) => {
    const raw = blocks?.[block.id];
    if (!raw) return [];

    const headingLevel = headingLevelForBlockType(block.type);
    const snapshot: EditableBlockSnapshot = {
      ...block,
      ...(currentHeading ? { heading: currentHeading.text } : {}),
      ...(headingLevel ? { headingLevel } : {}),
      hasInlineContentRisk: titleHasInlineContentRisk(raw.content?.title),
      raw,
    };

    if (headingLevel) {
      currentHeading = { text: block.text, level: headingLevel };
      snapshot.heading = block.text;
    }

    return [snapshot];
  });
}
