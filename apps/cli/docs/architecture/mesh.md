# CodeSurf Mesh & Modes — Architecture Guide

> Interactive diagrams: open [**mesh.html**](./mesh.html) in a browser (renders the
> same architecture with Mermaid). This file is the plain-markdown companion.

## One engine, two run modes

Every CodeSurf session uses the **same engine capabilities**. The only thing that
changes is *where the Agent lives*.

### Mode 1 — serverless (the default)

`codesurf` (or `codesurf -p "…"`) runs an Agent **inside the TUI process**. The TUI
owns it completely:

- Kill the TUI and processing stops — inherent, one process.
- The only thing that keeps running after you kill a local TUI is a **separately
  spawned process** (an external CLI agent it delegated to, or a background/daemon).
- The TUI shows `· serverless` in its status line, and prints
  `codesurf session: local (serverless — same engine capabilities)` on boot —
  so the mode is always visible, never assumed.

### Mode 2 — wire front (`--connect`)

```bash
codesurf --connect ws://127.0.0.1:3948
```

The TUI becomes a **thin front**. A `codesurf node` owns the sessions:

- The front hands off a task, **streams responses live** over the wire, and can
  **send more** (continue the same session).
- **Client-death resilience:** kill the front and the node keeps the turn running
  (sessions outlive their front; the node reaper evicts abandoned sessions later).
- The status badge flips to `· wire ws://…`, and boot prints
  `codesurf session: attached to … (session N)`.
- If the node is unreachable, the TUI **falls back to the local in-process agent**
  so a dead `--connect` never bricks the UI.

### The same capabilities

PTC (programmatic tool calls) is presentation-level: set
`CODESURF_TOOL_PRESENTATION=code|both` and the model drives tools through
`run_code` — identical on the serverless and wire paths (the node runs the same
Agent).

## The mesh

- **Logical mesh over physical spokes.** Each client holds ONE web socket to a hub.
  Hubs register, discover, route, and forward. Thousands of clients, relays,
  gateways, and daemons hang off hubs while the logical topology stays any-to-any
  (Phase 2/3 requirement).
- **Workers** (`codesurf node`) expose sessions, distributed-compute jobs, fleet
  telemetry, and tracing as remote tools on the hub. `codesurf serve` exposes the
  same engine as OpenAI/ACP/MCP surfaces.

## Two planes on one socket

- **Control plane** — the versioned relay envelope (`delegate_request/`
  `delegate_reply`): steward-gated, bounded, traced. Session/job/fleet/trace ops.
- **Data plane** — `op:"session"` frames for live turn streaming:
  - front → node: `create`, `message`, `subscribe`, `status`, `destroy`
  - node → front: `created`, `chunk` (a `StreamChunk`), `done`, `status`, `error`

The hub ignores `session` frames; the node's `SessionStreamServer` bridges them to
`NodeSessionHost` (which already streams to observers). The headless client and the
interactive TUI both consume this via `createRemoteSessionTurn` — an async
generator of `StreamChunk`, the exact shape the TUI turn engine uses.

## Resilience & hygiene (Phase 4)

- **Reaping.** `codesurf node` auto-evicts sessions idle past a TTL / alive past
  a max TTL, drops finished jobs past a TTL, and prunes stale traces — disposing the
  evicted session's Agent. This is the fix class surfaced by the buddy-system audit
  (32 abandoned MCP sessions exhausting a server → HTTP 503).
- **Distributed tracing.** Delegate ops carry trace context; the hub records spans
  and renders full traceroutes (trajectory timeline).

## Component map

| Command / artifact | Role |
|---|---|
| `codesurf` | TUI + headless client (serverless by default; `--connect` → front) |
| `codesurf node` | `EngineNode`: hub + session host + job host + fleet + tracing + reaper |
| `codesurf serve` | Gateway surface (OpenAI/ACP/MCP) |
| `codesurf mcp` | MCP server surface |
| `SessionStreamClient` / `SessionStreamServer` | live streaming data plane |
| `NodeSessionHost` | sessions that outlive any front |

See [phase3-hub-protocol](./phase3-hub-protocol.md) and [phase2-relay-steward](./phase2-relay-steward.md)
for the worked build record, and [../relay/protocol.md](../relay/protocol.md) for the wire format.
