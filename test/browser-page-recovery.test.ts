import { describe, expect, it } from 'vitest';

import { pickReusablePage, shouldRecoverFromClosedPageError } from '../src/browser/transport.js';

describe('browser page recovery', () => {
  it('reuses the first non-closed page', () => {
    const closedPage = { isClosed: () => true };
    const openPage = { isClosed: () => false };

    expect(pickReusablePage([closedPage, openPage])).toBe(openPage);
  });

  it('returns undefined when all pages are closed', () => {
    expect(pickReusablePage([{ isClosed: () => true }])).toBeUndefined();
  });

  it('treats target page/browser closed errors as recoverable', () => {
    expect(shouldRecoverFromClosedPageError(new Error('page.goto: Target page, context or browser has been closed'))).toBe(true);
    expect(shouldRecoverFromClosedPageError(new Error('something else'))).toBe(false);
  });
});
