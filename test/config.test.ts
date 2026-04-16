import { describe, expect, it } from 'vitest';

import * as configModule from '../src/config.js';
import { readJsonFixture } from './helpers/fixtures.js';

const {
  DEFAULT_CONFIG_DIR_NAME,
  DEFAULT_USER_DATA_DIR_NAME,
  getConfigPaths,
  parseBooleanEnv,
} = configModule;

describe('config helpers', () => {
  it('resolves config and browser profile paths under ~/.config/zoomdocs-mcp', () => {
    expect(getConfigPaths('/tmp/home')).toEqual({
      configDir: '/tmp/home/.config/zoomdocs-mcp',
      browserProfileDir: '/tmp/home/.config/zoomdocs-mcp/browser-profile',
      stateFile: '/tmp/home/.config/zoomdocs-mcp/state.json',
    });
  });

  it('parses boolean-like env values safely', () => {
    expect(parseBooleanEnv(undefined, false)).toBe(false);
    expect(parseBooleanEnv('1', false)).toBe(true);
    expect(parseBooleanEnv('true', false)).toBe(true);
    expect(parseBooleanEnv('yes', false)).toBe(true);
    expect(parseBooleanEnv('0', true)).toBe(false);
    expect(parseBooleanEnv('false', true)).toBe(false);
    expect(parseBooleanEnv('off', true)).toBe(false);
    expect(parseBooleanEnv('weird', true)).toBe(true);
  });

  it('exports stable default directory names', () => {
    expect(DEFAULT_CONFIG_DIR_NAME).toBe('zoomdocs-mcp');
    expect(DEFAULT_USER_DATA_DIR_NAME).toBe('browser-profile');
  });

  it('resolves the Claude Desktop config path on macOS', () => {
    expect(typeof (configModule as { getClaudeDesktopConfigPath?: unknown }).getClaudeDesktopConfigPath).toBe('function');

    const getClaudeDesktopConfigPath = (configModule as {
      getClaudeDesktopConfigPath: (options: { platform: NodeJS.Platform; homeDir: string }) => string;
    }).getClaudeDesktopConfigPath;

    expect(getClaudeDesktopConfigPath({
      platform: 'darwin',
      homeDir: '/Users/alice',
    })).toBe('/Users/alice/Library/Application Support/Claude/claude_desktop_config.json');
  });

  it('upserts a local Claude Desktop MCP entry without clobbering preserved env or other servers', async () => {
    expect(typeof (configModule as { buildClaudeDesktopServerConfig?: unknown }).buildClaudeDesktopServerConfig).toBe('function');
    expect(typeof (configModule as { upsertClaudeDesktopConfig?: unknown }).upsertClaudeDesktopConfig).toBe('function');

    const buildClaudeDesktopServerConfig = (configModule as {
      buildClaudeDesktopServerConfig: (options: {
        mode: 'local' | 'package';
        packageSpec: string;
        localEntryPath: string;
        nodeCommand?: string;
      }) => Record<string, unknown>;
    }).buildClaudeDesktopServerConfig;

    const upsertClaudeDesktopConfig = (configModule as unknown as {
      upsertClaudeDesktopConfig: (config: Record<string, unknown>, options: { serverConfig: Record<string, unknown> }) => Record<string, unknown>;
    }).upsertClaudeDesktopConfig;

    const existingConfig = await readJsonFixture<Record<string, unknown>>('config', 'claude-desktop-existing.json');

    expect(
      upsertClaudeDesktopConfig(existingConfig, {
        serverConfig: buildClaudeDesktopServerConfig({
          mode: 'local',
          packageSpec: '@jcornudella/zoomdocs-mcp',
          localEntryPath: '/repo/zoomdocs-mcp/dist/index.js',
          nodeCommand: '/usr/local/bin/node',
        }),
      })
    ).toEqual({
      mcpServers: {
        filesystem: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem'],
        },
        zoomdocs: {
          command: '/usr/local/bin/node',
          args: ['/repo/zoomdocs-mcp/dist/index.js'],
          env: {
            ZOOMDOCS_MCP_HEADLESS: 'true',
            EXTRA_FLAG: '1',
          },
        },
      },
      theme: 'dark',
    });
  });

  it('detects local and package Claude Desktop entries as compatible even when they carry custom env', async () => {
    expect(typeof (configModule as { detectClaudeDesktopServerMode?: unknown }).detectClaudeDesktopServerMode).toBe('function');

    const detectClaudeDesktopServerMode = (configModule as {
      detectClaudeDesktopServerMode: (
        server: Record<string, unknown> | undefined,
        options: { packageSpec: string; localEntryPath: string; nodeCommand?: string }
      ) => 'local' | 'package' | null;
    }).detectClaudeDesktopServerMode;

    const existingConfig = await readJsonFixture<{
      mcpServers: { zoomdocs: Record<string, unknown> };
    }>('config', 'claude-desktop-existing.json');

    expect(
      detectClaudeDesktopServerMode(existingConfig.mcpServers.zoomdocs, {
        packageSpec: '@jcornudella/zoomdocs-mcp',
        localEntryPath: '/repo/zoomdocs-mcp/dist/index.js',
      })
    ).toBe('package');

    expect(
      detectClaudeDesktopServerMode(
        {
          ...existingConfig.mcpServers.zoomdocs,
          command: '/usr/local/bin/node',
          args: ['/repo/zoomdocs-mcp/dist/index.js'],
        },
        {
          packageSpec: '@jcornudella/zoomdocs-mcp',
          localEntryPath: '/repo/zoomdocs-mcp/dist/index.js',
          nodeCommand: '/usr/local/bin/node',
        }
      )
    ).toBe('local');
  });
});
