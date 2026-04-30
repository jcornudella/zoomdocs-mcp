import { describe, expect, it } from 'vitest';

import { analyzeCaptureLines, formatCaptureAnalysis } from '../src/zoomdocs/capture-analyzer.js';

describe('capture analyzer', () => {
  it('groups HTTP records by normalized method/path and keeps redacted examples', () => {
    const lines = [
      JSON.stringify({
        kind: 'http',
        method: 'GET',
        url: 'https://docs.zoom.us/api/file/files/doc-1/share_status',
        pathWithQuery: '/api/file/files/doc-1/share_status',
        status: 200,
        requestBody: null,
        responseBody: '{"isShared":false}',
      }),
      JSON.stringify({
        kind: 'http',
        method: 'GET',
        url: 'https://docs.zoom.us/api/file/files/doc-2/share_status',
        pathWithQuery: '/api/file/files/doc-2/share_status',
        status: 200,
        requestBody: null,
        responseBody: '{"isShared":true}',
      }),
      JSON.stringify({
        kind: 'websocket',
        url: 'wss://docs.zoom.us/ws?auth=secret',
        direction: 'open',
        payload: null,
      }),
      'not json',
    ];

    const result = analyzeCaptureLines(lines);

    expect(result.invalidLineCount).toBe(1);
    expect(result.websocketCount).toBe(1);
    expect(result.groups).toEqual([
      {
        key: 'GET /api/file/files/{id}/share_status',
        method: 'GET',
        normalizedPath: '/api/file/files/{id}/share_status',
        count: 2,
        statuses: { '200': 2 },
        examples: [
          {
            pathWithQuery: '/api/file/files/doc-1/share_status',
            requestBody: null,
            responseBody: '{"isShared":false}',
          },
        ],
      },
    ]);
  });

  it('does not treat static file utility endpoints as file ids', () => {
    const result = analyzeCaptureLines([
      JSON.stringify({
        kind: 'http',
        method: 'PUT',
        pathWithQuery: '/api/file/files/title',
        status: 200,
        requestBody: '{"id":"doc-1","title":"Renamed"}',
        responseBody: '{}',
      }),
      JSON.stringify({
        kind: 'http',
        method: 'POST',
        pathWithQuery: '/api/file/files/user/vcard',
        status: 200,
        requestBody: '{"userId":"user-1","fileId":"doc-1"}',
        responseBody: '{}',
      }),
    ]);

    expect(result.groups.map((group) => group.key).sort()).toEqual([
      'POST /api/file/files/user/vcard',
      'PUT /api/file/files/title',
    ]);
  });

  it('normalizes comment mutation ids in paths and query strings', () => {
    const result = analyzeCaptureLines([
      JSON.stringify({
        kind: 'http',
        method: 'PATCH',
        pathWithQuery: '/api/comment/threads/thread-1?fileId=doc-1',
        status: 200,
      }),
      JSON.stringify({
        kind: 'http',
        method: 'PATCH',
        pathWithQuery: '/api/comment/threads/thread-2?fileId=doc-2',
        status: 200,
      }),
      JSON.stringify({
        kind: 'http',
        method: 'DELETE',
        pathWithQuery: '/api/comment/comments/comment-1?threadId=thread-1&fileId=doc-1',
        status: 200,
      }),
    ]);

    expect(result.groups.map((group) => group.key).sort()).toEqual([
      'DELETE /api/comment/comments/{id}?threadId={id}&fileId={id}',
      'PATCH /api/comment/threads/{id}?fileId={id}',
    ]);
    expect(result.groups.find((group) => group.key.startsWith('PATCH'))?.count).toBe(2);
  });

  it('formats grouped endpoints for quick endpoint triage', () => {
    const result = analyzeCaptureLines([
      JSON.stringify({
        kind: 'http',
        method: 'POST',
        pathWithQuery: '/api/share/invite?fileId=doc-1',
        status: 200,
        requestBody: '{"email":"<redacted>"}',
        responseBody: '{"ok":true}',
      }),
    ]);

    expect(formatCaptureAnalysis(result)).toContain('POST /api/share/invite?fileId={id} — 1 request');
    expect(formatCaptureAnalysis(result)).toContain('request: {"email":"<redacted>"}');
  });
});
