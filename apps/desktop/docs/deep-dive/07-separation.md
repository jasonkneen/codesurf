# Separation of Concerns & Package Extraction

This dimension examines where logic lives versus where it *should* live: pure
domain code trapped inside IO-coupled modules, geometry/parsing engines
duplicated across runtime boundaries, and "package candidates" that either
genuinely warrant extraction or were mislabeled. The headline pattern is two
god-files — `App.tsx` (renderer) and `src/main/ipc/chat.ts` (main) — that fuse
pure, testable logic with framework IO, plus a real cross-runtime duplication
between the Electron main process and the `@codesurf/daemon` package. Several
modules previously flagged as "extract to a package" are correctly placed and
should *not* be packaged; the structural wins there are testability splits and a
single boundary-hygiene alias fix.

## Findings

| ID | Title | Severity | Effort | Files |
| --- | --- | --- | --- | --- |
| soc-01 | Canvas discovery geometry engine duplicated in `App.tsx` and the canonical worker copy | medium | M | `src/renderer/src/App.tsx`, `src/renderer/src/workers/discovery-graph-impl.ts`, `src/renderer/src/hooks/useDiscoveryGraph.ts` |
| soc-02 | `chat.ts` embeds pure prompt-convention logic its own test cannot import | medium | S | `src/main/ipc/chat.ts`, `test/chat-convention-prompts.test.ts` |
| soc-03 | External-session indexer duplicated near-verbatim across the app/daemon boundary | medium | L | `src/main/session-sources.ts`, `packages/codesurf-daemon/bin/session-index.mjs` |
| soc-04 | `agent-adapter-registry` is well-bounded but has zero production consumers | low | M | `src/main/agents/agent-adapter-registry.ts`, `src/main/agents/agent-adapter-types.ts`, `test/agent-adapter-registry.test.ts` |
| soc-05 | `event-bus` and `peer-state` are clean single-process modules — keep in main | low | S | `src/main/event-bus.ts`, `src/main/peer-state.ts` |
| soc-06 | Theme/color engine is renderer-only and single-consumer — extract pure `colorMath` for testability, not packaging | low | S | `src/renderer/src/theme.ts`, `src/renderer/src/colorMath.ts`, `src/renderer/src/themeResolution.ts`, `src/renderer/src/theme-tokens.ts` |
| soc-07 | `env.d.ts` imports `codesurf-relay` types via deep package-internal path | low | S | `src/renderer/src/env.d.ts` |

---

### soc-01 — Canvas discovery geometry engine duplicated in `App.tsx` and the canonical worker copy

**Severity:** medium · **Effort:** M · **Category:** duplicate-logic / mixed-concerns

**Problem.** The O(n²) tile-discovery geometry engine exists in two physical
copies. `src/renderer/src/App.tsx` runs the inline path (used for `n < 10` tiles
and for drag rendering) and defines `getTileCapabilities`,
`getTileSpatialReference`, `getCapabilityMatches`, `getOrthogonalRoute`,
`makeAnchor`, `simplifyRoute`, `findBestAnchorPair`, `stepOutFromAnchor`.
`src/renderer/src/workers/discovery-graph-impl.ts` (the worker path for
`n >= 10`) defines the identical functions. The impl file's own header
explicitly documents the sync burden and the intent to remove the duplicates,
and there is no test asserting the two copies produce equal output —
`connection-graph.test.ts` only covers `shared/connectionGraph.ts` cascade
logic, not the geometry.

**Evidence.**

- `src/renderer/src/workers/discovery-graph-impl.ts:89` —
  `export function getTileCapabilities(tile, extActionsByTileId: ExtActionsByTileId)`
  (explicit param).
- `src/renderer/src/App.tsx:552` — `function getTileCapabilities(tile: TileState)`,
  then reads the module-global `extensionActionRegistry` at line 570.
- `src/renderer/src/workers/discovery-graph-impl.ts:14-21` (header docstring):
  > "`getTileCapabilities` here accepts an explicit `extActionsByTileId` map
  > instead of reading the global mutable `extensionActionRegistry` … If the
  > App.tsx originals diverge from this file, the divergence will surface as a
  > connection-graph mismatch between worker and main-thread fallback. Keep the
  > two in sync until we delete the App.tsx duplicates in a follow-up."

**Recommendation.** Treat this as a maintainability hazard (hand-synced
duplicate geometry + untested equivalence), not a correctness bug. Scoped fix:

1. Delete only the genuinely-dead duplicate: `App.tsx` `findDiscoveryConnections`
   (line 630) is now unreferenced — the proximity graph comes from
   `useDiscoveryGraph` → impl. Safe single deletion.
2. Do **not** delete the `540-1010` range wholesale. It contains live, App-only
   code absent from impl: `getTileGridBounds` (582), `routeToSvgPath` (794),
   `getConnectionHandlePoint` (798), `getNearestTileSide` (805),
   `getOppositeAnchorSide` (816), and `findDiscoveryMatch` (990, called at
   1242/2011/4258/4368). Deleting them would break drag rendering and
   locked/cascade/associated connections.
3. Replace only the truly-duplicated pure functions with imports from impl:
   `getTileCapabilities`, `getTileSpatialReference`, `getCapabilityMatches`,
   `getOrthogonalRoute`, `findBestAnchorPair`, `makeAnchor`, `simplifyRoute`,
   `stepOutFromAnchor`. This requires impl to **export** the currently-private
   helpers (`getCapabilityMatches`, `getOrthogonalRoute`, `findBestAnchorPair`,
   `makeAnchor`, `simplifyRoute`, `stepOutFromAnchor` are non-exported today).
4. Thread `extActionsByTileId` (already built at `App.tsx:4265-4272` from the
   same registry) into the ~6 call sites that rely on the global (4323/4324,
   the cascade/associated resolvers at 699/723, and `findDiscoveryMatch`). This
   is the real coupling cost — the module is not drop-in importable because
   App's copy reads a module-global the impl deliberately parameterizes.
5. Add a geometry-equivalence unit test (the gap this finding correctly
   identifies).

Expected LOC reduction is well under any "~470 lines" estimate, since most of
the `540-1010` range stays.

**Verifier critique (refined).** The structural problem is real: ~8
geometry/capability functions are physically duplicated, the impl header
documents the sync burden, and no test guards equivalence — all function
locations and signatures are accurate. But two severity drivers were
overstated. (1) The "`n < 10` vs `n >= 10` can compute *different* graphs" claim
is false in principle: both paths call the same `impl.runDiscoveryPipeline`
(`useDiscoveryGraph.ts:81` inline; the worker delegates to impl too) — the
split is pure thread placement, not two implementations. (2) The "already
drifted" claim does not carry the severity it implies: the base capability maps
are byte-identical (`App.tsx:554-563` vs `discovery-graph-impl.ts:94-102`), and
the global-registry-vs-explicit-param difference is equivalent plumbing because
`App`'s `extActionsByTileId` is derived from the same `extensionActionRegistry`
at 4265-4272. Signatures differ; behavior does not. This is a medium
maintainability risk (an unguarded vector for future divergence), not a high
correctness defect. `alreadyAddressed = false`: the main finder moved to the
worker module, but the duplicated geometry helpers still live in and are
actively used from `App.tsx`.

**See also:** This finding is part of cluster **C1** (primary dimension:
**duplication**, with `dup-02` and `test-03`). The duplication section owns the
root-cause write-up; the equivalence-test gap is owned by the testing section.

---

### soc-02 — `chat.ts` embeds pure prompt-convention logic its own test cannot import

**Severity:** medium · **Effort:** S · **Category:** mixed-concerns / testability

**Problem.** `src/main/ipc/chat.ts` is a ~4174-LOC IPC god-file that mixes
Electron IO (`ipcMain`, `BrowserWindow`, `dialog`, `child_process`, `http`,
`fs`), provider orchestration, and pure prompt-building. The prompt-convention
block (lines 819-1086: `joinPromptSections`, `CODESURF_OUTPUT_CONVENTION`,
`CODESURF_INSIGHT_CONVENTION`, `buildCodeSurfOutputConvention`,
`buildCodeSurfInsightConvention`, `buildAsyncExecutionPrompt`,
`buildClaudeAgentPrompt`, `buildCodexPrompt`, `buildPeerSystemPrompt`) is
provider-agnostic pure string logic with no IO dependency, yet is trapped in a
module that imports `electron`, `@anthropic-ai/claude-agent-sdk`, and
`child_process`. The proof it is a boundary violation:
`test/chat-convention-prompts.test.ts` is forced to `readFileSync` the source
of `chat.ts` and assert on the raw text, because the module cannot be imported.

**Evidence.**

- `test/chat-convention-prompts.test.ts:22` —
  `const CHAT_SOURCE = readFileSync(resolve(process.cwd(), 'src/main/ipc/chat.ts'), 'utf8')`
- `test/chat-convention-prompts.test.ts:11` (header comment) —
  "chat.ts cannot be imported directly (it pulls in Electron main APIs), so …"
- `src/main/ipc/chat.ts:833` — `export const CODESURF_OUTPUT_CONVENTION` and
  `:870` — `export const CODESURF_INSIGHT_CONVENTION`. These are already pure
  `export const`s, ready to move.

**Recommendation.** Extract a plain in-repo module
`src/main/chat/prompt-conventions.ts` (no Electron imports) holding
`CODESURF_OUTPUT_CONVENTION`, `CODESURF_INSIGHT_CONVENTION`,
`joinPromptSections`, `buildAsyncExecutionPrompt`, `buildClaudeAgentPrompt`,
`buildCodexPrompt`, `buildPeerSystemPrompt`. `chat.ts` imports from it. Then
rewrite `test/chat-convention-prompts.test.ts` to import the real module
instead of string-scraping. This is an in-repo file move (not a package — single
consumer, main-only), low effort because the symbols are already exported, and
it directly unlocks real unit testing of the convention logic.

**See also:** This finding is part of cluster **C6** (primary dimension:
**separation** — owned here). It also pairs with `test-08`: the
local-execution checkpoint-safety helpers in `chat.ts` (extract file paths,
build checkpoint label, sanitize tool output) share the same trap and have no
tests at all while their daemon twins in `chat-jobs.mjs` are covered. The same
extraction approach applies; the testing section owns the checkpoint-helper
coverage gap.

---

### soc-03 — External-session indexer duplicated near-verbatim across the app/daemon boundary

**Severity:** medium · **Effort:** L · **Category:** duplicate-logic / package-extraction

**Problem.** The scanning/parsing of external agent session directories is
implemented twice with line-for-line parallel structure: once in the Electron
main process (`src/main/session-sources.ts`, ~2393 LOC, TS) and once in the
daemon (`packages/codesurf-daemon/bin/session-index.mjs`, ~1411 LOC, MJS). Both
define `listCodexSessions` rooted at `homedir()/.codex/sessions`, both define a
`.cursor/chats` scanner, and both rely on a `listFilesRecursive` helper with an
identical extension-filter predicate. The bodies differ only in TS-vs-MJS
syntax. This is the canonical divergence-risk dup: a fix to Codex/Cursor session
parsing in one runtime silently does not reach the other.

**Evidence.**

- `src/main/session-sources.ts:1323` —
  `async function listCodexSessions(workspacePath: string | null)`; `:1324` —
  `const root = join(homedir(), '.codex', 'sessions')`.
- `packages/codesurf-daemon/bin/session-index.mjs:865` —
  `async function listCodexSessions(workspacePath)`; `:866` —
  `const root = join(homedir(), '.codex', 'sessions')`.
- Both then `if (!(await fileExists(root))) return []` and call
  `listFilesRecursive(root, …)`. The same pattern repeats for `.cursor/chats`
  (`session-sources.ts:1525` vs `session-index.mjs:929`).

**Recommendation.** This *is* a legitimate package candidate because it meets
the existing bar: cross-runtime reuse (the `@codesurf/daemon` package exists
precisely because the desktop app and TUI share it). Extract the source-agnostic
scan/parse primitives (`listFilesRecursive`, the per-source readers
`listCodexSessions` / `listCursorSessions` / Claude / OpenClaw, and the
`AggregatedSessionEntry` shaping) into a new package
`packages/codesurf-session-index` (`@codesurf/session-index`, `type: module`,
`src/` entry + exports map — matching the `@codesurf/daemon` and
`@codesurf/dreaming` conventions). Both `src/main/session-sources.ts` and the
daemon bin consume it. Do this incrementally: extract the shared per-source
readers first, leaving the TS-only cache layer (`CachedExternalSessionState`,
60s expiry) and the MJS-only daemon cache in their respective callers. Do **not**
attempt a greenfield restructure.

**See also:** This finding is the primary write-up for cluster **C5** (primary
dimension: **separation** — owned here, with `daemon-10`). The daemon section
adds context on the unbounded per-workspace listing caches retained in both
runtimes.

---

### soc-04 — `agent-adapter-registry` is well-bounded but has zero production consumers

**Severity:** low · **Effort:** M · **Category:** dead-code / premature-extraction

**Problem.** This was listed as a package candidate, but it is currently dead
weight from a wiring standpoint. A repo-wide grep for its exported symbols
(`AGENT_ADAPTER_DEFINITIONS`, `getAgentAdapterDefinition`,
`getAgentAdapterDefinitions`, `summarizeAgentAdapterAvailability`) finds **no**
importer in `src/` other than the file itself — only
`test/agent-adapter-registry.test.ts` consumes it. The live runtime agent
detection lives elsewhere: `src/main/ipc/agents.ts` (its own hardcoded list) and
`src/main/agent-paths.ts`. The registry is an aspirational/parallel definition
not yet plugged into the live detection path.

**Evidence.**

- `grep -rn 'AGENT_ADAPTER_DEFINITIONS|getAgentAdapterDefinition|summarizeAgentAdapterAvailability' src/ --include='*.ts'`,
  excluding `agents/agent-adapter-registry`, returns **empty**.
- `src/main/agents/agent-adapter-registry.ts` is 237 LOC:
  `AGENT_ADAPTER_DEFINITIONS` (line 30), `getAgentAdapterDefinition` (184),
  `summarizeAgentAdapterAvailability` (189).
- `src/main/ipc/agents.ts` and `src/main/agent-paths.ts` independently enumerate
  agents.

**Recommendation.** Do **not** extract to a package yet — single (test) consumer,
cross-runtime-reuse bar not met. The higher-value structural move is the
opposite: **wire** this registry into `src/main/ipc/agents.ts` and
`src/main/agent-paths.ts` to replace their hardcoded lists, collapsing three
sources of truth into one. Only after it has real multi-module consumers (and if
the TUI/daemon needs it too) does packaging as `@codesurf/agent-adapters` become
justified. The file itself is clean, fully typed, and has a passing test — the
issue is integration, not quality.

---

### soc-05 — `event-bus` and `peer-state` are clean single-process modules — keep in main

**Severity:** low · **Effort:** S · **Category:** no-action / framing-correction

**Problem.** These were listed as package candidates, but neither meets the
existing package bar (cross-runtime reuse, per `@codesurf/daemon`). `event-bus`
is an in-memory, single-process pub/sub with 10 main-process importers (`ipc/bus`,
`ipc/system`, `ipc/terminal`, `ipc/tile-context`, `mcp-server`, `relay/service`,
`extensions/registry`, `extensions/context`, `ipc/localProxy`, `peer-state`) and
**zero** renderer importers; an in-memory bus is fundamentally unshareable with
an out-of-process daemon, so packaging would buy nothing. `peer-state` is also
main-only, depends directly on `event-bus` (line 9), and shares its
single-process lifetime. Packaging either would add an exports-map/scope/build
surface for no consumer outside the Electron main process.

**Evidence.**

- `grep -rln event-bus src/renderer/` returns **empty** — no renderer importer.
- `src/main/event-bus.ts`: `EventBus` class (lines 15-167), singleton export
  (169).
- `src/main/peer-state.ts`: module-scope `Map`s (lines 41-43), operations
  `setState` (70), `sendMessage` (162), `removeTile` (232).
- Contrast `packages/codesurf-relay`, a package precisely because it is the
  file-based, cross-process message store usable from daemon/TUI.

**Recommendation.** Leave both in `src/main/`. They are correctly placed and
well-bounded. Incremental improvements (out of scope for this dimension): (a)
`peer-state` has no lifecycle hook guaranteeing `removeTile()` is called on tile
deletion, so the module-scope `Map`s can leak — a cleanup concern, not a
separation one; (b) `event-bus` could grow a tiny unit test since `EventBus` is
exported and trivially constructable. No package extraction.

---

### soc-06 — Theme/color engine is renderer-only and single-consumer — extract pure `colorMath` for testability, not packaging

**Severity:** low · **Effort:** S · **Category:** testability / framing-correction

**Problem.** The theme engine was listed as a package candidate, but
`colorMath.ts`'s own header (lines 4-5) states it "stays inside the renderer
because it has no main-process callers." There is no cross-runtime consumer, so
the package bar is not met. The real structural defect is testability, not
boundaries: `colorMath.ts` is pure math on the contrast hot-path (called on
every slider change) yet has no tests, and `theme.ts`'s `applyContrast` is a
complex pure transform with hardcoded surface/text/border tuples and likewise no
color-fidelity tests.

**Evidence.**

- `src/renderer/src/colorMath.ts:4-5` (header) explicitly scopes it to the
  renderer. (244 LOC: parse/HSLA conversion, `shiftLAway`.)
- `colorMath` importers: `src/renderer/src/theme.ts` and
  `src/renderer/src/components/Minimap.tsx` — both renderer-internal, no
  main-process caller.
- `src/renderer/src/theme.ts:1` imports `shiftLAway` from `colorMath`; `:2`
  imports `resolveThemeIdForAppearance` from `themeResolution`.
- `themeResolution` already has `test/theme-resolution.test.ts`; `colorMath`
  does not.

**Recommendation.** Do **not** package the theme engine. Instead: (a) add a
`colorMath` unit test (round-trip hex8 alpha preservation, rgb/rgba
re-emit-in-original-shape, NaN/unknown passthrough, `shiftLAway` L-axis bounds)
— the module is already pure and isolated, so this is pure upside at S effort;
(b) optionally split the large `theme.ts` (~3048 LOC) by separating the
`applyContrast` algorithm and the preset table into `theme-contrast.ts` and
`theme-presets.ts` to shrink the god-file — but that is an in-renderer file
split, not a package. Keep everything under `src/renderer/src/`.

---

### soc-07 — `env.d.ts` imports `codesurf-relay` types via deep package-internal path

**Severity:** low · **Effort:** S · **Category:** boundary-violation / package-hygiene

**Problem.** The `codesurf-relay` package defines a proper exports map
(`packages/codesurf-relay/package.json`: `main ./src/index.ts`, `exports '.'`),
and `tsconfig` already aliases `@codesurf/chat-bridge` — but the renderer's
`env.d.ts` reaches into the package by relative deep path
`../../../packages/codesurf-relay/src` instead of via a `@codesurf/relay` alias.
This is the one real (if minor) instance of crossing a package boundary by
internal path rather than through its published entry, coupling the renderer's
type surface to the package's internal directory layout.

**Evidence.**

- `src/renderer/src/env.d.ts:376-386` repeats
  `import('../../../packages/codesurf-relay/src').RelayX` ~11 times
  (`RelayParticipant`, `RelayChannel`, `RelayMessage`,
  `RelayDirectMessageDraft`, etc.) — confirmed present.
- By contrast `@codesurf/chat-bridge` has a tsconfig path alias
  (`tsconfig.json:19-20`); `codesurf-relay`'s `package.json` declares an exports
  map but no alias is wired for it.

**Recommendation.** Add a tsconfig path alias `@codesurf/relay` →
`packages/codesurf-relay/src/index.ts` (mirroring the existing `@codesurf/chat-bridge`
alias) plus the matching Vite `resolve.alias`, then replace the deep
`import('../../../packages/codesurf-relay/src')` references in `env.d.ts` with
`@codesurf/relay`. This routes the renderer through the package's public entry,
decoupling it from internal file layout. Low effort, low risk, and aligns with
the existing alias convention.

---

## Quick wins

- **soc-07 (S):** Add the `@codesurf/relay` tsconfig + Vite alias and swap the 11
  deep `import('../../../packages/codesurf-relay/src')` references in `env.d.ts`.
  Pure hygiene, low risk.
- **soc-02 (S):** Move the already-exported prompt-convention symbols out of
  `chat.ts` into `src/main/chat/prompt-conventions.ts` and rewrite
  `test/chat-convention-prompts.test.ts` to import the real module instead of
  `readFileSync`-scraping source. Unlocks genuine unit testing.
- **soc-06 (S):** Add a `colorMath` unit test (alpha round-trip, shape
  preservation, NaN passthrough, `shiftLAway` bounds). The module is already
  pure and isolated — no refactor required.
- **soc-01 step 1 (XS):** Delete the now-unreferenced `findDiscoveryConnections`
  in `App.tsx` (line 630) — a safe single deletion that shrinks the duplicated
  surface immediately, ahead of the larger import-consolidation work.
