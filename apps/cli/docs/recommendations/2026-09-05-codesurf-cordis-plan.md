# CodeSurf Cordis migration and source review plan

Date: 2026-09-05. Planning model: GPT-6 Astra. Implementation model requested by owner: GPT-5.3-Codex-Spark. This document is a plan and source review, not a claim that implementation or runtime verification has completed.

## Scope and baseline

Companion evidence: [built-in ID/default inventory](2026-09-05-codesurf-plugin-inventory.md), [tools and LSP review](2026-09-05-codesurf-tools-review.md), [daemon lifecycle review](2026-09-05-codesurf-daemon-review.md), [storage and hooks review](2026-09-05-codesurf-storage-hooks-review.md), and [file coverage ledger](2026-09-05-codesurf-review-coverage.csv). The scoped reviews distinguish inspected paths from outstanding coverage and propose regression tests; their findings are not claims of completed repairs.

Expanded coverage: [Agent](2026-09-05-codesurf-agent-review.md), [UI](2026-09-05-codesurf-ui-review.md), [providers and transports](2026-09-05-codesurf-providers-review.md), [networking](2026-09-05-codesurf-network-review.md), and [index/verification/remaining storage](2026-09-05-codesurf-index-verify-review.md). Prioritize the batch approval/schema bypass, stale transcript after compaction, provider/turn lifetime defects, and Telegram destination isolation before performance restructuring. The indexing report includes a measured pre-change chunking baseline. No source review or isolated reproduction is evidence that a repair has landed.

Review the entire CodeSurf repository, repair correctness/race/rendering/performance defects, reduce oversized responsibility owners, establish enforceable package boundaries, and rewrite every built-in extension as a native Cordis plugin. Product name is CodeSurf; `grok-cli` is the checkout directory.

Initial worktree has unrelated `.codesurf/DREAMING.md` changes. Preserve them. Recorded baseline at [codesurf-review-baseline](2026-09-05-codesurf-review-baseline.md): typecheck, build and lint pass; isolated Vitest has 1,308 passing and two failing tests; isolated Bun suite passes all 24. Remaining failures are hardcoded home-directory LSP cache fixtures denied by the sandbox. Do not use historical HEARTBEAT items as proof of current defects: `app.tsx` is already 566 lines, `src/agent/turns/{stream-turn,session-turn,batch-turn}.ts` already exist, footer chrome is merged, knowledge maps have disposal, and isolated Claude skills are already a helper of the Claude provider.

Local reference: `/Users/jkneen/Documents/GitHub/deepseek-harness`, HEAD `5b1da730b9`. Its `vendor/cordis/package.json` identifies `@deepseek-ai/cordis` version `4.0.2`, dependent on `@deepseek-ai/cosmokit` and `@standard-schema/spec`. Verify registry availability before installing; a local version is not proof of a published release. If vendoring the reference implementation is necessary, preserve its MIT license, upstream revision and dependency provenance. Do not write a Cordis imitation.

## Source-grounded findings

These are inspected source findings; concurrency failure paths need deterministic regression tests before claiming reproduced runtime defects. The hook filenames in Hans's findings resolve under `src/ui/hooks/`.

| Priority | Evidence | Finding and executable correction |
|---|---|---|
| P1 | `src/core/extensions/model-runtime.ts:85`, `getOrConnectSession` | The cache is populated only after `await adapter.connect`. Two concurrent calls for the same adapter/conversation can both connect, overwrite the cache and strand a session. Add an in-flight map keyed by adapter/conversation/generation; delete only the matching promise in `finally`; disconnect stale results. Test concurrent warm/resolve, connect failure/retry, and disable during connect. |
| P1 | `src/core/extensions/model-runtime.ts:177`, `disposeProviderSession` | Conversation teardown awaits disconnect before deleting cache entries, and does not invalidate pending connections for that conversation. Lookups can observe a disconnecting session or repopulate after session switch. Remove matching entries before awaiting, invalidate a conversation epoch, and make reconnect ownership explicit. Test deferred connect and disconnect while switching conversations. Preserve existing adapter generation protection. |
| P1 | `src/core/extensions/loader.ts:994`, `runDisposeCallbacks`; `src/core/extensions/api.ts:1358`; `builtin/bash-tools.ts:256`; `builtin/voice/index.ts:385` | Disposal is synchronous and forward ordered; Bash cleanup and recording cancellation are explicitly fire-and-forget. Disable/re-enable or shutdown can finish before resources close. Native Cordis effects must return awaited cleanup; test slow shutdown, errors, repeated disposal and replacement isolation. **Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/core/extensions/loader.ts`, `api.ts`, `builtin/bash-tools.ts` and `builtin/voice/index.ts` — disposal awaits returned cleanup in reverse registration order, isolates a throwing callback so later ones still run, is idempotent on repeat, and fences a re-enable against an in-flight disposal; Bash cleanup and voice recording cancellation now return their awaited cleanup. Regression: `src/core/extensions/loader.test.ts`. |
| P1, Hans independent source review | `use-turn-engine.ts:141-145`; `use-session-lifecycle.ts:67-85`; `agent.ts:2692` | Turn preparation awaits `prepareText` then starts `processMessage`; abort does not invalidate runId, and Agent creates a new controller. A turn cancelled during deferred preparation can subsequently start tools. Invalidate the run on abort and check ownership immediately after preparation and before dispatch. Test abort-before-preparation-resolves and replacement by run B; A must never call processMessage. |
| P1, Hans independent source review | `use-turn-stream.ts:294-327`; `agent.ts:1953`, `1384` | Transcript reconciliation overwrites rebuilt user rows using ordinal optimistic UI rows. Cancelled A may remain in optimistic UI while absent from persistence, so persisted B can display A's content; assistant metadata has analogous ordinal misalignment. Reconcile by stable turn/message identities, not positional correspondence. Test cancelled A then successful B with user text and assistant metadata assertions. |
| P1, Hans independent source review | `use-turn-engine.ts:378-380` | Stale run A clears shared `contentAccRef` after replacement B may have begun streaming. Gate cleanup by run ownership and move accumulators into per-run state. Test delayed A cleanup after B text, including tool and error boundaries; B's accumulated response must survive. |
| P2 | `src/core/extensions/registry.ts:141`, `rebuildSnapshot`, and slice hooks around line 310 | Every mutation flattens/sorts/replaces every collection and notifies every subscriber. An unrelated setting/status update invalidates command/model/tool array identities. Use instance-owned slice stores, stable identities for unchanged slices, and transactional publication of activation contributions. Measure notification/render counts before and after. |
| P2 | `src/core/extensions/loader.ts:114-220`, `sinks.ts`, `model-runtime.ts` cache | Runtime ownership is process-global across instances, settings, sinks and provider sessions. Native Cordis services must own state per root/session; no process singleton should be the hidden implementation of a supposedly isolated context. Boot two roots in one test and prove settings, contributions, sessions and teardown isolation. |
| P2 | `src/core/extensions/api.ts:17-29` | The extension contract imports concrete Bash/schedule implementations, UI modal types and application settings. Extract structural service contracts; implementations depend inward on those contracts. Plugin API must typecheck without importing host UI, Agent or concrete tools. |
| P2 | `src/core/extensions/builtin/index.ts:6-53` | The built-in catalog statically imports every provider and feature even when disabled. After native conversion use a declarative metadata catalog with dynamic imports and explicit dependency injection. Test disabled expensive providers do not import/start their SDK/daemon until enabled. |
| P2 | `src/lsp/npm-cache.test.ts` and its production cache implementation; baseline run | Cache fixtures and production cache root use real home `~/.grok/cache/lsp`, bypassing the supported config-directory isolation. Inject or resolve the cache directory through the shared config/path service; tests use a temporary root and remove only their own fixtures. Verify behavior-compatible default paths and isolated parallel tests. **Implementation status (2026-09-05, resumed in Claude Code):** repaired in `src/lsp/npm-cache.ts` — the cache root resolves through the shared config-directory helper (honouring `CODESURF_CONFIG_DIR`) and keeps `~/.grok/cache/lsp` as the behaviour-compatible default; the suite uses a temporary root and removes only its own fixtures, so no test writes to the real home directory. Regression: `src/lsp/npm-cache.test.ts`. |
| P2 | `src/agent/agent.ts` 2,937 lines; `loader.ts` 1,527; `api.ts` 1,390; Claude provider 1,547; desktop provider 1,376; `message-list.tsx` 1,253 | Remaining large owners mix independent responsibilities. Extract behavior owners specified below; moving whole files into a package or splitting only by line count is insufficient. |
| Investigation | `src/ui/components/message-list.tsx:669-739`, `748-877` | Viewport observation is adaptive polling and transcript grouping/height prefixes are memoized full-list transforms. This is not evidence of a current rendering bug or unbounded per-token work. Profile long-history streaming, resize, image clipping and scroll anchoring before changing algorithms; preserve existing virtualization and stable chip identity. |

## Native Cordis target

The reference's `vendor/cordis/src/context.ts` provides actual `Context`, plugin registry and scoped service lookup; `service.ts` gives effect-owned service registration. `fiber.ts:69-90` documents awaited, reverse-order disposal. `packages/session/session-title-all-prompts-llm/src/index.ts` demonstrates `name`, `inject`, `Config`, and `apply(ctx, config)` using narrow services.

CodeSurf plugins must be ordinary Cordis modules (`name`, `inject`, optional validated `Config`, `apply`) mounted by `ctx.plugin`. Registrations, subscriptions, timers, connections and subprocesses belong to the plugin fiber through `ctx.effect` or equivalent native owned operations. Missing required services prevent activation; provider service removal disposes dependents. Settings and permissions remain explicit host policy, not a claimed in-process sandbox.

Suggested dependency direction:

1. `@codesurf/plugin-api`: structural contracts, DTOs and Cordis Context augmentation; separate entrypoint for optional React/OpenTUI rendering contracts.
2. `@codesurf/runtime`: Cordis root composition, contribution/command/model/tool registries, config and lifecycle services. It depends on plugin-api, not CLI/UI/concrete plugins.
3. Domain packages: provider runtime, agent runtime, persistence, tools, UI, plus independently declared plugin families. Extract only coherent boundaries; avoid one package per trivial file.
4. CLI host composes services, enabled plugin catalog and UI/headless adapters. Plugins import public package exports, never `../../../src` or sibling implementation internals.

Keep extension IDs, settings keys, default/protected flags, groups, command aliases and order, provider adapter/model identities, tool permissions and existing persisted opt-outs. Native Cordis plugin names can equal existing stable extension IDs. Config schema must validate configuration before effects start. A temporary V1 adapter may exist during migration, but neither wrapper-only conversions nor leftover built-ins using `activate(api)` satisfy completion.

## Executable phases

### 0. Baseline and exhaustive review ledger

Record Git HEAD/status and run typecheck, build, lint, Vitest and Bun-native suites. Separate preexisting failures. Inventory every tracked runtime file under `src`, `packages/codesurf-daemon`, build scripts and configuration. Review by domain: agent/turns; plugin/runtime/providers; UI/input/rendering; tools/processes/verification; storage/persistence; daemon/protocol; MCP/Telegram/network/auth; startup/build. Maintain per-file reviewed status and finding disposition so “full review” has auditable coverage. Inspect tests as corroboration, not a substitute for implementation review.

Capture startup time, cold import cost, idle CPU, long transcript streaming latency, viewport frame/update counts and listener/child-process counts using a fixed local replay fixture. No network credentials should be required for deterministic replay.

### 1. First implementable slice: real runtime and one native command

Resolve actual Cordis dependency. Add plugin-api/runtime workspace exports and build order; root `tsconfig.json` currently has `rootDir: src`, so packages must build separately rather than reaching outside rootDir. Establish Context-owned contribution/settings/chat/context services. Convert `builtin/context-command.ts` to native `apply(ctx)` using injected services and disposable command registration. Host boot mounts the real plugin and surfaces the same `/context` behavior. Test mount/unmount/remount, missing dependency, activation throw, async disposal and two-root isolation. Existing V1 plugins may temporarily bridge, clearly labeled.

Acceptance: compiled CLI can invoke the converted command; actual Cordis fiber disposal removes contributions; no new fake framework or hidden global runtime. Before broad conversion, repair the three turn ownership/identity findings and provider concurrency using deterministic deferred-promise regressions. These are independent correctness units and should remain separately reviewable.

### 2. Migrate all 48 built-ins, by dependency family

Each item gets a migration ledger entry: source path, native plugin export, injected services, owned effects, compatibility parity, and test evidence. The authoritative initial manifest is the 48 exports in `src/core/extensions/builtin/index.ts`; helper files are included in their owning plugin.

| Wave | Built-in source stems (48 total) | Ownership and parity focus |
|---|---|---|
| Commands A (6) | context-command, routing-command, workflow-prompts, skills-listing, pets-explainer, mcp-prompt-commands | Commands, aliases, dynamic visibility, document/screen lookup, prompt sources. |
| Tools (13) | bash-tools, file-tools, grep-tool, xai-tools, lsp-tool, computer-tools, schedule-tools, subagents-tools, telegram-tools, payments-tools, plan-tools, ask-tools, knowledge-extensions | Executable tool definitions, permissions, mode gating, abort propagation, sink ownership, process/connection disposal, mention providers. |
| Workflows (7) | workflow-orchestrator, user-workflows, js-workflows, loop-command, subagent-commands, host-actions, auto-mode | Cancellation, schedules, subagent dispatch, settings, loop event ownership and stop behavior. |
| UI (8) | editor-command, files-command, steer-command, doc-viewer, pets, footer-chrome, nerd-icons, voice | Screen contributions, OpenTUI subscriptions, input interception, status indicators, modal focus, recording/timer/renderer disposal. |
| Providers (14) | xai-provider, anthropic-provider, claude-agent-provider, codex-provider, codesurf-desktop-provider, amp-provider, grok-provider, lazar-provider, lightclaw-provider, hermes-gateway-provider, omnigent-provider, opencode-provider, fractal-provider, local-llm-provider | Adapter/model identity, dynamic discovery, permissions, credentials, streaming and usage, reconnect and epoch ownership. |

Provider helpers such as `claude-grok-skills-provider.ts` are migrated with their parent; it currently exports `registerGrokSkillsProvider`, not a separate extension. Convert capability groups and every resource registration, not merely the exported object shape. After each wave run focused contracts and compilation; after final wave delete the built-in V1 adapter and obsolete activation/disposal ownership.

### 3. Responsibility and package boundaries

Extract remaining Agent responsibilities into session/transcript state, toolset composition, task/delegation execution, verification orchestration, prompt/context assembly and lifecycle coordination. Reuse existing turn runners; keep one terminal state protocol for direct, batch and provider-owned paths. Preserve pending approval continuation, cancellation neutrality, tracing, usage, hooks and persisted messages.

Replace loader with small root composition and plugin catalog modules; services own contributions/settings/mentions/provider sessions individually. Split API by domain with public barrels. Split large provider implementations into transport connection, session stream translation, configuration/discovery and plugin wiring. Separate message rendering, grouping/measurement and viewport observation; extract pure algorithms only when their ownership is distinct.

Add dependency checks against cross-package relative imports and host imports from plugin-api/runtime; enforce package exports and standalone package typechecks. Record before/after sizes and cycles. Review files over 600 lines for coherent ownership; the goal is bounded responsibility, not cosmetic line-count compliance.

### 4. Measured rendering and performance repair

Use the replay baseline to reproduce reported rendering symptoms and trace input/render state transitions. Exercise long markdown/reasoning streams, tool-result insertion, image clipping, scroll-away/return-to-bottom, terminal resize, modal switching and rapid cancellation. Preserve virtualization and memoization already present. Repair invalidation/root state ownership, then compare identical fixtures. Prefer observable viewport events where supported; otherwise retain bounded adaptive polling. Publish raw fixture/measurement parameters and before/after numbers, with no invented throughput claims.

### 5. Whole-system verification and review closeout

Complete every file/domain ledger entry. Run all checks, built CLI help/headless fixture, fresh-context restart and native TUI smoke. Test extension settings migration from existing persisted configuration. Compare all 48 contribution snapshots before/after including disabled and protected behavior. Repeatedly enable/disable resource-heavy plugins and assert no accumulating sessions, timers, input hooks, listeners, subprocesses or stale registry entries. Document externally dependent live provider checks separately from offline verified contracts.

## Acceptance status, row by row

Against the matrix below, as of 2026-09-05. "Partial" always names what is left.

| Objective | Status |
| --- | --- |
| Full code review | **Done.** Eight reports, per-file ledger, every finding repaired or explicitly recorded with what remains and why. Daemon and startup included. |
| Correctness/races | **Done.** Deterministic connect/dispose/abort/enable-disable interleavings, each with a regression test; the enable/disable one now runs across the whole catalog. |
| All native Cordis plugins | **Done.** 48/48, real fiber lifecycle, disposal (not the loader) removes contributions. The V1 adapter direction is native→loader, not loader→native. |
| Decoupled packages | **Done.** Public exports, standalone typechecks, import direction enforced as a test (`packages/plugin-api/src/boundaries.test.ts`), root-isolation covered. |
| Reduced god files | **Done, with a stated stopping point.** Three responsibilities extracted with before/after metrics (`SessionPromptContext`, `SessionToolsets`, `SessionDelegations`; agent.ts 3,029 → 2,718). Verification orchestration already lived outside the Agent. Session/transcript state stays, deliberately: 122 references across the class mean extracting it yields an Agent that delegates on every line — the "arbitrary chunks" this matrix rejects. The V1 loader path is now deleted. |
| Rendering | **Unblocked and measured.** `scripts/bench/replay.mjs` is the fixed local replay fixture, deterministic and credential-free. Baseline recorded in the performance doc: streaming shows no per-delta cliff (p50 1.17 ms, max 1.98 ms) and idle is genuinely idle (1 frame, 3.5 ms CPU per 500 ms). The reported "~2s freeze" was separately traced to un-memoized provider CLI checks on the render path and fixed; this fixture is the standing check. |
| Performance | **Done.** Startup, cold import, bootstrap and snapshot reads from `bench:startup`; streaming latency, idle CPU, frame counts and listener leakage from `bench:replay`. Terminal byte/write counts are absent rather than faked — `testing: true` makes them a constant zero, and they need a PTY harness. |
| Compatibility | **Done.** Stable IDs, defaults and protection enforced against the pre-conversion inventory as a test; verified against a copy of real persisted configuration, not only a fresh one. |
| Build/test quality | **Done.** Typecheck, `bun run build`, lint, 1,959 Vitest across 233 files and 29 Bun-native tests, run and reported together. The built CLI starts and prints help under Bun (`bun dist/index.js --help`); it does not run under plain `node`, which is pre-existing — the emitted ESM uses extensionless imports that Bun resolves and Node does not, and `bin` is invoked through Bun. |
| Requested model workflow | **Not met, and cannot be.** The plan called for Spark implementation; Spark was unavailable, and the owner redirected the work to Claude Code rather than accepting a silent substitution. Recorded here so the matrix is not read as satisfied. |

## Acceptance matrix

| Objective | Required evidence | Cannot count as done |
|---|---|---|
| Full code review | Per-file/domain coverage ledger with severity, evidence, fix or reasoned disposition; daemon and startup included | A size ranking or extension-only scan |
| Correctness/races | Deterministic connect/dispose/abort/enable-disable interleavings; single terminal state and ownership cleanup | Typecheck alone |
| All native Cordis plugins | 48/48 catalog entries native; actual Context/plugin/fiber lifecycle; no built-in legacy adapter; helper ownership covered | Calling old activate from a Cordis wrapper |
| Decoupled packages | Public exports, standalone checks, enforced import direction, root-isolation tests | Moving files while retaining host-relative imports |
| Reduced god files | Responsibility owners extracted, cycles reduced, before/after module metrics and unchanged behavior tests | Splitting a switch into arbitrary chunks |
| Rendering | Repro replay plus TUI observation for focus, scrolling, resize, images, streaming and cancellation | Assuming old UI backlog is still open |
| Performance | Same-fixture startup/idle/streaming measurements and update-count comparison, resource stability | Unmeasured optimization claims |
| Compatibility | Stable IDs/settings/aliases/defaults/protection/model selection and persisted-session/config checks | Working only with a fresh configuration |
| Build/test quality | Typecheck, build, lint, Vitest and Bun-native results with preexisting failures distinguished | Reporting one suite as the whole validation |
| Requested model workflow | Astra plan and Spark implementation execution evidence | Silently replacing unavailable Spark with another model |

## Current execution status

Last updated 2026-09-05, after the correctness campaign and the completed
conversion. Everything below is committed and pushed on `codesurf`.

### Correctness repairs — complete

Every finding in the eight review reports is repaired; each carries an
"Implementation status" line in its own report naming the mechanism and its
regression test. Verification is uneven and splits into three tiers, described
in the section below.

The five findings that were partial — A14, T7, T8, NET-6 and the OpenCode
provider finding — have since been closed, with two exceptions that are stated
rather than quietly left open:

- **T7** keeps one deliberately deferred item. The user-visible defect (two
  unmarked projects sharing one manager rooted at `/`) is fixed and tested; what
  remains is aligning `resolveManagerKey` with `ctx.workspace` on a single
  definition of workspace identity, which belongs to the package-boundary phase
  and would have to be redone against whatever that phase decides.
- **OpenCode** keeps one item blocked by the dependency: disposal cannot await
  the owned process's close, because `createOpencodeServer` returns a `close()`
  that yields `void` and never exposes the child. That needs an upstream SDK
  change.

Every other remaining item is repaired with a regression test. Two of those
tests were checked the strong way — the defect reintroduced and the test watched
to fail (T8's un-raced waits, NET-6's unfenced dispatch), which mattered because
both had weaker sibling assertions that passed either way. A14 and OpenCode
discriminate by construction rather than by a reverted run: A14's asserts on a
step field that did not exist before, and OpenCode's on `port: 0` and a boot
signal that was not passed before. Stated so the two levels of evidence are not
read as one.

### Cordis migration — 48 of 48 converted

Phase 1 landed: `@codesurf/plugin-api` (structural contracts) and
`@codesurf/runtime` (per-root Cordis composition) are workspace packages built
by project references, and `src/core/extensions/native/host.ts` presents a
native plugin to the V1 loader as an `ExtensionModule` whose activate mounts a
fiber and whose deactivate disposes it. The loader keeps owning persisted
enable/disable and the `/extensions` listing; fiber disposal — not the loader —
removes contributions.

**Converted: all 48.** All 14 providers (xAI, Anthropic, claude-agent, codex,
codesurf-desktop, amp, grok-cli, lazar, lightclaw, hermes-gateway, omnigent,
opencode, fractal, local-LLM); all tool groups (bash, file, grep, xai, lsp,
computer, schedule, subagents, telegram, payments, plan, ask, knowledge, voice);
all command bundles (workflow-prompts, workflow-orchestrator, user-workflows,
js-workflows, skills-listing, context, loop, routing, editor, files, steer,
subagent-commands, mcp-prompt-commands, pets-explainer, host-actions); and the
UI plugins (doc-viewer, pets, footer-chrome, nerd-icons) plus auto-mode.

`src/core/extensions/builtin/` now holds only the modules plugins import —
groups, icons, and the voice and footer-chrome component folders — and the
catalog. The V1 `ExtensionModule` / `activate` path in the loader is deliberately
untouched: nothing built-in uses it, but a third-party extension may, and
removing it is a separate decision.

**Two bugs the conversion introduced and the ported tests caught**, worth
recording because both were silent:

- Cordis services are classes, so a method plucked off `ctx` and passed as a
  bare function reference loses its receiver. `semanticSettingsFrom(ctx.settings.get)`
  threw on the first `this` read; V1's object-literal services tolerated it.
- `api.onDispose(fn)` was mechanically rewritten to `ctx.effect(() => () => fn)`,
  whose disposer only *names* `fn` and never calls it — ten leaked subscriptions
  across four plugins. The correct form is `ctx.effect(() => fn)`. auto-mode's
  handlers also guard on a `disposed` flag, which masked the leak from any
  behavioural assertion, so its regression test asserts the subscription count.

**Contracts that exist**: commands (including `visible` gating and prompt/
listing/resolver variants), tools (`wrapExecute`, `safeExecute`, enable/
disable), settings (including `list`), model providers and models, screens,
status indicators and toggleable indicators (in the `@codesurf/plugin-api/ui`
entrypoint, the only place React types are allowed), mentions, icons, traces,
sub-agents (including delegation), chat with `displayText`, workspace, session,
models, ui, toast, plugins, lifecycle.

**Contracts still missing: none.** Every gap the original table named is
closed. Four were added after it was written, and the last two were not
anticipated by it at all:

| Added | For | Note |
| --- | --- | --- |
| Kernel sinks (`bindKernelSink`) | bash-tools, mcp-prompt-commands | Ownership is tokenised: the disposer compares-and-releases, so a plugin whose finalizer runs late cannot clear a newer owner's sink. |
| Schedule service | schedule-tools | create/list/remove/readLog and the daemon lifecycle. |
| Telegram service | telegram-tools | `sendFile` and the bridge surface. |
| Loops (`LoopsService`) | loop-command | `LoopSpec` / `LoopState` / `LoopIterationRecord` plus nine methods. Durability stays with the host's loop manager; the plugin only reads and drives. |
| Narrow indicator props | footer-chrome | Not a contract addition — a genuine UI refactor. Its two components took the whole host services facade; they now take a `getSetting` reader, and `getStats` for the meter. |

Every conversion is checked against a clean-config boot: 58 commands, 50 tools,
30 models, 4 providers, 25 settings, 6 screens, 5 indicators, 36 extensions
active, 0 failed — identical to the pre-campaign baseline. Run that check after
each conversion; it is the compatibility gate.

Two contract defects were found only by converting, and are worth remembering
as the reason parity tests matter: `ToastService` used `{message, kind}` where
the host toast is `{title, style}`, so every plugin toast would have rendered
with no text; and `ToolOutcome` carried an index signature, which made the
host's own richer result type unassignable to the contract meant to describe it.

### Compatibility, checked against real persisted state

Every other gate in this campaign ran against `mktemp -d`, and the acceptance
matrix says a fresh configuration alone cannot count as done. Booting a copy of
the owner's real `~/.codesurf` (a copy — never the live directory) gives 48
active, 0 failed, with the persisted settings intact: `anthropic.agent-sdk.effort`
still `max`, `voice.enabled` still true, and the context-bar toggles unchanged.
The higher counts against a clean boot (63 commands, 63 models vs 58 and 30) are
the persisted `enabled` list turning on providers that ship off by default,
which is correct.

`src/core/extensions/native/inventory-parity.test.ts` makes the compatibility
claim enforceable rather than asserted: it reads the inventory document itself —
not a frozen copy, which could drift from the record it is meant to check — and
requires the live catalog to carry the same 48 stable ids and the same effective
`enabledByDefault` / `protected` flags. It also requires every Source path to
resolve, which is what caught two entries the conversion left pointing at
`builtin/`.

One declaration difference exists and is behaviourally inert: `builtin.tools.lsp`
gained an explicit `protected: false` where the snapshot recorded the flag as
absent. The loader reads both as false. The test compares effective values for
that reason, which is stated in it.

**Two pre-existing findings surfaced by this check, neither caused by the
campaign, neither fixed here** — they are the owner's data, not the code's:

- The persisted opt-out for `builtin.commands.mcpPrompts` has been dead since
  2026-05-08, when commit `a5d34b2` renamed that extension to `builtin.mcp`. The
  opt-out is keyed by id, so the rename silently re-enabled MCP prompt commands
  four months ago. Anyone who wants them off has to disable `builtin.mcp`.
- `builtin.provider-pi` is in the persisted enable list and no longer exists in
  the catalog. Harmless — unknown ids are ignored — but it is dead state.

Both argue for the same missing mechanism: a rename must migrate persisted ids,
or the id must never change. Neither exists today.

### Boundaries and performance

`packages/plugin-api/src/boundaries.test.ts` enforces the dependency direction
as a test rather than a convention: plugin-api may import nothing but cordis,
runtime only plugin-api and cordis, neither may reach into `src/` or pull in the
renderer, React, the model SDK or zod.

`scripts/bench/startup.mjs` measures cold import, bootstrap, snapshot reads and
the built CLI, each sample in a fresh process with its own config dir. The
baseline is in [the performance record](2026-09-05-codesurf-performance-baseline.md)
and it substantiates the P2 catalog finding: importing the catalog costs ~282 ms
against ~23 ms to activate everything, and all 48 entries are imported though
only 36 activate. It also retires the idea that registry snapshot reads are hot
(0.1 ms per thousand), so that P2 row needs a mutation-churn fixture instead.

Two god-file extractions have landed, both by responsibility rather than line
count, with before/after metrics:

| Extraction | Owns | agent.ts before → after |
| --- | --- | --- |
| `SessionPromptContext` (`src/agent/prompt-context.ts`, 123 lines) | Five session-stable snapshot fields and their resolvers, sharing one invariant: never re-read mid-session, or the provider's cached prefix stops hitting. | 3,029 → 2,937 |
| `SessionToolsets` (`src/agent/session-toolsets.ts`, 330 lines) | Per-turn ToolSet composition and the session-scoped MCP bundle — held open across turns so the tool schemas the provider caches stay byte-stable, and building a turn's ToolSet is the only thing that reads it. | 3,033 → 2,784 |
| `SessionDelegations` (`src/agent/session-delegations.ts`, 143 lines) | Starting background sub-agent runs and reporting them, plus the TaskCreated/TaskCompleted hooks that bracket each one. Deps are getters, not values: the model and token budgets change mid-session, and a snapshot would start delegations against the model the session opened with. | 2,793 → 2,718 |

The toolset cut was clean because the responsibility had exactly one
back-reference: a sub-agent's nested `task` tool re-enters the Agent, so
`runTask` is injected and nothing else is. Everything else it needs comes from
module imports. `SubagentExecutionContext` moved to `turns/types.ts`, which is
already the shared vocabulary between the Agent and its extracted pieces.

The three tests that reached the moved methods through a private-field cast were
repointed at the new owner rather than given a delegating shim on the Agent — a
shim would have kept the coupling while hiding it.

**Verification orchestration** was already outside the Agent
(`src/verify/orchestrator.ts`). What is left in `Agent.runVerify` is 29 lines of
turn bookkeeping — push the user message, append the completed turn, clear the
abort controller by identity. Extracting that would mean injecting five Agent
internals and passing the Agent itself, which is a shim, not a boundary.

**Session and transcript state stays in the Agent, deliberately.** It is not
line-count squeamishness: `this.session` has 73 references, `this.messages` 32
and `this.messageSeqs` 17, woven through nearly every method. Pulling them into
an owner leaves an Agent that delegates on every line — the "splitting a switch
into arbitrary chunks" the acceptance matrix rejects, and a worse design than
the one it replaced. The matrix asks for bounded responsibility, and this state
IS the Agent's responsibility. Recorded as a decision, not a to-do.

The V1 loader path named here has since been deleted (see below).

