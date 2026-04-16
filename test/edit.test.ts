import { describe, expect, it } from 'vitest';

import {
  buildAppendDelta,
  buildAuthorAttribution,
  buildBlockTransactionRequest,
  buildReplaceDelta,
  computeBlockTextLength,
  extractPlainTextFromTitle,
  summarizeBlocks,
} from '../src/zoomdocs/edit.js';

const USER_ID = 'LudYnENvQQ6KCCKzRJC-Rg';

describe('buildAuthorAttribution', () => {
  it('formats the 26:"<userId>" attribution tag', () => {
    expect(buildAuthorAttribution(USER_ID)).toBe('26:"LudYnENvQQ6KCCKzRJC-Rg"');
  });
});

describe('computeBlockTextLength', () => {
  it('sums string inserts from a title delta', () => {
    const title = JSON.stringify([[0, 'Hello ', '26:"u"'], [0, 'world', '26:"u"']]);
    expect(computeBlockTextLength(title)).toBe(11);
  });

  it('treats non-delta strings as their raw length', () => {
    expect(computeBlockTextLength('plain text')).toBe(10);
  });

  it('returns 0 for empty / malformed input', () => {
    expect(computeBlockTextLength('')).toBe(0);
    expect(computeBlockTextLength('[not json')).toBe(0);
    expect(computeBlockTextLength(null)).toBe(0);
    expect(computeBlockTextLength(undefined)).toBe(0);
  });

  it('counts embedded inline objects as length 1', () => {
    const title = JSON.stringify([[0, 'a', '26:"u"'], [0, { link: { source: { type: 'link' } } }, '']]);
    expect(computeBlockTextLength(title)).toBe(2);
  });
});

describe('extractPlainTextFromTitle', () => {
  it('joins string inserts into a single string', () => {
    const title = JSON.stringify([[0, 'Hello ', '26:"u"'], [0, 'world', '26:"u"']]);
    expect(extractPlainTextFromTitle(title)).toBe('Hello world');
  });

  it('skips non-insert ops and non-string values', () => {
    const title = JSON.stringify([[0, 'A', '26:"u"'], [2, 5], [0, { link: {} }, ''], [0, 'B', '26:"u"']]);
    expect(extractPlainTextFromTitle(title)).toBe('AB');
  });

  it('returns raw string when the title is not a delta', () => {
    expect(extractPlainTextFromTitle('legacy plain title')).toBe('legacy plain title');
  });

  it('returns empty string for non-string inputs', () => {
    expect(extractPlainTextFromTitle(undefined)).toBe('');
    expect(extractPlainTextFromTitle(42)).toBe('');
  });
});

describe('buildAppendDelta', () => {
  it('produces the retain+insert shape observed in captured traffic', () => {
    const delta = buildAppendDelta({ currentLength: 85, text: ' T', userId: USER_ID });
    expect(JSON.parse(delta)).toEqual([
      [2, 85],
      [0, ' T', `26:"${USER_ID}"`],
    ]);
  });

  it('omits the retain op for empty blocks', () => {
    const delta = buildAppendDelta({ currentLength: 0, text: 'first', userId: USER_ID });
    expect(JSON.parse(delta)).toEqual([[0, 'first', `26:"${USER_ID}"`]]);
  });
});

describe('buildReplaceDelta', () => {
  it('deletes existing content then inserts new text', () => {
    const delta = buildReplaceDelta({ currentLength: 10, text: 'new', userId: USER_ID });
    expect(JSON.parse(delta)).toEqual([
      [1, 10],
      [0, 'new', `26:"${USER_ID}"`],
    ]);
  });

  it('handles clearing a block (empty new text)', () => {
    const delta = buildReplaceDelta({ currentLength: 10, text: '', userId: USER_ID });
    expect(JSON.parse(delta)).toEqual([[1, 10]]);
  });

  it('handles inserting into an empty block', () => {
    const delta = buildReplaceDelta({ currentLength: 0, text: 'hello', userId: USER_ID });
    expect(JSON.parse(delta)).toEqual([[0, 'hello', `26:"${USER_ID}"`]]);
  });
});

describe('buildBlockTransactionRequest', () => {
  it('matches the capture payload shape exactly', () => {
    const request = buildBlockTransactionRequest({
      fileId: 'cPRC6rtoRGCS9X80-SHjQA',
      clientId: 'dd10f56c-b43a-4f12-8284-b14d0e5d973c',
      baseVersion: 644,
      blockId: '6c737ab81d0140ac89b9e01cb042f70f',
      delta: JSON.stringify([[2, 85], [0, ' T', `26:"${USER_ID}"`]]),
      reqId: 'b51a032e-d628-498a-b628-1ee73d4fde8c',
      transactionId: '8b638220-1b18-42f4-b95d-1936f33d3078',
    });

    expect(request).toEqual({
      reqId: 'b51a032e-d628-498a-b628-1ee73d4fde8c',
      clientId: 'dd10f56c-b43a-4f12-8284-b14d0e5d973c',
      baseVersion: 644,
      transactions: [
        {
          id: '8b638220-1b18-42f4-b95d-1936f33d3078',
          ops: [
            {
              command: 'COMMAND_TYPE_UPDATE',
              blockId: '6c737ab81d0140ac89b9e01cb042f70f',
              args: { delta: JSON.stringify([[2, 85], [0, ' T', `26:"${USER_ID}"`]]) },
            },
          ],
        },
      ],
      extra: { fromFileId: 'cPRC6rtoRGCS9X80-SHjQA' },
    });
  });
});

describe('summarizeBlocks', () => {
  it('returns blocks in doc order (PAGE root, then children sorted by seq)', () => {
    const blocks = {
      third: {
        id: 'third',
        type: 'BLOCK_TYPE_PARAGRAPH',
        parentId: 'doc',
        seq: 'c',
        version: 3,
        content: { title: JSON.stringify([[0, 'three', '26:"u"']]) },
      },
      first: {
        id: 'first',
        type: 'BLOCK_TYPE_PARAGRAPH',
        parentId: 'doc',
        seq: 'a',
        version: 1,
        content: { title: JSON.stringify([[0, 'one', '26:"u"']]) },
      },
      doc: { id: 'doc', type: 'BLOCK_TYPE_PAGE', version: 1, content: { title: 'title' } },
      second: {
        id: 'second',
        type: 'BLOCK_TYPE_PARAGRAPH',
        parentId: 'doc',
        seq: 'b',
        version: 2,
        content: { title: JSON.stringify([[0, 'two', '26:"u"']]) },
      },
    };
    const result = summarizeBlocks(blocks, { rootId: 'doc' });
    expect(result.map((block) => block.id)).toEqual(['doc', 'first', 'second', 'third']);
  });

  it('uses createdAt as a secondary sort when seq ties', () => {
    const blocks = {
      late: { id: 'late', parentId: 'doc', seq: 'a', createdAt: '2', version: 1 },
      early: { id: 'early', parentId: 'doc', seq: 'a', createdAt: '1', version: 1 },
      doc: { id: 'doc', type: 'BLOCK_TYPE_PAGE', version: 1 },
    };
    const result = summarizeBlocks(blocks, { rootId: 'doc' });
    expect(result.map((block) => block.id)).toEqual(['doc', 'early', 'late']);
  });

  it('recurses into nested children', () => {
    const blocks = {
      doc: { id: 'doc', type: 'BLOCK_TYPE_PAGE', version: 1 },
      a: { id: 'a', parentId: 'doc', seq: 'a', version: 1 },
      b: { id: 'b', parentId: 'doc', seq: 'b', version: 1 },
      a1: { id: 'a1', parentId: 'a', seq: 'a', version: 1 },
      a2: { id: 'a2', parentId: 'a', seq: 'b', version: 1 },
    };
    const result = summarizeBlocks(blocks, { rootId: 'doc' });
    expect(result.map((block) => block.id)).toEqual(['doc', 'a', 'a1', 'a2', 'b']);
  });

  it('appends orphan blocks that are unreachable from the root', () => {
    const blocks = {
      doc: { id: 'doc', type: 'BLOCK_TYPE_PAGE', version: 1 },
      a: { id: 'a', parentId: 'doc', seq: 'a', version: 1 },
      orphan: { id: 'orphan', parentId: 'missing-parent', seq: 'a', version: 1 },
    };
    const result = summarizeBlocks(blocks, { rootId: 'doc' });
    expect(result.map((block) => block.id)).toEqual(['doc', 'a', 'orphan']);
  });

  it('falls back to the PAGE block when rootId is not provided', () => {
    const blocks = {
      doc: { id: 'doc', type: 'BLOCK_TYPE_PAGE', version: 1 },
      a: { id: 'a', parentId: 'doc', seq: 'a', version: 1 },
    };
    const result = summarizeBlocks(blocks);
    expect(result.map((block) => block.id)).toEqual(['doc', 'a']);
  });

  it('returns an empty array when no blocks are present', () => {
    expect(summarizeBlocks(undefined)).toEqual([]);
    expect(summarizeBlocks({})).toEqual([]);
  });
});
