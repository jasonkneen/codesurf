# Duplication & Dead Code

This section catalogs code that exists in more than one place (or no longer exists in any reachable path) across the contex codebase. The headline issues are two engines shipped as parallel copies — the dreaming module (byte-identical, one copy fully dead) and the discovery-graph geometry pipeline (App.tsx vs. worker impl) — plus a long tail of copy-pasted filesystem/JSON helpers and per-provider boilerplate. The unifying hazard is silent drift: a fix applied to one copy never reaches its twin, and no compiler check or test asserts the copies stay equal. Severities below reflect post-verification refinement; one finding (`dup-02`) had its severity dropped from high to medium because the verifier disproved its central "boundary-dependent divergence" claim.

## Findings

| ID | Title | Severity | Effort | Files |
|----|-------|----------|--------|-------|
| dup-01 | Byte-identical dreaming module shipped twice; package copy is dead | High | S | `packages/codesurf-dreaming/src/index.mjs`, `packages/codesurf-daemon/vendor/dreaming.mjs` |
| dup-02 | Discovery-graph geometry helpers reimplemented in App.tsx vs. worker impl | Medium | M | `src/renderer/src/App.tsx`, `src/renderer/src/workers/discovery-graph-impl.ts` |
| dup-03 | FS/JSON/ID helpers copy-pasted across daemon bins and main process | Medium | M | `packages/codesurf-daemon/bin/*.mjs`, `src/main/storage/jsonArtifacts.ts` |
| dup-04 | Dead JSX-preview rendering code in ChatTile (sole caller commented out) | Low | S | `src/renderer/src/components/ChatTile.tsx`, `src/renderer/src/components/ai-elements/JSXPreview.tsx` |
| dup-05 | Provider/model lists duplicated between renderer config and main/daemon | Low | M | `src/renderer/src/config/providers.ts`, `src/main/ipc/chat.ts` |
| dup-06 | Per-provider error/key/fetch boilerplate duplicated across TTS/STT/title routers | Low | M | `src/main/ipc/tts.ts`, `src/main/ipc/transcribe.ts` |

---

### dup-01 — Byte-identical dreaming module shipped twice; package copy is dead

**Severity: High · Effort: S · Category: duplication**

**Problem.** The ~30KB dreaming engine exists as two byte-identical copies. Only `packages/codesurf-daemon/vendor/dreaming.mjs` is imported at runtime (`packages/codesurf-daemon/bin/codesurfd.mjs:15` imports `'../vendor/dreaming.mjs'`). The `@codesurf/dreaming` package (`main: ./src/index.mjs`) is referenced by **nothing** except packaging-copy rules — a grep for `codesurf-dreaming` / `@codesurf/dreaming` finds zero `import` usages. So (a) the source package is dead code, and (b) the build bundles **both** directories, shipping the identical 30KB file twice. Worse, the two copies can silently diverge: a fix to `vendor/dreaming.mjs` leaves the package stale (or vice-versa) with no compiler or test catching the drift.

**Evidence.**

- `diff -q packages/codesurf-dreaming/src/index.mjs packages/codesurf-daemon/vendor/dreaming.mjs` reports identical; both md5 `51ec253560e4a03af2bcc7e36e16db07` (815 lines each). Verified this session.
- Runtime import is exclusively `'../vendor/dreaming.mjs'` at `packages/codesurf-daemon/bin/codesurfd.mjs:15`.
- The dead package ships via **three** packaging configs, not one:
  - `electrobun.config.ts:24` (build copy of `packages/codesurf-dreaming`)
  - `package.json:15` (npm `files` array)
  - `package.json:140` (electron-builder `files` array)
- grep for `codesurf-dreaming` returns only those packaging references plus two self-references inside `vendor/dreaming.mjs` strings (the agent name `'codesurf-dreaming'`).

**Recommendation.** Delete the orphaned `packages/codesurf-dreaming` package — it is not in any `workspaces` config, imported by nothing, and the `codesurf-daemon` README already names `vendor/dreaming.mjs` as canonical. Then remove **all three** packaging references (`electrobun.config.ts:24`, `package.json:15`, `package.json:140`), not just the electrobun copy rule. Keep `packages/codesurf-daemon/vendor/dreaming.mjs` as the single source of truth. The existing test (`test/daemon/dreaming.test.mjs`) already exercises only the vendor copy via the bin shim, so no test changes are needed once the dead copy is gone — and removing it eliminates the drift surface entirely, which is cleaner than adding a hash-equality CI guard.

**Verifier note (refined, confidence high).** Every cited fact verified against the codebase. Refined only because the original finding understated blast radius: the dead package ships via three packaging configs, so cleanup must cover all three. The drift-risk claim was confirmed and sharpened — the test suite exercises only the vendor copy via the bin shim, so the duplicate package copy has **zero** test/type coverage. Severity held at high.

> Cross-reference cluster **C2** (`dup-01` + `sl-06`): the dreaming engine's two-copy structure also touches the self-learning dimension. This section owns the duplication write-up; see the self-learning section for how a fix to the named-package location would never reach the running daemon.

---

### dup-02 — Discovery-graph geometry helpers reimplemented in App.tsx vs. worker impl

**Severity: Medium · Effort: M · Category: duplication**

**Problem.** The O(n²) pairwise tile-discovery/capability geometry pipeline is implemented twice as parallel, non-shared code. `src/renderer/src/App.tsx` does **not** import `discovery-graph-impl.ts` — it redefines every helper. The duplication is genuine, but the original finding's causal mechanism was **wrong** and has been corrected (severity dropped high → medium accordingly):

- **The dead piece:** `App.tsx`'s `findDiscoveryConnections` (line 630) is dead — defined, never called. The actual discovery graph is computed by `useDiscoveryGraph`, which calls `runDiscoveryPipeline` (from the impl) on **both** paths.
- **The live duplication:** the 6 helpers in `App.tsx` — `getTileCapabilities` (552), `getTileSpatialReference` (603), `getCapabilityMatches` (623), `findBestAnchorPair` (741), `getOrthogonalRoute` (775), `rectsOverlap` (853) — are byte-for-byte parallel copies of the impl helpers and still feed App-side features the original finding never mentions: `cascadeDiscoveryConnections` (699–714), `addAssociatedDiscoveryConnections` (723–738), locked/negotiated-connection injection (4323–4331), and drag-preview routing (4533–4542, 6887–6891). An edit to capability matching, anchor selection, or route tracing in the impl would silently fail to reach those App-side consumers — a risk that is **independent of tile count**, not gated by 10 tiles.

**Evidence.**

- `grep "discovery-graph-impl" src/renderer/src/App.tsx` → exit 1 (no import). Verified this session.
- `src/renderer/src/hooks/useDiscoveryGraph.ts` uses `runDiscoveryPipeline` for the inline path (line 81) **and** the worker fallback (line 90). Verified this session. The 10-tile `WORKER_THRESHOLD` selects only **where** the same code runs (main thread vs. worker), never **which** code — so the claimed "graph differs across the 10-tile boundary" defect does not exist.
- The two copies have already drifted in **how** they source ext-tile actions: `App.tsx:552-580` `getTileCapabilities` reads the module-global `extensionActionRegistry` and iterates `action.name` at `:570-572`; `discovery-graph-impl.ts:89` takes an explicit `extActionsByTileId` map of pre-extracted string arrays. The impl header comment (lines 13–20) candidly documents this divergence.

**Recommendation.** Retarget the fix because the mechanism is wrong:
1. **Delete** `App.tsx`'s `findDiscoveryConnections` (line 630) outright — it is dead code.
2. Make `discovery-graph-impl.ts` the single source of truth: export its currently-private helpers and have `App.tsx` import them, threading `extActionsByTileId` (already available at the `App.tsx:4284` call site) into the helper calls so ext-tile capability sourcing is identical. The impl helpers are pure (import only `shared/types` and `shared/nodeTools`), so extraction is safe with no shared mutable-ref coupling.
3. A `runDiscoveryPipeline` snapshot test only guards the worker pipeline; it would **not** catch drift in the helper consumers. The parity test must also cover the cascade/associated/locked/drag helper outputs.

**Verifier note (refined, accurate: false → corrected, confidence high).** The finding correctly identified a real copy-paste duplication and the one documented divergence (registry-read vs. passed-map), but its central claim — that `useDiscoveryGraph` runs the App.tsx version for n<10 and the worker version for n≥10, causing a boundary-dependent graph difference — is factually false. Both `useDiscoveryGraph` paths call `runDiscoveryPipeline` from the impl; the threshold selects execution location, not code. There is no boundary-dependent discovery-graph bug. Severity dropped from high to medium: "high" was earned by the (false) premise of an active, user-visible defect. What actually remains is **latent** — the copies currently produce equivalent output, so nothing is broken today; the risk is the standard "edit one, forget the other," made concrete by the already-drifted ext-action sourcing.

> Cross-reference cluster **C1** (`dup-02` + `soc-01` + `test-03`, primaryDimension: duplication). This section owns the write-up. The separation-of-concerns angle (geometry engine embedded in a 1700-LOC `App.tsx`) and the missing equivalence test are detailed in their respective sections.

---

### dup-03 — FS/JSON/ID helpers copy-pasted across daemon bins and main process

**Severity: Medium · Effort: M · Category: duplication**

**Problem.** The same trivially-correct helpers are reimplemented many times with subtle variations in fallback/error behavior. `ensureDir` has 12 definitions repo-wide (5 in daemon bins). `normalizePath` has 4 daemon copies. The atomic-write pattern (write temp `.${pid}.${Date.now()}.tmp`, then rename) appears in 5+ places. A shared, hardened implementation already exists at `src/main/storage/jsonArtifacts.ts` (it adds balanced-JSON recovery + a `randomUUID` temp suffix to avoid collisions), but the standalone daemon `.mjs` bins cannot import TS, so each reinvents a weaker version. Divergence means a bug fixed in one (atomic-write fsync, JSON recovery) is not fixed in the others.

**Evidence.**

- `ensureDir`: `codesurfd.mjs:48`, `checkpoints.mjs:5`, `chat-jobs.mjs:15`, `session-index.mjs:25`, `vendor/dreaming.mjs:26` (+5 more in `src/main`: `permissions.ts:21`, `secrets.ts:34`, `activity-store.ts:23`, `session-sources.ts:103`, `ipc/skills.ts:139`).
- `normalizePath`: `codesurfd.mjs:52`, `checkpoints.mjs:24`, `chat-jobs.mjs:113`, `session-index.mjs:39`.
- `atomicWriteJson` / `writeJsonAtomic`: `codesurfd.mjs:60`, `vendor/dreaming.mjs:38`, `permissions.ts:25`, `usage/snapshot-store.ts:36`.
- Collision hazard: `jsonArtifacts.ts:80-85` uses `${pid}.${Date.now()}.${randomUUID()}.tmp`, while `codesurfd.mjs:62` uses only `${pid}.${Date.now()}.tmp` — collision-prone within a single process where pid is constant and `Date.now()` has millisecond resolution.
- `readJson*` variants appear in 8 files; `normalizeText` in `skills-index.mjs:34` and `vendor/dreaming.mjs:60`; `assertSafeId` in `codesurfd.mjs:1587` and `vendor/dreaming.mjs:20`.

**Recommendation.** Create one shared `.mjs` utility module inside `packages/codesurf-daemon` (e.g. `bin/_fs-util.mjs`) exporting `ensureDir`, `atomicWriteJson`, `readJsonFile`, `normalizePath`, `normalizeText`, `assertSafeId`, `makeId`, and have every daemon bin import it instead of redefining. For the main process, route `permissions.ts` and `usage/snapshot-store.ts` through `src/main/storage/jsonArtifacts.ts` (`writeJsonArtifactAtomic` / `readJsonArtifact`) to inherit the collision-safe temp suffix and JSON-recovery. This collapses ~20 helper copies into 2 homes (one per process boundary).

> Cross-reference cluster **C4** (`dup-03` + `rel-05`, primaryDimension: duplication). This section owns the duplication write-up. The reliability angle — that the weak `atomicWriteJson` actually collides on same-millisecond same-process writes (constant pid + ms-resolution `Date.now()`), overwriting each other and renaming non-atomically — is detailed in the reliability section.

---

### dup-04 — Dead JSX-preview rendering code in ChatTile (sole caller commented out)

**Severity: Low · Effort: S · Category: dead-code**

**Problem.** `InlineJSXPreviewBlock` and `splitRenderableMessageSegments` are unreachable. The `bodySegments` call that consumed them is commented out, with an explicit note that the feature was disabled for causing render lockups. This is ~250+ lines of dead code carried in the largest file in the renderer (`ChatTile.tsx` is ~6800 LOC), plus a whole unused component file (`JSXPreview.tsx`, 356 LOC), plus the `react-jsx-parser` dependency it pulls in.

**Evidence.**

- `ChatTile.tsx`: `JSXPreview` imported at line 49; `splitRenderableMessageSegments` defined at line 773; `InlineJSXPreviewBlock` defined at lines 848–~1070 (uses `<JSXPreview>` at 1046).
- The only invocation site is the commented-out `useMemo` at line 1585, with note at line 1584: `JSX preview disabled — was causing render lockups on message history load`.
- `grep '<InlineJSXPreviewBlock|InlineJSXPreviewBlock('` returns only the definition (line 848). `splitRenderableMessageSegments` has exactly two hits: definition (773) and the commented call (1585). `JSXPreview` is imported only by `ChatTile.tsx`.

**Recommendation.** Remove `InlineJSXPreviewBlock`, `splitRenderableMessageSegments`, the `JSXPreview` import, and the commented `bodySegments` lines from `ChatTile.tsx`. If the JSX-streaming feature is truly abandoned (render lockups), delete `JSXPreview.tsx` and drop `react-jsx-parser` from dependencies; if it may return, move it behind a feature flag rather than a comment. Confirm with the team before deleting per the repo's dead-code policy.

---

### dup-05 — Provider/model lists duplicated between renderer config and main/daemon

**Severity: Low · Effort: M · Category: duplication**

**Problem.** `providers.ts` `DEFAULT_MODELS` is the renderer's source of truth (and per the project's own memory note, must be hand-mirrored elsewhere). Yet model ids are independently hardcoded in `chat.ts` (the OpenCode fallback list), `session-title-generation.ts`, `vendor/dreaming.mjs`, and `provider-executor.ts`. When a model is renamed or retired (e.g. `claude-sonnet-4-6` → next), these scattered literals drift out of sync, causing silent fallback-to-wrong-model behavior. This is the same hand-mirroring hazard the project already flagged for grok-cli in its memory notes.

**Evidence.**

- `src/renderer/src/config/providers.ts:24` — `DEFAULT_MODELS` (canonical).
- `src/main/ipc/chat.ts:1706` — `OPEN_CODE_FALLBACK_MODELS` hardcodes `anthropic/claude-sonnet-4-6`, `openai/gpt-5.4`, etc.
- `src/main/ipc/session-title-generation.ts:48-49` — `OPENAI_TITLE_MODEL` / `OPENROUTER_FREE_TITLE_MODELS`.
- `packages/codesurf-daemon/vendor/dreaming.mjs:7-8` — `DEFAULT_PROVIDER='claude'` / `DEFAULT_MODEL='claude-sonnet-4-6'`.
- `src/main/relay/provider-executor.ts:91` — fallback `'claude-sonnet-4-6'`.
- `grep 'claude-sonnet-4-6'` across main/daemon returns `chat.ts:1707`, `dreaming.mjs:8/543/813`, `provider-executor.ts:91` — all independent literals, none importing `providers.ts` (which is renderer-only and cannot be imported by `.mjs` daemon bins).

**Recommendation.** Promote model/provider defaults into a process-agnostic shared module (e.g. `src/shared/` as plain JSON or a `.ts` both renderer and main can import; a parallel `.mjs` export for the daemon, or have the daemon read defaults from the daemon API instead of hardcoding). At minimum, centralize the main-process literals (`chat.ts`, `session-title-generation.ts`, `provider-executor.ts`) into one constants module. Lower priority than `dup-01`/`dup-02`/`dup-03`, but reduces release-time model-rename toil.

---

### dup-06 — Per-provider error/key/fetch boilerplate duplicated across TTS/STT/title routers

**Severity: Low · Effort: M · Category: duplication**

**Problem.** Each provider implementation re-derives the same shape: resolve API key (`getSecret(name) ?? process.env.NAME`), return `{ok:false, error:'No X key set.'}` on miss, `fetch` with provider-specific headers, then near-identical error parsing. `transcribe.ts` and `tts.ts` are structurally the same router with different endpoints. This is repeated error handling, not a defect, but it means a fix to key-resolution or timeout/retry must be applied N times and is a known drift source.

**Evidence.**

- `src/main/ipc/tts.ts`: per-provider blocks each doing `getSecret(x) ?? process.env.X`, key-missing early return, `fetch(url, {headers})`, error parse — Cartesia (~57), Deepgram (~88), ElevenLabs (~113).
- `src/main/ipc/transcribe.ts` mirror: OpenAI (~59), Deepgram (~85), AssemblyAI (~116).
- `src/main/ipc/session-title-generation.ts` duplicates the candidate-selection + key-fetch + fallback chain.
- grep shows the identical `getSecret(x) ?? process.env.X` + `'No X API key set.'` pattern repeated per provider in both `tts.ts` and `transcribe.ts` (8+ occurrences).

**Recommendation.** Extract a small helper: `resolveProviderKey(name)` (`getSecret ?? env`, returns a standardized "no key" error) and a `callProviderFetch(url, {headers, parseError})` wrapper with shared timeout/error normalization. Have all three routers consume them. Keeps provider-specific request shaping but removes the copy-pasted key/error scaffolding. Judgment-level; do only if these routers are actively maintained.

---

## Quick wins

- **`dup-01` (S):** Delete `packages/codesurf-dreaming` and its three packaging references (`electrobun.config.ts:24`, `package.json:15`, `package.json:140`). High-severity, small effort, zero test changes needed — the single best ROI in this dimension.
- **`dup-04` (S):** Strip the dead `InlineJSXPreviewBlock` / `splitRenderableMessageSegments` / `JSXPreview` block (~250 LOC) from `ChatTile.tsx`; drop `react-jsx-parser` if the feature is abandoned.
- **`dup-02` (M, scoped quick part):** Delete the dead `findDiscoveryConnections` (App.tsx:630) immediately — it is unreachable and removing it is risk-free, independent of the larger helper-consolidation work.
- **`dup-03` partial (S within M):** Harden the daemon temp-suffix to include `randomUUID` to close the same-millisecond collision window even before the full `_fs-util.mjs` consolidation lands.
