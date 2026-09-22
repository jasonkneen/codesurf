# @codesurf/relay

Local-first agent messaging and coordination for CodeSurf workspaces.

## What it does

- tracks participants (agents, humans, services)
- tracks current work context per participant
  - branch
  - worktree path
  - touched files
  - blockers
  - impacts on humans / other agents / systems
- supports direct messages and shared channels
- BCCs every relay message into a central workspace archive
- mirrors direct mail into tile-local `.codesurf/<tileId>/messages/*` mailboxes when a participant is attached to a tile
- computes relationship hints from overlapping files, branches, worktrees, impacts, and shared channels
- supports autonomous agent loops via an injected executor

## Storage layout

Everything lives under:

```text
<workspace>/.codesurf/relay/
  participants/
    <participantId>/
      participant.json
      mailboxes/
        inbox/
        sent/
        memory/
        bin/
      cursors/
        <channel>.json
  channels/
    <channelId>/
      channel.json
      messages/
  archive/
    all/
      *.md
  relationships/
    latest.json
```

Messages are markdown with frontmatter plus an optional ```codesurf-data``` JSON block.

## Main concepts

### Participants

Participants are not tied to canvas connections. A participant can be:

- an AI chat tile
- a human
- a service tile
- a supervisor / bridge

### Work context

Each participant can publish:

- summary
- branch
- worktreePath
- files
- topics
- collaborators
- blockers
- impacts

This is what lets the relay answer: "who is working on what, together or separately, and who might be affected?"

### Channels

Channels are local chatrooms. They are designed so future bridges can forward them to:

- WhatsApp
- Slack
- supervisor feeds
- webhooks

### Central archive

Every direct or channel message is also written to the central archive so a workspace-level feed can be built later.

## Runtime

`RelayRuntime` is provider-agnostic. You inject an executor that takes a prompt and returns JSON.

In this repo, the Electron main process wires it to:

- Claude Code SDK
- Codex CLI

OpenCode is intentionally left as a follow-up in the runtime executor layer.

## Current integration points in this repo

- package core: `packages/codesurf-relay/`
- Electron service: `src/main/relay/`
- IPC: `src/main/ipc/relay.ts`
- preload bridge: `src/preload/index.ts`
- workspace sync from canvas: `src/renderer/src/App.tsx`
- legacy collab DMs mirrored into relay archive: `src/main/ipc/collab.ts`
- workspace extension dashboard: `.codesurf/extensions/codesurf-relay-suite/`

The Relay Suite extension is currently a **hybrid** packaging layer:

- the dashboard, manifest, settings, extension IPC, and extension MCP hooks live in the extension
- the relay runtime remains host-backed through `src/main/relay/`

See also:

- `docs/extensions.md`
- `docs/relay-suite-extension.md`

## Example

```ts
import { CodesurfRelay, RelayRuntime } from '@codesurf/relay'

const relay = new CodesurfRelay({ workspacePath: '/repo' })
await relay.init()

await relay.upsertParticipant({
  id: 'alice',
  name: 'Alice',
  kind: 'agent',
  status: 'ready',
  channels: ['backend'],
})

await relay.upsertParticipant({
  id: 'bob',
  name: 'Bob',
  kind: 'agent',
  status: 'ready',
  channels: ['backend'],
})

await relay.updateWorkContext('alice', {
  summary: 'Refactoring auth middleware',
  branch: 'feature/auth-split',
  files: ['src/auth/middleware.ts'],
  impacts: [{ targetType: 'agent', targetId: 'bob', description: 'Route contracts may change', severity: 'high' }],
})

await relay.sendDirectMessage('alice', {
  to: 'bob',
  subject: 'Heads up on auth middleware split',
  body: 'I am changing `src/auth/middleware.ts` on `feature/auth-split`. Route contracts may move.',
})
```
