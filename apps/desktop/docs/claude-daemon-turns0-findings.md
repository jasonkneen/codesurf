# Claude daemon turn produces ZERO output (turns:0 / cost:0) — root cause

**Status:** READ-ONLY investigation. No code changed.
**Failing job:** `0e5442b5-79dd-4875-a2d9-892f899bc20a` — provider=claude, model=claude-opus-4-7, prompt='hello', card=`codesurf-9881abe85fe8`, sessionId=`019ecd2c-8c24-7580-b8eb-32225463459a`, status=completed, error=null, turns:0, cost:0.

## Verdict (one line)

The Claude turn was submitted with a **codex/gpt-5.5 thread id** as its `resume` session id. The Claude Agent SDK was asked to resume a session that has **no transcript on disk**, so it returned a clean `result` message with `num_turns:0` / `total_cost_usd:0` and **no assistant content**. This is cross-provider session-id contamination, not context-loss and not an invocation error.

## The precise execution path for a daemon Claude turn

1. grok-cli's `CodesurfDesktopSession.runTurn` builds the request. It needs a `sessionId` for continuity and, because `this.sessionId` is null on a fresh provider session, calls `readDaemonSessionId(...)`.
   `codesurf-desktop-provider.ts:590` → `:881`.
2. `readDaemonSessionId` returns `findLatestDaemonSessionIdForCard(home, this.cardId, cwd)`.
   `codesurf-desktop-provider.ts:887`.
3. `findLatestDaemonSessionIdForCard` returns the **most-recent job record for this card** whose predicate matches on **cardId + workspaceDir only — it never checks `job.provider`**.
   `src/daemon/session-repair.ts:107-112` (records pre-sorted `newerFirst`, `session-repair.ts:96`).
4. The request is POSTed to the daemon with `sessionId: <that id>`.
   `codesurf-desktop-provider.ts:602`.
5. Daemon `runClaudeJob` emits the synthetic `codesurf-memory-context` tool events **before** the SDK runs (`chat-jobs.mjs:2384-2403`), then constructs SDK options including:
   `...(request.sessionId ? { resume: request.sessionId } : {})` — **`chat-jobs.mjs:1354`**.
6. The user prompt is passed correctly and separately: `claudeQuery({ prompt: lastUserMsg.content, options })` — `chat-jobs.mjs:1383`. (The memory context goes into `options.agents.contex.prompt` at `:1370-1380`, it does **not** overwrite the user prompt.)
7. The SDK resumes a session whose transcript file does not exist → it iterates the async generator, yields **only** a `result` message (`num_turns:0`, `total_cost_usd:0`, `session_id` echoed back = the resume id) and no `assistant`/`stream_event` messages.
8. The loop records the `session` event (`chat-jobs.mjs:1390`) and the `done` event from the result (`chat-jobs.mjs:1441-1449`). Timeline ends with `done {cost:0, turns:0}` and **zero `text` events**.

The user-visible "Tell me more"/empty reply is the client's empty-state fallback: with zero text events streamed, the chat tile has no assistant content to render and shows the placeholder, while the injected `Workspace Instructions` chrome (from the pre-query memory-context events) is still displayed.

## The exact drop / short-circuit point

**`packages/codesurf-daemon/bin/chat-jobs.mjs:1354`** — `resume: request.sessionId` is set unconditionally whenever a session id is present, with **no validation that the id belongs to a Claude session** (no provenance check, no "does this transcript exist" check). Feeding a foreign id makes the SDK return a 0-turn result.

The id is *produced* upstream at **`grok-cli/src/daemon/session-repair.ts:107-112`** (`findLatestDaemonSessionIdForCard`), whose `find` predicate omits `job.provider`.

## Evidence that nails it

- **Smoking-gun job history for the failing card** (`codesurf-9881abe85fe8`):
  ```
  21:25 codex  gpt-5.5          sid=019ecd2c…  (v7)
  21:30 codex  gpt-5.5          sid=019ecd2c…
  21:30 codex  gpt-5.5          sid=019ecd2c…
  22:01 codex  gpt-5.5          sid=019ecd2c…
  00:22 codex  gpt-5.5          sid=019ecd2c…
  00:23 codex  gpt-5.5          sid=019ecd2c…
  00:25 claude claude-opus-4-7  sid=019ecd2c…   ← the failing turn inherited the codex thread id
  ```
  Six prior codex turns minted thread `019ecd2c`; the Claude turn picked it up as the card's "latest session".
- **UUID version proves the id is foreign.** `019ecd2c-8c24-7580-…` is **UUID v7** (version nibble `7`), the codex/omnigent thread-id format. **Every** successful Claude job in `~/.codesurf/jobs` carries a **UUID v4** session id (e.g. `c92228fd`, `619885f0`, `074dff52`…). The Claude SDK only mints v4 and only echoes back a v7 if it was handed one via `resume`.
- **No transcript exists for the foreign id.** `find ~/.claude/projects -name '019ecd2c*'` → **0 files**. A working v4 id (`c92228fd`) → **1 file**.
- **The model is innocent.** Job `e26128db` — same model `claude-opus-4-7`, same prompt `hello`, same `codesurf-*` card class — produced `turns:1, cost:0.03`, 5 text events, a real reply. Its session id `c92228fd` is a real v4 Claude session. So `claude-opus-4-7` resolves fine and is **not** the cause (hypothesis #4 rejected).
- **The prompt is not dropped by the memory injection.** The `codesurf-memory-context` tool events (timeline seq 1–3) are synthetic UI events emitted at `chat-jobs.mjs:2384-2403` *before* `claudeQuery` runs; `prompt: lastUserMsg.content` carries 'hello' correctly (hypothesis #1 rejected).

### Structural diff vs a SUCCESSFUL Claude turn
| | Failing `0e5442b5` | Working `e26128db` (and `a139f1ff`, etc.) |
|---|---|---|
| session id | `019ecd2c…` **v7 (codex thread)** | `c92228fd…` **v4 (Claude session)** |
| transcript on disk | none | exists |
| `result.num_turns` | **0** | 1 (36 for a139f1ff) |
| `result.total_cost_usd` | **0** | 0.03 (4.24) |
| assistant/text events | **0** | 5 (many) |
| how the id arose | inherited from prior codex turns on the card | created fresh by Claude SDK and resumed thereafter |

## Corpus scan (all 222 jobs) — the reported symptom is a singleton

Scanning every Claude job's `done` event for `turns:0` and classifying the session id by UUID version + transcript existence:

| job | model | prompt | uuid | transcript | note |
|---|---|---|---|---|---|
| `0e5442b5` | opus-4-7 | **`hello`** (real user turn) | **v7** | MISSING | **the reported bug** — codex thread id resumed |
| `0397ece2` | opus-4-8 | `<local-command-caveat>…` | v4 | MISSING | slash/local-command message |
| `9988a71a` | opus-4-8 | `<local-command-caveat>…` | v4 | MISSING | slash/local-command message |
| `ca8b3c9d` | opus-4-7 | `<local-command-caveat>…` | v4 | MISSING | slash/local-command message |

Only **4 of 222** Claude jobs are `turns:0`. Three carry a `<local-command-caveat>` prompt — the wrapper Claude Code uses for **local slash-command** invocations, each the only job on its card (a first turn, so no resume id was even available). Those are a **different, plausibly-benign category** (a local command that does not drive a model turn), **not** the reported symptom. After excluding them, the reported symptom — a real user prompt returning an empty reply — is a **single job, `0e5442b5`**, and there is no competing explanation for it in the corpus.

Note: "missing transcript" is a *consequence* of `turns:0` (a turn that runs zero turns never writes a transcript), so it appears in all four. The distinguishing cause for `0e5442b5` is the **v7 resume id**, which the Claude SDK can never mint — it can only have entered via `resume`.

## Root-cause hypotheses, ranked by evidence

1. **(CONFIRMED) Cross-provider resume contamination.** The card had six prior codex turns minting thread `019ecd2c`; the Claude provider picked up that codex **v7** thread id via the provider-agnostic `findLatestDaemonSessionIdForCard`, the daemon passed it as `resume`, and the SDK resumed a session with no transcript → turns:0. The *id-pickup* is proven directly from disk (job history + provider-blind predicate). The *consequence* (foreign resume → 0 turns, no content) is established because the SDK ran its generator to completion and emitted a single `result` echoing a **v7 id it cannot have generated** — so the id was its `resume` input, and resuming it yielded zero turns. Corpus scan finds no real-prompt counterexample.
2. (Rejected) Memory-context injection overwrites the user prompt — the prompt is passed independently (`:1383`); injection is system-prompt + pre-query synthetic events.
3. (Rejected) Stream opened and closed without iterating assistant messages due to an unrelated early-return — the generator *was* iterated; it simply contained only a `result` message because the resume short-circuited the agent loop.
4. (Rejected) `claude-opus-4-7` silently no-ops — the same model+prompt succeeds on another card.

## Minimal fix location (no code written)

The cleanest single-point fix is **provenance-gating the resume id**. Two candidate sites, fix at one (provider-side preferred, daemon-side is the safety net):

- **Provider side (preferred):** `grok-cli/src/daemon/session-repair.ts:107-112` — add `job.provider === <downstream>` to the `findLatestDaemonSessionIdForCard` predicate (thread the provider in from `readDaemonSessionId`, which already has `decoded.downstream`). A session id should only be reused for the **same** downstream provider that created it. Note `splitGroupKey` (`session-repair.ts:118`) already treats provider as part of session identity — this lookup is the inconsistent one.
- **Daemon side (defense in depth):** `packages/codesurf-daemon/bin/chat-jobs.mjs:1354` — only set `resume` when the id maps to an existing Claude transcript / is a v4 id the Claude SDK could own; otherwise start fresh. Prevents *any* foreign id (future providers included) from zeroing out a Claude turn.

A v4-format guard alone is a cheap stopgap, but provider-tagging the session lookup is the correct fix because it also prevents the symmetric failure (a Claude v4 id being handed to a codex/omnigent resume).
