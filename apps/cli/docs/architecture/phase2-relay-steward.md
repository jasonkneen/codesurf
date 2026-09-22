# Phase 2 — Relay + steward tiers (plan & record)

**Branch:** `phase2/relay-steward` (off `phase1/agent-gateway`) · **2026-09-08**
Architecture: `docs/architecture/v0.md` §6 (node-to-node protocol), §7 (three-tier access), §12 roadmap.
Anti-duplication law: capabilities land once, in the engine; nodes connect over the relay protocol.

## Goal (v0 §12 Phase 2)

Relay + steward tiers: remote tool namespaces, **bounded envelopes**, audit. Exit: **two nodes exchange
delegated bounded calls.** No raw content off-node at the relay tier.

## Ground truth (measured)

- v0 §6 node-to-node ops: `announce`, `discover`, `route`, `delegate` (call tool T on node N under policy P;
  bounded envelope reply; `expand(handle)` follows the same gate), `presence` (join/leave/heartbeat).
  Messages are the contract; versioned schema + compat policy (mirror DSH session-log versioning).
- v0 §7 tiers: **Relay** (default) serves files/tools through relay but *bounded* — envelope + anchors +
  handle, no raw content off-node, ~0 model tokens. **Steward** (always on) is the dispatch gate — authz,
  redaction, scope, audit; steward-scoped tool name (`agent1_read_file`); the gate, not the brains. **Q**
  (policy-invoked) is the broker agent — out of scope for Phase 2 slice 1.
- Transport: outbound WS relay (tailscale mesh optional). This repo has no WS dep; slice 1 uses an
  in-memory node channel behind a `RelayTransport` seam so the protocol is testable without network, and
  wire attach (WebSocket) lands behind the same seam in a later slice.



## Mode spectrum & federation arc (owner, 2026-09-08)

One engine, N run shapes — **the node owns work/sessions; any front attaches** (the invariant).

1. **Standalone TUI** — node is the app; in-process front + local IDE connectors.
2. **Client + server** — same node headless; IDE/TUI attaches over the wire (Phase 1 `codesurf serve`).
3. **Client + many servers** — one front → several local nodes, each owning a client/repo's work (Phase 2).
4. **Distributed** — one front → many remote nodes, each a relay for skills/code/tools (Phase 3 hub protocol:
   announce/discover/route/delegate/presence over WS relay).

**agensis merge:** agensis-agent (WS relay daemon shelling out to external CLIs) becomes native to the
codesurf engine — the hub/relay is a first-class engine capability, not a bolted-on daemon. The Phase 2
node→relay→delegate machinery (bounded envelopes, steward gate, delegated calls) is the same transport
Mode 4 uses, carried over WS relay + hub discovery.



## Distributed compute (owner, 2026-09-08)

The mesh executes real work across thousands of nodes, not just routes requests.
- **From delegate to jobs.** `delegate` (= call tool T on node N under policy P) generalizes into jobs:
  longer-running work (agent turns, kernels like search/plan_tests, batch) dispatched to a node; only
  bounded results (statement+anchors+handle) cross the mesh — code/data stays local.
- **Placement is policy.** Job placement by: data locality (node whose filesystem owns the repo — v0
  §6 route), capability, load, trust/tenant. The 'Q' broker role (v0 §7) reads a task and decides where,
  then dispatches.
- **Hub dispatches, nodes compute.** The hub is the registry/route — it never runs the work; that keeps
  the hub an empty space and scale in the nodes.
- **Same invariants:** logical mesh + physical spokes; every job is steward-gated + audited; bounded
  envelopes are the hard default (wider blast radius).
- **LLM-gateway flavor = v0 Phase 4:** pooled inference across nodes with ceilings + per-tenant
  telemetry, on the same dispatch model.


## Agensis decoupling (owner, 2026-09-08)
Agensis is the existing PRODUCT surface — front end + server with **workspaces** and
**channels** — NOT the fabric. The relay hub (Phase 2/3) is the standalone transport
layer (nodes, discovery, routing, delegation, steward); it does not understand
workspaces/channels; it understands capabilities/repos/tenants/principals. They meet
only by protocol, never by coupling:
- workspace ~ tenant/namespace (steward ACL boundary)
- channel ~ routing scope (hub routes a channel's work to the owning node)
- membership ~ steward principals (who may delegate what, audited)
- The agensis server is a natural place to PLAY the hub role (it already brokers
  presence), but that is a deployment choice, not a coupling. The fabric is usable
  standalone; agensis is consumable as a front, a hub host, or not at all.
So "agensis merge -> hub-native" reads: agensis is a consumer/peer of the fabric.

## Fleet scale (owner, 2026-09-08): thousands of clients × thousands of nodes

Scale target: thousands of end-user clients and thousands of nodes (relays/gateways/daemons).
Consequences that are mandatory (not optional):
- **Logical mesh over physical spokes.** The protocol is ONE uniform mesh (every node/client speaks the
  same versioned relay protocol; any→any). Physically the connection graph is hub-spoked because a full
  mesh is O(N×M) connections at thousands×thousands. The hub is a router/registry (announce/discover/
  route), still a RelayNode on the same mesh, not a privileged tier.
  (`announce`/`discover`) and routes to the right node by repo/capability/tenant. The hub stays an
  "empty space of connections" — it routes, it does not reason (v0 §6 presence). -> Phase 3.
- **Per-tenant namespacing + steward ACLs.** Thousands of independent clients ⇒ steward-scoped tool
  names + per-principal authority + audit are the multi-tenant boundary; every delegated call is
  principal-checked.
- **Bounded envelopes are non-negotiable.** No raw content off-node at fleet scale (bandwidth, blast
  radius, exfiltration); `expand(handle)` is optional follow-through under the same steward gate.
- **Operability (v0 Phase 4):** fleet versioning, per-tenant telemetry, LLM-gateway pooling with
  ceilings. The Phase 2 relay/steward/host machinery is the per-node building block these run on.

## Driving requirement (owner, 2026-09-08): client-death resilience

**A client (IDE / TUI) may shut down at any time; the daemon must keep working.**
This is the reason the relay/steward host must live IN the daemon, not in any front.

- **Process persistence — already true today.** `codesurfd` is an independently spawned
  background HTTP daemon (shared `~/.codesurf/daemon/pid.json`); killing the TUI/IDE does not
  kill it)SkipIt already manages detached children (`manager.ts` `detached: true`) and hosts
  shared state (sessions, personas, remote tool namespaces in `node-tools.ts`).
- **Work persistence — the gap.** An interactive turn's `Agent` currently lives *in-process* in the
  front (TUI `App` or the per-session gateway host). If the front dies mid-turn, that turn dies.
- **Consequence for Phase 2/3:** the relay/steward host must *own* the Agent sessions (the daemon
  hosts agent nodes); fronts attach/detach freely by session id. Slice for this requirement: the
  relay node + agent host bind into `codesurfd`, so a turn/session continues after a front disconnects,
  and a reconnecting front re-attaches to the running session.

## Workstreams

- **W1 Bounded envelope + protocol schema** — versioned envelope (`schemaVersion`, `kind`, `nodeId`,
  `ttlMs`, `budgetBytes`, `content` OR `anchors[]` + optional `handle`), budget enforced at construction;
  relay-tier messages carry anchors+handle, never raw file content off-node. Ops: announce/delegate,
  presence; discover/route stubbed for slice 1.
- **W2 Steward gate** — authorize(principal, toolName, scope) -> allow/deny + redaction; mandates audit
  entry per gated call (who/what/scope/at). Steward-scoped tool names.
- **W3 Two-node delegated bounded call** — Node A delegates tool T on Node B; B's steward gates + scopes +
  audits, executes bounded, returns bounded envelope with anchors; content over budget is refused.

## Exit checks (W1–W3)

1. A bounded envelope over budget throws at construction; anchors-only relay payload has no raw content.
2. Steward records an audit entry on every delegated call; a denied call produces a denied capability
   envelope, not raw content.
3. Two `RelayNode`s exchange a delegated bounded call over the in-memory channel and the reply is within
   budget; `expand(handle)` re-enters the same gate.

## Record

- **2026-09-08 SLICE 1 LANDED (this branch):** v0 §6/§7 constraints transcribed; branch created off
  `phase1/agent-gateway` (pushed to origin as the completed Phase 1). Implementation: `src/relay/*` —
  envelope, protocol schema, in-memory transport, steward gate, relay node; W3 two-node delegated bounded
  call with audit. `src/relay/*`: envelope.ts (budget + relay-safety), protocol.ts (versioned schema,