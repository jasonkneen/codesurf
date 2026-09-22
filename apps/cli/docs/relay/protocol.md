# Relay & Session-Streaming Wire Protocol

Everything on the mesh is JSON over the same WebSocket. There are **two planes**:

## 1. Control plane — the versioned relay envelope

```jsonc
{
  "protocolVersion": 1,
  "op": "delegate_request",   // | delegate_reply | announce | presence | discover | discover_reply | route | route_reply
  "from": "front-1",
  "to": "hub",
  "seq": 0,
  "ttlMs": 5000,
  "payload": { }
}
```

- **Delegate requests** are steward-gated on the worker node (`allowPrincipals` /
  `"*"` = allow any), bounded by `BoundedEnvelope` (default 4096-byte budget),
  and carry optional trace context.
- **Reply** is bounded: `{ ok, reason?, statement?, anchors?, handle?, auditId, traceSpans? }`.
- **Session ops** on a worker node are server as remote tools:
  `session_create`, `session_message`, `session_status`, `session_destroy`,
  plus `job_submit` / `job_status` / `job_cancel`, `fleet_status`, `trace_path`.

## 2. Data plane — the `session` streaming channel

Rides the same socket as `op: "session"` frames (the hub ignores these; the node's
`SessionStreamServer` handles them). Live turn content streams here:

### Front → node (commands)

```jsonc
{ "op": "session", "action": "create" }                    // -> { event:"created", session }
{ "op": "session", "action": "message", "session": "s-1", "text": "hi" }
{ "op": "session", "action": "subscribe", "session": "s-1" }
{ "op": "session", "action": "status",   "session": "s-1" }
{ "op": "session", "action": "destroy",  "session": "s-1" }
```

### Node → front (events)

```jsonc
{ "op": "session", "event": "created", "session": "s-1" }
{ "op": "session", "event": "chunk",   "session": "s-1", "chunk": { "type": "content", "content": "…" } }
{ "op": "session", "event": "done",    "session": "s-1", "finished": true }
{ "op": "session", "event": "status",  "session": "s-1", "status": { … } }
{ "op": "session", "event": "error",   "message": "…" }
```

A `message` attaches an observer, runs the turn on the node's `NodeSessionHost`
(via the injected turn runner, e.g. a real Agent), and streams every `StreamChunk`
back as `chunk` frames until `done`. **Client death never cancels the turn.**

## Semantic guarantees

- Sessions are owned by the node and outlive any front (client-death resilience).
- The node auto-evicts sessions idle past `idleTtlMs` (default 30 min) or alive
  past `maxTtlMs`, drops finished jobs past a TTL, prunes stale traces, and disposes
  the evicted session's Agent (reaping).
- Every gated call returns an `auditId`; traces are recorded per span and rendered
  as full traceroutes.

## Where the code lives

| File | Contents |
|---|---|
| `src/relay/protocol.ts` | envelope types, ops, version |
| `src/relay/node.ts` / `hub.ts` | node + hub registry/route/forward |
| `src/relay/ws-transport.ts` | WebSocket spokes + `onSessionFrame` hook |
| `src/relay/session-stream.ts` | `SessionStreamServer` + `SessionStreamClient` + `createRemoteSessionTurn` |
| `src/relay/host.ts` | `NodeSessionHost` (sessions that outlive fronts) |
| `src/gateway/node-command.ts` | `codesurf node` wiring + reaper |
