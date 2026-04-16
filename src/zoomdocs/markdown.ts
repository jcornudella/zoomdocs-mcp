export type RawBlock = {
  id: string;
  parentId?: string;
  type?: string;
  seq?: string;
  createdAt?: string;
  fileId?: string;
  content?: {
    title?: unknown;
    ref?: {
      id?: string;
      type?: string;
    };
    row?: {
      values?: Record<string, { value?: unknown }>;
    };
    column?: {
      name?: string;
      isPrimary?: boolean;
      columnType?: string;
    };
    view?: {
      name?: string;
      databaseId?: string;
      viewType?: string;
      gallery?: {
        coverColumnId?: string;
      };
      viewColumns?: Record<string, { visible?: boolean }>;
      columnOrder?: Array<{ id?: string; seq?: string }>;
      rowOrder?: Array<{ id?: string; seq?: string }>;
    };
    database?: {
      name?: string;
      viewOrder?: Array<{ id?: string; seq?: string }>;
    };
    table?: {
      name?: string;
    };
  };
  style?: {
    checked?: boolean;
  };
};

export type RawDocPayload = {
  blocks?: Record<string, RawBlock>;
};

export interface AttachmentRef {
  attachmentId: string;
  blockId: string;
  pageId: string;
  name?: string;
  type?: string;
}

export interface MarkdownRenderOptions {
  attachmentUrls?: Record<string, string>;
  embeddedMarkdownByRefId?: Record<string, string>;
}

type RichTextSegment = unknown;

function indent(depth: number): string {
  return '  '.repeat(depth);
}

function sortBySeq<T extends { seq?: string; createdAt?: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => {
    const seqCompare = String(left.seq || '').localeCompare(String(right.seq || ''));
    if (seqCompare !== 0) return seqCompare;
    return String(left.createdAt || '').localeCompare(String(right.createdAt || ''));
  });
}

function escapeMarkdownTableCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

function parseRichTextSegments(value: unknown): RichTextSegment[] {
  if (typeof value !== 'string') return [];
  if (!value.trim()) return [];
  if (!value.trim().startsWith('[')) return [value];

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [value];
    return parsed.map((entry) => (Array.isArray(entry) ? entry[1] : entry));
  } catch {
    return [value];
  }
}

function renderAttachmentMarkdown(
  attachment: { attachmentId?: string; name?: string; type?: string },
  options: MarkdownRenderOptions
): string {
  const attachmentId = attachment.attachmentId;
  if (!attachmentId) return '';

  const label = attachment.name || attachmentId;
  const url = options.attachmentUrls?.[attachmentId] || `attachment://${attachmentId}`;
  return attachment.type?.startsWith('image/')
    ? `![${label}](${url})`
    : `[${label}](${url})`;
}

function renderInlineValue(value: unknown, options: MarkdownRenderOptions): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';

  if ('attachment' in value) {
    return renderAttachmentMarkdown(
      (value as { attachment?: { attachmentId?: string; name?: string; type?: string } }).attachment || {},
      options
    );
  }

  if ('link' in value) {
    const source = (value as {
      link?: {
        source?: {
          type?: string;
          link?: string;
          text?: string;
          guid?: string;
          mentionType?: string;
          channelId?: string;
        };
      };
    }).link?.source;

    if (source?.type === 'link' && source.link) {
      const label = source.text || source.link;
      return `[${label}](${source.link})`;
    }

    if (source?.type === 'mention' && source.guid) {
      if (source.mentionType === 'doc' || source.mentionType === 'page') {
        const url = `https://docs.zoom.us/doc/${source.guid}`;
        const label = source.text || source.guid;
        return `[${label}](${url})`;
      }
      const label = source.text || source.guid;
      return `[[${label}]]`;
    }

    if (source?.type === 'channel' && source.channelId) {
      return `#${source.text || source.channelId}`;
    }
  }

  if ('person' in value) {
    const person = (value as { person?: { name?: string; userId?: string } }).person;
    return person?.name ? `@${person.name}` : person?.userId ? `@${person.userId}` : '';
  }

  if ('date' in value) {
    const time = (value as { date?: { time?: string | number } }).date?.time;
    return time != null ? String(time) : '';
  }

  return '';
}

function renderRichText(value: unknown, options: MarkdownRenderOptions): string {
  const segments = parseRichTextSegments(value);
  if (segments.length === 0) {
    if (typeof value === 'string' && value.trim().startsWith('[')) return '';
    return typeof value === 'string' ? value : '';
  }

  return segments.map((segment) => renderInlineValue(segment, options)).join('');
}

function normalizeMarkdownLines(lines: string[]): string {
  const cleaned = lines.map((line) => line.replace(/[ \t]+$/g, ''));
  while (cleaned[0] === '') cleaned.shift();
  while (cleaned[cleaned.length - 1] === '') cleaned.pop();

  const result: string[] = [];
  let previousBlank = false;
  for (const line of cleaned) {
    const isBlank = line === '';
    if (isBlank && previousBlank) continue;
    result.push(line);
    previousBlank = isBlank;
  }

  return result.join('\n');
}

function buildBlocksByParentId(blocks: RawBlock[]): Map<string, RawBlock[]> {
  const blocksByParentId = new Map<string, RawBlock[]>();
  for (const block of blocks) {
    if (!block.parentId) continue;
    const siblings = blocksByParentId.get(block.parentId) || [];
    siblings.push(block);
    blocksByParentId.set(block.parentId, siblings);
  }
  return blocksByParentId;
}

function renderChildren(
  parentId: string,
  blocksByParentId: Map<string, RawBlock[]>,
  depth: number,
  options: MarkdownRenderOptions
): string[] {
  return sortBySeq(blocksByParentId.get(parentId) || []).flatMap((block) =>
    renderBlock(block, blocksByParentId, depth, options)
  );
}

function renderCalloutLines(lines: string[]): string[] {
  if (lines.length === 0) return [];

  return lines.flatMap((line) => {
    if (line === '') return ['>'];
    return [`> ${line}`];
  });
}

function renderDatabaseCellValue(value: unknown, options: MarkdownRenderOptions): string {
  if (value == null) return '';

  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (entry && typeof entry === 'object' && 'attachmentId' in entry) {
          return renderAttachmentMarkdown(entry as { attachmentId?: string; name?: string; type?: string }, options);
        }
        return typeof entry === 'string' ? entry : '';
      })
      .filter(Boolean)
      .join('<br>');
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length > 1) {
      try {
        const parsed = JSON.parse(trimmed) as { text?: string; doc?: unknown[] };
        if (typeof parsed.text === 'string' && parsed.text.trim()) return parsed.text;
        if (Array.isArray(parsed.doc)) {
          return parsed.doc
            .map((block) => {
              if (!block || typeof block !== 'object') return '';
              const content = (block as { content?: Array<{ data?: unknown }> }).content || [];
              return content.map((part) => renderInlineValue(part.data, options)).join('');
            })
            .filter(Boolean)
            .join('<br>');
        }
      } catch {
        // keep raw string
      }
    }
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (typeof value === 'object') {
    return renderInlineValue(value, options);
  }

  return '';
}

export function collectAttachmentRefs(payload: RawDocPayload): AttachmentRef[] {
  const refs = new Map<string, AttachmentRef>();

  for (const block of Object.values(payload.blocks || {})) {
    const pageId = block.fileId || block.parentId || block.id;

    for (const segment of parseRichTextSegments(block.content?.title)) {
      if (!segment || typeof segment !== 'object' || !('attachment' in segment)) continue;
      const attachment = (segment as { attachment?: { attachmentId?: string; name?: string; type?: string } }).attachment;
      if (!attachment?.attachmentId) continue;
      refs.set(attachment.attachmentId, {
        attachmentId: attachment.attachmentId,
        blockId: block.id,
        pageId,
        name: attachment.name,
        type: attachment.type,
      });
    }

    const rowValues = block.content?.row?.values || {};
    for (const cell of Object.values(rowValues)) {
      const value = cell?.value;
      if (!Array.isArray(value)) continue;
      for (const entry of value) {
        if (!entry || typeof entry !== 'object' || !('attachmentId' in entry)) continue;
        const attachment = entry as { attachmentId?: string; name?: string; type?: string };
        if (!attachment.attachmentId) continue;
        refs.set(attachment.attachmentId, {
          attachmentId: attachment.attachmentId,
          blockId: block.id,
          pageId,
          name: attachment.name,
          type: attachment.type,
        });
      }
    }
  }

  return [...refs.values()];
}

export function collectEmbeddedDatabaseRefs(payload: RawDocPayload): string[] {
  const refs = new Set<string>();

  for (const block of Object.values(payload.blocks || {})) {
    if (block.type !== 'BLOCK_TYPE_EMBED_REFERENCE') continue;
    const ref = block.content?.ref;
    if (ref?.type === 'EMBED_TYPE_DATABASE' && ref.id) {
      refs.add(ref.id);
    }
  }

  return [...refs];
}

export function renderEmbeddedDatabaseToMarkdown(
  payload: RawDocPayload,
  options: MarkdownRenderOptions = {}
): string {
  const blocks = Object.values(payload.blocks || {});
  const columns = new Map(
    blocks
      .filter((block) => block.type === 'BLOCK_TYPE_DATABASE_COLUMN')
      .map((block) => [block.id, block] as const)
  );
  const rows = new Map(
    blocks
      .filter((block) => block.type === 'BLOCK_TYPE_DATABASE_ROW')
      .map((block) => [block.id, block] as const)
  );
  const database = blocks.find((block) => block.type === 'BLOCK_TYPE_DATABASE');
  const table = blocks.find((block) => block.type === 'BLOCK_TYPE_DATABASE_TABLE');
  const views = blocks.filter((block) => block.type === 'BLOCK_TYPE_DATABASE_VIEW');

  const preferredViewId = database?.content?.database?.viewOrder?.[0]?.id;
  const selectedView =
    views.find((view) => view.id === preferredViewId) ||
    views.find((view) => view.content?.view?.viewType === 'VIEW_TYPE_TABLE') ||
    views[0];

  const view = selectedView?.content?.view;
  const title = view?.name || table?.content?.table?.name || database?.content?.database?.name || database?.id || 'Embedded database';

  const orderedColumnIds = (view?.columnOrder || []).map((entry) => entry.id).filter((id): id is string => Boolean(id));
  const visibleColumns = orderedColumnIds.filter((id) => view?.viewColumns?.[id]?.visible !== false || view?.viewType === 'VIEW_TYPE_TABLE');
  const orderedRowIds = (view?.rowOrder || []).map((entry) => entry.id).filter((id): id is string => Boolean(id));

  if (visibleColumns.length === 0 || orderedRowIds.length === 0) {
    return `### ${title}\n\n_(No rows)_`;
  }

  if (view?.viewType === 'VIEW_TYPE_GALLERY') {
    const coverColumnId = view.gallery?.coverColumnId;
    const lines = [`### ${title}`, ''];

    for (const rowId of orderedRowIds) {
      const row = rows.get(rowId);
      if (!row) continue;
      const values = row.content?.row?.values || {};
      const primaryColumnId = visibleColumns[0];
      const primary = primaryColumnId ? renderDatabaseCellValue(values[primaryColumnId]?.value, options) : rowId;
      lines.push(`- ${primary || rowId}`);

      if (coverColumnId && values[coverColumnId]?.value != null) {
        const cover = renderDatabaseCellValue(values[coverColumnId]?.value, options);
        if (cover) lines.push(`  ${cover}`);
      }

      for (const columnId of visibleColumns.slice(1)) {
        const column = columns.get(columnId);
        const value = renderDatabaseCellValue(values[columnId]?.value, options);
        if (!value) continue;
        lines.push(`  - ${column?.content?.column?.name || columnId}: ${value}`);
      }

      lines.push('');
    }

    return normalizeMarkdownLines(lines);
  }

  const header = visibleColumns.map((id) => columns.get(id)?.content?.column?.name || id);
  const separator = visibleColumns.map(() => '---');
  const lines = [`### ${title}`, '', `| ${header.join(' | ')} |`, `| ${separator.join(' | ')} |`];

  for (const rowId of orderedRowIds) {
    const row = rows.get(rowId);
    if (!row) continue;
    const values = row.content?.row?.values || {};
    const cells = visibleColumns.map((columnId) =>
      escapeMarkdownTableCell(renderDatabaseCellValue(values[columnId]?.value, options))
    );
    lines.push(`| ${cells.join(' | ')} |`);
  }

  return normalizeMarkdownLines(lines);
}

function renderBlock(
  block: RawBlock,
  blocksByParentId: Map<string, RawBlock[]>,
  depth: number,
  options: MarkdownRenderOptions
): string[] {
  const type = block.type || 'UNKNOWN';
  const title = renderRichText(block.content?.title, options);
  const children = renderChildren(block.id, blocksByParentId, depth, options);

  if (type === 'BLOCK_TYPE_PAGE') {
    return [
      ...(title ? [`# ${title}`, ''] : []),
      ...renderChildren(block.id, blocksByParentId, depth, options),
    ];
  }

  if (type === 'BLOCK_TYPE_HEADING1') return [`# ${title}`, '', ...children];
  if (type === 'BLOCK_TYPE_HEADING2') return [`## ${title}`, '', ...children];
  if (type === 'BLOCK_TYPE_HEADING3') return [`### ${title}`, '', ...children];
  if (type === 'BLOCK_TYPE_HEADING4') return [`#### ${title}`, '', ...children];
  if (type === 'BLOCK_TYPE_HEADING5') return [`##### ${title}`, '', ...children];
  if (type === 'BLOCK_TYPE_HEADING6') return [`###### ${title}`, '', ...children];

  if (type === 'BLOCK_TYPE_PARAGRAPH') {
    const lines = title ? [`${indent(depth)}${title}`, ''] : [];
    return [...lines, ...children];
  }

  if (type === 'BLOCK_TYPE_BULLET') {
    const line = title ? `${indent(depth)}- ${title}` : `${indent(depth)}-`;
    return [line, ...renderChildren(block.id, blocksByParentId, depth + 1, options), ''];
  }

  if (type === 'BLOCK_TYPE_TODO_LIST') {
    const checked = Boolean(block.style?.checked);
    const line = `${indent(depth)}- [${checked ? 'x' : ' '}] ${title}`.trimEnd();
    return [line, ...renderChildren(block.id, blocksByParentId, depth + 1, options), ''];
  }

  if (type === 'BLOCK_TYPE_IMAGE') {
    return title ? [`${indent(depth)}${title}`, ''] : children;
  }

  if (type === 'BLOCK_TYPE_EMBED_REFERENCE') {
    const ref = block.content?.ref;
    const embedded = ref?.id ? options.embeddedMarkdownByRefId?.[ref.id] : undefined;
    if (embedded) {
      return [...embedded.split('\n'), ''];
    }
    if (ref?.id || ref?.type) {
      return [`> Embedded ${ref.type || 'reference'}: ${ref.id || ''}`.trim(), ''];
    }
    return children;
  }

  if (type === 'BLOCK_TYPE_CALLOUT') {
    const nested = [...(title ? [title] : []), ...renderChildren(block.id, blocksByParentId, depth, options)];
    return [...renderCalloutLines(nested), ''];
  }

  if (type === 'BLOCK_TYPE_COLUMN' || type === 'BLOCK_TYPE_COLUMN_LIST') {
    return children;
  }

  return children;
}

export function renderZoomDocBlocksToMarkdown(
  payload: RawDocPayload,
  options: MarkdownRenderOptions = {}
): string {
  const blocks = Object.values(payload.blocks || {});
  const blocksByParentId = buildBlocksByParentId(blocks);

  const pageBlock = blocks.find((block) => block.type === 'BLOCK_TYPE_PAGE');
  const topLevelBlocks = pageBlock ? [pageBlock] : sortBySeq(blocks.filter((block) => !block.parentId));

  const lines = topLevelBlocks.flatMap((block) => renderBlock(block, blocksByParentId, 0, options));
  return normalizeMarkdownLines(lines);
}
