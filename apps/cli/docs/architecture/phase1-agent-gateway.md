# Phase 1 — Agent-gateway serve mode & PTC presentation (plan & record)

**Branch:** `phase1/agent-gateway` (off Phase 0) · **2026-09-07**
Architecture: `docs/architecture/v0.md` §5, §12 roadmap. Anti-duplication law: capabilities land once, in the engine (grok-cli); fronts connect.

## Goal (v0 §12 Phase 1)

Agent-gateway serve mode: sessions + full tool plane + **PTC presentation** + worker runtime on the engine; MCP/ACP/session surfaces. Exit: TUI and IDE drive the same gateway; a PTC session's wire collapses to `[run_code]` + SDK.

## Ground truth (measured)

- `src/agent/session-toolsets.ts` `buildTurn` assembles the per-turn AI SDK `ToolSet`: kernel tools (`getEnabledToolSet(mode)`), optional MCP overlay, `filterToolSetByEnabled`, `wrapToolSetWithLoopGuard`. Single source for the wire.
- `src/agent/turns/stream-turn.ts` is the streamText loop: `tools = turnToolset.tools` → `streamText({...tools})`; AI SDK drives multi-round tool calls internally.
- `src/agent/agent.ts` (~265) assembles system prompt STABLE → VOLATILE; `SessionPromptContext` holds session-stable sections; `mode-prompts.ts` has mode sections. SDK injection point = STABLE block, byte-stable per session (tool-catalog stability, v0 §5).
- Policy is already inside tool `execute` closures (approval wrappers at registration, loop-guard at build) ⇒ sub-dispatch through the SAME ToolSet object's `execute` is same-pipeline by construction (§4.5.1).
- DSH worker runtime packages verified Node-runnable in Phase 0 probes (`stripTypeScriptTypes`, `worker_threads`, import clean).

## Workstreams

- **W1 PTC presentation** — per-session `presentation: native|code|both`; at `buildTurn` keep native ToolSet for bindings; wire ToolSet = `{ run_code }` (code) or native + run_code (both). SDK renderer (names/descriptions/arg+output types from AI SDK `inputSchema`; output degrade → unknown) + usage instructions, injected into the STABLE system block. `run_code` execute → host a code runtime (`CodeRuntime` seam) with bindings = native tool executes; curated `{logs, result}` returns. Serial sub-dispatch v1 (v0 roadmap). Engine tests (scripted provider): wire == [run_code]+SDK; program composes 2 tools with curated result.
- **W2 Serve mode** — engine server: sessions + tool plane + PTC over HTTP/WS session API + MCP server; TUI/IDE/headless as clients (daemon/gateway per v0 §5). 
- **W3 ACP + OpenAI-style surfaces** — for external agents/IDEs (agensis etc.).

## Exit checks (W1)

1. `buildTurn` under `code` returns wire ToolSet of exactly one tool (name `run_code`) and keeps native set for bindings; `both` includes both.
2. streamText request, captured by a scripted provider, contains ONLY run_code schema (code) and system prompt contains the SDK block.
3. A run_code program executing two native tools (read + grep or bash) returns curated output; sub-call rejections surface as program-side errors (ToolCallError-equivalent); settlement aborts in-flight.
4. Typecheck + targeted tests green; no regressions in native mode (default).

## Record

- **2026-09-07 feasibility (verified by probe):** DSH worker runtime hosts inside the engine. `new Context()` from `@deepseek-ai/cordis` (installs built-in services incl reflect) + `ctx.plugin(WorkerThreadCodeRuntime, {})` (deps `@deepseek-ai/dsh-code-runtime-worker-thread@0.1.1-rc.2`, `@deepseek-ai/dsh-code-runtime@0.1.1-rc.2` added to engine root) → `ctx.codeRuntime.run({program, bindings})`. Probe results: trivial program → `{logs:[], value:42}`; binding rejection → program-side typed error carrying `toolName` + message. Node ≥22.6 (stripTypeScriptTypes; ExperimentalWarning noted). ⇒ W1 bindings bridge = wrap native ToolSet executes; no worker-host unknowns remain.

- **W2 slice 1 DONE (2026-09-07, commit d9e6094):** src/gateway/ — session registry (CRUD),
  StreamChunk→SSE mapper (whole-chunk fidelity), HTTP server (bearer auth via timing-safe
  compare; GET /healthz; sessions CRUD; POST /sessions/:id/messages streams SSE through an
  injected GatewayTurnRunner seam; empty-message 400; unknown-session 404).
  **8/8 tests green** on a real ephemeral-port server (node vitest); typecheck exit 0.
  Next: host wiring (Agent-backed runner + `codesurf serve` command), then MCP/ACP surfaces.

- **W2 slice 2 DONE (2026-09-07): serve host + command.** Agent gains per-session
  `presentation` option (AgentOptions, resolved per agent via resolvePresentation).
  src/gateway: token.ts (env/file bearer token, 0600, generated), agent-host.ts
  (per-session real `Agent` bound to the turn seam, cleanup on remove/shutdown),
  serve-command.ts (`codesurf serve`: boot plugins, sandbox, gateway; graceful shutdown).
  http-server DELETE sessions now invokes an `onRemove` host hook.
  `codesurf serve --help` verified; **10/10 tests green** (gateway 8 + token 2); typecheck exit 0.
  Remaining: live provider-backed turn run (owner-side, needs API key), MCP/ACP surfaces.
- **W2 MCP surface DONE (2026-09-08, commit 45be5c4):** `src/gateway/client.ts` (GatewayClient —
  health / sessions CRUD / message over the gateway HTTP+SSE wire) + `mcp-server.ts` (buildMcpServer
  exposing three stdio tools: codesurf_list_sessions / codesurf_create_session / codesurf_message, so
  any MCP client drives engine sessions while the engine keeps its full tool plane server-side) +
  `codesurf mcp` command wiring in src/index.ts. **3/3 MCP tests green** (in-memory transport over a
  real ephemeral gateway). One surface per client stays thin: MCP = tools; the engine's PTC is untouched.

- **W3 ACP surface DONE (2026-09-08, commit b64a703):** ACP (agent-client protocol) envelope for external
  agent clients/IDEs (agensis etc.) to drive engine sessions, complementing session API + MCP. `acp.ts`
  (versioned envelope: session/init/success · session/status · session/end · message/stream/{start,update,end}
  · agent/error; chunks carried whole in message/stream/update so no threshold fidelity is lost); mounted
  as `/acp` routes on the gateway http-server (reusing bearer auth, registry, turn-runner seam); `acp-client.ts`
  (thin client mirroring GatewayClient). OpenAI-style LLM-gateway surface remains as the last W3 item.
- **W3 OpenAI-style LLM-gateway surface DONE (2026-09-08):** `/v1/chat/completions` on the gateway,
  OpenAI-compatible (stream + non-stream) so an OpenAI-form client (Chat UI, LLM gateway consumer,
  IDE) drives the engine. `openai.ts` (request/response shapes, SSE delta/stop/[DONE] frames,
  lastUserMessage extraction); mounted in http-server.ts reusing bearer auth, registry,
  turn-runner; stateless per request (one gateway session, removed after the turn).
  Engine content StreamChunks become OpenAI text deltas; full tool plane stays server-side.
  **4/4 tests green** (non-stream, stream, no-user-message 400, runner-error stream termination).
- **2026-09-08 live smoke + fixes (verified end-to-end):** booted `codesurf serve`, then drove a real
  provider-backed turn through the OpenAI surface (POST /v1/chat/completions → model reply). This clears
  the last Phase 1 exit item (owner live provider-backed turn). Two real bugs surfaced and fixed:
  (1) `GatewayAgentHost.runner` was an unbound generator — `this.agents` was undefined when the HTTP
  server invoked it; now a bound method (arrow wrapper over a private `runTurn`).
  (2) serve's `--port` was silently ignored: the top-level sandbox option `--port <mapping>`
  (README port-forwards) shadowed the serve subcommand's `--port <port>`. Renamed the sandbox flag to
  `--forward-port <mapping>` and updated README, so `codesurf serve --port N` binds N. No publish.


  **5/5 ACP tests green** on a real ephemeral-port server. Design decision: v1 speaks the session/prompt/
  stream subset; full ACP control (approvals, multimodal, tool policy) lands behind the same envelope later.