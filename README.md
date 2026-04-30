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

### Normal authoring tools

These are the tools normal agents see by default:

- `zoomdocs_login`
- `zoomdocs_status`
- `zoomdocs_search`
- `zoomdocs_read`
- `zoomdocs_create_doc`
- `zoomdocs_edit_doc`
- `zoomdocs_edit_doc_batch`
- `zoomdocs_create_replacement_copy`
- `zoomdocs_get_edit_outline` (read-only editable refs/structure)
- `zoomdocs_get_access_info` (read-only sharing/permission state)
- `zoomdocs_get_comments` (read-only open/resolved comment threads, optional thread filter)
- `zoomdocs_add_doc_comment` (verified whole-doc comments; text, explicit mentions, and attachments)
- `zoomdocs_add_inline_comment` (verified inline/anchored comments for unique plain-text selections)
- `zoomdocs_reply_to_comment` (verified plain-text replies)
- `zoomdocs_resolve_comment_thread` (verified thread resolution)
- `zoomdocs_reopen_comment_thread` (verified thread reopen/unresolve)
- `zoomdocs_delete_comment` (verified non-root comment/reply deletion)
- `zoomdocs_add_comment_reaction` (verified emoji reactions)
- `zoomdocs_search_share_targets` (read-only user/channel target search)
- `zoomdocs_set_link_access` (verified link/account access updates)
- `zoomdocs_add_user_collaborator` (verified specific-user invite)
- `zoomdocs_set_user_collaborator_role` (verified specific-user role change)
- `zoomdocs_remove_user_collaborator` (verified specific-user removal)

### File-management tools

- `zoomdocs_list`
- `zoomdocs_get_metadata`
- `zoomdocs_rename`
- `zoomdocs_delete`
- `zoomdocs_move`

### Debug / legacy tools

These are hidden from the default MCP tool surface. Set `ZOOMDOCS_MCP_DEBUG_TOOLS=1` to expose them while reverse-engineering or debugging:

- `zoomdocs_write` (legacy)
- `zoomdocs_list_blocks`
- `zoomdocs_append_to_block`
- `zoomdocs_replace_block_text`
- `zoomdocs_capture_start`
- `zoomdocs_capture_stop`
- `zoomdocs_capture_status`
- `zoomdocs_set_permission_access` (debug/replay alias for `zoomdocs_set_link_access`)

## Important authoring behavior

Create, edit, and replacement-copy are intentionally separate tool intents:

| User intent | Tool |
| --- | --- |
| Create a new doc | `zoomdocs_create_doc` |
| Edit an existing paragraph/list item/heading in place | `zoomdocs_edit_doc` |
| Apply multiple validated text edits to one doc | `zoomdocs_edit_doc_batch` |
| Inspect editable structure / get stable refs | `zoomdocs_get_edit_outline` |
| Add/replace content under a heading | `zoomdocs_edit_doc` structural operations |
| Make a new replacement copy | `zoomdocs_create_replacement_copy` |
| Rename/move/delete a file | management tools |
| Inspect collaborators/link access/pending requests | `zoomdocs_get_access_info` |
| Inspect open/resolved comment threads | `zoomdocs_get_comments` |
| Add a whole-doc comment | `zoomdocs_add_doc_comment` |
| Add an inline/anchored comment | `zoomdocs_add_inline_comment` |
| Reply to an existing comment | `zoomdocs_reply_to_comment` |
| Resolve a comment thread | `zoomdocs_resolve_comment_thread` |
| Reopen/unresolve a comment thread | `zoomdocs_reopen_comment_thread` |
| Delete a non-root comment/reply | `zoomdocs_delete_comment` |
| Add an emoji reaction to a comment | `zoomdocs_add_comment_reaction` |
| Find user/channel IDs for sharing | `zoomdocs_search_share_targets` |
| Set account/org or anyone-with-link access | `zoomdocs_set_link_access` |
| Add/change/remove a specific Zoom user collaborator | `zoomdocs_add_user_collaborator` / `zoomdocs_set_user_collaborator_role` / `zoomdocs_remove_user_collaborator` |

When editing an existing doc, prefer preserving the same `fileId`/URL. Use `zoomdocs_create_replacement_copy` only when the user explicitly asks for a copy/new doc or when the in-place edit tool cannot express the change.

`zoomdocs_get_access_info` is read-only. It aggregates the Share dialog state Zoom's web UI reads: file privilege metadata, `share_status`, `publish`, pending `permission_request`s, and `ancestors/permission?flattenInherit=true` collaborator/link-access data.

`zoomdocs_get_comments` is read-only. It extracts inline comment thread refs from the doc content, reads those threads through Zoom's comment endpoint, and also checks doc-level discussion comments. It supports `thread_status = "open" | "resolved"` and optional `thread_id` filtering. Results include `doc_url`, per-thread URL/location hints, normalized `parent_comment_id`, attachment summaries, and reactions to make follow-up tool calls easier.

`zoomdocs_add_doc_comment` adds a whole-doc comment with Zoom's captured `POST /api/comment/threads?fileId={fileId}` endpoint using `commentType: 2`, then reads comments back to verify the created thread/comment. It supports plain text and explicit mention content parts (`user_id` + display name; resolve users with `zoomdocs_search_share_targets`). Local attachment upload support is wired to Zoom's captured `getUploadFileUrl` flow and returns a structured `ATTACHMENT_UPLOAD_FAILED` failure if Zoom rejects the underlying file upload.

`zoomdocs_add_inline_comment` adds an inline/anchored comment to a unique substring in one simple editable block. Prefer `target.by = "ref"` from `zoomdocs_get_edit_outline`, then pass `selected_text` as the exact visible substring to anchor. It uses Zoom's captured two-step inline flow (`POST /api/comment/threads?fileId={fileId}` followed by `POST /api/block/transactions?fileId={fileId}` marker insertion), verifies by read-back, fails closed for ambiguous text or inline-rich blocks, and resolves the created thread if marker insertion fails after thread creation.

`zoomdocs_reply_to_comment` adds a plain-text reply to an existing comment via the captured `POST /api/comment/comments?fileId={fileId}` endpoint and verifies by reading comments back. It requires explicit `file_id`, `thread_id`, and `parent_comment_id`; reply mentions/attachments are intentionally not exposed yet.

`zoomdocs_resolve_comment_thread` resolves a thread via the captured `PATCH /api/comment/threads/{threadId}?fileId={fileId}` endpoint and verifies in the resolved comments bucket.

`zoomdocs_reopen_comment_thread` reopens/unresolves a thread via the replay-verified `PATCH /api/comment/threads/{threadId}?fileId={fileId}` endpoint with `threadStatus: "open"`, then verifies in the open comments bucket.

`zoomdocs_delete_comment` deletes only non-root comments/replies via the captured `DELETE /api/comment/comments/{commentId}?threadId={threadId}&fileId={fileId}` endpoint and verifies the comment is absent on read-back. It intentionally refuses root comment / whole-thread deletion with `ROOT_COMMENT_DELETE_NOT_VERIFIED` until that flow is separately captured and replay-verified.

`zoomdocs_add_comment_reaction` adds an emoji reaction to an existing comment via the captured `POST /api/comment/reactions?fileId={fileId}` endpoint and verifies by reading comments back.

Captured comment capabilities:

- `@mention` in a comment body ✅ implemented + replay-verified with `notify: false`
- inline/anchored comment ✅ implemented + replay-verified
- plain-text reply ✅ implemented + replay-verified
- resolve thread ✅ implemented + replay-verified
- reopen/unresolve thread ✅ implemented + replay-verified
- delete non-root comment/reply ✅ implemented + replay-verified
- emoji reaction ✅ implemented + replay-verified
- attachment upload + attachment in comment ✅ implemented from captured `POST multipart/form-data /zoomfile/upload` + replay-verified through public MCP; still returns structured `ATTACHMENT_UPLOAD_FAILED` if Zoom rejects the upload.

`zoomdocs_set_link_access` changes only link/account access for an explicit file ID/URL. It supports `scope = "account" | "anyone_with_link"` and `role = "noAccess" | "viewer" | "commenter" | "editor"`, uses the captured `PATCH /api/file/files/{fileId}/permission` endpoint, and verifies by reading permissions back before returning. It does not invite/remove collaborators, transfer ownership, or publish the doc.

`zoomdocs_search_share_targets` uses the Share dialog contact search endpoint and returns Zoom users/channels. `zoomdocs_add_user_collaborator`, `zoomdocs_set_user_collaborator_role`, and `zoomdocs_remove_user_collaborator` currently support only explicit Zoom `user_id` targets and roles `viewer | commenter | editor`; channel invites, external email invites, and ownership transfer still require separate capture/replay verification. User-collaborator add defaults to `send_email = false` and `send_chat_message = false` unless explicitly set.

`zoomdocs_get_edit_outline` returns agent-friendly refs such as `doc/p1`, `h2:plan`, and `h2:plan/p1`, plus `safe_to_replace` / `has_inline_content_risk` safety hints. Prefer these refs when exact text targeting would be brittle; pass them to `zoomdocs_edit_doc` as `target.by = "ref"`.

Set `dry_run = true` on `zoomdocs_edit_doc` or `zoomdocs_edit_doc_batch` to preview before/after without applying changes. Dry runs still validate targets and safety rules, but they do not submit block transactions.

Use `zoomdocs_edit_doc_batch` for multiple same-doc text edits after collecting refs from `zoomdocs_get_edit_outline`. Mutating batches validate every edit first and refuse to apply if any edit fails validation or if two edits target the same block. Mutating batches currently support `replace_text`, `append_text`, and `replace_substring`; use single-edit `zoomdocs_edit_doc` for structural `insert_after` / `replace_section` operations.

`zoomdocs_edit_doc` currently supports one atomic in-place edit per call:

- `target.by = "ref"` + any supported operation for that block/section
- `target.by = "ref"` or `"exact_text"` + `operation.type = "replace_substring"`
- `target.by = "exact_text"` + `operation.type = "replace_text"`
- `target.by = "exact_text"` + `operation.type = "append_text"`
- `target.by = "exact_text"` or `"heading"` + `operation.type = "insert_after"`
- `target.by = "heading"` + `operation.type = "replace_text"`
- `target.by = "heading"` + `operation.type = "append_text"`
- `target.by = "heading"` + `operation.type = "replace_section"`

Structural markdown is intentionally limited to flat headings, paragraphs, bullets, and todo items. Unsupported containers, embeds, databases, columns, images, attachments, and inline-rich blocks fail closed.

Safety rules:

- matching is exact only; no fuzzy matching
- ambiguous matches return `ok: false, error_code: "AMBIGUOUS_MATCH"` with candidates
- missing targets return `ok: false, error_code: "NO_MATCH"`
- substring replacement requires `old_text` to occur exactly once in the matched block
- replacing inline-rich blocks (mentions/attachments/inline objects/comment markers/formatting annotations) returns `ok: false, error_code: "INLINE_CONTENT_RISK"`
- structural replacements fail closed when section blocks are unsupported or would lose attachments/inline annotations/objects
- successful edits re-read the doc and verify post-write state before returning

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
- `zoomdocs_edit_doc` to modify existing docs in place when possible
- `zoomdocs_create_doc` to create new docs
- `zoomdocs_create_replacement_copy` only when a new replacement copy is explicitly desired

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
- `ZOOMDOCS_MCP_DEBUG_TOOLS` (default: unset/false; set to `1` to expose legacy block-edit and capture tools)

## Notes / limitations

- This server relies on Zoom Docs **internal web APIs** plus the local authenticated browser session. That makes it practical for local use, but the integration may need maintenance if Zoom changes the web app.
- This repo assumes a locally installed browser such as **Google Chrome**. It does not manage bundled browser downloads.
- `zoomdocs_read` returns rendered Markdown from the internal document payload when available. It no longer includes the full raw internal payload in normal tool output.
- `zoomdocs_search` uses Zoom's native `/api/search/file` endpoint, so it covers indexed title + body content across the account (not just folder title walks). Results include a `titleHighlight` string with `<em>` markers where Zoom matched the query.
- file-cluster routing is handled conservatively and may need hardening if you hit cross-cluster docs edge cases.
- no shared auth model is implemented in this repo; sharing is done by sharing the code, not the session.

## Reverse-engineering Zoom internals (capture tool)

Some advanced structural Zoom Docs features (nested block insertion, arbitrary delete/reorder, rich containers, databases, attachments/images) still depend on observing and validating more internal endpoint behavior. The capture tool records the real requests Zoom's web UI makes so we can replicate them from the MCP.

This is a development/debug workflow. Capture and raw block-edit tools are hidden by default; start the MCP server with `ZOOMDOCS_MCP_DEBUG_TOOLS=1` to expose them.

1. In your agent, call `zoomdocs_capture_start`. A JSONL file path is returned, and the local browser window comes to the front at `docs.zoom.us`.
2. In that browser window, perform the action you want to capture (e.g. type into Zoom's search box, rename a doc, drag a doc between folders, edit a paragraph).
3. Call `zoomdocs_capture_stop`. The JSONL file now contains every `/api/*` request Zoom's UI made during the session plus any WebSocket frames (`kind: "websocket"` entries with `direction: open|sent|received|close`). Cookies, `Authorization` headers, and sensitive URL query params such as `auth`, `token`, `sessionId`, `zm_aid`, and `zm_haid` are redacted. Binary WebSocket payloads are base64-encoded.
4. Run the analyzer to group endpoint candidates:

```bash
npm run analyze:capture -- ~/.config/zoomdocs-mcp/captures/capture-YYYY-MM-DDTHH-MM-SS-msZ.jsonl
```

5. Inspect grouped request/response examples to identify the endpoint(s) involved, then wire a new MCP tool against them in `src/zoomdocs/service.ts` + `src/index.ts`.

Captures live at `~/.config/zoomdocs-mcp/captures/` by default. You can override with the `output_path` input on `zoomdocs_capture_start`.

### Comments capture playbook

Use a disposable test doc and capture one UI action per file. Keep comment text unique and harmless, for example `zoomdocs-mcp add comment test <timestamp>`. Recommended sequence:

1. `comments-open-panel.jsonl` — open the comments panel on a doc with no comments and then on a doc with one existing comment.
2. `comments-add-inline.jsonl` — select text in one simple paragraph, add exactly one inline comment, wait until it appears in the panel.
3. `comments-reply.jsonl` — reply to that exact comment thread.
4. `comments-resolve.jsonl` — resolve that thread.
5. `comments-reopen.jsonl` — reopen/unresolve the same thread if the UI supports it.
6. `comments-delete-reply.jsonl` — delete a disposable test reply if the UI supports it.
7. `comments-delete-thread.jsonl` — delete a disposable test thread only if the UI confirms the action and the doc is disposable.

For each action: start capture, perform exactly one UI action, wait for success/network idle, stop capture, then run `npm run analyze:capture -- <file>`. Promote a mutation only after a local replay script proves the endpoint body on a disposable test doc and a read-back via `zoomdocs_get_comments` verifies the expected state. Do not guess endpoint bodies for comments, replies, resolve/reopen, deletion, mentions, or attachments.

Known read-side comment endpoints:

- inline thread read: `POST /api/comment/threads:batchGet?fileId={fileId}` with thread IDs extracted from document content refs like `thread-{threadId}:true`
- doc-level discussion read: `POST /api/comment/discussions:batchGet?fileId={fileId}`

### Sharing / permissions capture playbook

Use a disposable test doc and capture one UI action per file. Recommended sequence:

1. `share-open-dialog.jsonl` — open the Share dialog.
2. `share-copy-link.jsonl` — click Copy link.
3. `share-set-link-viewer.jsonl` — change link access/role to viewer.
4. `share-set-link-commenter.jsonl` — change link access/role to commenter.
5. `share-set-link-editor.jsonl` — change link access/role to editor.
6. `share-invite-internal-viewer.jsonl` — invite a safe internal test user.
7. `share-invite-external-viewer.jsonl` — invite a safe external test user, or stop before sending if no safe address exists.
8. `share-change-role.jsonl` — change a collaborator role.
9. `share-remove-collaborator.jsonl` — remove the test collaborator.
10. `publish-doc.jsonl` — publish the doc.
11. `unpublish-doc.jsonl` — unpublish the doc.

For each action: start capture, perform exactly one UI action, wait for success/network idle, stop capture, then run `npm run analyze:capture -- <file>`. Compare before/after read endpoints such as `share_status`, `publish`, `batch_get`, and collaborator/user endpoints before promoting any mutation to a public MCP tool.

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
