import { describe, expect, it } from 'vitest';

import {
  formatAddCommentReactionText,
  formatEditOutlineText,
  formatResolveCommentThreadText,
} from '../src/zoomdocs/format.js';

describe('Zoom Docs MCP text formatters', () => {
  it('formats non-verification failures as failures instead of claiming every ok:false result is verification-only', () => {
    expect(
      formatResolveCommentThreadText({
        ok: false,
        file_id: 'doc-1',
        thread_id: 'missing-thread',
        error_code: 'THREAD_NOT_FOUND',
        message: 'Thread was not found in the open comments bucket.',
      })
    ).toBe('Zoom Docs comment thread resolution failed (THREAD_NOT_FOUND): Thread was not found in the open comments bucket.');

    expect(
      formatAddCommentReactionText({
        ok: false,
        file_id: 'doc-1',
        thread_id: 'thread-1',
        comment_id: 'missing-comment',
        error_code: 'COMMENT_NOT_FOUND',
        message: 'Comment was not found in the requested thread/status bucket.',
      })
    ).toBe('Zoom Docs comment reaction failed (COMMENT_NOT_FOUND): Comment was not found in the requested thread/status bucket.');
  });

  it('formats edit outline safety hints without exposing raw block internals first', () => {
    expect(
      formatEditOutlineText({
        file_id: 'doc-1',
        blocks: [
          {
            ref: 'doc/p1',
            block_id: 'block-1',
            block_type: 'BLOCK_TYPE_PARAGRAPH',
            text: 'Safe paragraph',
            safe_to_replace: true,
            has_inline_content_risk: false,
          },
          {
            ref: 'doc/p2',
            block_id: 'block-2',
            block_type: 'BLOCK_TYPE_PARAGRAPH',
            text: 'Commented paragraph',
            safe_to_replace: false,
            has_inline_content_risk: true,
          },
        ],
        sections: [],
        unsectioned_blocks: [],
      })
    ).toContain('doc/p2 [BLOCK_TYPE_PARAGRAPH] ⚠️ rich/unsafe: Commented paragraph');
  });
});
