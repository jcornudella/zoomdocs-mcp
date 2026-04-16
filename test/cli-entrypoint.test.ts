import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('CLI entrypoint source', () => {
  it('starts with a node shebang so npm keeps the published bin mapping', async () => {
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');

    expect(source.startsWith('#!/usr/bin/env node\n')).toBe(true);
  });
});
