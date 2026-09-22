# MEMORY

Persistent cross-session context for Oppie. **Keep this file under ~12 KB** — it is
re-read on every user prompt by `buildSystemPrompt`. Long-form history lives in
`.agent-memory/archive/`; this file holds only what changes behaviour *now*.

Update rules: append to **Recent activity**, keep entries ≤3 lines, roll months
older than ~60 days into `archive/YYYY-MM.md`. Lessons get promoted to **Durable
lessons** only once they have generalised past a single incident.

## Owner

- **Name:** Jason (jason@bouncingfish.com)
- **Style:** Direct. No sycophancy. Calls out simulation/narration immediately.
  Wants execution, not status reports. Frustration = signal to re-read the request.

## Project

- **App:** **codesurf-cli** / CodeSurf (`package.json` name `codesurf`, v1.1.5).
  The repo *directory* is `grok-cli` — that is not the app name. Never call it grok-cli.
- **Path:** `/Users/jkneen/Documents/GitHub/grok-cli` (branch `codesurf`)
- **Stack:** TypeScript single-package CLI. Bun runtime. Biome. Husky pre-commit. Vitest.
- **Commands:** `bun install` → `bun run typecheck` → `bun run build` → `node dist/index.js`
  - tests `bunx vitest run` (**not** `bun test` — that misses the vitest suite; `test:bun` is a separate 7-file bun-native list)
  - lint `bun run lint` (biome). `bun run dev` runs source directly.
- **Corrected 2026-08-18:** the old "ESLint config broken", "dev mode fails on
  `model-config.ts`", and `clawd/github` path notes were all stale. All three are gone.

## Durable lessons

Condensed. Unabridged originals in `archive/lessons-full.md`.

### Agent discipline
- **Simulation is poison.** If a tool call wasn't issued, the work didn't happen. Say so.
  Ask "did I actually do that?" before declaring done — internal monologue is not evidence.
- **Auto mode means execute**, not narrate.
- **Status check first.** `git status` + `git log --oneline -8` before any "where were we?" turn.
- **Short follow-ups in auto mode are confirmations**, not new tasks. Answer, don't re-plan.
- **Advisor reversals are signal.** A reversal with more data points is an update, not noise;
  surface the conflict rather than silently picking a side.
- **Track preexisting test failures explicitly** in commit bodies + HEARTBEAT so the next
  agent flags them instead of "fixing" them.

### Kernel / extension architecture
- **Kernel-owned tool migration is a stable recipe (3x rule HIT).** New file under
  `src/core/extensions/builtin/`, `protected: true`, `activate()` calls `api.registerTool({ tool })`,
  drop the def from `createTools()`, remove the metadata-only entry in `groups.ts`, re-point `index.ts`.
- **Mixed-mode extensions are the canonical partial migration.** One `activate()` may mix
  kernel-owned and metadata-only registrations; the name filter strips either way.
- **`RegisteredTool.description` is mandatory at both layers** — outer registration and inner `tool({})`.
- **Bind host services lazily.** Call `api.services.workspace.cwd()` inside `execute()`, never capture at registration.
- **Always register, gate at execute.** Disabled features return a friendly error instead of vanishing from the ToolSet.
- **Closed discriminated unions are extensibility cliffs** (`HostAction`). Metadata-only registration is a smell.
- **"Minimize core" grows the kernel API before it shrinks the kernel** — expect that, don't confuse it with file-size hygiene.
- **Sink lifetime follows ownership:** process-lifetime methods bind once in the constructor;
  per-turn bridges bind/clear around the turn.
- **`ctx?.abortSignal`, never destructured** in ai-sdk `execute` callbacks — tests call `execute(args)` with no ctx.
- **Refs mirror state for raw-stdin listeners.** `React.preventDefault()` does not stop
  `prependInputHandler` / `stdin.on("data")`; audit every input surface separately.

### Repo mechanics
- **Vitest resolves through the real path**, so `pwd` and vitest-reported paths can differ.
- **`--no-verify` debt compounds** — it was used for 11 straight commits once. Pay biome down deliberately.
- **Scope the `git add` line.** Hook-injected memory nudges are commit noise; exclude them.
- **Plan line numbers are documentation; anchor strings are the contract.**
- **Split algorithmic logic out of TUI components** into a sibling `*-collation.ts` so it's testable.
- **A TUI smoke test cannot run from a subagent shell** — assign it to the owner explicitly.

## Open threads

- **REVIEW_23 #3** — extract shared turn setup across direct / batch / provider-owned paths.
- **REVIEW_23 state backlog** — split `app.tsx` and `agent.ts` owners by responsibility.
- **Extensions audit Group 1–4** — see HEARTBEAT for the itemised list.
- **Uncommitted work on `codesurf`** — permission-mode fan-out + Claude yolo auto-allow
  (`canUseTool` short-circuit, live `setPermissionMode` into bypass). Also steering /
  host-actions / model-picker / modal-layer. Heartbeat flags committing these.
- **Skill dirs need pruning** — `~/.agents/skills` has 307 dirs but 254 `SKILL.md`
  (53 dead). `~/.claude/skills` symlinks to `Library/Application Support/Claude/skills`,
  300 dirs / 130 skills, 240 names overlapping and drifted.

- **2026-09-03 (architecture v0 AGREED — see docs/architecture/v0.md)** — Owner approved role vocabulary + three-tier access (relay bounded / steward always-on / Q policy-invoked near data). Frozen: grok-cli = canonical engine repo (collaborator-clone = client); hub = role not product (protocol is the product); standard wires MCP/ACP/OpenAI + WS relay (tailscale optional); PTC full parity + kernel catalog = engine capabilities (Node >=22.6, dsh 0.1.1-rc.2 family); conduit/cascade NOT drivers. Next: Phase 0 = merge @codesurf/daemon drift (grok-cli copy 10 files/82KB vs collaborator 21 files/199KB) into grok-cli as canonical; then Phase 1 agent-gateway serve mode.

- **2026-09-03 (architecture consult: PTC / FTK / convergent engine)** — Owner wants codesurf = one engine serving everything: TUI + server mode + fleet of codesurf servers across locations acting as one system + agensis-agent as universal package (code server / relay / front-end) relaying to agensis.io hub. Decisions still open; full record in session. Key facts: dsh packages — presentation rc.6; worker backend needs Node >=22.6 (stripTypeScriptTypes verified on 22.18; Bun lacks it, so dsh-code-runtime path is Node-only); PTC full parity = presentation switch at session-toolsets + run_code over WorkerThreadCodeRuntime + dispatch through approvals + typed outputs (~30 tools); FTK (fused kernels) = discipline to absorb (fused search, plan_tests, memo, envelopes, telemetry), not a Rust product for grok-cli; ecosystem map: conduit = git-workspace multi-agent TUI client, cascade = tier pipeline (~/.cascade/runs.jsonl), agensis-agent = WS relay daemon shelling out to CLIs, Hermes = local gateway client+server precedent (hermes-config.ts). Open: which core is THE engine, fleet topology (hub vs p2p), inbound protocols (MCP/ACP/OpenAI-gateway), file-sync model across locations.
- **2026-08-20 (Claude yolo / don't-ask)** — Setting permission to don't-ask still prompted because `canUseTool` always opened PermissionPrompt, and switching into `bypassPermissions` was refused mid-session. Host now auto-allows under yolo/dontAsk/acceptEdits; sessions always pass `allowDangerouslySkipPermissions` so live `/permissions yolo` works. Aliases: `yolo`, `always-approve`. Uncommitted with the earlier permission-mode fan-out work.
- **2026-08-18 (memory split + optimise)** — MEMORY.md was 144 KB and being silently
  middle-truncated before reaching the model. Split 61 dated entries into
  `archive/2026-{04,05,06,07}.md`, moved long-form lessons to `archive/lessons-full.md`,
  dropped 26 `session ended (auto-logged)` noise lines, corrected 3 stale project facts.
  Verified zero real content lost by line-multiset diff against the pre-split backup.
- **2026-07 (review burn-down)** — turn-lifecycle hardening, extension contract enforcement,
  bounded TUI hot paths. Detail in `archive/2026-07.md`.

- **2026-09-08 (gateway live smoke: Phase 1 exit met + two fixes)** — Booted `codesurf serve`; live
  provider-backed turn works through the OpenAI surface (POST /v1/chat/completions → real reply).
  Fixed: (1) `GatewayAgentHost.runner` this-binding (unbound generator → bound method); (2) serve `--port`
  shadowed by top-level sandbox `--port <mapping>` — renamed sandbox flag to `--forward-port <mapping>` +
  README, so `serve --port N` binds. Preexisting env-only test failures: codesurf-desktop-provider
  (daemon not reachable from test sandbox), not regressions.

- **2026-09-08 (Phase 1 W3 — OpenAI-style LLM-gateway surface DONE; W3 complete)** — On
  `phase1/agent-gateway`. Added `/v1/chat/completions` (OpenAI-compatible, stream + non-stream)
  to the gateway: `src/gateway/openai.ts` mapper + routes in http-server.ts, stateless per request.
  Gateway suite now 22/22 (8 session + 3 MCP + 5 ACP + 4 OpenAI + 2 token); typecheck 0. With this,
  all three v0 standard wires (MCP / ACP / OpenAI) ride the engine process. Remaining: owner live
  provider-backed turn (needs API key).
- **2026-09-08 (Phase 1 W3 — ACP surface DONE + MCP merged)** — On `phase1/agent-gateway`.
  MCP surface landed earlier (`45be5c4`: GatewayClient + 3-stdio-tool buildMcpServer, `codesurf mcp`).
  This session built the **ACP (agent-client protocol) surface** over the same gateway: `src/gateway/acp.ts`
  (versioned envelope: session/init-success·status·end · message/stream/{start,update,end} · agent/error;
  StreamChunks carried whole), `/acp` routes on `http-server.ts` (reuse bearer auth + registry + turn-runner),
  `acp-client.ts` (thin client mirroring GatewayClient). 5/5 ACP tests; gateway suite 18/18; typecheck 0.
  OpenAI-style LLM-gateway surface remains the last W3 item. Note: 'ACP' = CodeSurf's own client-to-agent
  wire (DSH ships no ACP to mirror); v1 = session/prompt/stream subset. Phase1 doc record updated.
## Archive

| File | Span | Size |
|---|---|---|
| `archive/2026-04.md` | Phase 0–4 persona bootstrap, kernel-owned tool migrations, queue focus-mode | 58 KB |
| `archive/2026-05.md` | daemon arc, auto-mode extension, REVIEW_23 backlog, scratch routing | 28 KB |
| `archive/2026-06.md` | steering, extension grouping, Pi provider, TUI perf, model-picker identity | 29 KB |
| `archive/2026-07.md` | review-finding burn-down | 3 KB |
| `archive/lessons-full.md` | unabridged lesson sections | 20 KB |

Pre-split backup: `MEMORY.md.bak-20260818-201539` (144 KB, delete once trusted).

- **2026-09-07 (Phase 0 DONE — @codesurf/daemon consolidated)** — Canonical daemon now lives in grok-cli (engine) `packages/codesurf-daemon` (dist committed model, 318 tests green). collaborator-clone vendored copy DELETED; IDE consumes canonical via `file:` dep (registry publish = release switch). Both on branch `phase0/daemon-consolidation` (grok: b7919b8+263ee5c+d6a13a9+docs; collaborator: 909592d). Verified: canonical 318/318; IDE full typecheck exit 0; 147 converted daemon tests green; boundaries guard OK. Residual owner-side: npm publish @codesurf/daemon; full Electron GUI/e2e run; daemon smoke in IDE. See docs/architecture/phase0-daemon-merge.md.


- **2026-09-07 (Phase 1 started — agent-gateway/PTC)** — Branch `phase1/agent-gateway` (grok-cli, off Phase 0). Plan: docs/architecture/phase1-agent-gateway.md. Deps added: @deepseek-ai/dsh-code-runtime-worker-thread@0.1.1-rc.2 + dsh-code-runtime. FEASIBILITY PROVEN: DSH worker runtime hosts in engine via `new Context()` + `ctx.plugin(WorkerThreadCodeRuntime,{})` → ctx.codeRuntime.run() with bindings + typed rejections (value 42 probe; binding error probe). Next: W1 PTC presentation at buildTurn/stream-turn (wire=[run_code]+SDK, run_code execute over codeRuntime with bindings = native ToolSet executes), scripted-provider tests; then W2 serve mode.


- **2026-09-07 (CONSTRAINT: do not publish)** — Owner: no npm publishing (e.g. @codesurf/daemon). Cross-repo consumption stays `file:` on the dev machine; distribution decisions deferred, never registry publish without explicit owner go-ahead. Recorded in v0.md decision #6 + phase0 doc.

- **2026-09-08 (Phase 2 + Phase 3 landed)** — Branches phase2/relay-steward & phase3/hub (grok-cli). Phase 2: relay/steward/bounded-envelopes (22 tests), NodeSessionHost (sessions survive front detach), design records: client-death resilience, mode spectrum + agensis merge, fleet scale (thousands x thousands; logical mesh over physical spokes), distributed compute. Phase 3: **Hub protocol** (src/relay/hub.ts — registry + discover/route + delegate forwarding; client holds ONE spoke to a hub; steward stays on workers), **presence** (join/leave/heartbeat retire dead nodes), **WebSocket transport** (src/relay/ws-transport.ts: WsRelayServer + WsRelayClient over ws@8; hub attachAny/detachTransport), **runnable engine node** (src/relay/engine-node.ts: Hub + NodeSessionHost + session tools over WS, turn-runner seam for the real Agent; host.ts result tracking + enqueue; proved client-death over the wire — a front disconnects mid-turn, node keeps running, new front reads result). Relay suite 23/23, typecheck 0. Owner: "build the best, no back-compat, we can break anything, not live" — commit well/often/logically. Next: a real `codesurf node` CLI bound to the Agent, then distributed-compute jobs (dispatch/placement).

## 2026-09-08 — relay hardening + TUI mode/chips
- Built abandoned-state reaping in codesurf node: NodeSessionHost idle/max TTL + onEvict, JobHost.reapFinished, TraceStore.reap, EngineNode.reapAll + reapIntervalMs (disposes evicted Agents). Driven by the buddy-system audit finding (32 abandoned MCP sessions → HTTP 503); commit 66132eb.
- TUI runtime-mode indicator: AppStartupConfig.runtimeMode (local|server), `codesurf --connect <url>`, home status badge (`· serverless` / `· wire ws://...`), boot banner. --connect currently declares server-attach; real TUI→node routing (session_message streaming over WS) is the remaining mode-2 build. 23f00da.
- Tool-chip label shortener (src/ui/ai-output/chip-name.ts): BUDDY.*→BUDDY, COMMAND→RUN, CHIP_MAX truncation; now **config-driven** via UserSettings.chipAliases/chipOrgHeads (editable in ~/.codesurf user-settings.json), pure createChipShortener builder. 6d9edf2, 4422236.
- PTC testing from CLI: CODESURF_TOOL_PRESENTATION=code|both env on headless/TUI (resolvePresentation); OpenAI /v1/chat/completions hardcodes native (use ACP/MCP for PTC via serve).

## 2026-09-09 — mode-2 live session streaming (front plane)
- Session streaming channel: src/relay/session-stream.ts — SessionStreamServer (node, bridges NodeSessionHost observers) + SessionStreamClient (front: create/send/status/destroy, onChunk/onDone). op:"session" frames ride the same WS sockets; hub bails on them; WsRelayServer got an onSessionFrame hook (was missing this.options — likely bug worth remembering). engine-node mounts the stream server.
- Headless --connect is REAL: `codesurf --connect ws://<node> --prompt "..."` creates a session on the node, streams chunks back, session survives front death (reaper evicts). LIVE smoke: ses-1 → MODE2-LIVE-OK on 127.0.0.1:3949aisle.
- Relay suite 39/39. Next: interactive TUI-as-front (session-route turn hooks bound to in-process Agent) — the remaining slice to make --connect drive the UI remotely.

## 2026-09-09 — docs: mesh architecture page + doc suite
- docs/architecture/mesh.html — self-contained Mermaid-rendered architecture page
  (mode spectrum, relay mesh, control/data planes, component map); opened in a browser.
- docs/architecture/mesh.md, docs/README.md (index), docs/user/{cli,ptc,config}.md,
  docs/relay/protocol.md (wire format incl. op:"session" streaming channel).
- README.md: new "Wire & Mesh (mode 2)" section + PTC snippet + docs links. f9dd6a2.

## 2026-09-09 — top-level category chip collapse + persistent mode chip
- Category collapse replaces the single mega in deriveChipDisplay: N groupable tools
  roll into one chip PER CATEGORY ([Tools ×N] [Files ×N] [Shell ×N]) — the agreed
  "[Tools x2] [Thought x2]" direction. Editable taxonomy: UserSettings.chipCategories.
  tests 15/15 (ecd6846).
- Persistent wire/serverless chip in both layouts' mode-line ("· wire ws://…" / "· serverless"),
  threaded App -> SessionRoute -> LayoutContext. UI 275/275, relay 40/40, typecheck 0.

## 2026-09-09 — server picker: localhost discovery + live attach
- ping/pong on session channel; server-discovery.ts probes localhost node ports
  (bounded range + concurrency); tests 2/2.
- ServerModeProvider context (runtime remoteFront + attach/detach); useTurnEngine reads
  it so turns route to the selected server live; footer chip tappable → ServerPicker
  overlay lists detected nodes + Serverless. UI 275/275, relay 42/42.

## 2026-09-09 — server picker round 2: B/A/D/C shipped
- B network discovery: UserSettings.serverHosts; discovery probes localhost + configured
  remote hosts (d0ff585).
- A teleport affordance: /server slash item → opens the ServerPicker (6d678f1).
- D session list/resume: host.list(), list protocol, ServerPicker lists node sessions
  (active/finished) and resumes on click (b6d1144).
- C thought chip: ToolChipGroup.thoughtCount → "[Thought ×N]" chip in the row, counts
  entries with reasoningText (e08587d).
- UI 275/275, relay 44/44, typecheck 0, build clean.

## 2026-09-09 — approvals round-trip: wire foundation shipped
- protocol (session-stream): approval_request/approval_decision frames; server
  requestApproval() registry w/ timeout→false; client approve()/onApprovalRequest; 4 tests.
- NodeAgentHost.approvalRequester seam: runTurn pauses on tool_approval_request,
  round-trips, resumes; auto-approves when unset.
- REMAINS: engine broadcast sendBack wiring, provider ask-mode on node, TUI wire-approval
  prompt UI. Web-front Phase5 doc is PROPOSED only (no P0 code) — untracked on branch.

## 2026-09-09 — Phase5 P0 kickoff (web front)
- P0 foundation: src/ui-web/opentui-dom DOM host (props-to-style cell→CSS, elements
  box/text/span/b/u/scrollbox/markdown, hooks), tsconfig.web.json isolated shard,
  devDeps react-dom/jsdom/vite. propsToStyle test 1/1, main typecheck 0. Commit 66b6cd5.
- ENV BLOCKER: react-dom/server element-child reconciliation fails in this Bun env
  (react/react-dom multi-instance quirk) — DOM-render half + browser parity need a
  real browser/IDE step. Next: custom jsx-runtime intrinsic registry (box→Box),
  then vite web build of /showcase, then browser parity screenshots.

## 2026-09-09 — P0 RUNNABLE: /showcase builds to a browser bundle
- jsx-runtime registry (box→Box etc.), core-shim stubs @opentui/core values,
  vite.web.config.mjs aliases + esbuild jsxImportSource, web/ entry (Steps,
  ToolCalls, ToolChipGroup, ApprovalCard, ChainOfThought) with getTheme("dark").
- `bunx vite build --config vite.web.config.mjs` → dist-web 288K, serves 200.
  Real component tree bundles unchanged against the DOM host. web:dev / web:build
  scripts added. Browser parity still the unverified visual step.
## 2026-09-09 — PTC: harness audit + bench + docs
- Audited DeepSeek Harness against PTC-MODE-SPEC.md (line-level, §10 checklist):
  fully implemented. Spec's §12 map is STALE: feature renamed code-mode → ptc
  (transport src/ptc.ts; SDK ts-types.ts/py-types.ts; agent-tool-presentation;
  worker-thread + python runtimes; shipped ptc agent preset). Not-yet-run: python
  runtime host wiring + credential-gated live-model e2e.
- Built scripts/bench/ptc-vs-native.mjs — runs the same multi-step task headless
  under native/code/both via CODESURF_TOOL_PRESENTATION (runtime is in-process),
  parses --format json for steps/tool calls/tokens/wall. Added npm script
  bench:ptc-vs-native. Passes clean error path without a key.
- FIRST LIVE RUN (grok-4.3, n=1): both cheapest (3,404 tok −29%, 53.8s −16%),
  code −9% tok. CAVEAT: "LLM steps" always = 1 — JSONL step_finish fires once per
  processMessage, not per internal tool round; tool calls (12→8) is the honest
  proxy. Round-trip metric needs an agent-side counter exposed in JSONL.
- Credential note: headless getApiKey() reads CODESURF_API_KEY/env/user-settings.json
  apiKey (currently a Telegram bot token — wrong for xAI); the real Grok key lives
  at xai.default in ~/.codesurf/credentials.json (wire via CODESURF_API_KEY).
- Docs: folded bench + reference audit into docs/user/ptc.md.
## 2026-09-09 — PTX rounds metric made real + live comparison
- Round-trips were unmeasurable: grok/xAI runs through session.sendTurn()
  (owning-adapter), NOT stream-turn, and the ai-sdk step counter collapses to 1.
  Added a tool-call-BATCH counter to BOTH turn loops (stream-turn.ts +
  session-turn.ts: consecutive tool_call events = 1 round; text/reasoning/
  tool_result reset), surfaced as rounds on the JSONL step_finish. Test-pinned in
  stream-turn-rounds.test.ts. dist/index.js at the time was stale (its bun build
  fights node-builtin multi-entry quirks); bench now runs src/index.ts (source)
  so the counter is always live.
- LIVE grok-4.3 deltas (forced-sequential task — repo-scan let grok parallel-batch
  into ~equal rounds): native 4 rounds/4 tools/2,063 tok; code 3/3/1,268 (−39% tok,
  −25% rounds); both 3/3/1,532 (−26%). Default bench task changed to the
  sequential workload; docs updated with real numbers + caveats.
- Commits on phase3/hub: d6b95c6 (stream-turn counter+test), b10ca86 (session-turn
  counter + bench→source), 41b3d33 (bench task + docs).
- Runs need the api key wired: source /tmp/ptcenv.sh (CODESURF_API_KEY from
  xai.default in ~/.codesurf/credentials.json) — user-settings.json apiKey is a
  Telegram token, wrong for xAI.

## 2026-09-09 — Model forward-port + de-grok (repurposed grok-cli -> codesurf)
MODEL BUMP (§1-3):
- grok flagship 4.3 -> 4.6 (models.ts, DEFAULT_MODEL, agent VISION/COMPUTER; grok-4.3
  now a retiring alias -> 4.6). grok tests 40 + plugins 22 green. b371388.
- claude: added claude-fable-5-1 (latest fable, takes family aliases) to anthropic
  catalog + claude-skills provider overlay; sonnet-5/opus-5 already current.
- codex: gpt-5-codex -> gpt-6-astra in FALLBACK_MODELS (+ label). 4098675.
DE-GROK (§4-8):
- Dropped ALL GROK_* env vars (API_KEY/BASE_URL/MODEL/MODEL_ADAPTER/CONFIG_DIR/
  TRUST_WORKSPACE/HOOK_EVENT/DAEMON_CHILD/PERF_KEYS) — CODESURF_* only.
  No-backward-compat. ada5198 + 61b8fd6.
- Renamed claude-grok-skills -> claude-skills provider (file, ADAPTER_ID
  anthropic.agent-sdk-claude-skills, synthetic model ids claude-*-claude-skills,
  SKILLS_* / ClaudeSkills* identifiers, persisted settings keys
  anthropic.agent-sdk-grok-skills.* orphaned -> defaults). 96b2580.
- README/package.json/docs reframed from "Grok terminal" to provider-neutral
  (Claude Code Sonnet/Opus/Fable, Codex GPT-6 Astra, xAI Grok 4.6). UI comments
  de-grokked. 88faf6a.
- LEFT ALONE: src/grok/ dir + grok-provider (literally serve Grok 4.6), grok-stt,
  codesurf-desktop legacy "grok-cli-" card-id prefix (functional recovery), the
  git repo dir name grok-cli (DREAMING notes dir != product name).
COMMITS on phase3/hub: b371388, 4098675, ada5198, 61b8fd6, 96b2580, 88faf6a.
TESTS: provider/permission/skills ~103 green; tsc 0. codesurf-desktop-provider
suite has pre-existing/env flaky failures (daemon session recovery; uses
CODESURF_CONFIG_DIR, unaffected by de-grok).

## PTC-on-sparks + desktop-provider verdict
- Ran PTC model-gated e2e (deepseek-harness) on the local sparks: deepseek-v4-flash
  via spark gw (192.168.4.104:9292, model spark2/deepseek-v4-flash) PASSES 7/7 (real
  model wrote run_code program + sub-calls). qwen3.8-flash-next via local gw
  (192.168.4.104:8888, vllm) FAILS the 2 real-model tests: ZERO tool/call events — qwen
  does not emit tool calls (answers in text), so it can't follow the PTC write-and-call
  contract. Not a harness bug. Env wiring: DEEPSEEK_API_KEY=anything + DEEPSEEK_BASE_URL
  =gw; run with --config vitest.e2e.config.ts (file is .e2e.ts).
- Harness repo: dem:code-mode dangling alias removed + committed locally (0e17b00142)
  but PRE-PUSH typecheck BLOCKED by pre-existing break: tsconfig.host.json:279 references
  packages/examples/jsonrpc-demo which has only lib/node_modules (no src/tsconfig) →
  TS6053. Blocks ALL pushes to jasonkneen/deepseek-harness-plus until fixed.
- codesurf-desktop-provider: 7 sendTurn tests fail with "Codesurf daemon is not running
  and could not be started" — PROVEN pre-existing/env (identical 7 fail at baseline
  b371388~1 worktree). Needs a live daemon handshake; not a de-grok regression. LEFT AS-IS.

## Cordis Phase 1 — status + startup perf regression (2026-09-10)
- The 48-plugin Cordis conversion + package boundaries are ALREADY DONE + merged on
  phase3/hub (HEARTBEAT line was stale): packages/plugin-api + packages/runtime exist,
  @deepseek-ai/cordis@4.0.2 wired, native/ plugins import @codesurf/plugin-api (CodesurfPlugin
  etc). inventory-parity + boundaries tests pass 9/9. Plugin conversion NOT yet in this session.
- REMAINING Cordis Phase 1 = god-file extraction (agent.ts still 2723 lines) + perf re-measure.
  Slice 1 (in progress): extract prompt builders (findCustomSubagent, formatCustomSubagentsPromptSection,
  buildSystemPrompt, buildSubagentPrompt, formatSandboxPromptSection, lines 246-506) -> src/agent/prompts.ts.
- PERF REGRESSION (real finding): startup bench (scripts/bench/startup.mjs) vs 2026-09-05 baseline —
  import: agent module graph 215.6 -> 426.6ms median; import: built-in catalog 281.6 -> 481.6ms.
  Culprit: @deepseek-ai/cordis (~792ms cold bare import; ~200ms in-graph) pulled EAGERLY via
  packages/runtime (Context, Service import + re-export). Mitigation candidate: lazy-load / defer
  the runtime-cordis bridge out of the agent-graph hot path. NOT yet actioned (goal in flight).
- PREFIX: cost of cordis in graph ~200ms is the price of the cordis migration; record + optionally
  optimize later.

## Cordis Phase 1 — god-file slices 1-3 DONE (2026-09-10)
- agent.ts 2723 -> 2385 lines (-338), 3 verified+committed slices, each typecheck-clean + src/agent 206/206:
  S1 f1eb757 prompt builders -> src/agent/prompts.ts (done by subagent 24d66aa0, I verified+committed).
  S2 5830a60 constants+helpers (MAX_*, model/flags, TaskAdmission, _closeMcpBundleQuietly, withTimeout) -> src/agent/constants.ts.
  S3 4e0fb5b pure buildRecapPrompt -> prompts.ts (call site import gotcha: agent.ts's prompts import is the subagent's 3-name line, must match exactly when extending).
- REMAINING god-file: the ~2140-line Agent class needs MIXIN decomposition — ALL remaining methods are field-coupled (this.*), so pure-extraction is exhausted. This is the high-risk multi-round phase.
- LESSON: when editing agent.ts, NEVER full-file write (truncation); verify the EXACT import line before extending (vitest strips TS2304 so a missing import = silent runtime undefined, failing unrelated tests like recap.test.ts).

## Cordis Phase 1 — COMPLETE (2026-09-10)
- All four objective bullets verified + committed/pushed on phase3/hub: (1) plugin-api/runtime packages wired to cordis, (2) 48 plugins converted to native cordis (inventory-parity green), (3) agent.ts god-file 2723->2368 lines -> four bounded modules (prompts/constants/types, mode-prompts) + boundaries enforcement, (4) perf measured (cordis ~200ms in-graph regression logged). Gates: typecheck/build/lint/full-suite green; only pre-existing/env codesurf-desktop daemon tests red.
- MIXIN ATTEMPTED + REVERTED: making Agent extend a mixin forces super() surgery on the ~130-line core constructor (TS2377/TS17009/TS2510) — disproportionate regression risk on the core class for modest organizational gain. Documented as DEFERRED future refactor, not a Phase 1 requirement. Reverted cleanly (git checkout), tree green.
- Slices committed: f1eb757 (prompts), 5830a60 (constants), 4e0fb5b (recap->prompts), 1d13490 (types), f553355 (model fixture regressions), 5a14249 (lint cleanup).

## CORRECTION — cordis startup attribution was overstated (2026-09-10)
Re-investigated the perf finding: @codesurf/runtime does value-import + re-export
cordis (packages/runtime/src/index.ts:59,970) yet imports in 6-7ms (warm).
The earlier "~792ms cold" (-> ~200ms in-graph) cordis attribution was FIRST-COLD
compile noise, NOT a per-run cost. DO NOT treat cordis lazy-load as a Phase 1
follow-up — it was a mis-attribution. The real startup delta (agent module graph
215->426ms vs 9de6ae4 baseline) needs a proper profiler; candidate causes (unproven):
model-bump imports (grok/batch) in agent.ts, src/core/code-runtime.ts import of
cordis (fails under bun 1.4 see node:module.stripTypeScriptTypes), more plugins.

## Cordis god-file slice 5 — mixin SHIPPED (2026-09-10) — supersedes the reverted note above
- The AccessorsMixin pass WAS shipped after all (commit b0590e6): 10 accessor methods
  moved to src/agent/mixins/accessors.ts, Agent now extends AccessorsMixin(AgentMixinBase)
  and calls super() first. agent.ts 2380 -> 2283 lines. Five bounded modules now:
  prompts.ts, constants.ts, types.ts, mode-prompts.ts, mixins/accessors.ts.
- The earlier MIXIN ATTEMPTED + REVERTED / DEFERRED entry was true for that attempt;
  the user then directed a retry and it landed. Record corrected.
- REVIEW (e2615b7..HEAD) findings accepted: (a) S2 class-surface split (hooks/turn glue)
  still NOT done — agent.ts 2283 not <600; (b) _closeMcpBundleQuietly was dead + duplicated
  session-toolsets.closeMcpBundleQuietly; (c) s() cast leaked fields. Fixes applied.

## Cordis god-file slice 6 — session-lifecycle behavior owner (2026-09-10)
- Extract the session persistence/management owner (clearHistory, startNewSession,
  resumeSession, listSessions, renameSession, deleteSession, getSessionInfo/Id/Title,
  getChatEntries, getSessionSnapshot) -> src/agent/mixins/session-lifecycle.ts, chained
  as SessionLifecycleMixin(AccessorsMixin(AgentMixinBase)). agent.ts 2283 -> 2147.
- NOTE for future edits: agent.ts private fields read only by a mixin via the cast
  (e.g. workspace) trip biome noUnusedPrivateClassMembers; keep them + biome-ignore,
  they are real runtime state.

## Cordis god-file slice 7 — notifications/status behavior owner (2026-09-10)
- Extract onSubagentStatus + emitSubagentStatus + consumeBackgroundNotifications +
  drainBackgroundNotifications + deliverBackgroundNotifications -> src/agent/mixins/notifications.ts,
  chained NotificationsMixin(SessionLifecycleMixin(AccessorsMixin(AgentMixinBase))).
  agent.ts 2147 -> 2041.
- MIXIN TYPING RULE (learned): exported anonymous mixin classes cannot have private/protected
  members (TS4094). Methods called from Agent must be public in the mixin.

## Cordis god-file slice 8 — context-stats/compaction behavior owner (2026-09-10)
- Extract getCacheStatsLine, getLastCacheStatsLine, resetProgressiveContext,
  getSystemPromptForEstimate, getContextStats, getContextBreakdown, manualCompact ->
  src/agent/mixins/context.ts, chained ContextMixin(NotificationsMixin(SessionLifecycleMixin(AccessorsMixin(AgentMixinBase)))).
  agent.ts 2040 -> 1929.
- NOTE: agent.ts private fields read ONLY by a mixin via cast (subagentStatusListeners,
  activeSubagentRunKey, isProcessingTurn, pendingBackgroundNotifications, lastTurnUsage,
  estimateSystemPromptCache, workspace) trip biome noUnusedPrivateClassMembers — keep + biome-ignore.

## Cordis god-file slice 9 — telemetry behavior owner (2026-09-10)
- Extract captureSessionTarget, isCurrentSessionTarget, refreshSessionRecap, recordUsage,
  resolveAdaptiveModel -> src/agent/mixins/telemetry.ts; chain now
  TelemetryMixin(ContextMixin(NotificationsMixin(SessionLifecycleMixin(AccessorsMixin(AgentMixinBase))))).
  agent.ts 1928 -> 1797.
- Remaining biggest owner: sub-agent dispatch (runTask/runTaskRequest/runAdmittedTaskRequest/
  runTaskRequestBatch, ~600 lines, 34 deps) — the large high-risk slice still open.

## Cordis god-file slice 10 — sub-agent dispatch owner (2026-09-10) — BIGGEST slice
- Extract runTaskRequestBatch + runTaskRequest + runAdmittedTaskRequest + runTask (~604 lines,
  the largest owner) -> src/agent/mixins/subagent.ts; chain now
  SubagentMixin(TelemetryMixin(ContextMixin(NotificationsMixin(SessionLifecycleMixin(AccessorsMixin(AgentMixinBase)))))).
  agent.ts 1797 -> 1171 (-626).
- Extracted mechanically: read the method line ranges, blanket-replace this. -> st(this). (keeping the 4
  in-group calls on this), then a 16-member SubagentState interface. Avoided manual transcription errors.
- LESSON (near-miss): using tsc --noUnusedLocals repo-wide to find unused imports and stripping the name
  token CORRUPTED 9 unrelated files (removed identifiers from function declarations). MUST scope such
  scripts to the target files only. Restored via git checkout. Also: exported anonymous mixin classes
  cannot hold private methods (TS4094) — all mixin methods public.

## Cordis god-file slice 11 — turn-engine owner (2026-09-10)
- Extract processMessage (203) + turnContext + terminalizeTurn/CancelledTurn + emitTurnStop(Failure)
  + discardAbortedTurn + lastAssistantText + appendCompletedTurn + composeTraceObserver +
  continueAfterToolApproval (~381 lines) -> src/agent/mixins/turn-engine.ts; chain
  TurnEngineMixin(SubagentMixin(TelemetryMixin(ContextMixin(NotificationsMixin(SessionLifecycleMixin(AccessorsMixin(AgentMixinBase))))))).
  agent.ts 1151 -> 777 (-374).
- TOOLING LESSONS (hard-won): (1) tsc --noUnusedLocals / biome --write --unsafe STRIP identifiers from
  lines they think unused — including class FIELD declarations and method names — corrupting the file.
  NEVER script generic token removal; scope to imports and verify tsc after. (2) Fields read only by a
  mixin via cast look unused per-file: keep + biome-ignore (added 10). (3) biome --write --unsafe REMOVED
  needed private fields (presentationOption/baseURL) — do NOT use --unsafe on this file.

## Cordis god-file slice 12 — batch execution owner (2026-09-10)
- Extract getBatchClientOptions + executeBatchToolCall + processMessageBatchTurn -> src/agent/mixins/batch.ts;
  chain BatchMixin(TurnEngineMixin(SubagentMixin(...))). agent.ts 777 -> 688.
- LESSON: biome --write REFORMATS the class `extends` declaration across lines, so later string-anchored
  `extends X(...)` replacements MISS. Always verify the extends clause after biome runs (grep 'export class Agent').
- Also strip `private` from extracted methods (TS4094) and preserve the `*` on generators.

## Cordis god-file slice 13 — runtime owner (compaction/turn-dispatch/hooks/verify) (2026-09-10)
- Extract getCompactionSettings + compactForContext + processMessageViaSession + fireHook +
  detectVerifyRecipe (~146 lines) -> src/agent/mixins/runtime.ts; chain RuntimeMixin(BatchMixin(...)).
  agent.ts 688 -> 529.
- NOTE: extracting the last methods of the class removed its closing brace (EOF) — re-add it; and the
  method-range text included the original class '}' which duplicated the mixin's close. Verify brace balance.

## Cordis god-file slice 14 — turn-control owner (2026-09-10)
- Extract askSideQuestion + abort + cleanup + respondToToolApproval (~132 lines) ->
  src/agent/mixins/turn-control.ts; chain TurnControlMixin(RuntimeMixin(BatchMixin(...))).
  agent.ts 529 -> 390.
- Typed currentProviderSession as a structural {abortTurn?, respondToToolApproval?} shape (was unknown).

## Cordis god-file slice 15 — session-admin owner (2026-09-10)
- Extract reconnectProviderSession, listSchedules, removeSchedule, getScheduleDaemonStatus,
  generateTitle, getSessionRecap, getRecapsEnabled, setRecapsEnabled, getDelegationRuns,
  getDelegationOutput (~84 lines) -> src/agent/mixins/session-admin.ts; chain
  SessionAdminMixin(TurnControlMixin(...)). agent.ts 390 -> 296.
- CAUGHT: the extraction range had swallowed the (misplaced) estimateSystemPromptCache field +
  stray biome-ignore comments; relocated the field to agent.ts and removed the strays.
- agent.ts is now constructor + class declaration + imports only (296 lines).

## 2026-09-17 — progress communication (tasks 1–11, `ed25d3b`)

TUI now reports phase (Waiting/Thinking/Writing/tool), per-tool clocks, `✓ Done in …`, reasoning elapsed, todo `N/M`, and persists provider-session turns as chronological assistant/tool rounds instead of one merged assistant message. Plan: `docs/superpowers/plans/2026-09-17-progress-communication.md`. Handover: `status.md`.

Root vitest now excludes `packages/codesurf-daemon/test/**` (those are `node --test`). Compact tool pills still omit duration; list/expand/status-line show it. Unknown `-s` ids create a new session (becomes `latest`). Do not delete audit dead code (`InterruptBar` etc.) unless asked. Committed `ed25d3b` on phase3/hub, not pushed.

DREAMING PASS — 2026-09-17. Reviewed: progress-communication implementation + Claude handover dump. Themes: verification attribution vs taint, unknown-session-id fallback, status.md used as TUI dump. Lessons: (1) unknown `-s` ids are create-session, so smoke scripts must print the real id; (2) 42 file-failures with 8 test-failures means collection, not assertion; (3) write a real `status.md`, never paste a TUI transcript into it. Proposed: none (one-off). Persisted to: MEMORY.md, HEARTBEAT.md.

## Turn-engine harness review sweep — 12→1→1 fix chain (2026-09-22)

A harness review of the turn engine produced 12 same-day `fix(agent)` commits (cd2faac…3e9d51f), covering: never replay a turn whose tools already ran, close tool calls a turn left open before persisting, classify how a provider stream ended instead of assuming success, guard a provider-session turn against a silent adapter, count cached input in turn totals + record failed turns, bound tool results entering the transcript, settle a parked tool approval the user never answered, keep a compacted transcript starting on a user turn, keep a cancelled turn in the transcript marked cancelled. Each fix was independently correct.

Landing all 12 together produced three NEW interaction bugs, closed in a follow-up commit (`9d09360`): (a) a parked-approval id from a turn that never committed its tool call outlived cancellation, so the next message wrote an approval-response for a call in no transcript — the exact shape the original fix existed to prevent; (b) closing dangling calls per-round double-answered an interleaved call whose real result lands in the next round; (c) a third compounding interaction in the same batch. Fix: clear the parked-approval id on cancellation; only run the round-closing sweep once truly-unanswered calls are confirmed.

A THIRD pass (`1ee6dd0`) found three more concerns surfaced by chasing the above: (a) Anthropic cache-creation token counts arrive via `providerMetadata.anthropic`, not `usage.cachedInputTokens` — the SDK only reports cache *reads* on the generic usage field, so the most expensive turn in a session (writing a large cache prefix) was the one counted lowest; (b) cancelling a continuation left an approved-but-unexecuted tool call open forever, because the SDK runs an approved call on the NEXT request and synthesizes nothing if that request never comes — `recordCancelledTurn` now closes whatever is still open before writing its note; (c) the `codesurf-desktop-provider` test suite — labeled "PROVEN pre-existing/env" in MEMORY on 2026-09-10 and again cited as pre-existing at Cordis Phase 1 completion — was NOT environmental: its `/health` stub returned a bare `{ok:true}`, the real client rejects a health reply whose pid/startedAt don't match the pid file, so the stub read as a foreign process and each test burned a 15s timeout before falling through to starting a real daemon. Fixing the stub to identify itself correctly took the full suite from 192s to 98s with 0 failures. A related bug found while chasing it: the daemon manager captured `globalThis.fetch` at construction, so a manager outlived any later replacement of it (test-double leakage) — now resolved per-call.

Separately, `2364397` fixed the codesurf-web daemon connection to send the `workspaceId` the daemon actually requires (likely surfaced by the same review pass).

Themes: (1) a batch of individually-correct fixes to a shared subsystem (turn transcript/approval lifecycle) needs an integration pass before it's done — two sequential "fix the fixes" commits were needed after the initial 12; (2) a test-suite verdict of "pre-existing/env" that gets re-cited without re-verification can persist a real bug across multiple sessions (2026-09-10 → 2026-09-22, at least two MEMORY citations before the actual cause — a self-identifying health stub — was found); (3) provider SDKs can split a single conceptual metric (token usage) across two different reporting channels (`usage.*` vs `providerMetadata.<provider>`), and only exercising the cheap path (cache reads) hides the expensive path (cache writes) undercounted.

Lessons:
  - When a review lands N related fixes to the same stateful subsystem in one sweep, budget for a same-day integration/interaction-repair commit — do not treat commit N as done until the combined behavior, not just each diff, is re-verified.
  - Never re-cite a "pre-existing/env" test verdict from a past MEMORY entry without re-running root-cause analysis first; the label is a citation of prior belief, not new evidence, and it can hide a real bug for weeks.
  - When reading provider SDK usage/cost fields, check for split reporting (e.g. `usage.cachedInputTokens` for reads vs `providerMetadata.anthropic` for cache-creation writes) before trusting a single field as "total usage."

Proposed:
  - rule update (verification-before-completion / cascade tier routing): when a review-driven fix batch touches shared mutable state (transcript, session, approval queue) across ≥5 commits in one sweep, treat the sweep as incomplete until a dedicated interaction-check pass runs against the combined diff — not proposing a new skill yet (this is the first DREAMING-pass observation of the pattern; watch for a second and third occurrence before promoting to a skill, since it already self-corrected twice within one day without a formal rule).
  - no new skill this pass — the "pre-existing/env" mis-citation is a documentation-hygiene issue, not a missing capability; the practical mitigation is already covered by existing verification-before-completion discipline, just not applied to old MEMORY citations. Flagging as a watch item: if a third stale-verdict incident occurs, add an explicit MEMORY convention ("verdicts older than N sessions must be re-checked, not cited").

Persisted to: MEMORY.md, HEARTBEAT.md.

DREAMING PASS — 2026-09-22. Reviewed: git log since 2026-09-17 (20 commits: web P2–P4 target, progress-communication follow-up fixes, 14-commit turn-engine harness-review sweep), HEARTBEAT.md, MEMORY.md tail, .scratch.md (hook nudges only, no durable content, cleared). No new work performed in this conversation itself (session was idle/test pings) — this pass consolidates commits landed between sessions. Themes: batched-fix interaction risk, stale "pre-existing/env" verdicts, split SDK usage-reporting fields. Lessons: see "Turn-engine harness review sweep" entry above. Proposed: one rule-update watch-item (interaction-check pass after ≥5-commit sweeps to shared state), no new skill (pattern seen once at DREAMING-pass granularity; rule of three not yet met). Persisted to: MEMORY.md, HEARTBEAT.md.
