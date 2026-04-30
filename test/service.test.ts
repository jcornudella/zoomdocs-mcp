import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';

import {
  ZoomDocsService,
  buildZoomDocFileLink,
  normalizeNativeSearchItem,
  stripTitleHighlightMarkup,
  type ZoomDocsTransport,
} from '../src/zoomdocs/service.js';
import { readJsonFixture } from './helpers/fixtures.js';

type RequestJsonMock = ReturnType<typeof vi.fn>;

function encodePayload(payload: unknown): string {
  return deflateSync(Buffer.from(JSON.stringify(payload), 'utf8')).toString('base64');
}

function encodeBlocks(blocks: Record<string, unknown>) {
  return {
    content: {
      data: encodePayload({ blocks }),
      gzip: true,
    },
  };
}

function createMockTransport(): ZoomDocsTransport & {
  ensureLoggedIn: ReturnType<typeof vi.fn>;
  openLogin: ReturnType<typeof vi.fn>;
  requestJson: RequestJsonMock;
  startCapture: ReturnType<typeof vi.fn>;
  stopCapture: ReturnType<typeof vi.fn>;
  captureStatus: ReturnType<typeof vi.fn>;
} {
  const requestJson = vi.fn(async (_options?: unknown) => undefined as unknown);

  return {
    ensureLoggedIn: vi.fn(async () => undefined),
    openLogin: vi.fn(async () => ({ alreadyAuthenticated: false })),
    requestJson: requestJson as ZoomDocsTransport['requestJson'] & RequestJsonMock,
    startCapture: vi.fn(async ({ outputPath }: { outputPath: string }) => ({
      outputPath,
      startedAt: '2026-04-16T00:00:00.000Z',
    })),
    stopCapture: vi.fn(async () => ({
      outputPath: '/tmp/capture.jsonl',
      entriesWritten: 0,
      startedAt: '2026-04-16T00:00:00.000Z',
      stoppedAt: '2026-04-16T00:00:01.000Z',
    })),
    captureStatus: vi.fn(() => ({
      active: false,
      outputPath: null,
      startedAt: null,
      entriesWritten: 0,
    })),
  };
}

describe('ZoomDocsService', () => {
  it('opens login browser flow without blocking on authentication', async () => {
    const transport = createMockTransport();
    const service = new ZoomDocsService(transport);

    const result = await service.login();

    expect(transport.openLogin).toHaveBeenCalledTimes(1);
    expect(transport.ensureLoggedIn).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'login_opened' });
  });

  it('checks authentication status through the transport boundary', async () => {
    const transport = createMockTransport();
    const service = new ZoomDocsService(transport);

    await expect(service.status()).resolves.toEqual({ ok: true });
    expect(transport.ensureLoggedIn).toHaveBeenCalledWith(false);
    expect(transport.requestJson).not.toHaveBeenCalled();
  });

  it('delegates auth checks to requestJson for non-status operations', async () => {
    const transport = createMockTransport();
    transport.requestJson.mockImplementation(async (options?: unknown) => {
      const request = options as { path?: string };

      if (request.path === '/api/file/files/action/batch_get_children') {
        return {
          successItems: [
            {
              parentId: 'my-docs',
              children: [{ id: 'doc-1', title: 'Doc 1', fileType: 'doc', fileLink: 'https://docs.zoom.us/doc/doc-1' }],
            },
          ],
        };
      }

      if (request.path === '/api/file/files/action/batch_get') {
        return {
          successItems: [
            { id: 'doc-1', title: 'Doc 1', fileType: 'doc', parentId: 'my-docs', fileLink: 'https://docs.zoom.us/doc/doc-1' },
          ],
        };
      }

      if (request.path === '/api/page/doc-1/content?returnEncodedData=true&fileId=doc-1') {
        return {
          content: {
            data: encodePayload({ text: 'Hello from Zoom Docs' }),
            gzip: true,
          },
        };
      }

      if (request.path === '/api/bridge/import/syncCreate') {
        return {
          fileId: 'doc-new',
          fileLink: 'https://docs.zoom.us/doc/doc-new',
        };
      }

      if (request.path === '/api/file/files/title') {
        return { ok: true };
      }

      if (request.path === '/api/search/file') {
        return {
          items: [
            {
              file: { id: 'doc-1', title: 'Doc 1', fileType: 'doc', parentId: 'my-docs', isDeleted: false },
              highlight: { titleHighlight: 'Doc 1' },
            },
          ],
        };
      }

      return {
        successItems: [{ parentId: 'my-docs', children: [] }],
      };
    });

    const service = new ZoomDocsService(transport);

    await service.list();
    await service.getMetadata({ fileId: 'doc-1' });
    await service.search({ query: 'Doc 1' });
    await service.read({ fileId: 'doc-1' });
    await service.writeMarkdown({ markdown: '# Updated content' });
    await service.rename({ fileId: 'doc-1', title: 'Renamed doc' });

    expect(transport.ensureLoggedIn).not.toHaveBeenCalled();
  });

  it('reads decoded modoc text content without exposing raw payloads', async () => {
    const transport = createMockTransport();
    transport.requestJson.mockResolvedValueOnce({
      content: {
        data: encodePayload({ text: 'Hello from Zoom Docs' }),
        gzip: true,
      },
    });

    const service = new ZoomDocsService(transport);
    const result = await service.read({ fileId: 'doc-1' });

    expect(result).toEqual({
      fileId: 'doc-1',
      text: 'Hello from Zoom Docs',
      format: 'modoc-json',
    });
    expect('raw' in result).toBe(false);
    expect(transport.requestJson).toHaveBeenCalledWith({
      method: 'GET',
      path: '/api/page/doc-1/content?returnEncodedData=true&fileId=doc-1',
      fileId: 'doc-1',
    });
  });

  it('renders markdown even when embedded database lookup and attachment signing fail', async () => {
    const transport = createMockTransport();
    const pagePayload = await readJsonFixture<Record<string, unknown>>('zoomdocs', 'read', 'page-with-embed.json');

    transport.requestJson.mockImplementation(async (options?: unknown) => {
      const request = options as { path?: string };

      if (request.path === '/api/page/doc-1/content?returnEncodedData=true&fileId=doc-1') {
        return {
          content: {
            data: encodePayload(pagePayload),
            gzip: true,
          },
        };
      }

      if (request.path === '/api/database/db-1/content?returnEncodedData=true&fileId=doc-1') {
        throw new Error('database lookup failed');
      }

      if (request.path === '/api/attachment/getSignedFileUrls?fileId=doc-1') {
        throw new Error('attachment signing failed');
      }

      return undefined;
    });

    const service = new ZoomDocsService(transport);
    const result = await service.read({ fileId: 'doc-1' });

    expect(result.format).toBe('markdown');
    expect(result.text).toContain('![diagram.png](attachment://att-1)');
    expect(result.text).toContain('> Embedded EMBED_TYPE_DATABASE: db-1');
    expect('raw' in result).toBe(false);
  });

  it('calls the native Zoom Docs search endpoint and normalizes returned items', async () => {
    const transport = createMockTransport();
    transport.requestJson.mockResolvedValueOnce({
      items: [
        {
          file: {
            id: 'doc-exact',
            title: 'Seed Changes',
            fileType: 'doc',
            parentId: 'folder-1',
            isDeleted: false,
            updatedInfo: { user: { displayName: 'Jane Doe' }, time: '2026-04-01T10:00:00.000Z' },
          },
          highlight: { titleHighlight: '<em>Seed</em> <em>Changes</em>' },
        },
        {
          file: {
            id: 'doc-loose',
            title: 'Changes for seed data',
            fileType: 'doc',
            parentId: 'folder-1',
            isDeleted: false,
          },
          highlight: { titleHighlight: '' },
        },
        {
          file: {
            id: 'doc-trashed',
            title: 'Old Seed Changes',
            fileType: 'doc',
            parentId: 'folder-1',
            isDeleted: true,
          },
        },
      ],
    });

    const service = new ZoomDocsService(transport);
    const result = await service.search({ query: 'Seed Changes', pageSize: 5 });

    expect(transport.requestJson).toHaveBeenCalledTimes(1);
    expect(transport.requestJson).toHaveBeenCalledWith({
      method: 'POST',
      path: '/api/search/file',
      body: {
        pageSize: 5,
        query: 'Seed Changes',
        fileTypes: ['database', 'classicDoc', 'doc', 'page'],
      },
    });

    expect(result.items.map((item) => item.id)).toEqual(['doc-exact', 'doc-loose']);
    expect(result.items[0]).toMatchObject({
      id: 'doc-exact',
      title: 'Seed Changes',
      fileType: 'doc',
      parentId: 'folder-1',
      fileLink: 'https://docs.zoom.us/doc/doc-exact',
      isDeleted: false,
      titleHighlight: '<em>Seed</em> <em>Changes</em>',
      updatedAt: '2026-04-01T10:00:00.000Z',
      updatedByDisplayName: 'Jane Doe',
    });
    expect(result.totalReturned).toBe(2);
  });

  it('clamps page_size and includes trashed docs when requested', async () => {
    const transport = createMockTransport();
    transport.requestJson.mockResolvedValueOnce({
      items: [
        {
          file: { id: 'doc-trashed', title: 'Trashed', fileType: 'doc', parentId: 'folder-1', isDeleted: true },
        },
      ],
    });

    const service = new ZoomDocsService(transport);
    const result = await service.search({
      query: 'trash',
      pageSize: 500,
      includeDeleted: true,
      fileTypes: ['doc'],
    });

    expect(transport.requestJson).toHaveBeenCalledWith({
      method: 'POST',
      path: '/api/search/file',
      body: { pageSize: 50, query: 'trash', fileTypes: ['doc'] },
    });
    expect(result.items.map((item) => item.id)).toEqual(['doc-trashed']);
    expect(result.items[0]?.isDeleted).toBe(true);
  });

  it('rejects an empty search query', async () => {
    const service = new ZoomDocsService(createMockTransport());
    await expect(service.search({ query: '   ' })).rejects.toThrow(/query is required/);
  });

  it('creates a brand new doc without replacement semantics', async () => {
    const transport = createMockTransport();
    transport.requestJson.mockResolvedValueOnce(await readJsonFixture('zoomdocs', 'service', 'sync-create-response.json'));

    const service = new ZoomDocsService(transport);
    const result = await service.createDoc({
      title: 'Weekly Notes',
      markdown: '# Weekly Notes',
      parentId: 'https://docs.zoom.us/folder/folder-1',
    });

    expect(transport.requestJson).toHaveBeenCalledWith({
      method: 'POST',
      path: '/api/bridge/import/syncCreate',
      body: {
        parentId: 'folder-1',
        filename: 'Weekly Notes',
        targetType: 1,
        sourceData: '# Weekly Notes',
        sourceType: 4,
      },
      fileId: 'folder-1',
    });
    expect(result).toEqual({
      file_id: 'doc-new',
      file_link: 'https://docs.zoom.us/doc/doc-new',
      parent_id: 'folder-1',
    });
  });

  it('creates an explicit sibling replacement copy without accepting a parent override', async () => {
    const transport = createMockTransport();
    transport.requestJson
      .mockResolvedValueOnce(await readJsonFixture('zoomdocs', 'service', 'metadata-response.json'))
      .mockResolvedValueOnce(await readJsonFixture('zoomdocs', 'service', 'sync-create-response.json'));

    const service = new ZoomDocsService(transport);
    const result = await service.createReplacementCopy({
      targetFileId: 'doc-old',
      markdown: '# Updated content',
    });

    expect(transport.requestJson).toHaveBeenNthCalledWith(1, {
      method: 'POST',
      path: '/api/file/files/action/batch_get',
      body: { ids: ['doc-old'] },
      fileId: 'doc-old',
    });
    expect(transport.requestJson).toHaveBeenNthCalledWith(2, {
      method: 'POST',
      path: '/api/bridge/import/syncCreate',
      body: {
        parentId: 'folder-1',
        filename: 'Existing title',
        targetType: 1,
        sourceData: '# Updated content',
        sourceType: 4,
      },
      fileId: 'folder-1',
    });
    expect(result).toEqual({
      file_id: 'doc-new',
      file_link: 'https://docs.zoom.us/doc/doc-new',
      parent_id: 'folder-1',
      replaced_file_id: 'doc-old',
    });
  });

  it('keeps legacy writeMarkdown replacement behavior for debug/legacy callers', async () => {
    const transport = createMockTransport();
    transport.requestJson
      .mockResolvedValueOnce(await readJsonFixture('zoomdocs', 'service', 'metadata-response.json'))
      .mockResolvedValueOnce(await readJsonFixture('zoomdocs', 'service', 'sync-create-response.json'));

    const service = new ZoomDocsService(transport);
    const result = await service.writeMarkdown({
      markdown: '# Updated content',
      targetFileId: 'doc-old',
    });

    expect(result.mode).toBe('replace');
    expect(result.fileLink).toBe('https://docs.zoom.us/doc/doc-new');
  });

  it('returns an agent-friendly edit outline with stable refs', async () => {
    const transport = createMockTransport();
    transport.requestJson.mockResolvedValueOnce(
      encodeBlocks({
        'doc-1': { id: 'doc-1', type: 'BLOCK_TYPE_PAGE', version: 1, content: { title: 'Doc title' } },
        top: {
          id: 'top',
          parentId: 'doc-1',
          type: 'BLOCK_TYPE_PARAGRAPH',
          seq: 'a0',
          version: 2,
          content: { title: 'Top level intro' },
        },
        planHeading: {
          id: 'planHeading',
          parentId: 'doc-1',
          type: 'BLOCK_TYPE_HEADING_2',
          seq: 'a1',
          version: 3,
          content: { title: 'Plan' },
        },
        planParagraph: {
          id: 'planParagraph',
          parentId: 'doc-1',
          type: 'BLOCK_TYPE_PARAGRAPH',
          seq: 'a2',
          version: 4,
          content: { title: 'First paragraph' },
        },
        planBullet: {
          id: 'planBullet',
          parentId: 'doc-1',
          type: 'BLOCK_TYPE_BULLET',
          seq: 'a3',
          version: 5,
          content: { title: 'First bullet' },
        },
        duplicatePlanHeading: {
          id: 'duplicatePlanHeading',
          parentId: 'doc-1',
          type: 'BLOCK_TYPE_HEADING_2',
          seq: 'a4',
          version: 6,
          content: { title: 'Plan' },
        },
      })
    );

    const service = new ZoomDocsService(transport);
    const result = await service.getEditOutline({ fileId: 'https://docs.zoom.us/doc/doc-1' });

    expect(result.file_id).toBe('doc-1');
    expect(result.blocks.map((block) => [block.ref, block.block_id, block.text])).toEqual([
      ['doc/p1', 'top', 'Top level intro'],
      ['h2:plan', 'planHeading', 'Plan'],
      ['h2:plan/p1', 'planParagraph', 'First paragraph'],
      ['h2:plan/b1', 'planBullet', 'First bullet'],
      ['h2:plan~2', 'duplicatePlanHeading', 'Plan'],
    ]);
    expect(result.sections).toEqual([
      {
        ref: 'h2:plan',
        heading: 'Plan',
        level: 2,
        block_id: 'planHeading',
        blocks: [
          expect.objectContaining({ ref: 'h2:plan/p1', block_id: 'planParagraph' }),
          expect.objectContaining({ ref: 'h2:plan/b1', block_id: 'planBullet' }),
        ],
      },
      {
        ref: 'h2:plan~2',
        heading: 'Plan',
        level: 2,
        block_id: 'duplicatePlanHeading',
        blocks: [],
      },
    ]);
  });

  it('marks outline blocks with inline annotations as unsafe to replace', async () => {
    const transport = createMockTransport();
    transport.requestJson.mockResolvedValueOnce(
      encodeBlocks({
        'doc-1': { id: 'doc-1', type: 'BLOCK_TYPE_PAGE', version: 1, content: { title: 'Doc title' } },
        commented: {
          id: 'commented',
          parentId: 'doc-1',
          type: 'BLOCK_TYPE_PARAGRAPH',
          seq: 'a1',
          version: 2,
          content: { title: JSON.stringify([[0, 'Commented text', '26:"user-1"|8:1|thread-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:true']]) },
        },
      })
    );

    const service = new ZoomDocsService(transport);
    const result = await service.getEditOutline({ fileId: 'doc-1' });

    expect(result.blocks).toEqual([
      expect.objectContaining({
        ref: 'doc/p1',
        block_id: 'commented',
        text: 'Commented text',
        safe_to_replace: false,
        has_inline_content_risk: true,
      }),
    ]);
  });

  it('edits a doc by outline ref and verifies the post-write state', async () => {
    const transport = createMockTransport();
    const initialBlocks = {
      'doc-1': { id: 'doc-1', type: 'BLOCK_TYPE_PAGE', version: 1, content: { title: 'Doc title' } },
      heading: {
        id: 'heading',
        parentId: 'doc-1',
        type: 'BLOCK_TYPE_HEADING_2',
        seq: 'a1',
        version: 2,
        content: { title: 'Plan' },
      },
      paragraph: {
        id: 'paragraph',
        parentId: 'doc-1',
        type: 'BLOCK_TYPE_PARAGRAPH',
        seq: 'a2',
        version: 7,
        content: { title: 'Old paragraph' },
      },
    };
    const updatedBlocks = {
      ...initialBlocks,
      paragraph: {
        ...initialBlocks.paragraph,
        version: 8,
        content: { title: 'New paragraph' },
      },
    };
    let contentReads = 0;
    transport.requestJson.mockImplementation(async (options?: unknown) => {
      const request = options as { path?: string };
      if (request.path === '/api/page/doc-1/content?returnEncodedData=true&fileId=doc-1') {
        contentReads += 1;
        return contentReads === 1 ? encodeBlocks(initialBlocks) : encodeBlocks(updatedBlocks);
      }
      if (request.path === '/api/user/me') {
        return { user: { userId: 'user-1' }, account: { accountId: 'acct-1' } };
      }
      if (request.path === '/api/block/transactions?fileId=doc-1') {
        return {};
      }
      return undefined;
    });

    const service = new ZoomDocsService(transport);
    const result = await service.editDoc({
      fileId: 'doc-1',
      target: { by: 'ref', value: 'h2:plan/p1' },
      operation: { type: 'replace_text', text: 'New paragraph' },
    });

    expect(result).toMatchObject({
      ok: true,
      matched_block_id: 'paragraph',
      matched_heading: 'Plan',
      before_text: 'Old paragraph',
      after_text: 'New paragraph',
    });
  });

  it('edits a unique exact-text target in place and verifies the post-write state', async () => {
    const transport = createMockTransport();
    const initialBlocks = {
      'doc-1': { id: 'doc-1', type: 'BLOCK_TYPE_PAGE', version: 1, content: { title: 'Doc title' } },
      intro: {
        id: 'intro',
        parentId: 'doc-1',
        type: 'BLOCK_TYPE_PARAGRAPH',
        seq: 'a1',
        version: 7,
        content: { title: 'Intrdo paragraph' },
      },
    };
    const updatedBlocks = {
      ...initialBlocks,
      intro: {
        ...initialBlocks.intro,
        version: 11,
        content: { title: 'Intro paragraph' },
      },
    };
    let contentReads = 0;
    transport.requestJson.mockImplementation(async (options?: unknown) => {
      const request = options as { path?: string };
      if (request.path === '/api/page/doc-1/content?returnEncodedData=true&fileId=doc-1') {
        contentReads += 1;
        return contentReads === 1 ? encodeBlocks(initialBlocks) : encodeBlocks(updatedBlocks);
      }
      if (request.path === '/api/user/me') {
        return { user: { userId: 'user-1' }, account: { accountId: 'acct-1' } };
      }
      if (request.path === '/api/block/transactions?fileId=doc-1') {
        return {};
      }
      return undefined;
    });

    const service = new ZoomDocsService(transport);
    const result = await service.editDoc({
      fileId: 'doc-1',
      target: { by: 'exact_text', value: 'Intrdo paragraph' },
      operation: { type: 'replace_text', text: 'Intro paragraph' },
    });

    expect(result).toMatchObject({
      ok: true,
      file_id: 'doc-1',
      preserved_file_id: true,
      matched_block_id: 'intro',
      matched_block_type: 'BLOCK_TYPE_PARAGRAPH',
      operation_type: 'replace_text',
      before_text: 'Intrdo paragraph',
      after_text: 'Intro paragraph',
      previous_version: 7,
      new_version: 11,
      warnings: [],
    });
    expect(transport.requestJson).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        path: '/api/block/transactions?fileId=doc-1',
        fileId: 'doc-1',
        body: expect.objectContaining({ baseVersion: 1 }),
      })
    );
  });

  it('lists open inline comment threads with normalized comments and users', async () => {
    const transport = createMockTransport();
    const threadId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const commentId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const blockId = 'paragraph';
    transport.requestJson.mockImplementation(async (options?: unknown) => {
      const request = options as { path?: string; body?: unknown };
      if (request.path === '/api/page/doc-1/content?returnEncodedData=true&fileId=doc-1') {
        return encodeBlocks({
          'doc-1': { id: 'doc-1', type: 'BLOCK_TYPE_PAGE', version: 1, content: { title: 'Doc title' } },
          [blockId]: {
            id: blockId,
            parentId: 'doc-1',
            type: 'BLOCK_TYPE_PARAGRAPH',
            seq: 'a1',
            version: 2,
            content: {
              title: `[[0,"Commented text","26:\\"user-1\\"|8:1|thread-${threadId}:true"]]`,
            },
          },
        });
      }
      if (request.path === '/api/comment/threads:batchGet?fileId=doc-1') {
        expect(request.body).toEqual({ threadIds: [threadId], threadStatus: 'open' });
        return {
          threads: [
            {
              thread: {
                threadId,
                createdBy: 'user-1',
                threadStatus: 'open',
                selectContent: 'Commented text',
                createAt: '1776067728209',
                modifyAt: '1776067728209',
                commentCount: '1',
                rootBlockId: 'doc-1',
                fileId: 'doc-1',
                newestCommentCreateAt: '1776070036859',
                resolveAt: '0',
                commentType: 1,
                blockIds: [blockId],
              },
              comments: [
                {
                  comment: {
                    commentId,
                    createdBy: 'user-2',
                    content: JSON.stringify({ text: 'Looks good to me.\n' }),
                    parentComment: '',
                    createAt: '1776070036859',
                    modifyAt: '1776070036859',
                    attachments: '',
                    threadId,
                    isEdited: false,
                    parentId: '',
                  },
                  reactions: [],
                },
              ],
            },
          ],
          users: {
            'user-1': { userId: 'user-1', displayName: 'Owner', avatarUrl: '' },
            'user-2': { userId: 'user-2', displayName: 'Reviewer', avatarUrl: '' },
          },
        };
      }
      if (request.path === '/api/comment/discussions:batchGet?fileId=doc-1') {
        expect(request.body).toEqual({ commentType: 2, threadStatus: 'open', limit: 200, cursor: '' });
        return { threads: [], users: {}, nextCursor: '' };
      }
      return undefined;
    });

    const service = new ZoomDocsService(transport);
    const result = await service.getComments({ fileId: 'doc-1' });

    expect(result).toEqual({
      file_id: 'doc-1',
      doc_url: 'https://docs.zoom.us/doc/doc-1',
      thread_status: 'open',
      inline_thread_ids: [threadId],
      threads: [
        {
          source: 'inline',
          thread_id: threadId,
          thread_url: 'https://docs.zoom.us/doc/doc-1',
          status: 'open',
          selected_content: 'Commented text',
          comment_type: 1,
          file_id: 'doc-1',
          root_block_id: 'doc-1',
          block_ids: [blockId],
          created_by: 'user-1',
          created_at: '2026-04-13T08:08:48.209Z',
          modified_at: '2026-04-13T08:08:48.209Z',
          resolved_at: null,
          comment_count: 1,
          comments: [
            {
              comment_id: commentId,
              thread_id: threadId,
              parent_comment_id: null,
              created_by: 'user-2',
              text: 'Looks good to me.\n',
              created_at: '2026-04-13T08:47:16.859Z',
              modified_at: '2026-04-13T08:47:16.859Z',
              is_edited: false,
              reaction_count: 0,
            },
          ],
        },
      ],
      users: {
        'user-1': { user_id: 'user-1', display_name: 'Owner', avatar_url: '' },
        'user-2': { user_id: 'user-2', display_name: 'Reviewer', avatar_url: '' },
      },
      discussion_next_cursor: '',
    });
  });

  it('filters comments by thread id and includes doc/thread URLs', async () => {
    const transport = createMockTransport();
    const firstThreadId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const secondThreadId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    transport.requestJson.mockImplementation(async (options?: unknown) => {
      const request = options as { path?: string; body?: unknown };
      if (request.path === '/api/page/doc-1/content?returnEncodedData=true&fileId=doc-1') {
        return encodeBlocks({
          'doc-1': { id: 'doc-1', type: 'BLOCK_TYPE_PAGE', version: 1, content: { title: 'Doc title' } },
        });
      }
      if (request.path === '/api/comment/threads:batchGet?fileId=doc-1') {
        expect(request.body).toEqual({ threadIds: [secondThreadId], threadStatus: 'open' });
        return {
          threads: [
            {
              thread: { threadId: secondThreadId, threadStatus: 'open', commentType: 2, fileId: 'doc-1', rootBlockId: 'doc-1', blockIds: [] },
              comments: [],
            },
          ],
          users: {},
        };
      }
      if (request.path === '/api/comment/discussions:batchGet?fileId=doc-1') {
        return {
          threads: [firstThreadId, secondThreadId].map((threadId) => ({
            thread: { threadId, threadStatus: 'open', commentType: 2, fileId: 'doc-1', rootBlockId: 'doc-1', blockIds: [] },
            comments: [
              {
                comment: {
                  commentId: `${threadId}-comment`,
                  createdBy: 'user-1',
                  content: JSON.stringify({ text: `Comment for ${threadId}` }),
                  attachments: '',
                  threadId,
                  isEdited: false,
                  parentId: '',
                },
                reactions: [],
              },
            ],
          })),
          users: {},
          nextCursor: '',
        };
      }
      return undefined;
    });

    const service = new ZoomDocsService(transport);
    const result = await service.getComments({ fileId: 'doc-1', threadStatus: 'open', threadId: secondThreadId });

    expect(result).toMatchObject({
      file_id: 'doc-1',
      doc_url: 'https://docs.zoom.us/doc/doc-1',
      filtered_thread_id: secondThreadId,
      threads: [
        {
          source: 'discussion',
          thread_id: secondThreadId,
          thread_url: 'https://docs.zoom.us/doc/doc-1',
          comments: [{ comment_id: `${secondThreadId}-comment` }],
        },
      ],
    });
    expect(result.threads).toHaveLength(1);
  });

  it('lists resolved whole-doc comment threads', async () => {
    const transport = createMockTransport();
    const threadId = 'cccccccccccccccccccccccccccccccc';
    const commentId = 'dddddddddddddddddddddddddddddddd';
    transport.requestJson.mockImplementation(async (options?: unknown) => {
      const request = options as { path?: string; body?: unknown };
      if (request.path === '/api/page/doc-1/content?returnEncodedData=true&fileId=doc-1') {
        return encodeBlocks({
          'doc-1': { id: 'doc-1', type: 'BLOCK_TYPE_PAGE', version: 1, content: { title: 'Doc title' } },
        });
      }
      if (request.path === '/api/comment/discussions:batchGet?fileId=doc-1') {
        expect(request.body).toEqual({ commentType: 2, threadStatus: 'resolved', limit: 200, cursor: '' });
        return {
          threads: [
            {
              thread: {
                threadId,
                createdBy: 'user-1',
                threadStatus: 'resolved',
                selectContent: '',
                createAt: '1777452173752',
                modifyAt: '1777452256772',
                commentCount: '1',
                rootBlockId: 'doc-1',
                fileId: 'doc-1',
                newestCommentCreateAt: '1777452173752',
                resolveAt: '1777452256772',
                commentType: 2,
                blockIds: [],
              },
              comments: [
                {
                  comment: {
                    commentId,
                    createdBy: 'user-1',
                    content: JSON.stringify({ text: 'This is a whole doc comment\n' }),
                    parentComment: '',
                    createAt: '1777452173752',
                    modifyAt: '1777452173752',
                    attachments: '',
                    threadId,
                    isEdited: false,
                    parentId: '',
                  },
                  reactions: [],
                },
              ],
            },
          ],
          users: { 'user-1': { userId: 'user-1', displayName: 'Owner', avatarUrl: '' } },
          nextCursor: '',
        };
      }
      return undefined;
    });

    const service = new ZoomDocsService(transport);
    const result = await service.getComments({ fileId: 'doc-1', threadStatus: 'resolved' });

    expect(result).toMatchObject({
      file_id: 'doc-1',
      thread_status: 'resolved',
      inline_thread_ids: [],
      threads: [
        {
          source: 'discussion',
          thread_id: threadId,
          status: 'resolved',
          selected_content: '',
          comment_type: 2,
          block_ids: [],
          resolved_at: '2026-04-29T08:44:16.772Z',
          comments: [{ comment_id: commentId, text: 'This is a whole doc comment\n' }],
        },
      ],
    });
  });

  it('adds a plain-text reply to an existing comment and verifies it by reading back', async () => {
    const transport = createMockTransport();
    let replyCommentId = '';
    let replyCreated = false;
    transport.requestJson.mockImplementation(async (options?: unknown) => {
      const request = options as { method?: string; path?: string; body?: Record<string, unknown> };
      if (request.path === '/api/page/doc-1/content?returnEncodedData=true&fileId=doc-1') {
        return encodeBlocks({ 'doc-1': { id: 'doc-1', type: 'BLOCK_TYPE_PAGE', version: 1, content: { title: 'Doc title' } } });
      }
      if (request.path === '/api/comment/discussions:batchGet?fileId=doc-1') {
        return {
          threads: [
            {
              thread: { threadId: 'thread-1', threadStatus: 'open', commentType: 2, fileId: 'doc-1', rootBlockId: 'doc-1', blockIds: [] },
              comments: [
                {
                  comment: {
                    commentId: 'root-comment-1',
                    createdBy: 'user-1',
                    content: JSON.stringify({ text: 'Root comment' }),
                    attachments: '',
                    threadId: 'thread-1',
                    isEdited: false,
                    parentId: '',
                  },
                  reactions: [],
                },
                ...(replyCreated
                  ? [
                      {
                        comment: {
                          commentId: replyCommentId,
                          createdBy: 'user-2',
                          content: JSON.stringify({ text: 'Reply text' }),
                          attachments: '',
                          parentComment: JSON.stringify({ id: 'root-comment-1', content: JSON.stringify({ text: 'Root comment' }), attachments: '', createdBy: 'user-1' }),
                          threadId: 'thread-1',
                          isEdited: false,
                          parentId: 'root-comment-1',
                        },
                        reactions: [],
                      },
                    ]
                  : []),
              ],
            },
          ],
          users: {},
          nextCursor: '',
        };
      }
      if (request.method === 'POST' && request.path === '/api/comment/comments?fileId=doc-1') {
        replyCommentId = String(request.body?.commentId);
        expect(replyCommentId).toMatch(/^[a-f0-9]{32}$/);
        expect(request.body).toEqual({
          threadId: 'thread-1',
          commentContent: JSON.stringify({ text: 'Reply text' }),
          attachments: '[]',
          parentComment: JSON.stringify({ id: 'root-comment-1', content: JSON.stringify({ text: 'Root comment' }), attachments: '', createdBy: 'user-1' }),
          commentId: replyCommentId,
          blockIds: [],
          fileId: 'doc-1',
        });
        replyCreated = true;
        return {
          comment: { commentId: replyCommentId, threadId: 'thread-1', content: request.body?.commentContent, parentId: 'root-comment-1' },
          thread: { threadId: 'thread-1', threadStatus: 'open', commentType: 2, blockIds: [], commentCount: '2' },
        };
      }
      return undefined;
    });

    const service = new ZoomDocsService(transport);
    const result = await service.replyToComment({
      fileId: 'doc-1',
      threadId: 'thread-1',
      parentCommentId: 'root-comment-1',
      text: 'Reply text',
    });

    expect(result).toMatchObject({
      ok: true,
      file_id: 'doc-1',
      thread_id: 'thread-1',
      parent_comment_id: 'root-comment-1',
      comment_id: replyCommentId,
      text: 'Reply text',
      verified: true,
    });
    const normalizedReply = result.ok
      ? result.comments.threads.find((thread) => thread.thread_id === 'thread-1')?.comments.find((comment) => comment.comment_id === replyCommentId)
      : undefined;
    expect(normalizedReply?.parent_comment_id).toBe('root-comment-1');
  });

  it('reopens a resolved comment thread and verifies it in the open bucket', async () => {
    const transport = createMockTransport();
    transport.requestJson.mockImplementation(async (options?: unknown) => {
      const request = options as { method?: string; path?: string; body?: Record<string, unknown> };
      if (request.method === 'PATCH' && request.path === '/api/comment/threads/thread-1?fileId=doc-1') {
        expect(request.body).toEqual({ threadStatus: 'open' });
        return { thread: { threadId: 'thread-1', threadStatus: 'open' } };
      }
      if (request.path === '/api/page/doc-1/content?returnEncodedData=true&fileId=doc-1') {
        return encodeBlocks({ 'doc-1': { id: 'doc-1', type: 'BLOCK_TYPE_PAGE', version: 1, content: { title: 'Doc title' } } });
      }
      if (request.path === '/api/comment/threads:batchGet?fileId=doc-1') {
        return { threads: [], users: {} };
      }
      if (request.path === '/api/comment/discussions:batchGet?fileId=doc-1') {
        return {
          threads: [
            {
              thread: { threadId: 'thread-1', threadStatus: 'open', commentType: 2, fileId: 'doc-1', rootBlockId: 'doc-1', blockIds: [] },
              comments: [
                {
                  comment: {
                    commentId: 'comment-1',
                    createdBy: 'user-1',
                    content: JSON.stringify({ text: 'Comment text' }),
                    threadId: 'thread-1',
                    isEdited: false,
                  },
                  reactions: [],
                },
              ],
            },
          ],
          users: {},
          nextCursor: '',
        };
      }
      return undefined;
    });

    const service = new ZoomDocsService(transport);
    const result = await service.reopenCommentThread({ fileId: 'doc-1', threadId: 'thread-1' });

    expect(result).toMatchObject({
      ok: true,
      file_id: 'doc-1',
      thread_id: 'thread-1',
      verified: true,
      comments: { thread_status: 'open', threads: [{ thread_id: 'thread-1', status: 'open' }] },
    });
  });

  it('returns a structured failure without patching when the resolved thread is not found', async () => {
    const transport = createMockTransport();
    transport.requestJson.mockImplementation(async (options?: unknown) => {
      const request = options as { method?: string; path?: string };
      if (request.method === 'PATCH') {
        throw new Error('resolve patch should not be attempted for a missing thread');
      }
      if (request.path === '/api/page/doc-1/content?returnEncodedData=true&fileId=doc-1') {
        return encodeBlocks({ 'doc-1': { id: 'doc-1', type: 'BLOCK_TYPE_PAGE', version: 1, content: { title: 'Doc title' } } });
      }
      if (request.path === '/api/comment/threads:batchGet?fileId=doc-1') {
        return { threads: [], users: {} };
      }
      if (request.path === '/api/comment/discussions:batchGet?fileId=doc-1') {
        return { threads: [], users: {}, nextCursor: '' };
      }
      return undefined;
    });

    const service = new ZoomDocsService(transport);
    const result = await service.resolveCommentThread({ fileId: 'doc-1', threadId: 'missing-thread' });

    expect(result).toMatchObject({
      ok: false,
      file_id: 'doc-1',
      thread_id: 'missing-thread',
      error_code: 'THREAD_NOT_FOUND',
      comments: { threads: [] },
    });
  });

  it('resolves a comment thread and verifies it in the resolved bucket', async () => {
    const transport = createMockTransport();
    transport.requestJson.mockImplementation(async (options?: unknown) => {
      const request = options as { method?: string; path?: string; body?: Record<string, unknown> };
      if (request.method === 'PATCH' && request.path === '/api/comment/threads/thread-1?fileId=doc-1') {
        expect(request.body).toEqual({ threadStatus: 'resolved' });
        return { thread: { threadId: 'thread-1', threadStatus: 'resolved', resolveAt: '1777452250646' } };
      }
      if (request.path === '/api/page/doc-1/content?returnEncodedData=true&fileId=doc-1') {
        return encodeBlocks({ 'doc-1': { id: 'doc-1', type: 'BLOCK_TYPE_PAGE', version: 1, content: { title: 'Doc title' } } });
      }
      if (request.path === '/api/comment/threads:batchGet?fileId=doc-1') {
        return { threads: [], users: {} };
      }
      if (request.path === '/api/comment/discussions:batchGet?fileId=doc-1') {
        return {
          threads: [
            {
              thread: { threadId: 'thread-1', threadStatus: 'resolved', commentType: 2, fileId: 'doc-1', rootBlockId: 'doc-1', blockIds: [], resolveAt: '1777452250646' },
              comments: [
                {
                  comment: {
                    commentId: 'comment-1',
                    createdBy: 'user-1',
                    content: JSON.stringify({ text: 'Comment text' }),
                    threadId: 'thread-1',
                    isEdited: false,
                  },
                  reactions: [],
                },
              ],
            },
          ],
          users: {},
          nextCursor: '',
        };
      }
      return undefined;
    });

    const service = new ZoomDocsService(transport);
    const result = await service.resolveCommentThread({ fileId: 'doc-1', threadId: 'thread-1' });

    expect(result).toMatchObject({
      ok: true,
      file_id: 'doc-1',
      thread_id: 'thread-1',
      verified: true,
      comments: { thread_status: 'resolved', threads: [{ thread_id: 'thread-1', status: 'resolved' }] },
    });
  });

  it('deletes a non-root comment and verifies it is absent on read-back', async () => {
    const transport = createMockTransport();
    let deleted = false;
    transport.requestJson.mockImplementation(async (options?: unknown) => {
      const request = options as { method?: string; path?: string; body?: Record<string, unknown> };
      if (request.path === '/api/page/doc-1/content?returnEncodedData=true&fileId=doc-1') {
        return encodeBlocks({ 'doc-1': { id: 'doc-1', type: 'BLOCK_TYPE_PAGE', version: 1, content: { title: 'Doc title' } } });
      }
      if (request.path === '/api/comment/discussions:batchGet?fileId=doc-1') {
        return {
          threads: [
            {
              thread: { threadId: 'thread-1', threadStatus: 'open', commentType: 2, fileId: 'doc-1', rootBlockId: 'doc-1', blockIds: [] },
              comments: [
                {
                  comment: {
                    commentId: 'root-comment-1',
                    createdBy: 'user-1',
                    content: JSON.stringify({ text: 'Root comment' }),
                    attachments: '',
                    threadId: 'thread-1',
                    isEdited: false,
                    parentId: '',
                  },
                  reactions: [],
                },
                ...(deleted
                  ? []
                  : [
                      {
                        comment: {
                          commentId: 'reply-comment-1',
                          createdBy: 'user-2',
                          content: JSON.stringify({ text: 'Reply text' }),
                          attachments: '',
                          threadId: 'thread-1',
                          isEdited: false,
                          parentId: 'root-comment-1',
                        },
                        reactions: [],
                      },
                    ]),
              ],
            },
          ],
          users: {},
          nextCursor: '',
        };
      }
      if (request.method === 'DELETE' && request.path === '/api/comment/comments/reply-comment-1?threadId=thread-1&fileId=doc-1') {
        expect(request.body).toEqual({});
        deleted = true;
        return { thread: { threadId: 'thread-1', threadStatus: 'open', commentCount: '1' } };
      }
      return undefined;
    });

    const service = new ZoomDocsService(transport);
    const result = await service.deleteComment({ fileId: 'doc-1', threadId: 'thread-1', commentId: 'reply-comment-1' });

    expect(result).toMatchObject({
      ok: true,
      file_id: 'doc-1',
      thread_id: 'thread-1',
      comment_id: 'reply-comment-1',
      verified: true,
    });
    expect(result.ok && result.comments.threads[0]?.comments.map((comment) => comment.comment_id)).toEqual(['root-comment-1']);
  });

  it('refuses to delete a root comment because full-thread deletion is not replay-verified', async () => {
    const transport = createMockTransport();
    transport.requestJson.mockImplementation(async (options?: unknown) => {
      const request = options as { method?: string; path?: string };
      if (request.path === '/api/page/doc-1/content?returnEncodedData=true&fileId=doc-1') {
        return encodeBlocks({ 'doc-1': { id: 'doc-1', type: 'BLOCK_TYPE_PAGE', version: 1, content: { title: 'Doc title' } } });
      }
      if (request.path === '/api/comment/discussions:batchGet?fileId=doc-1') {
        return {
          threads: [
            {
              thread: { threadId: 'thread-1', threadStatus: 'open', commentType: 2, fileId: 'doc-1', rootBlockId: 'doc-1', blockIds: [] },
              comments: [
                {
                  comment: {
                    commentId: 'root-comment-1',
                    createdBy: 'user-1',
                    content: JSON.stringify({ text: 'Root comment' }),
                    attachments: '',
                    threadId: 'thread-1',
                    isEdited: false,
                    parentId: '',
                  },
                  reactions: [],
                },
              ],
            },
          ],
          users: {},
          nextCursor: '',
        };
      }
      if (request.method === 'DELETE') {
        throw new Error('Root comment delete should not be attempted');
      }
      return undefined;
    });

    const service = new ZoomDocsService(transport);
    const result = await service.deleteComment({ fileId: 'doc-1', threadId: 'thread-1', commentId: 'root-comment-1' });

    expect(result).toMatchObject({
      ok: false,
      file_id: 'doc-1',
      thread_id: 'thread-1',
      comment_id: 'root-comment-1',
      error_code: 'ROOT_COMMENT_DELETE_NOT_VERIFIED',
    });
  });

  it('adds an inline comment to a unique selected substring and verifies it by reading back', async () => {
    const transport = createMockTransport();
    let threadId = '';
    let commentId = '';
    let markerApplied = false;
    const plainTitle = JSON.stringify([[0, 'Inline target alpha beta gamma.', '26:"user-1"']]);

    transport.requestJson.mockImplementation(async (options?: unknown) => {
      const request = options as { method?: string; path?: string; body?: Record<string, unknown> };
      if (request.path === '/api/page/doc-1/content?returnEncodedData=true&fileId=doc-1') {
        const markedTitle = threadId
          ? JSON.stringify([
              [0, 'Inline target ', '26:"user-1"'],
              [0, 'alpha beta', `thread-${threadId}:true`],
              [0, ' gamma.', '26:"user-1"'],
            ])
          : plainTitle;
        return encodeBlocks({
          'doc-1': { id: 'doc-1', type: 'BLOCK_TYPE_PAGE', version: markerApplied ? 2 : 1, content: { title: 'Doc title' } },
          'block-1': { id: 'block-1', parentId: 'doc-1', type: 'BLOCK_TYPE_PARAGRAPH', version: markerApplied ? 2 : 1, seq: 'a0', content: { title: markerApplied ? markedTitle : plainTitle } },
        });
      }
      if (request.method === 'POST' && request.path === '/api/comment/threads?fileId=doc-1') {
        threadId = String(request.body?.threadId);
        commentId = String(request.body?.commentId);
        expect(threadId).toMatch(/^[a-f0-9]{32}$/);
        expect(commentId).toMatch(/^[a-f0-9]{32}$/);
        expect(request.body).toEqual({
          threadId,
          selectContent: 'alpha beta',
          commentContent: JSON.stringify({ text: 'Inline comment' }),
          attachments: '[]',
          rootBlockId: 'doc-1',
          commentId,
          blockIds: ['block-1'],
          fileId: 'doc-1',
        });
        return {
          thread: { threadId, threadStatus: 'open', selectContent: 'alpha beta', commentType: 1, blockIds: ['block-1'] },
          comment: { commentId, threadId, content: request.body?.commentContent },
        };
      }
      if (request.method === 'POST' && request.path === '/api/block/transactions?fileId=doc-1') {
        expect(request.body).toMatchObject({
          baseVersion: 1,
          transactions: [
            {
              ops: [
                {
                  command: 'COMMAND_TYPE_UPDATE',
                  blockId: 'block-1',
                  args: { delta: JSON.stringify([[2, 14], [2, 10, `thread-${threadId}:true`]]) },
                },
              ],
            },
          ],
        });
        markerApplied = true;
        return {};
      }
      if (request.path === '/api/comment/threads:batchGet?fileId=doc-1') {
        expect(request.body).toEqual({ threadIds: [threadId], threadStatus: 'open' });
        return {
          threads: [
            {
              thread: { threadId, threadStatus: 'open', selectContent: 'alpha beta', commentType: 1, fileId: 'doc-1', rootBlockId: 'doc-1', blockIds: ['block-1'] },
              comments: [
                {
                  comment: {
                    commentId,
                    createdBy: 'user-1',
                    content: JSON.stringify({ text: 'Inline comment' }),
                    attachments: '',
                    threadId,
                    isEdited: false,
                    parentId: '',
                  },
                  reactions: [],
                },
              ],
            },
          ],
          users: {},
        };
      }
      if (request.path === '/api/comment/discussions:batchGet?fileId=doc-1') {
        return { threads: [], users: {}, nextCursor: '' };
      }
      return undefined;
    });

    const service = new ZoomDocsService(transport);
    const result = await service.addInlineComment({
      fileId: 'doc-1',
      target: { by: 'ref', value: 'doc/p1' },
      selectedText: 'alpha beta',
      text: 'Inline comment',
    });

    expect(result).toMatchObject({
      ok: true,
      file_id: 'doc-1',
      block_id: 'block-1',
      thread_id: threadId,
      comment_id: commentId,
      selected_text: 'alpha beta',
      text: 'Inline comment',
      verified: true,
    });
  });

  it('resolves an orphan inline thread when marker insertion fails', async () => {
    const transport = createMockTransport();
    let threadId = '';
    let commentId = '';
    let resolvedThread = false;
    const plainTitle = JSON.stringify([[0, 'Inline target alpha beta gamma.', '26:"user-1"']]);

    transport.requestJson.mockImplementation(async (options?: unknown) => {
      const request = options as { method?: string; path?: string; body?: Record<string, unknown> };
      if (request.path === '/api/page/doc-1/content?returnEncodedData=true&fileId=doc-1') {
        return encodeBlocks({
          'doc-1': { id: 'doc-1', type: 'BLOCK_TYPE_PAGE', version: 1, content: { title: 'Doc title' } },
          'block-1': { id: 'block-1', parentId: 'doc-1', type: 'BLOCK_TYPE_PARAGRAPH', version: 1, seq: 'a0', content: { title: plainTitle } },
        });
      }
      if (request.method === 'POST' && request.path === '/api/comment/threads?fileId=doc-1') {
        threadId = String(request.body?.threadId);
        commentId = String(request.body?.commentId);
        return {
          thread: { threadId, threadStatus: 'open', selectContent: 'alpha beta', commentType: 1, blockIds: ['block-1'] },
          comment: { commentId, threadId, content: request.body?.commentContent },
        };
      }
      if (request.method === 'POST' && request.path === '/api/block/transactions?fileId=doc-1') {
        throw new Error('marker transaction failed');
      }
      if (request.method === 'PATCH' && request.path === `/api/comment/threads/${threadId}?fileId=doc-1`) {
        expect(request.body).toEqual({ threadStatus: 'resolved' });
        resolvedThread = true;
        return { thread: { threadId, threadStatus: 'resolved' } };
      }
      return undefined;
    });

    const service = new ZoomDocsService(transport);
    const result = await service.addInlineComment({
      fileId: 'doc-1',
      target: { by: 'ref', value: 'doc/p1' },
      selectedText: 'alpha beta',
      text: 'Inline comment',
    });

    expect(result).toMatchObject({
      ok: false,
      file_id: 'doc-1',
      thread_id: threadId,
      comment_id: commentId,
      error_code: 'MARKER_INSERT_FAILED',
      cleanup: { attempted: true, resolved_thread: true },
    });
    expect(resolvedThread).toBe(true);
  });

  it('returns a structured failure without posting when the thread to reopen is not found', async () => {
    const transport = createMockTransport();
    transport.requestJson.mockImplementation(async (options?: unknown) => {
      const request = options as { method?: string; path?: string };
      if (request.method === 'PATCH') {
        throw new Error('reopen patch should not be attempted for a missing thread');
      }
      if (request.path === '/api/page/doc-1/content?returnEncodedData=true&fileId=doc-1') {
        return encodeBlocks({ 'doc-1': { id: 'doc-1', type: 'BLOCK_TYPE_PAGE', version: 1, content: { title: 'Doc title' } } });
      }
      if (request.path === '/api/comment/threads:batchGet?fileId=doc-1') {
        return { threads: [], users: {} };
      }
      if (request.path === '/api/comment/discussions:batchGet?fileId=doc-1') {
        return { threads: [], users: {}, nextCursor: '' };
      }
      return undefined;
    });

    const service = new ZoomDocsService(transport);
    const result = await service.reopenCommentThread({ fileId: 'doc-1', threadId: 'missing-thread' });

    expect(result).toMatchObject({
      ok: false,
      file_id: 'doc-1',
      thread_id: 'missing-thread',
      error_code: 'THREAD_NOT_FOUND',
      comments: { threads: [] },
    });
  });

  it('adds an emoji reaction to an existing comment and verifies it by reading back', async () => {
    const transport = createMockTransport();
    let reactionId = '';
    transport.requestJson.mockImplementation(async (options?: unknown) => {
      const request = options as { method?: string; path?: string; body?: Record<string, unknown> };
      if (request.method === 'POST' && request.path === '/api/comment/reactions?fileId=doc-1') {
        reactionId = String(request.body?.reactionId);
        expect(reactionId).toMatch(/^[a-f0-9]{32}$/);
        expect(request.body).toEqual({
          threadId: 'thread-1',
          commentId: 'comment-1',
          reactionId,
          reaction: '💙',
        });
        return {
          reaction: {
            userId: 'user-1',
            reaction: '💙',
            createAt: '1777451935217',
            threadId: 'thread-1',
            commentId: 'comment-1',
            reactionId,
          },
        };
      }
      if (request.path === '/api/page/doc-1/content?returnEncodedData=true&fileId=doc-1') {
        return encodeBlocks({ 'doc-1': { id: 'doc-1', type: 'BLOCK_TYPE_PAGE', version: 1, content: { title: 'Doc title' } } });
      }
      if (request.path === '/api/comment/threads:batchGet?fileId=doc-1') {
        return { threads: [], users: {} };
      }
      if (request.path === '/api/comment/discussions:batchGet?fileId=doc-1') {
        return {
          threads: [
            {
              thread: { threadId: 'thread-1', threadStatus: 'open', commentType: 2, fileId: 'doc-1', rootBlockId: 'doc-1', blockIds: [] },
              comments: [
                {
                  comment: {
                    commentId: 'comment-1',
                    createdBy: 'user-2',
                    content: JSON.stringify({ text: 'Comment text' }),
                    threadId: 'thread-1',
                    isEdited: false,
                  },
                  reactions: [{ userId: 'user-1', reaction: '💙', createAt: '1777451935217', threadId: 'thread-1', commentId: 'comment-1', reactionId }],
                },
              ],
            },
          ],
          users: {},
          nextCursor: '',
        };
      }
      return undefined;
    });

    const service = new ZoomDocsService(transport);
    const result = await service.addCommentReaction({
      fileId: 'doc-1',
      threadId: 'thread-1',
      commentId: 'comment-1',
      reaction: '💙',
    });

    expect(result).toMatchObject({
      ok: true,
      file_id: 'doc-1',
      thread_id: 'thread-1',
      comment_id: 'comment-1',
      reaction_id: reactionId,
      reaction: '💙',
      verified: true,
    });
  });

  it('returns a structured failure without posting when reacting to a missing comment', async () => {
    const transport = createMockTransport();
    transport.requestJson.mockImplementation(async (options?: unknown) => {
      const request = options as { method?: string; path?: string };
      if (request.method === 'POST' && request.path === '/api/comment/reactions?fileId=doc-1') {
        throw new Error('reaction post should not be attempted for a missing comment');
      }
      if (request.path === '/api/page/doc-1/content?returnEncodedData=true&fileId=doc-1') {
        return encodeBlocks({ 'doc-1': { id: 'doc-1', type: 'BLOCK_TYPE_PAGE', version: 1, content: { title: 'Doc title' } } });
      }
      if (request.path === '/api/comment/threads:batchGet?fileId=doc-1') {
        return { threads: [], users: {} };
      }
      if (request.path === '/api/comment/discussions:batchGet?fileId=doc-1') {
        return {
          threads: [
            {
              thread: { threadId: 'thread-1', threadStatus: 'open', commentType: 2, fileId: 'doc-1', rootBlockId: 'doc-1', blockIds: [] },
              comments: [],
            },
          ],
          users: {},
          nextCursor: '',
        };
      }
      return undefined;
    });

    const service = new ZoomDocsService(transport);
    const result = await service.addCommentReaction({
      fileId: 'doc-1',
      threadId: 'thread-1',
      commentId: 'missing-comment',
      reaction: '💙',
    });

    expect(result).toMatchObject({
      ok: false,
      file_id: 'doc-1',
      thread_id: 'thread-1',
      comment_id: 'missing-comment',
      error_code: 'COMMENT_NOT_FOUND',
      comments: { threads: [{ thread_id: 'thread-1', comments: [] }] },
    });
  });

  it('returns a structured failure when comment attachment upload fails', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'zoomdocs-comment-attachment-fail-'));
    const attachmentPath = path.join(tmpDir, 'note.txt');
    await writeFile(attachmentPath, 'hello file!', 'utf8');

    const fetchMock = vi.fn(async () => ({ ok: false, status: 400, text: async () => '{"message":"Unexpected Content-Type"}' }));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const transport = createMockTransport();
      transport.requestJson.mockImplementation(async (options?: unknown) => {
        const request = options as { path?: string };
        if (request.path === '/api/attachment/getUploadFileUrl?fileId=doc-1') {
          return {
            attachmentId: 'attachment-1',
            signedPutUrl: 'https://upload.example.test/file',
            putHeaders: { 'x-zm-auth': 'Bearer token', 'Zoom-File-Meta': '{}' },
          };
        }
        return undefined;
      });

      const service = new ZoomDocsService(transport);
      const result = await service.addDocComment({
        fileId: 'doc-1',
        text: 'See attachment',
        attachments: [{ path: attachmentPath }],
      });

      expect(result).toMatchObject({
        ok: false,
        file_id: 'doc-1',
        error_code: 'ATTACHMENT_UPLOAD_FAILED',
        message: 'Zoom Docs attachment upload failed for note.txt: 400 {"message":"Unexpected Content-Type"}',
      });
      expect(transport.requestJson).not.toHaveBeenCalledWith(expect.objectContaining({ path: '/api/comment/threads?fileId=doc-1' }));
    } finally {
      vi.unstubAllGlobals();
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('uploads a local attachment and adds it to a whole-doc comment', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'zoomdocs-comment-attachment-'));
    const attachmentPath = path.join(tmpDir, 'note.txt');
    await writeFile(attachmentPath, 'hello file!', 'utf8');

    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const transport = createMockTransport();
      let createdThreadId = '';
      let createdCommentId = '';
      let attachmentRecord: Record<string, unknown> | undefined;
      transport.requestJson.mockImplementation(async (options?: unknown) => {
        const request = options as { method?: string; path?: string; body?: Record<string, unknown> };
        if (request.path === '/api/attachment/getUploadFileUrl?fileId=doc-1') {
          expect(request.body).toEqual({
            bucket: 8,
            name: 'note.txt',
            contentType: 'text/plain',
            contentLength: 11,
            permissionRecord: { pageId: 'doc-1', blockId: 'doc-1' },
          });
          return {
            attachmentId: 'attachment-1',
            signedPutUrl: 'https://upload.example.test/file',
            putHeaders: { 'x-zm-auth': 'Bearer token', 'Zoom-File-Meta': '{}' },
          };
        }
        if (request.method === 'POST' && request.path === '/api/comment/threads?fileId=doc-1') {
          createdThreadId = String(request.body?.threadId);
          createdCommentId = String(request.body?.commentId);
          const attachments = JSON.parse(String(request.body?.attachments)) as Array<Record<string, unknown>>;
          attachmentRecord = attachments[0];
          expect(attachmentRecord).toMatchObject({
            name: 'note.txt',
            size: 11,
            type: 'text/plain',
            attachmentId: 'attachment-1',
          });
          expect(attachmentRecord?.id).toEqual(expect.stringMatching(/^[a-f0-9]{32}$/));
          return {
            thread: { threadId: createdThreadId, threadStatus: 'open', commentType: 2, blockIds: [] },
            comment: { commentId: createdCommentId, threadId: createdThreadId, content: request.body?.commentContent, attachments: request.body?.attachments },
          };
        }
        if (request.path === '/api/page/doc-1/content?returnEncodedData=true&fileId=doc-1') {
          return encodeBlocks({ 'doc-1': { id: 'doc-1', type: 'BLOCK_TYPE_PAGE', version: 1, content: { title: 'Doc title' } } });
        }
        if (request.path === '/api/comment/discussions:batchGet?fileId=doc-1') {
          return {
            threads: [
              {
                thread: { threadId: createdThreadId, threadStatus: 'open', commentType: 2, fileId: 'doc-1', rootBlockId: 'doc-1', blockIds: [] },
                comments: [
                  {
                    comment: {
                      commentId: createdCommentId,
                      createdBy: 'user-1',
                      content: JSON.stringify({ text: 'See attachment' }),
                      attachments: JSON.stringify([attachmentRecord]),
                      threadId: createdThreadId,
                      isEdited: false,
                    },
                    reactions: [],
                  },
                ],
              },
            ],
            users: {},
            nextCursor: '',
          };
        }
        return undefined;
      });

      const service = new ZoomDocsService(transport);
      const result = await service.addDocComment({
        fileId: 'doc-1',
        text: 'See attachment',
        attachments: [{ path: attachmentPath }],
      });

      expect(fetchMock).toHaveBeenCalledWith('https://upload.example.test/file', expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-zm-auth': 'Bearer token',
          'Zoom-File-Meta': '{}',
        }),
      }));
      const uploadCallOptions = (fetchMock.mock.calls[0] as unknown[] | undefined)?.[1] as { headers?: Record<string, string>; body?: unknown } | undefined;
      expect(uploadCallOptions?.headers?.['Content-Type']).toBeUndefined();
      expect(uploadCallOptions?.body).toBeInstanceOf(FormData);
      expect(result).toMatchObject({
        ok: true,
        file_id: 'doc-1',
        attachments: [
          {
            name: 'note.txt',
            size: 11,
            type: 'text/plain',
            attachment_id: 'attachment-1',
          },
        ],
        comments: {
          threads: [
            {
              comments: [
                {
                  attachments: [
                    {
                      name: 'note.txt',
                      size: 11,
                      type: 'text/plain',
                      attachment_id: 'attachment-1',
                    },
                  ],
                },
              ],
            },
          ],
        },
      });
    } finally {
      vi.unstubAllGlobals();
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('adds a whole-doc comment with an explicit mention content part', async () => {
    const transport = createMockTransport();
    let createdThreadId = '';
    let createdCommentId = '';
    let mentionId = '';
    transport.requestJson.mockImplementation(async (options?: unknown) => {
      const request = options as { method?: string; path?: string; body?: Record<string, unknown> };
      if (request.method === 'POST' && request.path === '/api/comment/threads?fileId=doc-1') {
        createdThreadId = String(request.body?.threadId);
        createdCommentId = String(request.body?.commentId);
        const commentContent = JSON.parse(String(request.body?.commentContent)) as {
          doc: Array<{ type: string; content?: Array<{ data: unknown }> }>;
          text: string;
        };
        const mentionData = commentContent.doc[0]?.content?.[1]?.data as { person?: { mentionId?: string; userId?: string; name?: string; notify?: boolean } };
        mentionId = mentionData.person?.mentionId ?? '';
        expect(mentionId).toMatch(/^[a-f0-9]{32}$/);
        expect(commentContent).toEqual({
          doc: [
            {
              type: 'BLOCK_TYPE_PARAGRAPH',
              content: [
                { data: 'Hi ' },
                { data: { person: { mentionId, userId: 'user-2', name: 'Reviewer', notify: true } } },
                { data: ', please review this.' },
              ],
            },
            { type: 'BLOCK_TYPE_PARAGRAPH', content: [] },
          ],
          text: 'Hi Reviewer, please review this.\n',
        });
        expect(request.body).toMatchObject({
          threadId: createdThreadId,
          attachments: '[]',
          rootBlockId: 'doc-1',
          commentId: createdCommentId,
          blockIds: ['doc-1'],
          commentType: 2,
          fileId: 'doc-1',
        });
        return {
          thread: { threadId: createdThreadId, threadStatus: 'open', commentType: 2, blockIds: [] },
          comment: { commentId: createdCommentId, threadId: createdThreadId, content: request.body?.commentContent },
        };
      }
      if (request.path === '/api/page/doc-1/content?returnEncodedData=true&fileId=doc-1') {
        return encodeBlocks({ 'doc-1': { id: 'doc-1', type: 'BLOCK_TYPE_PAGE', version: 1, content: { title: 'Doc title' } } });
      }
      if (request.path === '/api/comment/discussions:batchGet?fileId=doc-1') {
        return {
          threads: [
            {
              thread: { threadId: createdThreadId, threadStatus: 'open', commentType: 2, fileId: 'doc-1', rootBlockId: 'doc-1', blockIds: [] },
              comments: [
                {
                  comment: {
                    commentId: createdCommentId,
                    createdBy: 'user-1',
                    content: JSON.stringify({ text: 'Hi Reviewer, please review this.\n' }),
                    threadId: createdThreadId,
                    isEdited: false,
                  },
                  reactions: [],
                },
              ],
            },
          ],
          users: {},
          nextCursor: '',
        };
      }
      return undefined;
    });

    const service = new ZoomDocsService(transport);
    const result = await service.addDocComment({
      fileId: 'doc-1',
      contentParts: [
        { type: 'text', text: 'Hi ' },
        { type: 'mention', userId: 'user-2', name: 'Reviewer', notify: true },
        { type: 'text', text: ', please review this.' },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      file_id: 'doc-1',
      thread_id: createdThreadId,
      comment_id: createdCommentId,
      text: 'Hi Reviewer, please review this.\n',
      verified: true,
    });
  });

  it('adds a plain whole-doc comment and verifies it by reading comments back', async () => {
    const transport = createMockTransport();
    let createdThreadId = '';
    let createdCommentId = '';
    transport.requestJson.mockImplementation(async (options?: unknown) => {
      const request = options as { method?: string; path?: string; body?: Record<string, unknown> };
      if (request.method === 'POST' && request.path === '/api/comment/threads?fileId=doc-1') {
        createdThreadId = String(request.body?.threadId);
        createdCommentId = String(request.body?.commentId);
        expect(createdThreadId).toMatch(/^[a-f0-9]{32}$/);
        expect(createdCommentId).toMatch(/^[a-f0-9]{32}$/);
        expect(request.body).toEqual({
          threadId: createdThreadId,
          selectContent: '',
          commentContent: JSON.stringify({ text: 'Plain whole-doc comment\n' }),
          attachments: '[]',
          rootBlockId: 'doc-1',
          commentId: createdCommentId,
          blockIds: ['doc-1'],
          commentType: 2,
          fileId: 'doc-1',
        });
        return {
          thread: {
            threadId: createdThreadId,
            createdBy: 'user-1',
            threadStatus: 'open',
            selectContent: '',
            createAt: '1777452173752',
            modifyAt: '1777452173752',
            commentCount: '1',
            rootBlockId: 'doc-1',
            fileId: 'doc-1',
            newestCommentCreateAt: '1777452173752',
            resolveAt: '0',
            commentType: 2,
            blockIds: [],
          },
          comment: {
            commentId: createdCommentId,
            createdBy: 'user-1',
            content: JSON.stringify({ text: 'Plain whole-doc comment\n' }),
            parentComment: '',
            createAt: '1777452173752',
            modifyAt: '1777452173752',
            attachments: '',
            threadId: createdThreadId,
            isEdited: false,
            parentId: '',
          },
        };
      }
      if (request.path === '/api/page/doc-1/content?returnEncodedData=true&fileId=doc-1') {
        return encodeBlocks({ 'doc-1': { id: 'doc-1', type: 'BLOCK_TYPE_PAGE', version: 1, content: { title: 'Doc title' } } });
      }
      if (request.path === '/api/comment/discussions:batchGet?fileId=doc-1') {
        return {
          threads: [
            {
              thread: {
                threadId: createdThreadId,
                createdBy: 'user-1',
                threadStatus: 'open',
                selectContent: '',
                createAt: '1777452173752',
                modifyAt: '1777452173752',
                commentCount: '1',
                rootBlockId: 'doc-1',
                fileId: 'doc-1',
                newestCommentCreateAt: '1777452173752',
                resolveAt: '0',
                commentType: 2,
                blockIds: [],
              },
              comments: [
                {
                  comment: {
                    commentId: createdCommentId,
                    createdBy: 'user-1',
                    content: JSON.stringify({ text: 'Plain whole-doc comment\n' }),
                    parentComment: '',
                    createAt: '1777452173752',
                    modifyAt: '1777452173752',
                    attachments: '',
                    threadId: createdThreadId,
                    isEdited: false,
                    parentId: '',
                  },
                  reactions: [],
                },
              ],
            },
          ],
          users: { 'user-1': { userId: 'user-1', displayName: 'Owner', avatarUrl: '' } },
          nextCursor: '',
        };
      }
      return undefined;
    });

    const service = new ZoomDocsService(transport);
    const result = await service.addDocComment({ fileId: 'doc-1', text: 'Plain whole-doc comment\n' });

    expect(result).toMatchObject({
      ok: true,
      file_id: 'doc-1',
      thread_id: createdThreadId,
      comment_id: createdCommentId,
      text: 'Plain whole-doc comment\n',
      verified: true,
      comments: {
        threads: [
          {
            source: 'discussion',
            thread_id: createdThreadId,
            comment_type: 2,
            comments: [{ comment_id: createdCommentId, text: 'Plain whole-doc comment\n' }],
          },
        ],
      },
    });
  });

  it('returns a structured failure for unsupported high-level target locators', async () => {
    const transport = createMockTransport();
    const service = new ZoomDocsService(transport);

    const result = await service.editDoc({
      fileId: 'doc-1',
      target: { by: 'block_id', value: 'intro' } as never,
      operation: { type: 'replace_text', text: 'Updated' },
    });

    expect(result).toEqual({
      ok: false,
      error_code: 'UNSUPPORTED_TARGET',
      message: 'Unsupported edit target. Use exact_text, heading, or ref.',
    });
    expect(transport.requestJson).not.toHaveBeenCalled();
  });

  it('dry-runs a batch of text edits without mutating the doc', async () => {
    const transport = createMockTransport();
    transport.requestJson.mockResolvedValue(
      encodeBlocks({
        'doc-1': { id: 'doc-1', type: 'BLOCK_TYPE_PAGE', version: 1, content: { title: 'Doc title' } },
        intro: {
          id: 'intro',
          parentId: 'doc-1',
          type: 'BLOCK_TYPE_PARAGRAPH',
          seq: 'a1',
          version: 7,
          content: { title: 'Intro: old' },
        },
        summary: {
          id: 'summary',
          parentId: 'doc-1',
          type: 'BLOCK_TYPE_PARAGRAPH',
          seq: 'a2',
          version: 9,
          content: { title: 'Summary: old' },
        },
      })
    );

    const service = new ZoomDocsService(transport);
    const result = await service.editDocBatch({
      fileId: 'doc-1',
      dryRun: true,
      edits: [
        { target: { by: 'ref', value: 'doc/p1' }, operation: { type: 'replace_substring', old_text: 'old', new_text: 'new' } },
        { target: { by: 'ref', value: 'doc/p2' }, operation: { type: 'append_text', text: ' details' } },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      dry_run: true,
      file_id: 'doc-1',
      preserved_file_id: true,
      edit_count: 2,
      results: [
        {
          ok: true,
          dry_run: true,
          matched_block_id: 'intro',
          operation_type: 'replace_substring',
          before_text: 'Intro: old',
          after_text: 'Intro: new',
          previous_version: 7,
          new_version: 7,
        },
        {
          ok: true,
          dry_run: true,
          matched_block_id: 'summary',
          operation_type: 'append_text',
          before_text: 'Summary: old',
          after_text: 'Summary: old details',
          previous_version: 9,
          new_version: 9,
        },
      ],
      warnings: [],
    });
    expect(transport.requestJson).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'POST', path: '/api/block/transactions?fileId=doc-1' })
    );
  });

  it('refuses structural operations in mutating batches before applying anything', async () => {
    const transport = createMockTransport();
    transport.requestJson.mockResolvedValue(
      encodeBlocks({
        'doc-1': { id: 'doc-1', type: 'BLOCK_TYPE_PAGE', version: 1, content: { title: 'Doc title' } },
        heading: {
          id: 'heading',
          parentId: 'doc-1',
          type: 'BLOCK_TYPE_HEADING_2',
          seq: 'a1',
          version: 2,
          content: { title: 'Plan' },
        },
        paragraph: {
          id: 'paragraph',
          parentId: 'doc-1',
          type: 'BLOCK_TYPE_PARAGRAPH',
          seq: 'a2',
          version: 3,
          content: { title: 'Old paragraph' },
        },
      })
    );

    const service = new ZoomDocsService(transport);
    const result = await service.editDocBatch({
      fileId: 'doc-1',
      edits: [
        { target: { by: 'ref', value: 'h2:plan' }, operation: { type: 'replace_section', markdown: 'New paragraph' } },
      ],
    });

    expect(result).toMatchObject({
      ok: false,
      file_id: 'doc-1',
      error_code: 'UNSUPPORTED_OPERATION',
      failed_edit_index: 0,
      message: 'Batch edit 1 uses replace_section. Mutating batches currently support replace_text, append_text, and replace_substring only. Use zoomdocs_edit_doc for structural edits.',
    });
    expect(transport.requestJson).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'POST', path: '/api/block/transactions?fileId=doc-1' })
    );
  });

  it('refuses a mutating batch that would edit the same block twice before applying anything', async () => {
    const transport = createMockTransport();
    transport.requestJson.mockResolvedValue(
      encodeBlocks({
        'doc-1': { id: 'doc-1', type: 'BLOCK_TYPE_PAGE', version: 1, content: { title: 'Doc title' } },
        intro: {
          id: 'intro',
          parentId: 'doc-1',
          type: 'BLOCK_TYPE_PARAGRAPH',
          seq: 'a1',
          version: 7,
          content: { title: 'Intro: old' },
        },
      })
    );

    const service = new ZoomDocsService(transport);
    const result = await service.editDocBatch({
      fileId: 'doc-1',
      edits: [
        { target: { by: 'ref', value: 'doc/p1' }, operation: { type: 'replace_substring', old_text: 'old', new_text: 'new' } },
        { target: { by: 'ref', value: 'doc/p1' }, operation: { type: 'append_text', text: ' details' } },
      ],
    });

    expect(result).toMatchObject({
      ok: false,
      file_id: 'doc-1',
      error_code: 'UNSUPPORTED_OPERATION',
      failed_edit_index: 1,
      message: 'Batch edit 2 targets block intro, which is already targeted by batch edit 1. Combine those edits or run separate calls.',
    });
    expect(transport.requestJson).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'POST', path: '/api/block/transactions?fileId=doc-1' })
    );
  });

  it('applies a validated batch of text edits in order', async () => {
    const transport = createMockTransport();
    const initialBlocks = {
      'doc-1': { id: 'doc-1', type: 'BLOCK_TYPE_PAGE', version: 1, content: { title: 'Doc title' } },
      intro: {
        id: 'intro',
        parentId: 'doc-1',
        type: 'BLOCK_TYPE_PARAGRAPH',
        seq: 'a1',
        version: 7,
        content: { title: 'Intro: old' },
      },
      summary: {
        id: 'summary',
        parentId: 'doc-1',
        type: 'BLOCK_TYPE_PARAGRAPH',
        seq: 'a2',
        version: 9,
        content: { title: 'Summary: old' },
      },
    };
    const afterFirstBlocks = {
      ...initialBlocks,
      'doc-1': { ...initialBlocks['doc-1'], version: 2 },
      intro: { ...initialBlocks.intro, version: 8, content: { title: 'Intro: new' } },
    };
    const afterSecondBlocks = {
      ...afterFirstBlocks,
      'doc-1': { ...afterFirstBlocks['doc-1'], version: 3 },
      summary: { ...initialBlocks.summary, version: 10, content: { title: 'Summary: old details' } },
    };
    let contentReads = 0;
    transport.requestJson.mockImplementation(async (options?: unknown) => {
      const request = options as { path?: string };
      if (request.path === '/api/page/doc-1/content?returnEncodedData=true&fileId=doc-1') {
        contentReads += 1;
        if (contentReads <= 3) return encodeBlocks(initialBlocks);
        if (contentReads <= 5) return encodeBlocks(afterFirstBlocks);
        return encodeBlocks(afterSecondBlocks);
      }
      if (request.path === '/api/user/me') {
        return { user: { userId: 'user-1' }, account: { accountId: 'acct-1' } };
      }
      if (request.path === '/api/block/transactions?fileId=doc-1') {
        return {};
      }
      return undefined;
    });

    const service = new ZoomDocsService(transport);
    const result = await service.editDocBatch({
      fileId: 'doc-1',
      edits: [
        { target: { by: 'ref', value: 'doc/p1' }, operation: { type: 'replace_substring', old_text: 'old', new_text: 'new' } },
        { target: { by: 'ref', value: 'doc/p2' }, operation: { type: 'append_text', text: ' details' } },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      file_id: 'doc-1',
      preserved_file_id: true,
      edit_count: 2,
      results: [
        { ok: true, matched_block_id: 'intro', operation_type: 'replace_substring', before_text: 'Intro: old', after_text: 'Intro: new' },
        { ok: true, matched_block_id: 'summary', operation_type: 'append_text', before_text: 'Summary: old', after_text: 'Summary: old details' },
      ],
      warnings: [],
    });
    expect(transport.requestJson).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'POST', path: '/api/block/transactions?fileId=doc-1' })
    );
    const transactionCalls = transport.requestJson.mock.calls.filter(([options]) =>
      Boolean((options as { method?: string; path?: string } | undefined)?.method === 'POST' && (options as { path?: string } | undefined)?.path === '/api/block/transactions?fileId=doc-1')
    );
    expect(transactionCalls).toHaveLength(2);
  });

  it('dry-runs a substring replacement without mutating the doc', async () => {
    const transport = createMockTransport();
    transport.requestJson.mockResolvedValueOnce(
      encodeBlocks({
        'doc-1': { id: 'doc-1', type: 'BLOCK_TYPE_PAGE', version: 1, content: { title: 'Doc title' } },
        paragraph: {
          id: 'paragraph',
          parentId: 'doc-1',
          type: 'BLOCK_TYPE_PARAGRAPH',
          seq: 'a1',
          version: 7,
          content: { title: 'Pass threshold is 50 percent.' },
        },
      })
    );

    const service = new ZoomDocsService(transport);
    const result = await service.editDoc({
      fileId: 'doc-1',
      target: { by: 'ref', value: 'doc/p1' },
      operation: { type: 'replace_substring', old_text: '50 percent', new_text: '60 percent' },
      dryRun: true,
    });

    expect(result).toMatchObject({
      ok: true,
      dry_run: true,
      file_id: 'doc-1',
      matched_block_id: 'paragraph',
      operation_type: 'replace_substring',
      before_text: 'Pass threshold is 50 percent.',
      after_text: 'Pass threshold is 60 percent.',
      previous_version: 7,
      new_version: 7,
    });
    expect(transport.requestJson).toHaveBeenCalledTimes(1);
    expect(transport.requestJson).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'POST', path: '/api/block/transactions?fileId=doc-1' })
    );
  });

  it('dry-runs a section replacement without mutating the doc', async () => {
    const transport = createMockTransport();
    transport.requestJson.mockResolvedValueOnce(
      encodeBlocks({
        'doc-1': { id: 'doc-1', type: 'BLOCK_TYPE_PAGE', version: 1, content: { title: 'Doc title' } },
        heading: {
          id: 'heading',
          parentId: 'doc-1',
          type: 'BLOCK_TYPE_HEADING_2',
          seq: 'a1',
          version: 2,
          content: { title: 'Plan' },
        },
        first: {
          id: 'first',
          parentId: 'doc-1',
          type: 'BLOCK_TYPE_PARAGRAPH',
          seq: 'a2',
          version: 3,
          content: { title: 'Old paragraph' },
        },
        second: {
          id: 'second',
          parentId: 'doc-1',
          type: 'BLOCK_TYPE_BULLET',
          seq: 'a3',
          version: 4,
          content: { title: 'Old bullet' },
        },
      })
    );

    const service = new ZoomDocsService(transport);
    const result = await service.editDoc({
      fileId: 'doc-1',
      target: { by: 'ref', value: 'h2:plan' },
      operation: { type: 'replace_section', markdown: 'New paragraph\n- New bullet' },
      dryRun: true,
    });

    expect(result).toMatchObject({
      ok: true,
      dry_run: true,
      file_id: 'doc-1',
      matched_block_id: 'heading',
      operation_type: 'replace_section',
      before_markdown: 'Old paragraph\nOld bullet',
      after_markdown: 'New paragraph\n- New bullet',
      previous_version: 2,
      new_version: 2,
      inserted_block_count: 2,
      deleted_block_count: 2,
    });
    expect(transport.requestJson).toHaveBeenCalledTimes(1);
  });

  it('replaces a unique substring inside a ref-targeted block', async () => {
    const transport = createMockTransport();
    const initialBlocks = {
      'doc-1': { id: 'doc-1', type: 'BLOCK_TYPE_PAGE', version: 1, content: { title: 'Doc title' } },
      heading: {
        id: 'heading',
        parentId: 'doc-1',
        type: 'BLOCK_TYPE_HEADING_2',
        seq: 'a1',
        version: 2,
        content: { title: 'Plan' },
      },
      paragraph: {
        id: 'paragraph',
        parentId: 'doc-1',
        type: 'BLOCK_TYPE_PARAGRAPH',
        seq: 'a2',
        version: 7,
        content: { title: 'Pass threshold is 50 percent.' },
      },
    };
    const updatedBlocks = {
      ...initialBlocks,
      paragraph: {
        ...initialBlocks.paragraph,
        version: 8,
        content: { title: 'Pass threshold is 60 percent.' },
      },
    };
    let contentReads = 0;
    transport.requestJson.mockImplementation(async (options?: unknown) => {
      const request = options as { path?: string };
      if (request.path === '/api/page/doc-1/content?returnEncodedData=true&fileId=doc-1') {
        contentReads += 1;
        return contentReads === 1 ? encodeBlocks(initialBlocks) : encodeBlocks(updatedBlocks);
      }
      if (request.path === '/api/user/me') {
        return { user: { userId: 'user-1' }, account: { accountId: 'acct-1' } };
      }
      if (request.path === '/api/block/transactions?fileId=doc-1') {
        return {};
      }
      return undefined;
    });

    const service = new ZoomDocsService(transport);
    const result = await service.editDoc({
      fileId: 'doc-1',
      target: { by: 'ref', value: 'h2:plan/p1' },
      operation: { type: 'replace_substring', old_text: '50 percent', new_text: '60 percent' },
    });

    expect(result).toMatchObject({
      ok: true,
      matched_block_id: 'paragraph',
      before_text: 'Pass threshold is 50 percent.',
      after_text: 'Pass threshold is 60 percent.',
      operation_type: 'replace_substring',
    });
  });

  it('returns a structured failure when substring replacement has no match', async () => {
    const transport = createMockTransport();
    transport.requestJson.mockResolvedValueOnce(
      encodeBlocks({
        'doc-1': { id: 'doc-1', type: 'BLOCK_TYPE_PAGE', version: 1, content: { title: 'Doc title' } },
        paragraph: {
          id: 'paragraph',
          parentId: 'doc-1',
          type: 'BLOCK_TYPE_PARAGRAPH',
          seq: 'a1',
          version: 7,
          content: { title: 'Pass threshold is 50 percent.' },
        },
      })
    );

    const service = new ZoomDocsService(transport);
    const result = await service.editDoc({
      fileId: 'doc-1',
      target: { by: 'ref', value: 'doc/p1' },
      operation: { type: 'replace_substring', old_text: '70 percent', new_text: '80 percent' },
    });

    expect(result).toEqual({
      ok: false,
      error_code: 'NO_MATCH',
      message: 'Substring to replace was not found in the matched block.',
      candidates: [{ block_id: 'paragraph', block_type: 'BLOCK_TYPE_PARAGRAPH', text: 'Pass threshold is 50 percent.' }],
    });
  });

  it('returns a structured failure when substring replacement is ambiguous within a block', async () => {
    const transport = createMockTransport();
    transport.requestJson.mockResolvedValueOnce(
      encodeBlocks({
        'doc-1': { id: 'doc-1', type: 'BLOCK_TYPE_PAGE', version: 1, content: { title: 'Doc title' } },
        paragraph: {
          id: 'paragraph',
          parentId: 'doc-1',
          type: 'BLOCK_TYPE_PARAGRAPH',
          seq: 'a1',
          version: 7,
          content: { title: 'Repeat, repeat, repeat.' },
        },
      })
    );

    const service = new ZoomDocsService(transport);
    const result = await service.editDoc({
      fileId: 'doc-1',
      target: { by: 'ref', value: 'doc/p1' },
      operation: { type: 'replace_substring', old_text: 'repeat', new_text: 'word' },
    });

    expect(result).toEqual({
      ok: false,
      error_code: 'AMBIGUOUS_MATCH',
      message: 'Substring matched 2 times in the matched block. Make old_text unique before editing.',
      candidates: [{ block_id: 'paragraph', block_type: 'BLOCK_TYPE_PARAGRAPH', text: 'Repeat, repeat, repeat.' }],
    });
  });

  it('fails closed instead of substring-replacing inline-rich blocks with plain text', async () => {
    const transport = createMockTransport();
    transport.requestJson.mockResolvedValueOnce(
      encodeBlocks({
        'doc-1': { id: 'doc-1', type: 'BLOCK_TYPE_PAGE', version: 1, content: { title: 'Doc title' } },
        inlineRich: {
          id: 'inlineRich',
          parentId: 'doc-1',
          type: 'BLOCK_TYPE_PARAGRAPH',
          seq: 'a1',
          version: 3,
          content: {
            title: JSON.stringify([[0, 'Hello ', '26:"u"'], [0, { mention: { id: 'user-1' } }, ''], [0, ' again', '26:"u"']]),
          },
        },
      })
    );

    const service = new ZoomDocsService(transport);
    const result = await service.editDoc({
      fileId: 'doc-1',
      target: { by: 'ref', value: 'doc/p1' },
      operation: { type: 'replace_substring', old_text: 'Hello', new_text: 'Hi' },
    });

    expect(result).toEqual({
      ok: false,
      error_code: 'INLINE_CONTENT_RISK',
      message: 'Refusing to replace a substring in this block because it contains inline annotations or objects that plain text replacement would remove.',
      candidates: [{ block_id: 'inlineRich', block_type: 'BLOCK_TYPE_PARAGRAPH', text: 'Hello  again' }],
    });
  });

  it('retries post-write verification while Zoom Docs content reads are stale', async () => {
    const transport = createMockTransport();
    const initialBlocks = {
      'doc-1': { id: 'doc-1', type: 'BLOCK_TYPE_PAGE', version: 1, content: { title: 'Doc title' } },
      intro: {
        id: 'intro',
        parentId: 'doc-1',
        type: 'BLOCK_TYPE_PARAGRAPH',
        seq: 'a1',
        version: 7,
        content: { title: '' },
      },
    };
    const updatedBlocks = {
      ...initialBlocks,
      intro: {
        ...initialBlocks.intro,
        version: 8,
        content: { title: 'Updated after lag' },
      },
    };
    let contentReads = 0;
    transport.requestJson.mockImplementation(async (options?: unknown) => {
      const request = options as { path?: string };
      if (request.path === '/api/page/doc-1/content?returnEncodedData=true&fileId=doc-1') {
        contentReads += 1;
        return contentReads <= 2 ? encodeBlocks(initialBlocks) : encodeBlocks(updatedBlocks);
      }
      if (request.path === '/api/user/me') {
        return { user: { userId: 'user-1' }, account: { accountId: 'acct-1' } };
      }
      if (request.path === '/api/block/transactions?fileId=doc-1') {
        return {};
      }
      return undefined;
    });

    const service = new ZoomDocsService(transport);
    const result = await service.editDoc({
      fileId: 'doc-1',
      target: { by: 'exact_text', value: '' },
      operation: { type: 'replace_text', text: 'Updated after lag' },
    });

    expect(result).toMatchObject({
      ok: true,
      matched_block_id: 'intro',
      after_text: 'Updated after lag',
      new_version: 8,
    });
    expect(contentReads).toBeGreaterThanOrEqual(3);
  });

  it('returns structured candidates when exact text is ambiguous', async () => {
    const transport = createMockTransport();
    transport.requestJson.mockResolvedValueOnce(
      encodeBlocks({
        'doc-1': { id: 'doc-1', type: 'BLOCK_TYPE_PAGE', version: 1, content: { title: 'Doc title' } },
        first: {
          id: 'first',
          parentId: 'doc-1',
          type: 'BLOCK_TYPE_PARAGRAPH',
          seq: 'a1',
          version: 3,
          content: { title: 'Repeated paragraph' },
        },
        second: {
          id: 'second',
          parentId: 'doc-1',
          type: 'BLOCK_TYPE_PARAGRAPH',
          seq: 'a2',
          version: 4,
          content: { title: 'Repeated paragraph' },
        },
      })
    );

    const service = new ZoomDocsService(transport);
    const result = await service.editDoc({
      fileId: 'doc-1',
      target: { by: 'exact_text', value: 'Repeated paragraph' },
      operation: { type: 'replace_text', text: 'Updated' },
    });

    expect(result).toEqual({
      ok: false,
      error_code: 'AMBIGUOUS_MATCH',
      message: 'Target matched 2 editable blocks. Add within_heading or make the target text unique.',
      candidates: [
        { block_id: 'first', block_type: 'BLOCK_TYPE_PARAGRAPH', text: 'Repeated paragraph' },
        { block_id: 'second', block_type: 'BLOCK_TYPE_PARAGRAPH', text: 'Repeated paragraph' },
      ],
    });
    expect(transport.requestJson).toHaveBeenCalledTimes(1);
  });

  it('uses within_heading to disambiguate exact-text matches without exposing block ids', async () => {
    const transport = createMockTransport();
    const initialBlocks = {
      'doc-1': { id: 'doc-1', type: 'BLOCK_TYPE_PAGE', version: 1, content: { title: 'Doc title' } },
      introHeading: {
        id: 'introHeading',
        parentId: 'doc-1',
        type: 'BLOCK_TYPE_HEADING_1',
        seq: 'a1',
        version: 2,
        content: { title: 'Intro' },
      },
      introParagraph: {
        id: 'introParagraph',
        parentId: 'doc-1',
        type: 'BLOCK_TYPE_PARAGRAPH',
        seq: 'a2',
        version: 3,
        content: { title: 'Same text' },
      },
      conclusionHeading: {
        id: 'conclusionHeading',
        parentId: 'doc-1',
        type: 'BLOCK_TYPE_HEADING_1',
        seq: 'a3',
        version: 4,
        content: { title: 'Conclusion' },
      },
      conclusionParagraph: {
        id: 'conclusionParagraph',
        parentId: 'doc-1',
        type: 'BLOCK_TYPE_PARAGRAPH',
        seq: 'a4',
        version: 5,
        content: { title: 'Same text' },
      },
    };
    const updatedBlocks = {
      ...initialBlocks,
      conclusionParagraph: {
        ...initialBlocks.conclusionParagraph,
        version: 6,
        content: { title: 'Same text appended' },
      },
    };
    let contentReads = 0;
    transport.requestJson.mockImplementation(async (options?: unknown) => {
      const request = options as { path?: string };
      if (request.path === '/api/page/doc-1/content?returnEncodedData=true&fileId=doc-1') {
        contentReads += 1;
        return contentReads === 1 ? encodeBlocks(initialBlocks) : encodeBlocks(updatedBlocks);
      }
      if (request.path === '/api/user/me') {
        return { user: { userId: 'user-1' }, account: { accountId: 'acct-1' } };
      }
      if (request.path === '/api/block/transactions?fileId=doc-1') {
        return {};
      }
      return undefined;
    });

    const service = new ZoomDocsService(transport);
    const result = await service.editDoc({
      fileId: 'doc-1',
      target: { by: 'exact_text', value: 'Same text', within_heading: 'Conclusion' },
      operation: { type: 'append_text', text: ' appended' },
    });

    expect(result).toMatchObject({
      ok: true,
      matched_block_id: 'conclusionParagraph',
      matched_heading: 'Conclusion',
      before_text: 'Same text',
      after_text: 'Same text appended',
    });
  });

  it('fails closed instead of replacing blocks with existing inline comment markers', async () => {
    const transport = createMockTransport();
    transport.requestJson.mockResolvedValueOnce(
      encodeBlocks({
        'doc-1': { id: 'doc-1', type: 'BLOCK_TYPE_PAGE', version: 1, content: { title: 'Doc title' } },
        commented: {
          id: 'commented',
          parentId: 'doc-1',
          type: 'BLOCK_TYPE_PARAGRAPH',
          seq: 'a1',
          version: 3,
          content: {
            title: JSON.stringify([[0, 'Commented text', '26:"user-1"|8:1|thread-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:true']]),
          },
        },
      })
    );

    const service = new ZoomDocsService(transport);
    const result = await service.editDoc({
      fileId: 'doc-1',
      target: { by: 'exact_text', value: 'Commented text' },
      operation: { type: 'replace_text', text: 'Replacement text' },
    });

    expect(result).toEqual({
      ok: false,
      error_code: 'INLINE_CONTENT_RISK',
      message: 'Refusing to replace this block because it contains inline annotations or objects that plain text replacement would remove.',
      candidates: [{ block_id: 'commented', block_type: 'BLOCK_TYPE_PARAGRAPH', text: 'Commented text' }],
    });
    expect(transport.requestJson).toHaveBeenCalledTimes(1);
  });

  it('fails closed instead of replacing inline-rich blocks with plain text', async () => {
    const transport = createMockTransport();
    transport.requestJson.mockResolvedValueOnce(
      encodeBlocks({
        'doc-1': { id: 'doc-1', type: 'BLOCK_TYPE_PAGE', version: 1, content: { title: 'Doc title' } },
        inlineRich: {
          id: 'inlineRich',
          parentId: 'doc-1',
          type: 'BLOCK_TYPE_PARAGRAPH',
          seq: 'a1',
          version: 3,
          content: {
            title: JSON.stringify([[0, 'Hello ', '26:"u"'], [0, { mention: { id: 'user-1' } }, ''], [0, '!', '26:"u"']]),
          },
        },
      })
    );

    const service = new ZoomDocsService(transport);
    const result = await service.editDoc({
      fileId: 'doc-1',
      target: { by: 'exact_text', value: 'Hello !' },
      operation: { type: 'replace_text', text: 'Hello Joan!' },
    });

    expect(result).toEqual({
      ok: false,
      error_code: 'INLINE_CONTENT_RISK',
      message: 'Refusing to replace this block because it contains inline annotations or objects that plain text replacement would remove.',
      candidates: [{ block_id: 'inlineRich', block_type: 'BLOCK_TYPE_PARAGRAPH', text: 'Hello !' }],
    });
    expect(transport.requestJson).toHaveBeenCalledTimes(1);
  });

  it('inserts safe markdown blocks after a matched heading in the same doc', async () => {
    const transport = createMockTransport();
    const initialBlocks = {
      'doc-1': { id: 'doc-1', type: 'BLOCK_TYPE_PAGE', version: 10, content: { title: 'Doc title' } },
      risksHeading: {
        id: 'risksHeading',
        parentId: 'doc-1',
        type: 'BLOCK_TYPE_HEADING1',
        seq: 'a1',
        version: 2,
        content: { title: 'Risks' },
      },
      existingRisk: {
        id: 'existingRisk',
        parentId: 'doc-1',
        type: 'BLOCK_TYPE_PARAGRAPH',
        seq: 'a2',
        version: 3,
        content: { title: 'Existing risk' },
      },
    };
    let contentReads = 0;
    let createdOps: Array<{ blockId: string; args: { type: string; afterBlockId?: string; content?: { title?: string }; style?: unknown } }> = [];
    transport.requestJson.mockImplementation(async (options?: unknown) => {
      const request = options as { path?: string; body?: { transactions?: Array<{ ops?: unknown[] }> } };
      if (request.path === '/api/page/doc-1/content?returnEncodedData=true&fileId=doc-1') {
        contentReads += 1;
        if (contentReads === 1) return encodeBlocks(initialBlocks);
        return encodeBlocks({
          ...initialBlocks,
          [createdOps[0]!.blockId]: {
            id: createdOps[0]!.blockId,
            parentId: 'doc-1',
            type: createdOps[0]!.args.type,
            seq: 'a1.1',
            version: 1,
            content: createdOps[0]!.args.content,
          },
          [createdOps[1]!.blockId]: {
            id: createdOps[1]!.blockId,
            parentId: 'doc-1',
            type: createdOps[1]!.args.type,
            seq: 'a1.2',
            version: 1,
            content: createdOps[1]!.args.content,
            style: createdOps[1]!.args.style as Record<string, unknown>,
          },
        });
      }
      if (request.path === '/api/user/me') {
        return { user: { userId: 'user-1' }, account: { accountId: 'acct-1' } };
      }
      if (request.path === '/api/block/transactions?fileId=doc-1') {
        createdOps = (request.body?.transactions?.[0]?.ops ?? []) as typeof createdOps;
        return {};
      }
      return undefined;
    });

    const service = new ZoomDocsService(transport);
    const result = await service.editDoc({
      fileId: 'doc-1',
      target: { by: 'heading', value: 'Risks' },
      operation: { type: 'insert_after', markdown: '- New risk\n- [ ] Follow up' },
    });

    expect(result).toMatchObject({
      ok: true,
      file_id: 'doc-1',
      preserved_file_id: true,
      matched_block_id: 'risksHeading',
      operation_type: 'insert_after',
      inserted_block_count: 2,
      deleted_block_count: 0,
    });
    expect(createdOps).toHaveLength(2);
    expect(createdOps[0]).toMatchObject({
      command: 'COMMAND_TYPE_CREATE',
      blockId: expect.any(String),
      args: {
        type: 'BLOCK_TYPE_BULLET',
        parentBlockId: 'doc-1',
        afterBlockId: 'risksHeading',
      },
    });
    expect(createdOps[1]).toMatchObject({
      command: 'COMMAND_TYPE_CREATE',
      blockId: expect.any(String),
      args: {
        type: 'BLOCK_TYPE_TODO_LIST',
        parentBlockId: 'doc-1',
        afterBlockId: createdOps[0]!.blockId,
        style: { checked: false },
      },
    });
  });

  it('replaces the safe content under a heading with new blocks', async () => {
    const transport = createMockTransport();
    const initialBlocks = {
      'doc-1': { id: 'doc-1', type: 'BLOCK_TYPE_PAGE', version: 20, content: { title: 'Doc title' } },
      statusHeading: {
        id: 'statusHeading',
        parentId: 'doc-1',
        type: 'BLOCK_TYPE_HEADING1',
        seq: 'a1',
        version: 2,
        content: { title: 'Status' },
      },
      oldOne: {
        id: 'oldOne',
        parentId: 'doc-1',
        type: 'BLOCK_TYPE_PARAGRAPH',
        seq: 'a2',
        version: 3,
        content: { title: 'Old one' },
      },
      oldTwo: {
        id: 'oldTwo',
        parentId: 'doc-1',
        type: 'BLOCK_TYPE_BULLET',
        seq: 'a3',
        version: 4,
        content: { title: 'Old two' },
      },
      nextHeading: {
        id: 'nextHeading',
        parentId: 'doc-1',
        type: 'BLOCK_TYPE_HEADING1',
        seq: 'a4',
        version: 5,
        content: { title: 'Next' },
      },
    };
    let contentReads = 0;
    let ops: Array<{ command: string; blockId: string; args?: { type?: string; content?: { title?: string }; afterBlockId?: string } }> = [];
    transport.requestJson.mockImplementation(async (options?: unknown) => {
      const request = options as { path?: string; body?: { transactions?: Array<{ ops?: unknown[] }> } };
      if (request.path === '/api/page/doc-1/content?returnEncodedData=true&fileId=doc-1') {
        contentReads += 1;
        if (contentReads === 1) return encodeBlocks(initialBlocks);
        const creates = ops.filter((op) => op.command === 'COMMAND_TYPE_CREATE');
        return encodeBlocks({
          'doc-1': initialBlocks['doc-1'],
          statusHeading: initialBlocks.statusHeading,
          [creates[0]!.blockId]: {
            id: creates[0]!.blockId,
            parentId: 'doc-1',
            type: creates[0]!.args!.type,
            seq: 'a1.1',
            version: 1,
            content: creates[0]!.args!.content,
          },
          [creates[1]!.blockId]: {
            id: creates[1]!.blockId,
            parentId: 'doc-1',
            type: creates[1]!.args!.type,
            seq: 'a1.2',
            version: 1,
            content: creates[1]!.args!.content,
          },
          nextHeading: initialBlocks.nextHeading,
        });
      }
      if (request.path === '/api/user/me') {
        return { user: { userId: 'user-1' }, account: { accountId: 'acct-1' } };
      }
      if (request.path === '/api/block/transactions?fileId=doc-1') {
        ops = (request.body?.transactions?.[0]?.ops ?? []) as typeof ops;
        return {};
      }
      return undefined;
    });

    const service = new ZoomDocsService(transport);
    const result = await service.editDoc({
      fileId: 'doc-1',
      target: { by: 'heading', value: 'Status' },
      operation: { type: 'replace_section', markdown: 'New status\n- New bullet' },
    });

    expect(result).toMatchObject({
      ok: true,
      operation_type: 'replace_section',
      matched_block_id: 'statusHeading',
      inserted_block_count: 2,
      deleted_block_count: 2,
      deleted_block_ids: ['oldTwo', 'oldOne'],
    });
    expect(ops.map((op) => op.command)).toEqual([
      'COMMAND_TYPE_DELETE',
      'COMMAND_TYPE_DELETE',
      'COMMAND_TYPE_CREATE',
      'COMMAND_TYPE_CREATE',
    ]);
    expect(ops.slice(0, 2).map((op) => op.blockId)).toEqual(['oldTwo', 'oldOne']);
    expect(ops[2]).toMatchObject({
      command: 'COMMAND_TYPE_CREATE',
      args: { type: 'BLOCK_TYPE_PARAGRAPH', parentBlockId: 'doc-1', afterBlockId: 'statusHeading' },
    });
    expect(ops[3]).toMatchObject({
      command: 'COMMAND_TYPE_CREATE',
      args: { type: 'BLOCK_TYPE_BULLET', parentBlockId: 'doc-1', afterBlockId: ops[2]!.blockId },
    });
  });

  it('fails closed when replacing a section would delete attachment-heavy blocks', async () => {
    const transport = createMockTransport();
    transport.requestJson.mockResolvedValueOnce(
      encodeBlocks({
        'doc-1': { id: 'doc-1', type: 'BLOCK_TYPE_PAGE', version: 1, content: { title: 'Doc title' } },
        heading: {
          id: 'heading',
          parentId: 'doc-1',
          type: 'BLOCK_TYPE_HEADING1',
          seq: 'a1',
          version: 2,
          content: { title: 'Assets' },
        },
        image: {
          id: 'image',
          parentId: 'doc-1',
          type: 'BLOCK_TYPE_IMAGE',
          seq: 'a2',
          version: 3,
          content: { title: JSON.stringify([[0, { attachment: { attachmentId: 'att-1' } }, '']]) },
        },
      })
    );

    const service = new ZoomDocsService(transport);
    const result = await service.editDoc({
      fileId: 'doc-1',
      target: { by: 'heading', value: 'Assets' },
      operation: { type: 'replace_section', markdown: 'Plain text' },
    });

    expect(result).toEqual({
      ok: false,
      error_code: 'INLINE_CONTENT_RISK',
      message: 'Refusing to replace this section because it contains blocks with inline annotations/objects or unsupported structures.',
      candidates: [{ block_id: 'image', block_type: 'BLOCK_TYPE_IMAGE', text: '', heading: 'Assets' }],
    });
    expect(transport.requestJson).toHaveBeenCalledTimes(1);
  });

  it('renames a heading through the high-level edit tool', async () => {
    const transport = createMockTransport();
    const initialBlocks = {
      'doc-1': { id: 'doc-1', type: 'BLOCK_TYPE_PAGE', version: 1, content: { title: 'Doc title' } },
      heading: {
        id: 'heading',
        parentId: 'doc-1',
        type: 'BLOCK_TYPE_HEADING_2',
        seq: 'a1',
        version: 5,
        content: { title: 'Old heading' },
      },
    };
    const updatedBlocks = {
      ...initialBlocks,
      heading: {
        ...initialBlocks.heading,
        version: 9,
        content: { title: 'New heading' },
      },
    };
    let contentReads = 0;
    transport.requestJson.mockImplementation(async (options?: unknown) => {
      const request = options as { path?: string };
      if (request.path === '/api/page/doc-1/content?returnEncodedData=true&fileId=doc-1') {
        contentReads += 1;
        return contentReads === 1 ? encodeBlocks(initialBlocks) : encodeBlocks(updatedBlocks);
      }
      if (request.path === '/api/user/me') {
        return { user: { userId: 'user-1' }, account: { accountId: 'acct-1' } };
      }
      if (request.path === '/api/block/transactions?fileId=doc-1') {
        return {};
      }
      return undefined;
    });

    const service = new ZoomDocsService(transport);
    const result = await service.editDoc({
      fileId: 'doc-1',
      target: { by: 'heading', value: 'Old heading' },
      operation: { type: 'replace_text', text: 'New heading' },
    });

    expect(result).toMatchObject({
      ok: true,
      matched_block_id: 'heading',
      matched_block_type: 'BLOCK_TYPE_HEADING_2',
      before_text: 'Old heading',
      after_text: 'New heading',
    });
  });

  it('searches share targets through Zoom Docs contact search', async () => {
    const transport = createMockTransport();
    transport.requestJson.mockResolvedValueOnce({
      users: [
        {
          userId: 'user-1',
          accountId: 'acct-1',
          displayName: 'Alvaro Example',
          email: 'alvaro@example.test',
          avatarUrl: 'https://example.test/avatar.png',
          locale: 'en-US',
        },
      ],
      channels: [
        {
          channelId: 'channel-1',
          name: 'Test Channel',
          channelType: 'channel',
          channelIconType: 'privateChannel',
          memberCount: 3,
        },
      ],
    });

    const service = new ZoomDocsService(transport);
    const result = await service.searchShareTargets({ query: ' alv ' });

    expect(result).toEqual({
      query: 'alv',
      users: [
        {
          user_id: 'user-1',
          account_id: 'acct-1',
          display_name: 'Alvaro Example',
          email: 'alvaro@example.test',
          avatar_url: 'https://example.test/avatar.png',
        },
      ],
      channels: [
        {
          channel_id: 'channel-1',
          name: 'Test Channel',
          channel_type: 'channel',
          channel_icon_type: 'privateChannel',
          member_count: 3,
        },
      ],
    });
    expect(transport.requestJson).toHaveBeenCalledWith({
      method: 'POST',
      path: '/api/user/contact',
      body: { keyword: 'alv' },
    });
  });

  it('rejects blank share target searches', async () => {
    const transport = createMockTransport();
    const service = new ZoomDocsService(transport);

    await expect(service.searchShareTargets({ query: '   ' })).rejects.toThrow(/query is required/);
    expect(transport.requestJson).not.toHaveBeenCalled();
  });

  it('fetches access info from Zoom Docs sharing and permission endpoints', async () => {
    const transport = createMockTransport();
    transport.requestJson.mockImplementation(async (options?: unknown) => {
      const request = options as { path?: string };

      if (request.path === '/api/file/files/action/batch_get') {
        return {
          successItems: [
            {
              id: 'doc-1',
              title: 'Permissions doc',
              privilege: {
                role: { role: 'owner', newRole: 'owner' },
                linkAccess: {
                  settingItem: 'accountPermissionSetting',
                  role: { role: 'viewer', newRole: 'viewer' },
                },
              },
            },
          ],
        };
      }

      if (request.path === '/api/file/files/doc-1/share_status') return { isShared: true };
      if (request.path === '/api/file/files/doc-1/publish') {
        return { setting: { publishStatus: 'unpublish' } };
      }
      if (request.path === '/api/file/files/doc-1/permission_request?limit=50') {
        return { requests: [], nextPagingToken: '' };
      }
      if (request.path === '/api/file/files/doc-1/ancestors/permission?flattenInherit=true') {
        return {
          ancestorPermissionInfos: [
            {
              id: 'doc-1',
              fileType: 'doc',
              permissionInfo: {
                collaborators: [
                  { user: { id: 'user-1', displayName: 'Owner' }, role: { role: 'owner', newRole: 'owner' } },
                ],
                currentLinkAccess: {
                  settingItem: 'accountPermissionSetting',
                  role: { role: 'viewer', newRole: 'viewer' },
                },
              },
              canSeeCollaborators: true,
            },
          ],
        };
      }

      return {};
    });

    const service = new ZoomDocsService(transport);
    const result = await service.getAccessInfo({ fileId: 'https://docs.zoom.us/doc/doc-1' });

    expect(result).toMatchObject({
      file_id: 'doc-1',
      file: { id: 'doc-1', title: 'Permissions doc' },
      share_status: { isShared: true },
      publish: { setting: { publishStatus: 'unpublish' } },
      permission_requests: { requests: [], nextPagingToken: '' },
      permission_info: {
        currentLinkAccess: {
          settingItem: 'accountPermissionSetting',
          role: { role: 'viewer', newRole: 'viewer' },
        },
      },
    });
    expect(transport.requestJson).toHaveBeenCalledWith({
      method: 'GET',
      path: '/api/file/files/doc-1/ancestors/permission?flattenInherit=true',
      fileId: 'doc-1',
    });
  });

  it('patches permission access and verifies the read-back state', async () => {
    const transport = createMockTransport();
    transport.requestJson.mockImplementation(async (options?: unknown) => {
      const request = options as { method?: string; path?: string };
      if (request.method === 'PATCH' && request.path === '/api/file/files/doc-1/permission') return {};
      if (request.path === '/api/file/files/action/batch_get') return { successItems: [{ id: 'doc-1' }] };
      if (request.path === '/api/file/files/doc-1/share_status') return { isShared: true };
      if (request.path === '/api/file/files/doc-1/publish') return { setting: { publishStatus: 'unpublish' } };
      if (request.path === '/api/file/files/doc-1/permission_request?limit=50') return { requests: [] };
      if (request.path === '/api/file/files/doc-1/ancestors/permission?flattenInherit=true') {
        return {
          ancestorPermissionInfos: [
            {
              id: 'doc-1',
              permissionInfo: {
                currentLinkAccess: {
                  settingItem: 'linkPermissionSetting',
                  role: { role: 'commenter', newRole: 'commenter' },
                },
              },
            },
          ],
        };
      }
      return {};
    });

    const service = new ZoomDocsService(transport);
    const result = await service.setPermissionAccess({
      fileId: 'doc-1',
      scope: 'anyone_with_link',
      role: 'commenter',
    });

    expect(transport.requestJson).toHaveBeenCalledWith({
      method: 'PATCH',
      path: '/api/file/files/doc-1/permission',
      body: {
        id: 'doc-1',
        permissionSetting: {
          settingItem: 'linkPermissionSetting',
          role: { role: 'commenter', newRole: 'commenter' },
        },
        propagatePermissionChanges: true,
      },
      fileId: 'doc-1',
    });
    expect(result).toMatchObject({
      ok: true,
      file_id: 'doc-1',
      scope: 'anyone_with_link',
      role: 'commenter',
      setting_item: 'linkPermissionSetting',
    });
  });

  it('returns a structured failure when permission access read-back does not match', async () => {
    const transport = createMockTransport();
    transport.requestJson.mockImplementation(async (options?: unknown) => {
      const request = options as { method?: string; path?: string };
      if (request.method === 'PATCH') return {};
      if (request.path === '/api/file/files/action/batch_get') return { successItems: [{ id: 'doc-1' }] };
      if (request.path === '/api/file/files/doc-1/share_status') return { isShared: true };
      if (request.path === '/api/file/files/doc-1/publish') return { setting: { publishStatus: 'unpublish' } };
      if (request.path === '/api/file/files/doc-1/permission_request?limit=50') return { requests: [] };
      if (request.path === '/api/file/files/doc-1/ancestors/permission?flattenInherit=true') {
        return {
          ancestorPermissionInfos: [
            {
              id: 'doc-1',
              permissionInfo: {
                currentLinkAccess: {
                  settingItem: 'accountPermissionSetting',
                  role: { role: 'viewer', newRole: 'viewer' },
                },
              },
            },
          ],
        };
      }
      return {};
    });

    const service = new ZoomDocsService(transport);
    await expect(
      service.setPermissionAccess({ fileId: 'doc-1', scope: 'anyone_with_link', role: 'commenter' })
    ).resolves.toMatchObject({
      ok: false,
      error_code: 'VERIFICATION_FAILED',
      expected: { setting_item: 'linkPermissionSetting', role: 'commenter' },
      actual: { setting_item: 'accountPermissionSetting', role: 'viewer' },
    });
  });

  it('adds a user collaborator and verifies the collaborator read-back state', async () => {
    const transport = createMockTransport();
    let collaboratorAdded = false;
    transport.requestJson.mockImplementation(async (options?: unknown) => {
      const request = options as { method?: string; path?: string };
      if (request.method === 'POST' && request.path === '/api/file/files/doc-1/collaborators') {
        collaboratorAdded = true;
        return { successList: [{ user: { id: 'user-1' }, role: { role: 'commenter', newRole: 'commenter' } }], failedList: [] };
      }
      if (request.path === '/api/file/files/action/batch_get') return { successItems: [{ id: 'doc-1' }] };
      if (request.path === '/api/file/files/doc-1/share_status') return { isShared: false };
      if (request.path === '/api/file/files/doc-1/publish') return { setting: { publishStatus: 'unpublish' } };
      if (request.path === '/api/file/files/doc-1/permission_request?limit=50') return { requests: [] };
      if (request.path === '/api/file/files/doc-1/ancestors/permission?flattenInherit=true') {
        return {
          ancestorPermissionInfos: [
            {
              id: 'doc-1',
              permissionInfo: {
                collaborators: [
                  { user: { id: 'owner-1' }, role: { role: 'owner', newRole: 'owner' } },
                  ...(collaboratorAdded
                    ? [{ user: { id: 'user-1' }, role: { role: 'commenter', newRole: 'commenter' } }]
                    : []),
                ],
              },
            },
          ],
        };
      }
      return {};
    });

    const service = new ZoomDocsService(transport);
    const result = await service.addUserCollaborator({
      fileId: 'doc-1',
      userId: 'user-1',
      role: 'commenter',
      sendEmail: false,
      sendChatMessage: false,
    });

    expect(transport.requestJson).toHaveBeenCalledWith({
      method: 'POST',
      path: '/api/file/files/doc-1/collaborators',
      body: {
        id: 'doc-1',
        collaboratorInfo: [
          {
            collaboratorId: { userId: 'user-1' },
            role: { role: 'commenter', newRole: 'commenter' },
          },
        ],
        sendEmail: false,
        allowDowngrade: true,
        sendChatMessage: false,
      },
      fileId: 'doc-1',
    });
    expect(result).toMatchObject({
      ok: true,
      file_id: 'doc-1',
      user_id: 'user-1',
      role: 'commenter',
    });
  });

  it('changes a user collaborator role and verifies the collaborator read-back state', async () => {
    const transport = createMockTransport();
    let collaboratorRole = 'viewer';
    transport.requestJson.mockImplementation(async (options?: unknown) => {
      const request = options as { method?: string; path?: string };
      if (request.method === 'PATCH' && request.path === '/api/file/files/doc-1/collaborators') {
        collaboratorRole = 'editor';
        return {};
      }
      if (request.path === '/api/file/files/action/batch_get') return { successItems: [{ id: 'doc-1' }] };
      if (request.path === '/api/file/files/doc-1/share_status') return { isShared: false };
      if (request.path === '/api/file/files/doc-1/publish') return { setting: { publishStatus: 'unpublish' } };
      if (request.path === '/api/file/files/doc-1/permission_request?limit=50') return { requests: [] };
      if (request.path === '/api/file/files/doc-1/ancestors/permission?flattenInherit=true') {
        return {
          ancestorPermissionInfos: [
            {
              id: 'doc-1',
              permissionInfo: {
                collaborators: [
                  { user: { id: 'owner-1' }, role: { role: 'owner', newRole: 'owner' } },
                  { user: { id: 'user-1' }, role: { role: collaboratorRole, newRole: collaboratorRole } },
                ],
              },
            },
          ],
        };
      }
      return {};
    });

    const service = new ZoomDocsService(transport);
    const result = await service.setUserCollaboratorRole({ fileId: 'doc-1', userId: 'user-1', role: 'editor' });

    expect(transport.requestJson).toHaveBeenCalledWith({
      method: 'PATCH',
      path: '/api/file/files/doc-1/collaborators',
      body: {
        id: 'doc-1',
        collaboratorInfo: {
          collaboratorId: { userId: 'user-1' },
          role: { role: 'editor', newRole: 'editor' },
          isEmailInvitee: false,
        },
        propagatePermissionChanges: true,
      },
      fileId: 'doc-1',
    });
    expect(result).toMatchObject({
      ok: true,
      file_id: 'doc-1',
      user_id: 'user-1',
      role: 'editor',
    });
  });

  it('returns a structured failure when changing a user collaborator role does not verify', async () => {
    const transport = createMockTransport();
    transport.requestJson.mockImplementation(async (options?: unknown) => {
      const request = options as { path?: string };
      if (request.path === '/api/file/files/action/batch_get') return { successItems: [{ id: 'doc-1' }] };
      if (request.path === '/api/file/files/doc-1/share_status') return { isShared: false };
      if (request.path === '/api/file/files/doc-1/publish') return { setting: { publishStatus: 'unpublish' } };
      if (request.path === '/api/file/files/doc-1/permission_request?limit=50') return { requests: [] };
      if (request.path === '/api/file/files/doc-1/ancestors/permission?flattenInherit=true') {
        return {
          ancestorPermissionInfos: [
            {
              id: 'doc-1',
              permissionInfo: {
                collaborators: [
                  { user: { id: 'owner-1' }, role: { role: 'owner' } },
                  { user: { id: 'user-1' }, role: { role: 'viewer' } },
                ],
              },
            },
          ],
        };
      }
      return {};
    });

    const service = new ZoomDocsService(transport);
    await expect(service.setUserCollaboratorRole({ fileId: 'doc-1', userId: 'user-1', role: 'editor' })).resolves.toMatchObject({
      ok: false,
      error_code: 'VERIFICATION_FAILED',
      file_id: 'doc-1',
      user_id: 'user-1',
      expected: { role: 'editor' },
      actual: { present: true, role: 'viewer' },
    });
  });

  it('removes a user collaborator and verifies the collaborator is absent', async () => {
    const transport = createMockTransport();
    let collaboratorPresent = true;
    transport.requestJson.mockImplementation(async (options?: unknown) => {
      const request = options as { method?: string; path?: string };
      if (request.method === 'POST' && request.path === '/api/file/files/doc-1/collaborators/action/remove') {
        collaboratorPresent = false;
        return {};
      }
      if (request.path === '/api/file/files/action/batch_get') return { successItems: [{ id: 'doc-1' }] };
      if (request.path === '/api/file/files/doc-1/share_status') return { isShared: false };
      if (request.path === '/api/file/files/doc-1/publish') return { setting: { publishStatus: 'unpublish' } };
      if (request.path === '/api/file/files/doc-1/permission_request?limit=50') return { requests: [] };
      if (request.path === '/api/file/files/doc-1/ancestors/permission?flattenInherit=true') {
        return {
          ancestorPermissionInfos: [
            {
              id: 'doc-1',
              permissionInfo: {
                collaborators: [
                  { user: { id: 'owner-1' }, role: { role: 'owner', newRole: 'owner' } },
                  ...(collaboratorPresent
                    ? [{ user: { id: 'user-1' }, role: { role: 'viewer', newRole: 'viewer' } }]
                    : []),
                ],
              },
            },
          ],
        };
      }
      return {};
    });

    const service = new ZoomDocsService(transport);
    const result = await service.removeUserCollaborator({ fileId: 'doc-1', userId: 'user-1' });

    expect(transport.requestJson).toHaveBeenCalledWith({
      method: 'POST',
      path: '/api/file/files/doc-1/collaborators/action/remove',
      body: {
        id: 'doc-1',
        collaboratorIds: [{ userId: 'user-1' }],
        targets: [{ collaboratorId: { userId: 'user-1' }, isEmailInvitee: false }],
        propagatePermissionChanges: true,
      },
      fileId: 'doc-1',
    });
    expect(result).toMatchObject({
      ok: true,
      file_id: 'doc-1',
      user_id: 'user-1',
    });
  });

  it('returns a structured failure when adding a user collaborator does not verify', async () => {
    const transport = createMockTransport();
    transport.requestJson.mockImplementation(async (options?: unknown) => {
      const request = options as { path?: string };
      if (request.path === '/api/file/files/action/batch_get') return { successItems: [{ id: 'doc-1' }] };
      if (request.path === '/api/file/files/doc-1/share_status') return { isShared: false };
      if (request.path === '/api/file/files/doc-1/publish') return { setting: { publishStatus: 'unpublish' } };
      if (request.path === '/api/file/files/doc-1/permission_request?limit=50') return { requests: [] };
      if (request.path === '/api/file/files/doc-1/ancestors/permission?flattenInherit=true') {
        return {
          ancestorPermissionInfos: [
            { id: 'doc-1', permissionInfo: { collaborators: [{ user: { id: 'owner-1' }, role: { role: 'owner' } }] } },
          ],
        };
      }
      return { successList: [], failedList: [] };
    });

    const service = new ZoomDocsService(transport);
    await expect(service.addUserCollaborator({ fileId: 'doc-1', userId: 'user-1', role: 'viewer' })).resolves.toMatchObject({
      ok: false,
      error_code: 'VERIFICATION_FAILED',
      file_id: 'doc-1',
      user_id: 'user-1',
      expected: { role: 'viewer' },
      actual: { present: false, role: null },
    });
  });

  it('renames a file via the metadata endpoint', async () => {
    const transport = createMockTransport();
    transport.requestJson.mockResolvedValueOnce({ ok: true });

    const service = new ZoomDocsService(transport);
    await service.rename({ fileId: 'doc-1', title: 'Renamed doc' });

    expect(transport.requestJson).toHaveBeenCalledWith({
      method: 'PUT',
      path: '/api/file/files/title',
      body: { id: 'doc-1', title: 'Renamed doc', stopSync: false },
      fileId: 'doc-1',
    });
  });

  it('moves a file to the trash via delete_to_trash with the accountId', async () => {
    const transport = createMockTransport();
    transport.requestJson.mockImplementation(async (options?: unknown) => {
      const request = options as { path?: string };
      if (request.path === '/api/user/me') {
        return { user: { userId: 'user-1' }, account: { accountId: 'acct-1' } };
      }
      return {};
    });

    const service = new ZoomDocsService(transport);
    const result = await service.deleteFile({ fileId: 'https://docs.zoom.us/doc/doc-42' });

    expect(result).toEqual({ fileId: 'doc-42', status: 'trashed' });
    expect(transport.requestJson).toHaveBeenCalledWith({
      method: 'POST',
      path: '/api/file/files/action/delete_to_trash',
      body: { ids: ['doc-42'], accountId: 'acct-1' },
      fileId: 'doc-42',
    });
  });

  it('moves a file under a new parent and resolves URLs on both inputs', async () => {
    const transport = createMockTransport();
    transport.requestJson.mockImplementation(async (options?: unknown) => {
      const request = options as { path?: string };
      if (request.path === '/api/user/me') {
        return { user: { userId: 'user-1' }, account: { accountId: 'acct-1' } };
      }
      return {};
    });

    const service = new ZoomDocsService(transport);
    const result = await service.moveFile({
      fileId: 'https://docs.zoom.us/doc/doc-1',
      parentId: 'https://docs.zoom.us/folder/folder-7',
    });

    expect(result).toEqual({ fileId: 'doc-1', newParentId: 'folder-7' });
    expect(transport.requestJson).toHaveBeenCalledWith({
      method: 'POST',
      path: '/api/file/files/action/move',
      body: { ids: ['doc-1'], parentId: 'folder-7', accountId: 'acct-1' },
      fileId: 'doc-1',
    });
  });

  it('caches accountId from /api/user/me across delete + move calls', async () => {
    const transport = createMockTransport();
    let userMeCalls = 0;
    transport.requestJson.mockImplementation(async (options?: unknown) => {
      const request = options as { path?: string };
      if (request.path === '/api/user/me') {
        userMeCalls += 1;
        return { user: { userId: 'user-1' }, account: { accountId: 'acct-1' } };
      }
      return {};
    });

    const service = new ZoomDocsService(transport);
    await service.deleteFile({ fileId: 'doc-1' });
    await service.moveFile({ fileId: 'doc-2', parentId: 'folder-9' });

    expect(userMeCalls).toBe(1);
  });

  it('rejects moveFile when parent_id is empty', async () => {
    const transport = createMockTransport();
    const service = new ZoomDocsService(transport);
    await expect(service.moveFile({ fileId: 'doc-1', parentId: '   ' })).rejects.toThrow(/parent_id/);
  });
});

describe('buildZoomDocFileLink', () => {
  it('builds the doc link for regular doc types', () => {
    expect(buildZoomDocFileLink('doc', 'abc')).toBe('https://docs.zoom.us/doc/abc');
    expect(buildZoomDocFileLink('classicDoc', 'abc')).toBe('https://docs.zoom.us/doc/abc');
    expect(buildZoomDocFileLink('page', 'abc')).toBe('https://docs.zoom.us/doc/abc');
  });

  it('builds distinct links for folder and database resources', () => {
    expect(buildZoomDocFileLink('folder', 'abc')).toBe('https://docs.zoom.us/folder/abc');
    expect(buildZoomDocFileLink('database', 'abc')).toBe('https://docs.zoom.us/database/abc');
  });
});

describe('stripTitleHighlightMarkup', () => {
  it('removes <em> tags while preserving the surrounding text', () => {
    expect(stripTitleHighlightMarkup('<em>Seed</em> Changes')).toBe('Seed Changes');
  });

  it('returns undefined for empty or missing input', () => {
    expect(stripTitleHighlightMarkup(undefined)).toBeUndefined();
    expect(stripTitleHighlightMarkup('')).toBeUndefined();
  });
});

describe('normalizeNativeSearchItem', () => {
  it('skips entries that are missing an id', () => {
    expect(normalizeNativeSearchItem({ file: { title: 'nope' } })).toBeNull();
    expect(normalizeNativeSearchItem({})).toBeNull();
  });

  it('populates fileLink, updatedAt, and updatedByDisplayName when available', () => {
    const normalized = normalizeNativeSearchItem({
      file: {
        id: 'doc-1',
        title: 'Weekly Notes',
        fileType: 'doc',
        parentId: 'folder-a',
        isDeleted: false,
        updatedInfo: { user: { displayName: 'Ada Lovelace' }, time: '2026-04-10T12:00:00.000Z' },
      },
      highlight: { titleHighlight: '<em>Weekly</em> Notes' },
    });

    expect(normalized).toEqual({
      id: 'doc-1',
      title: 'Weekly Notes',
      fileType: 'doc',
      parentId: 'folder-a',
      fileLink: 'https://docs.zoom.us/doc/doc-1',
      isDeleted: false,
      titleHighlight: '<em>Weekly</em> Notes',
      updatedAt: '2026-04-10T12:00:00.000Z',
      updatedByDisplayName: 'Ada Lovelace',
    });
  });
});
