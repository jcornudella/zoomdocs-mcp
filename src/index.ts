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
import { ZoomDocsService } from './zoomdocs/service.js';
import { runVersionCheck } from './version-check.js';

const CLAUDE_CONFIG_PATH_ENV = 'ZOOMDOCS_MCP_CLAUDE_CONFIG_PATH';
const PACKAGE_SPEC_ENV = 'ZOOMDOCS_MCP_PACKAGE_SPEC';
const VERSION_CHECK_OPT_OUT_ENV = 'ZOOMDOCS_MCP_DISABLE_VERSION_CHECK';

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

function toStructuredContent(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function formatListText(parentId: string, items: Array<{ id: string; title: string; fileType: string; fileLink?: string }>) {
  if (items.length === 0) {
    return `No Zoom Docs children found under ${parentId}.`;
  }

  return [
    `Children of ${parentId}:`,
    ...items.map((item) => `- [${item.fileType}] ${item.title} — ${item.id}${item.fileLink ? ` — ${item.fileLink}` : ''}`),
  ].join('\n');
}

function formatSearchText(result: {
  query: string;
  pageSize: number;
  fileTypes: string[];
  totalReturned: number;
  items: Array<{
    id: string;
    title: string;
    fileType: string;
    fileLink: string;
    titleHighlight?: string;
    updatedAt?: string;
    updatedByDisplayName?: string;
  }>;
}) {
  if (result.items.length === 0) {
    return `No Zoom Docs matches found for "${result.query}" (file types: ${result.fileTypes.join(', ')}).`;
  }

  return [
    `Search results for "${result.query}" (${result.totalReturned} of up to ${result.pageSize}):`,
    ...result.items.map((item) => {
      const display = item.titleHighlight || item.title;
      const updatedBits = [
        item.updatedAt ? `updated ${item.updatedAt}` : undefined,
        item.updatedByDisplayName ? `by ${item.updatedByDisplayName}` : undefined,
      ]
        .filter(Boolean)
        .join(' ');
      const trailing = updatedBits ? ` — ${updatedBits}` : '';
      return `- [${item.fileType}] ${display} — ${item.id} — ${item.fileLink}${trailing}`;
    }),
  ].join('\n');
}

function formatMetadataText(node: {
  id: string;
  title: string;
  fileType: string;
  fileLink?: string;
  parentId?: string;
}) {
  return [
    `[${node.fileType}] ${node.title}`,
    `ID: ${node.id}`,
    node.parentId ? `Parent: ${node.parentId}` : undefined,
    node.fileLink ? `Link: ${node.fileLink}` : undefined,
  ]
    .filter(Boolean)
    .join('\n');
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

async function emitVersionWarningIfOutdated(): Promise<void> {
  if (versionCheckDisabled()) return;
  try {
    const { name: packageName, version: currentVersion } = await readPackageMetadata();
    const result = await runVersionCheck({ packageName, currentVersion });
    if (result.notice) {
      process.stderr.write(`[zoomdocs-mcp] ${result.notice}\n`);
    }
  } catch {
    // Best-effort; never block startup on version-check failures.
  }
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
    'zoomdocs_write',
    {
      title: 'Zoom Docs Write',
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
    'zoomdocs_replace_block_text',
    {
      title: 'Zoom Docs Replace Block Text',
      description:
        'Replace the entire text content of an existing block in a Zoom Doc, in place. Invoke this when the user asks to rewrite, edit, or overwrite a specific paragraph, heading, or list item. Use zoomdocs_list_blocks first to find the right block_id. WARNING: any existing inline objects (attachments, links, mentions) inside that block will be removed; only plain text remains.',
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

  server.registerTool(
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
