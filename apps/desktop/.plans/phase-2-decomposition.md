# Phase 2 — Decomposition (Multi-Agent)

## Wave 5 — MCP tool modules (3 parallel + 1 integrator)

| Agent | Owns | Creates |
|-------|------|---------|
| P2-A | canvas + extension list tools | `src/main/mcp/tools/canvas.ts` |
| P2-B | kanban + card_* tools | `src/main/mcp/tools/kanban.ts` |
| P2-C | bus + peer + context + generation image tools | `src/main/mcp/tools/bus.ts`, `peer.ts`, `context.ts` |
| P2-D | Orchestrator | `src/main/mcp/registry.ts`, slim `mcp-server.ts` |

## Wave 6 — Chat provider split (4 parallel, sequential merge)

| Agent | Owns | Creates |
|-------|------|---------|
| P2-E | chatClaude | `src/main/chat/providers/claude.ts` |
| P2-F | chatCodex | `src/main/chat/providers/codex.ts` |
| P2-G | chatOpencode + openclaw | `src/main/chat/providers/opencode.ts` |
| P2-H | chatHermes + csagent | `src/main/chat/providers/hermes.ts` |

## Wave 7 — Docs + PR

- Update CODE_REVIEW.md status table
- Open PR for feature/hardening-wave-1