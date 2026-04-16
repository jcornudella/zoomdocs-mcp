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

  it('writes markdown into a replacement doc when targetFileId is provided', async () => {
    const transport = createMockTransport();
    transport.requestJson
      .mockResolvedValueOnce(await readJsonFixture('zoomdocs', 'service', 'metadata-response.json'))
      .mockResolvedValueOnce(await readJsonFixture('zoomdocs', 'service', 'sync-create-response.json'));

    const service = new ZoomDocsService(transport);
    const result = await service.writeMarkdown({
      markdown: '# Updated content',
      targetFileId: 'doc-old',
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
    expect(result.mode).toBe('replace');
    expect(result.fileLink).toBe('https://docs.zoom.us/doc/doc-new');
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
