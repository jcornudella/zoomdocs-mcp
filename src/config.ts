import os from 'node:os';
import path from 'node:path';

export const CLAUDE_DESKTOP_CONFIG_FILENAME = 'claude_desktop_config.json';
export const DEFAULT_MCP_SERVER_NAME = 'zoomdocs';

export const DEFAULT_CONFIG_DIR_NAME = 'zoomdocs-mcp';
export const DEFAULT_USER_DATA_DIR_NAME = 'browser-profile';

export interface ConfigPaths {
  configDir: string;
  browserProfileDir: string;
  stateFile: string;
}

export function getConfigPaths(homeDir = os.homedir()): ConfigPaths {
  const configDir = path.join(homeDir, '.config', DEFAULT_CONFIG_DIR_NAME);

  return {
    configDir,
    browserProfileDir: path.join(configDir, DEFAULT_USER_DATA_DIR_NAME),
    stateFile: path.join(configDir, 'state.json'),
  };
}

export function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null) return defaultValue;

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

export interface RuntimeConfig {
  baseUrl: string;
  userDataDir: string;
  headless: boolean;
  browserChannel?: 'chrome' | 'msedge';
  loginTimeoutMs: number;
  requestTimeoutMs: number;
}

export interface ClaudeDesktopServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
}

export interface ClaudeDesktopConfig {
  mcpServers?: Record<string, ClaudeDesktopServerConfig>;
  [key: string]: unknown;
}

export type ClaudeDesktopSetupMode = 'local' | 'package';

export function getClaudeDesktopConfigPath({
  platform = process.platform,
  homeDir = os.homedir(),
  appData = process.env.APPDATA,
}: {
  platform?: NodeJS.Platform;
  homeDir?: string;
  appData?: string;
} = {}): string {
  if (platform === 'darwin') {
    return path.join(homeDir, 'Library', 'Application Support', 'Claude', CLAUDE_DESKTOP_CONFIG_FILENAME);
  }

  if (platform === 'win32') {
    return path.join(appData || path.join(homeDir, 'AppData', 'Roaming'), 'Claude', CLAUDE_DESKTOP_CONFIG_FILENAME);
  }

  return path.join(homeDir, '.config', 'Claude', CLAUDE_DESKTOP_CONFIG_FILENAME);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === 'string');
}

function isServerConfig(value: unknown): value is ClaudeDesktopServerConfig {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeArgs(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    return undefined;
  }

  return value;
}

function sameStringArray(left: string[] | undefined, right: string[] | undefined): boolean {
  if ((left?.length || 0) !== (right?.length || 0)) return false;
  return (left || []).every((entry, index) => entry === right?.[index]);
}

export function buildClaudeDesktopServerConfig({
  mode,
  packageSpec,
  localEntryPath,
  nodeCommand = process.execPath,
}: {
  mode: ClaudeDesktopSetupMode;
  packageSpec: string;
  localEntryPath: string;
  nodeCommand?: string;
}): ClaudeDesktopServerConfig {
  if (mode === 'local') {
    return {
      command: nodeCommand,
      args: [localEntryPath],
    };
  }

  return {
    command: 'npx',
    args: ['-y', packageSpec],
  };
}

export function detectClaudeDesktopServerMode(
  server: Record<string, unknown> | undefined,
  {
    packageSpec,
    localEntryPath,
    nodeCommand = process.execPath,
  }: {
    packageSpec: string;
    localEntryPath: string;
    nodeCommand?: string;
  }
): ClaudeDesktopSetupMode | null {
  if (!server || typeof server.command !== 'string') {
    return null;
  }

  const args = normalizeArgs(server.args);

  if (server.command === 'npx' && sameStringArray(args, ['-y', packageSpec])) {
    return 'package';
  }

  if (server.command === nodeCommand && sameStringArray(args, [localEntryPath])) {
    return 'local';
  }

  return null;
}

export function upsertClaudeDesktopConfig(
  config: ClaudeDesktopConfig,
  {
    serverConfig,
    serverName = DEFAULT_MCP_SERVER_NAME,
  }: {
    serverConfig: ClaudeDesktopServerConfig;
    serverName?: string;
  }
): ClaudeDesktopConfig {
  const currentServers = config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers : {};
  const currentServer = isServerConfig(currentServers[serverName]) ? currentServers[serverName] : undefined;
  const mergedEnv = {
    ...(isStringRecord(currentServer?.env) ? currentServer.env : {}),
    ...(isStringRecord(serverConfig.env) ? serverConfig.env : {}),
  };

  return {
    ...config,
    mcpServers: {
      ...currentServers,
      [serverName]: {
        ...(currentServer || {}),
        ...serverConfig,
        ...(Object.keys(mergedEnv).length > 0 ? { env: mergedEnv } : {}),
      },
    },
  };
}

export function getRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const paths = getConfigPaths();

  return {
    baseUrl: env.ZOOMDOCS_MCP_BASE_URL || 'https://docs.zoom.us',
    userDataDir: env.ZOOMDOCS_MCP_USER_DATA_DIR || paths.browserProfileDir,
    headless: parseBooleanEnv(env.ZOOMDOCS_MCP_HEADLESS, false),
    browserChannel:
      env.ZOOMDOCS_MCP_BROWSER_CHANNEL === 'chrome' || env.ZOOMDOCS_MCP_BROWSER_CHANNEL === 'msedge'
        ? env.ZOOMDOCS_MCP_BROWSER_CHANNEL
        : 'chrome',
    loginTimeoutMs: Number(env.ZOOMDOCS_MCP_LOGIN_TIMEOUT_MS || 5 * 60_000),
    requestTimeoutMs: Number(env.ZOOMDOCS_MCP_REQUEST_TIMEOUT_MS || 60_000),
  };
}
