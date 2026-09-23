# Agensis Relay on the CodeSurf server: integration plan

Status: proposal (read-only analysis, 2026-09-23). No source was changed in either repo.

Goal: the CodeSurf server (the background engine node, `apps/cli/src/gateway/node-command.ts` + `apps/cli/src/relay/*`) shows up in the Agensis dashboard as a Relay connection and runs Agensis jobs on the CodeSurf engine. The user's rule: where agensis-agent and CodeSurf overlap, reuse CodeSurf's code instead of copying agensis code in.

Sources analysed:
- agensis-agent @ `a9f7e4a` (`/Users/jkneen/Documents/GitHub/agensis-agent`, v0.1.56, MIT, "Copyright (c) 2026 Agensis contributors")
- codesurf-mono @ `fb7f4173` (`/Users/jkneen/clawd/codesurf-mono`), plus the untracked in-flight `apps/cli/src/server/{registry,cli-entry}.ts` from the `codesurf server start|stop|status|list` work.

Path shorthands: `A:` = `agensis-agent/packages/agensis-cli/src/`, `AB:` = `agensis-agent/packages/agensis-cli/bin/`, `C:` = `codesurf-mono/apps/cli/src/`, `D:` = `codesurf-mono/packages/codesurf-daemon/`.

---

## 0. Summary

- About **15%** of agensis-agent (~2.1k of 13.8k lines) is the Agensis relay itself: the WS connection, auth, registration, heartbeat, job and permission frames, capability sync, the connection profile and the pairing flow. That part is **unique** and gets ported to TypeScript.
- About **60%** runs coding CLIs: the executors, Claude SDK and Codex app-server pools, Amp runtime, the ACP harness client, CLI discovery and the stream-json parser. CodeSurf already has **duplicates** of all of this in its provider plugins, so it is **dropped**. Agensis jobs then run through `Agent.processMessage`, the same path the TUI and `codesurf node` use.
- The remaining ~25% is product surface the CodeSurf server does not need yet: CursorBuddy, WhatsApp/Signal bridges, LAN mesh, e2b sandbox, shared inference, self-update/supervise, launchd service. It is **deferred**, and the standalone agensis-agent package keeps shipping it.
- **Recommended home:** `apps/cli/src/relay/agensis/`. It is TS, its only dependency is `ws` (already in `apps/cli/package.json:91`), and it plugs into the `NodeAgentHost` turn seam.
- **Six engine gaps block a correct port.** Each is spelled out in §4.6.
  1. Per-session cwd and sandbox mode. The other agents are building this now, so it is a hard dependency.
  2. Approval scopes: CodeSurf only has a boolean `approve`.
  3. Per-session MCP server injection, needed for the Agensis hub tools.
  4. A per-session FIFO, because `NodeSessionHost` *rejects* a busy session.
  5. Usage and finish reason never reach the host seam, so no metering yet.
  6. The hub may validate `metadata.runtime: "agensis"`, and we have no server repo to check.
- **Shared runtime package (§8):** the recommendation is option (b), staged. Extract `packages/agent-runtimes` in the monorepo, built on the existing `ProviderSession` interface plus per-session config, scoped approvals and a closed stop-reason set. Codex goes first, then Amp, Claude and the ACP harnesses ported from agensis. Publish it and switch agensis-agent over last (about −4k lines there). The relay protocol itself is still vendored.
- **Acceptance gate:** port `agensis-agent/tests/daemon-wire-contract.test.cjs` (848 lines) to vitest against the CodeSurf relay. The standalone repo is frozen, not retired, until that passes against a real hub.

---

## 1. Inventory of agensis-agent

Line counts are from `wc -l`. The npm package `@agensis/agensis-agent` is an esbuild bundle of `agensis-cli` (`packages/agensis-agent/build.mjs`, 60 lines). Its runtime deps are `@agentclientprotocol/sdk@1.3.0`, `@anthropic-ai/claude-agent-sdk@^0.3.218` and `ws@^8.20.0`, with optional `e2b` (`packages/agensis-cli/package.json`).

### 1.1 Relay protocol / connection (the part Agensis-specific to the hub)

| Module | Lines | Purpose | Key exports | Ext deps |
|---|---|---|---|---|
| `A:agensis.mjs` | 2616 | Daemon core. Covers multi-hub fan-out (`runAgensisDaemon` 83-152) and the per-hub connection (`runHubConnection` 154-799): auth, register, heartbeat, inbound dispatch, reconnect, parked results. Also config normalisation (801-923), `socketUrl` (941-950), job execution (`runAgentJob` 1155-1404, `runAmpAgentJob` 1406-1546), the prompt builder (1548-1596), CLI command building (1650-1773), the stream-json parser (1822-1950), permission/model resolution (1952-2048), heartbeat metadata (2089-2123), capabilities (2211-2302), memory/skill push (2323-2377), `send`/`sendResult`/backpressure (2442-2471) and `restartSelf` (2495-2535) | `runAgensisDaemon`, `socketUrl`, `agentBackendUrl`, `restartSelf`, `AGENSIS_CLI_VERSION` | `ws` |
| `A:permissions.mjs` | 473 | Human-in-the-loop tool approval broker: request, park, legacy decide, two-phase prepare/receipt/commit, abort, reconnect resume, cancelJob, shutdown. Canonical rule keys, SDK suggestion filtering, synthesised `Bash(prefix:*)` rules, stored-rule matching | `createPermissionBroker`, `requestRuleKeys`, `isAllowedByStoredRules`, `jobPermissionRules`, `disclosedSuggestions`, `PERMISSION_SCOPES`, `PERMISSION_REQUEST_TTL_MS` | none |
| `A:hubConnections.mjs` | 90 | `resolveHubs` (≤32 hubs, canonical URL id, per-hub token and bearer) and `createHubScheduler`, one host-wide capacity budget with per-hub dedupe and cancel | `resolveHubs`, `createHubScheduler` | none |
| `A:hubLiveness.mjs` | 30 | Ping every 15s. Terminates the socket after 120s with no inbound traffic | `watchHubSocket` | none |
| `A:queue.mjs` | 199 | Lane-aware queue: serial within a lane, parallel across lanes up to `concurrency`, keyed dedupe and cancel. Also holds `looksLikeCancel` and `dedupeKey`, which are unused by the relay path | `createQueue` | none |
| `A:teamMessages.mjs` | 51 | `team_message` → `team_message_ack` plus a persisted per-team seq cursor (`team_cursor` on register) | `createTeamInbox` | none |
| `A:stopReasons.mjs` | 185 | Closed stop-reason vocabulary (22-34) and mappers from SDK, Codex and Amp results | `STOP_REASONS`, `stopValue`, `stopReasonFromSdkResult`, … | none |
| `A:deadlines.mjs` | 72 | Hard plus idle deadline race helper | `withDeadlines` | none |
| `A:connectProfiles.mjs` | 189 | Connection profile `~/.agensis/daemon-profiles/<name>.json`: 0600 file, 0700 dir, atomic tmp+rename, `tokenHash`, allow-listed keys | `readDaemonProfile`, `writeDaemonProfile`, `mergeDaemonProfile`, … | none |
| `A:setupFlow.mjs` | 150 | Browser pairing. Starts a loopback HTTP callback on `127.0.0.1:0`, opens `<url>?intent=setup&callback=…&state=…`, verifies `state`, receives `daemonArgs {url, token, workspace, agent}` | `runSetupFlow` | none |
| `A:state.mjs` | 475 | Per-agent state dir `~/.agensis/<ws>/<agent>/`: heartbeat.json, agent.json, soul.md, status.json (agent-written), identity.json (sent on register), heartbeat.md (injected into prompts), update-request.json | `writeAgentMirror`, `readAgentIdentity`, `readAgentStatus`, `writeHeartbeatFileSync`, `resolveStateDir`, … | none |
| `A:status.mjs` | 96 | `agensis status`, a read-only disk view | `collectStatus`, `formatStatus` | none |
| `AB:agensis.mjs` | 453 | CLI: `connect`, `setup`, `supervise`, `service …`, `buddy connect`, `status`, `health`. Flag parser | — | — |

### 1.2 Execution lanes (running coding CLIs)

| Module | Lines | Purpose |
|---|---|---|
| `A:executor.mjs` | 248 | Picks Local, Primary (pooled) or Sandbox executor by family and `run_mode` |
| `A:connectionExecutors.mjs` | 1099 | Warm Claude Agent SDK `query()` session (`createClaudeSdkExecutor` 310) with `canUseTool` → broker (`makeCanUseTool` 266-305). Warm `codex app-server` JSON-RPC (`createCodexAppServerExecutor` 881). Step and segment synthesis |
| `A:ampRuntime.mjs` | 224 | `amp` orb thread runtime, failure codes, repo allow-list |
| `A:cli.mjs` | 226 | Async spawn with a heartbeat (`runCli`) |
| `A:sessionSlots.mjs` | 143 | Lane-sticky warm-session slots per silo |
| `A:acp/client.mjs` | 342 | ACP client over `@agentclientprotocol/sdk` |
| `A:acp/executor.mjs` | 554 | ACP session pool for grok, hermes, goose, kimi, cursor, fx, opencode and openclaw |
| `A:acp/harnesses.mjs` | 212 | Spawn recipes for the harnesses. `NATIVE_RUNTIME_HARNESSES = [claude, codex, amp]` |
| `A:acp/direct.mjs` | 287 | Headless fallback that respawns the CLI every turn |
| `A:acp/discovery.mjs` | 115 | `detectInstalledClis`, `detectHarnessRuntimes`, `suggestCodingCommand` |
| `A:acp/resolve.mjs` | 261 | PATH resolution: process PATH, tool prefixes (Homebrew, Bun, npm, nvm/fnm/volta/mise) and login-shell `command -v` |
| `A:sandbox/e2b.mjs` | 137 | e2b Firecracker provider (`run_mode: 'sandbox'`) |

### 1.3 Peripheral product surface

| Module | Lines | Purpose |
|---|---|---|
| `A:sharedInference.mjs` / `agensis-agent/lib/inference.mjs` | 233 / 233 | Share loopback OpenAI-compatible models with the workspace (`agent_inference_*` frames) |
| `A:bridges.mjs` | 358 | WhatsApp (Baileys), Signal and OpenClaw channel bridges (`bridge_*` frames) |
| `A:mesh.mjs` | 385 | Opt-in LAN daemon-to-daemon job handoff (`peer_*` frames, `policePeerJob`) |
| `A:cursorbuddyConnect.mjs` / `A:cursorbuddyLocalBridge.mjs` | 178 / 946 | CursorBuddy avatar bridge on :8787 |
| `A:memory.mjs` | 153 | Claude memory palace snapshot, opt-in (`agent_memory_sync`) |
| `A:skills.mjs` / `A:slashEnum.mjs` | 218 / 128 | Skill and command name enumeration plus SKILL.md body sync (`agent_skill_sync`) |
| `A:service.mjs` | 468 | launchd / systemd-user unit for `supervise` |
| `A:supervise.mjs` / `A:selfUpdate.mjs` | 254 / 292 | Supervisor with npm self-update and symlink rollback |
| `A:processGuard.mjs` | 269 | Exception-storm guard, EPIPE exit, orphan watchdog (`AGENSIS_SUPERVISOR_PID`), per-agent pid claim |
| `A:daemonHealth.mjs` | 417 | Startup sweep for hung or stale daemons |

---

## 2. Overlap and duplication map

Legend: **UNIQUE** = vendor (port to TS). **DUPLICATE** = drop and use CodeSurf's version. **OVERLAPPING** = merge, and name which side wins and why. **DEFER** = out of scope for "CodeSurf server as a Relay".

| agensis | CodeSurf counterpart | Verdict | Evidence / reasoning |
|---|---|---|---|
| Hub WS connection, auth, register, heartbeat, dispatch (`A:agensis.mjs:154-799`) | `C:relay/ws-transport.ts` (server side), `C:relay/hub.ts` (CodeSurf's own mesh hub), `C:relay/protocol.ts` (`RelayMessage {protocolVersion, op, from, to, seq, ttlMs, payload}`) | **UNIQUE** | Different wire. CodeSurf's relay is a node-to-node `op`-envelope mesh with a steward gate and bounded 4 KB envelopes (`C:relay/envelope.ts:7`). Agensis is `{type}` inbound and `{action}` outbound JSON over an **outbound client** socket. CodeSurf has no outbound hub client, and the bounded envelope forbids the streaming content Agensis needs. Port it as a separate client. Do not bend `RelayMessage` to fit |
| `socketUrl`/`agentBackendUrl` (`A:agensis.mjs:941-970`) | — | **UNIQUE** | `<url>/backend/ws?workspaceId=&agentId=`, plus the localhost dev rewrite to :3142 |
| Reconnect ladder, parked results, dead-peer watchdog (`A:agensis.mjs:205-278`, `A:hubLiveness.mjs`) | `C:relay/session-stream.ts` client has no reconnect. `SessionStreamClient.onClose` just ends the turn (`:387-392`) | **UNIQUE** | Port as-is. Additive jitter `[base, 2·base)`, doubling from 2s to a 30s cap, reset only on `agent_registered` (`:211-215`, `:525`). The 32-frame parked-result buffer is re-sent after register (`:262-278`, `:530`). `DEAD_PEER_TIMEOUT_MS = 120_000` is paired with the hub's pong budget (`:207-210`) |
| Permission broker (`A:permissions.mjs`) | `C:relay/session-stream.ts:59-79` `requestApproval` (boolean, 30s timeout, no reconnect survival). `C:gateway/node-host.ts:22` `approvalRequester → Promise<boolean>`. `C:agent/mixins/turn-control.ts:172` `respondToToolApproval(id, approved: boolean)` | **UNIQUE (protocol) + OVERLAPPING (engine seam)** | The broker is hub protocol: prepare/receipt/commit, `permissionRequestIds` on register, `resumedPermissionRequests`. Vendor it whole; it is pure and has no deps. The *engine* side is CodeSurf's `tool_approval_request` chunk plus `respondToToolApproval`, which has no scope. See gap G2 |
| Stored-rule matching (`requestRuleKeys`, `isAllowedByStoredRules`, `A:permissions.mjs:140-205`) | `C:core/plugins/permission-mode.ts` is modes only. There is no rule list | **UNIQUE** | Needed so `job.agent.metadata.permission_rules` (hub-stored "always" grants) short-circuit the prompt. Runs in the relay adapter before asking the hub |
| Hub scheduler + lane queue (`A:hubConnections.mjs:40-90`, `A:queue.mjs`) | `C:relay/host.ts` `NodeSessionHost` has one turn per session and **throws** on busy (`:102`); `enqueue` returns false (`:180-187`). `C:relay/jobs.ts` `JobHost` is a bounded FIFO without cancel of running jobs (`:96`) | **OVERLAPPING. Keep agensis semantics, thin** | Agensis needs serial-per-conversation FIFO with a host-wide cap plus cancel of queued *and* running jobs by id. `NodeSessionHost` gives turn ownership, abort (`controller`) and reaping, but no queue. Port `createQueue` (199 lines, pure) as the admission layer in front of `NodeSessionHost.message`. Do not use `JobHost`, which returns bounded 4 KB statements and cannot preempt |
| Multi-hub (`A:hubConnections.mjs:6-36`) | — | **UNIQUE** | The user runs Conductor plus agensis.io from one relay (`agensis-agent/docs/multi-hub-relays.md`). Keep it |
| Team inbox (`A:teamMessages.mjs`) | — | **UNIQUE** (Phase 3) | Small. Its wire names are marked "proposed" in `docs/handoff/platform-team.md` |
| Connection profile (`A:connectProfiles.mjs`) | `C:gateway/token.ts` (0600 token file under `~/.codesurf/<name>/token`, `:39-43`). `C:server/registry.ts` (0600 JSON, atomic write, `:82-88`) | **OVERLAPPING. CodeSurf pattern, agensis schema** | Reuse CodeSurf's `~/.codesurf` home, the tmp+rename+0600 write (`registry.ts:82-88`) and `tokensEqual`. Keep agensis's field allow-list idea, trimmed (§4.5). Do not keep reading `~/.agensis/daemon-profiles`, except for a one-shot `--import-agensis-profile` |
| Pairing (`A:setupFlow.mjs`) | — | **UNIQUE** | The browser callback flow is Agensis's server contract (`intent=setup`, `source=agensis-cli`). Port it, but with `source=codesurf` only if the hub accepts it. See risk R5 |
| `runAgentJob` + executors + connectionExecutors + cli.mjs (`A:agensis.mjs:1155-1404`, `A:executor.mjs`, `A:connectionExecutors.mjs`, `A:cli.mjs`) | `C:gateway/node-host.ts` `NodeAgentHost.runTurn` → `Agent.processMessage`. Claude: `C:core/plugins/native/claude-agent-provider.ts` (1748 lines, persistent `query()` with streaming input). Codex: `C:core/plugins/native/codex-provider.ts` (1096, `codex app-server` singleton per conversation) | **DUPLICATE** | Same architecture on both sides: warm SDK session and warm app-server. CodeSurf's version is the engine's native path, and selecting it is already a per-Agent option (`AgentOptions.modelAdapterId`, `C:agent/types.ts:8`). Drop all of agensis's executors |
| Amp (`A:ampRuntime.mjs`, `runAmpAgentJob`) | `C:core/plugins/native/amp-provider.ts` (291 lines, persistent `amp -x --stream-json-input` session) | **DUPLICATE. CodeSurf is better** | CodeSurf holds one amp process per conversation. Agensis spawns `amp` per turn via `runCli` (`A:agensis.mjs:1504`). Keep only agensis's thread continuation: `job.runtime.threadId` → provider resume. That becomes a provider option, not relay code |
| stream-json parser (`A:agensis.mjs:1822-1950`) | CodeSurf providers already decode into `StreamChunk` (`C:types/index.ts:313-341`) | **DUPLICATE** | The relay consumes `StreamChunk`, never NDJSON |
| ACP harness client (`A:acp/{client,executor,harnesses,direct}.mjs`, 1,395 lines; discovery/resolve are the next row) | CodeSurf's `C:gateway/acp.ts` / `C:gateway/acp-client.ts` is a *different* protocol that happens to share the name ACP: CodeSurf's own versioned SSE envelope for driving CodeSurf sessions (`acp.ts:19-35`). There is **no** `@agentclientprotocol/sdk` client in CodeSurf (grep: 0 hits) | **UNIQUE capability, wrong layer. DEFER to a provider plugin** | grok, kimi, goose, cursor-agent and fx over ACP are genuinely missing from CodeSurf. They belong as a CodeSurf provider plugin (`core/plugins/native/acp-harness-provider.ts`) so the TUI gets them too, not inside the relay. A separate workstream, noted in Phase 4 |
| CLI discovery (`A:acp/discovery.mjs`, `A:acp/resolve.mjs`) | `C:utils/cli-check-cache.ts` (memoised `execFileSync` probes, 30s TTL). `C:mcp/command-exists.ts:26-45` (`resolveCommandPath`, spawn-faithful PATH search) | **OVERLAPPING. Agensis's search path is better for services** | CodeSurf searches only the spawn PATH (`command-exists.ts:31-38`). A server started under launchd or systemd, or by the desktop app, inherits a thin PATH and will report CLIs as missing. Agensis's `buildSearchPath` covers Homebrew, Bun, npm-global, nvm/fnm/volta/mise and a cached login-shell PATH (`resolve.mjs:83-236`). Port **only** `buildSearchPath` + `resolveCommandPath` into `C:utils/` as an option to CodeSurf's resolver, wrapped in `cachedCliCheck`. Drop `AGENT_CLI_NAMES`: capability sync derives runtimes from registered providers (§4.4) |
| Sandbox (`A:sandbox/e2b.mjs`, root-yolo heuristics `A:agensis.mjs:1681-1711, 2059-2084`) | `C:tools/bash.ts` shuru sandbox mode (`:168`, `:577-619`), `setSandboxMode` | **DUPLICATE (local) / DEFER (e2b)** | Agensis `permission_mode` maps onto CodeSurf sandbox plus permission mode (§4.2). e2b `run_mode: 'sandbox'` jobs are refused with `errorCode: "run_mode_unsupported"` until someone asks |
| Permission modes (`normalizePermissionMode`, `A:agensis.mjs:1983-1992`) | `C:core/plugins/permission-mode.ts` (`default`/`acceptEdits`/`bypassPermissions`/`plan`, `CODEX_APPROVAL_FROM_PERMISSION` `:68-75`) | **OVERLAPPING. CodeSurf wins, add a mapper** | CodeSurf already maps modes across adapters. The relay needs a 3-line agensis → CodeSurf mapping (§4.2) |
| `sessionSlots.mjs` | `NodeSessionHost` keyed by session id | **DUPLICATE** | Per-lane CodeSurf sessions give every conversation its own Agent and history. That is the behaviour `sessionSlots` was bolted on to approximate (`A:sessionSlots.mjs:5-19`) |
| `deadlines.mjs` idle/hard timeout | `C:relay/session-stream.ts:411` `REMOTE_TURN_IDLE_TIMEOUT_MS` (front side only). No node-side turn deadline | **OVERLAPPING. Port `withDeadlines`** | The relay must stop a silent turn at 9 min, just inside the hub's 10-min reaper (`A:agensis.mjs:56-70`). CodeSurf has no node-side equivalent. Port the 72-line pure helper and wire `onTimeout` → session `controller.abort()` |
| `stopReasons.mjs` | `C:agent/types.ts` `TurnTerminalState` (success/failure/cancelled), `ProcessMessageFinishReason` (`C:agent/turns/types.ts:15`) | **UNIQUE (vocabulary)** | Keep the closed enum (it is shared with the hub) and add a CodeSurf → enum mapper (§3.6) |
| state.mjs (heartbeat.json, identity.json, status.json, heartbeat.md) | `C:server/registry.ts` (pid/port record) | **OVERLAPPING. Minimal port** | Keep identity.json (sent on register) and status.json (folded into the heartbeat) under `~/.codesurf/agensis/<profile>/`. Drop agent.json/soul.md mirrors and heartbeat.md prompt injection. Liveness comes from the server registry |
| slashEnum / skills / memory sync | `C:utils/skills.ts:141` `discoverSkills(projectRoot)`, `C:utils/workflows.ts:202` `discoverUserWorkflows`, `D:bin/skills-index.mjs:583`, `D:bin/memory-loader.mjs:17` | **OVERLAPPING. CodeSurf discovers, agensis frames** | Names and bodies come from CodeSurf's discovery. The fingerprint, hash and frame shape come from agensis (`A:skills.mjs`, `A:agensis.mjs:2356-2377`). Memory sync stays opt-in and off (Phase 3) |
| `processGuard.mjs` | `C:utils/process-guards.ts` (crash log, rejection interceptors) | **OVERLAPPING. Complementary** | CodeSurf's guards own crash logging. From agensis take only the per-agent **pid claim** (so two servers never register the same agent id) if the server registry does not already prevent it |
| `service.mjs`, `supervise.mjs`, `selfUpdate.mjs`, `daemonHealth.mjs`, `status.mjs` | `C:server/registry.ts` + `codesurf server start/stop/status/list` (in flight). `C:daemon/codesurf-daemon.ts` | **DUPLICATE / DEFER** | Server lifecycle belongs to the server-lifecycle work. A launchd/systemd "start at login" is a server feature, not a relay feature. If wanted, lift `renderLaunchAgent`/`renderSystemdUserUnit` (`A:service.mjs:123-206`) into server tooling later |
| `restartSelf` (`agent_restart` frame) | — | **DEFER → degrade** | Answer `agent_restart` by reconnecting the relay link only. Never re-exec the CodeSurf server from a hub frame |
| sharedInference, bridges, mesh, cursorbuddy*, e2b | — | **DEFER** | Separate product features. Unknown frames are logged and ignored. The hub already tolerates older daemons that lack them |
| Prompt builder (`buildPrompt`, `A:agensis.mjs:1548-1596`) | CodeSurf system prompt plus skills/memory context in the Agent | **OVERLAPPING. Thin port** | Keep the Agensis-specific *context header*: workspace, session, agent name/handle, description, soul, system_prompt, instructions, thread-widget instruction, identity boundary, then the user message. It goes in as the turn text. Drop the status-file, heartbeat.md and lean 10 KB truncation (the truncation existed for `claude -p` argv) |
| Lean CLI MCP injection (`leanMcpRuntime`, `A:agensis.mjs:1797-1807`) | MCP servers come only from user settings (`C:utils/settings.ts:972` `loadMcpServers`, used at `C:core/plugins/native/claude-agent-provider.ts:1673`) | **GAP (G3)** | Agensis jobs expect hub tools (create_thread_item, …) at `<url>/backend/mcp` with bearer `AGENSIS_MCP_TOKEN` = agent token |

Net result: **ported ≈ 2.1k lines** (relay core, broker, queue, liveness, hubs, profile, setup, stop reasons, deadlines, capability framing). **Dropped ≈ 8k lines**. **Deferred ≈ 3.5k lines**.

---

## 3. The Agensis relay protocol (for the implementer)

All frames are JSON text over one WebSocket. The daemon sends `{action: …}`. The hub sends `{type: …}`, except the `auth` frame, which the daemon sends as `{type: "auth"}`.

### 3.1 Connection and authentication

1. **URL:** `new URL(baseUrl)` with `http→ws` / `https→wss`, pathname `+ "/backend/ws"`, query `workspaceId`, `agentId`, no hash (`A:agensis.mjs:941-950`). Dev rewrite: localhost on :5173, :8888 or an ephemeral port is rewritten to `127.0.0.1:3142` (`:952-970`). Base URLs are canonicalised by `resolveHubs`: http(s) only, no userinfo, query or fragment, trailing slashes stripped (`A:hubConnections.mjs:18-35`).
2. **Upgrade headers:** `Authorization: Bearer <hubBearer>` only when a proxy bearer is configured (`A:agensis.mjs:387`). The agent token **never** rides the URL (F14, `:416-418`).
3. **On `open`:** send `{type:"auth", token:"aga_…"}` (`:418`). The wire test asserts this is frame #1 (`tests/daemon-wire-contract.test.cjs:44-46`).
4. **Hub reply:** `{type:"authenticated"}` or `{type:"system", event:"authenticated"}` (`:510`). Then send `agent_register` (3.2).
5. **30s auth deadline:** if not registered, `terminate()` (`:402-408`).
6. **Frame gating:** until registration is sent, drop everything. Until `agent_registered` arrives, accept only `agent_registered` and `error` (`:514-515`).

### 3.2 Registration

Sent by the daemon (`A:agensis.mjs:441-468`):

```jsonc
{ "action": "agent_register",
  "workspaceId": "...", "agentId": "...", "handle": "slug", "name": "Display",
  "host": "<os.hostname()>", "cwd": "<default cwd>",
  "permissionRequestIds": ["<ids still parked in this process>"],
  "identity": { /* optional, from identity.json: avatar, description, soul, voice{cartesia_voice_id,speed,emotion}, name */ },
  "metadata": {
    "codingCmd": "...", "model": "...", "permissionMode": "default|accept_edits|yolo",
    "permissionFlags": [],                 // ["--no-sandbox","--yolo"] when yolo
    "permissionDecisionReceipts": true,    // REQUIRED for two-phase approvals
    "once": false,
    "runtime": "agensis",                  // asserted by the wire test (see R5)
    "executionRuntime": "claude|codex|amp|custom",
    "version": "0.1.56" } }
```

The hub answers with `{type:"agent_registered", connection:{name, host, agentId?, workspaceId?, handle?}, agent:{name, handle, model, permission_mode, memory_dir}, resumedPermissionRequests:[ids]}` (`:516-557`). On receipt the daemon, in order:
- sets registered and resets backoff
- applies the agent config (`applyAgentConfig` `:2165-2175`: name, handle, model, permission mode, memory_dir)
- **flushes parked results**
- `permissions.resume(resumedPermissionRequests)`: denies every parked id not listed
- persists the profile (`onRegistered`)
- pushes memory (opt-in), skills and capabilities
- sends `team_cursor` if it holds any cursors

Other register-time hub frames:
- `agent_config` (live config update, `:559-564`)
- `agent_disabled` (stop the whole relay, `:703-709`)
- close code `1008` with "agent deactivated|authentication failed" (stop, no reconnect, `:753-757`)

### 3.3 Heartbeat and liveness

- Every `heartbeatMs` (15s), send `{action:"agent_heartbeat", capabilitiesHash, memoryHash, skillsHash?, metadata}` (`:472-503`). `metadata` = `{busy, queueSize, cwd, model, permissionMode, permissionFlags, daemon:{runtime, version, pid, node, platform, arch, host, cwd}, activeInferenceByModel?, agentStatus?, agentNote?, agentStatusAt?}` (`:2089-2123`). The hub merges `metadata` into the connection row. The hashes ride at the top level so the hub can detect drift.
- On hash drift the hub nudges `agent_capabilities_refresh`, `agent_memory_refresh` or `agent_skills_refresh` (`:576-594`).
- WS-level liveness: ping every 15s. With no inbound `ping`, `pong` or `message` for 120s, terminate (`A:hubLiveness.mjs`). This pairs with the hub's `LIVENESS_MAX_MISSED_PONGS × interval`.
- **Reconnect:** delay = `base + rand(0, base)`, where `base = min(2000·2^n, 30000)`, and n resets only on `agent_registered` (`:205-215`). A clean `1012 "restarting"` close is used for restarts. **Do not** use 1008, which stops the fleet (`:2487-2488`).

### 3.4 Job dispatch

The hub sends `{type:"agent_job", job:{…}}` (`:711-730`). Fields read across the codebase:

| Field | Meaning | Where read |
|---|---|---|
| `id` | job id, dedupe key | `:711-714` |
| `workspaceId`, `sessionId`, `threadParentId` | conversation. Lane = `JSON.stringify([sessionId, threadParentId])` | `:985-989` |
| `prompt` | transcript plus latest message (already server-composed) | `:1590` |
| `cwd` | working dir override, otherwise the profile cwd | `:1266` |
| `model` / `agent.model` | model; `auto` / empty → default | `:1952-1971` |
| `permissionMode` / `permission_mode` / `agent.permissionMode` / `agent.permission_mode` | `default` / `accept_edits` / `yolo` (aliases `:1983-1988`) | `:1973-1981` |
| `agent.{name, handle, description, soul, system_prompt, instructions, tools[], skills[], run_mode}` | persona / context. `run_mode` = `daemon` / `sandbox` | `:1549-1593`, `:1694` |
| `agent.metadata.{executionRuntime, runtime, acp_harness, host_folders, permission_rules}` | runtime pin, harness pin, extra dirs (server-gated), stored "always" rules | `:1788-1795`, `:2016-2023`, `A:permissions.mjs:182-189` |
| `hostFolders` / `host_folders` | extra dirs, job-level | `:2017-2020` |
| `runtime.{threadId, continuationRequired}`, `ampThreadId`, `metadata.ampThreadId` | Amp thread continuation | `:1478-1487` |
| `voiceHuddle` | spoken turn, so use low reasoning effort | `:1638-1648` |

The hub may also send:
- `{type:"agent_job_cancel", jobId, reason}`: deny any parked approvals for the job first, then cancel queued or running work (`:599-611`).
- `{type:"agent_restart", reason, drainMs}` (`:565-575`).

### 3.5 Streaming results (daemon → hub)

- `agent_job_delta` `{jobId, content, elapsedMs, model, permissionMode, permissionFlags}`: `content` is the **whole accumulated text of the currently open block**, not an increment. It is sent on start (empty), every 1s by timer, and at most every 150ms on data (`:1195-1206`, `:1233-1235`, `:1307-1311`). It is **skipped** when `ws.bufferedAmount > 1 MiB`, because the next delta supersedes it (`:2453-2456`).
- `agent_job_step` `{jobId, kind:"tool", name, detail, elapsedMs}`: one per tool call, deduped by tool-use id (`:1210-1219`, `:1903-1913`). `detail` = `summarizeToolInput(input)` (`A:connectionExecutors.mjs:217`).
- `agent_job_segment` `{jobId, text, elapsedMs}`: closes a finished assistant text block. After a segment the live `content` restarts empty (`:1224-1231`, `:1848-1858`).
- `agent_job_result` (final, **must not be lost**, so it goes through `sendResult` → park on socket loss, `:2467-2471`):
  `{jobId, response, error, errorCode?, stopReason?, stopDetail?, numTurns?, costUsd?, permissionDenials?, usage?{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}, elapsedMs, model, permissionMode, permissionFlags, metadata?}` (`:1379-1398`).
  - Omit `stopReason` when unknown. The wire test asserts absence, not a guess (`tests/daemon-wire-contract.test.cjs:101-108`).
  - `errorCode` values seen: `execution_failed` (`:346`), `runtime_mismatch` (`:1166`), `amp_*`.

### 3.6 Stop-reason vocabulary

`completed | cancelled | max_tokens | max_turns | max_budget | refused | idle_timeout | hard_timeout | permission_denied | agent_error | connection_lost` (`A:stopReasons.mjs:22-34`). The hub keeps a byte-identical copy.

Mapping from CodeSurf:

| CodeSurf outcome | stopReason |
|---|---|
| `done` with no error | `completed` |
| `TurnTerminalState.cancelled`, or the job was cancelled | `cancelled` |
| `ProcessMessageFinishReason "length"` | `max_tokens` |
| `"content-filter"` | `refused` |
| `error` chunk / failure | `agent_error` |
| relay idle deadline fired | `idle_timeout` |
| relay hard deadline fired | `hard_timeout` |

Usage comes from `ProcessMessageUsage` (`C:agent/turns/types.ts:17-27`): `inputTokens→input_tokens`, `outputTokens→output_tokens`, `cacheReadTokens→cache_read_input_tokens`, `cacheWriteTokens→cache_creation_input_tokens`. **Caveat (G6):** usage and `ProcessMessageFinishReason` reach only the `ProcessMessageObserver` passed to `processMessage`, and `NodeAgentHost` passes `{}` (`C:gateway/node-host.ts:53`). The relay only sees `StreamChunk`s through `SessionObserver` (`C:relay/host.ts:14-17`). So until G6 is closed, `usage`, `costUsd` and the `length → max_tokens` / `content-filter → refused` rows have no data path. Omit them from `agent_job_result` (the wire tolerates absence), and map only `completed`, `cancelled`, `agent_error` and the two timeouts.

### 3.7 Tool approvals (two-phase)

1. **Request (daemon):** `{action:"agent_permission_request", jobId, requestId(uuid), toolName, title, description, detail, input, rules:[canonical keys an "always" would grant], scopes:["once","session","always"] | ["once","session"], expiresInMs}` (`A:permissions.mjs:271-289`). If the send fails, deny immediately (`:290-292`). The TTL is 10 min (`:41`), which auto-denies with a readable message.
2. **Legacy decision (hub):** `{type:"agent_permission_decision", requestId, behavior:"allow"|"deny", scope, decidedBy, message}` (`:317-326`). Ignored once a prepare is pending.
3. **Two-phase decision (hub):**
   - `agent_permission_prepare {requestId, behavior, scope, decidedBy, message}`: the daemon caches it and receipts `{action:"agent_permission_prepared", requestId, accepted}` **on the socket that delivered it** (`A:agensis.mjs:616-628`, `A:permissions.mjs:335-373`). Two differing prepares poison the request.
   - `agent_permission_commit {requestId}` releases the tool, and only after a successful receipt (`:376-383`).
   - `agent_permission_abort {requestId, message}` denies (`:392-399`).
4. **Reconnect:** parked requests **survive** a socket close. `permissionRequestIds` goes out on register, and the hub returns `resumedPermissionRequests`. Anything not returned is denied (`:411-439`). A 45s backstop denies everything if no reconnect lands (`A:agensis.mjs:235-253`).
5. **Rule identity:** `Tool(content)` strings. Only `addRules`+`allow` suggestions are honoured; `setMode` and `addDirectories` are dropped (`A:permissions.mjs:81-103`). With no suggestions, synthesise `Bash(<cmd> <sub>:*)` for unchained commands only (`:140-152`). Stored rules come from `job.agent.metadata.permission_rules` and short-circuit the request (`A:connectionExecutors.mjs:280-282`).

### 3.8 Capability sync

`{action:"agent_capabilities_sync", workspaceId, agentId, skills[], commands[], clis[], mcpServers[], sharedModels[], runtimes{id:{id,label,available,path?,transport}}, codingRoute, shared, memoryRoot, reach?, hash, memoryHash, skillsHash}` (`A:agensis.mjs:2277-2302`).
- Sent on register and on `agent_capabilities_refresh`.
- `hash = sha1(JSON(canonical fields)).slice(0,16)` (`:2195-2197`, `:2247`).
- The same hashes ride every heartbeat.

Related frames:
- `{action:"agent_skill_sync", workspaceId, agentId, hash, skills:[{name, body, truncated, …}]}` (`:2356-2377`), 64 KiB per skill.
- `{action:"agent_memory_sync", workspaceId, agentId, root, files}` (opt-in, `:2323-2340`).

### 3.9 Deferred frame families (ignore in Phase 1; log once)

- `agent_inference_request/cancel` → `agent_inference_started/delta/result/error` (`:595-676`, `A:sharedInference.mjs:133-203`)
- `bridge_start/send/stop` → `bridge_status/inbound`
- `peer_*` / `agent_reach_*` (mesh)
- `team_message` → `team_message_ack`, `team_cursor` (small, Phase 3)

---

## 4. Target design

### 4.1 Placement

```
apps/cli/src/relay/agensis/
  protocol.ts        # frame types (inbound {type}, outbound {action}), STOP_REASONS, socketUrl, resolveHubs
  connection.ts      # AgensisHubConnection: one hub. Auth, register, heartbeat, dispatch, reconnect ladder, parked results, liveness
  relay.ts           # AgensisRelay: N hubs, one shared admission queue, start/stop, status for `codesurf server status`
  permissions.ts     # vendored broker + rule keys (port of permissions.mjs, near-verbatim)
  queue.ts           # vendored lane queue (port of queue.mjs + createHubScheduler)
  deadlines.ts       # vendored withDeadlines
  job-runner.ts      # Agensis job → CodeSurf session turn (the only file that knows both worlds)
  stream-mapper.ts   # StreamChunk → delta/step/segment/result accumulator
  capabilities.ts    # CodeSurf registry/discovery → agent_capabilities_sync + hashes
  profile.ts         # ~/.codesurf/agensis/<profile>.json (0600), import from ~/.agensis
  setup.ts           # browser pairing (port of setupFlow.mjs)
  LICENSE-agensis    # MIT notice for the vendored files
```

Why not a separate `packages/agensis-relay`:
- `connection.ts` and `job-runner.ts` depend on CodeSurf's `StreamChunk`, `NodeSessionHost` and the provider registry.
- Only `protocol.ts`, `permissions.ts`, `queue.ts` and `deadlines.ts` are host-agnostic. If desktop or `codesurfd` ever need to talk to Agensis directly, promote exactly those four files to `packages/agensis-relay` then. That costs nothing now and avoids a package with one consumer.

### 4.2 Job → CodeSurf server session

This sits on top of the in-flight "one server, many folders" work, where every session carries `cwd` and `sandboxMode`.

| Agensis | CodeSurf |
|---|---|
| lane `[hubId, sessionId, threadParentId]` | one CodeSurf server session per lane. `sessionId = "agensis:" + sha256(hubId, workspaceId, agentId, sessionId, threadParentId).slice(0,24)`, created lazily through `NodeSessionHost.createSession(id)` (`C:relay/host.ts:73`). The history of each conversation stays in its own Agent (`persistSession: true`, like `C:gateway/node-host.ts:47-49`) |
| queue / concurrency | `relay/agensis/queue.ts` in front of `NodeSessionHost.message()`. Serial per lane, host-wide cap `maxConcurrency` (default 2, as in agensis). `message()` is only called when the lane is idle, so the "busy" throw (`host.ts:102`) is never hit |
| `job.cwd` / profile cwd / `host_folders` | session `cwd`, which must be inside the profile's allowed roots: profile cwd plus profile `hostFolders` plus server-gated `agent.metadata.host_folders`. `job.cwd` outside the roots is refused with `errorCode:"cwd_not_allowed"`. This is stricter than agensis, which trusts `job.cwd` (`A:agensis.mjs:1266`), because a CodeSurf server may be user-scoped over many folders |
| model (`job.agent.model` / `job.model`) | `normalizeModelId` → `getModelById(id)` (`C:core/plugins/registry.ts:416`) → `RegisteredModel.adapterId`, or when that is absent `providerId` → `getModelProviderById` (`:420`; fields at `C:core/plugins/api.ts:494-501`). Unknown or `auto` → the profile default model, otherwise the server default |
| runtime pin (`agent.metadata.executionRuntime`/`runtime`: claude, codex, amp, grok, …) | `modelAdapterId`: `claude` → the Claude Agent SDK adapter, `codex` → the codex app-server adapter, `amp` → the amp adapter, `opencode` → the opencode adapter. A pin with no installed or authenticated adapter → `errorCode:"runtime_unavailable"`. This replaces agensis's `runtime_mismatch` logic (`:1158-1172`) |
| permission mode: `default` / `accept_edits` / `yolo` | CodeSurf adapter permission mode through `permission-mode.ts`: `default→default`, `accept_edits→acceptEdits`, `yolo→bypassPermissions`. Bash sandbox: `yolo` → `off`, otherwise the server's configured sandbox mode (shuru when enabled). **yolo is capped by the profile's `maxPermissionMode`** (default `accept_edits`). A job cannot raise its own permissions beyond what the local operator allowed. This follows the mesh rule `policePeerJob` (`A:mesh.mjs:61`) |
| approvals | `NodeAgentHost.approvalRequester` (`C:gateway/node-host.ts:22,87-90`) → stored-rule check → `broker.request({jobId, toolName, title, detail, input})` → boolean. Phase 2 adds scopes (G2). **Today nothing sets `approvalRequester`**: `node-command.ts:49-55` builds `NodeAgentHost` without one, and `SessionStreamServer.requestApproval` has no caller. So the relay is the first real requester, and the requester is **one callback per host**. The relay therefore installs a **router**: sessions whose id starts with `agensis:` go to the broker; everything else goes to the session-stream front (`requestApproval`) or the existing deny/`--auto-approve` behaviour. Without the router, a TUI front and an Agensis job on the same server would answer each other's approvals |
| streaming | `stream-mapper.ts` consumes `StreamChunk`s from the session observer (`host.attach`, `C:relay/host.ts:89-93`) |
| cancel (`agent_job_cancel`) | `broker.cancelJob(jobId)`, then `queue.cancel(jobId)`: removes a queued job, or aborts the running one via `NodeSessionHost`'s per-turn `controller`. **Needs** a `NodeSessionHost.abortTurn(sessionId)` (4 lines; `destroy()` aborts but also deletes the session) → Agent `abort({userInitiated:false})` (`node-host.ts:56`) |
| deadlines | `withDeadlines(run, {timeoutMs: 30m, idleTimeoutMs: 9m})`. `touch()` on every chunk, and `onTimeout` → `abortTurn`. Stop reason `idle_timeout` / `hard_timeout` |
| prompt | Turn text = the Agensis context header (§2, prompt builder row) + `job.prompt`. System prompt, skills and memory come from CodeSurf |
| hub tools | per-session MCP server `{id:"agensis", transport:"http", url:"<hub>/backend/mcp", headers:{Authorization:"Bearer <token>"}}` (G3) |

**Stream mapping** (`stream-mapper.ts`):

| `StreamChunk.type` (`C:types/index.ts:313-341`) | Agensis frame |
|---|---|
| `content` | append to `open`. Throttled `agent_job_delta{content: open}` (150ms, plus a 1s timer, skipped when `bufferedAmount > 1 MiB`) |
| `tool_calls` (yielded at `C:agent/turns/batch-turn.ts:220` and, for owning adapters, `C:agent/turns/session-turn.ts:517`), or a `tool_result` whose `toolCall.id` has not been seen yet (`session-turn.ts:630`) | if `open` is non-empty, send `agent_job_segment{text: open}` and set `closed += open; open = ""`. Then one `agent_job_step{kind:"tool", name, detail}` per call, deduped by `toolCall.id` |
| `tool_result` | nothing (optional future `kind:"tool_result"`) |
| `reasoning` | nothing in Phase 1. The hub has no reasoning frame; do not leak it into `content` |
| `tool_approval_request` | handled by the approval requester, not forwarded |
| `status`, `warning` | heartbeat metadata only |
| `error` | `error += content` |
| `done` | final `agent_job_delta`, then `agent_job_result{response: closed + open, error, stopReason, usage, elapsedMs, model, permissionMode}` via `sendResult` (parks on socket loss) |

### 4.3 Server lifecycle integration

- The relay runs **inside the CodeSurf server process** (the `codesurf server start` child, i.e. the `EngineNode` in `C:gateway/node-command.ts:56-73`), started when the server boots with one or more linked Agensis profiles.
- The server keeps its local WS API (TUI and desktop fronts). Agensis is just another front, reached outbound.
- There is **one relay per server**, and each linked profile gets its own hub connection. The Agensis agent id identifies the server in the dashboard.
- A user-scoped server with many folders advertises every allowed root in `cwd` / `hostFolders`. A project-scoped server advertises its project root.
- A pid claim keyed by `(workspace, agent)` under `~/.codesurf/agensis/<profile>/relay.pid` stops two servers from registering the same agent. Use `C:server/registry.ts:isPidAlive` (`:41-49`).

### 4.4 Capability sync from CodeSurf (no agensis discovery code)

| Field | Source |
|---|---|
| `runtimes` | `getRegistrySnapshot().modelProviders` (`C:core/plugins/registry.ts`). Per `RegisteredModelProvider` (`C:core/plugins/api.ts:631-660`) → `{id: providerId, label, available: (await auth.check(ctx)).ok, transport: connectionMode, models: (models ?? await listModels()).map(m=>m.id)}`. Adds a `models` list, which agensis never had: the dashboard can then offer CodeSurf's catalog for pinning. `id` keys stay `claude` / `codex` / `amp` for compatibility |
| `clis` | the provider availability probes via `cachedCliCheck` (`C:utils/cli-check-cache.ts:11`), using the ported `buildSearchPath` |
| `mcpServers` | `loadMcpServers().filter(s=>s.enabled).map(s=>s.id)` (`C:utils/settings.ts:972`) |
| `skills` | `discoverSkills(root)` for each allowed root (`C:utils/skills.ts:141`) → names |
| `commands` | `discoverUserWorkflows(root)` (`C:utils/workflows.ts:202`) plus `services.commands.listDynamic()` (`C:core/plugins/api.ts:771`) → `{name, parent}` |
| `codingRoute` | `true` unless the profile sets `noCoding` |
| `shared`, `sharedModels` | `false`, `[]` (deferred) |
| `memoryRoot` | `null` unless opted in (Phase 3) |
| `reach` | `null` (no mesh) |
| `hash` | same canonical-JSON sha1/16 recipe (`A:agensis.mjs:2247`) so the drift nudges keep working |
| `agent_skill_sync` | bodies from `DiscoveredSkill.skillMdPath`, 64 KiB cap, stat-only fingerprint (port `skillsFingerprint`, `A:skills.mjs:177`) |

### 4.5 Linking a server (UX)

```
codesurf server connect agensis --url https://agensis.io --token aga_… --workspace W --agent A [--name "Jason's Mac"] [--server default] [--cwd …] [--host-folder …] [--max-permission accept_edits]
codesurf server connect agensis --setup [--url https://agensis.io]        # browser pairing (setup.ts)
codesurf server connect agensis --import-agensis-profile default          # one-shot copy of ~/.agensis/daemon-profiles/default.json
codesurf server disconnect agensis [--profile P]
codesurf server status                                                     # per-hub: connecting|online|disconnected, last register, active jobs
```

- **Paste-in form:** the existing "connection command" in an Agensis agent profile already emits `--url --token --workspace --agent`. The flag names are kept identical so the user can paste it after `codesurf server connect agensis`. Pasting `agensis connect …` as-is is **not** supported.
- **Profile file:** `~/.codesurf/agensis/<profile>.json`, dir 0700 and file 0600, atomic tmp+rename (the `C:server/registry.ts:82-88` pattern).
  - Fields: `{version, hubs:[{url, token, bearer?, mcp?}], workspace, agent, handle, name, server, roots:[cwd, …hostFolders], defaultModel?, maxPermissionMode, maxConcurrency, syncSkills, syncMemory, tokenHash}`.
  - The token lives only in this file. Never in the server registry record, never in logs; redact it in `socketUrl` logging as `A:agensis.mjs:386` does.
  - `CODESURF_AGENSIS_TOKEN` env override for CI.
- **Desktop and settings:** later, a settings panel writes the same profile file. Out of scope here.
- **First register:** "Connected as <name> on <host>". The server log line matches agensis wording so support docs carry over.

### 4.6 Engine gaps (must be closed; each named with what breaks without it)

| # | Gap | Evidence | Needed change | Breaks without it |
|---|---|---|---|---|
| G1 | Process-global bash cwd and sandbox | `C:agent/agent.ts:203-206` (`getHostServices().bash.setSandboxMode`), SessionStore opened on `bash.cwd()` (`:237-244`) | Session-scoped `cwd` + `sandboxMode`. **This is the in-flight engine-cwd work, so it is a hard dependency** | Two concurrent Agensis jobs in different folders run in whichever cwd was set last. `yolo` in one lane disables the sandbox for all lanes. Phase 1 must force `maxConcurrency = 1` and a single root until G1 lands |
| G2 | Approval is boolean, 30s front timeout, no scope | `C:relay/session-stream.ts:59-79`, `C:gateway/node-host.ts:22`, `C:agent/mixins/turn-control.ts:172` | Phase 1: boolean through the broker (the relay owns the 10-min TTL, not session-stream's 30s). `once` = allow. `session` = relay-side per-lane cache of the request's rule keys, auto-allow on match. `always` = the hub persists it and the next job carries it in `permission_rules` → stored-rule short-circuit. Phase 2: an `Agent` per-session allow list so an SDK-native "session" grant equals the SDK's `updatedPermissions` (`A:connectionExecutors.mjs:302`) | Without the relay-side cache, "allow for session" re-prompts on every call. **Rule suggestions:** CodeSurf's `tool_approval_request` carries no SDK `suggestions`, so rules are always synthesised (`Bash(prefix:*)` only). Every non-Bash tool offers once/session only. Be honest about this in the card |
| G3 | No per-session MCP injection | `C:utils/settings.ts:972`, `C:core/plugins/native/claude-agent-provider.ts:1673` | `AgentOptions.extraMcpServers?: McpServerConfig[]` (`C:agent/types.ts:5-14`), merged into the provider's MCP set for that session only | Agensis thread widgets and hub tools are unavailable. Jobs still run, but the prompt must not mention the tools |
| G4 | NodeSessionHost rejects a busy session; no abort-without-destroy | `C:relay/host.ts:102,141-148,180-187` | The relay queue guarantees one turn per lane. Add `abortTurn(sessionId)` | Cancelling a running job destroys the conversation's Agent and history |
| G6 | Usage / finish reason do not reach the host seam | `C:gateway/node-host.ts:53` passes `observer = {}`; `HostedTurnRunner` yields only `StreamChunk` (`C:relay/host.ts:12`) | Let `NodeAgentHost.runTurn` accept an optional `ProcessMessageObserver`, or emit a terminal `status` chunk carrying `{usage, finishReason}` | No token metering or `max_tokens` / `refused` stop reasons for Agensis; everything else works |
| G5 | Node-side turn deadline | only front-side `REMOTE_TURN_IDLE_TIMEOUT_MS` (`C:relay/session-stream.ts:411`) | `withDeadlines` in `job-runner.ts` | A hung provider holds the lane until the hub's 10-min reaper, and the human sees "stopped responding" |

`C:agent/**`, `C:relay/host.ts` and `C:gateway/node-host.ts` are in the concurrent agents' area. Coordinate G1, G3, G4 and G6 through the room before editing.

### 4.7 Fate of the standalone agensis-agent repo

**Recommendation: keep and freeze, then thin.** If option (b) in §8 is adopted, "thin" means agensis-agent imports `@codesurf/agent-runtimes` instead of keeping its frozen copy (§8.5 B3).

- **Now:** freeze `@agensis/agensis-agent` at the current feature set. It stays the published install for users without CodeSurf, and the home of the deferred features (bridges, CursorBuddy, shared inference, mesh, e2b, supervise/self-update).
- **After Phase 2 passes the wire gate against a real hub:** mark `agensis connect`'s coding-execution lanes as maintenance-only in its README and point coding users at `codesurf server connect agensis`.
- **Retire** only when the hub team confirms no traffic depends on the deferred frame families. Retiring earlier would silently drop WhatsApp/Signal bridges and shared inference for existing users.
- A "thin wrapper" (agensis → spawns CodeSurf) is **not** recommended. It would ship two runtimes in one package and duplicate the lifecycle. Users who want CodeSurf run CodeSurf.

---

## 5. Phased implementation plan

### Phase 0: prerequisites (coordination, no Agensis code)

- **Confirm with engine-cwd:** a session record carries `cwd` + `sandboxMode` (G1), and when it lands.
- **Confirm with server-lifecycle:**
  - a hook for "on server boot, start subsystems": the relay registers there
  - `codesurf server connect` as a subcommand name
  - `server status` extensibility
- **Ask the Agensis hub owner (it is not in either repo):**
  - is `metadata.runtime` validated? Can it be `"codesurf"` with `version` = the CLI version?
  - is `source=codesurf` accepted in setup pairing?
  - is extra `runtimes.*.models` tolerated?

### Phase 1: relay core, single hub, boolean approvals (acceptance: wire contract)

Files (new unless marked):
- `C:relay/agensis/protocol.ts`: frame types, `socketUrl`, `resolveHubs`, `STOP_REASONS` (from `A:agensis.mjs:941-989`, `A:hubConnections.mjs:6-36`, `A:stopReasons.mjs:20-40`)
- `C:relay/agensis/connection.ts`: port of `A:agensis.mjs:154-799` minus cursorbuddy, mesh, bridges, inference and restart re-exec. Keep socket-identity guards (`socket !== ws`) everywhere, as the original does (`:388-392`, `:440`)
- `C:relay/agensis/liveness.ts`: port of `A:hubLiveness.mjs`
- `C:relay/agensis/permissions.ts`: port of `A:permissions.mjs` (typed, same behaviour)
- `C:relay/agensis/queue.ts`: port of `A:queue.mjs` `createQueue` + `createHubScheduler`
- `C:relay/agensis/deadlines.ts`: port of `A:deadlines.mjs`
- `C:relay/agensis/stream-mapper.ts`, `C:relay/agensis/job-runner.ts` (§4.2)
- `C:relay/agensis/capabilities.ts`: runtimes/clis/mcpServers/skills/commands + hashes (§4.4). No skill bodies yet
- `C:relay/agensis/profile.ts`: 0600 profile + env override
- `C:relay/agensis/relay.ts`: owns connections, exposes `status()`
- `C:relay/host.ts` (**edit, coordinate**): `abortTurn(sessionId)`
- `C:gateway/node-host.ts` (**edit, coordinate**): accept per-session `{cwd, sandboxMode, modelAdapterId, model}` when creating the Agent. This depends on G1
- `C:server/*` / `C:index.ts` (**edit, coordinate**): `server connect|disconnect agensis`, and relay start on server boot
- `C:gateway/node-command.ts` (**edit, coordinate**): install the approval router as `NodeAgentHost.approvalRequester` (`agensis:` sessions → broker, others → the session-stream front or the current deny/auto-approve)
- `C:relay/agensis/LICENSE-agensis`: MIT text + "Portions derived from agensis-agent (https://github.com/jasonkneen/agensis-agent), Copyright (c) 2026 Agensis contributors". Each vendored file gets a header line naming its source module

Tests (vitest, colocated):
- `relay/agensis/wire-contract.test.ts`: **port of `agensis-agent/tests/daemon-wire-contract.test.cjs`** against a local `ws` server with a fake turn runner (the `HostedTurnRunner` seam, `C:relay/host.ts:12`) yielding scripted `StreamChunk`s. Asserts:
  - first frame is `{type:"auth", token}`
  - the upgrade URL is `/backend/ws?workspaceId=&agentId=`
  - `agent_register` fields, with `permissionDecisionReceipts: true`
  - delta → step → segment → result ordering
  - `stopReason` absent when unknown
  - prepare → receipt → commit, and abort, release parked approvals
- `relay/agensis/reconnect.test.ts`: port of `tests/daemon-reconnect-result.test.cjs`. A result that finishes during an outage is parked and re-sent after `agent_registered`. Backoff never goes below 2s. Backoff resets only on register
- `relay/agensis/permissions.test.ts`: port of `tests/agent-permissions.test.cjs`. Covers rule synthesis (chaining refused, redirects tolerated), stored-rule short-circuit, conflict poisoning, resume denies unlisted ids, and the 45s reconnect backstop
- `relay/agensis/queue.test.ts`: serial within a lane, parallel across lanes up to the cap, cancel of queued vs running jobs, dedupe of an active key
- `relay/agensis/stream-mapper.test.ts`: cumulative delta semantics, segment resets `open`, tool-step dedupe by id, `bufferedAmount` skip, usage mapping
- `relay/agensis/job-runner.test.ts`:
  - cwd outside roots → `cwd_not_allowed`
  - `yolo` capped by `maxPermissionMode`
  - unknown runtime pin → `runtime_unavailable`
  - cancel of a running job aborts but keeps the session
  - idle deadline → `idle_timeout`
- `relay/agensis/profile.test.ts`: file mode 0600, dir 0700, atomic write, token never appears in `status()` output or log lines

Constraint until G1 lands: `maxConcurrency` is forced to 1 and `roots` to a single folder. `codesurf server status` shows the reason.

### Phase 2: approvals with scope, hub tools, multi-hub, pairing

- G2 relay-side session grants. Then an Agent-level session allow list (coordinate with the engine owners).
- G3 `AgentOptions.extraMcpServers` + the hub MCP entry (`url/backend/mcp`, bearer = agent token passed as a header value, never written to settings).
- Multi-hub: repeatable `--hub` in the profile, per-hub token and bearer, one shared queue (`createHubScheduler`).
- `setup.ts` browser pairing (port of `A:setupFlow.mjs`: loopback callback, state check, CORS preflight).
- `agent_config` live updates, `agent_disabled`, `1008` stop handling (in Phase 1 if cheap).
- Tests: multi-hub (port `tests/multi-hub.test.mjs`); pairing callback (state mismatch 403, missing fields 400); MCP injection visible to the claude-agent and codex adapters.

### Phase 3: parity niceties

- `agent_skill_sync` bodies plus `skillsHash` drift.
- Opt-in memory sync (`syncMemory`, off by default).
- identity.json / status.json under `~/.codesurf/agensis/<profile>/`.
- `team_message` ack + `team_cursor` (if the hub has confirmed the wire names).
- Port `buildSearchPath` into `C:utils/` for service-launched servers, with tests over a fake HOME containing `~/.bun/bin`, `~/.volta/bin`, etc.

### Phase 4: separate workstreams (not relay)

- An ACP harness provider plugin (grok, kimi, goose, cursor-agent, fx) built on `@agentclientprotocol/sdk`, using agensis `acp/harnesses.mjs` as the recipe source. It then shows up in capability sync for free.
- Shared inference, bridges and mesh stay in agensis-agent unless product asks.

---

## 6. Risks and security

| # | Risk | Mitigation |
|---|---|---|
| R1 | **The hub can execute arbitrary prompts with the server's credentials** (Claude, Codex, Amp logins, git). An Agensis workspace member becomes a remote user of this machine | Explicit opt-in per server (`server connect`). The profile holds `roots` + `maxPermissionMode` (default `accept_edits`, never `yolo` unless the operator types it). The job's `cwd` and `host_folders` must fall inside `roots`. Unlike agensis, the job cannot widen the roots. `run_mode:'sandbox'` is refused. Shuru sandbox is on for non-yolo modes when configured |
| R2 | Token leakage | Token only in the 0600 profile or the env. Sent in the first `auth` frame, never in the URL (F14). Redacted in logs. Never copied into `ServerRecord`, settings, MCP config on disk or crash logs. Hub MCP auth is injected in memory per session. `tokenHash` stored for display/rotation |
| R3 | Approval bypass through scope | "session" grants live in relay memory per lane and die with the lane. `always` only ever comes back from the hub as `permission_rules`, and is matched by the exact synthesised key. `setMode` / `addDirectories` never applied (`A:permissions.mjs:81-103`). With no hub reachable: deny. With no front: deny (never `--auto-approve` for Agensis jobs) |
| R4 | Global engine state (G1) → cross-lane cwd and sandbox bleed | Force concurrency 1 and a single root until per-session cwd/sandbox lands. `status` shows the constraint |
| R5 | Unknown hub server contract (`metadata.runtime:"agensis"`, `version` semantics, `source=agensis-cli` in pairing) | Phase 0 question to the hub owner. Until answered, send `runtime:"agensis"` and `executionRuntime:"custom"`, or the pinned family (`claude` / `codex` / `amp`) when the profile pins one. `executionRuntime` must stay in the hub's vocabulary, because the hub compares it with the job's declared runtime (`A:agensis.mjs:1788-1795`). Send the **real** CodeSurf CLI version in `version` and `metadata.daemon.version`. Do not spoof `0.1.56`: the hub may base `agent_restart` or update nudges on it. Wire test against a staging hub before GA |
| R6 | The idle and hard timeouts are a cross-repo pair (9m daemon vs 10m hub reaper, `A:agensis.mjs:56-70`) | Named constants with the same comment. A test asserts idle < 10m |
| R7 | Divergence from the frozen agensis code while both ship | Keep a `relay/agensis/UPSTREAM.md` naming the source commit (`a9f7e4a`) for each vendored file. Port future wire changes by diffing that commit |
| R8 | Duplicate registration: desktop agensis daemon and CodeSurf server with the same agent id | pid claim per `(workspace, agent)`. `server connect` warns if `~/.agensis/<ws>/<agent>/heartbeat.json` is fresh (a live agensis daemon) |
| R9 | License | MIT permits vendoring. Keep the copyright notice (`LICENSE-agensis`) plus per-file provenance headers. No agensis package is added as a dependency, so `@agentclientprotocol/sdk` and `e2b` do not enter CodeSurf |

---

## 7. Decisions for the architect

1. **Where it lives:** `apps/cli/src/relay/agensis/` (recommended) or a new `packages/agensis-relay`.
2. **Security default:** `maxPermissionMode` default `accept_edits` (recommended) or mirror agensis's `default`, where yolo comes from the job.
3. **What the server calls itself on the wire:** register as `runtime:"agensis"` until the hub owner says otherwise (recommended), or as `runtime:"codesurf"` now.
4. **The standalone repo:** freeze (recommended) or retire.
5. **Runtimes (§8):** a shared `packages/agent-runtimes` in the monorepo, published and consumed by agensis-agent (recommended, staged B1→B3). The alternatives are keeping it in the agensis-agent repo (rejected) or plain vendoring with agensis's coding lanes frozen (the fallback).

---

## 8. Shared runtime package option

The user asked for this analysis to weigh against plain vendoring. The aim is fewer code changes overall, and a fix to a runtime that lands once instead of twice.

**Scope note.** This does **not** change the relay design in §4. The CodeSurf server still runs Agensis jobs through `Agent.processMessage`, which already uses CodeSurf's providers. What changes is agensis-agent. Today it keeps its own copy of the runtimes (§4.7 freezes that copy). With a shared package it would import CodeSurf's instead. The relay port and the runtime extraction are therefore two independent workstreams.

### 8.1 The shared interface: extend what already exists

CodeSurf already publishes this interface **as types** in `@codesurf/plugin-api` (`packages/plugin-api/src/index.ts:530-598`). It has:
- `ProviderSession.sendTurn(input, controller) → {usage}`, `abortTurn`, `warm`, `disconnect`, `respondToToolApproval`
- `ProviderStreamEvent`: `status`, `text-delta`, `reasoning-delta`, `tool-call`, `tool-result`, `usage`, `error`, `done{stopReason}`, `tool-approval-request`, `questionnaire-request`
- `ProviderConnectionContext`

agensis's equivalent is looser. `executor.run(opts)` returns `{status, stdout, stderr, error, stop, acp}`. It streams through `onData(chunk)` and fakes structured events by injecting synthetic NDJSON lines (`agensis_step` / `agensis_segment`, parsed back out at `A:agensis.mjs:1864-1879`). So the typed CodeSurf shape is the base. What follows adds exactly what agensis passes today that CodeSurf cannot express.

```ts
// packages/agent-runtimes/src/types.ts: a superset of plugin-api's ProviderSession

/** agensis's closed vocabulary (A:stopReasons.mjs:22-34). CodeSurf emits raw strings today:
 *  claude passes message.stop_reason through (C:core/plugins/native/claude-agent-provider.ts:1296),
 *  and codex hard-codes "stop" (C:core/plugins/native/codex-provider.ts:379). */
export type StopReason =
  | "completed" | "cancelled" | "max_tokens" | "max_turns" | "max_budget" | "refused"
  | "idle_timeout" | "hard_timeout" | "permission_denied" | "agent_error" | "connection_lost";

/** Per-session config. agensis passes all of this per job today (A:agensis.mjs:1262-1293).
 *  CodeSurf's providers read it from process-global host services / settings (gaps G1 and G3). */
export interface RuntimeSessionConfig {
  sessionKey: string;                 // one warm session per key (agensis "silo/lane", CodeSurf conversationId)
  cwd: string;
  additionalDirectories?: string[];   // agensis --add-dir / host_folders
  model?: string;
  permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  mcpServers?: Array<{ id: string; transport: "http" | "sse" | "stdio"; url?: string; headers?: Record<string, string>;
                       command?: string; args?: string[]; env?: Record<string, string> }>;
  leanContext?: boolean;              // agensis lean mode: no user settings, skills, hooks or memory (A:agensis.mjs:1662-1678, 1750-1765)
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  resume?: { threadId?: string; history?: readonly unknown[] };  // amp/codex thread; claude history preface
  idleTimeoutMs?: number;             // agensis: 9m (A:agensis.mjs:70). CodeSurf: STALL_TIMEOUT_MS 120s (claude-agent-provider.ts:433)
  hardTimeoutMs?: number;
  env?: Record<string, string>;
  log?: (line: string) => void;
}

/** Replaces the boolean. agensis needs scope for Claude updatedPermissions (A:connectionExecutors.mjs:302)
 *  and for Codex accept vs acceptForSession (A:connectionExecutors.mjs:860-861, 1011-1012). */
export interface ApprovalRequest {
  approvalId: string; toolName: string; input: unknown;
  title?: string; description?: string;
  /** Canonical rule keys an "always"/"session" answer would grant (A:permissions.mjs:159-162). */
  ruleKeys: string[];
  signal: AbortSignal;
}
export interface ApprovalDecision { behavior: "allow" | "deny"; scope?: "once" | "session" | "always"; message?: string }
export type ApprovalHandler = (req: ApprovalRequest) => Promise<ApprovalDecision>;

export type RuntimeEvent =
  | Exclude<ProviderStreamEvent, { type: "tool-approval-request" } | { type: "done" }>
  | { type: "segment-end" }           // agensis agent_job_segment boundary (A:agensis.mjs:1224-1231)
  | { type: "done"; stopReason: StopReason; stopDetail?: string };

export interface TurnOutcome {
  stop: { reason: StopReason; detail?: string };
  usage?: ProviderUsageSnapshot; costUsd?: number; numTurns?: number; permissionDenials?: number;
  resume?: { threadId?: string };     // amp/codex thread to persist for the next turn
}

export interface RuntimeSession {
  readonly key: string;
  warm(): Promise<void>;                                   // = ProviderSession.warm
  sendTurn(input: { prompt: string; messages?: readonly unknown[]; signal: AbortSignal },
           emit: (e: RuntimeEvent) => void): Promise<TurnOutcome>;
  abortTurn(): Promise<void>;
  dispose(): Promise<void>;                                // = disconnect
}

export interface RuntimeProbe {
  available: boolean; path?: string; version?: string;
  auth: "ok" | "needs_login" | "not_installed"; reason?: string;
  models?: Array<{ id: string; label: string }>;
}

export interface AgentRuntime {
  id: "claude" | "codex" | "amp" | "opencode" | `acp:${string}`;
  label: string;
  probe(opts?: { searchPath?: string }): Promise<RuntimeProbe>;   // = auth.check + listModels (C:core/plugins/api.ts:626, 657)
  open(config: RuntimeSessionConfig, approvals: ApprovalHandler, hooks?: RuntimeHostHooks): Promise<RuntimeSession>;
}

/** Host-specific add-ons are injected, never imported, so the package has no CodeSurf engine dependency. */
export interface RuntimeHostHooks {
  extraMcpServers?: () => Promise<RuntimeSessionConfig["mcpServers"]>;  // CodeSurf: codesurf-mcp tool bridge
  interceptTool?: (name: string, input: unknown) => Promise<unknown | undefined>; // CodeSurf: rg/grep fast path
  historyPreface?: (history: readonly unknown[]) => string;             // CodeSurf: provider-history-preface
}
```

Ownership of the types: `packages/agent-runtimes/src/types.ts` **owns** `ProviderStreamEvent`, `ProviderUsageSnapshot` and the types above. `@codesurf/plugin-api` re-exports them. The dependency runs plugin-api → agent-runtimes/types and never the reverse, so agensis-agent does not pull in `@deepseek-ai/cordis`.

Why approvals are a callback here and not an event + `respondToToolApproval` as in CodeSurf today:
- A callback returning a promise carries scope and is naturally cancellable.
- CodeSurf's event style becomes a ~20-line shim inside the plugin wrapper: the handler emits a `tool_approval_request` chunk and resolves when `respondToToolApproval` (`C:agent/mixins/turn-control.ts:172`) is called.
- That is a **breaking change to plugin-api** (boolean → decision). The TUI approval UI then gains "allow for session".

This is gaps G1, G2 and G3 restated as interface work. Close them once here and both hosts get them.

### 8.2 Which existing implementation becomes the shared one

| Runtime | Winner | Evidence | What to take from the loser |
|---|---|---|---|
| **Claude** (Agent SDK) | **CodeSurf** `claude-agent-provider.ts` (1748 lines) | Persistent streaming-input `query()`, like agensis. Stall timer (`:433`, `:1018-1024`). History-preface resume (`:367-372`). AskUserQuestion questionnaire. MCP gate. **2,208** test lines (`claude-agent-provider.test.ts` 1634 + `builtin/claude-agent-provider-permission.test.ts` 467 + `claude-agent-mcp-gate.test.ts` 107). agensis has 964 test lines, shared with Codex | From agensis:<br>- approval scopes via SDK `suggestions` → `updatedPermissions` with setMode/addDirectories filtered (`A:connectionExecutors.mjs:266-305`, `A:permissions.mjs:81-103`)<br>- `stopReasonFromSdkResult` + cost/permissionDenials (`A:stopReasons.mjs:93-`)<br>- lean mode<br>- rebuild when `canAsk` changes (`A:connectionExecutors.mjs:241-248`)<br>- cancel drain<br>**Cost:** the most host-coupled file. It imports `tools/bash`, `tools/grep`, `utils/settings.loadMcpServers`, `./codesurf-mcp`, `builtin/claude-skills-provider`, `provider-history-preface` and `anthropic-models-catalog` (`:32-33`, `:87-106`). All of these must become `RuntimeHostHooks` or plugin-side wrappers. This file is the bulk of option (b)'s cost |
| **Codex** (app-server) | **CodeSurf** `codex-provider.ts` (1096) | JSON-RPC `codex app-server` singleton, threadId (`:601-655`), usage (`:361`), approval events (`:862`), OAuth `startAuth`, 827 test lines. **Low coupling:** imports only `binary-on-path`, `cli-check-cache`, `workspace-scope`, `groups`, `provider-usage` (`:37-41`). **Best pilot** for extraction | From agensis:<br>- scope-aware decision mapping `CODEX_ALLOW_ONCE/SESSION` (`A:connectionExecutors.mjs:860-861`, `:1011-1012`)<br>- per-turn `idleTimeoutMs` (`:958`, `:1066-1073`)<br>- lean flags<br>Codex version skew: agensis was verified on codex-cli 0.145.0 (`A:connectionExecutors.mjs:39-41`), CodeSurf on 0.134 (`codex-provider.ts` header). Re-verify on the newer one |
| **Amp** | **CodeSurf** `amp-provider.ts` (291) on `builtin/transports/persistent-stdio-session.ts` | Persistent `--stream-json-input` session (one process per conversation). agensis spawns `amp` per turn (`A:agensis.mjs:1504`) | agensis's failure taxonomy and messages (`A:ampRuntime.mjs:63-80`, `classifyAmpFailure` `:102`), thread-id continuation and validation (`:41-46`, `A:agensis.mjs:1478-1487`), repo allow-list (`assertAmpRepo` `:126`), and 320 test lines |
| **OpenCode** | **CodeSurf** `opencode-provider.ts` (658, `@opencode-ai/sdk`) | Native SDK. agensis only reaches opencode through ACP | — |
| **ACP harnesses** (grok, hermes, goose, kimi, cursor, fx, openclaw) | **agensis** `acp/client.mjs`, `executor.mjs`, `harnesses.mjs`, `direct.mjs` (1,395 lines, plus `discovery.mjs` 115 and `resolve.mjs` 261) | CodeSurf has **no** `@agentclientprotocol/sdk` client (grep: 0 hits; `C:gateway/acp.ts` is a different protocol). 937 test lines (`tests/acp-*.mjs`) | Port to TS as `acp:<id>` runtimes. This replaces §5 Phase 4: the TUI gains these harnesses for free |
| **CLI discovery** | **agensis** `acp/resolve.mjs` `buildSearchPath`/`resolveCommandPath` | Login-shell PATH plus tool prefixes, which is needed for service-launched hosts (§2) | Wrap in CodeSurf's `cachedCliCheck` (`C:utils/cli-check-cache.ts:11`). `probe()` uses it |
| **Stop reasons** | **agensis** `stopReasons.mjs` | Closed and documented. The hub has a byte-identical copy | — |
| **Permission rule keys** (pure part) | **agensis** `ruleKey`, `requestRuleKeys`, `synthesizedRuleKeys`, `isAllowedByStoredRules` (`A:permissions.mjs:52-205`) | Needed by any host that offers "always allow" | The **broker** (`createPermissionBroker`) is Agensis hub protocol and stays with the relay |
| **Sandbox** | **not shared** | CodeSurf's shuru wraps CodeSurf's *own* bash tool (`C:tools/bash.ts:168`, `:577-619`). agensis's is CLI flag heuristics (`--dangerously-skip-permissions` vs root/container, `A:agensis.mjs:1681-1711`, `:2059-2084`). Different layers; owning adapters run their own tools | Share only the permission-mode *mapping* (`C:core/plugins/permission-mode.ts:68-75`). Root/container detection stays host policy |
| **Deadlines** (`withDeadlines`, `A:deadlines.mjs`) | **agensis**, into the shared package | CodeSurf has only a Claude-specific stall timer (`claude-agent-provider.ts:433`) and a front-side idle limit (`C:relay/session-stream.ts:411`). agensis's helper is pure and covers hard + idle for any lane | `RuntimeSession.sendTurn` applies `idleTimeoutMs` / `hardTimeoutMs` through it for every runtime. It maps onto `idle_timeout` / `hard_timeout` |
| **Lane queue** (`createQueue` / `createHubScheduler`, `A:queue.mjs`, `A:hubConnections.mjs:40-90`) | **not in the runtime package: relay-side** | Admission (serial per conversation, host-wide cap, cancel by job id) is host policy. The CodeSurf TUI has one turn per Agent and needs none of it. Runtimes stay one-turn-per-session and reject overlap | Lives with the relay protocol (§8.4). Both hosts' relay layers use the same copy |
| `executor.mjs` (subprocess fallback), `cli.mjs`, `sessionSlots.mjs`, `createStreamJsonParser` | **dropped** | Superseded by `RuntimeSession` keyed by `sessionKey` | — |

No blocker for Node consumers: there are no `Bun.` APIs in `builtin/transports/*.ts` or in the claude, codex, amp and opencode providers (grep: 0 hits). agensis runs on Node ≥18.

### 8.3 Where the shared package lives

| | (a) In agensis-agent repo, published; CodeSurf depends on it | (b) In the monorepo `packages/agent-runtimes`, published; agensis-agent depends on it | (c) Plain vendoring (§1-§7 as written) |
|---|---|---|---|
| Fix lands once | yes | yes | **no**: two copies for as long as agensis-agent keeps running coding jobs |
| Direction of dependency | The engine depends on the relay-host repo (inverted) | The relay host depends on the engine org's package (natural) | none |
| Language fit | agensis is untyped `.mjs`, bundled with esbuild, no TS build. Three of five winners are CodeSurf TS, so they would be ported *into* agensis and re-imported | Winners already TS in-repo. agensis consumes compiled JS through esbuild | — |
| Release coupling | Every runtime fix = publish in agensis-agent + bump in the monorepo. The cross-repo `file:` dependency already broke CI once | Every fix = publish from the monorepo + bump in agensis-agent (esbuild inlines it, so agensis users see no new dependency). **New pipeline:** every `@codesurf/*` package is `private: true` today; only the `codesurf` CLI (1.1.5) is published. The daemon README's "umbrella promotes exact runtime deps" is the nearest precedent | none |
| SDK version pinning | — | Must unify `@anthropic-ai/claude-agent-sdk`: agensis `^0.3.218`, CLI `^0.3.278`, daemon `0.2.141` | stays split |
| Transitive deps | — | `@codesurf/plugin-api` has a runtime dep on `@deepseek-ai/cordis` (import is type-only, `src/index.ts:12`). The runtime package must depend on a **types-only slice** (its own `types.ts`), not on plugin-api | — |
| **agensis-agent files touched** | ~14 source files moved (below). Plus a new package, its build, `.d.ts` and publish config, and the port of CodeSurf's Claude/Codex/Amp code into it | **Deleted or moved:** `executor.mjs`, `connectionExecutors.mjs`, `sessionSlots.mjs`, `cli.mjs`, most of `ampRuntime.mjs`, `acp/client.mjs`, `acp/executor.mjs`, `acp/harnesses.mjs`, `acp/direct.mjs`, `acp/discovery.mjs`, `acp/resolve.mjs`, `stopReasons.mjs`, `deadlines.mjs` (13).<br>**Edited:**<br>- `agensis.mjs`: `runAgentJob` (1155-1404) becomes one `RuntimeSession.sendTurn` loop with a ~60-line `RuntimeEvent` → delta/step/segment/result mapper; `runAmpAgentJob` (1406-1546) folds into it; `buildAgentCommand` (1650-1773) and `createStreamJsonParser` (1822-1950) are deleted; `computeCapabilities` (2211-2253) switches to `probe()`<br>- `permissions.mjs`: keeps the broker, imports rule keys from the package<br>- `package.json`: the one package replaces `claude-agent-sdk` and `acp/sdk`<br>- `packages/agensis-agent/build.mjs`: esbuild inputs<br>- `packages/agensis-cli/package.json` `files[]`<br>**Tests:** ~9 files (`agent-connection-executors`, `acp-*` ×5, `amp-runtime`, `native-runtime-lane`, `agent-executor`, ~2.5k lines) move to the monorepo or become thin acceptance tests. `daemon-wire-contract` and `daemon-reconnect-result` stay. **Net ≈ −4k / +0.3k lines in agensis-agent** | **0 files** |
| **CodeSurf files touched** | the same as (b) plus consuming an external package | new `packages/agent-runtimes/**`. `claude-agent-provider.ts`, `codex-provider.ts`, `amp-provider.ts`, `opencode-provider.ts` become thin plugin wrappers (auth/settings/registration + hooks). `builtin/transports/*` (1,988 lines) and `provider-usage.ts` move. `packages/plugin-api` `respondToToolApproval` signature changes. `C:agent/mixins/turn-control.ts:172` + the TUI approval UI. `model-runtime.ts` passes `RuntimeSessionConfig` | §4 only |

**(a) is rejected** for three reasons:
1. The dependency is inverted: the engine would depend on a relay host.
2. The languages don't fit: CodeSurf's TS winners would be ported into an untyped `.mjs` repo, only to be re-imported.
3. It repeats the cross-repo coupling that already broke CI.

### 8.4 What stays unique to each host, and how the relay protocol is consumed

- **Unique to agensis-agent** (the relay host):
  - the Agensis wire protocol, auth and registration
  - the permission **broker** (prepare/receipt/commit, reconnect resume)
  - multi-hub, profiles, pairing, team inbox
  - bridges, mesh, CursorBuddy, shared inference, supervise/self-update/service
  - the prompt context header and host policy: root/container yolo heuristics, `host_folders` gating
- **Unique to CodeSurf:** the `Agent` turn engine, TUI, desktop, `codesurfd`, CodeSurf's own tools and the shuru sandbox, the plugin/provider registry (auth UI, settings), the `codesurf-mcp` tool bridge, and the server lifecycle.
- **How the CodeSurf server consumes the Agensis relay protocol: vendor it** (§4.1, unchanged).
  - Importing it from agensis-agent would recreate the cross-repo dependency in the opposite direction, so each side would have to publish for the other.
  - The protocol changes rarely, and its consts already have to match the hub byte for byte.
  - `relay/agensis/UPSTREAM.md` pins the source commit.
- **So a protocol fix lands once:** vendoring means a fix to the protocol files is made in agensis-agent and then re-applied to the CodeSurf copy by diffing against the pinned commit. That is cheap because the files are pure: `protocol`, `permissions` (broker), `queue`, `liveness`, `hubs`, `stopReasons`. It is still two landings. To get one landing, put these ~1.2k pure lines in a second monorepo package, `packages/agensis-relay` (a protocol core with no host code: `connection` takes a `runJob` callback), published alongside `agent-runtimes` in stage B3. agensis-agent then imports it the same way it imports the runtimes, which adds no new release path beyond (b). Recommended as part of B3, not before: until then only one host runs the protocol code actively, since agensis-agent's relay is frozen.
- **Possible later end-state (not recommended yet):** move the relay protocol into the monorepo too (`packages/agensis-relay`). agensis-agent then becomes a thin CLI over two monorepo packages, and nothing is duplicated. Only worth it if agensis-agent's own feature work (bridges, mesh) stops.

### 8.5 Recommendation: (b), staged

1. **Now, unchanged:** vendor the relay into the CodeSurf server (§5 Phases 1-3). That work is blocked on engine-cwd (G1), not on this decision.
2. **Stage B1, monorepo only, no publishing:**
   - create `packages/agent-runtimes` (private) with the §8.1 types
   - extract **Codex** first: lowest coupling, 827 test lines to guard it
   - make `codex-provider.ts` a wrapper, and fold in agensis's scope and idle-timeout logic
   - the `plugin-api` approval-decision change lands here, because the TUI needs it anyway (G2)
3. **Stage B2:** Amp (the transports move with it), then Claude, whose coupling turns into `RuntimeHostHooks`. Then port the ACP harnesses in from agensis as TS; CodeSurf gains five harnesses.
4. **Stage B3:**
   - flip `packages/agent-runtimes` to published (`@codesurf/agent-runtimes`)
   - unify the claude-agent-sdk version
   - agensis-agent switches to it, using the footprint in §8.3(b)
   - gate: agensis's `daemon-wire-contract` and `daemon-reconnect-result` tests still pass, and its moved runtime tests pass inside the monorepo

**Why (b):**
- It is the only option where a runtime fix lands once.
- It puts the shared code where three of the four in-use winners (Claude, Codex, Amp) already live, with their tests, and where ACP reaches the TUI.
- Most of its CodeSurf-side cost (G1-G3, stop-reason normalisation) is work the relay needs anyway.
- Staging keeps the Agensis-dashboard goal from waiting on a plugin-api break and a first-ever npm pipeline.

**When to fall back to (c):** if the user decides agensis-agent's coding lanes should freeze (§4.7), choose (c) and skip B3. The duplication then stops growing, because only CodeSurf's copy is maintained. B1-B2 still pay for themselves inside CodeSurf through the decoupling and the ACP harnesses.
