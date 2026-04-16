import { describe, expect, it } from 'vitest';

import { renderEmbeddedDatabaseToMarkdown, renderZoomDocBlocksToMarkdown } from '../src/zoomdocs/markdown.js';
import { readJsonFixture, readTextFixture } from './helpers/fixtures.js';

describe('renderZoomDocBlocksToMarkdown', () => {
  it('renders a page block graph into markdown', () => {
    const richText = (...segments: unknown[]) => JSON.stringify(segments.map((segment) => [0, segment, 'meta']));

    const markdown = renderZoomDocBlocksToMarkdown({
      blocks: {
        page: {
          id: 'page',
          type: 'BLOCK_TYPE_PAGE',
          content: { title: 'Doc title' },
          seq: 'a0',
        },
        heading: {
          id: 'heading',
          parentId: 'page',
          type: 'BLOCK_TYPE_HEADING2',
          content: { title: richText('Overview') },
          seq: 'a1',
        },
        paragraph: {
          id: 'paragraph',
          parentId: 'page',
          type: 'BLOCK_TYPE_PARAGRAPH',
          content: { title: richText('Hello ', 'world') },
          seq: 'a2',
        },
        bullet: {
          id: 'bullet',
          parentId: 'page',
          type: 'BLOCK_TYPE_BULLET',
          content: { title: richText('Item one') },
          seq: 'a3',
        },
        todo: {
          id: 'todo',
          parentId: 'bullet',
          type: 'BLOCK_TYPE_TODO_LIST',
          content: { title: richText('Done task') },
          style: { checked: true },
          seq: 'a0',
        },
        image: {
          id: 'image',
          parentId: 'page',
          type: 'BLOCK_TYPE_IMAGE',
          content: {
            title: richText({ attachment: { attachmentId: 'att-1', name: 'image.png', type: 'image/png' } }),
          },
          seq: 'a4',
        },
        callout: {
          id: 'callout',
          parentId: 'page',
          type: 'BLOCK_TYPE_CALLOUT',
          content: { title: '[]' },
          seq: 'a5',
        },
        calloutParagraph: {
          id: 'calloutParagraph',
          parentId: 'callout',
          type: 'BLOCK_TYPE_PARAGRAPH',
          content: { title: richText('Callout text') },
          seq: 'a0',
        },
        linkedHeading: {
          id: 'linkedHeading',
          parentId: 'page',
          type: 'BLOCK_TYPE_HEADING4',
          content: { title: richText({ link: { source: { type: 'link', link: 'https://docs.zoom.us/recent', text: 'Try creating your first doc' } } }) },
          seq: 'a55',
        },
        embed: {
          id: 'embed',
          parentId: 'page',
          type: 'BLOCK_TYPE_EMBED_REFERENCE',
          content: { title: '[]', ref: { id: 'db-1', type: 'EMBED_TYPE_DATABASE' } },
          seq: 'a6',
        },
      },
    }, {
      attachmentUrls: {
        'att-1': 'https://cdn.example.com/image.webp',
      },
      embeddedMarkdownByRefId: {
        'db-1': '### Embedded table\n\n| Name | Preview |\n| --- | --- |\n| [Doc](https://docs.zoom.us/doc/123) | ![image](https://cdn.example.com/db.webp) |',
      },
    });

    expect(markdown).toContain('# Doc title');
    expect(markdown).toContain('## Overview');
    expect(markdown).toContain('Hello world');
    expect(markdown).toContain('- Item one');
    expect(markdown).toContain('  - [x] Done task');
    expect(markdown).toContain('![image.png](https://cdn.example.com/image.webp)');
    expect(markdown).toContain('> Callout text');
    expect(markdown).toContain('#### [Try creating your first doc](https://docs.zoom.us/recent)');
    expect(markdown).toContain('### Embedded table');
    expect(markdown).toContain('| Name | Preview |');
  });

  it('renders fixture-backed page and database payloads into markdown', async () => {
    const pagePayload = await readJsonFixture<Record<string, unknown>>('zoomdocs', 'read', 'page-with-embed.json');
    const databasePayload = await readJsonFixture<Record<string, unknown>>('zoomdocs', 'read', 'embedded-database.json');
    const expectedMarkdown = await readTextFixture('zoomdocs', 'read', 'page-with-embed.md');

    const markdown = renderZoomDocBlocksToMarkdown(pagePayload, {
      attachmentUrls: {
        'att-1': 'https://cdn.example.com/diagram.webp',
        'att-db': 'https://cdn.example.com/db-image.webp',
      },
      embeddedMarkdownByRefId: {
        'db-1': renderEmbeddedDatabaseToMarkdown(databasePayload, {
          attachmentUrls: {
            'att-db': 'https://cdn.example.com/db-image.webp',
          },
        }),
      },
    });

    expect(markdown).toBe(expectedMarkdown.trimEnd());
  });

  it('renders embedded database payloads as markdown table rows', () => {
    const markdown = renderEmbeddedDatabaseToMarkdown({
      blocks: {
        database: {
          id: 'db-1',
          type: 'BLOCK_TYPE_DATABASE',
          content: { database: { name: 'Examples', viewOrder: [{ id: 'view-1', seq: 'a0' }] } },
        },
        table: {
          id: 'table-1',
          parentId: 'db-1',
          type: 'BLOCK_TYPE_DATABASE_TABLE',
          content: { table: { name: 'Examples table' } },
        },
        view: {
          id: 'view-1',
          parentId: 'table-1',
          type: 'BLOCK_TYPE_DATABASE_VIEW',
          content: {
            view: {
              name: 'Table',
              databaseId: 'db-1',
              viewType: 'VIEW_TYPE_TABLE',
              viewColumns: {
                'col-1': { visible: true },
                'col-2': { visible: true },
              },
              columnOrder: [{ id: 'col-1', seq: 'a0' }, { id: 'col-2', seq: 'a1' }],
              rowOrder: [{ id: 'row-1', seq: 'a0' }],
            },
          },
        },
        col1: {
          id: 'col-1',
          parentId: 'table-1',
          type: 'BLOCK_TYPE_DATABASE_COLUMN',
          content: { column: { name: 'Doc', isPrimary: true, columnType: 'COLUMN_TYPE_TEXT' } },
        },
        col2: {
          id: 'col-2',
          parentId: 'table-1',
          type: 'BLOCK_TYPE_DATABASE_COLUMN',
          content: { column: { name: 'Image', columnType: 'COLUMN_TYPE_ATTACHMENT' } },
        },
        row: {
          id: 'row-1',
          parentId: 'table-1',
          type: 'BLOCK_TYPE_DATABASE_ROW',
          content: {
            row: {
              values: {
                'col-1': { value: JSON.stringify({ text: 'https://docs.zoom.us/doc/abc123' }) },
                'col-2': { value: [{ attachmentId: 'att-db', name: 'db-image.png', type: 'image/png' }] },
              },
            },
          },
        },
      },
    }, {
      attachmentUrls: {
        'att-db': 'https://cdn.example.com/db-image.webp',
      },
    });

    expect(markdown).toContain('### Table');
    expect(markdown).toContain('| Doc | Image |');
    expect(markdown).toContain('https://docs.zoom.us/doc/abc123');
    expect(markdown).toContain('![db-image.png](https://cdn.example.com/db-image.webp)');
  });
});
