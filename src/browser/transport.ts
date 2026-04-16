import { mkdir } from 'node:fs/promises';
import { chromium, type BrowserContext, type Page, type Request, type WebSocket } from 'playwright-core';

import type { RuntimeConfig } from '../config.js';
import type { RequestJsonOptions } from '../zoomdocs/service.js';
import { CaptureRecorder, shouldRecordRequest } from '../zoomdocs/capture.js';
import { collectRememberableNodes, type ZoomDocsNode } from '../zoomdocs/internal-api.js';
import { buildApiReplayHeaders, buildCandidateDocsOrigins, parseCsrfTokenResponse, toAbsoluteUrl } from './helpers.js';
import {
  removeSingletonLockIfExists,
  resolveSingletonLockState,
  singletonLockPath,
} from './profile-lock.js';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForCondition(
  condition: () => boolean,
  {
    timeoutMs,
    intervalMs,
  }: {
    timeoutMs: number;
    intervalMs: number;
  }
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (condition()) return true;
    await sleep(intervalMs);
  }
  return condition();
}

function writeStderr(message: string) {
  process.stderr.write(`[zoomdocs-mcp] ${message}\n`);
}

export function pickReusablePage<T extends { isClosed(): boolean }>(pages: T[]): T | undefined {
  return pages.find((page) => !page.isClosed());
}

export function shouldRecoverFromClosedPageError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Target page, context or browser has been closed');
}

export function buildLaunchOptions({
  headless,
  browserChannel,
}: {
  headless: boolean;
  browserChannel: 'chrome' | 'msedge';
}) {
  return {
    headless,
    channel: browserChannel,
    viewport: { width: 1440, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  } satisfies Parameters<typeof chromium.launchPersistentContext>[1];
}

export function formatBrowserLaunchError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `Could not launch a local browser for Zoom Docs. This MCP expects an installed system browser (for example Google Chrome). Original error: ${detail}`;
}

export class PlaywrightZoomDocsTransport {
  private contextPromise: Promise<BrowserContext> | null = null;
  private csrfTokenByOrigin = new Map<string, string>();
  private preferredBaseUrl: string | null = null;
  private apiReplayHeaders: Record<string, string> = {};
  private readonly instrumentedPages = new WeakSet<Page>();
  private readonly fileHostById = new Map<string, string>();
  private captureRecorder: CaptureRecorder | null = null;
  private captureDetach: (() => void) | null = null;
  private captureStartedAt: string | null = null;

  constructor(private readonly config: RuntimeConfig) {}

  private rememberNodes(nodes: ZoomDocsNode[]) {
    for (const node of nodes) {
      const url = node.fileLink || node.fileClusterApiPrefix;
      if (!url) continue;
      try {
        const parsed = new URL(url);
        this.fileHostById.set(node.id, parsed.origin);
      } catch {
        // ignore malformed host hints
      }
    }
  }

  async dispose() {
    if (this.captureRecorder) {
      this.captureDetach?.();
      this.captureDetach = null;
      await this.captureRecorder.close();
      this.captureRecorder = null;
      this.captureStartedAt = null;
    }

    const context = this.contextPromise ? await this.contextPromise : null;
    await context?.close();
    this.contextPromise = null;
    this.csrfTokenByOrigin.clear();
    this.preferredBaseUrl = null;

    await removeSingletonLockIfExists(singletonLockPath(this.config.userDataDir)).catch(() => undefined);
  }

  isCapturing(): boolean {
    return this.captureRecorder !== null;
  }

  async startCapture({
    outputPath,
  }: {
    outputPath: string;
  }): Promise<{ outputPath: string; startedAt: string }> {
    if (this.captureRecorder) {
      throw new Error(
        `Zoom Docs capture is already running at ${this.captureRecorder.outputPath}. Call stopCapture first.`
      );
    }

    const context = await this.getContext(true);
    const recorder = new CaptureRecorder(outputPath);

    const detachCallbacks: Array<() => void> = [];
    const trackedWebSockets = new WeakSet<WebSocket>();

    const attachWebSocket = (ws: WebSocket, page: Page) => {
      if (trackedWebSockets.has(ws)) return;
      trackedWebSockets.add(ws);

      const fromPageUrl = page.url() || undefined;

      recorder
        .recordWebSocket({
          frame: { url: ws.url(), direction: 'open', payload: null, fromPageUrl },
        })
        .catch(() => undefined);

      const sentHandler = (data: { payload: string | Buffer }) => {
        recorder
          .recordWebSocket({
            frame: { url: ws.url(), direction: 'sent', payload: data.payload, fromPageUrl },
          })
          .catch(() => undefined);
      };

      const receivedHandler = (data: { payload: string | Buffer }) => {
        recorder
          .recordWebSocket({
            frame: { url: ws.url(), direction: 'received', payload: data.payload, fromPageUrl },
          })
          .catch(() => undefined);
      };

      const closeHandler = (_ws: WebSocket) => {
        recorder
          .recordWebSocket({
            frame: { url: ws.url(), direction: 'close', payload: null, fromPageUrl },
          })
          .catch(() => undefined);
      };

      ws.on('framesent', sentHandler);
      ws.on('framereceived', receivedHandler);
      ws.on('close', closeHandler);

      detachCallbacks.push(() => {
        ws.off('framesent', sentHandler);
        ws.off('framereceived', receivedHandler);
        ws.off('close', closeHandler);
      });
    };

    const attachPageWebSockets = (page: Page) => {
      const webSocketHandler = (ws: WebSocket) => attachWebSocket(ws, page);
      page.on('websocket', webSocketHandler);
      detachCallbacks.push(() => page.off('websocket', webSocketHandler));
    };

    for (const page of context.pages()) {
      if (!page.isClosed()) attachPageWebSockets(page);
    }

    const newPageHandler = (page: Page) => attachPageWebSockets(page);
    context.on('page', newPageHandler);
    detachCallbacks.push(() => context.off('page', newPageHandler));

    const finishedHandler = async (request: Request) => {
      if (!shouldRecordRequest(request.url())) return;
      try {
        const response = await request.response().catch(() => null);
        await recorder.record({
          timestamp: new Date().toISOString(),
          request: {
            method: request.method(),
            url: request.url(),
            resourceType: request.resourceType(),
            headers: await request.allHeaders().catch(() => ({})),
            body: request.postData(),
            fromPageUrl: request.frame()?.url(),
          },
          response: response
            ? {
                status: response.status(),
                statusText: response.statusText(),
                headers: await response.allHeaders().catch(() => ({})),
                body: await response.text().catch(() => null),
              }
            : undefined,
        });
      } catch {
        // best-effort; never let capture break the session
      }
    };

    const failedHandler = async (request: Request) => {
      if (!shouldRecordRequest(request.url())) return;
      try {
        await recorder.record({
          timestamp: new Date().toISOString(),
          request: {
            method: request.method(),
            url: request.url(),
            resourceType: request.resourceType(),
            headers: await request.allHeaders().catch(() => ({})),
            body: request.postData(),
            fromPageUrl: request.frame()?.url(),
          },
          failure: request.failure()?.errorText ?? 'unknown failure',
        });
      } catch {
        // best-effort
      }
    };

    context.on('requestfinished', finishedHandler);
    context.on('requestfailed', failedHandler);
    detachCallbacks.push(() => {
      context.off('requestfinished', finishedHandler);
      context.off('requestfailed', failedHandler);
    });

    this.captureDetach = () => {
      for (const detach of detachCallbacks) {
        try {
          detach();
        } catch {
          // ignore teardown errors
        }
      }
    };
    this.captureRecorder = recorder;
    this.captureStartedAt = new Date().toISOString();

    const page = await this.getPage(true);
    try {
      if (!page.url() || page.url() === 'about:blank') {
        await page.goto(this.config.baseUrl, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
      }
    } catch {
      // non-fatal; the user can navigate manually
    }
    await page.bringToFront().catch(() => undefined);

    return { outputPath, startedAt: this.captureStartedAt };
  }

  async stopCapture(): Promise<{ outputPath: string; entriesWritten: number; startedAt: string; stoppedAt: string }> {
    const recorder = this.captureRecorder;
    const startedAt = this.captureStartedAt;
    if (!recorder || !startedAt) {
      throw new Error('No Zoom Docs capture is currently running.');
    }

    this.captureDetach?.();
    this.captureDetach = null;
    await recorder.close();
    this.captureRecorder = null;
    this.captureStartedAt = null;

    return {
      outputPath: recorder.outputPath,
      entriesWritten: recorder.count,
      startedAt,
      stoppedAt: new Date().toISOString(),
    };
  }

  captureStatus(): { active: boolean; outputPath: string | null; startedAt: string | null; entriesWritten: number } {
    return {
      active: this.captureRecorder !== null,
      outputPath: this.captureRecorder?.outputPath ?? null,
      startedAt: this.captureStartedAt,
      entriesWritten: this.captureRecorder?.count ?? 0,
    };
  }

  async ensureLoggedIn(interactive: boolean): Promise<void> {
    if (await this.isAuthenticated()) {
      return;
    }

    if (!interactive) {
      throw new Error('Zoom Docs is not logged in locally. Run the zoomdocs_login tool first.');
    }

    writeStderr('Opening Zoom Docs login window. Complete login in the browser...');
    const page = await this.openOrFocusLoginPage();
    await page.bringToFront();

    const startedAt = Date.now();
    while (Date.now() - startedAt < this.config.loginTimeoutMs) {
      if (await this.isAuthenticated()) {
        writeStderr('Zoom Docs login detected.');
        return;
      }
      await sleep(1500);
    }

    throw new Error(`Timed out waiting for Zoom Docs login after ${Math.round(this.config.loginTimeoutMs / 1000)}s.`);
  }

  async openLogin(): Promise<{ alreadyAuthenticated: boolean }> {
    if (await this.isAuthenticated()) {
      return { alreadyAuthenticated: true };
    }

    writeStderr('Opening Zoom Docs login window. Complete login in the browser, then run zoomdocs_status.');
    const page = await this.openOrFocusLoginPage();
    await page.bringToFront();

    await waitForCondition(() => Boolean(this.apiReplayHeaders.authorization), {
      timeoutMs: 5_000,
      intervalMs: 50,
    });

    return { alreadyAuthenticated: false };
  }

  async requestJson<T>(options: RequestJsonOptions): Promise<T> {
    await this.ensureLoggedIn(false);
    const context = await this.getContext(false);
    const baseUrl = await this.resolveBaseUrl(options.fileId);
    const url = toAbsoluteUrl(baseUrl, options.path);

    const headers: Record<string, string> = {
      Accept: 'application/json, text/plain, */*',
      'X-Requested-With': 'fetch',
      ...this.apiReplayHeaders,
      ...(this.apiReplayHeaders.authorization ? {} : { 'X-Requested-With': 'fetch' }),
    };

    if (this.apiReplayHeaders.origin) {
      headers.origin = this.apiReplayHeaders.origin;
    } else {
      headers.origin = this.config.baseUrl;
    }

    if (this.apiReplayHeaders.referer) {
      headers.referer = this.apiReplayHeaders.referer;
    }

    if (options.headers) {
      Object.assign(headers, options.headers);
    }

    if (options.method !== 'GET') {
      const csrfToken = await this.getCsrfToken(baseUrl);
      if (csrfToken) {
        headers['csrf-token'] = csrfToken;
        headers['x-csrf-token'] = csrfToken;
      }
    }

    const response = await context.request.fetch(url, {
      method: options.method,
      headers,
      data: options.body,
      failOnStatusCode: false,
      timeout: this.config.requestTimeoutMs,
    });

    const text = await response.text();
    if (!response.ok()) {
      if (response.status() === 401 || response.status() === 403) {
        throw new Error(`Zoom Docs request failed (${response.status()}). Your local browser session may have expired; run zoomdocs_login again.`);
      }
      throw new Error(`Zoom Docs request failed (${response.status()} ${response.statusText()}): ${text.slice(0, 1000)}`);
    }

    try {
      const parsed = JSON.parse(text) as T;
      this.rememberNodes(collectRememberableNodes(parsed));
      return parsed;
    } catch {
      return text as T;
    }
  }

  private async resolveBaseUrl(fileId?: string): Promise<string> {
    if (fileId && fileId !== 'my-docs') {
      return this.fileHostById.get(fileId) || this.preferredBaseUrl || this.config.baseUrl;
    }

    return this.preferredBaseUrl || this.config.baseUrl;
  }

  private async getCsrfToken(baseUrl: string): Promise<string | null> {
    const cached = this.csrfTokenByOrigin.get(baseUrl);
    if (cached) return cached;

    const context = await this.getContext(false);
    const response = await context.request.post(toAbsoluteUrl(baseUrl, '/csrf_js'), {
      headers: {
        'fetch-csrf-token': '1',
      },
      failOnStatusCode: false,
      timeout: this.config.requestTimeoutMs,
    });

    if (!response.ok()) {
      return null;
    }

    const token = parseCsrfTokenResponse(await response.text());
    this.csrfTokenByOrigin.set(baseUrl, token);
    return token;
  }

  private async isAuthenticated(): Promise<boolean> {
    const context = await this.getContext(false);
    const candidateOrigins = buildCandidateDocsOrigins({
      baseUrl: this.config.baseUrl,
      pageUrls: context.pages().filter((page) => !page.isClosed()).map((page) => page.url()).filter(Boolean),
      cookieDomains: (await context.cookies()).map((cookie) => cookie.domain),
      rememberedOrigins: [
        ...(this.preferredBaseUrl ? [this.preferredBaseUrl] : []),
        ...this.fileHostById.values(),
      ],
    });

    const headers: Record<string, string> = {
      Accept: 'application/json, text/plain, */*',
      ...this.apiReplayHeaders,
    };

    for (const origin of candidateOrigins) {
      const response = await context.request.get(toAbsoluteUrl(origin, '/api/file/my_space'), {
        failOnStatusCode: false,
        timeout: this.config.requestTimeoutMs,
        headers,
      });

      if (!response.ok()) continue;
      const contentType = response.headers()['content-type'] || '';
      if (!contentType.includes('application/json')) continue;

      const text = await response.text();
      if (!text.includes('"mySpace"')) continue;

      this.preferredBaseUrl = origin;
      return true;
    }

    return false;
  }

  private async getPage(interactive: boolean): Promise<Page> {
    const context = await this.getContext(interactive);
    const page = pickReusablePage(context.pages()) ?? await context.newPage();
    this.instrumentPage(page);
    return page;
  }

  private async createFreshPage(interactive: boolean): Promise<Page> {
    const context = await this.getContext(interactive);
    const page = await context.newPage();
    this.instrumentPage(page);
    return page;
  }

  private instrumentPage(page: Page): void {
    if (this.instrumentedPages.has(page)) return;
    this.instrumentedPages.add(page);

    page.on('request', async (request) => {
      if (!request.url().includes('/api/')) return;
      try {
        const headers = buildApiReplayHeaders(await request.allHeaders());
        if (!headers.authorization) return;

        this.apiReplayHeaders = { ...this.apiReplayHeaders, ...headers };

        const origin = new URL(request.url()).origin;
        if (origin.endsWith('docs.zoom.us')) {
          this.preferredBaseUrl = origin;
        }
      } catch {
        // best-effort only
      }
    });
  }

  private async openOrFocusLoginPage(): Promise<Page> {
    let page = await this.getPage(true);

    try {
      await page.goto(this.config.baseUrl, { waitUntil: 'domcontentloaded' });
    } catch (error) {
      if (!shouldRecoverFromClosedPageError(error)) {
        throw error;
      }

      page = await this.createFreshPage(true);
      await page.goto(this.config.baseUrl, { waitUntil: 'domcontentloaded' });
    }

    return page;
  }

  private async getContext(interactive: boolean): Promise<BrowserContext> {
    if (!this.contextPromise) {
      this.contextPromise = this.launchContext(interactive);
    }
    return this.contextPromise;
  }

  private async launchContext(interactive: boolean): Promise<BrowserContext> {
    await mkdir(this.config.userDataDir, { recursive: true });
    await this.ensureProfileLockClear();

    const requestedHeadless = interactive ? false : this.config.headless;
    const launchOptions = buildLaunchOptions({
      headless: requestedHeadless,
      browserChannel: this.config.browserChannel ?? 'chrome',
    });

    try {
      const context = await chromium.launchPersistentContext(this.config.userDataDir, launchOptions);
      context.setDefaultTimeout(this.config.requestTimeoutMs);
      return context;
    } catch (error) {
      throw new Error(formatBrowserLaunchError(error));
    }
  }

  private async ensureProfileLockClear(): Promise<void> {
    const lockPath = singletonLockPath(this.config.userDataDir);
    const state = await resolveSingletonLockState({ lockPath });

    if (state.kind === 'missing') return;

    if (state.kind === 'stale' || state.kind === 'unparsable') {
      await removeSingletonLockIfExists(lockPath);
      writeStderr(
        state.kind === 'stale'
          ? `Removed stale browser-profile lock (pid ${state.pid} no longer running).`
          : `Removed unrecognized browser-profile lock (target: ${state.target}).`
      );
      return;
    }

    throw new Error(
      `Zoom Docs browser profile at ${this.config.userDataDir} is in use by pid ${state.pid} (host ${state.hostname}). ` +
        `Quit that process (or run 'kill ${state.pid}') and try again. ` +
        `If you are sure nothing is running, delete ${lockPath}.`
    );
  }
}
