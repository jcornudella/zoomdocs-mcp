import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const tsxCliPath = `${repoRoot}/node_modules/tsx/dist/cli.mjs`;

function cleanEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  return {
    ...env,
    ZOOMDOCS_MCP_DISABLE_VERSION_CHECK: '1',
    ...overrides,
  };
}

async function listToolNames(env: Record<string, string> = {}): Promise<string[]> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsxCliPath, 'src/index.ts'],
    cwd: repoRoot,
    env: cleanEnv(env),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'zoomdocs-mcp-test', version: '1.0.0' });

  try {
    await client.connect(transport);
    const result = await client.listTools();
    return result.tools.map((tool) => tool.name).sort();
  } finally {
    await client.close();
  }
}

describe('MCP tool surface', () => {
  it('exposes explicit create/edit/replacement tools and hides legacy block/debug tools by default', async () => {
    const toolNames = await listToolNames();

    expect(toolNames).toContain('zoomdocs_create_doc');
    expect(toolNames).toContain('zoomdocs_edit_doc');
    expect(toolNames).toContain('zoomdocs_edit_doc_batch');
    expect(toolNames).toContain('zoomdocs_create_replacement_copy');
    expect(toolNames).toContain('zoomdocs_get_edit_outline');
    expect(toolNames).toContain('zoomdocs_get_access_info');
    expect(toolNames).toContain('zoomdocs_get_comments');
    expect(toolNames).toContain('zoomdocs_add_doc_comment');
    expect(toolNames).toContain('zoomdocs_add_comment_reaction');
    expect(toolNames).toContain('zoomdocs_reply_to_comment');
    expect(toolNames).toContain('zoomdocs_resolve_comment_thread');
    expect(toolNames).toContain('zoomdocs_reopen_comment_thread');
    expect(toolNames).toContain('zoomdocs_delete_comment');
    expect(toolNames).toContain('zoomdocs_add_inline_comment');
    expect(toolNames).toContain('zoomdocs_set_link_access');
    expect(toolNames).toContain('zoomdocs_search_share_targets');
    expect(toolNames).toContain('zoomdocs_add_user_collaborator');
    expect(toolNames).toContain('zoomdocs_set_user_collaborator_role');
    expect(toolNames).toContain('zoomdocs_remove_user_collaborator');

    expect(toolNames).not.toContain('zoomdocs_write');
    expect(toolNames).not.toContain('zoomdocs_list_blocks');
    expect(toolNames).not.toContain('zoomdocs_append_to_block');
    expect(toolNames).not.toContain('zoomdocs_replace_block_text');
    expect(toolNames).not.toContain('zoomdocs_capture_start');
    expect(toolNames).not.toContain('zoomdocs_capture_stop');
    expect(toolNames).not.toContain('zoomdocs_capture_status');
    expect(toolNames).not.toContain('zoomdocs_set_permission_access');
  });

  it('exposes legacy block/capture tools only when debug tools are enabled', async () => {
    const toolNames = await listToolNames({ ZOOMDOCS_MCP_DEBUG_TOOLS: '1' });

    expect(toolNames).toContain('zoomdocs_write');
    expect(toolNames).toContain('zoomdocs_list_blocks');
    expect(toolNames).toContain('zoomdocs_append_to_block');
    expect(toolNames).toContain('zoomdocs_replace_block_text');
    expect(toolNames).toContain('zoomdocs_capture_start');
    expect(toolNames).toContain('zoomdocs_capture_stop');
    expect(toolNames).toContain('zoomdocs_capture_status');
    expect(toolNames).toContain('zoomdocs_set_permission_access');
    expect(toolNames).toContain('zoomdocs_add_user_collaborator');
    expect(toolNames).toContain('zoomdocs_remove_user_collaborator');
  });
});
