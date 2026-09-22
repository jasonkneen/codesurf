# ADR-001: CodeSurf Daemon Gateway — build-vs-adopt

> Status: **PROPOSED — awaiting architect sign-off.** No daemon code until the path + the one
> open decision (§7) are confirmed. Scope: the daemon/gateway only (agent-def wiring A-PR1 and
> render-mode are separate tracks). Grounded by two independent explorers (E1 omnigent-substrate
> feasibility, codex; E2 daemon↔grok-cli API + storage, claude_code) + the C-D0 design note.

## Decision

**Adopt option C — Hybrid gateway.** Keep CodeSurf's existing **Node `@codesurf/daemon`** as *the*
gateway both clients speak, and port omnigent's proven gateway **model** into it **additively**:
identity + session ACL, a canonical session registry with parent/root lineage, spawn-tree
visibility, runtime policies, comments/review, async inbox, and a per-user discovery stream.
Use omnigent's **OpenAPI as a design reference** and its **ACL level constants verbatim**
(`read=1, edit=2, manage=3, owner=4`, `__public__`) — not as a replacement API.

Ranked: **C hybrid > B adopt omnigent > A extend Node naively.** (A is subsumed by C; C = A *plus*
omnigent's model, so we don't reinvent ACL/lineage/policy semantics.)

## Why this, in one line

omnigent has the stronger **gateway primitives**; CodeSurf has the stronger **IDE substrate** and
**already-shared client + storage-compat surface**. C takes omnigent's model and CodeSurf's
substrate; B would throw away the latter; A would re-derive the former.

## Why NOT B (adopt omnigent as the substrate) — weighed and declined on evidence

The architect explicitly authorized porting CodeSurf onto omnigent "if best." It was evaluated and
declined on evidence, which is the correct use of that authority:

- **Two TS clients would have to bundle/supervise a Python service.** grok-cli is Bun/TS, the IDE is
  Electron/TS; both already manage a Node daemon (`packages/codesurf-daemon/src/manager.ts:59-63`,
  `client.ts:45-63`). omnigent is Python FastAPI/uvicorn + Python-only SDK
  (`omnigent/pyproject.toml:175-183`, `sdks/README.md:1-15`); its TS web client is hand-ported and
  warns of drift with no cross-language CI gate (`ap-web/README.md:88-104`). Its OpenAPI has `{}`
  response schemas in places (`openapi.json:4627-4632,5801-5806,6034-6039`) — not clean TS codegen.
- **The "normal storage" the architect wants preserved lives in the Node daemon and is absent from
  omnigent.** CodeSurf aggregates external CLI session stores — `~/.claude/transcripts/*.jsonl`
  (resume via `--resume <id>`), `~/.codex/sessions`, `~/.cursor`, `~/.opencode`, `~/.openclaw`
  (`src/main/session-sources.ts:1094-1389`, `session-index.mjs:743-871`). omnigent's native-state
  files only record wrapper launch cwd under `~/.omnigent` (`claude_native_state.py:1-38`) — a
  different, narrower contract. Adopting B means rebuilding this interop boundary around Python.
- **CodeSurf's IDE substrate has no omnigent equivalent and would be rebuilt:** canvas/tile state
  (`src/shared/types.ts:1004-1070`), relay/peer protocol (`packages/codesurf-relay/src/types.ts:30-169`,
  `src/main/mcp/tools/peer-bridge.ts:123-232`), worktree checkpoints (`checkpoints.mjs`).

B is feasible (omnigent runs fully local on SQLite, loopback, single-user header auth —
`omnigent/host/local_server.py:40-80,415-681`, `cli.py:753-785,2833-2857`; no Redis required,
`deploy/README.md:101-122`). It is simply **more cost for less fit** than C.

## What C inherits from each side (coverage map)

**Port FROM omnigent (model, re-implemented in Node):**
- Identity + session ACL — `omnigent/server/auth.py:1-17`, `permissions.py:17-60`,
  `db_models.py:195-233`, `schemas.py:1867-1895`.
- Conversation lineage: parent/root, agent/runner/host ids, model/harness metadata, external
  session id, workspace, branch — `omnigent/entities/conversation.py:25-203`.
- Spawn-tree (`spawn.py:56-83`), async inbox (`async_inbox.py:1-27`), comments
  (`server/routes/comments.py:117-241`), policy engine (runtime ALLOW/DENY/ASK).

**KEEP from CodeSurf (load-bearing, do not disturb):**
- Shared `@codesurf/daemon` HTTP/SSE API + `pid.json`/Bearer handshake used by BOTH clients
  (`packages/codesurf-daemon/src/client.ts`, `bin/codesurfd.mjs:2822-3373`, `manager.ts:99-110`).
- `~/.codesurf` job/timeline formats grok-cli reads directly (`jobs/*.json`, `timelines/*.jsonl` —
  `session-repair.ts:44-200`).
- External-CLI session scanner (the claude-compat storage boundary).
- Canvas/tile model, relay/peer protocol, worktree checkpoints, multi-provider dispatch
  (Claude/Codex/OpenCode/Hermes/Omnigent; Pi is explicitly fail-closed until its
  published harness adapter dependency chain is safe — `chat-jobs.mjs:2808-2822`).

## Compatibility baseline — the stated principle + the discriminating check

**Principle:** on day one, the existing `@codesurf/daemon` HTTP/SSE contract, the `pid.json`/Bearer
handshake, the `~/.codesurf` job/timeline formats, and the external-CLI scanner all keep working
**unchanged**. omnigent's model is layered in **additively** behind them (local-first defaults to the
`local` user, so single-user usage is byte-for-byte unaffected).

**The check that separates "C done right" from "C that is secretly a rewrite":**
> Does any step break that contract *before* it delivers value? If yes, the step is mis-scoped.

## Execution sequencing (keystone first; full 7-PR arc behind it)

The full multi-host/ACL/sharing vision is in scope (architect mandate), delivered as a sequence of
independently shippable, cross-reviewed PRs — **sequencing, not descoping**:

0. **KEYSTONE — Canonical session-id + alias registry** (first daemon PR). CodeSurf has no canonical
   session id; sessions are aggregated from tile/job/provider sources. A grant/lineage must attach
   to a canonical id, with aliases `codesurf-runtime:${tileId}`, `codesurf-job:${jobId}`,
   `provider:${provider}:${sessionId}` → canonical. Independently valuable; prerequisite for ACL,
   sharing, and spawn-tree. **No contract break.**
1. Identity foundation (`local` + `__public__`, all-three auth behind config, `GET /identity/me`).
2. Session registry + owner seeding (lazy `local` owner on existing sessions).
3. Read enforcement (fail-closed list/state) — first deliberate fail-closed change.
4. Write enforcement (edit/manage/owner on mutating routes; don't leak job events).
5. Sharing API + per-user discovery stream (`__public__` read grants enabled — architect §4).
6. Spawn-tree inheritance (parent/root via relay metadata first, typed later).
7. Remote/multi-host (in scope per architect §3) — after local ACLs enforced.
   Comments/review (architect §8) layered alongside once ACLs exist.

Each daemon PR is cross-vendor reviewed (claude_code ⇄ codex). Port omnigent's model as
**native Node helpers + tests** — the architecture ports, the Python code does not.

## 7. The one decision to surface (drives effort more than anything else)

**grok-cli back-compat vs lockstep update.** The architect said either is fine. **Proposed default:
additive / strict back-compat first** — keep the public daemon API + storage formats stable, and
update grok-cli only where a NEW capability (e.g. identity headers, ACL-aware session list) actually
requires it. This keeps both clients green throughout and confines grok-cli changes to opt-in
surfaces. Architect may veto in favor of an upfront lockstep migration.

## Open follow-ups inherited from C-D0 §7 (already decided)
Auth = all three; storage = hybrid (JSON for compat + SQLite for ACL/users/registry, architect's
discretion, no format breakage); scope = remote+local+multiple; public sharing = yes;
comments = yes. Provider-native session import, admins/owner-transfer, and relay typing are
recommended within the sequence above (import-on-share; local owner-recovery first, admins optional;
relay metadatabefore typed fields).

---

## DECISIONS LOCKED (operator sign-off)

1. **Agent templates = INHERIT.** Instances derive from a base template via config merge at spawn (flatten template + overrides -> one launch payload in makeAgent()). NOT runtime delegation to native CLI subagents. Our schema is a superset; per-harness importers read native formats where they exist (Claude Code .claude/agents/*.md); Codex has no persona equivalent -- do not invent one.
2. **Harness-template-primitives explore = run now** (read-only), feeds A-PR2 schema design.
3. **ADR-001 = approve C (Hybrid gateway) + keystone-first (PR-0 = canonical session-id + alias registry).**
   - HARD CONSTRAINT: capability parity with omnigent is the FLOOR, not the ceiling. The port must NOT drop, simplify, or compromise ANY omnigent capability. Match or exceed.
4. **grok-cli posture = back-compat-first, but SOFT.** Prefer stable public API + storage. BUT any time back-compat forces a capability compromise or meaningful added complexity, BREAK the contract and update grok-cli instead -- it is unreleased. Capability always wins over compatibility.

---

## CODEX EXECUTION PATH — RECOMMENDATION (pending operator sign-off)

Three options evaluated for running Codex with per-mode permissions + worktree isolation:

- **A. Native `codex exec` CLI** (current A-PR1 baseline): honors all 4 modes (sandbox+approval), and uniquely passes `--ignore-user-config` (blocks global Codex config/MCP/plugins from leaking into app runs). No daemon worktree isolation. Ships today.
- **B. Fork `@ai-sdk/harness-codex`** (the patch/build/copy plan): feasible (Apache-2.0, ~7 files) BUT the SDK eval shows the harness is just a wrapper around `@openai/codex-sdk` — canary fork drift, an adapter that shims around a Codex-SDK MCP bug, high maintenance. Forking it = owning a worse copy of the SDK we can use directly.
- **C. Official `@openai/codex-sdk`** (Apache-2.0, v0.139.0 — this IS the "Codex Agent SDK"): natively exposes ApprovalMode + SandboxMode matching all 4 CodeSurf modes; typed native events; low-medium maintenance (official). Worktree isolation not native but easy to compose with CodeSurf's OWN harness-worktree.mjs via workingDirectory. Gaps: no `--ignore-user-config` equivalent in the published type surface (config-isolation gap); no first-class systemPrompt/tools (persona via prompt preamble + fail-closed tools, same as A).

**DECISION: A (baseline, now) + adopt C as the first-class Codex Agent SDK provider; DROP B (the fork).**
- C is the official "Codex Agent SDK support" the operator asked for, and the long-term first-class path beside the Claude Agent SDK provider.
- B dropped: the official SDK obviates the harness fork; forking the wrapper is strictly worse.
- A stays as the safe fallback until C closes the config-isolation gap (SDK gains an ignore-user-config option, or keep a CLI fallback for that).
- Worktree isolation for Codex comes from composing C with CodeSurf's existing worktree wrapper, NOT from the harness.
