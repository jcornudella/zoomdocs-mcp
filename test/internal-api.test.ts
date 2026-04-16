import { deflateSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import {
  DOC_TARGET_TYPE,
  MARKDOWN_SOURCE_TYPE,
  ROOT_PARENT_ID,
  buildSyncCreatePayload,
  collectRememberableNodes,
  decodeContentData,
  extractFileId,
  normalizeBatchGetChildrenResult,
  normalizeBatchGetNodesResult,
  parseModocContent,
} from '../src/zoomdocs/internal-api.js';
import { readJsonFixture } from './helpers/fixtures.js';

describe('zoomdocs internal api helpers', () => {
  it('extracts file ids from raw ids and docs urls', () => {
    expect(extractFileId('abc123')).toBe('abc123');
    expect(extractFileId('https://docs.zoom.us/doc/abc123')).toBe('abc123');
    expect(extractFileId(' https://docs.zoom.us/folder/xyz789?from=share ')).toBe('xyz789');
  });

  it('builds the markdown syncCreate payload with stable enum values', () => {
    expect(buildSyncCreatePayload({
      title: 'Weekly Notes',
      markdown: '# Hello',
    })).toEqual({
      parentId: ROOT_PARENT_ID,
      filename: 'Weekly Notes',
      targetType: DOC_TARGET_TYPE,
      sourceData: '# Hello',
      sourceType: MARKDOWN_SOURCE_TYPE,
    });
  });

  it('normalizes child listing results', () => {
    expect(normalizeBatchGetChildrenResult({
      successItems: [
        {
          parentId: 'my-docs',
          children: [
            { id: 'a', title: 'Doc A', fileType: 'doc', fileLink: 'https://docs.zoom.us/doc/a' },
            { id: 'b', title: 'Folder B', fileType: 'folder', fileLink: 'https://docs.zoom.us/folder/b' }
          ]
        }
      ]
    })).toEqual([
      { id: 'a', title: 'Doc A', fileType: 'doc', fileLink: 'https://docs.zoom.us/doc/a' },
      { id: 'b', title: 'Folder B', fileType: 'folder', fileLink: 'https://docs.zoom.us/folder/b' },
    ]);
  });

  it('collects rememberable nodes from fixture payloads so routing can follow cluster-specific docs hosts', async () => {
    const payload = await readJsonFixture<Record<string, unknown>>('zoomdocs', 'routing', 'batch-get-children.json');

    expect(collectRememberableNodes(payload)).toEqual([
      {
        id: 'doc-aw1',
        title: 'Seed Changes',
        fileType: 'doc',
        parentId: 'my-docs',
        fileLink: 'https://aw1docs.zoom.us/doc/doc-aw1',
      },
      {
        id: 'folder-eu',
        title: 'Designs',
        fileType: 'folder',
        parentId: 'my-docs',
        fileLink: 'https://eu02docs.zoom.us/folder/folder-eu',
        fileClusterApiPrefix: 'https://eu02docs.zoom.us',
      },
    ]);
  });

  it('normalizes metadata lookup results', () => {
    expect(normalizeBatchGetNodesResult({
      successItems: [
        { id: 'a', title: 'Doc A', fileType: 'doc', parentId: 'my-docs', fileLink: 'https://docs.zoom.us/doc/a' }
      ]
    })).toEqual({
      id: 'a',
      title: 'Doc A',
      fileType: 'doc',
      parentId: 'my-docs',
      fileLink: 'https://docs.zoom.us/doc/a',
    });
  });

  it('extracts readable text from modoc payloads when text is present', () => {
    expect(parseModocContent(JSON.stringify({ text: 'Line one\nLine two' }))).toEqual({
      text: 'Line one\nLine two',
      raw: JSON.stringify({ text: 'Line one\nLine two' }),
      format: 'modoc-json',
    });
  });

  it('falls back to raw content when the payload is not json', () => {
    expect(parseModocContent('Just text')).toEqual({
      text: 'Just text',
      raw: 'Just text',
      format: 'plain-text',
    });
  });

  it('decodes gzip-compressed encoded content', () => {
    const raw = JSON.stringify({ text: 'Hello from gzip' });
    const encoded = gzipSync(Buffer.from(raw, 'utf8')).toString('base64');

    expect(decodeContentData(encoded, true)).toBe(raw);
  });

  it('decodes deflate-compressed encoded content', () => {
    const raw = JSON.stringify({ text: 'Hello from deflate' });
    const encoded = deflateSync(Buffer.from(raw, 'utf8')).toString('base64');

    expect(decodeContentData(encoded, true)).toBe(raw);
  });
});
