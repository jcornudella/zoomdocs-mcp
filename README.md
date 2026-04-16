# @jcornudella/zoomdocs-mcp

Agent-first MCP server for Zoom Docs that uses **each user's own browser-authenticated Zoom session** and is meant to be installed once so agents can use it autonomously.

It does **not** require Zoom developer API credentials. Instead, it:

1. launches a local Playwright browser profile
2. lets the user log into Zoom Docs interactively
3. uses the authenticated Zoom Docs **web app / internal web APIs** from that local session

The browser profile is persistent, so users should **not** need to log in every time. In normal use they log in once, then the stored local Zoom session is reused until Zoom/SSO expires it.

This package is distributed under a **personal npm scope** for ownership/distribution, but the runtime itself is still generic Zoom Docs automation: in principle it can work for any Zoom Docs user who can normally access `https://docs.zoom.us` in local Chrome.

Because this package reads and writes document content through an LLM-driven workflow, users should treat it like any other agent integration: only use it on Zoom Docs content you are comfortable sending through your chosen model/provider.

## Why this shape

This is optimized for **Option A**:
- every coworker runs the MCP server locally
- every coworker logs in with their own Zoom account
- no shared cookies, no shared bot account, no shared secrets

## Current tools

- `zoomdocs_login`
- `zoomdocs_status`
- `zoomdocs_search`
- `zoomdocs_list`
- `zoomdocs_get_metadata`
- `zoomdocs_read`
- `zoomdocs_write`
- `zoomdocs_rename`
- `zoomdocs_delete`
- `zoomdocs_move`
- `zoomdocs_list_blocks`
- `zoomdocs_append_to_block`
- `zoomdocs_replace_block_text`
- `zoomdocs_capture_start`
- `zoomdocs_capture_stop`
- `zoomdocs_capture_status`

## Important write behavior

`zoomdocs_write` supports two modes:

- without `target_file_id` -> creates a new Zoom Doc from Markdown
- with `target_file_id` -> creates a **replacement** doc under the same parent

For in-place edits of an existing doc, use `zoomdocs_append_to_block` or `zoomdocs_replace_block_text` (both keep the same `fileId`). Find the right `block_id` with `zoomdocs_list_blocks` first.

## Local persistence

By default, the persistent browser profile lives in:

- `~/.config/zoomdocs-mcp/browser-profile`

That is where the local Zoom login session is kept.

## Setup

Assumption: users already have **Google Chrome** installed.

### Development / local repo setup

```bash
cd ~/automations/zoomdocs-mcp
npm install
npm run build
node dist/index.js setup claude
```

When `setup claude` is run from this local checkout, it now points Claude Desktop at this repo’s built `dist/index.js` instead of the published npm package.

If you want to force the local mode explicitly, you can also run:

```bash
node dist/index.js setup claude --local
```

### Published package setup

Once this package is published to npm, the intended one-time install flow is:

```bash
npx -y @jcornudella/zoomdocs-mcp setup claude
```

That auto-detects the published package environment and writes the Claude Desktop entry in package mode. You can also force that behavior explicitly from any environment with:

```bash
zoomdocs-mcp setup claude --package
```

That configures Claude Desktop to launch the MCP through stdio using:

```json
{
  "mcpServers": {
    "zoomdocs": {
      "command": "npx",
      "args": ["-y", "@jcornudella/zoomdocs-mcp"]
    }
  }
}
```

## Doctor / health check

```bash
node dist/index.js doctor
```

This checks:
- Claude Desktop config presence / compatibility (`local` or `package` mode)
- local Chrome launch availability
- the persistent Zoom Docs browser-profile path in use

## First use

After setup, the goal is that users just talk to Claude naturally, for example:

- `Summarize the Seed Changes Zoom Doc`
- `Create a Zoom Doc called Weekly Notes with this outline...`

The agent should use the tools autonomously:
- `zoomdocs_search` to resolve a doc by title/topic
- `zoomdocs_read` to fetch Markdown
- `zoomdocs_write` to create/replace docs

If authentication is missing on first use, the agent (or user) can run:

- `zoomdocs_login`

That opens or focuses the local browser window and returns immediately.

Then:
1. finish login in the browser
2. run `zoomdocs_status`

After that, the local browser profile is reused across future sessions until Zoom expires the login.

## Environment variables

- `ZOOMDOCS_MCP_BASE_URL` (default: `https://docs.zoom.us`)
- `ZOOMDOCS_MCP_USER_DATA_DIR` (default: `~/.config/zoomdocs-mcp/browser-profile`)
- `ZOOMDOCS_MCP_HEADLESS` (default: `false`)
- `ZOOMDOCS_MCP_BROWSER_CHANNEL` (`chrome` or `msedge`, default: `chrome`)
- `ZOOMDOCS_MCP_LOGIN_TIMEOUT_MS` (default: `300000`)
- `ZOOMDOCS_MCP_REQUEST_TIMEOUT_MS` (default: `60000`)

## Notes / limitations

- This server relies on Zoom Docs **internal web APIs** plus the local authenticated browser session. That makes it practical for local use, but the integration may need maintenance if Zoom changes the web app.
- This repo assumes a locally installed browser such as **Google Chrome**. It does not manage bundled browser downloads.
- `zoomdocs_read` returns rendered Markdown from the internal document payload when available. It no longer includes the full raw internal payload in normal tool output.
- `zoomdocs_search` uses Zoom's native `/api/search/file` endpoint, so it covers indexed title + body content across the account (not just folder title walks). Results include a `titleHighlight` string with `<em>` markers where Zoom matched the query.
- file-cluster routing is handled conservatively and may need hardening if you hit cross-cluster docs edge cases.
- no shared auth model is implemented in this repo; sharing is done by sharing the code, not the session.

## Reverse-engineering Zoom internals (capture tool)

Some Zoom Docs features (real full-text search, in-place edit on an existing doc, delete, move) are not yet implemented because the internal endpoints have not been observed. The capture tool records the real requests Zoom's web UI makes so we can replicate them from the MCP.

This is primarily a development workflow, but the tools are always available — ask the agent to start a capture, drive the action in the focused browser window, then stop.

1. In your agent, call `zoomdocs_capture_start`. A JSONL file path is returned, and the local browser window comes to the front at `docs.zoom.us`.
2. In that browser window, perform the action you want to capture (e.g. type into Zoom's search box, rename a doc, drag a doc between folders, edit a paragraph).
3. Call `zoomdocs_capture_stop`. The JSONL file now contains every `/api/*` request Zoom's UI made during the session plus any WebSocket frames (`kind: "websocket"` entries with `direction: open|sent|received|close`), with cookies and `Authorization` headers redacted. Binary WebSocket payloads are base64-encoded.
4. Inspect the JSONL to identify the endpoint(s) involved, then wire a new MCP tool against them in `src/zoomdocs/service.ts` + `src/index.ts`.

Captures live at `~/.config/zoomdocs-mcp/captures/` by default. You can override with the `output_path` input on `zoomdocs_capture_start`.

## Development

```bash
npm run verify
```

(`npm run verify` runs tests, typecheck, and build — the same sanity checks enforced by `prepublishOnly`.)

## Publishing checklist

1. `npm run verify`
2. `npm version <patch|minor|major>`
3. `npm publish`
4. in a clean machine/profile, run `npx -y @jcornudella/zoomdocs-mcp setup claude`
5. open Claude and verify a natural-language flow such as `Summarize the Seed Changes Zoom Doc`

Notes:
- the package is configured for **public** npm publishing under the `@jcornudella` scope
- users should understand that document contents returned by `zoomdocs_read` will enter their Claude/agent conversation context, and attachment/image URLs may be included in rendered Markdown when available

## CLI commands

```bash
zoomdocs-mcp                           # start MCP stdio server
zoomdocs-mcp setup claude              # auto-detect local checkout vs package install
zoomdocs-mcp setup claude --local      # force Claude Desktop to use this local checkout
zoomdocs-mcp setup claude --package    # force Claude Desktop to use npx package mode
zoomdocs-mcp doctor                    # validate local wiring
zoomdocs-mcp --version                 # print version
```
