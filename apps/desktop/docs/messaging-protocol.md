# CodeSurf tile messaging protocol

Each tile now has a message store at:

- `.contex/<tileId>/messages/inbox/`
- `.contex/<tileId>/messages/sent/`
- `.contex/<tileId>/messages/memory/`
- `.contex/<tileId>/messages/bin/`

## Why Markdown

Message files are Markdown first so humans can inspect them easily in Finder, Git, or an editor.

Structured data lives in two places:

1. **YAML-style frontmatter header** for routing and indexing metadata
2. **Optional `codesurf-data` JSON fenced block** for machine payloads

That gives us readable files without giving up machine-friendly structure.

## File shape

```md
---
protocol: "codesurf-message/v1"
id: "6d61b7f9-0f3a-47cb-9320-f0a0f4c6d314"
threadId: "6d61b7f9-0f3a-47cb-9320-f0a0f4c6d314"
fromTileId: "tile-a"
toTileId: "tile-b"
type: "request"
subject: "Need the latest schema"
status: "unread"
createdAt: "2026-03-23T11:14:22.000Z"
createdTs: 1774264462000
updatedAt: "2026-03-23T11:14:22.000Z"
updatedTs: 1774264462000
replyToId: null
---

Can you send me the latest contract for the MCP workspace bridge?

```codesurf-data
{
  "priority": "normal",
  "refs": ["workspace-bridge", "mcp"]
}
```
```

## Semantics

### Mailboxes

- `inbox` — received messages waiting to be processed
- `sent` — sender-side copies
- `memory` — durable/promoted messages worth keeping around
- `bin` — soft-deleted or retired messages

### Types

- `request`
- `reply`
- `note`
- `signal`
- `memory`

### Status

- `unread`
- `read`
- `sent`
- `archived`

## Current IPC surface

Renderer access is exposed on `window.electron.collab`:

- `ensureDir(workspacePath, tileId)`
- `listMessages(workspacePath, tileId, mailbox)`
- `readMessage(workspacePath, tileId, mailbox, filename)`
- `sendMessage(workspacePath, fromTileId, draft)`
- `updateMessageStatus(workspacePath, tileId, mailbox, filename, status)`
- `moveMessage(workspacePath, tileId, fromMailbox, toMailbox, filename)`
- `watchMessages(workspacePath, tileId)`
- `unwatchMessages(workspacePath, tileId)`
- `onMessageChanged(callback)`

## Design notes

- Sender and recipient keep separate copies so local mailbox state can diverge cleanly.
- `status` is per-copy, not global.
- `threadId` stays stable across replies.
- `replyToId` links direct reply chains.
- The body is plain Markdown so humans can read or edit it directly if needed.
- The `codesurf-data` block is optional and intended for structured agent payloads.
