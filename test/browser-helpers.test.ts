import { describe, expect, it } from 'vitest';

import { buildApiReplayHeaders, buildCandidateDocsOrigins, parseCsrfTokenResponse, toAbsoluteUrl } from '../src/browser/helpers.js';

describe('browser helpers', () => {
  it('resolves relative api paths against the docs base url', () => {
    expect(toAbsoluteUrl('https://docs.zoom.us', '/api/file/my_docs')).toBe('https://docs.zoom.us/api/file/my_docs');
    expect(toAbsoluteUrl('https://docs.zoom.us/', 'api/file/my_docs')).toBe('https://docs.zoom.us/api/file/my_docs');
  });

  it('extracts the csrf token from the csrf_js response format', () => {
    expect(parseCsrfTokenResponse('csrf-token:abc123')).toBe('abc123');
    expect(parseCsrfTokenResponse('ignored-prefix:token-value')).toBe('token-value');
  });

  it('prefers cluster-specific docs origins discovered from open pages and cookies', () => {
    expect(
      buildCandidateDocsOrigins({
        baseUrl: 'https://docs.zoom.us',
        pageUrls: ['https://us01docs.zoom.us/doc/abc123', 'https://zoom.us/signin'],
        cookieDomains: ['.us01docs.zoom.us', '.zoom.us', 'docs.zoom.us'],
        rememberedOrigins: ['https://eu01docs.zoom.us'],
      })
    ).toEqual([
      'https://us01docs.zoom.us',
      'https://eu01docs.zoom.us',
      'https://docs.zoom.us',
    ]);
  });

  it('keeps only the auth and zoom-specific headers needed to replay API calls', () => {
    expect(
      buildApiReplayHeaders({
        authorization: 'Bearer token',
        'x-zm-device-tracking-id': 'device-1',
        'x-zm-docs-container': 'docs/browser',
        'x-zm-docs-loading': 'init',
        'x-zm-cluster-id': 'aw1',
        origin: 'https://docs.zoom.us',
        referer: 'https://docs.zoom.us/',
        'x-requested-with': 'XMLHttpRequest',
        cookie: 'drop-me',
        'user-agent': 'drop-me-too',
      })
    ).toEqual({
      authorization: 'Bearer token',
      'x-zm-device-tracking-id': 'device-1',
      'x-zm-docs-container': 'docs/browser',
      'x-zm-docs-loading': 'init',
      'x-zm-cluster-id': 'aw1',
      origin: 'https://docs.zoom.us',
      referer: 'https://docs.zoom.us/',
      'x-requested-with': 'XMLHttpRequest',
    });
  });
});
