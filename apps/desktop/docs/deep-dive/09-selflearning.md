# Self-Learning, Self-Adapting & Auto-Skill Generation

This dimension covers how the system carries learning forward across sessions, adapts agent behaviour from accumulated experience, and turns recurring activity into reusable skills. The codebase has one real self-learning mechanism — the **dreaming** consolidation pass, which periodically summarizes recent session activity into `.codesurf/DREAMING.md` — plus a **skills** subsystem that discovers, installs, and injects pre-authored skills. The headline gap is that the loop is self-*summarizing* but not self-*adapting*: there is no auto-skill generation, discovered skills never reach the model without manual toggling, dreamed memory is stripped from cloud runs, dreaming ignores the strongest failure/success signals the system already records, the learning trigger fails silently and is hard-coupled to Claude credentials, and the entire engine ships as two byte-identical copies (one of them dead).

## Findings

| ID | Title | Severity | Effort | Files |
|----|-------|----------|--------|-------|
| sl-01 | No auto-skill generation: the system only discovers/installs/loads existing skills, never creates new ones | medium | L | `packages/codesurf-daemon/bin/skills-index.mjs`, `src/main/ipc/skills.ts`, `src/renderer/src/components/CustomisationTile.tsx` |
| sl-02 | Discovered skills are never surfaced to the model unless the user manually toggles them on | medium | M | `packages/codesurf-daemon/bin/skills-index.mjs`, `src/main/ipc/chat.ts` |
| sl-03 | All dreaming-generated memory is silently stripped from cloud/remote execution | medium | M | `packages/codesurf-daemon/bin/memory-loader.mjs`, `packages/codesurf-daemon/bin/context-buckets.mjs` |
| sl-04 | No reinforcement signal: dreaming ignores checkpoint-restores, tool errors, and permission denials | medium | M | `packages/codesurf-daemon/vendor/dreaming.mjs`, `packages/codesurf-daemon/bin/chat-jobs.mjs` |
| sl-05 | The learning trigger fails silently and is hard-coupled to Claude credentials | medium | M | `packages/codesurf-daemon/vendor/dreaming.mjs`, `packages/codesurf-daemon/bin/codesurfd.mjs` |
| sl-06 | Dead duplicate of the entire dreaming engine (package vs daemon vendor copy) | low | S | `packages/codesurf-dreaming/src/index.mjs`, `packages/codesurf-daemon/vendor/dreaming.mjs`, `packages/codesurf-daemon/bin/codesurfd.mjs` |

---

### sl-01 — No auto-skill generation: the system only discovers/installs/loads existing skills, never creates new ones

**Severity:** medium · **Effort:** L · **Type:** factual

**Problem.** The dimension is named "Auto-Skill Generation," but no code path generates a skill from observed session activity. Every skill that enters the index comes from exactly three sources:

1. **Disk scan** of skill directories — `scanSkillDirectory` in `packages/codesurf-daemon/bin/skills-index.mjs:235-269`.
2. **Extraction** of a user-supplied `.skill` zip — `extractSkillArchive` (`skills-index.mjs:389-404`) / `extractSkill` (`src/main/ipc/skills.ts:147-167`).
3. **User-authored JSON** in `.codesurf/customisation/skills.json` — `loadSavedCustomSkills` (`skills-index.mjs:193-218`), written by the `CustomisationTile` skills editor (`src/renderer/src/components/CustomisationTile.tsx:501-560`).

There is no consolidation-to-skill pass analogous to dreaming. The dreaming pass writes prose memory (`DREAMING.md`) but is explicitly told **not** to produce reusable procedures — `'You are not writing user instructions; you are writing generated project memory.'` (`packages/codesurf-daemon/vendor/dreaming.mjs:292`). So recurring successful workflows are never distilled into invokable skills; the "auto-skill" leg of the self-learning system simply does not exist.

**Evidence.** A repo-wide grep across `src/main`, `src/renderer`, and `packages/codesurf-daemon` for skill-creation paths returns only `installSkill` (`skills-index.mjs:523`, which requires a pre-built `zipPath`), `extractSkillArchive` (`skills-index.mjs:389-404`), and `collab:writeSkills` (`src/main/ipc/collab.ts:414` — a selection enabled/disabled *toggle* writer, not a generator). There is no write-of-new-skill function. `.codesurf/skills/` is auto-scanned with `rootKind: 'codesurf'` (`skills-index.mjs:442-446`).

**Recommendation.** Add an optional dream-style consolidation pass that reuses the existing `runClaudeDream` + `writeTextAtomic` machinery (`packages/codesurf-dreaming/src/index.mjs:321` and `:45`; the engine already consumes `sessionBundles` and writes `.codesurf/DREAMING.md`) to emit candidate `<name>/SKILL.md` files. Prompt it to detect recurring tool sequences / repeated user corrections across the same session bundle dreaming already loads, and write a skill **only** when a stable, repeated procedure is evidenced. Gate behind a config flag and mark generated skills with provenance frontmatter (source run id).

There is a design fork you must resolve explicitly — the original "zero new plumbing AND a review gate" framing is self-contradictory:

- **(A) Zero-plumbing:** write straight into `.codesurf/skills/` and accept that generated skills are **auto-eligible immediately** (no human review). That directory is scanned by `scanSkillDirectory` with `rootKind: 'codesurf'` (`skills-index.mjs:434, 442-446`), so anything written there is picked up on the next index and offered to agents with no review. Lowest effort (S/M).
- **(B) Review gate:** write to a **separate** directory (e.g. `.codesurf/generated-skills/`) and add real new plumbing — a `generated` `rootKind` branch in `collectIndex`/`scanSkillDirectory`, a promote action that moves the skill into `.codesurf/skills/`, and exclusion from the selection/injection system (`buildSkillSelectionPrompt`) until promoted. This is the L-effort path.

Pick one — you cannot have both simultaneously.

**Verifier critique.** All three sourcing claims are verified. Skills enter the index only via (a) disk scan `scanSkillDirectory` (`skills-index.mjs:235-269`), (b) zip extraction `extractSkillArchive`/`installSkill` (`389-404, 523-556`) and IPC `extractSkill` (`skills.ts:147-167`), and (c) user-authored JSON via `loadSavedCustomSkills` (`193-218`) written by `CustomisationTile` (`501-560`). A repo-wide grep returns only `collab:writeSkills` (a toggle writer) and install/extract/scan — no generator. The dreaming-prompt citation is correct in substance; the "generated project memory" text is at line 292 of `packages/codesurf-dreaming/src/index.mjs` (and the bundled copy at `packages/codesurf-daemon/vendor/dreaming.mjs:292`). `runClaudeDream` (321) and `writeTextAtomic` (45) exist as described. **Severity lowered high→medium:** this is a missing enhancement, not a defect — the prompt at line 292 deliberately forbids procedure output (the finding concedes this), and a self-learning mechanism (dreaming) already exists, so the dimension is not absent, only the invokable-skills implementation is. Nothing is broken; the system does what it was built to do. The recommendation was also adjusted to force the explicit zero-plumbing-vs-gated design choice.

---

### sl-02 — Discovered skills are never surfaced to the model unless the user manually toggles them on

**Severity:** medium · **Effort:** M · **Type:** factual

**Problem.** `buildSkillSelectionPrompt` builds the injected `## Included Skills` block by iterating `selection.enabledIds` only (`packages/codesurf-daemon/bin/skills-index.mjs:300`). Those `enabledIds` come exclusively from `.contex/<cardId>/skills.json` via `readTileSkillSelection` (`skills-index.mjs:271-290`). A skill that was discovered on disk but is not in that per-tile enabled list is **never** put in front of the model — not even as a one-line name/description catalogue. The full index is returned to the renderer for a UI browser, but the LLM only ever sees the manually-enabled subset. The chat path (`src/main/ipc/chat.ts:3727-3733`) forwards only `selection.prompt`. Net effect: the "discovery" half of the learn→adapt loop has no behavioral effect on the agent unless a human pre-selects. The agent cannot adapt by choosing a relevant skill it has never been shown.

**Evidence.** `skills-index.mjs:300` `for (const id of enabledIds)` is the only population loop; an empty resolution returns `prompt: undefined` (`309-318`). `chat.ts` `buildSelectedSkillsPrompt` (`1210-1212`) reads `index?.selection?.prompt`, which is empty when nothing is enabled. The full `skills` array **is** fetched into `skillsContext` (`chat.ts:3729-3731`) and the daemon-side `skillIndex` (`packages/codesurf-daemon/bin/codesurfd.mjs:3219`) but is dropped — only `.selection.prompt` is consumed. A grep confirms there is no agent-callable skill discovery/load/search tool (no `skill_load`/`load_skill`/`get_skill`/`search_skill` in `src/` or `packages/`, and no `skill` MCP tool in `mcp-server.ts`); the daemon's `getSkill` (`skills-index.mjs:508`) is internal RPC only.

**Recommendation.** Inject a compact name+description catalogue of **all** discovered skills (not just enabled) as a low-token "available skills" menu, or add a per-turn relevance pre-selection (keyword/embedding match of the user message against skill descriptions). Cleanest implementation: in `buildSkillSelectionPrompt` (`skills-index.mjs:292`), which already receives the full `skills` array, add an `availableSummary` field to the returned `selection` object built from all skills (name + scope + description), distinct from `prompt`. Then in `chat.ts` add a sibling to `buildSelectedSkillsPrompt` (e.g. `buildAvailableSkillsCatalogue` at ~`1210`) reading `index?.selection?.availableSummary`, and thread it into `requestWithContext` (`3743-3748`) and system-prompt assembly (`buildClaudeAgentPrompt` `1909` / `buildCodexPrompt` `2659`) the same way `skillsPrompt` is. No new I/O is needed — the full index is already in hand. **Also patch the daemon-side fallback at `codesurfd.mjs:3217-3235`**, which independently re-derives `skillsPrompt` from `selection.prompt`; otherwise remote/daemon-owned jobs will still see only the enabled subset. Optionally pair with an agent-callable skill-load tool (promote the daemon's internal `getSkill` at `skills-index.mjs:508`) so the model can pull full content for a catalogue entry it selects.

**Verifier critique.** All cited locations verified against source; the data flow is exactly as described. Confirmed `alreadyAddressed=false` — no agent-callable skill discovery/load tool exists, so the agent genuinely cannot adapt by choosing a skill it was never shown, without prior human toggling via the renderer's `writeSkills` UI. The recommendation is practical and well-scoped (the full skills array is already at the exact functions that need to change). Two adjustments: (1) the daemon-side fallback at `codesurfd.mjs:3217-3235` is a second injection site the original evidence missed and must also be patched; (2) **severity adjusted high→medium** — this is a real degradation of autonomous adaptation, but the system is deliberately built around human-curated per-tile selection (renderer toggle UI, enabled/disabled model), discovery still works for the human-facing browser, and core chat function is unaffected. It blunts agent self-adaptation rather than breaking the product.

---

### sl-03 — All dreaming-generated memory is silently stripped from cloud/remote execution

**Severity:** medium · **Effort:** M · **Type:** factual

**Problem.** `.codesurf/DREAMING.md` is classified `bucket: 'local-only'` (`packages/codesurf-daemon/bin/memory-loader.mjs:185-187`). `getIncludedContextBuckets('cloud')` returns `['remote-safe']` only (`packages/codesurf-daemon/bin/context-buckets.mjs:3-7`), and `loadMemoryContext` filters `sections` by the included bucket before building the prompt (`memory-loader.mjs:28`). Therefore every learning the dreaming pass consolidates is dropped on any cloud/remote-daemon run — the exact mode where carried-forward context matters most, since a fresh remote machine has no other state. The self-learning loop closes for local execution and silently opens for cloud. This is by-design for the privacy of user-global instructions, but `DREAMING.md` is generated project memory grounded only in that project's sessions, so the blanket `local-only` classification is over-broad.

**Evidence.** `test/daemon/dreaming.test.mjs:85` explicitly asserts *"memory loader includes workspace DREAMING.md for local execution but excludes it from cloud bundles"* — confirming the exclusion is intended and tested, not a bug, but it means generated memory never reaches remote runs. `EXPLICIT_CONTEXT_BUCKETS` (`context-buckets.mjs:1`) is frozen to `['local-only', 'remote-safe']` with no third "generated" tier.

**Recommendation.** Either (a) introduce a third bucket / per-file policy so generated `DREAMING.md` can be marked remote-safe when it contains no local-only imports, behind a redaction pass; or (b) make the bucket of generated memory configurable. Either way, surface to the user that cloud runs do not see dreamed memory so the silent gap is at least visible. Tie this to `project-context.mjs`'s existing cloud-boundary policy rather than inventing a parallel one.

*No separate verifier critique was recorded for this finding.*

---

### sl-04 — No reinforcement signal: dreaming ignores checkpoint-restores, tool errors, and permission denials

**Severity:** medium · **Effort:** M · **Type:** judgment

**Problem.** Dreaming's only input substrate is raw message text: `summarizeSessionMessages` filters to user/assistant/system roles and truncates the last 6 messages (`packages/codesurf-daemon/vendor/dreaming.mjs:134-149`). The strongest learning signals the system already records are never fed in:

1. **Checkpoint *restores*** — a restore is an explicit human-or-agent "that edit was wrong" marker stored in daemon checkpoint metadata.
2. **Tool execution errors.**
3. **Tool permission denials.**

Because none of these reach the dreaming prompt (`buildDreamUserPrompt`, `dreaming.mjs:248-286`), the consolidated memory has no concept of failure-avoidance or reinforcement of successful patterns. The loop accumulates *descriptive* memory ("what the project is") but never *corrective/adaptive* memory ("what not to do here," "the pattern that worked"). This is the difference between a notebook and a feedback loop, and it is why the system is self-summarizing but not self-adapting.

**Evidence.** `buildDreamInputs` (`dreaming.mjs:378-424`) loads `listSessions` + `getSessionState` (messages) + `loadMemoryContext` + the existing `DREAMING.md` only. There is no reference to checkpoints, tool errors, or permission grants. Checkpoint metadata exists (`docs/daemon-memory-and-checkpoints.md:247-255`, "last restored checkpoint id/time") but is not passed to dreaming.

**Recommendation.** Extend `buildDreamInputs` to pull per-session checkpoint-restore events and tool-error/denial counts (already available via the daemon checkpoint store and job timelines) and add a "Corrections & Failures" section to `buildDreamUserPrompt`, instructing the model to record durable "avoid X / prefer Y" rules. This converts dreaming from pure summarization into a true reinforcement pass using signals the system already captures.

*No separate verifier critique was recorded for this finding.*

---

### sl-05 — The learning trigger fails silently and is hard-coupled to Claude credentials

**Severity:** medium · **Effort:** M · **Type:** factual

**Problem.** Every entry point that drives the learning loop swallows errors:

- The debounced auto-eval — `void evaluateAutoDream(args).catch(() => {})` (`packages/codesurf-daemon/vendor/dreaming.mjs:719`).
- The periodic sweep — `runAutoSweepOnce().catch(() => {})` (`dreaming.mjs:793`, and per-workspace `775`).
- Orphan reconciliation — `reconcileOrphanRuns(...).catch(() => {})` (`dreaming.mjs:523`).
- The codesurfd scheduler wrapper — empty try/catch (`packages/codesurf-daemon/bin/codesurfd.mjs:2437-2449`).

Separately, dreaming is hard Claude-only: `runDream` throws for any non-claude provider (`dreaming.mjs:545-547`), and `runClaudeDream` always calls the Claude Agent SDK `query()` (`328`) regardless of which provider the workspace actually uses for chat. Consequence: a workspace whose user works in Codex/OpenCode/local models, or who simply lacks Anthropic credentials, gets **no** dreaming at all and **no** surfaced reason — the loop is silently dead. Failures that do occur land in run records (`status:'failed', error:...`) that the status bar shows only at a glance; the swallowed scheduling/sweep failures produce no record at all.

**Evidence.** `dreaming.mjs` lines `719/775/793/523` all use empty `.catch(() => {})`. Lines `545-547` throw on `provider !== 'claude'`; `328-359` hardwire the Anthropic SDK. `dreaming.test.mjs` runs exclusively with `CODESURF_DREAMING_TEST_MODE='stub'` (a `testExecute` is injected — see `runClaudeDream`'s `testExecute` short-circuit), so the real SDK invocation, `formatClaudeSdkError` (`313-319`), and credential-absent behaviour are never exercised by tests.

**Recommendation.** Log (not swallow) scheduling/sweep/reconcile failures to the daemon log with the workspace id; expose a "dreaming unavailable: <reason>" state when the Claude SDK is unconfigured so users know the learning loop is off. Longer term, allow dreaming to use the workspace's configured provider (or any available consolidation-capable model) instead of hard-requiring Claude. Add at least one test that exercises `runClaudeDream`'s error path with the SDK stubbed to throw, to cover `formatClaudeSdkError`.

*No separate verifier critique was recorded for this finding.*

---

### sl-06 — Dead duplicate of the entire dreaming engine (package vs daemon vendor copy)

**Severity:** low · **Effort:** S · **Type:** factual

> **Cross-reference (cluster C2). See also: the duplication section owns this.** The full write-up — byte-identical copies, electrobun double-bundling, and the canonicalization fix — lives there; it is not duplicated here.

The dreaming engine ships as two byte-identical copies: `packages/codesurf-dreaming/src/index.mjs` and `packages/codesurf-daemon/vendor/dreaming.mjs` (verified IDENTICAL via `diff -q`). The running daemon imports only the **vendor** copy (`packages/codesurf-daemon/bin/codesurfd.mjs:15`), so the `codesurf-dreaming` package source is dead code — a divergence trap where a fix to the obvious package location would never ship. Low severity, S effort; pick one canonical source and add a CI diff-check. See the duplication section for details and the cluster-level fix.

---

## Quick wins

- **`sl-06` (S):** delete or de-duplicate the dead `packages/codesurf-dreaming/src/index.mjs`, or add a CI diff-check so the two copies cannot silently diverge. Lowest effort, removes a real divergence trap. (Owned by the duplication section.)
- **`sl-05` partial (S within M):** stop swallowing scheduler/sweep/reconcile failures — replace the four empty `.catch(() => {})` blocks (`dreaming.mjs:523/719/775/793`) with daemon-log writes keyed by workspace id, so a dead learning loop is at least observable.
- **`sl-02` partial (S within M):** expose an `availableSummary` (name + scope + description) of all discovered skills alongside the existing `selection.prompt` in `buildSkillSelectionPrompt` — the full skills array is already in hand, so this is a few lines and immediately lets the agent see what it could use. (Remember to also patch the daemon fallback at `codesurfd.mjs:3217-3235`.)
