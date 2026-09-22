# Port from dpcode: Usage Tracking + Versioning + Multi-CLI Polish

**Status**: Planning
**Created**: 2026-04-28
**Source repo**: `/Users/jkneen/Documents/GitHub/dpcode`
**Target repo**: `/Users/jkneen/clawd/collaborator-clone` (codesurf)

## Background

dpcode has shipped four valuable patterns that codesurf would benefit from:

1. **Tail-edit / replay policy** — strict rule for which user messages can be re-sent
2. **Canonical agent request types** — normalize permission requests across providers
3. **Cross-CLI handoff** — continue a conversation in a different agent CLI
4. **Provider usage snapshots** — "1h 47m left in your 5h Claude window"

codesurf has 1+2 partially (file-based permissions, agent capability list) and lacks 3+4 entirely.

## Architectural alignment

Where dpcode's idioms differ from codesurf's, the port adapts to codesurf:

| Concern | dpcode | codesurf |
|---|---|---|
| Persistence | Effect-SQL projections | better-sqlite3 + JSON file overlay |
| Provider list | `claudeAgent`, `codex`, `gemini`, `opencode` | `claude`, `codex`, `opencode`, `openclaw`, `hermes` |
| Permissions | `CanonicalRequestType` union (9 types) | free-text `toolName` per grant |
| Capabilities | `ProviderComposerCapabilities` struct | `AgentAdapterCapability[]` array of IDs |
| Events | WebSocket push | `event-bus.ts` |
| UI integration | `apps/web` React | Electron renderer |

## Build order

1. **Migration 005** — `provider_rate_limits_index` table (one row per provider, plus pointer to JSON file)
2. **Snapshot store** — `~/.codesurf/usage/<provider>.json` writer/reader following codesurf's pointer+overlay pattern
3. **Codex usage reader** — port from dpcode (`~/.codex/sessions/YYYY/MM/DD/*.jsonl`)
4. **Claude usage reader** — port from dpcode (`~/.claude/projects/*/transcripts.jsonl`)
5. **Live event hook** — wire `account.rate-limits.updated` from agent-stream into the snapshot writer
6. **Duration formatter** — `src/renderer/src/lib/rateLimitDuration.ts` with thresholded urgency
7. **MainStatusBar surface** — show "Resets in 1h 47m" with urgency color
8. **(then) Edit/replay port** — `src/shared/conversation-edit.ts`
9. **(then) Cross-CLI handoff** — `src/main/agents/handoff.ts`
10. **(then) Canonical request types** — extend `permissions.ts` to map toolName → canonical category

## Open questions

- **Q1**: Does codesurf's `agent-stream.ts` already parse `rate_limit_info` from Claude responses? (Need to read it.)
- **Q2**: What's the right IPC channel for `usage:get` / `usage:subscribe`? Reuse an existing one or add a new file under `src/main/ipc/`?
- **Q3**: Codesurf supports `openclaw` and `hermes` — do these have rate-limit concepts at all, or do we mark them "no quota" like the dpcode plan suggests for opencode?

These are answered before code lands.
