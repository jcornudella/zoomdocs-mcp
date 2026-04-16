import { deflateSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';

import { ZoomDocsService, type ZoomDocsTransport } from '../src/zoomdocs/service.js';
import { readJsonFixture } from './helpers/fixtures.js';

type RequestJsonMock = ReturnType<typeof vi.fn>;

function encodePayload(payload: unknown): string {
  return deflateSync(Buffer.from(JSON.stringify(payload), 'utf8')).toString('base64');
}

function createMockTransport(): ZoomDocsTransport & {
  ensureLoggedIn: ReturnType<typeof vi.fn>;
  openLogin: ReturnType<typeof vi.fn>;
  requestJson: RequestJsonMock;
} {
  const requestJson = vi.fn(async (_options?: unknown) => undefined as unknown);

  return {
    ensureLoggedIn: vi.fn(async () => undefined),
    openLogin: vi.fn(async () => ({ alreadyAuthenticated: false })),
    requestJson: requestJson as ZoomDocsTransport['requestJson'] & RequestJsonMock,
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

  it('searches recursively by title so agents can resolve docs from natural language', async () => {
    const transport = createMockTransport();
    transport.requestJson.mockImplementation(async (options?: unknown) => {
      const request = options as {
        path?: string;
        body?: { parentIds?: string[] };
      };

      if (request.path !== '/api/file/files/action/batch_get_children') {
        return undefined;
      }

      const parentId = request.body?.parentIds?.[0];
      if (parentId === 'my-docs') {
        return {
          successItems: [
            {
              parentId: 'my-docs',
              children: [
                { id: 'doc-prefix', title: 'Seed Changes Draft', fileType: 'doc', fileLink: 'https://docs.zoom.us/doc/doc-prefix' },
                { id: 'folder-1', title: 'Archive', fileType: 'folder', fileLink: 'https://docs.zoom.us/folder/folder-1' },
              ],
            },
          ],
        };
      }

      if (parentId === 'folder-1') {
        return {
          successItems: [
            {
              parentId: 'folder-1',
              children: [
                { id: 'doc-exact', title: 'Seed Changes', fileType: 'doc', fileLink: 'https://docs.zoom.us/doc/doc-exact' },
                { id: 'doc-loose', title: 'Changes for seed data', fileType: 'doc', fileLink: 'https://docs.zoom.us/doc/doc-loose' },
              ],
            },
          ],
        };
      }

      return {
        successItems: [{ parentId, children: [] }],
      };
    });

    const service = new ZoomDocsService(transport);
    const result = await service.search({ query: 'Seed Changes' });

    expect(result.items.map((item) => item.id)).toEqual(['doc-exact', 'doc-prefix', 'doc-loose']);
    expect(result.scannedFolders).toBe(2);
    expect(transport.requestJson).toHaveBeenNthCalledWith(1, {
      method: 'POST',
      path: '/api/file/files/action/batch_get_children',
      body: { parentIds: ['my-docs'] },
      fileId: 'my-docs',
    });
    expect(transport.requestJson).toHaveBeenNthCalledWith(2, {
      method: 'POST',
      path: '/api/file/files/action/batch_get_children',
      body: { parentIds: ['folder-1'] },
      fileId: 'folder-1',
    });
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
});
