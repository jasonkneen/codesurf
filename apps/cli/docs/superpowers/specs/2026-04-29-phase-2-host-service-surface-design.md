# Phase 2 #4+ — Host-Service Surface Design

**Status:** Proposal · 2026-04-29
**Phase:** 2 #4+ (proposed) — follows Phase 2 #1 (grep), #2 (lsp), #3 (read_file + mixed-mode file extension), all shipped.
**Goal:** Pick the host-service surface shape that lets the four remaining tool tiers (provider-coupled, mode-gated, BashTool+hooks, callback-coupled) migrate out of `src/grok/tools.ts` `createTools()` and into kernel-owned extensions, while keeping `services.*` honest about its surface area.

> **Decision required:** which option (a/b/c — or hybrid) governs Phase 2 #4 onward. Implementation is owner-gated and not started.

## Context

Phase 2 #1–#3 shipped three migrations using a single recipe:

| Phase | Tool | Commit | Surface used |
|---|---|---|---|
| 2 #1 | `grep` | `5195c60` | `services.workspace.cwd()` |
| 2 #2 | `lsp` | `bc61e6d` | `services.workspace.cwd()` |
| 2 #3 | `read_file` | `df25799` | `services.workspace.cwd()` |

All three share the same minimal dependency: **`cwd`, read lazily at execute time so post-`cd` drift inside bash stays correct**. They migrated cleanly because the kernel already exposed exactly that primitive.

Phase 2 #3 also discovered the **mixed-mode pattern**: a single extension's `activate()` can mix kernel-owned `api.registerTool({ ..., tool })` calls with metadata-only `api.registerTool({ ... })` declarations under one manifest. `builtin.tools.file` uses this — `read_file` is kernel-owned; `write_file` and `edit_file` are still metadata-only with execution in `createTools()`. The mixed-mode pattern means we can migrate tier-by-tier without ever splitting a logical group across two extensions.

The remaining tools in `createTools()` fall into four tiers, each with a different shape of host coupling:

### Tier inventory (current `src/grok/tools.ts`)

**Tier A — Provider-coupled (4 tools):**
`search_web`, `search_x` call `provider.responses(MODEL)` and `provider.tools.webSearch()/xSearch()` for embedded ai-sdk searches via the Responses API. `generate_image`, `generate_video` call `generateImageTool(provider, ...)` / `generateVideoTool(provider, ...)`. All four take a concrete `XaiProvider` instance.

**Tier B — Mode-gated (14 tools, agent-mode only):**
12 `computer_*` tools, plus `write_file` and `edit_file`. All gated on `mode === "agent"`. (Plus `generate_plan` gated on `mode === "plan"`, but that's a separate one-off.)

**Tier C — BashTool + hooks (4 tools):**
`bash` (which also runs the pre/post-tool hooks pipeline), `process_logs`, `process_stop`, `process_list`. All take a concrete `BashTool` instance and share its background-process registry. `bash` additionally needs `executePreToolHooks` / `executePostToolHooks` / `executePostToolFailureHooks` from `src/hooks/index`, plus `options.sessionId`.

**Tier D — Callback-coupled (~12 tools):**
- `task` ← `options.runTask`
- `delegate`, `delegation_read`, `delegation_list` ← `options.runDelegation` / `readDelegation` / `listDelegations`
- 7 `schedule_*` tools ← `options.scheduleManager: ScheduleManager`
- `telegram_send_file` ← `options.sendTelegramFile` (only set when bridge active)
- `wallet_info`, `wallet_history`, `fetch_payment_info`, `paid_request` — these dynamic-import their dependencies (`WalletManager`, `PaymentHistory`, `X402Service`); they have no real callback coupling, just lazy access. Listed under D for completeness.

### What `services.*` exposes today

```ts
ExtensionHostServices = {
  toast, commands, tools, models, settings, extensions,  // registry views
  chat: { dispatch, appendAssistant },                    // sink-backed
  workspace: { cwd },                                     // provider-backed
  ui: { action },                                         // sink-backed (HostAction union)
}
```

Five sinks bound by `app.tsx`: `toast`, `chat`, `assistant`, `ui-action`, `cwd-provider`. The kernel exposes `setXxxSink` / `setCwdProvider` for each. Sinks default to no-op until bound.

The lazy-binding pattern is consistent: tools call `services.workspace.cwd()`, which delegates to a provider that resolves at execute time. No service-shape inflation.

## Goal

Pick a host-service surface shape that:

1. Lets every tier migrate out of `createTools()` without re-writing `createTools()` end-to-end.
2. Keeps `services.*` minimal — each new entry is justified by ≥ 2 tools that need it, not speculative additions.
3. Preserves the lazy-binding pattern (no concrete instances leaking into manifests; everything resolved at execute time).
4. Allows tier-by-tier shipping. Each migration must be independently committable and revertible.

## Options considered

Three architectural options. Each has been mapped against the four tiers.

### Option (a) — Extend `services.*` per-tier

Add typed sub-interfaces to `ExtensionHostServices` for each missing capability:

```ts
ExtensionHostServices = {
  // ... existing ...
  bash:       { execute, startBackground, getProcessLogs, stopProcess, listProcesses, getCwd };
  runtime:    { mode };  // current AgentMode
  subagents:  { runTask, runDelegation, readDelegation, listDelegations };
  schedule:   ScheduleManager-shaped facade;
  telegram:   { sendFile };
  session:    { id };
}
```

Each new sub-interface is sink-backed (parallel to `chat`, `ui`, `workspace`). The agent binds the sinks at startup; tools read them lazily.

**Pros:**
- Concrete and typed. `services.bash.execute(...)` is self-explanatory; no string indirection.
- Matches the established pattern — `chat`, `workspace`, `ui` are already this shape.
- Sink defaults to no-op when unbound, mirroring existing behavior — tests stay simple.
- Each addition stands or falls on its own merits; nothing speculative.

**Cons:**
- `ExtensionHostServices` grows from 9 fields to ~14. The blast radius of a future API change is larger.
- Some additions are conditional. `services.telegram` only meaningfully works when the bridge runs; `services.runtime.mode` only matters in the host process. The kernel needs to model "this service is no-op in some configurations" — already true for sinks, but more facets to track.
- Risk of feature drift: each new sub-interface invites new methods over time.

### Option (b) — Filter at the merge step

Keep `createTools()` as-is. Use the kernel's tool registry purely as a *manifest layer* — every tool name is registered metadata-only via tool-group extensions; execution stays in `createTools()`. The kernel's `filterToolSetByEnabled()` already strips disabled-extension tools by name. Add mode-awareness to that filter (`RegisteredTool.modes?: AgentMode[]`) and call it done.

`createTools()` becomes "an internal builtin extension that lives in agent code". The kernel never owns tier-A/B/C/D execution.

**Pros:**
- Cheapest. ~20 lines of kernel code and `RegisteredTool.modes` metadata. Done in an afternoon.
- Zero `services.*` inflation.
- The mixed-mode pattern from #3 already has this shape for `write_file`/`edit_file` — option (b) just stops at exactly that point and declares the migration finished.

**Cons:**
- Violates the project's stated goal: *"minimizing the codesurf core TUI to its absolute bare minimum, with everything else as extensions"*. Tier B/C/D code still lives in `createTools()` permanently; they're "extensions" in metadata only. Anyone reading the codebase still has to grep through `tools.ts` for the `bash` impl.
- Tool authorship for third parties stays gated — there's no path for a user-installed extension to contribute a tool that uses BashTool, schedules, or sub-agents. The kernel can't help them because the kernel doesn't expose the runtime.
- Stops the migration short of where the dreaming-pass lessons point: the recipe (kernel-owned `tool({...})` def + lazy host-service binding) generalizes; (b) discards the generalization.

### Option (c) — Hybrid bind: `services.runtime.bind(toolName, fn)`

Introduce a parallel registry of *executors* keyed by tool name. Extensions declare schemas (and optional `tool({...})` defs); the agent binds executor functions per name.

```ts
// In agent.ts at startup:
runtimeBindings.bind("bash",         (input, ctx) => bashImpl(bash, hooks, input, ctx));
runtimeBindings.bind("schedule_create", (input, ctx) => scheduleManager.create(input));
runtimeBindings.bind("task",         (input, ctx) => runTask(input, ctx.abortSignal));
// etc.
```

The extension's `tool({...})` def (registered in the kernel via `api.registerTool`) calls `services.runtime.invoke(toolName, input, ctx)`, which dispatches to the bound executor. Unbound names crash at startup — fail-fast.

**Pros:**
- Single new abstraction (`services.runtime.bind` / `invoke`) covers all four tiers. No per-tier service surface inflation.
- Decouples schema (in the extension) from executor (in the agent). Lets us migrate schemas now and executors later, or vice versa.
- Third-party extensions get a clean path: declare a tool that calls `services.runtime.invoke("user.thing", ...)` — wait, no, that doesn't help third parties because the agent must explicitly bind. Scratch that.

**Cons:**
- Indirect. Two registries (RegisteredTool + runtime bindings) that must stay in sync. The compile-time type safety of (a) goes away — bindings are keyed by string.
- Doesn't actually solve the third-party case. Third-party extensions still can't write a tool that uses `bash` because they can't bind into the agent's runtime registry.
- Adds a layer that none of the three shipped migrations needed. We'd be paying complexity up front for flexibility that may never be used.
- The dreaming-pass lessons emphasize concreteness ("kernel exposes typed surface; lazy execute"). (c) trades typed for stringly-keyed.

## Recommendation

**Hybrid: per-tier home selection. Default to (a) when state is genuinely cross-tool shared; default to "extension owns its tools" when coupling is local; never (b) or (c) wholesale.**

The decision per tier follows from where the coupling actually lives. Two of four tiers don't extend `services.*` at all (provider-owned, self-contained); one extends with metadata-only changes (mode); one extends with cross-tool sinks (bash + callbacks). Calling this "option (a) with footnotes" overstates the surface inflation; calling it "hybrid" matches the tier-mapping table below.

The carve-outs prevent the (a)-shaped tiers' "surface inflation" downside from biting. They emerge from looking at each tier's actual coupling rather than treating all four uniformly:

### Carve-out 1 — Provider-coupled tools live in their owning provider extension

Tier A's four tools (`search_web`, `search_x`, `generate_image`, `generate_video`) are xAI-specific. They have no business living in a generic `services.*` field. The cleanest home is the xai-provider extension itself — once it owns the runtime `XaiProvider` instance (Phase 3b dependency, see Risks below), it can register the four tools with full kernel ownership in its own `activate()`. No new host-service surface needed.

This matches `RegisteredScreen` prior art: extensions own their UI (`api.registerScreen`); they should own their tools too. The HostAction union already has `open-screen`/`close-screen` variants for cross-extension use; provider tools are a similar self-contained unit.

### Carve-out 2 — Wallet/payments self-contain

`wallet_info`, `wallet_history`, `fetch_payment_info`, `paid_request` already dynamic-import their dependencies. They need only `cwd` (already exposed) and `sessionId` (which only `paid_request` reads, and only for audit-log tagging). Moved them to a new fully kernel-owned `payments-tools` extension.

**Amendment (2026-04-29, step 2 landed):** `services.session.id()` shipped in step 2, *not* step 7 as originally planned. Rationale: implementing the closure-over-`activate()`-parameters alternative would have required threading `options.sessionId` through `bootstrapExtensions()` and into every extension's `activate()`, polluting the host-API surface with a value most extensions don't need. The lazy-getter pattern (`services.session.id()` returns `null` when unbound, sink bound by `app.tsx`) is mechanically identical to the existing `services.workspace.cwd()` and uses zero new abstractions. The "≥ 2 tools" rule rephrases to "≥ 2 tools across the migration roadmap": `paid_request` (step 2) and `bash` + hooks (step 7) are the legitimate consumers. The roadmap-scoped rule still keeps the surface honest — speculative additions are still rejected; this one is committed.

`paid_request` also has `needsApproval: () => boolean` — that's a vanilla ai-sdk `tool({...})` field; the kernel's ToolSet merge already preserves it.

### Carve-out 3 — Bash promotes to a builtin extension that exposes `services.bash`

Tier C is the only tier where multiple tools genuinely share an instance (the `BashTool` background-process registry). The bash tools are also load-bearing for almost every coding workflow, which is why `builtin.tools.bash` is already marked `protected: true`.

Promote `bash` to a *kernel-owned* builtin extension that constructs the `BashTool` inside its `activate()`, registers `bash` / `process_logs` / `process_stop` / `process_list` with full kernel ownership, and exposes the BashTool methods other tools may need via `services.bash` (`cwd`, `execute`, `startBackground`, `getProcessLogs`). The cwd-provider rewires from `agent.getCwd()` → `services.bash.cwd()` (functionally identical; cleaner ownership).

This carve-out is the largest of the seven steps because `BashTool` is currently the **de facto cwd authority for the entire Agent**. See Step 7's expanded scope below — `agent.ts` has ~28 direct `this.bash.getCwd()` call sites that all rewire, plus child-bash construction (`new BashTool(this.bash.getCwd(), ...)` for sub-agents) that needs a different shape post-migration.

### Carve-out 4 — Hooks pipeline ships alongside bash but is internal-only

Hooks (`executePreToolHooks`, `executePostToolHooks`, `executePostToolFailureHooks`, `executeEventHooks`) aren't bash-specific — they read user-config files and run user-supplied scripts at tool-execution boundaries. Currently the only caller inside `tools.ts` is `bash`'s `execute`, but `agent.ts:2117` already calls `executeEventHooks` outside any tool. So the hooks pipeline is genuinely a cross-cutting concern, not a bash internal.

Expose `services.hooks.{runPre, runPost, runFailure, runEvent}` as a sink-backed surface bound by the Agent at startup. The bash extension (step 7) calls `services.hooks.runPre(...)` from inside its tool's `execute`. Other extensions *could* opt in, but **don't advertise this as a third-party API** — hook-author trust assumptions (running user scripts that read filesystem, network, etc.) require a permission model that doesn't exist yet. Mark `services.hooks` as builtin-only in the JSDoc and revisit when the permission model lands.

This carve-out shares step 7's commit but stands as a distinct conceptual move — hooks live next to the bash promotion, but they don't *belong* to bash.

### Tier-by-tier mapping

| Tier | Recommendation | New surface | Carve-out |
|---|---|---|---|
| A — Provider-coupled (4) | Co-locate in `xai-provider-extension.activate()` | (none) | #1 |
| B — Mode-gated (14) | Add `RegisteredTool.modes?: AgentMode[]` + kernel `setMode(mode)` exporter + mode filter in `filterToolSetByEnabled` | (none in `services.*`; metadata + setter) | — |
| C — Bash + hooks (4) | Promote bash to extension owning `BashTool`; expose `services.bash.{cwd,execute,startBackground,getProcessLogs,stopProcess,listProcesses}`; add `services.hooks.{runPre,runPost,runFailure}` | `services.bash`, `services.hooks` | #3 |
| D — Callbacks (~12) | Per-subsystem sinks: `services.subagents`, `services.schedule`, `services.telegram`. Wallet/payments self-contain. `services.session.id` shipped in step 2 (paid_request consumer). | `services.subagents`, `services.schedule`, `services.telegram`, `services.session` (shipped step 2) | #2 |

After all migrations, `createTools()` should be empty (or contain only `generate_plan` for `mode === "plan"`, which can also migrate via the same mode-metadata mechanism).

### Why not (b) or (c) wholesale

- **Not (b)** because the project goal is everything-as-extensions, and (b) explicitly draws the line short. Tier C/D code in `tools.ts` becomes permanent residue. The dreaming-pass lessons argue against this: the recipe generalizes; we should keep generalizing.
- **Not (c)** because the three shipped migrations didn't need the indirection. Adding `services.runtime.bind` is paying for flexibility we have no current use case for — third-party extensions still can't bind into the agent's runtime, so the indirection only helps the agent itself, which already has a perfectly good direct path (per-tier `services.*` additions).

## Implementation sketch

Order is "cheapest first; each step independently shippable". Each row has roughly the same scope as one of the three Phase 2 migrations already shipped.

1. **Mode metadata + filter** *(no `services.*` change)* — add `modes?: AgentMode[]` to `RegisteredTool`, add kernel `setMode(mode: AgentMode)`, extend `filterToolSetByEnabled` to drop tools whose `modes` don't include the current mode. Migrate `write_file` / `edit_file` (already metadata-only in `builtin.tools.file`!) by attaching their `tool({...})` defs and adding `modes: ["agent"]`. Migrate the 12 `computer_*` tools similarly into the existing `builtin.tools.computer` group.

2. **Wallet/payments self-contain** *(SHIPPED, commit pending)* — promoted `builtin.tools.payments` to fully kernel-owned. Moved 4 tools (`wallet_info`, `wallet_history`, `fetch_payment_info`, `paid_request`) into the extension's `activate()`. `paid_request` reads `sessionId` via `services.session.id()` (sink added in same step — see Carve-out 2 amendment). ~80 lines + 6 new tests.

3. **Telegram self-contain** — promote `builtin.tools.telegram` to kernel-owned. Add `services.telegram.sendFile` sink, bound by the bridge code when active. The tool's execute calls `services.telegram.sendFile()` directly. ~30 lines + tests.

4. **Provider-coupled tools** *(hard-blocked on Phase 3b — do not start before 3b lands; see Risks)* — once `xai-provider-extension` owns its runtime `XaiProvider`, move 4 tools (`search_web`, `search_x`, `generate_image`, `generate_video`) into its `activate()`. ~120 lines + tests. After 3b lands, this becomes a small migration; before 3b lands, it's "redo 3b." Greenlight signal: 3b PR merged.

5. **Subagents callbacks** — add `services.subagents.{runTask, runDelegation, readDelegation, listDelegations}` sinks. Promote `builtin.tools.subagents` to kernel-owned. Move 4 tools (`task`, `delegate`, `delegation_read`, `delegation_list`). ~150 lines + tests.

6. **Schedule callbacks** — add `services.schedule.*` (likely a single sink that exposes the `ScheduleManager` shape, since the manager is one cohesive object). Promote `builtin.tools.schedule` to kernel-owned. Move 7 `schedule_*` tools. ~200 lines + tests.

7. **BashTool extension + hooks** — by far the largest. Step 7's surface area is materially bigger than steps 1–6 combined. Three sub-moves, all in one commit because they're mechanically inseparable: removing `BashTool` construction from the Agent constructor (7a) eliminates `this.bash`, which immediately breaks every one of the ~28 `this.bash.getCwd()` references — so 7b *must* land in the same commit. (A shim path exists — leave `this.bash = services.bash` as a property and migrate sites incrementally — but it doubles the test-surface and leaves a half-migrated state behind. Reject the shim; commit all three sub-moves together.)
   - **(7a) Promote `builtin.tools.bash` to kernel-owned** — owns the `BashTool` instance. Construction moves from `agent.ts` Agent constructor into the extension's `activate()`. Expose `services.bash.{cwd, execute, startBackground, getProcessLogs, stopProcess, listProcesses}`. Move 4 tools (`bash`, `process_logs`, `process_stop`, `process_list`).
   - **(7b) Rewire all `this.bash.getCwd()` consumers in `agent.ts`** — there are **~28 direct call sites** (e.g., `DelegationManager` constructor at 575, `SessionStore` at 589, the cwd-provider sink wire at 580, hook-event calls at 693/2117, child-agent bash construction at 1240, plus ~22 others scattered across run/turn/verify code paths). All rewire to `services.bash.cwd()`. Critically, child-bash construction (`new BashTool(parentCwd, {...})` for sub-agents) needs its own pattern — likely the extension exposes a `services.bash.spawnChild(parentCwd)` factory rather than callers reaching for the `BashTool` constructor directly.
   - **(7c) Add `services.hooks` sink** — bound by Agent at startup; only `services.bash`'s `execute` calls it from inside tool execution. The pre-existing `agent.ts:2117` call to `executeEventHooks` rewires to `services.hooks.runEvent()`.

   **Activation order constraint:** the bash extension's `activate()` must complete before the Agent constructs `DelegationManager` / `SessionStore` / cwd-provider, because those bind to `services.bash.cwd` lazily. If the bootstrap order today is `Agent ctor → loadBuiltinExtensions()`, that flips to `loadBuiltinExtensions() → Agent ctor` (or the Agent ctor splits into pre-extension and post-extension phases). Either way, `agent.ts` ordering changes — that's part of step 7, not a follow-on.

   **Estimated scope:** ~600 lines + tests, with the bulk in `agent.ts` rewires (~250 lines of grep-replace plus careful review for capture vs lazy-read at each site) and `bootstrap.ts` ordering changes. Treat step 7 as a multi-day landing; do not block steps 1–6 on it.

   **Test-suite impact:** unlike steps 1–6 (where the verification budget is "test count strictly increases" — pure additions), step 7 is also a *modification* risk. Existing Agent tests that mock `BashTool` directly, assert against `this.bash.getCwd()`, or assume Agent ctor produces a working bash will need rewiring beyond mechanical search-replace. Expect order ~10–20 existing tests to require updates (delegation-manager spec, session-store spec, cwd-provider tests, plus any agent-run tests that touch bash). Step 7's plan should enumerate which test files are touched and budget separately for "modify existing" vs "add new" — the strictly-increases rule from #1–#3 still applies, but the existing-test churn is the harder part to estimate.

After step 7, `createTools()` is either deleted or reduced to `generate_plan` (which is a one-tool extension migration thereafter).

## Verification (per-step pattern)

Each step follows the recipe Phase 2 #1–#3 already proved:

- `bun run typecheck` clean.
- `bun run test` count strictly increases (preexisting failures stay tracked: anthropic-provider disabled-by-default, filter.test.ts payments-disabled-by-default, model-runtime anthropic credential — none of these are blocked by this migration).
- The migrated tools' `RegisteredTool.description` is populated at *both* layers (registry-level outer + model-facing inner via `tool({ description })`), per the dual-layer-description gotcha from #1.
- `cwd` (or any execute-time host-service binding) read lazily inside `execute`, not captured at register time.
- New sinks default to no-op; tests cover unbound, bound, replace, clear-on-reset.
- Mixed-mode pattern preserved where the extension contains both kernel-owned and metadata-only tools mid-migration.

## Risks

- **Tier A blocks on Phase 3b — explicitly.** The current `xai-provider-extension` is metadata-only; the Agent constructs `XaiProvider` directly via `createProvider()` in `src/grok/client.ts`. Step 4 does not self-unblock. Self-unblocking would mean step 4 owns `XaiProvider` construction *and* tier A migration *and* the new sink that feeds the constructed provider back to the Agent — that's Phase 3b plus a tier-A migration, not "step 4." **Hard sequencing:** Phase 3b (Agent consumes kernel-registered providers) must land before step 4 starts. Steps 1–3 and 5–7 do not depend on 3b and can ship in any order. If 3b is delayed, step 4 simply waits — it's the smallest of the seven and the easiest to slot in late.

- **Mode-as-metadata vs mode-as-execute-gate.** Step 1 chooses metadata-time gating (filter strips mode-mismatched tools from the ToolSet). The lsp migration used execute-time gating (`isLspToolEnabled()` called inside `execute`) because lsp's enable/disable is a runtime setting that can flip during a session. Mode is also runtime-mutable (`/plan` toggles into plan mode). **Mitigation:** `setMode(mode)` invalidates the cached ToolSet by re-running `getEnabledToolSet()`. The Agent's three ToolSet merge sites already re-call this each turn — confirming the cache invalidation is implicit.

- **`services.bash` API surface lock-in.** Step 7 commits to a public `services.bash` shape that other extensions may consume. Adding methods later is easy; removing them is hard. **Mitigation:** start with the *minimum* surface — just the methods the four bash tools actually use today. New methods added only when a second tool needs them, per the "≥ 2 tools" rule.

- **`services.session.id` may leak into too many places.** Once exposed, it's tempting to thread it through every tool. **Mitigation (active):** the surface landed in step 2 (per Carve-out 2 amendment). The rule remains "tools that produce auditable side effects can read it for tagging; everything else doesn't need it." `bash`, `paid_request`, `task`, `schedule_create` are the legitimate consumers. Mode-gated and filesystem tools should not depend on it. Reviewers must reject diffs that add `services.session.id()` calls to non-side-effect-producing tools.

- **Step 7 activation-order regression.** Promoting bash to an extension means the Agent's `DelegationManager`, `SessionStore`, and cwd-provider all start binding to `services.bash.cwd()` instead of `this.bash.getCwd()`. If `loadBuiltinExtensions()` runs *after* those constructors, the sink is unbound at bind time and they'd see `undefined`. **Mitigation:** bootstrap reorders to `loadBuiltinExtensions() → buildHostServices() → new Agent(services)`, OR the Agent constructor splits into pre-extension and post-extension phases (constructor takes the kernel; bind-dependent state initializes in a separate `attach()` method called after extensions activate). Decide which during step 7 planning; whichever is chosen, the Agent test suite needs targeted activation-order coverage to catch regressions.

- **Sink lifecycle drift.** Each new sink needs to be cleared in both `shutdownExtensions()` and `__resetExtensionsForTests()`. Five sinks today; up to ~10 after this work. **Mitigation:** consolidate into a single `clearAllSinks()` helper in `loader.ts` once we hit 7 — the boilerplate becomes a maintenance liability before it becomes a correctness one.

- **Hooks subsystem coupling.** `executePreToolHooks` etc. read config files and run user-supplied scripts. Currently called from `bash`'s `execute` plus `agent.ts:2117` (`executeEventHooks`). If `services.hooks` is exposed, other tools may opt in — meaning hook authors get more surface area than they had before. **Mitigation:** per Carve-out 4, mark `services.hooks` as builtin-only in JSDoc and don't advertise as third-party API until a permission model exists. Hook authors' threat surface stays at today's level.

## Out of scope

- **Cluster C migration** (`/btw`, `/term`, `/term-modal`): these need lifecycle primitives, not host-service surface design. Separate pass.
- **`createTools()` factory deletion**: this is what the seven steps lead to, but pulling the trigger ("delete the file") is the *result*, not a step. After step 7 lands, `tools.ts` is either empty or holds only `generate_plan` — that gets handled in a closing PR.
- **Generic third-party extension access to BashTool/ScheduleManager/etc.** This proposal stops at "host-services exposed for builtins"; extending those to user extensions requires a permission model that doesn't exist yet (see `manifest.permissions` for the foothold but it's currently advisory only).
- **Replacing `createTools()` for the `mode === "plan"` path**: `generate_plan` is the only plan-mode tool. Migrate it last (or skip — it's a one-tool tier all on its own).

## Acceptance criteria

If owner approves this proposal, downstream plan documents (one per step, parallel to `2026-04-29-cluster-b-host-action-api.md`) must satisfy:

1. Each step's plan documents the new `services.*` field(s) added (if any), the sink-binding location, and the migrated tool names.
2. Each step is independently typecheckable, testable, and committable. Reverting one step doesn't break preceding steps.
3. `RegisteredTool.description` populated at both layers per #1's dual-layer rule.
4. `cwd` (and any other host-service value that can drift) read lazily inside `execute`.
5. Sink unbound / bound / replaced / cleared-on-reset paths each have at least one unit test.
6. After step N completes, the count of `tool({...})` definitions executed from `createTools()` decreases by exactly the number listed in step N's plan; no off-by-one drift. ("Count" here means the number of tool defs whose `execute` runs inside `createTools()` — metadata-only declarations elsewhere don't count toward the floor; tier-A/B/C/D defs that fully relocate to an extension's `activate()` do.)
7. `bun run test` count strictly increases at each step. The three preexisting failures stay tracked but unaffected.

## Spec sections summary

1. **Context** — three migrations shipped; recipe stable; mixed-mode pattern proven; four remaining tiers enumerated.
2. **Goal** — pick a host-service surface that lets all four tiers migrate.
3. **Options** — (a) extend `services.*`, (b) filter at merge, (c) hybrid bind. Pros/cons for each.
4. **Recommendation** — hybrid (per-tier home selection) with four carve-outs: providers self-contain in their owning extension; wallet/payments self-contain (`services.session.id` shipped in step 2 per Carve-out 2 amendment); bash promotes to extension exposing `services.bash`; hooks pipeline ships alongside bash but builtin-only.
5. **Implementation sketch** — seven independently-shippable steps, ordered cheapest-first; step 4 hard-blocked on Phase 3b; step 7 expanded to cover ~28 `agent.ts` rewires + activation-order changes.
6. **Verification** — per-step pattern matching the three shipped migrations.
7. **Risks** — seven risks with mitigations (added step-7 activation-order regression).
8. **Out of scope** — Cluster C; third-party tool access; closing-PR formalisms.
