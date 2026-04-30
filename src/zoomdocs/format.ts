import type {
  AddCommentReactionResult,
  AddDocCommentResult,
  AddInlineCommentResult,
  AddUserCollaboratorResult,
  DeleteCommentResult,
  EditDocBatchResult,
  EditDocResult,
  EditOutlineResult,
  RemoveUserCollaboratorResult,
  ReopenCommentThreadResult,
  ReplyToCommentResult,
  ResolveCommentThreadResult,
  SetPermissionAccessResult,
  SetUserCollaboratorRoleResult,
  ShareTargetSearchResult,
  ZoomDocsAccessInfo,
  ZoomDocsCommentsResult,
} from './service.js';

export function formatListText(parentId: string, items: Array<{ id: string; title: string; fileType: string; fileLink?: string }>) {
  if (items.length === 0) {
    return `No Zoom Docs children found under ${parentId}.`;
  }

  return [
    `Children of ${parentId}:`,
    ...items.map((item) => `- [${item.fileType}] ${item.title} — ${item.id}${item.fileLink ? ` — ${item.fileLink}` : ''}`),
  ].join('\n');
}

export function formatSearchText(result: {
  query: string;
  pageSize: number;
  fileTypes: string[];
  totalReturned: number;
  items: Array<{
    id: string;
    title: string;
    fileType: string;
    fileLink: string;
    titleHighlight?: string;
    updatedAt?: string;
    updatedByDisplayName?: string;
  }>;
}) {
  if (result.items.length === 0) {
    return `No Zoom Docs matches found for "${result.query}" (file types: ${result.fileTypes.join(', ')}).`;
  }

  return [
    `Search results for "${result.query}" (${result.totalReturned} of up to ${result.pageSize}):`,
    ...result.items.map((item) => {
      const display = item.titleHighlight || item.title;
      const updatedBits = [
        item.updatedAt ? `updated ${item.updatedAt}` : undefined,
        item.updatedByDisplayName ? `by ${item.updatedByDisplayName}` : undefined,
      ]
        .filter(Boolean)
        .join(' ');
      const trailing = updatedBits ? ` — ${updatedBits}` : '';
      return `- [${item.fileType}] ${display} — ${item.id} — ${item.fileLink}${trailing}`;
    }),
  ].join('\n');
}

export function formatMetadataText(node: {
  id: string;
  title: string;
  fileType: string;
  fileLink?: string;
  parentId?: string;
}) {
  return [
    `[${node.fileType}] ${node.title}`,
    `ID: ${node.id}`,
    node.parentId ? `Parent: ${node.parentId}` : undefined,
    node.fileLink ? `Link: ${node.fileLink}` : undefined,
  ]
    .filter(Boolean)
    .join('\n');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function roleName(value: unknown): string | undefined {
  const record = asRecord(value);
  const role = record?.role;
  return typeof role === 'string' ? role : undefined;
}

export function formatEditOutlineText(result: EditOutlineResult): string {
  if (result.blocks.length === 0) {
    return `No editable blocks found in Zoom Doc ${result.file_id}.`;
  }

  const lines = [`Edit outline for Zoom Doc ${result.file_id}:`];
  for (const block of result.blocks) {
    const risk = block.safe_to_replace ? '' : ' ⚠️ rich/unsafe';
    lines.push(`- ${block.ref} [${block.block_type}]${risk}: ${block.text.slice(0, 160)}`);
  }
  return lines.join('\n');
}

export function formatAccessInfoText(result: ZoomDocsAccessInfo): string {
  const fileTitle = typeof result.file?.title === 'string' ? result.file.title : undefined;
  const fileType = typeof result.file?.fileType === 'string' ? result.file.fileType : undefined;
  const shareStatus = typeof result.share_status.isShared === 'boolean'
    ? (result.share_status.isShared ? 'shared' : 'not shared')
    : 'unknown';
  const publishSetting = asRecord(result.publish.setting);
  const publishStatus = typeof publishSetting?.publishStatus === 'string' ? publishSetting.publishStatus : 'unknown';
  const currentLinkAccess = asRecord(result.permission_info?.currentLinkAccess);
  const currentLinkRole = roleName(currentLinkAccess?.role) ?? 'unknown';
  const currentLinkSetting = typeof currentLinkAccess?.settingItem === 'string' ? currentLinkAccess.settingItem : 'unknown';
  const collaborators = Array.isArray(result.permission_info?.collaborators)
    ? result.permission_info.collaborators.length
    : undefined;
  const pendingRequests = Array.isArray(result.permission_requests.requests)
    ? result.permission_requests.requests.length
    : undefined;

  return [
    fileTitle ? `${fileType ? `[${fileType}] ` : ''}${fileTitle}` : `Zoom Doc ${result.file_id}`,
    `ID: ${result.file_id}`,
    `Share status: ${shareStatus}`,
    `Publish status: ${publishStatus}`,
    `Current link access: ${currentLinkSetting} / ${currentLinkRole}`,
    collaborators !== undefined ? `Collaborators: ${collaborators}` : undefined,
    pendingRequests !== undefined ? `Pending permission requests: ${pendingRequests}` : undefined,
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatCommentsText(result: ZoomDocsCommentsResult): string {
  const filterText = result.filtered_thread_id ? ` matching thread ${result.filtered_thread_id}` : '';
  if (result.threads.length === 0) {
    return `No ${result.thread_status} Zoom Docs comments${filterText} found for ${result.file_id}.\nDoc: ${result.doc_url}`;
  }

  const lines = [
    `${result.thread_status[0]?.toUpperCase() ?? ''}${result.thread_status.slice(1)} Zoom Docs comments for ${result.file_id}: ${result.threads.length} threads${filterText}`,
    `Doc: ${result.doc_url}`,
    `Inline thread refs found in document content: ${result.inline_thread_ids.length}`,
  ];

  for (const thread of result.threads) {
    lines.push(
      '',
      `- ${thread.thread_id} [${thread.source}/${thread.status}]${thread.selected_content ? ` on "${thread.selected_content.slice(0, 120)}"` : ''}`
    );
    if (thread.thread_url) lines.push(`  URL: ${thread.thread_url}`);
    lines.push(
      `  Blocks: ${thread.block_ids.length ? thread.block_ids.join(', ') : 'none'}`,
      `  Comments: ${thread.comments.length}`
    );

    for (const comment of thread.comments) {
      const author = comment.created_by ? result.users[comment.created_by]?.display_name ?? comment.created_by : 'unknown';
      const text = comment.text.replace(/\s+/g, ' ').trim();
      const replyTo = comment.parent_comment_id ? ` (reply to ${comment.parent_comment_id})` : '';
      const attachments = comment.attachments?.length
        ? ` [attachments: ${comment.attachments.map((attachment) => `${attachment.name} (${attachment.attachment_id})`).join(', ')}]`
        : '';
      const reactions = comment.reactions?.length
        ? ` [reactions: ${comment.reactions.map((reaction) => reaction.reaction).join(' ')}]`
        : '';
      lines.push(`  - ${comment.comment_id}${replyTo} by ${author}${comment.created_at ? ` at ${comment.created_at}` : ''}: ${text.slice(0, 180)}${attachments}${reactions}`);
    }
  }

  return lines.join('\n');
}

export function formatAddDocCommentText(result: AddDocCommentResult): string {
  if (!result.ok) {
    return `Zoom Docs whole-doc comment failed (${result.error_code}): ${result.message}`;
  }

  return [
    `Added Zoom Docs whole-doc comment: ${result.comment_id}`,
    `File: ${result.file_id}`,
    `Thread: ${result.thread_id}`,
    `Verified: ${result.verified}`,
    result.attachments?.length ? `Attachments: ${result.attachments.map((attachment) => `${attachment.name} (${attachment.attachment_id})`).join(', ')}` : undefined,
    `Text: ${result.text}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatReplyToCommentText(result: ReplyToCommentResult): string {
  if (!result.ok) {
    return `Zoom Docs comment reply failed (${result.error_code}): ${result.message}`;
  }

  return [
    `Added Zoom Docs comment reply: ${result.comment_id}`,
    `File: ${result.file_id}`,
    `Thread: ${result.thread_id}`,
    `Parent comment: ${result.parent_comment_id}`,
    `Verified: ${result.verified}`,
    `Text: ${result.text}`,
  ].join('\n');
}

export function formatResolveCommentThreadText(result: ResolveCommentThreadResult): string {
  if (!result.ok) {
    return `Zoom Docs comment thread resolution failed (${result.error_code}): ${result.message}`;
  }

  return [
    `Resolved Zoom Docs comment thread: ${result.thread_id}`,
    `File: ${result.file_id}`,
    `Verified: ${result.verified}`,
  ].join('\n');
}

export function formatReopenCommentThreadText(result: ReopenCommentThreadResult): string {
  if (!result.ok) {
    return `Zoom Docs comment thread reopen failed (${result.error_code}): ${result.message}`;
  }

  return [
    `Reopened Zoom Docs comment thread: ${result.thread_id}`,
    `File: ${result.file_id}`,
    `Verified: ${result.verified}`,
  ].join('\n');
}

export function formatDeleteCommentText(result: DeleteCommentResult): string {
  if (!result.ok) {
    return `Zoom Docs comment deletion failed (${result.error_code}): ${result.message}`;
  }

  return [
    `Deleted Zoom Docs comment: ${result.comment_id}`,
    `File: ${result.file_id}`,
    `Thread: ${result.thread_id}`,
    `Verified: ${result.verified}`,
  ].join('\n');
}

export function formatAddInlineCommentText(result: AddInlineCommentResult): string {
  if (!result.ok) {
    const cleanup = result.cleanup
      ? ` Cleanup attempted: ${result.cleanup.attempted}${result.cleanup.resolved_thread !== undefined ? `, resolved_thread: ${result.cleanup.resolved_thread}` : ''}${result.cleanup.removed_marker !== undefined ? `, removed_marker: ${result.cleanup.removed_marker}` : ''}.`
      : '';
    return `Zoom Docs inline comment failed (${result.error_code}): ${result.message}${cleanup}`;
  }

  return [
    `Added Zoom Docs inline comment: ${result.comment_id}`,
    `File: ${result.file_id}`,
    `Block: ${result.block_id}`,
    `Thread: ${result.thread_id}`,
    `Selected text: ${result.selected_text}`,
    `Verified: ${result.verified}`,
    `Text: ${result.text}`,
  ].join('\n');
}

export function formatAddCommentReactionText(result: AddCommentReactionResult): string {
  if (!result.ok) {
    return `Zoom Docs comment reaction failed (${result.error_code}): ${result.message}`;
  }

  return [
    `Added Zoom Docs comment reaction: ${result.reaction}`,
    `File: ${result.file_id}`,
    `Thread: ${result.thread_id}`,
    `Comment: ${result.comment_id}`,
    `Reaction ID: ${result.reaction_id}`,
    `Verified: ${result.verified}`,
  ].join('\n');
}

export function formatShareTargetSearchText(result: ShareTargetSearchResult): string {
  const lines = [
    `Share targets for "${result.query}": ${result.users.length} users, ${result.channels.length} channels`,
  ];

  if (result.users.length > 0) {
    lines.push(
      'Users:',
      ...result.users.map((user) =>
        `- ${user.display_name} — user_id: ${user.user_id}${user.email ? ` — ${user.email}` : ''}`
      )
    );
  }

  if (result.channels.length > 0) {
    lines.push(
      'Channels:',
      ...result.channels.map((channel) =>
        `- ${channel.name} — channel_id: ${channel.channel_id}${typeof channel.member_count === 'number' ? ` — ${channel.member_count} members` : ''}`
      )
    );
  }

  return lines.join('\n');
}

export function formatSetPermissionAccessText(result: SetPermissionAccessResult): string {
  if (!result.ok) {
    return [
      `Zoom Docs permission access update not verified (${result.error_code}).`,
      result.message,
      `Expected: ${result.expected.setting_item} / ${result.expected.role}`,
      `Actual: ${result.actual.setting_item ?? 'unknown'} / ${result.actual.role ?? 'unknown'}`,
    ].join('\n');
  }

  return [
    `Updated Zoom Docs permission access: ${result.file_id}`,
    `Scope: ${result.scope}`,
    `Setting item: ${result.setting_item}`,
    `Role: ${result.role}`,
  ].join('\n');
}

export function formatAddUserCollaboratorText(result: AddUserCollaboratorResult): string {
  if (!result.ok) {
    return [
      `Zoom Docs user collaborator add not verified (${result.error_code}).`,
      result.message,
      `Expected role: ${result.expected.role ?? 'unknown'}`,
      `Actual: ${result.actual.present ? result.actual.role ?? 'unknown' : 'absent'}`,
    ].join('\n');
  }

  return [
    `Added Zoom Docs user collaborator: ${result.user_id}`,
    `File: ${result.file_id}`,
    `Role: ${result.role}`,
  ].join('\n');
}

export function formatSetUserCollaboratorRoleText(result: SetUserCollaboratorRoleResult): string {
  if (!result.ok) {
    return [
      `Zoom Docs user collaborator role update not verified (${result.error_code}).`,
      result.message,
      `Expected role: ${result.expected.role ?? 'unknown'}`,
      `Actual: ${result.actual.present ? result.actual.role ?? 'unknown' : 'absent'}`,
    ].join('\n');
  }

  return [
    `Updated Zoom Docs user collaborator role: ${result.user_id}`,
    `File: ${result.file_id}`,
    `Role: ${result.role}`,
  ].join('\n');
}

export function formatRemoveUserCollaboratorText(result: RemoveUserCollaboratorResult): string {
  if (!result.ok) {
    return [
      `Zoom Docs user collaborator removal not verified (${result.error_code}).`,
      result.message,
      `Actual: ${result.actual.present ? result.actual.role ?? 'unknown' : 'absent'}`,
    ].join('\n');
  }

  return [`Removed Zoom Docs user collaborator: ${result.user_id}`, `File: ${result.file_id}`].join('\n');
}

export function formatEditDocBatchText(result: EditDocBatchResult): string {
  if (!result.ok) {
    const preview = result.results.length
      ? `\nValidated/prepared edits before failure:\n${result.results
          .map((entry, index) =>
            entry.ok
              ? `- ${index + 1}. ${entry.operation_type} on ${entry.matched_block_id}: ${entry.before_text ?? entry.before_markdown ?? '(empty)'} -> ${entry.after_text ?? entry.after_markdown ?? '(empty)'}`
              : `- ${index + 1}. failed: ${entry.error_code} ${entry.message}`
          )
          .join('\n')}`
      : '';
    return `Zoom Docs batch edit not applied (${result.error_code}): ${result.message}${preview}`;
  }

  const lines = [
    result.dry_run ? `Zoom Docs batch edit dry run (no changes applied): ${result.file_id}` : `Edited Zoom Doc batch in place: ${result.file_id}`,
    `Preserved fileId/URL: ${result.preserved_file_id}`,
    `Edits: ${result.edit_count}`,
    ...result.results.map((entry, index) =>
      [
        `${index + 1}. ${entry.operation_type} on ${entry.matched_block_id} [${entry.matched_block_type}]`,
        entry.before_text !== undefined ? `before=${JSON.stringify(entry.before_text)}` : undefined,
        entry.after_text !== undefined ? `after=${JSON.stringify(entry.after_text)}` : undefined,
        entry.before_markdown !== undefined ? `before_markdown=${JSON.stringify(entry.before_markdown)}` : undefined,
        entry.after_markdown !== undefined ? `after_markdown=${JSON.stringify(entry.after_markdown)}` : undefined,
      ]
        .filter(Boolean)
        .join(' ')
    ),
  ];

  return lines.join('\n');
}

export function formatEditDocText(result: EditDocResult): string {
  if (!result.ok) {
    const candidates = result.candidates?.length
      ? `\nCandidates:\n${result.candidates
          .map((candidate) =>
            `- ${candidate.block_id} [${candidate.block_type}]${candidate.heading ? ` under "${candidate.heading}"` : ''}: ${candidate.text.slice(0, 120)}`
          )
          .join('\n')}`
      : '';
    return `Zoom Docs edit not applied (${result.error_code}): ${result.message}${candidates}`;
  }

  return [
    result.dry_run ? `Zoom Docs edit dry run (no changes applied): ${result.file_id}` : `Edited Zoom Doc in place: ${result.file_id}`,
    `Preserved fileId/URL: ${result.preserved_file_id}`,
    `Block: ${result.matched_block_id} [${result.matched_block_type}]`,
    result.matched_heading ? `Heading: ${result.matched_heading}` : undefined,
    `Operation: ${result.operation_type}`,
    typeof result.inserted_block_count === 'number' ? `Inserted blocks: ${result.inserted_block_count}` : undefined,
    typeof result.deleted_block_count === 'number' ? `Deleted blocks: ${result.deleted_block_count}` : undefined,
    result.before_text !== undefined ? `Before: ${result.before_text}` : undefined,
    result.after_text !== undefined ? `After: ${result.after_text}` : undefined,
    result.before_markdown !== undefined ? `Before markdown:\n${result.before_markdown || '(empty)'}` : undefined,
    result.after_markdown !== undefined ? `After markdown:\n${result.after_markdown || '(empty)'}` : undefined,
  ]
    .filter(Boolean)
    .join('\n');
}

