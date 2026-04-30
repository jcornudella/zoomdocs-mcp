import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

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
  buildBlockOpsTransactionRequest,
  buildBlockTransactionRequest,
  buildCreateBlockOp,
  buildDeleteBlockOp,
  buildEditableBlockSnapshots,
  buildReplaceDelta,
  computeBlockTextLength,
  extractPlainTextFromTitle,
  headingLevelForBlockType,
  parseStructuralMarkdown,
  summarizeBlocks,
  type BlockSummary,
  type BlockTransactionOp,
  type EditableBlockSnapshot,
  type RawBlockSummary,
  type StructuralBlockSpec,
} from './edit.js';
import {
  collectAttachmentRefs,
  collectEmbeddedDatabaseRefs,
  renderEmbeddedDatabaseToMarkdown,
  renderZoomDocBlocksToMarkdown,
  type AttachmentRef,
  type RawDocPayload,
} from './markdown.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RequestJsonOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
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

export interface CreateDocResult {
  file_id?: string;
  file_link?: string;
  parent_id: string;
}

export interface CreateReplacementCopyResult extends CreateDocResult {
  replaced_file_id: string;
}

export type EditDocTarget =
  | {
      by: 'exact_text';
      value: string;
      within_heading?: string;
    }
  | {
      by: 'heading';
      value: string;
    }
  | {
      by: 'ref';
      value: string;
    };

export type EditDocOperation =
  | {
      type: 'replace_text';
      text: string;
    }
  | {
      type: 'append_text';
      text: string;
    }
  | {
      type: 'insert_after';
      markdown: string;
    }
  | {
      type: 'replace_section';
      markdown: string;
    }
  | {
      type: 'replace_substring';
      old_text: string;
      new_text: string;
    };

export interface EditDocCandidate {
  block_id: string;
  block_type: string;
  text: string;
  heading?: string;
}

export type EditDocFailureCode =
  | 'NO_MATCH'
  | 'AMBIGUOUS_MATCH'
  | 'UNSUPPORTED_TARGET'
  | 'INLINE_CONTENT_RISK'
  | 'UNSUPPORTED_OPERATION';

export interface EditDocFailureResult {
  ok: false;
  error_code: EditDocFailureCode;
  message: string;
  candidates?: EditDocCandidate[];
}

export interface EditDocSuccessResult {
  ok: true;
  dry_run?: true;
  file_id: string;
  preserved_file_id: true;
  matched_block_id: string;
  matched_block_type: string;
  matched_heading?: string;
  operation_type: 'replace_text' | 'append_text' | 'insert_after' | 'replace_section' | 'replace_substring';
  before_text?: string;
  after_text?: string;
  before_markdown?: string;
  after_markdown?: string;
  previous_version: number;
  new_version: number;
  inserted_block_ids?: string[];
  deleted_block_ids?: string[];
  inserted_block_count?: number;
  deleted_block_count?: number;
  warnings: string[];
}

export type EditDocResult = EditDocSuccessResult | EditDocFailureResult;

export interface EditDocBatchItem {
  target: EditDocTarget;
  operation: EditDocOperation;
}

export interface EditDocBatchSuccessResult {
  ok: true;
  dry_run?: true;
  file_id: string;
  preserved_file_id: true;
  edit_count: number;
  results: EditDocSuccessResult[];
  warnings: string[];
}

export interface EditDocBatchFailureResult {
  ok: false;
  file_id: string;
  error_code: EditDocFailureCode;
  message: string;
  failed_edit_index?: number;
  result?: EditDocFailureResult;
  results: EditDocResult[];
}

export type EditDocBatchResult = EditDocBatchSuccessResult | EditDocBatchFailureResult;

export interface EditOutlineBlock {
  ref: string;
  block_id: string;
  block_type: string;
  text: string;
  heading?: string;
  heading_ref?: string;
  safe_to_replace: boolean;
  has_inline_content_risk: boolean;
}

export interface EditOutlineSection {
  ref: string;
  heading: string;
  level: number;
  block_id: string;
  blocks: EditOutlineBlock[];
}

export interface EditOutlineResult {
  file_id: string;
  blocks: EditOutlineBlock[];
  sections: EditOutlineSection[];
  unsectioned_blocks: EditOutlineBlock[];
}

export type ZoomDocsCommentThreadStatus = 'open' | 'resolved';
export type ZoomDocsCommentThreadSource = 'inline' | 'discussion';

export interface ZoomDocsCommentUser {
  user_id: string;
  display_name?: string;
  avatar_url?: string;
  email?: string;
}

export interface ZoomDocsCommentAttachment {
  id: string;
  name: string;
  size: number | null;
  type: string;
  attachment_id: string;
}

export interface ZoomDocsCommentReaction {
  reaction_id: string;
  thread_id: string | null;
  comment_id: string | null;
  user_id: string | null;
  reaction: string;
  created_at: string | null;
}

export interface ZoomDocsComment {
  comment_id: string;
  thread_id: string;
  parent_comment_id: string | null;
  created_by: string | null;
  text: string;
  created_at: string | null;
  modified_at: string | null;
  is_edited: boolean;
  reaction_count: number;
  reactions?: ZoomDocsCommentReaction[];
  attachments?: ZoomDocsCommentAttachment[];
}

export interface ZoomDocsCommentThread {
  source: ZoomDocsCommentThreadSource;
  thread_id: string;
  status: string;
  selected_content: string;
  comment_type: number | null;
  file_id: string | null;
  root_block_id: string | null;
  block_ids: string[];
  created_by: string | null;
  created_at: string | null;
  modified_at: string | null;
  resolved_at: string | null;
  comment_count: number;
  comments: ZoomDocsComment[];
  thread_url?: string;
}

export interface ZoomDocsCommentsResult {
  file_id: string;
  doc_url: string;
  thread_status: ZoomDocsCommentThreadStatus;
  filtered_thread_id?: string;
  inline_thread_ids: string[];
  threads: ZoomDocsCommentThread[];
  users: Record<string, ZoomDocsCommentUser>;
  discussion_next_cursor?: string;
}

export type AddDocCommentContentPart =
  | { type: 'text'; text: string }
  | { type: 'mention'; userId: string; name: string; notify?: boolean };

export interface AddDocCommentAttachmentInput {
  path: string;
  name?: string;
  contentType?: string;
}

export interface AddDocCommentUploadedAttachment {
  id: string;
  name: string;
  size: number;
  type: string;
  attachment_id: string;
}

interface CommentAttachmentWirePayload {
  id: string;
  name: string;
  size: number;
  type: string;
  attachmentId: string;
}

export interface AddDocCommentSuccessResult {
  ok: true;
  file_id: string;
  thread_id: string;
  comment_id: string;
  text: string;
  verified: true;
  comments: ZoomDocsCommentsResult;
  attachments?: AddDocCommentUploadedAttachment[];
}

export interface AddDocCommentFailureResult {
  ok: false;
  file_id: string;
  error_code: 'EMPTY_COMMENT' | 'ATTACHMENT_UPLOAD_FAILED' | 'NOT_VERIFIED';
  message: string;
  thread_id?: string;
  comment_id?: string;
  comments?: ZoomDocsCommentsResult;
}

export type AddDocCommentResult = AddDocCommentSuccessResult | AddDocCommentFailureResult;

export interface ReplyToCommentSuccessResult {
  ok: true;
  file_id: string;
  thread_id: string;
  parent_comment_id: string;
  comment_id: string;
  text: string;
  verified: true;
  comments: ZoomDocsCommentsResult;
}

export interface ReplyToCommentFailureResult {
  ok: false;
  file_id: string;
  thread_id: string;
  parent_comment_id: string;
  error_code: 'EMPTY_COMMENT' | 'PARENT_COMMENT_NOT_FOUND' | 'NOT_VERIFIED';
  message: string;
  comment_id?: string;
  comments?: ZoomDocsCommentsResult;
}

export type ReplyToCommentResult = ReplyToCommentSuccessResult | ReplyToCommentFailureResult;

export interface ResolveCommentThreadSuccessResult {
  ok: true;
  file_id: string;
  thread_id: string;
  verified: true;
  comments: ZoomDocsCommentsResult;
}

export interface ResolveCommentThreadFailureResult {
  ok: false;
  file_id: string;
  thread_id: string;
  error_code: 'THREAD_NOT_FOUND' | 'NOT_VERIFIED';
  message: string;
  comments?: ZoomDocsCommentsResult;
}

export type ResolveCommentThreadResult = ResolveCommentThreadSuccessResult | ResolveCommentThreadFailureResult;

export interface ReopenCommentThreadSuccessResult {
  ok: true;
  file_id: string;
  thread_id: string;
  verified: true;
  comments: ZoomDocsCommentsResult;
}

export interface ReopenCommentThreadFailureResult {
  ok: false;
  file_id: string;
  thread_id: string;
  error_code: 'THREAD_NOT_FOUND' | 'NOT_VERIFIED';
  message: string;
  comments?: ZoomDocsCommentsResult;
}

export type ReopenCommentThreadResult = ReopenCommentThreadSuccessResult | ReopenCommentThreadFailureResult;

export interface DeleteCommentSuccessResult {
  ok: true;
  file_id: string;
  thread_id: string;
  comment_id: string;
  verified: true;
  comments: ZoomDocsCommentsResult;
}

export interface DeleteCommentFailureResult {
  ok: false;
  file_id: string;
  thread_id: string;
  comment_id: string;
  error_code: 'COMMENT_NOT_FOUND' | 'ROOT_COMMENT_DELETE_NOT_VERIFIED' | 'NOT_VERIFIED';
  message: string;
  comments?: ZoomDocsCommentsResult;
}

export type DeleteCommentResult = DeleteCommentSuccessResult | DeleteCommentFailureResult;

export interface InlineCommentCleanupResult {
  attempted: boolean;
  resolved_thread?: boolean;
  removed_marker?: boolean;
  message?: string;
}

export interface AddInlineCommentSuccessResult {
  ok: true;
  file_id: string;
  block_id: string;
  thread_id: string;
  comment_id: string;
  selected_text: string;
  text: string;
  verified: true;
  comments: ZoomDocsCommentsResult;
}

export interface AddInlineCommentFailureResult {
  ok: false;
  file_id: string;
  error_code:
    | 'EMPTY_COMMENT'
    | 'EMPTY_SELECTION'
    | 'UNSUPPORTED_TARGET'
    | 'NO_MATCH'
    | 'AMBIGUOUS_MATCH'
    | 'INLINE_CONTENT_RISK'
    | 'MARKER_INSERT_FAILED'
    | 'NOT_VERIFIED';
  message: string;
  block_id?: string;
  thread_id?: string;
  comment_id?: string;
  cleanup?: InlineCommentCleanupResult;
  candidates?: EditDocCandidate[];
  comments?: ZoomDocsCommentsResult;
}

export type AddInlineCommentResult = AddInlineCommentSuccessResult | AddInlineCommentFailureResult;

export interface AddCommentReactionSuccessResult {
  ok: true;
  file_id: string;
  thread_id: string;
  comment_id: string;
  reaction_id: string;
  reaction: string;
  verified: true;
  comments: ZoomDocsCommentsResult;
}

export interface AddCommentReactionFailureResult {
  ok: false;
  file_id: string;
  error_code: 'EMPTY_REACTION' | 'COMMENT_NOT_FOUND' | 'NOT_VERIFIED';
  message: string;
  thread_id: string;
  comment_id: string;
  reaction_id?: string;
  comments?: ZoomDocsCommentsResult;
}

export type AddCommentReactionResult = AddCommentReactionSuccessResult | AddCommentReactionFailureResult;

interface RawCommentThreadsPayload {
  threads?: unknown;
  users?: unknown;
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

export type PermissionAccessScope = 'account' | 'anyone_with_link';
export type PermissionAccessRole = 'noAccess' | 'viewer' | 'commenter' | 'editor';
export type PermissionAccessSettingItem = 'accountPermissionSetting' | 'linkPermissionSetting';
export type CollaboratorRole = 'viewer' | 'commenter' | 'editor';

export interface ShareTargetUser {
  user_id: string;
  account_id?: string;
  display_name: string;
  email?: string;
  avatar_url?: string;
}

export interface ShareTargetChannel {
  channel_id: string;
  name: string;
  channel_type?: string;
  channel_icon_type?: string;
  member_count?: number;
}

export interface ShareTargetSearchResult {
  query: string;
  users: ShareTargetUser[];
  channels: ShareTargetChannel[];
}

export interface ZoomDocsAccessInfo {
  file_id: string;
  file: Record<string, unknown> | null;
  share_status: Record<string, unknown>;
  publish: Record<string, unknown>;
  permission_requests: Record<string, unknown>;
  ancestor_permission_infos: Array<Record<string, unknown>>;
  permission_info: Record<string, unknown> | null;
}

export interface SetPermissionAccessSuccessResult {
  ok: true;
  file_id: string;
  scope: PermissionAccessScope;
  role: PermissionAccessRole;
  setting_item: PermissionAccessSettingItem;
  access_info: ZoomDocsAccessInfo;
}

export interface SetPermissionAccessFailureResult {
  ok: false;
  error_code: 'VERIFICATION_FAILED';
  message: string;
  file_id: string;
  expected: {
    setting_item: PermissionAccessSettingItem;
    role: PermissionAccessRole;
  };
  actual: {
    setting_item: string | null;
    role: string | null;
  };
  access_info: ZoomDocsAccessInfo;
}

export type SetPermissionAccessResult = SetPermissionAccessSuccessResult | SetPermissionAccessFailureResult;

export interface CollaboratorVerificationFailureResult {
  ok: false;
  error_code: 'VERIFICATION_FAILED';
  message: string;
  file_id: string;
  user_id: string;
  expected: {
    present?: boolean;
    role?: CollaboratorRole;
  };
  actual: {
    present: boolean;
    role: string | null;
  };
  access_info: ZoomDocsAccessInfo;
}

export interface AddUserCollaboratorSuccessResult {
  ok: true;
  file_id: string;
  user_id: string;
  role: CollaboratorRole;
  access_info: ZoomDocsAccessInfo;
}

export interface SetUserCollaboratorRoleSuccessResult {
  ok: true;
  file_id: string;
  user_id: string;
  role: CollaboratorRole;
  access_info: ZoomDocsAccessInfo;
}

export interface RemoveUserCollaboratorSuccessResult {
  ok: true;
  file_id: string;
  user_id: string;
  access_info: ZoomDocsAccessInfo;
}

export type AddUserCollaboratorResult = AddUserCollaboratorSuccessResult | CollaboratorVerificationFailureResult;
export type SetUserCollaboratorRoleResult = SetUserCollaboratorRoleSuccessResult | CollaboratorVerificationFailureResult;
export type RemoveUserCollaboratorResult = RemoveUserCollaboratorSuccessResult | CollaboratorVerificationFailureResult;

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

  async createDoc({
    title,
    markdown,
    parentId,
  }: {
    title?: string;
    markdown: string;
    parentId?: string;
  }): Promise<CreateDocResult> {
    const resolvedParentId = extractFileId(parentId || 'my-docs');
    const resolvedTitle = title?.trim() || 'Untitled';
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
      file_id: payload.fileId,
      file_link: payload.fileLink,
      parent_id: resolvedParentId,
    };
  }

  async createReplacementCopy({
    targetFileId,
    markdown,
    title,
  }: {
    targetFileId: string;
    markdown: string;
    title?: string;
  }): Promise<CreateReplacementCopyResult> {
    const target = await this.getMetadata({ fileId: targetFileId });
    const resolvedParentId = target.parentId || 'my-docs';
    const resolvedTitle = title?.trim() || target.title || 'Untitled';
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
      file_id: payload.fileId,
      file_link: payload.fileLink,
      parent_id: resolvedParentId,
      replaced_file_id: target.id,
    };
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

  async searchShareTargets({ query }: { query: string }): Promise<ShareTargetSearchResult> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      throw new Error('query is required');
    }

    const payload = await this.transport.requestJson<{
      users?: Array<Record<string, unknown>>;
      channels?: Array<Record<string, unknown>>;
    }>({
      method: 'POST',
      path: '/api/user/contact',
      body: { keyword: normalizedQuery },
    });

    return {
      query: normalizedQuery,
      users: (payload.users ?? []).flatMap((user) => this.normalizeShareTargetUser(user)),
      channels: (payload.channels ?? []).flatMap((channel) => this.normalizeShareTargetChannel(channel)),
    };
  }

  private normalizeShareTargetUser(user: Record<string, unknown>): ShareTargetUser[] {
    const userId = user.userId;
    const displayName = user.displayName;
    if (typeof userId !== 'string' || !userId || typeof displayName !== 'string') return [];

    return [{
      user_id: userId,
      ...(typeof user.accountId === 'string' ? { account_id: user.accountId } : {}),
      display_name: displayName,
      ...(typeof user.email === 'string' && user.email ? { email: user.email } : {}),
      ...(typeof user.avatarUrl === 'string' && user.avatarUrl ? { avatar_url: user.avatarUrl } : {}),
    }];
  }

  private normalizeShareTargetChannel(channel: Record<string, unknown>): ShareTargetChannel[] {
    const channelId = channel.channelId;
    const name = channel.name;
    if (typeof channelId !== 'string' || !channelId || typeof name !== 'string') return [];

    return [{
      channel_id: channelId,
      name,
      ...(typeof channel.channelType === 'string' ? { channel_type: channel.channelType } : {}),
      ...(typeof channel.channelIconType === 'string' ? { channel_icon_type: channel.channelIconType } : {}),
      ...(typeof channel.memberCount === 'number' ? { member_count: channel.memberCount } : {}),
    }];
  }

  async getAccessInfo({ fileId }: { fileId: string }): Promise<ZoomDocsAccessInfo> {
    const resolvedFileId = extractFileId(fileId);
    const encodedFileId = encodeURIComponent(resolvedFileId);

    const [filePayload, shareStatus, publish, permissionRequests, ancestorPermissions] = await Promise.all([
      this.transport.requestJson<{ successItems?: Array<Record<string, unknown>> }>({
        method: 'POST',
        path: '/api/file/files/action/batch_get',
        body: { ids: [resolvedFileId] },
        fileId: resolvedFileId,
      }),
      this.transport.requestJson<Record<string, unknown>>({
        method: 'GET',
        path: `/api/file/files/${encodedFileId}/share_status`,
        fileId: resolvedFileId,
      }),
      this.transport.requestJson<Record<string, unknown>>({
        method: 'GET',
        path: `/api/file/files/${encodedFileId}/publish`,
        fileId: resolvedFileId,
      }),
      this.transport.requestJson<Record<string, unknown>>({
        method: 'GET',
        path: `/api/file/files/${encodedFileId}/permission_request?limit=50`,
        fileId: resolvedFileId,
      }),
      this.transport.requestJson<{ ancestorPermissionInfos?: Array<Record<string, unknown>> }>({
        method: 'GET',
        path: `/api/file/files/${encodedFileId}/ancestors/permission?flattenInherit=true`,
        fileId: resolvedFileId,
      }),
    ]);

    const file = filePayload.successItems?.[0] ?? null;
    const ancestorPermissionInfos = Array.isArray(ancestorPermissions.ancestorPermissionInfos)
      ? ancestorPermissions.ancestorPermissionInfos
      : [];
    const currentFilePermission = ancestorPermissionInfos.find((info) => info.id === resolvedFileId) ?? ancestorPermissionInfos[0];
    const permissionInfo = currentFilePermission?.permissionInfo;

    return {
      file_id: resolvedFileId,
      file,
      share_status: shareStatus,
      publish,
      permission_requests: permissionRequests,
      ancestor_permission_infos: ancestorPermissionInfos,
      permission_info:
        permissionInfo && typeof permissionInfo === 'object' && !Array.isArray(permissionInfo)
          ? permissionInfo as Record<string, unknown>
          : null,
    };
  }

  async setPermissionAccess({
    fileId,
    scope,
    role,
  }: {
    fileId: string;
    scope: PermissionAccessScope;
    role: PermissionAccessRole;
  }): Promise<SetPermissionAccessResult> {
    const resolvedFileId = extractFileId(fileId);
    const encodedFileId = encodeURIComponent(resolvedFileId);
    const settingItem = this.permissionSettingItemForScope(scope);

    await this.transport.requestJson({
      method: 'PATCH',
      path: `/api/file/files/${encodedFileId}/permission`,
      body: {
        id: resolvedFileId,
        permissionSetting: {
          settingItem,
          role: { role, newRole: role },
        },
        propagatePermissionChanges: true,
      },
      fileId: resolvedFileId,
    });

    const accessInfo = await this.getAccessInfo({ fileId: resolvedFileId });
    const actual = this.currentLinkAccessState(accessInfo.permission_info);
    if (actual.setting_item !== settingItem || actual.role !== role) {
      return {
        ok: false,
        error_code: 'VERIFICATION_FAILED',
        message: `Permission access update did not verify. Expected ${settingItem}/${role}, got ${actual.setting_item ?? 'unknown'}/${actual.role ?? 'unknown'}.`,
        file_id: resolvedFileId,
        expected: { setting_item: settingItem, role },
        actual,
        access_info: accessInfo,
      };
    }

    return {
      ok: true,
      file_id: resolvedFileId,
      scope,
      role,
      setting_item: settingItem,
      access_info: accessInfo,
    };
  }

  async addUserCollaborator({
    fileId,
    userId,
    role,
    sendEmail = true,
    sendChatMessage = true,
    allowDowngrade = true,
  }: {
    fileId: string;
    userId: string;
    role: CollaboratorRole;
    sendEmail?: boolean;
    sendChatMessage?: boolean;
    allowDowngrade?: boolean;
  }): Promise<AddUserCollaboratorResult> {
    const resolvedFileId = extractFileId(fileId);
    const resolvedUserId = userId.trim();
    if (!resolvedUserId) {
      throw new Error('user_id is required');
    }

    const encodedFileId = encodeURIComponent(resolvedFileId);
    await this.transport.requestJson({
      method: 'POST',
      path: `/api/file/files/${encodedFileId}/collaborators`,
      body: {
        id: resolvedFileId,
        collaboratorInfo: [
          {
            collaboratorId: { userId: resolvedUserId },
            role: { role, newRole: role },
          },
        ],
        sendEmail,
        allowDowngrade,
        sendChatMessage,
      },
      fileId: resolvedFileId,
    });

    const accessInfo = await this.getAccessInfo({ fileId: resolvedFileId });
    const actual = this.userCollaboratorState(accessInfo.permission_info, resolvedUserId);
    if (!actual.present || actual.role !== role) {
      return {
        ok: false,
        error_code: 'VERIFICATION_FAILED',
        message: `User collaborator update did not verify. Expected ${resolvedUserId}/${role}, got ${actual.present ? actual.role ?? 'unknown' : 'absent'}.`,
        file_id: resolvedFileId,
        user_id: resolvedUserId,
        expected: { role },
        actual,
        access_info: accessInfo,
      };
    }

    return {
      ok: true,
      file_id: resolvedFileId,
      user_id: resolvedUserId,
      role,
      access_info: accessInfo,
    };
  }

  async setUserCollaboratorRole({
    fileId,
    userId,
    role,
    isEmailInvitee = false,
  }: {
    fileId: string;
    userId: string;
    role: CollaboratorRole;
    isEmailInvitee?: boolean;
  }): Promise<SetUserCollaboratorRoleResult> {
    const resolvedFileId = extractFileId(fileId);
    const resolvedUserId = userId.trim();
    if (!resolvedUserId) {
      throw new Error('user_id is required');
    }

    const encodedFileId = encodeURIComponent(resolvedFileId);
    await this.transport.requestJson({
      method: 'PATCH',
      path: `/api/file/files/${encodedFileId}/collaborators`,
      body: {
        id: resolvedFileId,
        collaboratorInfo: {
          collaboratorId: { userId: resolvedUserId },
          role: { role, newRole: role },
          isEmailInvitee,
        },
        propagatePermissionChanges: true,
      },
      fileId: resolvedFileId,
    });

    const accessInfo = await this.getAccessInfo({ fileId: resolvedFileId });
    const actual = this.userCollaboratorState(accessInfo.permission_info, resolvedUserId);
    if (!actual.present || actual.role !== role) {
      return {
        ok: false,
        error_code: 'VERIFICATION_FAILED',
        message: `User collaborator role update did not verify. Expected ${resolvedUserId}/${role}, got ${actual.present ? actual.role ?? 'unknown' : 'absent'}.`,
        file_id: resolvedFileId,
        user_id: resolvedUserId,
        expected: { role },
        actual,
        access_info: accessInfo,
      };
    }

    return {
      ok: true,
      file_id: resolvedFileId,
      user_id: resolvedUserId,
      role,
      access_info: accessInfo,
    };
  }

  async removeUserCollaborator({
    fileId,
    userId,
    isEmailInvitee = false,
  }: {
    fileId: string;
    userId: string;
    isEmailInvitee?: boolean;
  }): Promise<RemoveUserCollaboratorResult> {
    const resolvedFileId = extractFileId(fileId);
    const resolvedUserId = userId.trim();
    if (!resolvedUserId) {
      throw new Error('user_id is required');
    }

    const encodedFileId = encodeURIComponent(resolvedFileId);
    await this.transport.requestJson({
      method: 'POST',
      path: `/api/file/files/${encodedFileId}/collaborators/action/remove`,
      body: {
        id: resolvedFileId,
        collaboratorIds: [{ userId: resolvedUserId }],
        targets: [{ collaboratorId: { userId: resolvedUserId }, isEmailInvitee }],
        propagatePermissionChanges: true,
      },
      fileId: resolvedFileId,
    });

    const accessInfo = await this.getAccessInfo({ fileId: resolvedFileId });
    const actual = this.userCollaboratorState(accessInfo.permission_info, resolvedUserId);
    if (actual.present) {
      return {
        ok: false,
        error_code: 'VERIFICATION_FAILED',
        message: `User collaborator removal did not verify. Expected ${resolvedUserId} to be absent, got ${actual.role ?? 'unknown'}.`,
        file_id: resolvedFileId,
        user_id: resolvedUserId,
        expected: { present: false },
        actual,
        access_info: accessInfo,
      };
    }

    return {
      ok: true,
      file_id: resolvedFileId,
      user_id: resolvedUserId,
      access_info: accessInfo,
    };
  }

  private userCollaboratorState(permissionInfo: Record<string, unknown> | null, userId: string): {
    present: boolean;
    role: string | null;
  } {
    const collaborators = permissionInfo?.collaborators;
    if (!Array.isArray(collaborators)) return { present: false, role: null };

    for (const collaborator of collaborators) {
      if (!collaborator || typeof collaborator !== 'object' || Array.isArray(collaborator)) continue;
      const collaboratorRecord = collaborator as Record<string, unknown>;
      const user = collaboratorRecord.user;
      if (!user || typeof user !== 'object' || Array.isArray(user)) continue;
      if ((user as Record<string, unknown>).id !== userId) continue;

      const rolePayload = collaboratorRecord.role;
      const role = rolePayload && typeof rolePayload === 'object' && !Array.isArray(rolePayload)
        ? (rolePayload as Record<string, unknown>).role
        : null;
      return { present: true, role: typeof role === 'string' ? role : null };
    }

    return { present: false, role: null };
  }

  private permissionSettingItemForScope(scope: PermissionAccessScope): PermissionAccessSettingItem {
    return scope === 'account' ? 'accountPermissionSetting' : 'linkPermissionSetting';
  }

  private currentLinkAccessState(permissionInfo: Record<string, unknown> | null): {
    setting_item: string | null;
    role: string | null;
  } {
    const currentLinkAccess = permissionInfo?.currentLinkAccess;
    if (!currentLinkAccess || typeof currentLinkAccess !== 'object' || Array.isArray(currentLinkAccess)) {
      return { setting_item: null, role: null };
    }

    const access = currentLinkAccess as Record<string, unknown>;
    const rolePayload = access.role;
    const role = rolePayload && typeof rolePayload === 'object' && !Array.isArray(rolePayload)
      ? (rolePayload as Record<string, unknown>).role
      : null;

    return {
      setting_item: typeof access.settingItem === 'string' ? access.settingItem : null,
      role: typeof role === 'string' ? role : null,
    };
  }

  async listBlocks({ fileId }: { fileId: string }): Promise<ListBlocksResult> {
    const resolvedFileId = extractFileId(fileId);
    const blocks = await this.fetchBlocks(resolvedFileId);
    return { fileId: resolvedFileId, blocks: summarizeBlocks(blocks, { rootId: resolvedFileId }) };
  }

  async getEditOutline({ fileId }: { fileId: string }): Promise<EditOutlineResult> {
    const resolvedFileId = extractFileId(fileId);
    const blocks = await this.fetchBlocks(resolvedFileId);
    const snapshots = buildEditableBlockSnapshots(blocks, { rootId: resolvedFileId });
    return {
      file_id: resolvedFileId,
      ...this.buildEditOutline(snapshots),
    };
  }

  async getComments({
    fileId,
    threadStatus = 'open',
    threadId,
  }: {
    fileId: string;
    threadStatus?: ZoomDocsCommentThreadStatus;
    threadId?: string;
  }): Promise<ZoomDocsCommentsResult> {
    const resolvedFileId = extractFileId(fileId);
    const encodedFileId = encodeURIComponent(resolvedFileId);
    const docUrl = buildZoomDocFileLink('doc', resolvedFileId);
    const blocks = await this.fetchBlocks(resolvedFileId);
    const inlineThreadIds = this.extractInlineCommentThreadIds(blocks);
    const inlineThreadIdsToFetch = threadId ? [threadId] : inlineThreadIds;

    const users: Record<string, ZoomDocsCommentUser> = {};
    const threads: ZoomDocsCommentThread[] = [];

    if (inlineThreadIdsToFetch.length > 0) {
      const inlinePayload = await this.transport.requestJson<RawCommentThreadsPayload>({
        method: 'POST',
        path: `/api/comment/threads:batchGet?fileId=${encodedFileId}`,
        body: { threadIds: inlineThreadIdsToFetch, threadStatus },
        fileId: resolvedFileId,
      });
      Object.assign(users, this.normalizeCommentUsers(inlinePayload.users));
      threads.push(...this.normalizeCommentThreads(inlinePayload.threads, 'inline', docUrl).filter((thread) => thread.comment_type === 1));
    }

    const discussionPayload = await this.transport.requestJson<RawCommentThreadsPayload & { nextCursor?: string }>({
      method: 'POST',
      path: `/api/comment/discussions:batchGet?fileId=${encodedFileId}`,
      body: { commentType: 2, threadStatus, limit: 200, cursor: '' },
      fileId: resolvedFileId,
    });
    Object.assign(users, this.normalizeCommentUsers(discussionPayload.users));
    threads.push(...this.normalizeCommentThreads(discussionPayload.threads, 'discussion', docUrl));

    const filteredThreads = threadId ? threads.filter((thread) => thread.thread_id === threadId) : threads;
    return {
      file_id: resolvedFileId,
      doc_url: docUrl,
      thread_status: threadStatus,
      ...(threadId ? { filtered_thread_id: threadId } : {}),
      inline_thread_ids: inlineThreadIds,
      threads: filteredThreads,
      users,
      ...(typeof discussionPayload.nextCursor === 'string' ? { discussion_next_cursor: discussionPayload.nextCursor } : {}),
    };
  }

  async addDocComment({
    fileId,
    text,
    contentParts,
    attachments,
  }: {
    fileId: string;
    text?: string;
    contentParts?: AddDocCommentContentPart[];
    attachments?: AddDocCommentAttachmentInput[];
  }): Promise<AddDocCommentResult> {
    const resolvedFileId = extractFileId(fileId);
    const commentContent = this.buildCommentContent({ text, contentParts });
    const normalizedText = commentContent.text;
    if (!normalizedText.trim()) {
      return {
        ok: false,
        file_id: resolvedFileId,
        error_code: 'EMPTY_COMMENT',
        message: 'Comment text is required.',
      };
    }

    const encodedFileId = encodeURIComponent(resolvedFileId);
    let uploadedAttachments: CommentAttachmentWirePayload[];
    try {
      uploadedAttachments = await this.uploadCommentAttachments({ fileId: resolvedFileId, attachments });
    } catch (error) {
      return {
        ok: false,
        file_id: resolvedFileId,
        error_code: 'ATTACHMENT_UPLOAD_FAILED',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    const threadId = randomUUID().replace(/-/g, '');
    const commentId = randomUUID().replace(/-/g, '');
    await this.transport.requestJson({
      method: 'POST',
      path: `/api/comment/threads?fileId=${encodedFileId}`,
      body: {
        threadId,
        selectContent: '',
        commentContent: JSON.stringify(commentContent.payload),
        attachments: JSON.stringify(uploadedAttachments),
        rootBlockId: resolvedFileId,
        commentId,
        blockIds: [resolvedFileId],
        commentType: 2,
        fileId: resolvedFileId,
      },
      fileId: resolvedFileId,
    });

    const comments = await this.fetchCommentsUntilComment({
      fileId: resolvedFileId,
      threadId,
      commentId,
      threadStatus: 'open',
    });
    const verified = this.commentsContainComment(comments, { threadId, commentId });
    if (!verified) {
      return {
        ok: false,
        file_id: resolvedFileId,
        error_code: 'NOT_VERIFIED',
        message: 'Zoom Docs comment creation was not verified by read-back.',
        thread_id: threadId,
        comment_id: commentId,
        comments,
      };
    }

    return {
      ok: true,
      file_id: resolvedFileId,
      thread_id: threadId,
      comment_id: commentId,
      text: normalizedText,
      verified: true,
      comments,
      ...(uploadedAttachments.length > 0 ? { attachments: uploadedAttachments.map((attachment) => this.toUploadedAttachmentResult(attachment)) } : {}),
    };
  }

  private async uploadCommentAttachments({
    fileId,
    attachments,
  }: {
    fileId: string;
    attachments?: AddDocCommentAttachmentInput[];
  }): Promise<CommentAttachmentWirePayload[]> {
    if (!attachments || attachments.length === 0) return [];

    const encodedFileId = encodeURIComponent(fileId);
    const uploaded: CommentAttachmentWirePayload[] = [];
    for (const attachment of attachments) {
      const data = await readFile(attachment.path);
      const name = attachment.name?.trim() || basename(attachment.path);
      const contentType = attachment.contentType?.trim() || this.inferContentType(name);
      const uploadInfo = await this.transport.requestJson<{
        attachmentId?: string;
        signedPutUrl?: string;
        putHeaders?: Record<string, string>;
      }>({
        method: 'POST',
        path: `/api/attachment/getUploadFileUrl?fileId=${encodedFileId}`,
        body: {
          bucket: 8,
          name,
          contentType,
          contentLength: data.byteLength,
          permissionRecord: { pageId: fileId, blockId: fileId },
        },
        fileId,
      });

      if (!uploadInfo.attachmentId || !uploadInfo.signedPutUrl) {
        throw new Error(`Zoom Docs attachment upload URL missing for ${name}`);
      }

      const formData = new FormData();
      formData.append('file', new Blob([data], { type: contentType }), name);

      const response = await fetch(uploadInfo.signedPutUrl, {
        method: 'POST',
        headers: uploadInfo.putHeaders ?? {},
        body: formData,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Zoom Docs attachment upload failed for ${name}: ${response.status}${body ? ` ${body}` : ''}`);
      }

      uploaded.push({
        id: randomUUID().replace(/-/g, ''),
        name,
        size: data.byteLength,
        type: contentType,
        attachmentId: uploadInfo.attachmentId,
      });
    }

    return uploaded;
  }

  private toUploadedAttachmentResult(attachment: CommentAttachmentWirePayload): AddDocCommentUploadedAttachment {
    return {
      id: attachment.id,
      name: attachment.name,
      size: attachment.size,
      type: attachment.type,
      attachment_id: attachment.attachmentId,
    };
  }

  private inferContentType(name: string): string {
    const extension = extname(name).toLowerCase();
    if (extension === '.pdf') return 'application/pdf';
    if (extension === '.txt') return 'text/plain';
    if (extension === '.md') return 'text/markdown';
    if (extension === '.json') return 'application/json';
    if (extension === '.png') return 'image/png';
    if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
    if (extension === '.gif') return 'image/gif';
    if (extension === '.webp') return 'image/webp';
    return 'application/octet-stream';
  }

  async replyToComment({
    fileId,
    threadId,
    parentCommentId,
    text,
    threadStatus = 'open',
  }: {
    fileId: string;
    threadId: string;
    parentCommentId: string;
    text: string;
    threadStatus?: ZoomDocsCommentThreadStatus;
  }): Promise<ReplyToCommentResult> {
    const resolvedFileId = extractFileId(fileId);
    if (!text.trim()) {
      return {
        ok: false,
        file_id: resolvedFileId,
        thread_id: threadId,
        parent_comment_id: parentCommentId,
        error_code: 'EMPTY_COMMENT',
        message: 'Reply text is required.',
      };
    }

    const before = await this.getComments({ fileId: resolvedFileId, threadStatus });
    const parentComment = before.threads
      .find((thread) => thread.thread_id === threadId)
      ?.comments.find((comment) => comment.comment_id === parentCommentId);
    if (!parentComment) {
      return {
        ok: false,
        file_id: resolvedFileId,
        thread_id: threadId,
        parent_comment_id: parentCommentId,
        error_code: 'PARENT_COMMENT_NOT_FOUND',
        message: 'Parent comment was not found in the requested thread/status bucket.',
        comments: before,
      };
    }

    const encodedFileId = encodeURIComponent(resolvedFileId);
    const commentId = randomUUID().replace(/-/g, '');
    await this.transport.requestJson({
      method: 'POST',
      path: `/api/comment/comments?fileId=${encodedFileId}`,
      body: {
        threadId,
        commentContent: JSON.stringify({ text }),
        attachments: '[]',
        parentComment: JSON.stringify({
          id: parentComment.comment_id,
          content: JSON.stringify({ text: parentComment.text }),
          attachments: this.parentCommentAttachmentsPayload(parentComment),
          createdBy: parentComment.created_by ?? '',
        }),
        commentId,
        blockIds: [],
        fileId: resolvedFileId,
      },
      fileId: resolvedFileId,
    });

    const comments = await this.fetchCommentsUntilComment({
      fileId: resolvedFileId,
      threadId,
      commentId,
      threadStatus,
    });
    if (!this.commentsContainComment(comments, { threadId, commentId })) {
      return {
        ok: false,
        file_id: resolvedFileId,
        thread_id: threadId,
        parent_comment_id: parentCommentId,
        error_code: 'NOT_VERIFIED',
        message: 'Zoom Docs reply creation was not verified by read-back.',
        comment_id: commentId,
        comments,
      };
    }

    return {
      ok: true,
      file_id: resolvedFileId,
      thread_id: threadId,
      parent_comment_id: parentCommentId,
      comment_id: commentId,
      text,
      verified: true,
      comments,
    };
  }

  private parentCommentAttachmentsPayload(comment: ZoomDocsComment): string {
    if (!comment.attachments?.length) return '';
    return JSON.stringify(comment.attachments.map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      type: attachment.type,
      size: attachment.size ?? 0,
      attachmentId: attachment.attachment_id,
    })));
  }

  private buildCommentContent({
    text,
    contentParts,
  }: {
    text?: string;
    contentParts?: AddDocCommentContentPart[];
  }): { text: string; payload: unknown } {
    if (!contentParts || contentParts.length === 0) {
      const plainText = text ?? '';
      return { text: plainText, payload: { text: plainText } };
    }

    const content = contentParts.map((part) => {
      if (part.type === 'mention') {
        return {
          data: {
            person: {
              mentionId: randomUUID().replace(/-/g, ''),
              userId: part.userId,
              name: part.name,
              notify: part.notify ?? true,
            },
          },
        };
      }
      return { data: part.text };
    });
    const renderedText = `${contentParts.map((part) => part.type === 'mention' ? part.name : part.text).join('')}\n`;

    return {
      text: renderedText,
      payload: {
        doc: [
          { type: 'BLOCK_TYPE_PARAGRAPH', content },
          { type: 'BLOCK_TYPE_PARAGRAPH', content: [] },
        ],
        text: renderedText,
      },
    };
  }

  async resolveCommentThread({
    fileId,
    threadId,
  }: {
    fileId: string;
    threadId: string;
  }): Promise<ResolveCommentThreadResult> {
    const resolvedFileId = extractFileId(fileId);
    const before = await this.getComments({ fileId: resolvedFileId, threadStatus: 'open', threadId });
    if (!before.threads.some((thread) => thread.thread_id === threadId)) {
      return {
        ok: false,
        file_id: resolvedFileId,
        thread_id: threadId,
        error_code: 'THREAD_NOT_FOUND',
        message: 'Thread was not found in the open comments bucket.',
        comments: before,
      };
    }

    const encodedFileId = encodeURIComponent(resolvedFileId);
    await this.transport.requestJson({
      method: 'PATCH',
      path: `/api/comment/threads/${encodeURIComponent(threadId)}?fileId=${encodedFileId}`,
      body: { threadStatus: 'resolved' },
      fileId: resolvedFileId,
    });

    const comments = await this.fetchCommentsUntilThreadStatus({
      fileId: resolvedFileId,
      threadId,
      threadStatus: 'resolved',
    });
    if (!this.commentsContainThreadStatus(comments, { threadId, threadStatus: 'resolved' })) {
      return {
        ok: false,
        file_id: resolvedFileId,
        thread_id: threadId,
        error_code: 'NOT_VERIFIED',
        message: 'Zoom Docs thread resolution was not verified by read-back.',
        comments,
      };
    }

    return {
      ok: true,
      file_id: resolvedFileId,
      thread_id: threadId,
      verified: true,
      comments,
    };
  }

  async deleteComment({
    fileId,
    threadId,
    commentId,
    threadStatus = 'open',
  }: {
    fileId: string;
    threadId: string;
    commentId: string;
    threadStatus?: ZoomDocsCommentThreadStatus;
  }): Promise<DeleteCommentResult> {
    const resolvedFileId = extractFileId(fileId);
    const before = await this.getComments({ fileId: resolvedFileId, threadStatus });
    const comment = before.threads
      .find((thread) => thread.thread_id === threadId)
      ?.comments.find((candidate) => candidate.comment_id === commentId);
    if (!comment) {
      return {
        ok: false,
        file_id: resolvedFileId,
        thread_id: threadId,
        comment_id: commentId,
        error_code: 'COMMENT_NOT_FOUND',
        message: 'Comment was not found in the requested thread/status bucket.',
        comments: before,
      };
    }

    if (!comment.parent_comment_id) {
      return {
        ok: false,
        file_id: resolvedFileId,
        thread_id: threadId,
        comment_id: commentId,
        error_code: 'ROOT_COMMENT_DELETE_NOT_VERIFIED',
        message: 'Deleting root comments or whole threads is not exposed because that flow has not been replay-verified. Delete only non-root replies for now.',
        comments: before,
      };
    }

    const encodedFileId = encodeURIComponent(resolvedFileId);
    await this.transport.requestJson({
      method: 'DELETE',
      path: `/api/comment/comments/${encodeURIComponent(commentId)}?threadId=${encodeURIComponent(threadId)}&fileId=${encodedFileId}`,
      body: {},
      fileId: resolvedFileId,
    });

    const comments = await this.fetchCommentsUntilCommentDeleted({
      fileId: resolvedFileId,
      threadId,
      commentId,
      threadStatus,
    });
    if (this.commentsContainComment(comments, { threadId, commentId })) {
      return {
        ok: false,
        file_id: resolvedFileId,
        thread_id: threadId,
        comment_id: commentId,
        error_code: 'NOT_VERIFIED',
        message: 'Zoom Docs comment deletion was not verified by read-back.',
        comments,
      };
    }

    return {
      ok: true,
      file_id: resolvedFileId,
      thread_id: threadId,
      comment_id: commentId,
      verified: true,
      comments,
    };
  }

  async addInlineComment({
    fileId,
    target,
    selectedText,
    text,
  }: {
    fileId: string;
    target: EditDocTarget;
    selectedText: string;
    text: string;
  }): Promise<AddInlineCommentResult> {
    const resolvedFileId = extractFileId(fileId);
    if (!text.trim()) {
      return {
        ok: false,
        file_id: resolvedFileId,
        error_code: 'EMPTY_COMMENT',
        message: 'Comment text is required.',
      };
    }
    if (!selectedText) {
      return {
        ok: false,
        file_id: resolvedFileId,
        error_code: 'EMPTY_SELECTION',
        message: 'selected_text is required.',
      };
    }
    if (target.by !== 'exact_text' && target.by !== 'heading' && target.by !== 'ref') {
      return {
        ok: false,
        file_id: resolvedFileId,
        error_code: 'UNSUPPORTED_TARGET',
        message: 'Unsupported inline comment target. Use exact_text, heading, or ref.',
      };
    }

    const blocks = await this.fetchBlocks(resolvedFileId);
    const snapshots = buildEditableBlockSnapshots(blocks, { rootId: resolvedFileId });
    const matches = this.findEditDocMatches(snapshots, target);
    if (matches.length === 0) {
      return {
        ok: false,
        file_id: resolvedFileId,
        error_code: 'NO_MATCH',
        message: this.noMatchMessage(target),
      };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        file_id: resolvedFileId,
        error_code: 'AMBIGUOUS_MATCH',
        message: target.by === 'exact_text'
          ? `Target matched ${matches.length} editable blocks. Add within_heading or make the target text unique.`
          : `Target matched ${matches.length} headings. Make the target text unique before commenting.`,
        candidates: matches.map((match) => this.toEditDocCandidate(match)),
      };
    }

    const match = matches[0];
    if (!match) {
      return {
        ok: false,
        file_id: resolvedFileId,
        error_code: 'NO_MATCH',
        message: this.noMatchMessage(target),
      };
    }
    if (match.hasInlineContentRisk) {
      return {
        ok: false,
        file_id: resolvedFileId,
        block_id: match.id,
        error_code: 'INLINE_CONTENT_RISK',
        message: 'Refusing to add an inline comment to a block that already contains inline annotations or objects.',
        candidates: [this.toEditDocCandidate(match)],
      };
    }

    const matchCount = this.countSubstringOccurrences(match.text, selectedText);
    if (matchCount === 0) {
      return {
        ok: false,
        file_id: resolvedFileId,
        block_id: match.id,
        error_code: 'NO_MATCH',
        message: 'selected_text was not found in the matched block.',
        candidates: [this.toEditDocCandidate(match)],
      };
    }
    if (matchCount > 1) {
      return {
        ok: false,
        file_id: resolvedFileId,
        block_id: match.id,
        error_code: 'AMBIGUOUS_MATCH',
        message: `selected_text matched ${matchCount} times in the matched block. Make selected_text unique before commenting.`,
        candidates: [this.toEditDocCandidate(match)],
      };
    }

    const selectionStart = match.text.indexOf(selectedText);
    const encodedFileId = encodeURIComponent(resolvedFileId);
    const threadId = randomUUID().replace(/-/g, '');
    const commentId = randomUUID().replace(/-/g, '');

    await this.transport.requestJson({
      method: 'POST',
      path: `/api/comment/threads?fileId=${encodedFileId}`,
      body: {
        threadId,
        selectContent: selectedText,
        commentContent: JSON.stringify({ text }),
        attachments: '[]',
        rootBlockId: resolvedFileId,
        commentId,
        blockIds: [match.id],
        fileId: resolvedFileId,
      },
      fileId: resolvedFileId,
    });

    try {
      await this.insertInlineCommentMarker({
        fileId: resolvedFileId,
        blockId: match.id,
        baseVersion: this.transactionBaseVersionFromSnapshots(snapshots, resolvedFileId),
        selectionStart,
        selectionLength: selectedText.length,
        threadId,
      });
    } catch (error) {
      const cleanup = await this.cleanupInlineThread({ fileId: resolvedFileId, threadId });
      return {
        ok: false,
        file_id: resolvedFileId,
        block_id: match.id,
        thread_id: threadId,
        comment_id: commentId,
        error_code: 'MARKER_INSERT_FAILED',
        message: error instanceof Error ? error.message : String(error),
        cleanup,
      };
    }

    const comments = await this.fetchCommentsUntilInlineComment({
      fileId: resolvedFileId,
      threadId,
      commentId,
    });
    const verified = comments.inline_thread_ids.includes(threadId) && this.commentsContainComment(comments, { threadId, commentId });
    if (!verified) {
      const cleanup = await this.cleanupUnverifiedInlineComment({
        fileId: resolvedFileId,
        blockId: match.id,
        originalText: match.text,
        threadId,
        markerMayExist: comments.inline_thread_ids.includes(threadId),
      });
      return {
        ok: false,
        file_id: resolvedFileId,
        block_id: match.id,
        thread_id: threadId,
        comment_id: commentId,
        error_code: 'NOT_VERIFIED',
        message: 'Zoom Docs inline comment creation was not verified by read-back.',
        cleanup,
        comments,
      };
    }

    return {
      ok: true,
      file_id: resolvedFileId,
      block_id: match.id,
      thread_id: threadId,
      comment_id: commentId,
      selected_text: selectedText,
      text,
      verified: true,
      comments,
    };
  }

  async reopenCommentThread({
    fileId,
    threadId,
  }: {
    fileId: string;
    threadId: string;
  }): Promise<ReopenCommentThreadResult> {
    const resolvedFileId = extractFileId(fileId);
    const before = await this.getComments({ fileId: resolvedFileId, threadStatus: 'resolved', threadId });
    if (!before.threads.some((thread) => thread.thread_id === threadId)) {
      return {
        ok: false,
        file_id: resolvedFileId,
        thread_id: threadId,
        error_code: 'THREAD_NOT_FOUND',
        message: 'Thread was not found in the resolved comments bucket.',
        comments: before,
      };
    }

    const encodedFileId = encodeURIComponent(resolvedFileId);
    await this.transport.requestJson({
      method: 'PATCH',
      path: `/api/comment/threads/${encodeURIComponent(threadId)}?fileId=${encodedFileId}`,
      body: { threadStatus: 'open' },
      fileId: resolvedFileId,
    });

    const comments = await this.fetchCommentsUntilThreadStatus({
      fileId: resolvedFileId,
      threadId,
      threadStatus: 'open',
    });
    if (!this.commentsContainThreadStatus(comments, { threadId, threadStatus: 'open' })) {
      return {
        ok: false,
        file_id: resolvedFileId,
        thread_id: threadId,
        error_code: 'NOT_VERIFIED',
        message: 'Zoom Docs thread reopen was not verified by read-back.',
        comments,
      };
    }

    return {
      ok: true,
      file_id: resolvedFileId,
      thread_id: threadId,
      verified: true,
      comments,
    };
  }

  async addCommentReaction({
    fileId,
    threadId,
    commentId,
    reaction,
    threadStatus = 'open',
  }: {
    fileId: string;
    threadId: string;
    commentId: string;
    reaction: string;
    threadStatus?: ZoomDocsCommentThreadStatus;
  }): Promise<AddCommentReactionResult> {
    const resolvedFileId = extractFileId(fileId);
    if (!reaction.trim()) {
      return {
        ok: false,
        file_id: resolvedFileId,
        error_code: 'EMPTY_REACTION',
        message: 'Reaction is required.',
        thread_id: threadId,
        comment_id: commentId,
      };
    }

    const before = await this.getComments({ fileId: resolvedFileId, threadStatus, threadId });
    const targetComment = before.threads
      .find((thread) => thread.thread_id === threadId)
      ?.comments.find((comment) => comment.comment_id === commentId);
    if (!targetComment) {
      return {
        ok: false,
        file_id: resolvedFileId,
        error_code: 'COMMENT_NOT_FOUND',
        message: 'Comment was not found in the requested thread/status bucket.',
        thread_id: threadId,
        comment_id: commentId,
        comments: before,
      };
    }

    const encodedFileId = encodeURIComponent(resolvedFileId);
    const reactionId = randomUUID().replace(/-/g, '');
    await this.transport.requestJson({
      method: 'POST',
      path: `/api/comment/reactions?fileId=${encodedFileId}`,
      body: {
        threadId,
        commentId,
        reactionId,
        reaction,
      },
      fileId: resolvedFileId,
    });

    const comments = await this.fetchCommentsUntilReaction({
      fileId: resolvedFileId,
      threadId,
      commentId,
      reactionId,
      threadStatus,
    });
    if (!this.commentsContainReaction(comments, { threadId, commentId, reactionId })) {
      return {
        ok: false,
        file_id: resolvedFileId,
        error_code: 'NOT_VERIFIED',
        message: 'Zoom Docs reaction creation was not verified by read-back.',
        thread_id: threadId,
        comment_id: commentId,
        reaction_id: reactionId,
        comments,
      };
    }

    return {
      ok: true,
      file_id: resolvedFileId,
      thread_id: threadId,
      comment_id: commentId,
      reaction_id: reactionId,
      reaction,
      verified: true,
      comments,
    };
  }

  async editDoc({
    fileId,
    target,
    operation,
    dryRun = false,
  }: {
    fileId: string;
    target: EditDocTarget;
    operation: EditDocOperation;
    dryRun?: boolean;
  }): Promise<EditDocResult> {
    const resolvedFileId = extractFileId(fileId);

    if (target.by !== 'exact_text' && target.by !== 'heading' && target.by !== 'ref') {
      return {
        ok: false,
        error_code: 'UNSUPPORTED_TARGET',
        message: 'Unsupported edit target. Use exact_text, heading, or ref.',
      };
    }

    const blocks = await this.fetchBlocks(resolvedFileId);
    const snapshots = buildEditableBlockSnapshots(blocks, { rootId: resolvedFileId });
    const matches = this.findEditDocMatches(snapshots, target);

    if (matches.length === 0) {
      return {
        ok: false,
        error_code: 'NO_MATCH',
        message: this.noMatchMessage(target),
      };
    }

    if (matches.length > 1) {
      return {
        ok: false,
        error_code: 'AMBIGUOUS_MATCH',
        message:
          target.by === 'exact_text'
            ? `Target matched ${matches.length} editable blocks. Add within_heading or make the target text unique.`
            : `Target matched ${matches.length} headings. Make the heading text unique before editing.`,
        candidates: matches.map((match) => this.toEditDocCandidate(match)),
      };
    }

    const match = matches[0];
    if (!match) {
      return {
        ok: false,
        error_code: 'NO_MATCH',
        message: this.noMatchMessage(target),
      };
    }

    if (operation.type === 'insert_after' || operation.type === 'replace_section') {
      return this.editDocStructure({
        fileId: resolvedFileId,
        snapshots,
        match,
        operation,
        dryRun,
      });
    }

    if (operation.type === 'replace_text' && match.hasInlineContentRisk) {
      return {
        ok: false,
        error_code: 'INLINE_CONTENT_RISK',
        message: 'Refusing to replace this block because it contains inline annotations or objects that plain text replacement would remove.',
        candidates: [this.toEditDocCandidate(match)],
      };
    }

    const beforeText = match.text;
    const substringReplacement = operation.type === 'replace_substring'
      ? this.buildSubstringReplacement({ match, oldText: operation.old_text, newText: operation.new_text })
      : null;
    if (substringReplacement && !substringReplacement.ok) return substringReplacement;

    const replacementText = operation.type === 'replace_substring'
      ? substringReplacement?.text ?? beforeText
      : operation.type === 'append_text'
        ? operation.text
        : operation.text;
    const afterText = operation.type === 'replace_substring'
      ? substringReplacement?.text ?? beforeText
      : operation.type === 'append_text'
        ? `${beforeText}${operation.text}`
        : operation.text;
    if (dryRun) {
      const blockVersion = typeof match.raw.version === 'number' ? match.raw.version : 0;
      return {
        ok: true,
        dry_run: true,
        file_id: resolvedFileId,
        preserved_file_id: true,
        matched_block_id: match.id,
        matched_block_type: match.type,
        ...(match.heading ? { matched_heading: match.heading } : {}),
        operation_type: operation.type,
        before_text: beforeText,
        after_text: afterText,
        previous_version: blockVersion,
        new_version: blockVersion,
        warnings: [],
      };
    }

    const editResult = await this.submitBlockEditFromBlock({
      fileId: resolvedFileId,
      blockId: match.id,
      block: match.raw,
      transactionBaseVersion: this.transactionBaseVersion(blocks, resolvedFileId),
      mode: operation.type === 'append_text' ? 'append' : 'replace',
      text: replacementText,
      expectedText: afterText,
    });

    return {
      ok: true,
      file_id: resolvedFileId,
      preserved_file_id: true,
      matched_block_id: match.id,
      matched_block_type: match.type,
      ...(match.heading ? { matched_heading: match.heading } : {}),
      operation_type: operation.type,
      before_text: beforeText,
      after_text: afterText,
      previous_version: editResult.previousVersion,
      new_version: editResult.newVersion,
      warnings: [],
    };
  }

  async editDocBatch({
    fileId,
    edits,
    dryRun = false,
  }: {
    fileId: string;
    edits: EditDocBatchItem[];
    dryRun?: boolean;
  }): Promise<EditDocBatchResult> {
    const resolvedFileId = extractFileId(fileId);
    const validationResults: EditDocResult[] = [];

    for (let index = 0; index < edits.length; index += 1) {
      const edit = edits[index];
      if (!edit) continue;

      const result = await this.editDoc({
        fileId: resolvedFileId,
        target: edit.target,
        operation: edit.operation,
        dryRun: true,
      });
      validationResults.push(result);

      if (!result.ok) {
        return {
          ok: false,
          file_id: resolvedFileId,
          error_code: result.error_code,
          message: `Batch edit ${index + 1} failed validation: ${result.message}`,
          failed_edit_index: index,
          result,
          results: validationResults,
        };
      }
    }

    if (dryRun) {
      return {
        ok: true,
        dry_run: true,
        file_id: resolvedFileId,
        preserved_file_id: true,
        edit_count: validationResults.length,
        results: validationResults as EditDocSuccessResult[],
        warnings: [],
      };
    }

    for (let index = 0; index < edits.length; index += 1) {
      const operationType = edits[index]?.operation.type;
      if (operationType === 'insert_after' || operationType === 'replace_section') {
        return {
          ok: false,
          file_id: resolvedFileId,
          error_code: 'UNSUPPORTED_OPERATION',
          message: `Batch edit ${index + 1} uses ${operationType}. Mutating batches currently support replace_text, append_text, and replace_substring only. Use zoomdocs_edit_doc for structural edits.`,
          failed_edit_index: index,
          results: validationResults,
        };
      }
    }

    const targetedBlockIndex = new Map<string, number>();
    for (let index = 0; index < validationResults.length; index += 1) {
      const result = validationResults[index];
      if (!result?.ok) continue;

      const previousIndex = targetedBlockIndex.get(result.matched_block_id);
      if (previousIndex !== undefined) {
        return {
          ok: false,
          file_id: resolvedFileId,
          error_code: 'UNSUPPORTED_OPERATION',
          message: `Batch edit ${index + 1} targets block ${result.matched_block_id}, which is already targeted by batch edit ${previousIndex + 1}. Combine those edits or run separate calls.`,
          failed_edit_index: index,
          results: validationResults,
        };
      }
      targetedBlockIndex.set(result.matched_block_id, index);
    }

    const appliedResults: EditDocResult[] = [];
    for (let index = 0; index < edits.length; index += 1) {
      const edit = edits[index];
      if (!edit) continue;

      const result = await this.editDoc({
        fileId: resolvedFileId,
        target: edit.target,
        operation: edit.operation,
      });
      appliedResults.push(result);

      if (!result.ok) {
        return {
          ok: false,
          file_id: resolvedFileId,
          error_code: result.error_code,
          message: `Batch edit ${index + 1} failed after validation: ${result.message}`,
          failed_edit_index: index,
          result,
          results: appliedResults,
        };
      }
    }

    return {
      ok: true,
      file_id: resolvedFileId,
      preserved_file_id: true,
      edit_count: appliedResults.length,
      results: appliedResults as EditDocSuccessResult[],
      warnings: [],
    };
  }

  private async editDocStructure({
    fileId,
    snapshots,
    match,
    operation,
    dryRun,
  }: {
    fileId: string;
    snapshots: EditableBlockSnapshot[];
    match: EditableBlockSnapshot;
    operation: Extract<EditDocOperation, { type: 'insert_after' | 'replace_section' }>;
    dryRun: boolean;
  }): Promise<EditDocResult> {
    if (!match.parentId) {
      return {
        ok: false,
        error_code: 'UNSUPPORTED_TARGET',
        message: 'Cannot structurally edit a block without a parent.',
        candidates: [this.toEditDocCandidate(match)],
      };
    }

    const specs = parseStructuralMarkdown(operation.markdown);
    if (specs.length === 0) {
      return {
        ok: false,
        error_code: 'UNSUPPORTED_OPERATION',
        message: 'No supported structural markdown blocks were provided.',
      };
    }

    if (operation.type === 'replace_section' && headingLevelForBlockType(match.type) === undefined) {
      return {
        ok: false,
        error_code: 'UNSUPPORTED_TARGET',
        message: 'replace_section requires a heading target so the section boundary can be calculated safely.',
        candidates: [this.toEditDocCandidate(match)],
      };
    }

    const sectionBlocks = operation.type === 'replace_section' ? this.sectionBlocksAfterHeading(snapshots, match) : [];
    const unsafeSectionBlocks = sectionBlocks.filter((block) => this.hasStructuralReplacementRisk(block));
    if (unsafeSectionBlocks.length > 0) {
      return {
        ok: false,
        error_code: 'INLINE_CONTENT_RISK',
        message: 'Refusing to replace this section because it contains blocks with inline annotations/objects or unsupported structures.',
        candidates: unsafeSectionBlocks.map((block) => this.toEditDocCandidate(block)),
      };
    }

    const unsupportedSectionBlocks = sectionBlocks.filter((block) => !this.isSupportedStructuralSectionBlock(block));
    if (unsupportedSectionBlocks.length > 0) {
      return {
        ok: false,
        error_code: 'UNSUPPORTED_OPERATION',
        message: 'This section contains block types that are not safe for structural replacement yet.',
        candidates: unsupportedSectionBlocks.map((block) => this.toEditDocCandidate(block)),
      };
    }

    const previousVersion = typeof match.raw.version === 'number' ? match.raw.version : 0;
    if (dryRun) {
      return {
        ok: true,
        dry_run: true,
        file_id: fileId,
        preserved_file_id: true,
        matched_block_id: match.id,
        matched_block_type: match.type,
        ...(match.heading ? { matched_heading: match.heading } : {}),
        operation_type: operation.type,
        before_markdown: sectionBlocks.map((block) => block.text).join('\n'),
        after_markdown: operation.markdown,
        previous_version: previousVersion,
        new_version: previousVersion,
        inserted_block_count: specs.length,
        deleted_block_count: sectionBlocks.length,
        warnings: [],
      };
    }

    const userId = await this.getCurrentUserId();
    const insertedBlockIds: string[] = [];
    const deletedBlockIds = [...sectionBlocks].reverse().map((block) => block.id);
    const createOps: BlockTransactionOp[] = [];
    let afterBlockId = match.id;

    for (const spec of specs) {
      const blockId = this.generateBlockId();
      insertedBlockIds.push(blockId);
      createOps.push(
        buildCreateBlockOp({
          blockId,
          type: spec.type,
          parentBlockId: match.parentId,
          afterBlockId,
          text: spec.text,
          userId,
          style: spec.style,
        })
      );
      afterBlockId = blockId;
    }

    const ops = [
      ...deletedBlockIds.map((blockId) => buildDeleteBlockOp({ blockId })),
      ...createOps,
    ];

    const body = buildBlockOpsTransactionRequest({
      fileId,
      clientId: this.clientId,
      baseVersion: this.transactionBaseVersionFromSnapshots(snapshots, fileId),
      ops,
      reqId: randomUUID(),
      transactionId: randomUUID(),
    });

    const encodedFileId = encodeURIComponent(fileId);
    await this.transport.requestJson({
      method: 'POST',
      path: `/api/block/transactions?fileId=${encodedFileId}`,
      body,
      fileId,
    });

    const updatedBlocks = await this.fetchBlocks(fileId);
    this.verifyStructuralEdit({ updatedBlocks, insertedBlockIds, specs, deletedBlockIds });

    const updatedMatch = updatedBlocks[match.id];
    const newVersion = typeof updatedMatch?.version === 'number' ? updatedMatch.version : previousVersion;

    return {
      ok: true,
      file_id: fileId,
      preserved_file_id: true,
      matched_block_id: match.id,
      matched_block_type: match.type,
      ...(match.heading ? { matched_heading: match.heading } : {}),
      operation_type: operation.type,
      before_markdown: sectionBlocks.map((block) => block.text).join('\n'),
      after_markdown: operation.markdown,
      previous_version: previousVersion,
      new_version: newVersion,
      inserted_block_ids: insertedBlockIds,
      deleted_block_ids: deletedBlockIds,
      inserted_block_count: insertedBlockIds.length,
      deleted_block_count: deletedBlockIds.length,
      warnings: [],
    };
  }

  private generateBlockId(): string {
    return randomUUID().replace(/-/g, '');
  }

  private transactionBaseVersion(blocks: Record<string, RawBlockSummary>, fileId: string): number {
    const rootBlock = blocks[fileId] ?? Object.values(blocks).find((block) => block.type === 'BLOCK_TYPE_PAGE');
    return typeof rootBlock?.version === 'number' ? rootBlock.version : 0;
  }

  private transactionBaseVersionFromSnapshots(snapshots: EditableBlockSnapshot[], fileId: string): number {
    const rootSnapshot = snapshots.find((snapshot) => snapshot.id === fileId) ?? snapshots.find((snapshot) => snapshot.type === 'BLOCK_TYPE_PAGE');
    return typeof rootSnapshot?.raw.version === 'number' ? rootSnapshot.raw.version : 0;
  }

  private sectionBlocksAfterHeading(
    snapshots: EditableBlockSnapshot[],
    heading: EditableBlockSnapshot
  ): EditableBlockSnapshot[] {
    const headingLevel = headingLevelForBlockType(heading.type);
    if (headingLevel === undefined) return [];

    const headingIndex = snapshots.findIndex((snapshot) => snapshot.id === heading.id);
    if (headingIndex < 0) return [];

    const section: EditableBlockSnapshot[] = [];
    for (const snapshot of snapshots.slice(headingIndex + 1)) {
      const nextHeadingLevel = headingLevelForBlockType(snapshot.type);
      if (nextHeadingLevel !== undefined && nextHeadingLevel <= headingLevel) break;
      section.push(snapshot);
    }
    return section;
  }

  private hasStructuralReplacementRisk(snapshot: EditableBlockSnapshot): boolean {
    return snapshot.hasInlineContentRisk || snapshot.type === 'BLOCK_TYPE_IMAGE' || snapshot.type === 'BLOCK_TYPE_ATTACHMENT';
  }

  private isSupportedStructuralSectionBlock(snapshot: EditableBlockSnapshot): boolean {
    return this.supportedStructuralBlockTypes().has(snapshot.type);
  }

  private supportedStructuralBlockTypes(): Set<string> {
    return new Set([
      'BLOCK_TYPE_PARAGRAPH',
      'BLOCK_TYPE_BULLET',
      'BLOCK_TYPE_TODO_LIST',
      'BLOCK_TYPE_HEADING1',
      'BLOCK_TYPE_HEADING2',
      'BLOCK_TYPE_HEADING3',
      'BLOCK_TYPE_HEADING4',
      'BLOCK_TYPE_HEADING5',
      'BLOCK_TYPE_HEADING6',
      'BLOCK_TYPE_HEADING_1',
      'BLOCK_TYPE_HEADING_2',
      'BLOCK_TYPE_HEADING_3',
      'BLOCK_TYPE_HEADING_4',
      'BLOCK_TYPE_HEADING_5',
      'BLOCK_TYPE_HEADING_6',
    ]);
  }

  private verifyStructuralEdit({
    updatedBlocks,
    insertedBlockIds,
    specs,
    deletedBlockIds,
  }: {
    updatedBlocks: Record<string, RawBlockSummary>;
    insertedBlockIds: string[];
    specs: StructuralBlockSpec[];
    deletedBlockIds: string[];
  }): void {
    for (const deletedBlockId of deletedBlockIds) {
      if (updatedBlocks[deletedBlockId]) {
        throw new Error(`Zoom Docs structural edit verification failed: deleted block still exists (${deletedBlockId}).`);
      }
    }

    for (let index = 0; index < insertedBlockIds.length; index += 1) {
      const blockId = insertedBlockIds[index];
      const spec = specs[index];
      const block = blockId ? updatedBlocks[blockId] : undefined;
      if (!block || !spec) {
        throw new Error(`Zoom Docs structural edit verification failed: inserted block missing (${blockId}).`);
      }

      const actualText = extractPlainTextFromTitle(block.content?.title);
      if (block.type !== spec.type || actualText !== spec.text) {
        throw new Error(
          `Zoom Docs structural edit verification failed for block ${blockId}: expected ${spec.type} ${JSON.stringify(spec.text)}, got ${block.type} ${JSON.stringify(actualText)}.`
        );
      }
    }
  }

  private buildSubstringReplacement({
    match,
    oldText,
    newText,
  }: {
    match: EditableBlockSnapshot;
    oldText: string;
    newText: string;
  }): { ok: true; text: string } | EditDocFailureResult {
    if (match.hasInlineContentRisk) {
      return {
        ok: false,
        error_code: 'INLINE_CONTENT_RISK',
        message: 'Refusing to replace a substring in this block because it contains inline annotations or objects that plain text replacement would remove.',
        candidates: [this.toEditDocCandidate(match)],
      };
    }

    if (!oldText) {
      return {
        ok: false,
        error_code: 'NO_MATCH',
        message: 'old_text is required for substring replacement.',
        candidates: [this.toEditDocCandidate(match)],
      };
    }

    const matchCount = this.countSubstringOccurrences(match.text, oldText);
    if (matchCount === 0) {
      return {
        ok: false,
        error_code: 'NO_MATCH',
        message: 'Substring to replace was not found in the matched block.',
        candidates: [this.toEditDocCandidate(match)],
      };
    }

    if (matchCount > 1) {
      return {
        ok: false,
        error_code: 'AMBIGUOUS_MATCH',
        message: `Substring matched ${matchCount} times in the matched block. Make old_text unique before editing.`,
        candidates: [this.toEditDocCandidate(match)],
      };
    }

    return { ok: true, text: match.text.replace(oldText, newText) };
  }

  private countSubstringOccurrences(value: string, substring: string): number {
    if (!substring) return 0;
    let count = 0;
    let index = 0;
    while (true) {
      const nextIndex = value.indexOf(substring, index);
      if (nextIndex === -1) return count;
      count += 1;
      index = nextIndex + substring.length;
    }
  }

  private async insertInlineCommentMarker({
    fileId,
    blockId,
    baseVersion,
    selectionStart,
    selectionLength,
    threadId,
  }: {
    fileId: string;
    blockId: string;
    baseVersion: number;
    selectionStart: number;
    selectionLength: number;
    threadId: string;
  }): Promise<void> {
    const retainWithMarker = [2, selectionLength, `thread-${threadId}:true`];
    const delta = JSON.stringify(selectionStart > 0 ? [[2, selectionStart], retainWithMarker] : [retainWithMarker]);
    const body = buildBlockTransactionRequest({
      fileId,
      clientId: this.clientId,
      baseVersion,
      blockId,
      delta,
      reqId: randomUUID(),
      transactionId: randomUUID(),
    });

    await this.transport.requestJson({
      method: 'POST',
      path: `/api/block/transactions?fileId=${encodeURIComponent(fileId)}`,
      body,
      fileId,
    });
  }

  private async cleanupInlineThread({ fileId, threadId }: { fileId: string; threadId: string }): Promise<InlineCommentCleanupResult> {
    try {
      await this.transport.requestJson({
        method: 'PATCH',
        path: `/api/comment/threads/${encodeURIComponent(threadId)}?fileId=${encodeURIComponent(fileId)}`,
        body: { threadStatus: 'resolved' },
        fileId,
      });
      return { attempted: true, resolved_thread: true };
    } catch (error) {
      return {
        attempted: true,
        resolved_thread: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async cleanupUnverifiedInlineComment({
    fileId,
    blockId,
    originalText,
    threadId,
    markerMayExist,
  }: {
    fileId: string;
    blockId: string;
    originalText: string;
    threadId: string;
    markerMayExist: boolean;
  }): Promise<InlineCommentCleanupResult> {
    const threadCleanup = await this.cleanupInlineThread({ fileId, threadId });
    if (!markerMayExist) return threadCleanup;

    try {
      await this.replaceBlockWithPlainText({ fileId, blockId, text: originalText });
      return { ...threadCleanup, removed_marker: true };
    } catch (error) {
      return {
        ...threadCleanup,
        removed_marker: false,
        message: [threadCleanup.message, error instanceof Error ? error.message : String(error)].filter(Boolean).join(' | '),
      };
    }
  }

  private async replaceBlockWithPlainText({ fileId, blockId, text }: { fileId: string; blockId: string; text: string }): Promise<void> {
    const blocks = await this.fetchBlocks(fileId);
    const block = blocks[blockId];
    if (!block) throw new Error(`Could not find block ${blockId} while removing inline marker.`);
    const userId = await this.getCurrentUserId();
    const delta = buildReplaceDelta({ currentLength: computeBlockTextLength(block.content?.title), text, userId });
    const body = buildBlockTransactionRequest({
      fileId,
      clientId: this.clientId,
      baseVersion: this.transactionBaseVersion(blocks, fileId),
      blockId,
      delta,
      reqId: randomUUID(),
      transactionId: randomUUID(),
    });
    await this.transport.requestJson({
      method: 'POST',
      path: `/api/block/transactions?fileId=${encodeURIComponent(fileId)}`,
      body,
      fileId,
    });
  }

  private async fetchCommentsUntilInlineComment({
    fileId,
    threadId,
    commentId,
  }: {
    fileId: string;
    threadId: string;
    commentId: string;
  }): Promise<ZoomDocsCommentsResult> {
    let latest = await this.getComments({ fileId, threadStatus: 'open' });
    for (
      let attempt = 0;
      attempt < 8 && !(latest.inline_thread_ids.includes(threadId) && this.commentsContainComment(latest, { threadId, commentId }));
      attempt += 1
    ) {
      await sleep(250);
      latest = await this.getComments({ fileId, threadStatus: 'open' });
    }
    return latest;
  }

  private async fetchCommentsUntilComment({
    fileId,
    threadId,
    commentId,
    threadStatus,
  }: {
    fileId: string;
    threadId: string;
    commentId: string;
    threadStatus: ZoomDocsCommentThreadStatus;
  }): Promise<ZoomDocsCommentsResult> {
    let latest = await this.getComments({ fileId, threadStatus });
    for (let attempt = 0; attempt < 4 && !this.commentsContainComment(latest, { threadId, commentId }); attempt += 1) {
      await sleep(250);
      latest = await this.getComments({ fileId, threadStatus });
    }
    return latest;
  }

  private async fetchCommentsUntilCommentDeleted({
    fileId,
    threadId,
    commentId,
    threadStatus,
  }: {
    fileId: string;
    threadId: string;
    commentId: string;
    threadStatus: ZoomDocsCommentThreadStatus;
  }): Promise<ZoomDocsCommentsResult> {
    let latest = await this.getComments({ fileId, threadStatus });
    for (let attempt = 0; attempt < 4 && this.commentsContainComment(latest, { threadId, commentId }); attempt += 1) {
      await sleep(250);
      latest = await this.getComments({ fileId, threadStatus });
    }
    return latest;
  }

  private async fetchCommentsUntilThreadStatus({
    fileId,
    threadId,
    threadStatus,
  }: {
    fileId: string;
    threadId: string;
    threadStatus: ZoomDocsCommentThreadStatus;
  }): Promise<ZoomDocsCommentsResult> {
    let latest = await this.getComments({ fileId, threadStatus });
    for (let attempt = 0; attempt < 4 && !this.commentsContainThreadStatus(latest, { threadId, threadStatus }); attempt += 1) {
      await sleep(250);
      latest = await this.getComments({ fileId, threadStatus });
    }
    return latest;
  }

  private async fetchCommentsUntilReaction({
    fileId,
    threadId,
    commentId,
    reactionId,
    threadStatus,
  }: {
    fileId: string;
    threadId: string;
    commentId: string;
    reactionId: string;
    threadStatus: ZoomDocsCommentThreadStatus;
  }): Promise<ZoomDocsCommentsResult> {
    let latest = await this.getComments({ fileId, threadStatus });
    for (let attempt = 0; attempt < 4 && !this.commentsContainReaction(latest, { threadId, commentId, reactionId }); attempt += 1) {
      await sleep(250);
      latest = await this.getComments({ fileId, threadStatus });
    }
    return latest;
  }

  private commentsContainComment(
    comments: ZoomDocsCommentsResult,
    { threadId, commentId }: { threadId: string; commentId: string }
  ): boolean {
    return comments.threads.some(
      (thread) => thread.thread_id === threadId && thread.comments.some((comment) => comment.comment_id === commentId)
    );
  }

  private commentsContainThreadStatus(
    comments: ZoomDocsCommentsResult,
    { threadId, threadStatus }: { threadId: string; threadStatus: ZoomDocsCommentThreadStatus }
  ): boolean {
    return comments.threads.some((thread) => thread.thread_id === threadId && thread.status === threadStatus);
  }

  private commentsContainReaction(
    comments: ZoomDocsCommentsResult,
    { threadId, commentId, reactionId }: { threadId: string; commentId: string; reactionId: string }
  ): boolean {
    return comments.threads.some(
      (thread) => thread.thread_id === threadId && thread.comments.some(
        (comment) => comment.comment_id === commentId && comment.reactions?.some((reaction) => reaction.reaction_id === reactionId)
      )
    );
  }

  private extractInlineCommentThreadIds(blocks: Record<string, RawBlockSummary>): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();
    const threadRefPattern = /thread-([A-Za-z0-9_-]{16,80}):true/g;

    for (const block of Object.values(blocks)) {
      const title = block.content?.title;
      if (typeof title !== 'string') continue;

      for (const match of title.matchAll(threadRefPattern)) {
        const id = match[1];
        if (!id || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
      }
    }

    return ids;
  }

  private normalizeCommentThreads(rawThreads: unknown, source: ZoomDocsCommentThreadSource, threadUrl?: string): ZoomDocsCommentThread[] {
    if (!Array.isArray(rawThreads)) return [];

    return rawThreads.flatMap((rawThread) => {
      const wrapper = this.asRecord(rawThread);
      const thread = this.asRecord(wrapper.thread);
      const threadId = this.optionalString(thread.threadId);
      if (!threadId) return [];

      const comments = Array.isArray(wrapper.comments)
        ? wrapper.comments.flatMap((rawComment) => this.normalizeComment(rawComment, threadId))
        : [];

      return [
        {
          source,
          thread_id: threadId,
          status: this.optionalString(thread.threadStatus) ?? '',
          selected_content: this.optionalString(thread.selectContent) ?? '',
          comment_type: this.optionalNumber(thread.commentType),
          file_id: this.optionalString(thread.fileId),
          root_block_id: this.optionalString(thread.rootBlockId),
          block_ids: Array.isArray(thread.blockIds) ? thread.blockIds.filter((id): id is string => typeof id === 'string') : [],
          created_by: this.optionalString(thread.createdBy),
          created_at: this.timestampToIso(thread.createAt),
          modified_at: this.timestampToIso(thread.modifyAt),
          resolved_at: this.timestampToIso(thread.resolveAt),
          comment_count: this.optionalNumber(thread.commentCount) ?? comments.length,
          comments,
          ...(threadUrl ? { thread_url: threadUrl } : {}),
        },
      ];
    });
  }

  private normalizeComment(rawComment: unknown, fallbackThreadId: string): ZoomDocsComment[] {
    const wrapper = this.asRecord(rawComment);
    const comment = this.asRecord(wrapper.comment);
    const commentId = this.optionalString(comment.commentId);
    if (!commentId) return [];

    const reactions = Array.isArray(wrapper.reactions) ? this.normalizeCommentReactions(wrapper.reactions) : [];
    const attachments = this.parseCommentAttachments(comment.attachments);
    return [
      {
        comment_id: commentId,
        thread_id: this.optionalString(comment.threadId) ?? fallbackThreadId,
        parent_comment_id: this.parseParentCommentId(comment.parentComment, comment.parentId),
        created_by: this.optionalString(comment.createdBy),
        text: this.parseCommentText(comment.content),
        created_at: this.timestampToIso(comment.createAt),
        modified_at: this.timestampToIso(comment.modifyAt),
        is_edited: Boolean(comment.isEdited),
        reaction_count: reactions.length,
        ...(reactions.length > 0 ? { reactions } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      },
    ];
  }

  private parseCommentAttachments(rawAttachments: unknown): ZoomDocsCommentAttachment[] {
    if (typeof rawAttachments !== 'string' || !rawAttachments.trim()) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawAttachments);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];

    return parsed.flatMap((rawAttachment) => {
      const attachment = this.asRecord(rawAttachment);
      const id = this.optionalString(attachment.id);
      const name = this.optionalString(attachment.name);
      const type = this.optionalString(attachment.type);
      const attachmentId = this.optionalString(attachment.attachmentId);
      if (!id || !name || !type || !attachmentId) return [];
      return [
        {
          id,
          name,
          size: this.optionalNumber(attachment.size),
          type,
          attachment_id: attachmentId,
        },
      ];
    });
  }

  private normalizeCommentReactions(rawReactions: unknown[]): ZoomDocsCommentReaction[] {
    return rawReactions.flatMap((rawReaction) => {
      const reaction = this.asRecord(rawReaction);
      const reactionId = this.optionalString(reaction.reactionId);
      const value = this.optionalString(reaction.reaction);
      if (!reactionId || !value) return [];
      return [
        {
          reaction_id: reactionId,
          thread_id: this.optionalString(reaction.threadId),
          comment_id: this.optionalString(reaction.commentId),
          user_id: this.optionalString(reaction.userId),
          reaction: value,
          created_at: this.timestampToIso(reaction.createAt),
        },
      ];
    });
  }

  private normalizeCommentUsers(rawUsers: unknown): Record<string, ZoomDocsCommentUser> {
    const users = this.asRecord(rawUsers);
    return Object.fromEntries(
      Object.entries(users).flatMap(([key, rawUser]) => {
        const user = this.asRecord(rawUser);
        const userId = this.optionalString(user.userId) ?? key;
        if (!userId) return [];
        return [
          [
            userId,
            {
              user_id: userId,
              ...(typeof user.displayName === 'string' ? { display_name: user.displayName } : {}),
              ...(typeof user.avatarUrl === 'string' ? { avatar_url: user.avatarUrl } : {}),
              ...(typeof user.email === 'string' ? { email: user.email } : {}),
            },
          ] as const,
        ];
      })
    );
  }

  private parseParentCommentId(parentComment: unknown, parentId: unknown): string | null {
    const fallbackParentId = this.optionalString(parentId);
    if (typeof parentComment !== 'string' || !parentComment.trim()) return fallbackParentId || null;

    try {
      const parsed = this.asRecord(JSON.parse(parentComment));
      return this.optionalString(parsed.id) || fallbackParentId || null;
    } catch {
      return fallbackParentId || parentComment;
    }
  }

  private parseCommentText(content: unknown): string {
    if (typeof content !== 'string') return '';
    try {
      const parsed = JSON.parse(content) as { text?: unknown; elements?: unknown };
      if (typeof parsed.text === 'string') return parsed.text;
    } catch {
      // fall through to raw string
    }
    return content;
  }

  private timestampToIso(value: unknown): string | null {
    const timestamp = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
    return new Date(timestamp).toISOString();
  }

  private optionalString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
  }

  private optionalNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }

  private buildEditOutline(snapshots: EditableBlockSnapshot[]): Omit<EditOutlineResult, 'file_id'> {
    const blocks: EditOutlineBlock[] = [];
    const sections: EditOutlineSection[] = [];
    const unsectionedBlocks: EditOutlineBlock[] = [];
    const headingRefCounts = new Map<string, number>();
    const blockCountersByContainer = new Map<string, Map<string, number>>();
    let currentSection: EditOutlineSection | undefined;

    for (const snapshot of snapshots) {
      if (snapshot.type === 'BLOCK_TYPE_PAGE') continue;

      const headingLevel = headingLevelForBlockType(snapshot.type);
      if (headingLevel !== undefined) {
        const baseRef = `h${headingLevel}:${this.slugEditRef(snapshot.text)}`;
        const ref = this.uniqueEditRef(baseRef, headingRefCounts);
        const block = this.toEditOutlineBlock(snapshot, ref);
        blocks.push(block);

        currentSection = {
          ref,
          heading: snapshot.text,
          level: headingLevel,
          block_id: snapshot.id,
          blocks: [],
        };
        sections.push(currentSection);
        continue;
      }

      const containerRef = currentSection?.ref ?? 'doc';
      const kind = this.editOutlineBlockKind(snapshot.type);
      const counters = blockCountersByContainer.get(containerRef) ?? new Map<string, number>();
      const nextIndex = (counters.get(kind) ?? 0) + 1;
      counters.set(kind, nextIndex);
      blockCountersByContainer.set(containerRef, counters);

      const block = this.toEditOutlineBlock(snapshot, `${containerRef}/${kind}${nextIndex}`, currentSection);
      blocks.push(block);
      if (currentSection) {
        currentSection.blocks.push(block);
      } else {
        unsectionedBlocks.push(block);
      }
    }

    return { blocks, sections, unsectioned_blocks: unsectionedBlocks };
  }

  private toEditOutlineBlock(
    snapshot: EditableBlockSnapshot,
    ref: string,
    section?: EditOutlineSection
  ): EditOutlineBlock {
    return {
      ref,
      block_id: snapshot.id,
      block_type: snapshot.type,
      text: snapshot.text,
      ...(section ? { heading: section.heading, heading_ref: section.ref } : {}),
      safe_to_replace: this.supportedStructuralBlockTypes().has(snapshot.type) && !snapshot.hasInlineContentRisk,
      has_inline_content_risk: snapshot.hasInlineContentRisk,
    };
  }

  private editOutlineBlockKind(type: string): string {
    if (type === 'BLOCK_TYPE_BULLET') return 'b';
    if (type === 'BLOCK_TYPE_TODO_LIST') return 'todo';
    return 'p';
  }

  private slugEditRef(value: string): string {
    return value
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'untitled';
  }

  private uniqueEditRef(baseRef: string, counts: Map<string, number>): string {
    const nextCount = (counts.get(baseRef) ?? 0) + 1;
    counts.set(baseRef, nextCount);
    return nextCount === 1 ? baseRef : `${baseRef}~${nextCount}`;
  }

  private findEditDocMatches(snapshots: EditableBlockSnapshot[], target: EditDocTarget): EditableBlockSnapshot[] {
    if (target.by === 'ref') {
      const outline = this.buildEditOutline(snapshots);
      const block = outline.blocks.find((entry) => entry.ref === target.value);
      const match = block ? snapshots.find((snapshot) => snapshot.id === block.block_id) : undefined;
      return match ? [match] : [];
    }

    if (target.by === 'heading') {
      return snapshots.filter(
        (snapshot) => headingLevelForBlockType(snapshot.type) !== undefined && snapshot.text === target.value
      );
    }

    if (target.by === 'exact_text') {
      const matches = snapshots.filter(
        (snapshot) => snapshot.type !== 'BLOCK_TYPE_PAGE' && snapshot.text === target.value
      );
      if (!target.within_heading) return matches;
      return matches.filter((snapshot) => snapshot.heading === target.within_heading);
    }

    return [];
  }

  private noMatchMessage(target: EditDocTarget): string {
    if (target.by === 'ref') {
      return `No editable block ref matched "${target.value}".`;
    }

    if (target.by === 'heading') {
      return `No heading exactly matched "${target.value}".`;
    }

    if (target.within_heading) {
      return `No editable block exactly matched the target text within heading "${target.within_heading}".`;
    }

    return 'No editable block exactly matched the target text.';
  }

  private toEditDocCandidate(snapshot: EditableBlockSnapshot): EditDocCandidate {
    return {
      block_id: snapshot.id,
      block_type: snapshot.type,
      text: snapshot.text,
      ...(snapshot.heading ? { heading: snapshot.heading } : {}),
    };
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

    const beforeText = extractPlainTextFromTitle(block.content?.title);
    return this.submitBlockEditFromBlock({
      fileId: resolvedFileId,
      blockId,
      block,
      transactionBaseVersion: this.transactionBaseVersion(blocks, resolvedFileId),
      mode,
      text,
      expectedText: mode === 'append' ? `${beforeText}${text}` : text,
    });
  }

  private async submitBlockEditFromBlock({
    fileId,
    blockId,
    block,
    transactionBaseVersion,
    mode,
    text,
    expectedText,
  }: {
    fileId: string;
    blockId: string;
    block: RawBlockSummary;
    transactionBaseVersion: number;
    mode: 'append' | 'replace';
    text: string;
    expectedText: string;
  }): Promise<EditBlockResult> {
    const previousBlockVersion = typeof block.version === 'number' ? block.version : 0;
    const currentLength = computeBlockTextLength(block.content?.title);
    const userId = await this.getCurrentUserId();

    const delta =
      mode === 'append'
        ? buildAppendDelta({ currentLength, text, userId })
        : buildReplaceDelta({ currentLength, text, userId });

    const body = buildBlockTransactionRequest({
      fileId,
      clientId: this.clientId,
      baseVersion: transactionBaseVersion,
      blockId,
      delta,
      reqId: randomUUID(),
      transactionId: randomUUID(),
    });

    const encodedFileId = encodeURIComponent(fileId);
    await this.transport.requestJson({
      method: 'POST',
      path: `/api/block/transactions?fileId=${encodedFileId}`,
      body,
      fileId,
    });

    const updatedBlock = await this.fetchBlockUntilText({ fileId, blockId, expectedText });

    return {
      fileId,
      blockId,
      previousVersion: previousBlockVersion,
      newVersion: typeof updatedBlock.version === 'number' ? updatedBlock.version : previousBlockVersion,
      newTextLength: computeBlockTextLength(updatedBlock.content?.title),
    };
  }

  private async fetchBlockUntilText({
    fileId,
    blockId,
    expectedText,
    timeoutMs = 3_000,
    intervalMs = 100,
  }: {
    fileId: string;
    blockId: string;
    expectedText: string;
    timeoutMs?: number;
    intervalMs?: number;
  }): Promise<RawBlockSummary> {
    const startedAt = Date.now();
    let lastBlock: RawBlockSummary | undefined;
    let lastText: string | undefined;

    while (Date.now() - startedAt <= timeoutMs) {
      const updatedBlocks = await this.fetchBlocks(fileId);
      const updatedBlock = updatedBlocks[blockId];
      if (updatedBlock) {
        lastBlock = updatedBlock;
        lastText = extractPlainTextFromTitle(updatedBlock.content?.title);
        if (lastText === expectedText) return updatedBlock;
      }

      await sleep(intervalMs);
    }

    if (!lastBlock) {
      throw new Error(`Zoom Docs edit verification failed: block disappeared after edit (${blockId}).`);
    }

    throw new Error(
      `Zoom Docs edit verification failed for block ${blockId}: expected ${JSON.stringify(expectedText)}, got ${JSON.stringify(lastText ?? '')}.`
    );
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
