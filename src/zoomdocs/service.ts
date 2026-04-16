import { randomUUID } from 'node:crypto';

import {
  buildSyncCreatePayload,
  decodeContentData,
  extractFileId,
  normalizeBatchGetChildrenResult,
  normalizeBatchGetNodesResult,
  parseModocContent,
  type ParsedModocContent,
  type ZoomDocsNode,
} from './internal-api.js';
import {
  buildAppendDelta,
  buildBlockTransactionRequest,
  buildReplaceDelta,
  computeBlockTextLength,
  summarizeBlocks,
  type BlockSummary,
  type RawBlockSummary,
} from './edit.js';
import {
  collectAttachmentRefs,
  collectEmbeddedDatabaseRefs,
  renderEmbeddedDatabaseToMarkdown,
  renderZoomDocBlocksToMarkdown,
  type AttachmentRef,
  type RawDocPayload,
} from './markdown.js';

export interface RequestJsonOptions {
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  body?: unknown;
  fileId?: string;
  headers?: Record<string, string>;
}

export interface CaptureStartResult {
  outputPath: string;
  startedAt: string;
}

export interface CaptureStopResult {
  outputPath: string;
  entriesWritten: number;
  startedAt: string;
  stoppedAt: string;
}

export interface CaptureStatusResult {
  active: boolean;
  outputPath: string | null;
  startedAt: string | null;
  entriesWritten: number;
}

export interface ZoomDocsTransport {
  ensureLoggedIn(interactive: boolean): Promise<void>;
  openLogin(): Promise<{ alreadyAuthenticated: boolean }>;
  requestJson<T>(options: RequestJsonOptions): Promise<T>;
  startCapture(options: { outputPath: string }): Promise<CaptureStartResult>;
  stopCapture(): Promise<CaptureStopResult>;
  captureStatus(): CaptureStatusResult;
}

export interface ListResult {
  parentId: string;
  items: ZoomDocsNode[];
}

export const DEFAULT_SEARCH_FILE_TYPES = ['database', 'classicDoc', 'doc', 'page'] as const;
export const DEFAULT_SEARCH_PAGE_SIZE = 10;
export const MAX_SEARCH_PAGE_SIZE = 50;

export interface SearchResultItem {
  id: string;
  title: string;
  fileType: string;
  parentId?: string;
  fileLink: string;
  isDeleted: boolean;
  titleHighlight?: string;
  updatedAt?: string;
  updatedByDisplayName?: string;
}

export interface SearchResult {
  query: string;
  pageSize: number;
  fileTypes: string[];
  totalReturned: number;
  items: SearchResultItem[];
}

export interface RawZoomSearchItem {
  file?: {
    id?: string;
    title?: string;
    fileType?: string;
    parentId?: string;
    isDeleted?: boolean;
    createdInfo?: { user?: { displayName?: string }; time?: string };
    updatedInfo?: { user?: { displayName?: string }; time?: string };
  };
  highlight?: { titleHighlight?: string };
}

export function buildZoomDocFileLink(
  fileType: string,
  id: string,
  baseUrl = 'https://docs.zoom.us'
): string {
  if (fileType === 'folder') return `${baseUrl}/folder/${id}`;
  if (fileType === 'database') return `${baseUrl}/database/${id}`;
  return `${baseUrl}/doc/${id}`;
}

export function stripTitleHighlightMarkup(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/<\/?em>/gi, '') || undefined;
}

export function normalizeNativeSearchItem(entry: RawZoomSearchItem): SearchResultItem | null {
  const file = entry.file;
  if (!file?.id) return null;

  const fileType = String(file.fileType ?? 'unknown');
  return {
    id: String(file.id),
    title: String(file.title ?? ''),
    fileType,
    parentId: typeof file.parentId === 'string' ? file.parentId : undefined,
    fileLink: buildZoomDocFileLink(fileType, String(file.id)),
    isDeleted: Boolean(file.isDeleted),
    titleHighlight: entry.highlight?.titleHighlight || undefined,
    updatedAt: typeof file.updatedInfo?.time === 'string' ? file.updatedInfo.time : undefined,
    updatedByDisplayName:
      typeof file.updatedInfo?.user?.displayName === 'string'
        ? file.updatedInfo.user.displayName
        : undefined,
  };
}

export interface ReadResult {
  fileId: string;
  text: string;
  format: ParsedModocContent['format'];
}

export interface WriteMarkdownResult {
  mode: 'create' | 'replace';
  fileId?: string;
  fileLink?: string;
  parentId: string;
  replacedFileId?: string;
}

export interface ListBlocksResult {
  fileId: string;
  blocks: BlockSummary[];
}

export interface EditBlockResult {
  fileId: string;
  blockId: string;
  previousVersion: number;
  newVersion: number;
  newTextLength: number;
}

export interface DeleteFileResult {
  fileId: string;
  status: 'trashed';
}

export interface MoveFileResult {
  fileId: string;
  newParentId: string;
}

export class ZoomDocsService {
  private cachedUserId: string | null = null;
  private cachedAccountId: string | null = null;
  private readonly clientId: string = randomUUID();

  constructor(private readonly transport: ZoomDocsTransport) {}

  async login(): Promise<{ status: 'already_authenticated' | 'login_opened' }> {
    const result = await this.transport.openLogin();
    return {
      status: result.alreadyAuthenticated ? 'already_authenticated' : 'login_opened',
    };
  }

  async status(): Promise<{ ok: true }> {
    await this.transport.ensureLoggedIn(false);
    return { ok: true };
  }

  async list({ parentId }: { parentId?: string } = {}): Promise<ListResult> {
    const resolvedParentId = extractFileId(parentId || 'my-docs');
    const payload = await this.transport.requestJson<{
      successItems?: Array<{ children?: Array<Record<string, unknown>> }>;
    }>({
      method: 'POST',
      path: '/api/file/files/action/batch_get_children',
      body: { parentIds: [resolvedParentId] },
      fileId: resolvedParentId,
    });

    const items = normalizeBatchGetChildrenResult(payload);

    return {
      parentId: resolvedParentId,
      items,
    };
  }

  async getMetadata({ fileId }: { fileId: string }): Promise<ZoomDocsNode> {
    const resolvedFileId = extractFileId(fileId);
    const payload = await this.transport.requestJson<{
      successItems?: Array<Record<string, unknown>>;
    }>({
      method: 'POST',
      path: '/api/file/files/action/batch_get',
      body: { ids: [resolvedFileId] },
      fileId: resolvedFileId,
    });

    const node = normalizeBatchGetNodesResult(payload);
    if (!node) {
      throw new Error(`Zoom Doc not found: ${resolvedFileId}`);
    }

    return node;
  }

  async search({
    query,
    pageSize = DEFAULT_SEARCH_PAGE_SIZE,
    fileTypes,
    includeDeleted = false,
  }: {
    query: string;
    pageSize?: number;
    fileTypes?: readonly string[];
    includeDeleted?: boolean;
  }): Promise<SearchResult> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      throw new Error('query is required');
    }

    const resolvedFileTypes =
      fileTypes && fileTypes.length > 0 ? [...fileTypes] : [...DEFAULT_SEARCH_FILE_TYPES];
    const clampedPageSize = Math.min(Math.max(Math.round(pageSize), 1), MAX_SEARCH_PAGE_SIZE);

    const payload = await this.transport.requestJson<{ items?: RawZoomSearchItem[] }>({
      method: 'POST',
      path: '/api/search/file',
      body: {
        pageSize: clampedPageSize,
        query: normalizedQuery,
        fileTypes: resolvedFileTypes,
      },
    });

    const items = (payload.items ?? []).flatMap((entry) => {
      const normalized = normalizeNativeSearchItem(entry);
      if (!normalized) return [];
      if (!includeDeleted && normalized.isDeleted) return [];
      return [normalized];
    });

    return {
      query: normalizedQuery,
      pageSize: clampedPageSize,
      fileTypes: resolvedFileTypes,
      totalReturned: items.length,
      items,
    };
  }

  async read({ fileId }: { fileId: string }): Promise<ReadResult> {
    const resolvedFileId = extractFileId(fileId);
    const encodedFileId = encodeURIComponent(resolvedFileId);
    const payload = await this.transport.requestJson<{ content?: { data?: string; gzip?: boolean } }>({
      method: 'GET',
      path: `/api/page/${encodedFileId}/content?returnEncodedData=true&fileId=${encodedFileId}`,
      fileId: resolvedFileId,
    });

    const encoded = payload.content?.data;
    if (!encoded) {
      throw new Error(`Zoom Docs content payload missing for ${resolvedFileId}`);
    }

    const raw = decodeContentData(encoded, Boolean(payload.content?.gzip));

    try {
      const parsed = JSON.parse(raw) as { blocks?: Record<string, unknown> };
      if (parsed.blocks && typeof parsed.blocks === 'object') {
        const pagePayload = parsed as RawDocPayload;
        const embeddedDatabasePayloads = await this.fetchEmbeddedDatabasePayloads(resolvedFileId, pagePayload).catch(() => ({}));
        const attachmentRefs = [
          ...collectAttachmentRefs(pagePayload),
          ...Object.values(embeddedDatabasePayloads).flatMap((databasePayload) => collectAttachmentRefs(databasePayload)),
        ];
        const attachmentUrls = await this.fetchAttachmentUrls(resolvedFileId, attachmentRefs).catch(() => ({}));
        const embeddedMarkdownByRefId = Object.fromEntries(
          Object.entries(embeddedDatabasePayloads).flatMap(([databaseId, databasePayload]) => {
            try {
              return [[databaseId, renderEmbeddedDatabaseToMarkdown(databasePayload, { attachmentUrls })] as const];
            } catch {
              return [];
            }
          })
        );

        return {
          fileId: resolvedFileId,
          text: renderZoomDocBlocksToMarkdown(pagePayload, { attachmentUrls, embeddedMarkdownByRefId }),
          format: 'markdown',
        };
      }
    } catch {
      // fall back to legacy/plain-text parsing
    }

    const parsedContent = parseModocContent(raw);
    return {
      fileId: resolvedFileId,
      text: parsedContent.text,
      format: parsedContent.format,
    };
  }

  private async fetchEmbeddedDatabasePayloads(
    fileId: string,
    payload: RawDocPayload
  ): Promise<Record<string, RawDocPayload>> {
    const databaseIds = collectEmbeddedDatabaseRefs(payload);
    const results = await Promise.allSettled(
      databaseIds.map(async (databaseId) => {
        const encodedDatabaseId = encodeURIComponent(databaseId);
        const encodedFileId = encodeURIComponent(fileId);
        const databasePayload = await this.transport.requestJson<{ content?: { data?: string; gzip?: boolean } }>({
          method: 'GET',
          path: `/api/database/${encodedDatabaseId}/content?returnEncodedData=true&fileId=${encodedFileId}`,
          fileId,
        });

        const encoded = databasePayload.content?.data;
        if (!encoded) return null;

        const raw = decodeContentData(encoded, Boolean(databasePayload.content?.gzip));
        const parsed = JSON.parse(raw) as RawDocPayload;
        return [databaseId, parsed] as const;
      })
    );

    return Object.fromEntries(
      results.flatMap((result) =>
        result.status === 'fulfilled' && result.value ? [result.value] : []
      )
    );
  }

  private async fetchAttachmentUrls(
    fileId: string,
    attachmentRefs: AttachmentRef[]
  ): Promise<Record<string, string>> {
    if (attachmentRefs.length === 0) return {};

    const uniqueRefs = Array.from(new Map(attachmentRefs.map((ref) => [ref.attachmentId, ref])).values());
    const encodedFileId = encodeURIComponent(fileId);
    const signedUrls: Record<string, string> = {};

    for (const ref of uniqueRefs) {
      try {
        const response = await this.transport.requestJson<{
          signedUrls?: Record<string, string>;
        }>({
          method: 'POST',
          path: `/api/attachment/getSignedFileUrls?fileId=${encodedFileId}`,
          fileId,
          headers: {
            'x-zm-lkp-routing-app-name': 'blockserver',
          },
          body: {
            attachments: [
              {
                attachmentId: ref.attachmentId,
                permissionRecord: {
                  blockId: ref.blockId,
                  pageId: ref.pageId,
                },
              },
            ],
            acceptWEBP: true,
            process: 'image/w_2000xformat_webp',
          },
        });

        const signedUrl = response.signedUrls?.[ref.attachmentId];
        if (signedUrl) {
          signedUrls[ref.attachmentId] = signedUrl;
        }
      } catch {
        // best-effort only; fall back to attachment:// URLs in markdown output
      }
    }

    return signedUrls;
  }

  async writeMarkdown({
    title,
    markdown,
    parentId,
    targetFileId,
  }: {
    title?: string;
    markdown: string;
    parentId?: string;
    targetFileId?: string;
  }): Promise<WriteMarkdownResult> {
    let resolvedParentId = extractFileId(parentId || 'my-docs');
    let resolvedTitle = title?.trim();
    let replacedFileId: string | undefined;

    if (targetFileId) {
      const target = await this.getMetadata({ fileId: targetFileId });
      resolvedParentId = target.parentId || resolvedParentId;
      resolvedTitle ||= target.title;
      replacedFileId = target.id;
    }

    if (!resolvedTitle) {
      resolvedTitle = 'Untitled';
    }

    const payload = await this.transport.requestJson<{ fileId?: string; fileLink?: string }>({
      method: 'POST',
      path: '/api/bridge/import/syncCreate',
      body: buildSyncCreatePayload({
        parentId: resolvedParentId,
        title: resolvedTitle,
        markdown,
      }),
      fileId: resolvedParentId,
    });

    return {
      mode: replacedFileId ? 'replace' : 'create',
      fileId: payload.fileId,
      fileLink: payload.fileLink,
      parentId: resolvedParentId,
      replacedFileId,
    };
  }

  async captureStart({ outputPath }: { outputPath: string }): Promise<CaptureStartResult> {
    if (!outputPath) {
      throw new Error('outputPath is required for captureStart');
    }
    return this.transport.startCapture({ outputPath });
  }

  async captureStop(): Promise<CaptureStopResult> {
    return this.transport.stopCapture();
  }

  captureStatus(): CaptureStatusResult {
    return this.transport.captureStatus();
  }

  async rename({ fileId, title }: { fileId: string; title: string }): Promise<{ ok: true }> {
    const resolvedFileId = extractFileId(fileId);
    const normalizedTitle = title.trim();
    if (!normalizedTitle) {
      throw new Error('title is required');
    }

    await this.transport.requestJson({
      method: 'PUT',
      path: '/api/file/files/title',
      body: { id: resolvedFileId, title: normalizedTitle, stopSync: false },
      fileId: resolvedFileId,
    });

    return { ok: true };
  }

  async listBlocks({ fileId }: { fileId: string }): Promise<ListBlocksResult> {
    const resolvedFileId = extractFileId(fileId);
    const blocks = await this.fetchBlocks(resolvedFileId);
    return { fileId: resolvedFileId, blocks: summarizeBlocks(blocks, { rootId: resolvedFileId }) };
  }

  async appendToBlock({
    fileId,
    blockId,
    text,
  }: {
    fileId: string;
    blockId: string;
    text: string;
  }): Promise<EditBlockResult> {
    if (!text) {
      throw new Error('text must be a non-empty string');
    }
    return this.submitBlockEdit({ fileId, blockId, mode: 'append', text });
  }

  async replaceBlockText({
    fileId,
    blockId,
    text,
  }: {
    fileId: string;
    blockId: string;
    text: string;
  }): Promise<EditBlockResult> {
    return this.submitBlockEdit({ fileId, blockId, mode: 'replace', text });
  }

  private async submitBlockEdit({
    fileId,
    blockId,
    mode,
    text,
  }: {
    fileId: string;
    blockId: string;
    mode: 'append' | 'replace';
    text: string;
  }): Promise<EditBlockResult> {
    const resolvedFileId = extractFileId(fileId);
    const blocks = await this.fetchBlocks(resolvedFileId);
    const block = blocks[blockId];
    if (!block) {
      throw new Error(`Block not found in ${resolvedFileId}: ${blockId}`);
    }
    const baseVersion = typeof block.version === 'number' ? block.version : 0;
    const currentLength = computeBlockTextLength(block.content?.title);
    const userId = await this.getCurrentUserId();

    const delta =
      mode === 'append'
        ? buildAppendDelta({ currentLength, text, userId })
        : buildReplaceDelta({ currentLength, text, userId });

    const body = buildBlockTransactionRequest({
      fileId: resolvedFileId,
      clientId: this.clientId,
      baseVersion,
      blockId,
      delta,
      reqId: randomUUID(),
      transactionId: randomUUID(),
    });

    const encodedFileId = encodeURIComponent(resolvedFileId);
    await this.transport.requestJson({
      method: 'POST',
      path: `/api/block/transactions?fileId=${encodedFileId}`,
      body,
      fileId: resolvedFileId,
    });

    const newTextLength = mode === 'append' ? currentLength + text.length : text.length;
    return {
      fileId: resolvedFileId,
      blockId,
      previousVersion: baseVersion,
      newVersion: baseVersion + 1,
      newTextLength,
    };
  }

  private async fetchBlocks(fileId: string): Promise<Record<string, RawBlockSummary>> {
    const encodedFileId = encodeURIComponent(fileId);
    const payload = await this.transport.requestJson<{ content?: { data?: string; gzip?: boolean } }>({
      method: 'GET',
      path: `/api/page/${encodedFileId}/content?returnEncodedData=true&fileId=${encodedFileId}`,
      fileId,
    });

    const encoded = payload.content?.data;
    if (!encoded) {
      throw new Error(`Zoom Docs content payload missing for ${fileId}`);
    }

    const raw = decodeContentData(encoded, Boolean(payload.content?.gzip));
    const parsed = JSON.parse(raw) as { blocks?: Record<string, RawBlockSummary> };
    return parsed.blocks ?? {};
  }

  private async getCurrentUserId(): Promise<string> {
    if (this.cachedUserId) return this.cachedUserId;
    await this.loadCurrentUser();
    if (!this.cachedUserId) {
      throw new Error('Could not resolve current user id from /api/user/me');
    }
    return this.cachedUserId;
  }

  private async getCurrentAccountId(): Promise<string> {
    if (this.cachedAccountId) return this.cachedAccountId;
    await this.loadCurrentUser();
    if (!this.cachedAccountId) {
      throw new Error('Could not resolve current account id from /api/user/me');
    }
    return this.cachedAccountId;
  }

  private async loadCurrentUser(): Promise<void> {
    const payload = await this.transport.requestJson<{
      user?: { userId?: string; accountId?: string };
      account?: { accountId?: string };
    }>({
      method: 'GET',
      path: '/api/user/me',
    });
    if (payload.user?.userId) this.cachedUserId = payload.user.userId;
    const accountId = payload.account?.accountId ?? payload.user?.accountId;
    if (accountId) this.cachedAccountId = accountId;
  }

  async deleteFile({ fileId }: { fileId: string }): Promise<DeleteFileResult> {
    const resolvedFileId = extractFileId(fileId);
    const accountId = await this.getCurrentAccountId();
    await this.transport.requestJson({
      method: 'POST',
      path: '/api/file/files/action/delete_to_trash',
      body: { ids: [resolvedFileId], accountId },
      fileId: resolvedFileId,
    });
    return { fileId: resolvedFileId, status: 'trashed' };
  }

  async moveFile({
    fileId,
    parentId,
  }: {
    fileId: string;
    parentId: string;
  }): Promise<MoveFileResult> {
    const resolvedFileId = extractFileId(fileId);
    const resolvedParentId = extractFileId(parentId);
    if (!resolvedParentId) {
      throw new Error('parent_id is required');
    }
    const accountId = await this.getCurrentAccountId();
    await this.transport.requestJson({
      method: 'POST',
      path: '/api/file/files/action/move',
      body: { ids: [resolvedFileId], parentId: resolvedParentId, accountId },
      fileId: resolvedFileId,
    });
    return { fileId: resolvedFileId, newParentId: resolvedParentId };
  }
}
