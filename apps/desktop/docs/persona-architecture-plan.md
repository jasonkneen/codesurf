# Persona Architecture — Build Plan ("Full Omni")

Status: DRAFT for review · Owner: polly (orchestrator) · Decision date: 2026-06-15

## 1. Vision

**Persona** becomes CodeSurf's first-class composition root. One name binds, in a single
persisted entity:

- **Identity** — name, "soul" (system prompt), description, icon, color
- **Skills** — the skill set funneled to whichever engine runs
- **Tools + permission posture** — authoritative, fail-closed (inherited from PR #8)
- **An optional inherited agent template** — `extends` a detected/local agent file
- **One or many engines/models** — and, in Full Omni, routes between them
- **Workflows / process / hooks** — the steps a Persona can run

**"Agents"** demote to *detected raw material*: definitions discovered from folders
(`.claude/agents`, `.cursor/agents`, `.opencode/agents`, …). They are templates, not the
driver. **Engines** (Claude / Codex / Hermes / pi) become interchangeable execution targets.

**Full Omni (the committed target):** a single Persona performs **intra-conversation
routing** — different steps of one conversation can run on different engines/models —
while presenting **one consistent transcript** and enforcing **one authoritative
permission posture**.

## 2. Terminology

| Term | Meaning |
|------|---------|
| **Persona** (ours) | First-class, persisted composition root. The driver. |
| **Agent** (theirs / detected) | A definition discovered from a folder; raw template material a Persona may `extends`. |
| **Engine** | A CLI/model execution target: Claude, Codex, Hermes, pi. |

## 3. Current foundation (verified, with anchors)

What already exists (from read-only investigations this session):

- **`AgentMode` + authoritative main resolver** — `src/main/chat/agent-mode-resolver.ts`;
  `chat:send` re-resolves from trusted `.codesurf/customisation/agents.json`, overrides the
  renderer, fails closed. (PR #8) Injected into all engines via
  `src/main/chat/providers/agent-mode-payloads.ts`.
- **Folder-scan discovery (ephemeral)** — Customisation tile scans `~/.claude/agents`,
  `$WS/.claude/agents`, `.cursor/agents`, `.opencode/agents`, `~/.config/opencode/agents`,
  `.continue/agents`; editable list at `.codesurf/customisation/locations-agents.json`;
  parses `.json`→`Partial<AgentMode>`, `.md`/`.txt`→systemPrompt+frontmatter. `discovered-*`
  entries are filtered from persistence. (`CustomisationTile.tsx:328,1104,1152,1157`)
- **Uniform model plumbing** — `model`/`provider` are scalars on `ChatRequest`
  (`src/main/chat/types.ts:51`), consumed identically: Claude `Options.model`, Codex
  `--model`, Hermes `--model/--provider`. No per-persona/multi-model concept today.
- **Shared stream contract, provider-local synthesis** — `sendStream`→`agent:stream`→
  `useChatStreamHandler`→`chatStreamReducer`→shared `ChatMessage`/`ToolBlock`. Each provider
  hand-synthesizes events differently (leak #4).
- **Skills** — `skillsPrompt` reaches Claude + Codex; **Hermes drops it** (leak #3).
- **Tool fidelity drift** — Claude gets the exact tool list; Codex coarsens to
  sandbox/approval flags (refuses deny-all); Hermes maps to coarse toolsets (leaks #1–2).
- **Process prior art** — `KanbanCard` already bundles `agent + model + skillsAndCommands +
  hooks` into a launchable unit (`KanbanCard.tsx:28`). A proto-Persona to learn from / unify.

## 4. Phases & PR boundaries

> Every PR: isolated worktree, green test/lint/typecheck gates, **cross-vendor** review,
> its own PR, **human merges**. polly never merges.

### P0 — Gate (human)
Merge **PR #10** (Codex SDK provider) and **PR #11** (composer 1+2). All branches below cut
from the resulting `origin/main`.

### P1 — Persona spine
- Rename `AgentMode → Persona` (types, UI labels, resolver) — keep "agent/engine" for CLIs.
- **Schema designed for N engines/models**, single-model resolution implemented first
  (the field exists day one to avoid a later schema churn).
- Resolver populates `req.provider/req.model` from the Persona; composer stays a per-session
  override.
- `extends` inheritance.
- Persist (graduate from ephemeral).
- Seed **Polly** and **Gemma** as built-in Personas.
- _Est: 1–2 PRs._

### P1b — Model binding (RESOLVED 2026-06-15)

**Model is dissociated from Persona identity.** A Persona defines identity/soul/skills/tools;
the engine+model is a separate, swappable axis. Any Persona (Polly, Gemma) runs on any
engine/model with full Omni consistency intact, because identity/skills/tools/presentation are
model-independent.

**Locking lives in skills, not Personas.** A Persona may *softly prefer* an engine/model (seeds
the composer; user can change). The only **non-overridable** model constraint comes from a
**skill** the Persona links/defines that *requires* specific model(s): while that skill is
active, the composer model control is pinned + disabled. (Chosen over a Persona-level hard pin
to keep a single locking mechanism; a Persona-level lock can be added later, additively.)

**Precedence (highest wins):**

| # | Source | Overridable? |
|---|--------|--------------|
| 1 | Skill-required model (active linked skill) | ❌ locked while skill active |
| 2 | Persona soft default (preferred engine/model) | ✅ seeds composer |
| 3 | Composer / user pick | ✅ free choice (the dissociated default) |

**Altitude:** model is **not** a security boundary — running a different model is not privilege
escalation. The lock is a correctness/UX constraint enforced in normal resolution + composer UI
disablement. It does **NOT** use the PR #8 trusted-disk authoritative machinery (that stays
exclusively for tools/permissions, which remain fully fail-closed).

**Split:**
- **P1b-1 (ready now):** dissociation + Persona soft engine/model default + precedence-aware
  resolution (skill-lock slot *designed*, layers 2–3 *implemented*). Ships "Polly on GPT-5.5."
- **P1b-2 (advisor-gated):** skill-defined required-model + Persona↔skill linkage applies the
  lock + composer disablement. Touches the skills subsystem.

### P2 — Detected agents as templates
- Promote the existing ephemeral folder-scan into a first-class **"Agents (detected)"**
  surface; opt-in persistence.
- A Persona may `extends` a detected or local agent file (reuse the existing import parser).
- _Est: 1 PR._

### P3 — Unifier hardening (prerequisite for P4)
- **B1 — Hermes skills drop**: pass `skillsPrompt` to Hermes. Quick capability fix; may pull
  into P1.
- **B2 — Centralize outbound presentation normalization**: one canonical adapter contract
  feeding the shared `ChatMessage`/`ToolBlock` model, replacing per-provider synthesis.
  **Hard prerequisite for P4** (can't render a coherent multi-engine transcript otherwise).
- **B3 — Unified tool-semantics across engines**: design-first spike (each CLI's sandbox
  model differs), then implementation.
- _Est: 2–3 PRs._

### P4 — Full Omni routing
- Per-step engine/model selection within one conversation; routing policy expressed on the
  Persona.
- **Depends on B2.** Likely **depends on / co-designs with keystone PR-0** (daemon canonical
  session registry) for multi-engine session continuity mid-conversation.
- Optional: converge `KanbanCard`'s launch-bundle with Persona into one concept.
- _Est: multi-PR._

## 5. Dependency order

```
P0  →  P1  →  P2
            ↘  P3 (B1, B2, B3)  →  P4   [P4 also needs/links keystone PR-0]
```

- B2 **before** P4 (non-negotiable).
- P1 schema must carry the N-engine shape up front.
- Nothing starts before P0.

## 6. Cross-cutting invariants (must not regress)

1. **PR #8 fail-closed authority holds** for every engine and **every routing step**. Per-step
   routing must re-resolve the Persona's tools/permission authoritatively — routing must never
   become a permission bypass.
2. Absence of `agents.json` lets built-ins resolve; present-but-corrupt fails closed.
3. Each engine still receives the same persona definition; fidelity gaps (B1/B3) are closed,
   not papered over.

## 7. Open design questions (resolve per-phase, not now)

- ~~**Model field shape**~~ → RESOLVED (P1b): Persona carries a *soft* engine/model default
  (single preferred binding, schema shaped for N); per-skill `requiredModel` supplies locks.
  Not a per-engine map.
- **Routing policy authoring** (P4 scope still open): per-skill required-model is the locking
  surface; the broader "Codex for narrow edits, Claude for multi-file" routing policy is still
  undecided (Persona-level rules vs per-skill vs LLM router).
- **Canonical event schema** for B2 (target is the existing `ChatMessage`/`ToolBlock` model).
- **Kanban ↔ Persona convergence**: unify or keep separate?
- **Multi-engine session continuity**: how threads resume across engines mid-conversation
  (ties to keystone PR-0).

## 8. Track: CLI ↔ daemon — the Terminal tab as a CLI front-end

**Intent:** the Chat/Terminal toggle (PR #11) swaps two front-ends over the SAME daemon —
Chat tab (GUI) and Terminal tab running the CodeSurf CLI. Today the Terminal tab spawns a
plain shell; the CLI is not a chat client.

**Findings (read-only explore, with anchors):**
- **No chat CLI exists.** `codesurf` (`bin/codesurf.cjs`) only launches the Electron app +
  perms/update/cache helpers; `codesurfd` (`bin/codesurfd.mjs`) is a daemon launcher. There
  is no `codesurf chat` / TUI client entry point.
- **The daemon client API exists and is clean** — loopback HTTP on `127.0.0.1` + bearer
  token + SSE; pid-file discovery (`pid`/`port`/`token`); `POST /chat/job/start`,
  `GET /chat/job/state`, `GET /chat/job/events` (SSE), job-scoped permission/cancel.
  `request.sessionId` carries continuity and provider adapters resume from it. The GUI
  already drives this exact API.
- **The embedded Terminal** spawns the default shell (no `launchBin`). `TerminalTile`
  supports `launchBin`/`launchArgs` but **not env**; the terminal IPC allowlist is
  {claude, codex, aider, opencode, openclaw, hermes} — `codesurf` is not allowed.
- **Shared session is not possible today** — streaming/permission/cancel are job- and
  card-scoped; two clients using the same `sessionId` get separate jobs/timelines that do
  not merge.

**Phases:**
- **CX0 — Chat-capable CLI** (fork-independent foundation): a thin client over the existing
  daemon HTTP/SSE API (start job, stream events, answer permissions, resume by `sessionId`).
  New bin or `codesurf chat` subcommand.
- **CX1 — Terminal-tab launch wiring** (separate-session works after this): `ChatTile`
  passes `launchBin` + args; ADD a terminal **env** path through preload/main (daemon
  url/token/sessionId); allowlist the CLI bin.
- **CX2 = keystone PR-0 — canonical session registry** (shared session): session-keyed
  attach/stream/send routes; event fan-out + transcript merge by `sessionId`; shared
  permission/cancel semantics across GUI + CLI clients.

**Decision fork:** **separate-session** = CX0+CX1 (cheaper; the CLI runs its own
conversation in the terminal) vs **shared-session** = CX0+CX1+PR-0 (the real toggle: one
conversation, two live views).

**Security note:** passing the daemon bearer token + sessionId into a terminal env exposes
the token in the terminal's environment / process list. Use a scoped or short-lived session
token, not the raw daemon token.

**Convergence:** **PR-0 is the shared keystone for both the CLI shared-terminal (CX2) and
Full Omni intra-conversation routing (P4).** Building it once unlocks both — strong reason to
prioritise it.
