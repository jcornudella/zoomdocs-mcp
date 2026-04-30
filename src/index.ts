#!/usr/bin/env node

import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { chromium } from 'playwright-core';
import { z } from 'zod';

import {
  DEFAULT_MCP_SERVER_NAME,
  buildClaudeDesktopServerConfig,
  detectClaudeDesktopServerMode,
  getClaudeDesktopConfigPath,
  getConfigPaths,
  getRuntimeConfig,
  type ClaudeDesktopConfig,
  type ClaudeDesktopSetupMode,
  type ClaudeDesktopServerConfig,
  upsertClaudeDesktopConfig,
} from './config.js';
import {
  buildLaunchOptions,
  formatBrowserLaunchError,
  PlaywrightZoomDocsTransport,
} from './browser/transport.js';
import { defaultCaptureFilePath } from './zoomdocs/capture.js';
import {
  formatAccessInfoText,
  formatAddCommentReactionText,
  formatAddDocCommentText,
  formatAddInlineCommentText,
  formatAddUserCollaboratorText,
  formatCommentsText,
  formatDeleteCommentText,
  formatEditDocBatchText,
  formatEditDocText,
  formatEditOutlineText,
  formatListText,
  formatMetadataText,
  formatRemoveUserCollaboratorText,
  formatReopenCommentThreadText,
  formatReplyToCommentText,
  formatResolveCommentThreadText,
  formatSearchText,
  formatSetPermissionAccessText,
  formatSetUserCollaboratorRoleText,
  formatShareTargetSearchText,
} from './zoomdocs/format.js';
import { ZoomDocsService } from './zoomdocs/service.js';
import { runVersionCheck } from './version-check.js';

const CLAUDE_CONFIG_PATH_ENV = 'ZOOMDOCS_MCP_CLAUDE_CONFIG_PATH';
const PACKAGE_SPEC_ENV = 'ZOOMDOCS_MCP_PACKAGE_SPEC';
const VERSION_CHECK_OPT_OUT_ENV = 'ZOOMDOCS_MCP_DISABLE_VERSION_CHECK';
const DEBUG_TOOLS_ENV = 'ZOOMDOCS_MCP_DEBUG_TOOLS';

let cachedPackageMetadata: { name: string; version: string } | null = null;

async function readPackageMetadata(): Promise<{ name: string; version: string }> {
  if (cachedPackageMetadata) return cachedPackageMetadata;
  try {
    const raw = await readFile(new URL('../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
    cachedPackageMetadata = {
      name: typeof parsed.name === 'string' && parsed.name ? parsed.name : '@jcornudella/zoomdocs-mcp',
      version: typeof parsed.version === 'string' && parsed.version ? parsed.version : '0.0.0',
    };
  } catch {
    cachedPackageMetadata = { name: '@jcornudella/zoomdocs-mcp', version: '0.0.0' };
  }
  return cachedPackageMetadata;
}

async function getVersion(): Promise<string> {
  return (await readPackageMetadata()).version;
}

function versionCheckDisabled(): boolean {
  const value = process.env[VERSION_CHECK_OPT_OUT_ENV];
  if (!value) return false;
  return value === '1' || value.toLowerCase() === 'true';
}

function debugToolsEnabled(): boolean {
  const value = process.env[DEBUG_TOOLS_ENV];
  if (!value) return false;
  return value === '1' || value.toLowerCase() === 'true';
}

function toStructuredContent(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

async function resolvePackageSpec(): Promise<string> {
  if (process.env[PACKAGE_SPEC_ENV]) {
    return process.env[PACKAGE_SPEC_ENV] as string;
  }
  return (await readPackageMetadata()).name;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveLocalCliEntryPath(): Promise<string | null> {
  const currentModulePath = fileURLToPath(import.meta.url);
  const packageRoot = currentModulePath.endsWith(`${path.sep}src${path.sep}index.ts`) ||
    currentModulePath.endsWith(`${path.sep}dist${path.sep}index.js`)
    ? path.resolve(path.dirname(currentModulePath), '..')
    : null;

  if (!packageRoot) {
    return null;
  }

  const sourceEntryPath = path.join(packageRoot, 'src', 'index.ts');
  if (!(await pathExists(sourceEntryPath))) {
    return null;
  }

  const distEntryPath = path.join(packageRoot, 'dist', 'index.js');
  if (!(await pathExists(distEntryPath))) {
    throw new Error(`Local Claude Desktop setup requires a built dist/index.js at ${distEntryPath}. Run npm run build first.`);
  }

  return distEntryPath;
}

async function resolveClaudeDesktopServerConfig(
  setupMode: 'auto' | ClaudeDesktopSetupMode,
  packageSpec: string
): Promise<{
  mode: ClaudeDesktopSetupMode;
  serverConfig: ClaudeDesktopServerConfig;
}> {
  const localEntryPath = setupMode === 'package' ? null : await resolveLocalCliEntryPath();
  const mode = setupMode === 'auto' ? (localEntryPath ? 'local' : 'package') : setupMode;

  if (mode === 'local') {
    if (!localEntryPath) {
      throw new Error('Could not resolve a local dist/index.js entry for Claude Desktop setup. Run this from the local checkout and build it first.');
    }

    return {
      mode,
      serverConfig: buildClaudeDesktopServerConfig({
        mode,
        packageSpec,
        localEntryPath,
      }),
    };
  }

  return {
    mode,
    serverConfig: buildClaudeDesktopServerConfig({
      mode,
      packageSpec,
      localEntryPath: '',
    }),
  };
}

function formatClaudeDesktopLaunch(serverConfig: ClaudeDesktopServerConfig): string {
  return [serverConfig.command, ...(serverConfig.args || [])].join(' ').trim();
}

async function loadClaudeDesktopConfig(configPath: string): Promise<{
  config: ClaudeDesktopConfig;
  exists: boolean;
  rawText: string | null;
}> {
  try {
    const rawText = await readFile(configPath, 'utf8');
    return {
      config: JSON.parse(rawText) as ClaudeDesktopConfig,
      exists: true,
      rawText,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        config: {},
        exists: false,
        rawText: null,
      };
    }

    throw new Error(
      `Could not read Claude Desktop config at ${configPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function runSetupClaude(setupMode: 'auto' | ClaudeDesktopSetupMode = 'auto'): Promise<void> {
  const configPath = process.env[CLAUDE_CONFIG_PATH_ENV] || getClaudeDesktopConfigPath();
  const packageSpec = await resolvePackageSpec();
  const { mode, serverConfig } = await resolveClaudeDesktopServerConfig(setupMode, packageSpec);
  const current = await loadClaudeDesktopConfig(configPath);
  const nextConfig = upsertClaudeDesktopConfig(current.config, { serverConfig });
  const nextText = `${JSON.stringify(nextConfig, null, 2)}\n`;

  let action: 'created' | 'updated' | 'unchanged' = current.exists ? 'updated' : 'created';
  if (current.rawText === nextText) {
    action = 'unchanged';
  } else {
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, nextText, 'utf8');
  }

  process.stdout.write(
    [
      `${action === 'created' ? 'Created' : action === 'updated' ? 'Updated' : 'Verified'} Claude Desktop config: ${configPath}`,
      `Configured MCP server "${DEFAULT_MCP_SERVER_NAME}" in ${mode} mode: ${formatClaudeDesktopLaunch(serverConfig)}`,
      mode === 'local'
        ? 'Claude Desktop will launch this local checkout via its built dist/index.js entry.'
        : `Claude Desktop will launch the published package via npx -y ${packageSpec}.`,
      'Restart Claude Desktop if it is already open.',
      'On first use, the agent may open a browser window so you can log into Zoom once; the local browser profile is then reused until Zoom expires the session.',
    ].join('\n') + '\n'
  );
}

async function runDoctor(): Promise<void> {
  const config = getRuntimeConfig({
    ...process.env,
    ZOOMDOCS_MCP_HEADLESS: 'true',
  });
  const configPath = process.env[CLAUDE_CONFIG_PATH_ENV] || getClaudeDesktopConfigPath();
  const packageSpec = await resolvePackageSpec();

  let claudeConfigStatus = `missing (${configPath})`;
  let claudeConfigCompatible = false;
  try {
    const current = await loadClaudeDesktopConfig(configPath);
    const currentServer = current.config.mcpServers?.[DEFAULT_MCP_SERVER_NAME] as Record<string, unknown> | undefined;
    const localEntryPath = await resolveLocalCliEntryPath().catch(() => null);
    const detectedMode = detectClaudeDesktopServerMode(currentServer, {
      packageSpec,
      localEntryPath: localEntryPath || '__local-entry-unavailable__',
    });

    if (detectedMode) {
      claudeConfigCompatible = true;
      claudeConfigStatus = `configured (${detectedMode}; ${configPath})`;
    } else if (currentServer) {
      claudeConfigStatus = `present but incompatible/unverified ${DEFAULT_MCP_SERVER_NAME} entry (${configPath})`;
    } else if (current.exists) {
      claudeConfigStatus = `present but missing ${DEFAULT_MCP_SERVER_NAME} entry (${configPath})`;
    }
  } catch (error) {
    claudeConfigStatus = `error (${error instanceof Error ? error.message : String(error)})`;
  }

  const tempProfileDir = await mkdtemp(path.join(os.tmpdir(), 'zoomdocs-mcp-doctor-'));
  let browserStatus = 'ok';
  try {
    const context = await chromium.launchPersistentContext(
      tempProfileDir,
      buildLaunchOptions({
        headless: true,
        browserChannel: config.browserChannel ?? 'chrome',
      })
    );
    await context.close();
  } catch (error) {
    browserStatus = formatBrowserLaunchError(error);
  } finally {
    await rm(tempProfileDir, { recursive: true, force: true });
  }

  const { name: packageName, version: currentVersion } = await readPackageMetadata();

  let versionStatus: string;
  let versionOutdated = false;
  if (versionCheckDisabled()) {
    versionStatus = `skipped (${VERSION_CHECK_OPT_OUT_ENV}=1)`;
  } else {
    const versionResult = await runVersionCheck({ packageName, currentVersion });
    if (versionResult.latest == null) {
      versionStatus = 'could not reach npm registry';
    } else if (versionResult.outdated) {
      versionStatus = `update available: ${versionResult.current} -> ${versionResult.latest}`;
      versionOutdated = true;
    } else {
      versionStatus = `up to date (${versionResult.current})`;
    }
  }

  const lines = [
    `Zoom Docs MCP doctor (${currentVersion})`,
    `- Claude Desktop config: ${claudeConfigStatus}`,
    `- Browser launch: ${browserStatus}`,
    `- Local Zoom session profile: ${config.userDataDir}`,
    `- Package version: ${versionStatus}`,
  ];

  if (versionOutdated) {
    lines.push(
      '',
      `Upgrade: quit Claude Desktop and relaunch it (the npx-based config will fetch the latest on next launch).`,
      `If you installed via 'setup claude --local', run 'git pull && npm install && npm run build' in the local checkout.`
    );
  }

  process.stdout.write(`${lines.join('\n')}\n`);
  if (claudeConfigStatus.startsWith('error') || !claudeConfigCompatible || browserStatus !== 'ok') {
    process.exitCode = 1;
  }
}

function printHelp(): void {
  process.stdout.write(
    [
      'zoomdocs-mcp',
      '',
      'Usage:',
      '  zoomdocs-mcp                            Start the MCP stdio server',
      '  zoomdocs-mcp setup claude [--local]     Add/update the Claude Desktop MCP config entry for this local checkout',
      '  zoomdocs-mcp setup claude [--package]   Add/update the Claude Desktop MCP config entry via npx',
      '  zoomdocs-mcp doctor                     Check Claude config + local browser availability',
      '  zoomdocs-mcp --version       Print the current version',
    ].join('\n') + '\n'
  );
}

const pendingUpdateNotice: { current: string | null } = { current: null };

async function emitVersionWarningIfOutdated(): Promise<void> {
  if (versionCheckDisabled()) return;
  try {
    const { name: packageName, version: currentVersion } = await readPackageMetadata();
    const result = await runVersionCheck({ packageName, currentVersion });
    if (result.notice) {
      pendingUpdateNotice.current = result.notice;
      process.stderr.write(`[zoomdocs-mcp] ${result.notice}\n`);
    }
  } catch {
    // Best-effort; never block startup on version-check failures.
  }
}

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
};

function attachUpdateNoticeIfPending<T extends ToolResult>(result: T): T {
  const notice = pendingUpdateNotice.current;
  if (!notice) return result;
  pendingUpdateNotice.current = null;
  return {
    ...result,
    content: [
      ...result.content,
      {
        type: 'text',
        text:
          `\n\n[zoomdocs-mcp update available] ${notice}\n` +
          `Please tell the user this MCP server is out of date and they need to upgrade it as described above (in most cases: quit Claude Desktop and relaunch it).`,
      },
    ],
  };
}

async function runMcpServer() {
  const config = getRuntimeConfig();
  const transport = new PlaywrightZoomDocsTransport(config);
  const service = new ZoomDocsService(transport);

  void emitVersionWarningIfOutdated();

  const { version: currentVersion } = await readPackageMetadata();
  const server = new McpServer({
    name: 'zoomdocs-mcp',
    version: currentVersion,
  });

  const registerTool: typeof server.registerTool = ((
    name: string,
    config: Parameters<typeof server.registerTool>[1],
    handler: (args: unknown) => Promise<ToolResult>
  ) =>
    server.registerTool(
      name as Parameters<typeof server.registerTool>[0],
      config,
      (async (args: unknown) =>
        attachUpdateNoticeIfPending(await handler(args))) as Parameters<
        typeof server.registerTool
      >[2]
    )) as typeof server.registerTool;

  const registerDebugTool: typeof server.registerTool = ((
    name: string,
    config: Parameters<typeof server.registerTool>[1],
    handler: (args: unknown) => Promise<ToolResult>
  ) => {
    if (!debugToolsEnabled()) return undefined;
    return registerTool(name as Parameters<typeof server.registerTool>[0], config, handler as never);
  }) as typeof server.registerTool;

  registerTool(
    'zoomdocs_login',
    {
      title: 'Zoom Docs Login',
      description:
        'Use this only when another Zoom Docs tool says authentication is required. It opens or focuses the local Zoom Docs browser window so the user can log in, and that browser profile is reused across future sessions until Zoom expires it.',
      inputSchema: {},
    },
    async () => {
      const result = await service.login();
      return {
        content: [
          {
            type: 'text',
            text:
              result.status === 'already_authenticated'
                ? 'Zoom Docs is already authenticated in the local browser profile.'
                : 'Opened the local Zoom Docs browser window. Finish login there, then run zoomdocs_status.',
          },
        ],
        structuredContent: { ...result },
      };
    }
  );

  registerTool(
    'zoomdocs_status',
    {
      title: 'Zoom Docs Status',
      description: 'Check whether the local Zoom Docs browser session is authenticated. Use this after zoomdocs_login or when diagnosing auth issues.',
      inputSchema: {},
    },
    async () => {
      await service.status();
      return {
        content: [{ type: 'text', text: 'Zoom Docs local browser session is authenticated.' }],
        structuredContent: { ok: true },
      };
    }
  );

  registerTool(
    'zoomdocs_search',
    {
      title: 'Zoom Docs Search',
      description:
        'Use this first when the user mentions a Zoom Doc by name, topic, or content but does not provide an exact file ID or URL. Runs native Zoom Docs full-text search across the account (titles and body content as indexed by Zoom) and returns ranked results so the agent can resolve the right doc before reading or writing.',
      inputSchema: {
        query: z.string().describe('Natural-language query to search for. Matches titles and indexed body content.'),
        page_size: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Maximum number of results to return (1-50). Defaults to 10.'),
        file_types: z
          .array(z.enum(['doc', 'classicDoc', 'page', 'database', 'folder']))
          .optional()
          .describe(
            'Restrict results by Zoom file type. Defaults to ["database","classicDoc","doc","page"] which matches the Zoom Docs UI behavior.'
          ),
        include_deleted: z
          .boolean()
          .optional()
          .describe('Include docs that have been moved to trash. Defaults to false.'),
      },
    },
    async ({ query, page_size, file_types, include_deleted }) => {
      const result = await service.search({
        query,
        pageSize: page_size,
        fileTypes: file_types,
        includeDeleted: include_deleted,
      });

      return {
        content: [{ type: 'text', text: formatSearchText(result) }],
        structuredContent: toStructuredContent(result),
      };
    }
  );

  registerTool(
    'zoomdocs_list',
    {
      title: 'Zoom Docs List',
      description: 'List Zoom Docs files/folders under root or a specific folder. Use this when folder structure matters more than fuzzy title search.',
      inputSchema: {
        parent_id: z.string().optional().describe('Folder ID or Zoom Docs folder URL. Defaults to my-docs.'),
      },
    },
    async ({ parent_id }) => {
      const result = await service.list({ parentId: parent_id });
      return {
        content: [{ type: 'text', text: formatListText(result.parentId, result.items) }],
        structuredContent: toStructuredContent(result),
      };
    }
  );

  registerTool(
    'zoomdocs_get_metadata',
    {
      title: 'Zoom Docs Get Metadata',
      description: 'Fetch metadata for a Zoom Docs file by ID or URL. Use this when the user already gave an exact file identifier or URL.',
      inputSchema: {
        file_id: z.string().describe('Zoom Docs file ID or URL.'),
      },
    },
    async ({ file_id }) => {
      const result = await service.getMetadata({ fileId: file_id });
      return {
        content: [{ type: 'text', text: formatMetadataText(result) }],
        structuredContent: toStructuredContent(result),
      };
    }
  );

  registerTool(
    'zoomdocs_get_edit_outline',
    {
      title: 'Zoom Docs Get Edit Outline',
      description:
        'Read a Zoom Doc structure as agent-friendly editable refs. Use this before zoomdocs_edit_doc when exact text is hard to target; then pass target.by = "ref" with one of the returned refs.',
      inputSchema: {
        file_id: z.string().describe('Zoom Docs file ID or URL.'),
      },
    },
    async ({ file_id }) => {
      const result = await service.getEditOutline({ fileId: file_id });
      return {
        content: [{ type: 'text', text: formatEditOutlineText(result) }],
        structuredContent: toStructuredContent(result),
      };
    }
  );

  registerTool(
    'zoomdocs_get_access_info',
    {
      title: 'Zoom Docs Get Access Info',
      description:
        'Read sharing, collaborator, link-access, publish-status, and pending permission-request state for a Zoom Doc. This is read-only and should be used before changing permissions.',
      inputSchema: {
        file_id: z.string().describe('Zoom Docs file ID or URL.'),
      },
    },
    async ({ file_id }) => {
      const result = await service.getAccessInfo({ fileId: file_id });
      return {
        content: [{ type: 'text', text: formatAccessInfoText(result) }],
        structuredContent: toStructuredContent(result),
      };
    }
  );

  registerTool(
    'zoomdocs_get_comments',
    {
      title: 'Zoom Docs Get Comments',
      description:
        'Read open or resolved comments from a Zoom Doc. This is read-only. It extracts inline comment thread refs from the doc content and reads thread/comment data without mutating the document.',
      inputSchema: {
        file_id: z.string().describe('Zoom Docs file ID or URL.'),
        thread_status: z.enum(['open', 'resolved']).optional().describe('Which comment threads to read. Defaults to open.'),
        thread_id: z.string().optional().describe('Optional exact thread ID to return. Useful after mutations or when a doc has many comments.'),
      },
    },
    async ({ file_id, thread_status, thread_id }) => {
      const result = await service.getComments({ fileId: file_id, threadStatus: thread_status, threadId: thread_id });
      return {
        content: [{ type: 'text', text: formatCommentsText(result) }],
        structuredContent: toStructuredContent(result),
      };
    }
  );

  registerTool(
    'zoomdocs_add_doc_comment',
    {
      title: 'Zoom Docs Add Whole-Doc Comment',
      description:
        'Add a whole-doc comment to a Zoom Doc, then read comments back to verify. Supports plain text, explicit mention content parts, and local file attachments. This does not create inline/anchored comments or permission changes.',
      inputSchema: {
        file_id: z.string().describe('Exact Zoom Docs file ID or URL.'),
        text: z.string().optional().describe('Plain-text comment body. Required unless content_parts is provided.'),
        content_parts: z
          .array(
            z.discriminatedUnion('type', [
              z.object({ type: z.literal('text'), text: z.string() }),
              z.object({
                type: z.literal('mention'),
                user_id: z.string().describe('Explicit Zoom user ID to mention. Resolve with zoomdocs_search_share_targets first.'),
                name: z.string().describe('Display name for the mention payload.'),
                notify: z.boolean().optional().describe('Whether Zoom should notify the mentioned user. Defaults to true.'),
              }),
            ])
          )
          .optional()
          .describe('Rich comment content parts. Use explicit mention parts instead of free-form @ lookup.'),
        attachments: z
          .array(
            z.object({
              path: z.string().describe('Local path to upload as a Zoom Docs comment attachment.'),
              name: z.string().optional().describe('Attachment display name. Defaults to local basename.'),
              content_type: z.string().optional().describe('MIME type. Inferred from extension when omitted.'),
            })
          )
          .optional()
          .describe('Local files to upload and attach to the comment.'),
      },
    },
    async ({ file_id, text, content_parts, attachments }) => {
      const result = await service.addDocComment({
        fileId: file_id,
        text,
        contentParts: content_parts?.map((part) =>
          part.type === 'mention'
            ? { type: 'mention', userId: part.user_id, name: part.name, notify: part.notify }
            : { type: 'text', text: part.text }
        ),
        attachments: attachments?.map((attachment) => ({
          path: attachment.path,
          name: attachment.name,
          contentType: attachment.content_type,
        })),
      });
      return {
        content: [{ type: 'text', text: formatAddDocCommentText(result) }],
        structuredContent: toStructuredContent(result),
      };
    }
  );

  registerTool(
    'zoomdocs_reply_to_comment',
    {
      title: 'Zoom Docs Reply To Comment',
      description:
        'Add a plain-text reply to an existing Zoom Docs comment, then read comments back to verify. Requires explicit file_id, thread_id, and parent_comment_id from zoomdocs_get_comments. Does not support mentions or attachments in replies yet.',
      inputSchema: {
        file_id: z.string().describe('Exact Zoom Docs file ID or URL.'),
        thread_id: z.string().describe('Comment thread ID from zoomdocs_get_comments.'),
        parent_comment_id: z.string().describe('Existing comment ID to reply to, from zoomdocs_get_comments.'),
        text: z.string().min(1).describe('Plain-text reply body.'),
        thread_status: z.enum(['open', 'resolved']).optional().describe('Status bucket where the parent comment currently lives. Defaults to open.'),
      },
    },
    async ({ file_id, thread_id, parent_comment_id, text, thread_status }) => {
      const result = await service.replyToComment({
        fileId: file_id,
        threadId: thread_id,
        parentCommentId: parent_comment_id,
        text,
        threadStatus: thread_status,
      });
      return {
        content: [{ type: 'text', text: formatReplyToCommentText(result) }],
        structuredContent: toStructuredContent(result),
      };
    }
  );

  registerTool(
    'zoomdocs_resolve_comment_thread',
    {
      title: 'Zoom Docs Resolve Comment Thread',
      description:
        'Resolve an existing Zoom Docs comment thread, then read the resolved comments bucket back to verify. Requires explicit file_id and thread_id from zoomdocs_get_comments.',
      inputSchema: {
        file_id: z.string().describe('Exact Zoom Docs file ID or URL.'),
        thread_id: z.string().describe('Comment thread ID from zoomdocs_get_comments.'),
      },
    },
    async ({ file_id, thread_id }) => {
      const result = await service.resolveCommentThread({ fileId: file_id, threadId: thread_id });
      return {
        content: [{ type: 'text', text: formatResolveCommentThreadText(result) }],
        structuredContent: toStructuredContent(result),
      };
    }
  );

  registerTool(
    'zoomdocs_reopen_comment_thread',
    {
      title: 'Zoom Docs Reopen Comment Thread',
      description:
        'Reopen a resolved Zoom Docs comment thread, then read the open comments bucket back to verify. Requires explicit file_id and thread_id from zoomdocs_get_comments. This was replay-verified on a disposable test doc.',
      inputSchema: {
        file_id: z.string().describe('Exact Zoom Docs file ID or URL.'),
        thread_id: z.string().describe('Resolved comment thread ID from zoomdocs_get_comments.'),
      },
    },
    async ({ file_id, thread_id }) => {
      const result = await service.reopenCommentThread({ fileId: file_id, threadId: thread_id });
      return {
        content: [{ type: 'text', text: formatReopenCommentThreadText(result) }],
        structuredContent: toStructuredContent(result),
      };
    }
  );

  registerTool(
    'zoomdocs_delete_comment',
    {
      title: 'Zoom Docs Delete Comment',
      description:
        'Delete a non-root Zoom Docs comment/reply, then read comments back to verify it is gone. Requires explicit file_id, thread_id, and comment_id from zoomdocs_get_comments. Root comment / whole-thread deletion is intentionally refused until separately replay-verified.',
      inputSchema: {
        file_id: z.string().describe('Exact Zoom Docs file ID or URL.'),
        thread_id: z.string().describe('Comment thread ID from zoomdocs_get_comments.'),
        comment_id: z.string().describe('Non-root comment/reply ID to delete, from zoomdocs_get_comments.'),
        thread_status: z.enum(['open', 'resolved']).optional().describe('Status bucket where the comment currently lives. Defaults to open.'),
      },
    },
    async ({ file_id, thread_id, comment_id, thread_status }) => {
      const result = await service.deleteComment({
        fileId: file_id,
        threadId: thread_id,
        commentId: comment_id,
        threadStatus: thread_status,
      });
      return {
        content: [{ type: 'text', text: formatDeleteCommentText(result) }],
        structuredContent: toStructuredContent(result),
      };
    }
  );

  registerTool(
    'zoomdocs_add_inline_comment',
    {
      title: 'Zoom Docs Add Inline Comment',
      description:
        'Add an inline/anchored comment to a unique selected substring in one simple editable block, then read comments back to verify. Prefer target.by = ref from zoomdocs_get_edit_outline. Fails closed for ambiguous text or existing inline-rich blocks; if marker insertion fails after thread creation, it resolves the orphan thread before returning ok:false.',
      inputSchema: {
        file_id: z.string().describe('Exact Zoom Docs file ID or URL.'),
        target: z
          .discriminatedUnion('by', [
            z.object({
              by: z.literal('exact_text'),
              value: z.string().describe('Exact visible block text containing selected_text. No fuzzy matching is applied.'),
              within_heading: z.string().optional().describe('Optional exact heading text used only to disambiguate repeated visible text.'),
            }),
            z.object({
              by: z.literal('heading'),
              value: z.string().describe('Exact visible heading text containing selected_text.'),
            }),
            z.object({
              by: z.literal('ref'),
              value: z.string().describe('Editable ref returned by zoomdocs_get_edit_outline, for example h2:plan/p1.'),
            }),
          ])
          .describe('High-level locator for the block to anchor the inline comment in. Prefer ref; do not pass block IDs.'),
        selected_text: z.string().min(1).describe('Exact visible substring to anchor the comment to. Must occur exactly once in the matched block.'),
        text: z.string().min(1).describe('Plain-text comment body. Mentions and attachments are not supported for inline comments yet.'),
      },
    },
    async ({ file_id, target, selected_text, text }) => {
      const result = await service.addInlineComment({
        fileId: file_id,
        target,
        selectedText: selected_text,
        text,
      });
      return {
        content: [{ type: 'text', text: formatAddInlineCommentText(result) }],
        structuredContent: toStructuredContent(result),
      };
    }
  );

  registerTool(
    'zoomdocs_add_comment_reaction',
    {
      title: 'Zoom Docs Add Comment Reaction',
      description:
        'Add an emoji reaction to an existing Zoom Docs comment, then read comments back to verify. Requires explicit file_id, thread_id, and comment_id from zoomdocs_get_comments.',
      inputSchema: {
        file_id: z.string().describe('Exact Zoom Docs file ID or URL.'),
        thread_id: z.string().describe('Comment thread ID from zoomdocs_get_comments.'),
        comment_id: z.string().describe('Comment ID from zoomdocs_get_comments.'),
        reaction: z.string().min(1).describe('Emoji reaction to add, for example 💙.'),
        thread_status: z.enum(['open', 'resolved']).optional().describe('Status bucket to read back for verification. Defaults to open.'),
      },
    },
    async ({ file_id, thread_id, comment_id, reaction, thread_status }) => {
      const result = await service.addCommentReaction({
        fileId: file_id,
        threadId: thread_id,
        commentId: comment_id,
        reaction,
        threadStatus: thread_status,
      });
      return {
        content: [{ type: 'text', text: formatAddCommentReactionText(result) }],
        structuredContent: toStructuredContent(result),
      };
    }
  );

  registerTool(
    'zoomdocs_search_share_targets',
    {
      title: 'Zoom Docs Search Share Targets',
      description:
        'Search Zoom users and channels that can be selected in the Share dialog. This is read-only. Use it to resolve a user_id before inviting a specific collaborator.',
      inputSchema: {
        query: z.string().describe('Name or email fragment to search for in Zoom contacts/channels.'),
      },
    },
    async ({ query }) => {
      const result = await service.searchShareTargets({ query });
      return {
        content: [{ type: 'text', text: formatShareTargetSearchText(result) }],
        structuredContent: toStructuredContent(result),
      };
    }
  );

  registerTool(
    'zoomdocs_set_link_access',
    {
      title: 'Zoom Docs Set Link Access',
      description:
        'Set account-level or anyone-with-link access for a specific Zoom Doc, then read permissions back to verify. Use zoomdocs_get_access_info first. Requires an explicit file_id/URL and only changes link/account access; it does not invite collaborators, remove collaborators, transfer ownership, or publish the doc.',
      inputSchema: {
        file_id: z.string().describe('Exact Zoom Docs file ID or URL. Do not use fuzzy search inside this mutating tool.'),
        scope: z
          .enum(['account', 'anyone_with_link'])
          .describe('Which access scope to change: Zoom account/org access or anyone-with-link access.'),
        role: z
          .enum(['noAccess', 'viewer', 'commenter', 'editor'])
          .describe('Access role to set for the selected scope. Use noAccess to disable link access.'),
      },
    },
    async ({ file_id, scope, role }) => {
      const result = await service.setPermissionAccess({ fileId: file_id, scope, role });
      return {
        content: [{ type: 'text', text: formatSetPermissionAccessText(result) }],
        structuredContent: toStructuredContent(result),
      };
    }
  );

  registerDebugTool(
    'zoomdocs_set_permission_access',
    {
      title: 'Zoom Docs Set Permission Access (debug)',
      description:
        'DEBUG/replay alias for zoomdocs_set_link_access using the captured Zoom Docs permission endpoint. Kept for endpoint replay/debugging.',
      inputSchema: {
        file_id: z.string().describe('Zoom Docs file ID or URL.'),
        scope: z
          .enum(['account', 'anyone_with_link'])
          .describe('Which link-access setting to change: Zoom account/org access or anyone-with-link access.'),
        role: z
          .enum(['noAccess', 'viewer', 'commenter', 'editor'])
          .describe('Access role to set for the selected scope.'),
      },
    },
    async ({ file_id, scope, role }) => {
      const result = await service.setPermissionAccess({ fileId: file_id, scope, role });
      return {
        content: [{ type: 'text', text: formatSetPermissionAccessText(result) }],
        structuredContent: toStructuredContent(result),
      };
    }
  );

  registerTool(
    'zoomdocs_add_user_collaborator',
    {
      title: 'Zoom Docs Add User Collaborator',
      description:
        'Invite a specific Zoom user collaborator to a doc, then read permissions back to verify. Requires an explicit file_id and user_id from zoomdocs_search_share_targets. This only adds user collaborators; it does not change org/link access, invite channels, invite external emails, transfer ownership, or publish the doc.',
      inputSchema: {
        file_id: z.string().describe('Exact Zoom Docs file ID or URL.'),
        user_id: z.string().describe('Zoom user ID from zoomdocs_search_share_targets.'),
        role: z.enum(['viewer', 'commenter', 'editor']).describe('Collaborator role to grant.'),
        send_email: z.boolean().optional().describe('Whether Zoom should send email notification. Defaults to false.'),
        send_chat_message: z.boolean().optional().describe('Whether Zoom should send chat notification. Defaults to false.'),
      },
    },
    async ({ file_id, user_id, role, send_email, send_chat_message }) => {
      const result = await service.addUserCollaborator({
        fileId: file_id,
        userId: user_id,
        role,
        sendEmail: send_email ?? false,
        sendChatMessage: send_chat_message ?? false,
      });
      return {
        content: [{ type: 'text', text: formatAddUserCollaboratorText(result) }],
        structuredContent: toStructuredContent(result),
      };
    }
  );

  registerTool(
    'zoomdocs_set_user_collaborator_role',
    {
      title: 'Zoom Docs Set User Collaborator Role',
      description:
        'Change the role of an existing Zoom user collaborator on a doc, then read permissions back to verify. Requires an explicit file_id and user_id. This only changes user collaborator roles; it does not change org/link access, invite channels, invite external emails, transfer ownership, or publish the doc.',
      inputSchema: {
        file_id: z.string().describe('Exact Zoom Docs file ID or URL.'),
        user_id: z.string().describe('Zoom user ID whose collaborator role should change.'),
        role: z.enum(['viewer', 'commenter', 'editor']).describe('New collaborator role.'),
        is_email_invitee: z.boolean().optional().describe('Whether the target is an email invitee. Defaults to false for normal Zoom users.'),
      },
    },
    async ({ file_id, user_id, role, is_email_invitee }) => {
      const result = await service.setUserCollaboratorRole({
        fileId: file_id,
        userId: user_id,
        role,
        isEmailInvitee: is_email_invitee,
      });
      return {
        content: [{ type: 'text', text: formatSetUserCollaboratorRoleText(result) }],
        structuredContent: toStructuredContent(result),
      };
    }
  );

  registerTool(
    'zoomdocs_remove_user_collaborator',
    {
      title: 'Zoom Docs Remove User Collaborator',
      description:
        'Remove a specific Zoom user collaborator from a doc, then read permissions back to verify. Requires an explicit file_id and user_id. This only removes user collaborators; it does not change org/link access, remove channels, transfer ownership, or publish the doc.',
      inputSchema: {
        file_id: z.string().describe('Exact Zoom Docs file ID or URL.'),
        user_id: z.string().describe('Zoom user ID to remove from collaborators.'),
        is_email_invitee: z.boolean().optional().describe('Whether the target is an email invitee. Defaults to false for normal Zoom users.'),
      },
    },
    async ({ file_id, user_id, is_email_invitee }) => {
      const result = await service.removeUserCollaborator({
        fileId: file_id,
        userId: user_id,
        isEmailInvitee: is_email_invitee,
      });
      return {
        content: [{ type: 'text', text: formatRemoveUserCollaboratorText(result) }],
        structuredContent: toStructuredContent(result),
      };
    }
  );

  registerTool(
    'zoomdocs_read',
    {
      title: 'Zoom Docs Read',
      description:
        'Read a specific Zoom Doc and return Markdown. Use this when the user asks to summarize, quote, inspect, compare, or extract content from a doc after you have resolved the correct file ID/URL.',
      inputSchema: {
        file_id: z.string().describe('Zoom Docs file ID or URL.'),
      },
    },
    async ({ file_id }) => {
      const result = await service.read({ fileId: file_id });
      return {
        content: [{ type: 'text', text: result.text }],
        structuredContent: toStructuredContent(result),
      };
    }
  );

  registerTool(
    'zoomdocs_create_doc',
    {
      title: 'Zoom Docs Create Doc',
      description: 'Create a brand new Zoom Doc. Never use this to modify an existing doc.',
      inputSchema: {
        markdown: z.string().describe('Markdown content to import into the new Zoom Doc.'),
        title: z.string().optional().describe('New doc title. Defaults to Untitled.'),
        parent_id: z.string().optional().describe('Parent folder ID or URL. Defaults to my-docs.'),
      },
    },
    async ({ markdown, title, parent_id }) => {
      const result = await service.createDoc({ markdown, title, parentId: parent_id });
      return {
        content: [{ type: 'text', text: `Created Zoom Doc: ${result.file_link || result.file_id}` }],
        structuredContent: toStructuredContent(result),
      };
    }
  );

  registerTool(
    'zoomdocs_edit_doc',
    {
      title: 'Zoom Docs Edit Doc',
      description:
        'Modify an existing Zoom Doc in place and preserve the same fileId/URL when the requested change is supported. Use this for typos, sentence rewrites, paragraph updates, heading text edits, inserting simple blocks after a target, and replacing safe sections under a heading. If the target is missing or ambiguous, this tool returns a structured failure instead of guessing. Use this before creating a replacement copy.',
      inputSchema: {
        file_id: z.string().describe('Zoom Docs file ID or URL.'),
        target: z
          .discriminatedUnion('by', [
            z.object({
              by: z.literal('exact_text'),
              value: z.string().describe('Exact visible block text to edit. No fuzzy matching is applied.'),
              within_heading: z
                .string()
                .optional()
                .describe('Optional exact heading text used only to disambiguate repeated visible text.'),
            }),
            z.object({
              by: z.literal('heading'),
              value: z.string().describe('Exact visible heading text to edit.'),
            }),
            z.object({
              by: z.literal('ref'),
              value: z.string().describe('Editable ref returned by zoomdocs_get_edit_outline, for example h2:plan/p1.'),
            }),
          ])
          .describe('High-level locator. Prefer ref from zoomdocs_get_edit_outline when exact text is hard to target. Do not pass block IDs.'),
        operation: z
          .discriminatedUnion('type', [
            z.object({
              type: z.literal('replace_text'),
              text: z.string().describe('New plain text for the matched block.'),
            }),
            z.object({
              type: z.literal('append_text'),
              text: z.string().min(1).describe('Plain text to append to the matched block.'),
            }),
            z.object({
              type: z.literal('insert_after'),
              markdown: z
                .string()
                .describe('Safe structural markdown to insert after the matched block. Supports flat headings, paragraphs, bullets, and todo items.'),
            }),
            z.object({
              type: z.literal('replace_section'),
              markdown: z
                .string()
                .describe('Safe structural markdown to replace the content under a matched heading. Supports flat headings, paragraphs, bullets, and todo items.'),
            }),
            z.object({
              type: z.literal('replace_substring'),
              old_text: z.string().min(1).describe('Exact substring to replace inside the matched block. Must occur exactly once.'),
              new_text: z.string().describe('Replacement text for old_text.'),
            }),
          ])
          .describe('Single in-place edit operation.'),
        dry_run: z
          .boolean()
          .optional()
          .describe('Preview the edit and return before/after without applying any changes. Defaults to false.'),
      },
    },
    async ({ file_id, target, operation, dry_run }) => {
      const result = await service.editDoc({ fileId: file_id, target, operation, dryRun: dry_run });
      return {
        content: [{ type: 'text', text: formatEditDocText(result) }],
        structuredContent: toStructuredContent(result),
      };
    }
  );

  registerTool(
    'zoomdocs_edit_doc_batch',
    {
      title: 'Zoom Docs Edit Doc Batch',
      description:
        'Apply multiple safe in-place edits to one existing Zoom Doc. The server validates every edit before mutating; if validation fails or two edits target the same block, no changes are applied. Use dry_run first to preview all before/after values, then rerun without dry_run to apply.',
      inputSchema: {
        file_id: z.string().describe('Zoom Docs file ID or URL.'),
        edits: z
          .array(
            z.object({
              target: z
                .discriminatedUnion('by', [
                  z.object({
                    by: z.literal('exact_text'),
                    value: z.string().describe('Exact visible block text to edit. No fuzzy matching is applied.'),
                    within_heading: z
                      .string()
                      .optional()
                      .describe('Optional exact heading text used only to disambiguate repeated visible text.'),
                  }),
                  z.object({
                    by: z.literal('heading'),
                    value: z.string().describe('Exact visible heading text to edit.'),
                  }),
                  z.object({
                    by: z.literal('ref'),
                    value: z.string().describe('Editable ref returned by zoomdocs_get_edit_outline, for example h2:plan/p1.'),
                  }),
                ])
                .describe('High-level locator. Prefer ref from zoomdocs_get_edit_outline when exact text is hard to target. Do not pass block IDs.'),
              operation: z
                .discriminatedUnion('type', [
                  z.object({
                    type: z.literal('replace_text'),
                    text: z.string().describe('New plain text for the matched block.'),
                  }),
                  z.object({
                    type: z.literal('append_text'),
                    text: z.string().min(1).describe('Plain text to append to the matched block.'),
                  }),
                  z.object({
                    type: z.literal('insert_after'),
                    markdown: z
                      .string()
                      .describe('Safe structural markdown to insert after the matched block. Supports flat headings, paragraphs, bullets, and todo items.'),
                  }),
                  z.object({
                    type: z.literal('replace_section'),
                    markdown: z
                      .string()
                      .describe('Safe structural markdown to replace the content under a matched heading. Supports flat headings, paragraphs, bullets, and todo items.'),
                  }),
                  z.object({
                    type: z.literal('replace_substring'),
                    old_text: z.string().min(1).describe('Exact substring to replace inside the matched block. Must occur exactly once.'),
                    new_text: z.string().describe('Replacement text for old_text.'),
                  }),
                ])
                .describe('Single in-place edit operation.'),
            })
          )
          .min(1)
          .max(25)
          .describe('Ordered edits to validate and apply. Each mutating edit must target a different block.'),
        dry_run: z
          .boolean()
          .optional()
          .describe('Preview all edits and return before/after without applying any changes. Defaults to false.'),
      },
    },
    async ({ file_id, edits, dry_run }) => {
      const result = await service.editDocBatch({ fileId: file_id, edits, dryRun: dry_run });
      return {
        content: [{ type: 'text', text: formatEditDocBatchText(result) }],
        structuredContent: toStructuredContent(result),
      };
    }
  );

  registerTool(
    'zoomdocs_create_replacement_copy',
    {
      title: 'Zoom Docs Create Replacement Copy',
      description:
        'Create a new replacement copy of an existing doc. This produces a new fileId and preserves the original. Use only when the user explicitly wants a copy/new doc or when in-place editing is not possible.',
      inputSchema: {
        target_file_id: z.string().describe('Existing Zoom Doc ID or URL to copy from. The new file is created as a sibling.'),
        markdown: z.string().describe('Markdown content for the new replacement copy.'),
        title: z.string().optional().describe('Replacement copy title. Defaults to the target doc title.'),
      },
    },
    async ({ target_file_id, markdown, title }) => {
      const result = await service.createReplacementCopy({ targetFileId: target_file_id, markdown, title });
      return {
        content: [
          {
            type: 'text',
            text: `Created replacement Zoom Doc copy: ${result.file_link || result.file_id}\nOriginal doc preserved: ${result.replaced_file_id}`,
          },
        ],
        structuredContent: toStructuredContent(result),
      };
    }
  );

  registerDebugTool(
    'zoomdocs_write',
    {
      title: 'Zoom Docs Write (legacy/debug)',
      description:
        'Create a Zoom Doc from Markdown using the local browser-authenticated session. Use this when the user asks to create a new Zoom Doc or replace an existing one with drafted content.',
      inputSchema: {
        markdown: z.string().describe('Markdown content to import into Zoom Docs.'),
        title: z.string().optional().describe('New doc title. Defaults to Untitled, or the target doc title in replacement mode.'),
        parent_id: z.string().optional().describe('Parent folder ID or URL. Defaults to my-docs.'),
        target_file_id: z.string().optional().describe('Existing doc ID or URL to replace by creating a sibling replacement doc.'),
      },
    },
    async ({ markdown, title, parent_id, target_file_id }) => {
      const result = await service.writeMarkdown({
        markdown,
        title,
        parentId: parent_id,
        targetFileId: target_file_id,
      });

      const text = result.mode === 'replace'
        ? `Created replacement Zoom Doc: ${result.fileLink || result.fileId}\nOriginal doc preserved: ${result.replacedFileId}`
        : `Created Zoom Doc: ${result.fileLink || result.fileId}`;

      return {
        content: [{ type: 'text', text }],
        structuredContent: toStructuredContent(result),
      };
    }
  );

  registerDebugTool(
    'zoomdocs_capture_start',
    {
      title: 'Zoom Docs Capture: start',
      description:
        'Start recording Zoom Docs internal HTTP traffic from the local browser session to a JSONL file for offline inspection. Invoke this when the user asks to capture, record, or trace Zoom Docs network calls (for example to reverse-engineer endpoints for search/edit/delete/move). This is safe to run: cookies and Authorization headers are redacted, the local browser is simply brought to the foreground, and nothing is sent anywhere. Stop with zoomdocs_capture_stop.',
      inputSchema: {
        output_path: z
          .string()
          .optional()
          .describe(
            'Absolute path for the JSONL capture file. Defaults to ~/.config/zoomdocs-mcp/captures/capture-<timestamp>.jsonl.'
          ),
      },
    },
    async ({ output_path }) => {
      const capturesDir = path.join(getConfigPaths().configDir, 'captures');
      const outputPath = output_path || defaultCaptureFilePath({ capturesDir });
      const result = await service.captureStart({ outputPath });
      return {
        content: [
          {
            type: 'text',
            text: [
              `Zoom Docs capture started. Writing JSONL to ${result.outputPath}.`,
              'Perform the action you want to reverse-engineer (search, edit, delete, move, etc.) in the browser window that was focused.',
              'When finished, call zoomdocs_capture_stop.',
            ].join('\n'),
          },
        ],
        structuredContent: toStructuredContent(result),
      };
    }
  );

  registerDebugTool(
    'zoomdocs_capture_stop',
    {
      title: 'Zoom Docs Capture: stop',
      description:
        'Stop the currently running Zoom Docs capture and return the JSONL file path plus entry count. Invoke this when the user says they are done capturing, or asks to stop/finish the trace.',
      inputSchema: {},
    },
    async () => {
      const result = await service.captureStop();
      return {
        content: [
          {
            type: 'text',
            text: `Zoom Docs capture stopped. ${result.entriesWritten} entries written to ${result.outputPath}.`,
          },
        ],
        structuredContent: toStructuredContent(result),
      };
    }
  );

  registerDebugTool(
    'zoomdocs_capture_status',
    {
      title: 'Zoom Docs Capture: status',
      description:
        'Report whether a Zoom Docs capture session is active and how many entries have been written. Invoke when the user asks about capture status or wants to check if recording is on.',
      inputSchema: {},
    },
    async () => {
      const result = service.captureStatus();
      return {
        content: [
          {
            type: 'text',
            text: result.active
              ? `Zoom Docs capture active since ${result.startedAt}. ${result.entriesWritten} entries written so far to ${result.outputPath}.`
              : 'Zoom Docs capture is not running.',
          },
        ],
        structuredContent: toStructuredContent(result),
      };
    }
  );

  registerTool(
    'zoomdocs_delete',
    {
      title: 'Zoom Docs Delete',
      description:
        'Move a Zoom Doc (or folder) to the trash. Invoke when the user asks to delete, trash, or remove a specific Zoom Docs file. The file is moved to trash, not hard-deleted, so it can typically be restored from the Zoom Docs UI.',
      inputSchema: {
        file_id: z.string().describe('Zoom Docs file ID or URL to trash.'),
      },
    },
    async ({ file_id }) => {
      const result = await service.deleteFile({ fileId: file_id });
      return {
        content: [{ type: 'text', text: `Moved ${result.fileId} to trash.` }],
        structuredContent: toStructuredContent(result),
      };
    }
  );

  registerTool(
    'zoomdocs_move',
    {
      title: 'Zoom Docs Move',
      description:
        'Move a Zoom Doc (or folder) under a different parent folder. Invoke when the user asks to move, relocate, or reorganize a file into another folder.',
      inputSchema: {
        file_id: z.string().describe('Zoom Docs file ID or URL to move.'),
        parent_id: z
          .string()
          .describe('Destination parent folder ID or URL. Use "my-docs" for the root of the user\'s personal space.'),
      },
    },
    async ({ file_id, parent_id }) => {
      const result = await service.moveFile({ fileId: file_id, parentId: parent_id });
      return {
        content: [{ type: 'text', text: `Moved ${result.fileId} under parent ${result.newParentId}.` }],
        structuredContent: toStructuredContent(result),
      };
    }
  );

  registerDebugTool(
    'zoomdocs_list_blocks',
    {
      title: 'Zoom Docs List Blocks',
      description:
        'List every block inside a Zoom Doc with its ID, type, text, version, and parent. Invoke this when the user wants to edit part of an existing doc so you can pick the right block_id for zoomdocs_append_to_block or zoomdocs_replace_block_text.',
      inputSchema: {
        file_id: z.string().describe('Zoom Docs file ID or URL.'),
      },
    },
    async ({ file_id }) => {
      const result = await service.listBlocks({ fileId: file_id });
      const preview = result.blocks
        .slice(0, 40)
        .map((block) => `${block.id} [${block.type} v${block.version}] ${block.text.slice(0, 80)}`)
        .join('\n');
      const suffix = result.blocks.length > 40 ? `\n… ${result.blocks.length - 40} more blocks` : '';
      return {
        content: [
          {
            type: 'text',
            text: `Zoom Doc ${result.fileId} has ${result.blocks.length} blocks:\n${preview}${suffix}`,
          },
        ],
        structuredContent: toStructuredContent(result),
      };
    }
  );

  registerDebugTool(
    'zoomdocs_append_to_block',
    {
      title: 'Zoom Docs Append To Block',
      description:
        'Append text to the end of an existing block in a Zoom Doc, in place (no replacement doc is created). Invoke this when the user asks to add to / extend / tack on content to a specific paragraph, heading, or list item. Use zoomdocs_list_blocks first to find the right block_id. Non-text inline content in the block (attachments, links, mentions) is preserved.',
      inputSchema: {
        file_id: z.string().describe('Zoom Docs file ID or URL.'),
        block_id: z.string().describe('Block ID inside the doc, from zoomdocs_list_blocks.'),
        text: z.string().min(1).describe('Plain text to append to the block.'),
      },
    },
    async ({ file_id, block_id, text }) => {
      const result = await service.appendToBlock({ fileId: file_id, blockId: block_id, text });
      return {
        content: [
          {
            type: 'text',
            text: `Appended ${text.length} chars to block ${result.blockId} (v${result.previousVersion} -> v${result.newVersion}).`,
          },
        ],
        structuredContent: toStructuredContent(result),
      };
    }
  );

  registerDebugTool(
    'zoomdocs_replace_block_text',
    {
      title: 'Zoom Docs Replace Block Text',
      description:
        'Replace the entire text content of an existing block in a Zoom Doc, in place. Invoke this when the user asks to rewrite, edit, or overwrite a specific paragraph, heading, or list item. Use zoomdocs_list_blocks first to find the right block_id. WARNING: any existing inline annotations or objects (comments, formatting, attachments, links, mentions) inside that block will be removed; only plain text remains.',
      inputSchema: {
        file_id: z.string().describe('Zoom Docs file ID or URL.'),
        block_id: z.string().describe('Block ID inside the doc, from zoomdocs_list_blocks.'),
        text: z.string().describe('New plain text for the block. Pass an empty string to clear the block.'),
      },
    },
    async ({ file_id, block_id, text }) => {
      const result = await service.replaceBlockText({ fileId: file_id, blockId: block_id, text });
      return {
        content: [
          {
            type: 'text',
            text: `Replaced block ${result.blockId} (v${result.previousVersion} -> v${result.newVersion}) with ${text.length} chars.`,
          },
        ],
        structuredContent: toStructuredContent(result),
      };
    }
  );

  registerTool(
    'zoomdocs_rename',
    {
      title: 'Zoom Docs Rename',
      description: 'Rename an existing Zoom Docs file after you have resolved the right file ID or URL.',
      inputSchema: {
        file_id: z.string().describe('Zoom Docs file ID or URL.'),
        title: z.string().describe('New title.'),
      },
    },
    async ({ file_id, title }) => {
      await service.rename({ fileId: file_id, title });
      return {
        content: [{ type: 'text', text: `Renamed ${file_id} to "${title}".` }],
        structuredContent: { ok: true },
      };
    }
  );

  const stdio = new StdioServerTransport();
  await server.connect(stdio);

  const shutdown = async () => {
    await transport.dispose();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length === 0) {
    await runMcpServer();
    return;
  }

  if (argv[0] === 'setup') {
    if (argv[1] !== 'claude') {
      throw new Error('Unknown setup target. Supported targets: claude');
    }

    const setupFlags = new Set(argv.slice(2));
    if (setupFlags.has('--local') && setupFlags.has('--package')) {
      throw new Error('Choose either --local or --package for setup claude, not both.');
    }
    if ([...setupFlags].some((flag) => flag !== '--local' && flag !== '--package')) {
      throw new Error('Unknown setup flag. Supported flags: --local, --package');
    }

    await runSetupClaude(setupFlags.has('--local') ? 'local' : setupFlags.has('--package') ? 'package' : 'auto');
    return;
  }

  if (argv[0] === 'doctor') {
    await runDoctor();
    return;
  }

  if (argv[0] === '--help' || argv[0] === 'help') {
    printHelp();
    return;
  }

  if (argv[0] === '--version' || argv[0] === 'version') {
    process.stdout.write(`${await getVersion()}\n`);
    return;
  }

  throw new Error(`Unknown command: ${argv[0]}`);
}

main().catch(async (error) => {
  process.stderr.write(`[zoomdocs-mcp] fatal: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
