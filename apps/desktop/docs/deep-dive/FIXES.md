# Deep-Dive Fixes — Changelog

Applied from the findings in this directory. Gate used throughout: the project's
`npm test` suite (typecheck has 172 pre-existing, audit-unrelated errors, so it
is not a green gate; no fix added a new one).

**Verification after all waves:** `npm test` **297 pass / 0 fail** · `npm run
test:daemon` 72 pass / 0 fail · `npm run test:relay` 40 pass / 0 fail (2 todo) ·
typecheck **165 errors (down from ~172; zero introduced)** · **`npm run build`
green** (main · preload · renderer — no resolution errors, validates every new
chat/* + daemon + security cross-module change AND the react-jsx-parser removal +
global-JSX shim under the real bundler). New tests added across waves:
`colorMath` (7), `prompt-conventions` (rewrite), `output-sanitizers` (12),
`prompt-builders` (10), `chat-jobs-loop-hardening` (daemon-01/05/07, 3),
`file-protocol-auth` (11, risk-04), `generation-secrets` (9, gap-03),
`chrome-domain-allowlist` (8, risk-06). The relay suite is runnable + wired into CI.

No commits were made — all changes are in the working tree for review.

---

## Fixed

### Security (10-holes.md)
- **risk-01 (critical) — RCE on workspace open.** `src/main/extensions/registry.ts`: workspace-scoped power extensions now default to **off** and require explicit per-extension enablement (mirrors the catalog flow via `enabledCatalogIds`); enable/disable persist for power tier so the toggle survives rescans. Safe-tier UI extensions still auto-load (no behavior change). **Note:** existing users relying on a workspace power extension auto-loading must re-enable it once — the intended security tradeoff.
- **risk-02 (critical) — unauthenticated MCP server.** `src/main/mcp-server.ts`: added **Host-header validation** (rejects non-loopback Host → defeats DNS-rebinding), the actual remote defense. CORS now **reflects the caller's Origin** instead of a static `*` (an allowlist was considered but reverted: the in-app renderer's `/push` fetch sends `Content-Type: application/json` → a preflight, and its production Origin can be `"null"` from `file://`, so an allowlist would silently break it; and `/push`/`/inject` are side-effecting and reachable by *simple* cross-origin POSTs regardless of ACAO, so CORS was never their boundary). Full bearer-token enforcement was *not* turned on — the token is ephemeral and `/inject` is driven by external agents whose `.mcp.json` carries no auth header, so enforcing it would break agent↔terminal features that can't be runtime-tested here. Host-validation + 0o600 close the remote and cross-user vectors; **token enforcement (threaded into `.mcp.json` headers) is the remaining step** and the only thing that fully closes same-user local-process access.
- **risk-03 (high) — world-readable config.** `mcp-server.json` and `permissions.json` now written `0o600` (+ `chmod` for existing files), matching `secrets.json`.
- **risk-05 (medium) — git option injection.** `src/main/ipc/git.ts`: `assertSafeBranchName` rejects leading-`-`/control-char branch names; `git checkout --end-of-options`.
- **risk-07 (low) — silent plaintext secrets.** `src/main/secrets.ts`: one-time warning on `safeStorage`-unavailable plaintext fallback; decrypt failures are logged (not masked as "no key"); added `isSecretsEncryptionAvailable()`.
- **risk-08 (low) — committed build bundle.** Untracked the stale 798 KB root `index.js` (kept on disk) and `.gitignore`d it.
- **gap-02 (high) — relay tests never ran.** Added `test:relay` / `test:all` scripts; the suite runs (40 pass). Surfaced + fixed a real **unhandled rejection** in `packages/codesurf-relay/src/runtime.ts` (error handler threw on a removed participant).
- **gap-04 (medium) — no PR CI.** Added `.github/workflows/ci.yml` (typecheck + tests + relay tests on PR/push-to-main).
- **gap-05 (low) — hardcoded dev path.** Removed the `/Users/jkneen/...` codicon fallback in `src/main/extensions/protocol.ts`.
- **gap-03 (medium) — generation keys → keychain (user-approved product call).** Generation-provider API keys (Gemini/OpenAI-image/etc.) were stored plaintext in `settings.json` while TTS/STT keys already use the OS keychain. New electron-free, tested module `src/main/generation-secrets.ts` (`persistGenerationKeys` moves each key to `safeStorage` under `generation:<id>` and blanks the field; `resolveGenerationKeys` re-fills it from the keychain for the renderer + consumers). Wired into `settings:get`/`settings:set`/`setRawJson`/`validateGenerationProvider` (`ipc/workspace.ts`), the MCP generation path (`mcp-server.ts readAppSettingsForMcp`), and a one-time idempotent startup migration (`migrateGenerationKeysToKeychain`, run from `index.ts`). settings.json now holds no plaintext generation key. **9 unit tests** (round-trip, idempotency, no-data-loss-on-store-failure). **Runtime tail to verify in-app:** the SettingsPanel key field still shows/edits correctly (it receives resolved keys), and generation still works after the migration.
- **risk-04 (medium) — `codesurf-file://` cross-origin exfil (user-approved product call).** The scheme served most home-dir files with `Access-Control-Allow-Origin: *`, reachable cross-origin from webview tiles. **Dropped the wildcard ACAO header** — media tiles load via `<img>/<video>/<audio> src` (no-cors, confirmed: zero `crossorigin`/`fetch('codesurf-file')` in renderer source), so removing it blocks the `fetch()`/canvas cross-origin reads that were the exfil vector, with no media-display impact. Extracted the path-authorization into tested `src/main/file-protocol-auth.ts`, **expanded the sensitive-home denylist** (`.kube`/`.docker`/`.netrc`/`.npmrc`/`.git-credentials`/`.cache`/`.local`/… on top of the original 4), and hardened the home-prefix check against prefix-slip + `..` traversal. **11 unit tests.** A positive workspace/media-root *allowlist* (per-file registration) is honestly deferred — with ACAO gone it's hardening, not the boundary; it needs every media-open call site + the app loop. **Runtime tail:** exercise the screenshot/design-mode features + any media tile to confirm nothing relied on the old wildcard CORS.
- **risk-06 (medium) — Chrome cookie sync scope (user-approved product call).** Cookie sync injected the *entire* decrypted jar into browser-tile partitions that navigate arbitrary URLs. Added an approved-domains allowlist: tested electron-free matcher `src/main/chrome-sync/domain-allowlist.ts` (`isCookieDomainApproved`, dot-boundary subdomain match so `evilexample.com` ≠ `example.com`), threaded through `syncCookiesToPartition(…, { approvedDomains })` and read from a new `chromeSyncApprovedDomains` setting in the `chromeSync:syncCookies` IPC. **Empty list = inject-all + a console warning** (per design: never silently kill existing sync before the approval UI exists). **8 unit tests.** **Runtime tail:** add the approval UI (SettingsPanel/BrowserTile) to populate `chromeSyncApprovedDomains`; until then scoping is opt-in via settings/raw-JSON. Verify cookies still flow for approved domains in a live tile.

### Reliability (04-reliability.md)
- **rel-03 (high)** — `src/main/relay/provider-executor.ts`: `runClaudeTurn` now uses an `AbortController` (aborts the SDK subprocess on timeout) and clears the timer — stops a silently-billing leaked subprocess on every relay-Claude timeout.
- **rel-02 (medium)** — `killAllChatProcesses()` (`src/main/ipc/chat.ts`) wired into `before-quit` (`src/main/index.ts`): SIGTERM + unref'd SIGKILL fallback for live CLI children, stops the OpenCode server. Terminals left alone (tmux sessions are meant to survive).
- **rel-05 (medium)** — added a `randomUUID()` token to the `atomicWriteJson` temp path in all 6 copies (`codesurfd.mjs`, `chat-jobs.mjs`, `checkpoints.mjs`, `secrets.ts`, `permissions.ts`, `usage/snapshot-store.ts`) to close the same-millisecond collision window.

### Memory (02-memory.md)
- **mem-01 (medium)** — `chat:disposeCard` IPC evicts all five card-keyed maps and prunes `session-ids.json`; wired from `App.tsx cleanupTileResources`. `clearSession` now persists its eviction too.
- **mem-02 (medium)** — `src/main/ipc/stream.ts`: renderer `'destroyed'` cleanup reclaims orphaned HTTP/SSE requests on window crash/reload.
- **mem-03 (medium)** — `system:cleanupTile` now drops `card:`/`ctx:` bus channels, not just `tile:`.
- **mem-04 (low)** — `src/main/ipc/fs.ts`: file watchers refcounted per path with a subscriber set; multi-window watch is now correct and torn down only on last release.
- **mem-05 (low)** — bounded the `disposedChatTileIds` tombstone set (FIFO cap 256).

### Daemon & agent loop (08-daemon.md)
- **daemon-01 (high)** — `chat-jobs.mjs`: bounded job scheduler. A `maxConcurrentJobs` cap (default 4, env `CODESURF_MAX_CONCURRENT_JOBS`) with a FIFO queue replaces the unbounded `void runJob` fan-out; overflow sits in status `'queued'` and drains as slots free in `runJob`'s `finally` via `pumpJobQueue`. `streamJob` now holds the SSE stream open for `'queued'` (not just `'running'`) so a queued foreground chat doesn't close early; `cancelJob` removes a still-queued job from the queue and terminates it cleanly. Gated by a new test (`test/daemon/chat-jobs-loop-hardening.test.mjs`): 5 jobs against a cap of 2 → exactly 2 run, 3 queue, all complete, cap never exceeded.
- **daemon-07 (medium)** — `chat-jobs.mjs`: `appendEvent` still appends every event to the timeline jsonl, but the full-object metadata rewrite is now **debounced** (~250 ms) instead of fired per streamed delta. Terminal (`done`/`error`), session, and non-live events flush immediately, so final status/sessionId/lastSequence stay durable. Same new test proves the debounced final flush keeps `lastSequence` equal to the timeline's last sequence (no event lost).
- **daemon-05 core (medium)** — `chat-jobs.mjs`: added `sweepJobRetention({ maxAgeMs=30d, keepRecent=200 })` that prunes terminal (`completed`/`failed`) job `*.json` + their `timelines/*.jsonl` past the TTL while protecting the newest `keepRecent` and never touching live or active (`running`/`queued`) jobs. Wired into `codesurfd.mjs`'s existing 24 h timer + a startup pass. Gated by a new test (3rd case in `chat-jobs-loop-hardening.test.mjs`): old terminal jobs pruned with timelines, fresh/active jobs kept, `keepRecent` protects recent-but-old jobs. **Entangled remainder deferred (gate-based):** checkpoint-record retention crosses into `checkpoints.mjs` + per-workspace dirs, and the `readDaemonJobRecords` mtime-cap is server-side (not unit-reachable) — see the boundary table.
- **daemon-02 / rel-04 (high)** — `chatJobs.shutdown()` cancels in-flight jobs + kills CLI children (SIGTERM→SIGKILL grace), awaited inside `codesurfd.mjs shutdown()` before `server.close()`.
- **daemon-04B (high)** — `streamJob` liveness guard: an active-status job not in `liveJobs` (post-crash) emits a terminal error+done instead of hanging the SSE stream forever.
- **daemon-06 (medium)** — `captureFileSnapshot` size cap (5 MB) stores an `oversize` marker; restore skips it (was: `content==null` → **deleted the file**, which the new branch prevents).
- **daemon-08 (low)** — `writeSseEvent` try/catch + backpressure return; per-job SSE heartbeat (`: ping`).
- **daemon-09 (low)** — idempotent terminal events (`terminalEmitted` flag) — no more duplicate error+done on cancel.

### Duplication / Performance / Self-learning
- **dup-01 / sl-06 (high)** — deleted the dead, byte-identical `packages/codesurf-dreaming` package and its **three** packaging references (`package.json` files ×2, `electrobun.config.ts`). `codesurf-daemon/vendor/dreaming.mjs` remains canonical (tested).
- **dup-04 (low) — done the SAFE way (was previously reverted as a blind deletion).** Removed the dead JSX-preview island from `ChatTile.tsx` (`RenderableMessageSegment`, `JSX_FENCE_LANGUAGES`, `looksLikeInlineJsxSource`, `splitRenderableMessageSegments`, `InlineJSXPreviewBlock` — ~355 LOC), deleted `ai-elements/JSXPreview.tsx`, and **uninstalled `react-jsx-parser`**. The catch from the first attempt: `react-jsx-parser` bundled a nested `@types/react@18` that was the *sole* provider of the **global `JSX` namespace** the renderer's ~58 bare `JSX.Element`/`JSX.IntrinsicElements` annotations depend on (react@19 moved it to `React.JSX`). Fixed properly this time by **first adding an explicit `declare global { namespace JSX }` shim** in `src/renderer/src/env.d.ts` that mirrors `react/jsx-runtime` (maps every member to `React.JSX.*`, with the Electron `<webview>` augmentation folded into `IntrinsicElements`), *then* removing the dependency. Result: tsgo **165** (DOWN from 169 — the dead code carried ~4 errors; the first blind attempt had gone 171→345), build green, 269 tests pass. The renderer no longer depends on a transitive React-18 types package.
- **dup-02 / soc-01 step 1 (medium)** — deleted the compiler-confirmed-dead `findDiscoveryConnections` (`App.tsx`); the live discovery graph runs through `useDiscoveryGraph`. Removed its TS6133 error too.
- **perf-08 (low)** — `LIMIT 500` on the global `listThreadsFromDb(null)` scan.
- **sl-05 partial (medium)** — replaced the 4 silent `.catch(()=>{})` in `dreaming.mjs` (reconcile/auto-eval/schedule/sweep) with `console.error` so a dead learning loop is observable.
- **soc-06 (low)** — added `test/colormath.test.ts` (7 tests: parse/format round-trips, HSLA round-trip, shift bounds). The module was already pure; pure testing win.
- **soc-02 (medium)** — extracted the pure prompt conventions (`CODESURF_OUTPUT_CONVENTION`, `CODESURF_INSIGHT_CONVENTION`, `buildCodeSurf*`, `joinPromptSections`) out of the 4.2k-LOC `ipc/chat.ts` into `src/main/chat/prompt-conventions.ts`, and rewrote `test/chat-convention-prompts.test.ts` to import + assert the real values (it previously `readFileSync`-scraped source). Removed a dead-code error in the process. First incremental step of the chat.ts god-file decomposition.
- **soc-02 step 2 + dup (medium)** — extracted the pure agent-output sanitizers (`sanitizeToolOutputText`, `sanitizeClaudeStderrText`, `formatClaudeSdkError`) out of `ipc/chat.ts` into `src/main/chat/output-sanitizers.ts`. `sanitizeToolOutputText` was **byte-identically copy-pasted** into `src/main/session-sources.ts` too — both main-process copies now import the single module (renderer's differently-typed copy left alone per scope). Added `test/chat-output-sanitizers.test.ts` (12 tests). Behavior-preserving verbatim move; build + full suite green.
- **soc-02 step 3 (medium)** — extracted the pure prompt builders `buildAsyncExecutionPrompt` + `buildPeerSystemPrompt` (~90 LOC of system-prompt prose) out of `ipc/chat.ts` into `src/main/chat/prompt-builders.ts` with self-contained structural types (chat.ts's `PeerContext` / `asyncExecution` shapes pass through unchanged). The thin `buildClaudeAgentPrompt`/`buildCodexPrompt` wrappers stay in chat.ts (so the existing source-scrape convention test is unaffected). Added `test/chat-prompt-builders.test.ts` (10 tests covering the browser/extension/context branches the old source-scrape never exercised). Build + full suite green; tsgo unchanged at 169.
- **soc-02 step 4 — ChatTile decomposition (medium).** Extracted the pure Insight-block parser (`splitInsightSegments` + the open/close box-rule regexes + `ChatBodySegment`) out of the ~6.8k-LOC `ChatTile.tsx` into `src/renderer/src/components/chat/insightSegments.ts`; the React `InsightBlock` renderer stays. Added `test/insight-segments.test.ts` (7 tests for open/close/streaming-unclosed/backtick-dropped/`---`-is-not-a-close edge cases — coverage the embedded code never had). Behavior-preserving; build + full suite green. First gate-verifiable (no-click-test-needed) step of the renderer god-file decomposition.

### Adversarial tsgo triage (workflow) — 15 confirmed bugs from 37 candidates
A multi-agent workflow triaged every non-unused tsgo error (52 candidates across 20 files) and ran an independent skeptic per candidate prompted to *refute* it. 37 reached verification; **15 confirmed, 22 refuted** as guarded/test-only/narrowing-noise. Independent primary-source review then re-graded a few the agents over-confirmed (e.g. App.tsx:1186's `discovery.match` is reachable only when `hasCompatibleMatch` already proved it truthy — a TS-narrowing false alarm, not a crash). Applied the clean, gate-safe ones:
- **`autoAgentMode` missing from `TileState` (real type-completeness bug).** App.tsx writes `autoAgentMode` onto tiles at 5 sites and reads `tile.autoAgentMode` at 4093/5198, but the field was never declared on `TileState` — so the reads were typed as a non-existent property. Added `autoAgentMode?: boolean` to `src/shared/types.ts` (behavior-preserving — matches the established runtime). tsgo −2.
- **Relay test import bug.** `packages/codesurf-relay/src/runtime.test.ts` imported `CodesurfRelay` from `./types`, but it's exported from `./relay` (vitest strips the type-only import so the suite passed, masking it). Split the import. tsgo −1. (148→145, relay suite still 40 pass.)

**Confirmed real bugs flagged for you (not gate-safe / your call):**
- **vsix-drop crash (App.tsx:5893).** The drop handler calls `window.api.extensions.installVsix(...)` — but `window.api` is undefined (preload exposes `window.electron`) **and `installVsix` exists nowhere** in preload/main. Dropping a `.vsix` throws. This is a **feature gap**: either implement the `installVsix` IPC (+ a valid `ext:` TileType for the `addTile('extension', …)` at 5897) or remove the dead drop branch.
- **5 broken theme-token references (visual).** `theme.surface.overlay` (App.tsx:7037, ChatComposer.tsx:597/1032, ChatTile.tsx:1488) and `theme.surface.base` (CustomisationTile.tsx:143) reference tokens that **don't exist** on `theme.surface` → `undefined` → elements render with no background. `overlay` was never a real token (git confirms); `base` traces to commit `7955578` (same commit as the ImageTile crash). The fix-token is a design choice. Recommended: `overlay`→`panelMuted`, `base`→`panel`. Currently broken, so any valid surface token is an improvement — your eye picks the exact shade.
- **Low-value type-noise (left as-is):** App.tsx:1186 (narrowing false alarm, runtime-safe), index.ts:354 (dead `display-capture` comparison, harmless), mcp-server.ts:78 (`withDefaultSettings` handles it at runtime), App.tsx:736/738 (`AnchorPoint.gridX/gridY` unused), session-sources.ts:2005-2009 (`never`-narrowing). None affect runtime; deferred to avoid god-file churn for cosmetic tsgo wins.

### Holes discovered during the work (not in the original audit) — and fixed
- **InsightBlock `theme` crash (renderer).** `ChatTile.tsx`'s top-level `InsightBlock` referenced `theme.mode`/`theme.text.primary` but — unlike its 6 sibling components — never called `useTheme()`, so `theme` was undefined → a `ReferenceError` whenever an insight rendered. Surfaced while extracting the insight parser. Fixed with `const theme = useTheme()` (the established sibling pattern). tsgo 165→163.
- **ImageTile `theme` crash (renderer, core tile).** `ImageTile.tsx` (lazy-rendered from `App.tsx:4007`) referenced `theme.surface.app` / `theme.accent.base` / `theme.status.danger` / `theme.text.primary` **15×** with **no `useTheme()`/import/global source** — `theme` undefined → `ReferenceError` on every render of a core image tile. Introduced by commit `7955578 "Use theme tokens for UI colors and shadows"` (added the tokens, forgot the hook). Fixed with the import + `const theme = useTheme()`. **tsgo 163→148 (−15 real errors).** A repo-wide sweep confirmed only these two components had the pattern (`SkillInstallModal` was a comment-only false positive). **Runtime tail:** confirm image tiles + insight blocks render in-app (these were the two crash sites).

---

## Completion boundary — the precise edge of what's gated-completable here

The discriminator for every remaining item: **is there an automated gate (build or
test) that proves the change preserves behavior?** If no, it can't be completed in
this headless context without either a product decision or the app's run/click-test
loop. The residual, each with its one-line disqualifier:

| Item | Why it cannot be completed here |
|------|----|
| `refactor-01` App.tsx decompose | renderer, no runtime gate — user scoped it as "run/click-test between steps" |
| `refactor-02` ChatTile decompose | same — and `dup-04` already proved blind renderer surgery ships breakage |
| `perf-01/05/06/07` canvas memo, virtualization, streaming re-parse | hot-path; needs runtime profiling, no behavior-preserving gate |
| `perf-04` indexer cache | only with a test proving hit==miss + invalidation-on-write; couldn't author one without the live DB path → deferred |
| `gap-06/08`, `sl-01/02/03/04` | net-new features (auto-skill *generation*, provenance), not fixes; no existing behavior to preserve |
| `daemon-03` jobId cancel | cancel IPC is build-only-dead until the `MainStatusBar` UI wires it (renderer) — IPC+UI must land together to be non-dead and verifiable |
| `daemon-05` checkpoint retention | core (jobs+timelines sweep) **is done**; checkpoint-record pruning crosses into `checkpoints.mjs` + per-workspace `.contex/checkpoints` dirs — entangled, deferred like the ChatTile half |
| `daemon-05` `readDaemonJobRecords` mtime-cap | server-side dashboard scan, not unit-reachable in the manager harness; no behavior-preserving gate |
| `dup-03` `_fs-util.mjs` | consolidating divergent helper variants risks untested edge-behavior change; the *collision* half is already fixed (rel-05); marginal |
| `dup-05` model constants | the daemon `.mjs` can't import a TS shared module, so cross-process consolidation stays partial; Low sev. (One trivially-gated crumb exists — a `DEFAULT_CLAUDE_MODEL` const shared by `provider-executor.ts` + `chat.ts` — left out as optional, not disqualified: it's a 1-line dedupe with negligible payoff.) |
| `dup-06` TTS/STT key/fetch helper | Low sev "only if actively maintained"; `getSecret` dep makes the helper untestable without mocking — no clean gate |
| `soc-07` `@codesurf/relay` alias | tsconfig-path cosmetics; no behavior change, no gate, no user-visible value |

Everything above this line in "Fixed" met the gate and is build+test-verified. Everything
in this table genuinely requires the user (a product call, or the run/click-test loop the
headless context can't drive) — that is the legitimate completion boundary.

## Deliberately staged (not applied) — and why

These need a product decision, runtime verification of the Electron app (which
can't be exercised here), or fall under the repo's "confirm before removing dead
code" policy. Each is fully specified in its section file.

**Large structural refactors (L, ref-coupled — unsafe to do blind):**
- `refactor-01/02/03` — decompose `App.tsx` (7.3k), `ChatTile.tsx` (6.8k), `ipc/chat.ts` (4.2k). These thread mutable refs across handlers; a blind rewrite without click-testing the app risks shipping it broken. See `01-refactor.md`.
- `perf-01` (canvas memo boundary), `perf-04/05/06/07` (indexer cache, virtualization, streaming re-parse) — hot-path changes needing runtime profiling.

**Behavior / product decisions:**
- **`gap-03`, `risk-04`, `risk-06` — now FIXED** (user made the product calls; see "Fixed" above). Each shipped its gate-able main-process core + tests, with the documented runtime tail (SettingsPanel display, media/screenshot features, cookie-approval UX) for in-app verification.
- Still deferred: `gap-06` (confine renderer-supplied workspace paths — could reject legit paths), `gap-08` (cluso-embed provenance/build), `sl-01/02/03/04` (auto-skill *generation*, surfacing discovered skills to the model, cloud-memory parity, reinforcement signals).

**Daemon (M, runtime-wedge risk without exercising the daemon):**
- `daemon-01` (job concurrency scheduler/semaphore), `daemon-03` (jobId cancel IPC + status-bar wiring), `daemon-05` (TTL retention sweep), `daemon-07` (debounce metadata writes on the streaming hot path).

**dup-04 — NOW FIXED the safe way (see the "Fixed" section above).** The first attempt reverted because it was a blind deletion: `react-jsx-parser`'s nested `@types/react@18` was the sole provider of the global `JSX` namespace ~58 renderer files depend on, so removing it added ~174 type errors. The proper fix — add the explicit `declare global { namespace JSX }` → `React.JSX` shim *first*, then remove the dependency — has now been applied and validated against the typecheck (tsgo 165, down from 169) + build (green) loops the user authorised. The renderer no longer carries a load-bearing transitive React-18 types dependency.

**Note on the typecheck gate.** The project's `npm run typecheck` uses `tsgo` (`@typescript/native-preview`), which **under-reports** (it showed ~171 where real `tsc` shows ~344 — it skips much of `noUnusedLocals` and the relay tests, and its incremental state can mask errors until a cache invalidation). I gated on "tsgo count not increasing" + `npm test`; treat tsgo numbers as a floor, not truth.

**Consolidations (M, mechanical but broad):**
- `dup-03` full (`_fs-util.mjs` — the *collision* part is already fixed via rel-05), `dup-05` (model-list single source), `dup-06` (TTS/STT key/fetch helper), `soc-02` (extract `chat.ts` prompt conventions), `soc-07` (`@codesurf/relay` alias), `daemon-10`/`soc-03` (session-index app/daemon consolidation).
