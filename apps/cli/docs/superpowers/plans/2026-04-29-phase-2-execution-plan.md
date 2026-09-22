# Phase 2 #4–#7 — Execution Plan (Everything-as-Extensions)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended for steps 1–6; mandatory for step 7) to execute this plan task-by-task.

**Goal:** Migrate the remaining ~33 tools out of `src/grok/tools.ts`'s `createTools()` factory into kernel-owned extensions, ending with `createTools()` either deleted or holding only `generate_plan`. After this lands, *every executable tool ships through the extension registry*, the kernel exposes a clean host-service surface, and the migration recipe is the canonical answer for any future tool.

**Spec:** `docs/superpowers/specs/2026-04-29-phase-2-host-service-surface-design.md` (279 lines, approved 2026-04-29)

**Status:** Approved · Execution begins at owner approval

---

## Scope check (verified against current tree)

```
src/grok/tools.ts createTools() inventory (verified 2026-04-29):
  Always-on (top-level):        8 tool defs
    bash, process_logs, process_stop, process_list   (Tier C, BashTool+hooks)
    search_web, search_x, generate_image,
      generate_video                                  (Tier A, provider-coupled)
  Conditional (gated):
    telegram_send_file (when bridge active)           (Tier D)
    task                                              (Tier D)
    12× computer_*                                    (Tier B, mode-gated)
    write_file, edit_file                             (Tier B, mode-gated)
    delegate, delegation_read, delegation_list        (Tier D)
    7× schedule_*                                     (Tier D)
    wallet_info, wallet_history, fetch_payment_info,
      paid_request                                    (Tier E, self-contain)
    generate_plan                                     (one-off, defer)
  Total executions: 33 (excluding generate_plan)

agent.ts coupling sites (verified):
  this.bash references:                47 (spec said ~28; reality is 47)
  ToolSet merge sites:                  3 (1247/1261, 1945/1955, 2284/2294)
  Sinks today:                          5 (toast, chat, assistant, ui-action, cwd-provider)
```

---

## Object model — before & after

### Before Phase 2 #4

```
Agent
  ├── this.bash: BashTool ────────────────┐
  ├── this.scheduleManager: ScheduleManager
  ├── this.delegationManager: DelegationManager
  ├── createTools(opts) → ToolSet ────────┤   closure-captures provider, bash,
  │     // 33 tool defs inline            │   hooks, scheduleManager, runTask,
  │     // with closure captures          │   runDelegation, sendTelegramFile,
  │     // of every dependency above      │   sessionId, mode
  └── runTurn() ──────────────────────────┘
        ├── kernelTools = getEnabledToolSet()  ← 3 kernel-owned extensions today
        ├── tools = { ...createTools(opts), ...kernelTools }  ← merge
        └── filterToolSetByEnabled(tools)

ExtensionHostServices (today, 9 fields):
  toast | commands | tools | models | settings | extensions
  chat:{dispatch, appendAssistant} | workspace:{cwd} | ui:{action}
```

### After Phase 2 #7

```
Kernel
  ├── HostServices (~14 fields)
  │     ├── existing: toast, commands, tools, models, settings,
  │     │             extensions, chat, workspace, ui
  │     ├── + bash:    {cwd, execute, startBackground,
  │     │              getProcessLogs, stopProcess, listProcesses,
  │     │              spawnChild}
  │     ├── + hooks:   {runPre, runPost, runFailure, runEvent}      (builtin-only)
  │     ├── + subagents: {runTask, runDelegation,
  │     │                 readDelegation, listDelegations}
  │     ├── + schedule: ScheduleManager-shaped facade
  │     └── + telegram: {sendFile}
  │
  ├── 13 builtin extensions (existing 13 + ~4 new):
  │     existing: anthropic-provider, claude-agent-provider,
  │               xai-provider, file-tools, grep-tool, lsp-tool,
  │               groups, host-actions, skills-listing,
  │               subagent-commands, workflow-prompts, helpers, index
  │     new (and modified):
  │       computer-tools          12 mode-gated tools
  │       file-tools              ← write_file, edit_file promoted to kernel-owned
  │       payments-tools          wallet+payments, 4 tools, self-contained
  │       telegram-tools          1 tool, self-contained
  │       xai-provider            ← search/generate co-located after Phase 3b
  │       subagents-tools         task+delegation, 4 tools
  │       schedule-tools          7 tools
  │       bash-tools              4 tools + owns BashTool instance
  │
  └── Agent
        ├── (no this.bash; no this.scheduleManager, no this.delegationManager —
        │    all owned by their extensions; Agent reads via services.*)
        └── runTurn() reads ToolSet purely from kernel registry
```

### Sequence flow — tool dispatch (after migration)

```
Agent.runTurn()
  ├── tools = getEnabledToolSet()             ← all tools from kernel registry
  ├── tools = filterToolSetByEnabled(tools)   ← filter by enabled-extensions + mode
  └── stream events → on tool_call:
        ├── tool = tools[toolName]            ← resolved via registry merge
        └── tool.execute(args, ctx)
              │  ctx = { mode, sessionId, abortSignal, services }
              │
              ▼ (inside extension's tool({...}) def)
              const cwd = services.workspace.cwd()       ← lazy
              const result = await services.bash.execute({...})  ← lazy
              await services.hooks.runPost(...)          ← lazy
              return result
```

### Sink lifecycle invariant

```
mount         → setXxxSink(handler)  ← bind once at startup (app.tsx or extension activate)
runtime       → services.xxx.…       ← call sites resolve via current sink ref
unmount       → setXxxSink(null)     ← shutdownExtensions / __resetExtensionsForTests
unbound state → no-op (returns undefined or default; never throws)
replace       → setXxxSink(new)      ← second binding overwrites first; no leaks
```

---

## Class contracts to add

### `ToolContext` (per-invocation)

```ts
// src/core/extensions/api.ts (NEW or extend existing — current shape passes args only)
export interface ToolContext {
  /** Per-invocation agent mode. Tools that gate on mode (write_file, computer_*) read this. */
  mode: AgentMode;
  /** Session id for audit/log tagging. Tools that produce auditable side effects read this. */
  sessionId: string;
  /** AbortSignal for the running turn. Long-running execs honor this. */
  abortSignal: AbortSignal;
  /** Stable reference to host services. Tools call services.workspace.cwd() etc. lazily. */
  services: ExtensionHostServices;
}
```

The `tool({...})` `execute` callback signature changes from `execute(args)` → `execute(args, ctx)`. The kernel constructs `ctx` per-invocation in the merged ToolSet.

### `RegisteredTool.modes` (metadata)

```ts
// src/core/extensions/api.ts (extend existing RegisteredTool)
export interface RegisteredTool {
  name: string;
  description: string;
  group?: string;
  modes?: AgentMode[];   // NEW: filter strips tools whose modes don't include current mode
  tool?: ReturnType<typeof tool>;
}
```

`filterToolSetByEnabled` extends to consult `getKernelMode()` → drops tools whose `modes` is set and doesn't include the current mode. Equivalent to today's `if (mode === "agent")` registration-time gating, but flipped to execute-time so the model sees the tools always (matching the lsp pattern).

### Eight new HostServices subtypes

```ts
// src/core/extensions/api.ts — added to ExtensionHostServices

bash: {
  cwd(): string;
  execute(opts: BashExecOpts): Promise<BashResult>;
  startBackground(opts: BashStartOpts): Promise<{ pid: number; logFile: string }>;
  getProcessLogs(pid: number): Promise<string>;
  stopProcess(pid: number): Promise<void>;
  listProcesses(): Promise<ProcessInfo[]>;
  spawnChild(parentCwd: string): BashTool;   // for sub-agent construction
};

hooks: {                                      // BUILTIN-ONLY — JSDoc warns against third-party use
  runPre(opts: PreToolHookOpts): Promise<HookResult>;
  runPost(opts: PostToolHookOpts): Promise<HookResult>;
  runFailure(opts: PostToolFailureHookOpts): Promise<HookResult>;
  runEvent(opts: EventHookOpts): Promise<HookResult>;
};

subagents: {
  runTask(input: TaskInput, abortSignal: AbortSignal): Promise<TaskResult>;
  runDelegation(input: DelegationInput, abortSignal: AbortSignal): Promise<DelegationResult>;
  readDelegation(id: string): Promise<DelegationRecord>;
  listDelegations(): Promise<DelegationRecord[]>;
};

schedule: ScheduleManager;                    // expose facade directly; manager is one cohesive object

telegram: {
  sendFile(opts: TelegramSendFileOpts): Promise<void>;
};
```

Five new sink setters parallel the existing pattern in `loader.ts`:

```ts
setBashSink(sink: BashServices | null);
setHooksSink(sink: HooksServices | null);
setSubagentsSink(sink: SubagentsServices | null);
setScheduleSink(sink: ScheduleManager | null);
setTelegramSink(sink: TelegramServices | null);
```

After step 7, `loader.ts` has 10 sinks. Per Risk mitigation, consolidate cleanup into `clearAllSinks()` once that count crosses 7.

---

## Steps — independently shippable

Order is cheapest-first. Each step is one PR, one commit (step 7 is one commit covering 3 sub-moves), one revert if needed.

| # | Step | Tools migrated | Surface added | Effort | Blocks |
|---|------|---------------:|---------------|--------|--------|
| 1 | Mode metadata + filter | 14 | `RegisteredTool.modes`, `setMode()` | S | none |
| 2 | Wallet/payments self-contain | 4 | (none) | S | none |
| 3 | Telegram self-contain | 1 | `services.telegram` | XS | none |
| 4 | Provider tools (xAI) | 4 | (none — uses xai-provider's own runtime) | S | **Phase 3b must land first** |
| 5 | Subagents callbacks | 4 | `services.subagents` | M | none |
| 6 | Schedule callbacks | 7 | `services.schedule` | M | none |
| 7 | Bash + hooks (3 sub-moves) | 4 | `services.bash`, `services.hooks` | XL | activation-order rewire |

After step 7: `createTools()` empty (or only `generate_plan` for plan mode); the file may be deleted in a closing PR.

---

## Step 1 — Mode metadata + filter

**Goal:** Add `modes?: AgentMode[]` to `RegisteredTool`. Migrate 14 mode-gated tools (12 `computer_*` + `write_file` + `edit_file`) to kernel-owned extensions. No `services.*` change.

### Files

| File | Status | Responsibility |
|------|--------|----------------|
| `src/core/extensions/api.ts` | modify | Add `modes?: AgentMode[]` field; export `AgentMode` if not already. |
| `src/core/extensions/loader.ts` | modify | Add `currentKernelMode: AgentMode | null` + `setKernelMode(mode)`; extend `filterToolSetByEnabled` to consult mode. |
| `src/core/extensions/index.ts` | modify | Re-export `setKernelMode`. |
| `src/core/extensions/builtin/computer-tools.ts` | create | New extension `builtin.tools.computer`, `protected: true`. Registers all 12 `computer_*` tools as kernel-owned with `modes: ["agent"]`. |
| `src/core/extensions/builtin/file-tools.ts` | modify | Promote `write_file` + `edit_file` from metadata-only to kernel-owned by attaching `tool({...})` defs and `modes: ["agent"]`. |
| `src/core/extensions/builtin/index.ts` | modify | Add `computerToolsExtension` to bundle. |
| `src/agent/agent.ts` | modify | Drop the 14 mode-gated tool defs from `createTools()`. Wire `setKernelMode` per-turn (or per-mode-change) so the kernel filter has current mode. |
| `src/grok/tools.ts` | modify | Drop the 14 mode-gated defs. Drop unused imports (`writeFile`, `editFile`, `computer*`). |
| `src/core/extensions/loader.test.ts` | modify | New tests: mode-filter strips mismatched, mode-filter passes matching, mode change re-filters, no-mode preserves backward compat. |
| `tests/computer-tools.test.ts` | create | Smoke test: kernel registers all 12 names; filter behaves correctly across `agent`/`plan`/`ask`. |

### Acceptance

- [ ] `bun run typecheck` clean
- [ ] `bun run test` count strictly increases (≥ 4 new tests)
- [ ] All 14 mode-gated tool names visible in `getEnabledToolSet()` when mode = `"agent"`
- [ ] Same names absent when mode = `"plan"` or `"ask"`
- [ ] `createTools()` count of `tool({...})` defs decreases by exactly 14
- [ ] `bun run lint` no new warnings
- [ ] Smoke: `node dist/index.js`, `/plan` mode, type "edit foo.ts" — model does not see `edit_file`

### Subagent dispatch prompt (for `subagent-driven-development`)

> Implement step 1 of `docs/superpowers/plans/2026-04-29-phase-2-execution-plan.md`. Touch ONLY the files listed in Step 1's File Structure table. Do NOT touch any other tool tier (computer_* and write/edit_file only — no bash, schedule, etc.). Use `superpowers:executing-plans` to drive the work. Critical context: test runner is `bunx vitest run` via `bun run test` (NOT `bun test`); biome a11y warnings in `app.tsx` are preexisting and you may use `--no-verify` for the commit; do NOT run `bun run dev`. Report when done: files touched, line deltas, test count delta, commit SHA.

---

## Step 2 — Wallet/payments self-contain

**Goal:** Promote `builtin.tools.payments` to kernel-owned. Move 4 tools. `paid_request` reads `sessionId` via closure over `activate()` parameters (no `services.session.id` yet — deferred per Carve-out 2).

### Files

| File | Status | Responsibility |
|------|--------|----------------|
| `src/core/extensions/builtin/payments-tools.ts` | create | New extension `builtin.tools.payments`. Registers 4 tools as kernel-owned. Dynamic-imports `WalletManager`/`PaymentHistory`/`X402Service` inside `execute()`. `paid_request` closes over `sessionId` provided in extension manifest activation params. |
| `src/core/extensions/builtin/groups.ts` | modify | Remove existing metadata-only payment registrations. |
| `src/core/extensions/builtin/index.ts` | modify | Add `paymentsToolsExtension`. |
| `src/grok/tools.ts` | modify | Drop the 4 payment-tier tool defs. Drop dynamic-import scaffolding. |
| `src/agent/agent.ts` | modify | Pass `sessionId` to extension activate (via existing extension-instance options or new `loadBuiltinExtensions({ sessionId })` shape — see Risk: activation-time params). |
| `src/core/extensions/builtin/__tests__/payments-tools.test.ts` | create | Mock `WalletManager`/`PaymentHistory`/`X402Service`; assert each tool dispatches the right method; `paid_request` reads `sessionId` from activation params; `needsApproval: () => boolean` field preserved through registry. |

### Acceptance

- [ ] `bun run typecheck` clean
- [ ] `bun run test` count strictly increases (≥ 4 new tests)
- [ ] `createTools()` count decreases by exactly 4
- [ ] `paid_request.needsApproval` returns truthy when called (not lost in registry merge)
- [ ] Existing `filter.test.ts` payments-disabled-by-default test still passes (preexisting failure stays preexisting)

### Risk: activation-time params

Currently `loadBuiltinExtensions()` takes no per-instance params; the kernel reads sessionId from the Agent. To pass sessionId to the payments extension at `activate(api, { sessionId })`, either:

(a) Extend `loadBuiltinExtensions()` to accept an opts bag forwarded to each extension's activate (preferred; minimal change; only payment-tools cares today, but step 7 will reuse for `services.session.id`).
(b) Add `services.session.id` now (violates "≥ 2 tools" rule; rejected).
(c) Have payments-tools read from a getter: `services.session.id()`. Same shape as `services.workspace.cwd()`. **Preferred alternative if (a) feels too invasive.**

Decision: go with (c). It's the same lazy-binding pattern already proven; doesn't change loader signature; readies `services.session` for step 7 with one consumer instead of two.

> Spec amendment: this overrides the Carve-out 2 deferral. `services.session.id()` lands in step 2, not step 7. Update the spec doc when the step lands.

---

## Step 3 — Telegram self-contain

**Goal:** Add `services.telegram.sendFile` sink. Promote `builtin.tools.telegram` to kernel-owned with one tool.

### Files

| File | Status | Responsibility |
|------|--------|----------------|
| `src/core/extensions/api.ts` | modify | Add `telegram: { sendFile(opts): Promise<void> }` to `ExtensionHostServices`. |
| `src/core/extensions/loader.ts` | modify | Add `telegramSink: TelegramServices \| null`; `setTelegramSink()`; `services.telegram` resolves through sink (no-op if unbound). Cleanup in `shutdownExtensions` and `__resetExtensionsForTests`. |
| `src/core/extensions/index.ts` | modify | Re-export `setTelegramSink`. |
| `src/core/extensions/builtin/telegram-tools.ts` | create | New extension `builtin.tools.telegram`. Registers `telegram_send_file`; tool calls `services.telegram.sendFile()`. |
| `src/core/extensions/builtin/index.ts` | modify | Add `telegramToolsExtension`. |
| `src/grok/tools.ts` | modify | Drop the conditional `telegram_send_file` def. |
| `src/agent/agent.ts` | modify | When telegram bridge is active, call `setTelegramSink({ sendFile: options.sendTelegramFile })`. When inactive, sink stays unbound — extension's tool returns a friendly "telegram bridge not configured" error (matching the lsp-disabled pattern). |
| `src/core/extensions/loader.test.ts` | modify | Tests: sink unbound (returns friendly error), bound (forwards opts to handler), replaced, cleared. |
| `src/core/extensions/builtin/__tests__/telegram-tools.test.ts` | create | Tool execute path: bound sink forwards correctly; unbound sink returns documented error. |

### Acceptance

- [ ] `bun run typecheck` clean
- [ ] `bun run test` count strictly increases (≥ 5 new tests)
- [ ] `createTools()` count decreases by exactly 1
- [ ] `telegram_send_file` visible in tool list always (even when bridge inactive); friendly error documented in tool description

---

## Step 4 — Provider-coupled (xAI)

> **HARD-BLOCKED on Phase 3b.** Do not begin this step until the Agent consumes kernel-registered providers. The current `xai-provider-extension` is metadata-only; the Agent constructs `XaiProvider` directly via `createProvider()` in `src/grok/client.ts`. Self-unblocking would mean step 4 owns `XaiProvider` construction *and* tier-A migration *and* the new sink — that's Phase 3b plus a tier-A migration, not "step 4."

**Goal:** After Phase 3b lands, co-locate `search_web`, `search_x`, `generate_image`, `generate_video` in `xai-provider`'s `activate()`. No new `services.*`.

### Files (after Phase 3b lands)

| File | Status | Responsibility |
|------|--------|----------------|
| `src/core/extensions/builtin/xai-provider.ts` | modify | In `activate()`, after `XaiProvider` is constructed (Phase 3b's responsibility), call `api.registerTool({ tool: ... })` for the 4 search/generate tools, closing over the constructed provider. |
| `src/grok/tools.ts` | modify | Drop the 4 provider-tier defs. |
| `src/agent/agent.ts` | modify | Drop `provider` argument paths to `createTools` for these 4 tools (others may still need it pre-step-7). |
| `src/core/extensions/builtin/__tests__/xai-provider.test.ts` | modify | Add assertions: 4 tools register when provider activates; tools' execute calls `provider.responses(...)` / `provider.tools.webSearch()` / etc. |

### Acceptance

- [ ] Phase 3b PR merged before step 4 starts
- [ ] `bun run typecheck` clean
- [ ] `bun run test` count strictly increases (≥ 4 new tests)
- [ ] `createTools()` count decreases by exactly 4

---

## Step 5 — Subagents callbacks

**Goal:** Add `services.subagents.{runTask, runDelegation, readDelegation, listDelegations}` sink. Promote `builtin.tools.subagents` to kernel-owned with 4 tools.

### Files

| File | Status | Responsibility |
|------|--------|----------------|
| `src/core/extensions/api.ts` | modify | Add `subagents: { runTask, runDelegation, readDelegation, listDelegations }` to `ExtensionHostServices`. |
| `src/core/extensions/loader.ts` | modify | `setSubagentsSink()`; resolve `services.subagents` through sink. Cleanup. |
| `src/core/extensions/index.ts` | modify | Re-export. |
| `src/core/extensions/builtin/subagents-tools.ts` | create | New extension. Registers `task`, `delegate`, `delegation_read`, `delegation_list` — each calls `services.subagents.<method>()`. |
| `src/core/extensions/builtin/subagent-commands.ts` | leave untouched | This is a *commands* extension (slash commands), separate from the *tools* extension we're adding. Names don't collide. |
| `src/core/extensions/builtin/index.ts` | modify | Add `subagentsToolsExtension`. |
| `src/grok/tools.ts` | modify | Drop the 4 subagent-tier tool defs. |
| `src/agent/agent.ts` | modify | At Agent construction, `setSubagentsSink({ runTask: this.runTask.bind(this), ... })`. Cleanup on Agent destruction. |
| `src/core/extensions/loader.test.ts` | modify | Sink lifecycle tests (unbound, bound, replaced, cleared). |
| `src/core/extensions/builtin/__tests__/subagents-tools.test.ts` | create | Tool execute paths verified through mocked sink. |

### Acceptance

- [ ] `bun run typecheck` clean
- [ ] `bun run test` count strictly increases (≥ 6 new tests)
- [ ] `createTools()` count decreases by exactly 4

---

## Step 6 — Schedule callbacks

**Goal:** Add `services.schedule` sink (exposes the `ScheduleManager` shape directly — manager is one cohesive object, not 7 methods). Promote `builtin.tools.schedule` to kernel-owned with 7 tools.

### Files

| File | Status | Responsibility |
|------|--------|----------------|
| `src/core/extensions/api.ts` | modify | Add `schedule: ScheduleManager` to `ExtensionHostServices`. (Import the type; the kernel doesn't construct or own ScheduleManager — Agent does.) |
| `src/core/extensions/loader.ts` | modify | `setScheduleSink()`. |
| `src/core/extensions/index.ts` | modify | Re-export. |
| `src/core/extensions/builtin/schedule-tools.ts` | create | New extension. Registers all 7 `schedule_*` tools — each calls `services.schedule.<method>()` directly. |
| `src/core/extensions/builtin/index.ts` | modify | Add `scheduleToolsExtension`. |
| `src/grok/tools.ts` | modify | Drop the 7 schedule-tier defs. |
| `src/agent/agent.ts` | modify | `setScheduleSink(this.scheduleManager)` after construction. |
| `src/core/extensions/loader.test.ts` | modify | Sink lifecycle tests. |
| `src/core/extensions/builtin/__tests__/schedule-tools.test.ts` | create | Tool execute paths verified through mocked manager. |

### Acceptance

- [ ] `bun run typecheck` clean
- [ ] `bun run test` count strictly increases (≥ 9 new tests)
- [ ] `createTools()` count decreases by exactly 7

---

## Step 7 — BashTool extension + hooks (XL — multi-day)

> **The biggest step. Three sub-moves, one commit.** Sub-moves are mechanically inseparable: removing `BashTool` construction from the Agent constructor (7a) breaks all 47 `this.bash.*` references in `agent.ts`, so 7b and 7c must land in the same commit. (Shim path rejected — see spec Risk #5.)

### Files

| File | Status | Responsibility |
|------|--------|----------------|
| `src/core/extensions/api.ts` | modify | Add `bash: { cwd, execute, startBackground, getProcessLogs, stopProcess, listProcesses, spawnChild }` and `hooks: { runPre, runPost, runFailure, runEvent }` to `ExtensionHostServices`. JSDoc `services.hooks` as **builtin-only**. |
| `src/core/extensions/loader.ts` | modify | `setBashSink()`, `setHooksSink()`. **`clearAllSinks()` consolidation lands here** — replaces the now-10 individual cleanup lines in `shutdownExtensions` and `__resetExtensionsForTests`. |
| `src/core/extensions/index.ts` | modify | Re-export new setters; export `clearAllSinks`. |
| `src/core/extensions/builtin/bash-tools.ts` | create | **(7a)** New extension `builtin.tools.bash`, `protected: true`. Constructs the `BashTool` instance inside `activate()`. Registers 4 tools (`bash`, `process_logs`, `process_stop`, `process_list`) as kernel-owned. Exposes `services.bash.*` via `setBashSink` from inside `activate()`. |
| `src/core/extensions/builtin/index.ts` | modify | Add `bashToolsExtension` ahead of any extension that consumes `services.bash` (alphabetical placement is fine since extensions activate in array order and `bash-tools` precedes others lexically). |
| `src/grok/tools.ts` | modify | Drop the 4 bash-tier defs. After this step, `createTools()` is empty (or holds only `generate_plan`). Consider deletion in a closing PR. |
| `src/agent/agent.ts` | modify | **(7b)** Rewire all 47 `this.bash.*` references → `services.bash.*` (via `getHostServices()`). Constructor no longer creates `BashTool`. Child-bash construction (`new BashTool(parentCwd, …)` for sub-agents) → `services.bash.spawnChild(parentCwd)`. **(7c)** `executeEventHooks` call at line 2117 → `services.hooks.runEvent()`. |
| `src/agent/bootstrap.ts` (or equivalent) | modify | **Activation-order rewrite.** Today: `Agent ctor → loadBuiltinExtensions()`. After: `loadBuiltinExtensions(api, { sessionId, … }) → buildHostServices() → new Agent(services)`. Or split Agent ctor into pre-extension and post-extension phases (`new Agent(kernel)` then `agent.attach()` after extensions activate). Owner-decided during step 7 planning. |
| `src/hooks/index.ts` | modify | Wire `executePreToolHooks` etc. into `setHooksSink({ runPre: executePreToolHooks, … })` at module load OR via Agent attaching them. **Sink is set by the Agent**, not by the hooks module — keeps hooks module pure. |
| `src/core/extensions/loader.test.ts` | modify | Sink lifecycle tests for bash + hooks; `clearAllSinks` test (clears all 10 sinks in one call). |
| `src/core/extensions/builtin/__tests__/bash-tools.test.ts` | create | Tool execute paths through mocked `BashTool`; `services.bash.spawnChild` returns a usable child instance; `process_*` tools share the registry. |
| `tests/agent-bash-rewire.test.ts` | create | **Targeted activation-order coverage.** Mocked `BashTool`; verify `services.bash` is bound before `DelegationManager`/`SessionStore`/`cwd-provider` consume it; verify failure mode if `services.bash` is unbound at consume time (should fail loudly, not silently). |
| `tests/agent.test.ts` (and ~10–20 existing test files) | modify | **Test-suite churn.** Existing Agent tests that mock `BashTool` directly, assert against `this.bash.getCwd()`, or assume Agent ctor produces a working bash. Estimate ~10–20 files; enumerate during step 7 planning. |

### Acceptance

- [ ] `bun run typecheck` clean
- [ ] `bun run test` count strictly increases by ≥ 8 (4 sink lifecycle + 4 bash-tools-execute, plus targeted activation-order); existing-test churn budgeted separately
- [ ] All 47 `this.bash.*` references gone from `agent.ts`; replaced with `services.bash.*`
- [ ] `createTools()` count decreases by exactly 4 (or to 0/1 if `generate_plan` is the only survivor)
- [ ] Three preexisting failures (anthropic, payments, model-runtime) remain preexisting — not regressions
- [ ] `bun run lint` clean (excluding the preexisting `app.tsx` biome a11y warnings to be paid down separately)
- [ ] Smoke: cold-start `node dist/index.js` → run `ls`/`pwd`/`echo` via bash tool → `cd /tmp` inside bash → next bash invocation reflects new cwd (cwd-drift preserved)
- [ ] Smoke: spawn a sub-agent task — child bash inherits parent cwd correctly
- [ ] Smoke: `executePreToolHooks` user-config is still consulted on bash invocation (run a hook-config'd machine to verify)

### Subagent dispatch — split into 3 sub-prompts

Step 7's scope is too large for a single subagent dispatch. Split:

**7a — bash-tools extension (Implementation Specialist):**
> Implement step 7a of `docs/superpowers/plans/2026-04-29-phase-2-execution-plan.md`. Create `src/core/extensions/builtin/bash-tools.ts` only. Register the 4 bash tools as kernel-owned. Construct `BashTool` inside `activate()`. Expose `services.bash.*` via `setBashSink`. Do NOT touch `agent.ts`, `tools.ts`, or any consumer of `this.bash.*` yet — that's 7b. Do NOT touch hooks — that's 7c. Stop after the file compiles, the new tests pass, and the kernel registry shows the 4 names.

**7b — agent.ts rewire (Implementation Specialist; depends on 7a):**
> Implement step 7b. The bash-tools extension from 7a is now in tree. Rewire all 47 `this.bash.*` references in `src/agent/agent.ts` to `services.bash.*`. Use `getHostServices()` to resolve. Child-bash construction → `services.bash.spawnChild(parentCwd)`. Drop `BashTool` construction from Agent ctor. Update bootstrap order: load extensions → build services → construct Agent. Modify ~10–20 existing Agent test files as needed (enumerate them in your report). Stop after typecheck + tests pass.

**7c — hooks sink (Implementation Specialist; depends on 7b):**
> Implement step 7c. Add `services.hooks` sink. Wire `executePreToolHooks`/`executePostToolHooks`/`executePostToolFailureHooks`/`executeEventHooks` into the sink. Bash-tools extension's tool calls `services.hooks.runPre/runPost/runFailure` from inside execute. The pre-existing `agent.ts` event-hooks call rewires to `services.hooks.runEvent`. Add `clearAllSinks()` to consolidate the now-10 sink cleanup paths in `loader.ts`. Stop after typecheck + tests + smoke.

After 7c, the orchestrating agent runs the full verification stack and commits all three sub-moves in one commit.

---

## Verification protocol — every step

```
1. pnpm typecheck                         # must be clean
2. pnpm test                              # count strictly increases
3. pnpm build                             # must be clean
4. pnpm lint                              # no new warnings (preexisting tracked)
5. Verify createTools() count             # decreases by exactly the step's tool count
6. Smoke (manual or scripted)             # owner runs `node dist/index.js`, exercises the migrated tools
7. git commit --no-verify                 # convention until biome a11y debt paid down
```

## Cross-step invariants — must hold at every step boundary

- **Mixed-mode pattern preserved.** Mid-migration, an extension may have some kernel-owned + some metadata-only tools. `disabledExtensionToolNames` filter handles both.
- **`RegisteredTool.description` populated at both layers.** Outer (registry) AND inner (`tool({ description })`) per dual-layer rule.
- **Lazy binding for any drifting value.** `cwd`, `mode`, `sessionId`, hooks — all read inside `execute`, never captured at register time.
- **Sink defaults are no-op.** Tests must cover unbound/bound/replaced/cleared paths for every new sink.
- **Test runner is `bunx vitest run` via `bun run test`.** NOT `bun test`. Phantom failures will mislead the worker.
- **Three preexisting test failures stay tracked.** Anthropic-disabled-by-default, filter.test.ts payments-disabled-by-default, model-runtime credential. None blocked by this migration; none "fixed" as part of this migration.
- **`--no-verify` is acceptable on commit.** App.tsx biome a11y debt is preexisting and orthogonal. Pay-down in a dedicated cleanup PR after Phase 2 closes.

## Risks (delta from spec)

The spec already enumerates seven risks. Two need re-statement at the plan level:

### R1 — Activation-order regression in step 7

If `loadBuiltinExtensions()` runs *after* `DelegationManager`/`SessionStore`/`cwd-provider` constructors in agent.ts, those bind to an unbound `services.bash.cwd()` and silently get `undefined` at first call.

**Mitigation:** step 7's `tests/agent-bash-rewire.test.ts` runs the activation order in BOTH orders (correct + incorrect) and asserts the incorrect order produces a clear error message at startup, not silent `undefined`. Mandatory addition.

### R2 — Test-suite churn underestimated

Existing Agent tests that mock `BashTool` directly (~10–20 files) all need rewiring beyond mechanical search-replace.

**Mitigation:** step 7a/7b/7c subagents must enumerate touched test files in their reports. The orchestrating agent treats the enumeration as part of the spec compliance check before commit. If the count exceeds 25, halt and re-plan.

### R3 — `services.session.id` lands earlier than spec says

Per Step 2's risk decision, `services.session.id()` lands at step 2, not step 7. Update spec when step 2 ships.

---

## What "delivered" looks like

After step 7 lands and the closing PR runs:

- `src/grok/tools.ts` `createTools()` is empty or holds only `generate_plan`.
- 33 tools (excluding `generate_plan`) execute through the extension registry.
- `ExtensionHostServices` has ~14 fields; cleanly named; each justified by ≥ 2 consumers.
- `agent.ts` no longer owns `BashTool`, `ScheduleManager`, or `DelegationManager` directly — all reached through `services.*`.
- The kernel exposes a coherent host-service surface that any future tool can use.
- Migration recipe is the canonical answer; no special cases for any of the four tiers.
- Third-party extensions still cannot use `services.bash`/`services.hooks` (builtin-only by JSDoc) until a permission model lands — that's Phase 8+ work.

---

## Out of scope

- **Cluster C** (`/btw`, `/term`, `/term-modal`): needs lifecycle primitives, not host-service surface design. Separate Phase 4e+.
- **Permission model for third-party access to `services.bash`/`services.hooks`/`services.subagents`/`services.schedule`.** These remain builtin-only until a permission model exists.
- **`createTools()` deletion.** This plan ends with `createTools()` empty or near-empty. Deletion is a closing PR, not a step.
- **`generate_plan` migration.** One-off tool gated on `mode === "plan"`. Migrate via mode metadata pattern in a follow-up if owner wants — adds nothing structurally.
- **App.tsx biome a11y debt.** Preexisting; paid down in a dedicated cleanup PR independent of Phase 2.

---

## Plan-level acceptance

If owner approves this plan:

1. Steps execute in the listed order. Each step is one subagent dispatch (or three for step 7). Each step commits independently.
2. The plan document is the source of truth — when a step's findings amend the plan (e.g., step 2's `services.session.id()` lift), edit the plan in the same commit.
3. After step 7 ships, retire the spec document (keep on disk as historical reference; remove "Status: Approved" → "Status: Shipped").
4. The orchestrating agent updates HEARTBEAT/MEMORY at each step's commit boundary.
