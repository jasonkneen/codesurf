# Phase 3 — Hub protocol (plan & record)

**Branch:** `phase3/hub` (off `phase2/relay-steward`) · **2026-09-08**
Architecture: v0 §6 (announce/discover/route/delegate/presence), §7 (relay/steward/Q tiers), §12 roadmap.
Driving reqs from Phase 2 plan: fleet scale (thousands x thousands), distributed compute, agensis merge.

## Goal (v0 §12 Phase 3)

Hub protocol: announce/discover/route/delegate/presence; the hub = router/registry over the logical
mesh (an empty space of connections). Exit (slice 1): a client holds ONE spoke to the hub, discovers a
node by capability/repo, and delegates a job that the hub routes to the right node — bounded + audited.

## Ground truth (measured)

- v0 §6 ops: `announce` (node identity/capabilities/reachability), `discover` (resolve @agent tags,
  capability queries, locate a gateway for repo R), `route` (which node owns a workspace/session),
  `delegate` (call tool T on node N under policy P), `presence` (join/leave/heartbeat).
- Phase 2 gave us: versioned protocol schema, RelayNode, steward gate, NodeSessionHost (sessions outlive
  fronts). The hub reuses all of it — it is a RelayNode plus a registry + forwarder, same protocol.
- Fleet-scale decision: logical mesh over physical spokes — a client talks only to the hub; the hub
  discovers/routes and forwards; it never reasons and holds only registrations.

## Workstreams

- **W1 Registry + discover/route** — hub holds `nodeId → {capabilities, repo}`; `discover(capability/
  repo)` resolves candidates; `route(repo/session)` pins to the owning node.
- **W2 Hub dispatch** — client delegate_request to `to: hub`; hub routes to the node owning the
  capability, forwards, and relays the bounded reply back. Steward gate still runs on the worker node.
- **W3 Presence** — join/leave/heartbeat so hub stays consistent (stub in slice 1; registry update on
  announce + explicit leave).

## Exit checks (slice 1)

1. A client connected only to the hub can discover nodes by capability and repo.
2. Delegating a tool through the hub routes to the node owning it and returns the bounded reply.
3. The worker's steward gate still authorizes + audits before executing.

## Record

- **2026-09-08 SLICE 1 LANDED** — branch `phase3/hub` off phase2; uses Phase 2 machinery unchanged.
  `src/relay/hub.ts` Hub (registry + discover/route + delegate forwarding + reply relay), protocol extensions
  (discover_reply/route_reply ops, optional discover.query, delegate target), and `RelayNode` discover()/
  locate()/repo-aware announce. **6/6 tests**: discover by capability, route by repo, delegate through hub to
  the owning node (bounded reply, steward audit on worker), different-capability routing, steward denial, no-node
  reporting. Relay suite 20/20; typecheck 0. **W3 presence LANDED.** **W3 WS TRANSPORT LANDED:** `src/relay/ws-transport.ts` (WsRelayServer: sockets → hub spokes, node id from messages; WsRelayClient: client end) over `ws`; hub gains attachAny/detachTransport. **2/2 WS tests**: remote discover + delegate through the hub and socket-close retirement. Relay suite 22/22; typecheck 0. Relay suite 22/22; typecheck 0. **ENGINE NODE LANDED:** `src/relay/engine-node.ts` — a runnable node composing Hub + NodeSessionHost + session tools (create/message/status/destroy) served over WS, turn-runner seam for the real Agent; host.ts tracks results + enqueue(). Wire test proves client-death (front disconnects mid-turn, node keeps running, new front reads result). **NODE CMD LANDED:** `codesurf node --port N` — engine node bound to the real Agent (src/gateway/node-host.ts NodeAgentHost: persistent Agents per session; src/gateway/node-command.ts); steward gained "*" (allow-any). Live smoke: front discovered node0 via the hub)Skip created + read a session over real WS. Relay suite 25/25; typecheck 0. **JOBS LANDED:** `src/relay/jobs.ts` JobHost (bounded queue + runner seam + load) + registerJobTools
  (job_submit/status/cancel); hub placement is locality-then-load (announce carries load; delegate carries
  target/repo/budget). **2/2 tests**: placement (locality, least-load, explicit target) and a client
  submit->poll->done lifecycle. Relay suite 27/27; typecheck 0. **JOBS WIRED INTO THE RUNNABLE NODE:** EngineNode takes an optional jobRunner, mounts JobHost onto its
  relay node with live-load report; steward policy includes job_* tools. NodeAgentHost.batchRunner = a real
  headless agent turn as a bounded compute job; `codesurf node` passes it. Wire test: a front submits + polls
  a distributed job to done over WS. **LIVE LOAD:** nodes heartbeat JobHost.load() so placement follows
  real-time load (peers() exposes load). **FLEET TELEMETRY LANDED (Phase 4 groundwork):** nodes report status (sessions/jobs/version/uptimeMs)
  via presence; hub.fleetStatus() aggregates a bounded fleet snapshot; a fleet_status relay tool on the
  engine node exposes it over the wire. **TRACING / FULL TRACEROUTE LANDED:** traceId rides the delegate,
  the hub records forward/reply spans and merges worker run spans (src/relay/trace.ts TraceStore);
  renderTraceTrajectory() renders a DSH-app-style trajectory timeline; a trace_path relay tool exposes it
  over the wire. Relay suite 33/33; typecheck 0. Next: fleet versioning + pooled inference ceilings (Phase
  4); persist node state across restart.