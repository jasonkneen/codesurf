# CodeSurf ← omnigent: What to Lift (Investigation Plan)

> Status: **proposal / plan gate** — nothing built yet. Three read-only explorers
> compared `omnigent` (`/Users/jkneen/Documents/GitHub/omnigent`, Python platform)
> against CodeSurf IDE (`/Users/jkneen/clawd/collaborator-clone`, the `codesurf`
> infinite-canvas Electron workspace). Every claim below is grounded with `file:line`
> on both sides. Pick what's worth building; implementers are spawned only after you choose.

---

## TL;DR — the unifying spine

The three themes you named (chat interface, daemon multi-user/sharing, agent harness)
are **not independent** — they converge on one architectural spine that omnigent has and
CodeSurf lacks:

> **A durable, ACL-gated *session* model + a declarative *agent spec* + an async
> *inbox/sub-agent* fabric.**

Once that spine exists, most of the individual chat/UX features (review comments,
aggregated approvals, fan-out, policy banners) become thin surfaces on top of it.
So the recommendation is **foundation-first**, then surface features.

CodeSurf's current state is genuinely strong in places and should be *kept*, not replaced:
- Per-decision tool permissions (deny/never/once/session/today/forever) are **richer**
  than omnigent's binary ALLOW/ASK — `src/renderer/src/components/chat/ToolPermission.tsx:109-150`.
- Git-worktree isolation per harness turn already exists — `packages/codesurf-daemon/bin/harness-worktree.mjs:1-74`.
- Harness execution currently routes only single-shot/background Claude jobs.
  Foreground Claude and all Codex jobs use their native paths to preserve session
  continuity and permission semantics; Pi fails closed with a stable remediation
  until its published adapter dependency chain is safe —
  `packages/codesurf-daemon/bin/chat-jobs.mjs:991-996,2808-2819`.

**Do NOT copy:** omnigent's `timer` subsystem is a `NotImplementedError` stub — use CodeSurf's own cron/loop tooling for scheduling instead.

---

## Layer 0 — Foundation (build these first; everything else depends on them)

### F1. Session ACL + identity as daemon primitives  ·  Effort: **L**
- **omnigent:** pluggable identity, reserved `__public__`, read/edit/manage/owner levels — `omnigent/server/auth.py:1-23,42-59`; all access via parent-aware `check_session_access` — `omnigent/server/permissions.py:17-60`; direct/public grants — `omnigent/stores/permission_store/sqlalchemy_store.py:238-274`.
- **CodeSurf now:** daemon auth is a single random bearer token — `packages/codesurf-daemon/bin/codesurfd.mjs:32,2816-2825`; existing "permissions" are provider/tool/workspace grants, **not** session-sharing ACLs — `packages/codesurf-daemon/src/types.ts:161-188`.
- **Slots into:** new user/session ACL types in `packages/codesurf-daemon/src/types.ts` + checks in `codesurfd.mjs`; gate `src/main/ipc/canvas.ts` session reads through the daemon.
- **Why first:** multi-user/sharing is meaningless without durable identity + per-session ACLs. This is the keystone for F-items and daemon theme #2/#3.

### F2. Declarative agent bundle/spec (`AgentSpec`)  ·  Effort: **L**
- **omnigent:** one YAML declares harness/model, tools, sub-agents, OS/sandbox, terminals, async, policies — `docs/AGENT_YAML_SPEC.md:3-46`; parsed into `AgentSpec` — `omnigent/spec/parser.py:224-289`.
- **CodeSurf now:** only daemon env/settings toggles for harness routing, no per-agent spec — `packages/codesurf-daemon/bin/harness-settings.mjs:1-13`, `codesurfd.mjs:3248-3256`.
- **Slots into:** a TS `AgentSpec` schema/loader feeding `chat-jobs.mjs` + `harness-runtime.mjs`; specs can live in workspace memory or be contributed by extensions.
- **Why first:** the spec is the carrier for model routing, terminals, MCP wiring, policy, and sandbox declarations (F-items below all reference it).

### F3. Pluggable harness registry (kill hard-coded vendor branches)  ·  Effort: **M/L**
- **omnigent:** canonicalized harness names + generic module-loaded runner + shared executor adapter — `omnigent/harness_aliases.py:9-23`, `omnigent/runtime/harnesses/_runner.py:1-37,112-157`, `_executor_adapter.py:1-23`.
- **CodeSurf now:** adapter metadata and `resolveHarness` know Claude/Codex, but production routing admits only background Claude; Codex uses native `codex exec`, and Pi is explicitly fail-closed until its adapter is safe — `packages/codesurf-daemon/bin/harness-runtime.mjs:43-45,88-90,403-419`; routing lives in `packages/codesurf-daemon/bin/chat-jobs.mjs:991-996,2808-2822`.
- **Slots into:** replace `resolveHarness()` with a registry consumed by daemon chat jobs + relay executors.
- **Risk:** keep existing Claude/Codex/OpenCode/Hermes behavior stable while introducing registry metadata.

### F4. Async inbox + durable sub-agent sessions (spawn / fan-out / collect)  ·  Effort: **L**
- **omnigent:** `sys_call_async` dispatches background work → `task_id`; `sys_read_inbox` drains mid-turn; `sys_cancel_task` — `omnigent/tools/builtins/async_inbox.py:1-27,129-288`. Durable child sessions via `sys_session_send` (spawn-or-continue, concurrent fan-out) and `sys_session_create` — `omnigent/tools/builtins/spawn.py:56-154,550-588`.
- **CodeSurf now:** only synchronous turns + sequential queued turns — `src/renderer/src/components/chat/ChatTileQueuedTurnsDrawer.tsx:24-100`; relay has participants + scheduled ticks but no async inbox — `packages/codesurf-relay/src/runtime.ts:143-186`.
- **Slots into:** new MCP tools `codesurf_session_send/create/read_inbox` backed by `packages/codesurf-relay` + daemon job timelines; completions publish to `src/main/event-bus.ts`; a spawned agent becomes a new chat tile via `canvas_create_tile`.
- **Why foundational:** unlocks chat #3 (user-facing spawn), #2 (async), #6 (aggregated approvals), and is the daemon's spawn-tree backbone.

---

## Theme A — Chat interface + capabilities (surfaces on the spine)

| # | Lift | omnigent | CodeSurf now | Effort |
|---|------|----------|--------------|--------|
| A1 | **Anchored review-comment flow ("Address All")** — flagship differentiator | `omnigent/entities/comment.py:8-73`, `server/routes/comments.py:1-98`, `CommentsPanel.tsx` | only BlockNote margin notes on a block, no file-range anchoring — `src/shared/chat-types.ts:40-50` | **L** |
| A2 | **Cross-session approval Inbox (aggregated backlog)** | `InboxPage.tsx`, `pending_elicitations_count` | approvals are per-tile only — `ToolPermission.tsx:109-150` (keep the richer per-decision model, just aggregate) | **M** |
| A3 | **Tool-call grouping / collapse-old-steps** (quick win) | `BlockRenderer.tsx:278-359` (`STREAMING_TAIL=3`) | per-block collapse, no grouping of long runs — `ai-elements/tool.tsx:26-100` | **S** |
| A4 | **On-demand `load_skill` pull model** | `omnigent/tools/builtins/load_skill.py:13-78` | push/`/`-autocomplete only — `useChatTileWorkspaceSkills.ts:9-80` | **S/M** |
| A5 | **Intelligent model routing (cost advisor) w/ visible verdict** | `CostRoutingControl.tsx`, `examples/polly/config.yaml:29-35` | static picker only — `ChatTile.tsx:105,167-177` | **M** (UI small, classifier is the work) |

Note: A1 is also a daemon item (needs session ACL for multi-user attribution) — see D6.

---

## Theme B — Daemon + multi-user / sharing (build on F1)

| # | Lift | omnigent | CodeSurf now | Effort |
|---|------|----------|--------------|--------|
| D2 | **Per-user session-discovery stream** (fail-closed list + WS deltas + grant notify) | `server/routes/sessions.py:12056-12080,12279-12308,16537-16539`, `runtime/user_session_stream.py:1-22` | on-demand merged HTTP list, in-memory bus — `src/main/ipc/canvas.ts:819-866`, `event-bus.ts:15-35` | **M/L** (depends on F1, else leaks session IDs) |
| D3 | **Spawn-tree sessions w/ inherited visibility** (`parent`/`root` ids, READ-on-parent) | `entities/conversation.py:39-50`, `sessions.py:13798-13844,1750-1810` | flat relay participants/channels, spawn lacks parent/root — `packages/codesurf-relay/src/types.ts:30-48,157-169` | **L** |
| D4 | **Owner-scoped host/runner binding + tokenized launch** | `server/routes/hosts.py:241-289,328-395,497-546` | hosts have URL/token, no owner; `/host/list` returns all — `codesurf-daemon/src/types.ts:22-31`, `codesurfd.mjs:3738-3749` | **L/XL** (needs real remote runner/tunnel) |
| D5 | **Canonical workspace binding for shared/remote exec** | `entities/conversation.py:156-166`, `hosts.py:369-395,514-526` | path records, raw `workspaceDir` at job start — `codesurfd.mjs:1587-1596,3231-3234` (worktrees exist) | **M/L** |
| D6 | **Session-scoped, attributed, anchored review comments** (server side of A1) | `server/routes/comments.py:117-130`, `entities/comment.py:8-69` | tile mailbox markdown w/ frontmatter, no path/range anchor — `src/main/ipc/collab.ts:41-79,173-189` | **M** |
| D7 | **Versioned daemon API contract** (OpenAPI vs hand-rolled route switch) | `openapi.json:4038-5789` | TS wire types + route switch + string-path clients — `codesurfd.mjs:2821-2830`, `client.ts:135-225` | **M** (do before multi-client sharing widens) |

---

## Theme C — Agent harness (build on F2/F3)

| # | Lift | omnigent | CodeSurf now | Effort |
|---|------|----------|--------------|--------|
| H4 | **Runtime policy/guardrail layer** (request/response/tool phases, ALLOW/DENY/ASK, gate before harness spawn) | `docs/AGENT_YAML_SPEC.md:172-182`, `policies/schema.py:247-287`, `runner/policy.py:109-227`, `runner/app.py:4498-4530` | permission prompts/grants only; one special high-risk MCP gate — `chat-jobs.mjs:1056-1119`, `peer-bridge.ts:11-24` | **L** (Python callables don't port; need TS policy modules) |
| H5 | **Per-worker model routing + `list_models` preflight** | `examples/polly/config.yaml:80-91`, `tools/builtins/list_models.py:22-64`, `runtime/workflow.py:963-1101` | `model` accepted on spawn/jobs but no compat preflight — `chat-jobs.mjs:1049-1055,1262-1268` | **M** |
| H6 | **Declared terminal environments** (named presets, inherited env, cwd/sandbox gates) | `AGENT_YAML_SPEC.md:196-214`, `runner/app.py:9455-9504` | allowlisted ad-hoc terminal tiles + MCP preamble inject — `src/main/ipc/terminal.ts:48-83,284-354,418-470` | **M** |
| H7 | **Spec-scoped MCP wiring + proxy enforcement** (stdio/http, per-tool timeout/retry, central policy proxy) | `AGENT_YAML_SPEC.md:101-131`, `spec/types.py:837-925`, `runner/proxy_mcp_manager.py:1-190` | one local MCP server + extension registry — `src/main/mcp-server.ts:1-10,202-223`, `extensions/context.ts:121-132` | **M/L** |
| H8 | **First-class sandbox model** (fs/network policy beyond worktree) | `AGENT_YAML_SPEC.md:67-99`, `spec/types.py:1396-1413`, `runtime/workflow.py:1042-1045` | worktree isolation + raw `bash -c` local sandbox — `harness-runtime.mjs:96-126`, `harness-worktree.mjs:1-12` | **L** (macOS seatbelt/network is the hard part) |

---

## Recommended build sequence

1. **Quick wins (parallel, low risk):** A3 tool grouping (S), A4 `load_skill` (S/M). Ships UX/agent value immediately, warms up the codebase.
2. **Foundation:** F1 session ACL+identity → F4 async inbox + durable sub-agents → F2 agent spec → F3 harness registry. (F1 first; F4 and F2 can overlap.)
3. **Flagship surfaces (need foundation):** A1+D6 anchored review comments, A2 aggregated approval inbox, D2/D3 per-user discovery + spawn-tree.
4. **Harness depth:** H5 model preflight (M, independent) anytime; then H4 policy layer, H6 terminals, H7 MCP wiring, H8 sandbox.
5. **Hardening:** D7 versioned API before sharing widens; D4/D5 host/workspace binding only when remote/shared execution is actually on the roadmap (highest cost).

## Cross-cutting risks
- Almost all omnigent logic is **Python → TS/Node** ports: lift the *architecture*, not the code (policies and sandbox are the least portable).
- Identity/persistence (F1) is the gating dependency for the multi-user story — sequencing matters or streams leak session IDs across users.
- Sub-agent lifecycle (F4/D3) must reconcile **tile identity ↔ chat-job identity ↔ provider-native session id** — flagged by two independent explorers as the top risk.

---

# Build Plan v2 — scoped & sequenced (post-decision)

Decision from the architect: (1) build our own **agent definitions** with customisation/colors
on the existing framework, extended with omnigent concepts; (2) **make the daemon work like
omnigent** (multi-user/sharing); (3) tool-call grouping — keep our front-end rendering, add a
**render-mode switch** (traditional / grouped chain-of-thought / chips) over one data shape.

## Verified findings that reshape the work

- **`AgentMode` is the existing agent-definition framework** (`src/shared/types.ts:121-133`):
  `name, description, systemPrompt, tools[], icon, color, isBuiltin, defaultNextMode, source`.
  Authored in `CustomisationTile.tsx` → `${workspace}/.codesurf/customisation/agents.json`.
- **It is ORPHANED.** It is read by exactly one file and **never enters the chat launch payload**
  (`useChatTileMessaging.ts:317` sends `provider/model/mode/thinking`, no `agentId`/persona).
  → **Wiring `AgentMode` into launch is the prerequisite for everything below.**
- **Single clean insertion point:** `makeAgent({ harness, sandbox, permissionMode, instructions })`
  at `harness-runtime.mjs:422-427`. Note it currently **ignores `request.model`** (harness uses its
  own default); Codex path *does* honor `--model` (`chat-jobs.mjs:~1262`).
- **Front-end grouping ALREADY EXISTS** (corrects the earlier "S quick win"): `MixedToolGroup`,
  `CollapsedToolGroup`, `ToolGroupChip`, `ToolMegaChip` (`ToolBlockView.tsx:309-581`) + chips engine
  `toolChipCollation.ts` (thresholds at 3), assembled in `ChatTileTranscriptMessages.tsx:261-281`.
  Missing: a `renderMode` switch and **canonical step/group metadata** on the data shape
  (`ToolBlock` in `src/shared/chat-types.ts:19` has no `stepId/groupId/streamingTailSize`).
- **Daemon auth is a single bearer token** (`codesurfd.mjs:32`), no identity/ACL. "Like omnigent"
  here = an auth + persistence re-architecture (L/XL, security-sensitive), not a feature lift.

## Decomposition — dependency chain, NOT a parallel fan-out

Most foundation items are interdependent and L. Use **sequential-with-cross-review per PR**
(opposite-vendor reviewer on every PR), not the `fanout` skill. Two tracks can run in parallel
because they edit *different shared files* — **but both must touch `harness-runtime.mjs` and
`chat-jobs.mjs`** (Track A for `makeAgent` opts, Track B for metadata emission). That `.mjs`
overlap is the real conflict point: serialize those edits or assign both `.mjs` changes to one PR.

### Track A — Agent definitions (extends `AgentMode`; touches `src/shared/types.ts`)
- **A-PR1 (wiring ONLY, ~M):** add an agent-definition selector to the chat toolbar; thread
  `agentId` + resolved `AgentMode` through `chat:send` → daemon → `makeAgent()` using the
  *existing* fields (systemPrompt, tools allow-list); render `color`/`icon` in the chat tile header
  + canvas tile. Independently valuable: custom agents finally do something. De-risks the seam.
- **A-PR2 (omnigent fields, L):** make `AgentMode` the **superset** — add `harness?`, `model?`,
  `mcpServers?`, `subAgents?`, `policies?`, `osEnv?`/`sandbox?`, `terminals?`, `params?`; pass them
  into `makeAgent` opts (incl. fixing the ignored-model gap). omnigent YAML = import/export that
  round-trips through `AgentMode`. Editor UI in `CustomisationTile.tsx`.

### Track B — Render-mode (M, additive; touches `src/shared/chat-types.ts`)
- **B-PR1:** add canonical step/group metadata fields to `ToolBlock`/`ThinkingBlock`/`ContentBlock`
  (`chat-types.ts`) + `ChatStreamEvent`; emit/persist from `harness-runtime.mjs` + `chat-jobs.mjs` +
  `buildDaemonSessionState`. Add a `renderMode: 'traditional'|'grouped-cot'|'chips'` prop threaded
  `ChatTileTranscriptMessages → ChatTileTranscriptColumn → ChatTile`, persisted in
  `ChatTilePersistedState`. Keep `toolChipCollation.ts` as the chips strategy. Wire the dead 5s
  `toolCollapseTick` for streaming-tail collapse.

### Track C — Daemon like omnigent (DESIGN-NOTE FIRST; no implementer until architect signs off)
- **C-D0 (design note):** identity model + session-ACL (read/edit/manage/owner + `__public__`),
  persistence choice, how it maps onto relay participants/spawn-tree (`parent`/`root` ids), and the
  bearer-token migration path. omnigent refs: `auth.py:1-59`, `permissions.py:17-60`,
  `sessions.py` ACL routes. **Architect approves before code.**
- **C-PR1+ (after sign-off):** session ACL types in `codesurf-daemon/src/types.ts` + checks in
  `codesurfd.mjs`; per-user session-discovery stream (fail-closed list + WS deltas); spawn-tree
  visibility. Sequenced, each cross-reviewed.

## Suggested order
1. **A-PR1** (wiring) — unblocks the user's custom-agent goal immediately, lowest risk.
2. **B-PR1** (render-mode) in parallel — different shared file; coordinate the `.mjs` edits with A.
3. **C-D0** design note in parallel (no code) for architect sign-off.
4. **A-PR2** (omnigent fields) after A-PR1 lands.
5. **C-PR1+** daemon multi-user after C-D0 approved.

## Pre-flight (verified)
- PR path works: remote `github.com/jasonkneen/codesurf`, `gh` authed (ADMIN, `repo`+`workflow`),
  no `run.sh`/secret-in-history push-protection risk (that was the sibling `grok-cli` repo).
- Cross-vendor review available: `claude_code` ⇄ `codex` (Pi benched unless dispatched with an
  explicit `args.model` like `gpt-5.5`).

## Provenance
- Chat/capabilities explorer: `claude_code` (conv_e517a42c) — completed.
- Daemon/multi-user explorer: `codex` (conv_1075f0f8) — completed.
- Harness explorer: `codex` (conv_8aa88261) — completed (after `pi` failed twice on a missing-model default; see note).
- `pi` worker note: crashed twice ("process ended without response") because it was dispatched with no `args.model`. Its model list is verified and includes `gpt-5.5`; only dispatch `pi` with an explicit `args.model`.
