import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CaptureRecorder,
  buildCaptureRecord,
  buildWebSocketRecord,
  defaultCaptureFilePath,
  redactHeaders,
  redactSensitiveUrl,
  shouldRecordRequest,
  truncateBody,
} from '../src/zoomdocs/capture.js';

describe('redactHeaders', () => {
  it('replaces sensitive headers with <redacted> while preserving others', () => {
    const redacted = redactHeaders({
      cookie: 'session=secret',
      Authorization: 'Bearer abc',
      'x-custom': 'keep-me',
    });

    expect(redacted).toEqual({
      cookie: '<redacted>',
      Authorization: '<redacted>',
      'x-custom': 'keep-me',
    });
  });

  it('is case insensitive regardless of how the header was written', () => {
    expect(redactHeaders({ COOKIE: 'x' }).COOKIE).toBe('<redacted>');
    expect(redactHeaders({ 'SeT-CookIe': 'x' })['SeT-CookIe']).toBe('<redacted>');
  });
});

describe('redactSensitiveUrl', () => {
  it('redacts sensitive query parameters while preserving routing context', () => {
    expect(
      redactSensitiveUrl(
        'wss://us01docs.zoom.us/ws?clientId=abc&auth=jwt-secret&sessionId=session-secret&zm_aid=aid-secret&host=https%3A%2F%2Fus01docs.zoom.us'
      )
    ).toBe(
      'wss://us01docs.zoom.us/ws?clientId=abc&auth=%3Credacted%3E&sessionId=%3Credacted%3E&zm_aid=%3Credacted%3E&host=https%3A%2F%2Fus01docs.zoom.us'
    );
  });

  it('redacts repeated sensitive params case-insensitively', () => {
    expect(redactSensitiveUrl('https://docs.zoom.us/api?Token=a&TOKEN=b&query=keep')).toBe(
      'https://docs.zoom.us/api?Token=%3Credacted%3E&TOKEN=%3Credacted%3E&query=keep'
    );
  });

  it('returns malformed URLs unchanged', () => {
    expect(redactSensitiveUrl('not a url with token=abc')).toBe('not a url with token=abc');
  });
});

describe('shouldRecordRequest', () => {
  it('matches /api/ requests and Zoom file uploads by default', () => {
    expect(shouldRecordRequest('https://docs.zoom.us/api/file/my_space')).toBe(true);
    expect(shouldRecordRequest('https://eu01file.zoom.us/zoomfile/upload?channel=328')).toBe(true);
    expect(shouldRecordRequest('https://docs.zoom.us/static/app.js')).toBe(false);
  });

  it('accepts a regex filter', () => {
    expect(shouldRecordRequest('https://docs.zoom.us/api/search?q=x', /\/search/)).toBe(true);
    expect(shouldRecordRequest('https://docs.zoom.us/api/file/my_space', /\/search/)).toBe(false);
  });
});

describe('truncateBody', () => {
  it('returns the body untouched when under the byte limit', () => {
    expect(truncateBody('hello', 100)).toBe('hello');
  });

  it('truncates oversized bodies and annotates how much was dropped', () => {
    const body = 'a'.repeat(1024);
    const truncated = truncateBody(body, 16);
    expect(truncated?.startsWith('a'.repeat(16))).toBe(true);
    expect(truncated).toContain('<truncated');
    expect(truncated).toContain('1008 bytes');
  });

  it('passes null through', () => {
    expect(truncateBody(null, 10)).toBe(null);
  });
});

describe('buildCaptureRecord', () => {
  it('captures request + response data, redacts sensitive headers, and extracts the path', () => {
    const record = buildCaptureRecord({
      timestamp: '2026-04-16T10:00:00.000Z',
      request: {
        method: 'POST',
        url: 'https://docs.zoom.us/api/search?q=weekly',
        resourceType: 'fetch',
        headers: { authorization: 'Bearer sneaky', 'content-type': 'application/json' },
        body: '{"query":"weekly"}',
        fromPageUrl: 'https://docs.zoom.us/home',
      },
      response: {
        status: 200,
        statusText: 'OK',
        headers: { 'set-cookie': 'ZM_SESS=...', 'content-type': 'application/json' },
        body: '{"items":[]}',
      },
    });

    expect(record.method).toBe('POST');
    expect(record.url).toBe('https://docs.zoom.us/api/search?q=weekly');
    expect(record.pathWithQuery).toBe('/api/search?q=weekly');
    expect(record.requestHeaders.authorization).toBe('<redacted>');
    expect(record.requestHeaders['content-type']).toBe('application/json');
    expect(record.responseHeaders['set-cookie']).toBe('<redacted>');
    expect(record.status).toBe(200);
    expect(record.responseBody).toBe('{"items":[]}');
    expect(record.failure).toBe(null);
    expect(record.fromPageUrl).toBe('https://docs.zoom.us/home');
  });

  it('records failures without a response body', () => {
    const record = buildCaptureRecord({
      timestamp: '2026-04-16T10:00:00.000Z',
      request: {
        method: 'GET',
        url: 'https://docs.zoom.us/api/broken',
        headers: {},
        body: null,
      },
      failure: 'net::ERR_ABORTED',
    });

    expect(record.status).toBe(null);
    expect(record.responseBody).toBe(null);
    expect(record.failure).toBe('net::ERR_ABORTED');
  });
});

describe('defaultCaptureFilePath', () => {
  it('produces a sortable filename based on the timestamp', () => {
    const result = defaultCaptureFilePath({
      capturesDir: '/tmp/zoomdocs-captures',
      now: new Date('2026-04-16T10:30:15.123Z'),
    });

    expect(result).toBe('/tmp/zoomdocs-captures/capture-2026-04-16T10-30-15-123Z.jsonl');
  });
});

describe('CaptureRecorder', () => {
  it('writes one JSONL entry per record call and counts them', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'zoomdocs-capture-test-'));
    try {
      const outputPath = path.join(dir, 'capture.jsonl');
      const recorder = new CaptureRecorder(outputPath);

      await recorder.record({
        request: {
          method: 'GET',
          url: 'https://docs.zoom.us/api/file/my_space',
          headers: { authorization: 'Bearer x' },
          body: null,
        },
        response: { status: 200, statusText: 'OK', headers: {}, body: '{"mySpace":1}' },
      });

      await recorder.record({
        request: {
          method: 'POST',
          url: 'https://docs.zoom.us/api/search',
          headers: {},
          body: '{"query":"weekly"}',
        },
        response: { status: 200, statusText: 'OK', headers: {}, body: '{"items":[]}' },
      });

      await recorder.close();

      const contents = await readFile(outputPath, 'utf8');
      const lines = contents.trim().split('\n');
      expect(lines).toHaveLength(2);
      const first = JSON.parse(lines[0] as string);
      const second = JSON.parse(lines[1] as string);
      expect(first.pathWithQuery).toBe('/api/file/my_space');
      expect(first.requestHeaders.authorization).toBe('<redacted>');
      expect(second.method).toBe('POST');
      expect(recorder.count).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('records WebSocket frames alongside HTTP records in the same JSONL file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'zoomdocs-capture-test-'));
    try {
      const outputPath = path.join(dir, 'capture.jsonl');
      const recorder = new CaptureRecorder(outputPath);

      await recorder.record({
        request: {
          method: 'POST',
          url: 'https://docs.zoom.us/api/websocket/token',
          headers: {},
          body: '{}',
        },
        response: { status: 200, statusText: 'OK', headers: {}, body: '{"token":"..."}' },
      });

      await recorder.recordWebSocket({
        frame: { url: 'wss://us01docs.zoom.us/lynx?auth=secret', direction: 'open', payload: null },
      });

      await recorder.recordWebSocket({
        frame: {
          url: 'wss://us01docs.zoom.us/lynx',
          direction: 'sent',
          payload: '{"hello":"world"}',
        },
      });

      await recorder.recordWebSocket({
        frame: {
          url: 'wss://us01docs.zoom.us/lynx',
          direction: 'received',
          payload: Buffer.from([1, 2, 3, 4]),
        },
      });

      await recorder.close();

      const lines = (await readFile(outputPath, 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(4);

      const http = JSON.parse(lines[0] as string);
      const wsOpen = JSON.parse(lines[1] as string);
      const wsSent = JSON.parse(lines[2] as string);
      const wsBinary = JSON.parse(lines[3] as string);

      expect(http.kind).toBe('http');
      expect(wsOpen).toMatchObject({
        kind: 'websocket',
        direction: 'open',
        payload: null,
        payloadEncoding: 'none',
        url: 'wss://us01docs.zoom.us/lynx?auth=%3Credacted%3E',
      });
      expect(wsSent).toMatchObject({
        kind: 'websocket',
        direction: 'sent',
        payload: '{"hello":"world"}',
        payloadEncoding: 'text',
      });
      expect(wsBinary).toMatchObject({
        kind: 'websocket',
        direction: 'received',
        payloadEncoding: 'base64',
        payloadBytes: 4,
      });
      expect(Buffer.from(wsBinary.payload, 'base64')).toEqual(Buffer.from([1, 2, 3, 4]));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('skips requests that do not match the default filter', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'zoomdocs-capture-test-'));
    try {
      const outputPath = path.join(dir, 'capture.jsonl');
      const recorder = new CaptureRecorder(outputPath);

      await recorder.record({
        request: {
          method: 'GET',
          url: 'https://docs.zoom.us/static/app.js',
          headers: {},
          body: null,
        },
      });

      expect(recorder.count).toBe(0);
      // file should not exist because nothing was written
      await expect(readFile(outputPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
