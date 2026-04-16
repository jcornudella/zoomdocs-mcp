import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { readJsonFixture } from './helpers/fixtures.js';

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
const tsxCliPath = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

async function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return execFileAsync(process.execPath, [tsxCliPath, 'src/index.ts', ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env,
    },
    timeout: 2000,
  });
}

describe('zoomdocs-mcp CLI', () => {
  it('auto-detects the local checkout for setup claude and points Claude Desktop at dist/index.js', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'zoomdocs-mcp-cli-'));
    const configPath = path.join(tempDir, 'claude_desktop_config.json');

    await runCli(['setup', 'claude'], {
      ZOOMDOCS_MCP_CLAUDE_CONFIG_PATH: configPath,
    });

    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
      mcpServers: {
        zoomdocs: {
          command: process.execPath,
          args: [path.join(repoRoot, 'dist', 'index.js')],
        },
      },
    });
  });

  it('writes a local Claude Desktop MCP config entry with setup claude --local and preserves existing env', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'zoomdocs-mcp-cli-'));
    const configPath = path.join(tempDir, 'claude_desktop_config.json');
    const existingConfig = await readJsonFixture<Record<string, unknown>>('config', 'claude-desktop-existing.json');
    await writeFile(configPath, `${JSON.stringify(existingConfig, null, 2)}\n`, 'utf8');

    await runCli(['setup', 'claude', '--local'], {
      ZOOMDOCS_MCP_CLAUDE_CONFIG_PATH: configPath,
    });

    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
      mcpServers: {
        filesystem: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem'],
        },
        zoomdocs: {
          command: process.execPath,
          args: [path.join(repoRoot, 'dist', 'index.js')],
          env: {
            ZOOMDOCS_MCP_HEADLESS: 'true',
            EXTRA_FLAG: '1',
          },
        },
      },
      theme: 'dark',
    });
  });

  it('writes a package Claude Desktop MCP config entry with setup claude --package and preserves existing env', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'zoomdocs-mcp-cli-'));
    const configPath = path.join(tempDir, 'claude_desktop_config.json');
    const existingConfig = await readJsonFixture<Record<string, unknown>>('config', 'claude-desktop-existing.json');
    await writeFile(configPath, `${JSON.stringify(existingConfig, null, 2)}\n`, 'utf8');

    await runCli(['setup', 'claude', '--package'], {
      ZOOMDOCS_MCP_CLAUDE_CONFIG_PATH: configPath,
    });

    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
      mcpServers: {
        filesystem: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem'],
        },
        zoomdocs: {
          command: 'npx',
          args: ['-y', '@jcornudella/zoomdocs-mcp'],
          env: {
            ZOOMDOCS_MCP_HEADLESS: 'true',
            EXTRA_FLAG: '1',
          },
        },
      },
      theme: 'dark',
    });
  });
});
