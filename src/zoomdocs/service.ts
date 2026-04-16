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

export interface CapturedApiResponse {
  method: string;
  url: string;
  requestBody: string | null;
  status: number;
  /** Top-level keys of the JSON response, useful for quickly spotting relevant fields. */
  responseKeys: string[];
  /** First 500 chars of the raw response body. */
  responseSnippet: string | null;
}

export interface ZoomDocsTransport {
  ensureLoggedIn(interactive: boolean): Promise<void>;
  openLogin(): Promise<{ alreadyAuthenticated: boolean }>;
  requestJson<T>(options: RequestJsonOptions): Promise<T>;
  /**
   * Open the Zoom Docs web app in the local browser and capture every /api/ response
   * that fires during the given window. Useful for discovering undocumented internal
   * endpoints — the caller interacts with the UI during the window and then inspects
   * what was captured.
   */
  captureApiResponses(timeoutMs: number): Promise<CapturedApiResponse[]>;
}

export interface ListResult {
  parentId: string;
  items: ZoomDocsNode[];
}

export interface SearchResultItem extends ZoomDocsNode {
  score: number;
}

export interface SearchResult {
  query: string;
  parentId: string;
  recursive: boolean;
  maxResults: number;
  scannedFolders: number;
  scannedItems: number;
  truncated: boolean;
  items: SearchResultItem[];
}

export interface NativeSearchParams {
  query?: string;
  pageSize?: number;
  fileTypes?: string[];
  fileFilters?: string[];
  ancestorIds?: string[];
  owners?: string[];
  createdByUserIds?: string[];
  startLastModifyTime?: string;
  endLastModifyTime?: string;
  titleOnly?: boolean;
  pageToken?: string;
}

export interface NativeSearchUser {
  id: string;
  displayName: string;
}

export interface NativeSearchFile {
  id: string;
  title: string;
  fileType: string;
  parentId?: string;
  isDeleted?: boolean;
  createdInfo?: { user: NativeSearchUser; time: string };
  updatedInfo?: { user: NativeSearchUser; time: string };
}

export interface NativeSearchResult {
  items: NativeSearchFile[];
  pageToken: string;
  totalCount: number;
}

export interface UserContact {
  userId: string;
  displayName: string;
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

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreSearchCandidate(title: string, query: string): number {
  const normalizedTitle = normalizeSearchText(title);
  const normalizedQuery = normalizeSearchText(query);

  if (!normalizedTitle || !normalizedQuery) return 0;
  if (normalizedTitle === normalizedQuery) return 1000;
  if (normalizedTitle.startsWith(normalizedQuery)) return 800;
  if (normalizedTitle.includes(normalizedQuery)) return 700;

  const queryTokens = normalizedQuery.split(' ').filter(Boolean);
  const matchingTokens = queryTokens.filter((token) => normalizedTitle.includes(token));
  if (matchingTokens.length === 0) return 0;

  return 400 + matchingTokens.length * 50 - Math.max(0, normalizedTitle.length - normalizedQuery.length);
}

function rankSearchResults(items: SearchResultItem[]): SearchResultItem[] {
  return [...items].sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (left.fileType !== right.fileType) {
      return left.fileType === 'folder' ? 1 : -1;
    }
    return left.title.localeCompare(right.title);
  });
}

export class ZoomDocsService {
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
    parentId,
    recursive = true,
    maxResults = 10,
  }: {
    query: string;
    parentId?: string;
    recursive?: boolean;
    maxResults?: number;
  }): Promise<SearchResult> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      throw new Error('query is required');
    }

    const resolvedParentId = extractFileId(parentId || 'my-docs');
    const queue = [resolvedParentId];
    const visited = new Set<string>();
    const matches = new Map<string, SearchResultItem>();
    let scannedFolders = 0;
    let scannedItems = 0;
    let truncated = false;
    const maxFolders = 200;

    while (queue.length > 0) {
      const currentParentId = queue.shift();
      if (!currentParentId || visited.has(currentParentId)) continue;
      if (scannedFolders >= maxFolders) {
        truncated = true;
        break;
      }

      visited.add(currentParentId);
      scannedFolders += 1;

      const payload = await this.transport.requestJson<{
        successItems?: Array<{ children?: Array<Record<string, unknown>> }>;
      }>({
        method: 'POST',
        path: '/api/file/files/action/batch_get_children',
        body: { parentIds: [currentParentId] },
        fileId: currentParentId,
      });

      const items = normalizeBatchGetChildrenResult(payload);
      scannedItems += items.length;

      for (const item of items) {
        const score = scoreSearchCandidate(item.title, normalizedQuery);
        if (score > 0) {
          matches.set(item.id, { ...item, score });
        }

        if (recursive && item.fileType === 'folder' && !visited.has(item.id)) {
          queue.push(item.id);
        }
      }
    }

    return {
      query: normalizedQuery,
      parentId: resolvedParentId,
      recursive,
      maxResults,
      scannedFolders,
      scannedItems,
      truncated,
      items: rankSearchResults([...matches.values()]).slice(0, Math.max(1, maxResults)),
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

  /**
   * Open Zoom Docs in the local browser and record every internal API call made
   * during `timeoutMs` milliseconds. Type a search query in the browser during
   * this window; the captured calls will reveal the native search endpoint and
   * its full response shape (including creator/timestamp fields).
   */
  async discoverSearch(timeoutMs: number = 30_000): Promise<CapturedApiResponse[]> {
    return this.transport.captureApiResponses(timeoutMs);
  }

  /**
   * Call an internal Zoom Docs API endpoint directly using the authenticated
   * browser session. Use after `discoverSearch` has identified the right path
   * and request shape.
   */
  async searchNative({
    path,
    body,
    method = 'POST',
  }: {
    path: string;
    body?: unknown;
    method?: 'GET' | 'POST';
  }): Promise<unknown> {
    return this.transport.requestJson<unknown>({ method, path, body });
  }

  async nativeSearch(params: NativeSearchParams): Promise<NativeSearchResult> {
    const body: Record<string, unknown> = {
      pageSize: params.pageSize ?? 30,
      query: params.query ?? '',
      fileTypes: params.fileTypes ?? ['database', 'classicDoc', 'doc', 'page'],
    };
    if (params.fileFilters?.length) body.fileFilters = params.fileFilters;
    if (params.ancestorIds?.length) body.ancestorIds = params.ancestorIds;
    if (params.owners?.length) body.owners = params.owners;
    if (params.createdByUserIds?.length) body.createdByUserIds = params.createdByUserIds;
    if (params.startLastModifyTime) body.startLastModifyTime = params.startLastModifyTime;
    if (params.endLastModifyTime) body.endLastModifyTime = params.endLastModifyTime;
    if (params.titleOnly !== undefined) body.titleOnly = params.titleOnly;
    if (params.pageToken) body.pageToken = params.pageToken;

    const raw = await this.transport.requestJson<{
      items?: Array<{ file?: Record<string, unknown> }>;
      pageToken?: string;
      totalCount?: number;
    }>({ method: 'POST', path: '/api/search/file', body });

    const items: NativeSearchFile[] = (raw.items ?? []).map((entry) => {
      const f = (entry.file ?? {}) as Record<string, unknown>;
      const createdInfo = f.createdInfo as { user?: Record<string, unknown>; time?: string } | undefined;
      const updatedInfo = f.updatedInfo as { user?: Record<string, unknown>; time?: string } | undefined;
      return {
        id: String(f.id ?? ''),
        title: String(f.title ?? ''),
        fileType: String(f.fileType ?? 'unknown'),
        parentId: typeof f.parentId === 'string' ? f.parentId : undefined,
        isDeleted: typeof f.isDeleted === 'boolean' ? f.isDeleted : undefined,
        createdInfo: createdInfo?.user
          ? { user: { id: String(createdInfo.user.id ?? ''), displayName: String(createdInfo.user.displayName ?? '') }, time: String(createdInfo.time ?? '') }
          : undefined,
        updatedInfo: updatedInfo?.user
          ? { user: { id: String(updatedInfo.user.id ?? ''), displayName: String(updatedInfo.user.displayName ?? '') }, time: String(updatedInfo.time ?? '') }
          : undefined,
      };
    });

    return { items, pageToken: String(raw.pageToken ?? ''), totalCount: Number(raw.totalCount ?? 0) };
  }

  async lookupUsers(keyword: string): Promise<UserContact[]> {
    const raw = await this.transport.requestJson<{
      users?: Array<{ userId?: unknown; displayName?: unknown }>;
    }>({ method: 'POST', path: '/api/user/contact', body: { keyword } });

    return (raw.users ?? []).map((u) => ({
      userId: String(u.userId ?? ''),
      displayName: String(u.displayName ?? ''),
    }));
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
}
