# Phase 2 Step 7 — Background-process tools to kernel ownership (reduced scope)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the three background-process tools — `process_logs`, `process_stop`, `process_list` — out of `src/grok/tools.ts`'s `createTools()` factory and into a new kernel-owned extension `builtin.tools.bash` in `src/core/extensions/builtin/bash-tools.ts`. Replace the metadata-only `bashToolsExtension` currently in `groups.ts` with a mixed-mode extension that owns the same four tool names (`bash` stays metadata-only; `process_*` get full `tool({...})` defs).

**Architecture:** Same pattern Step 5 (subagents) and Step 6 (schedule) used. A new `services.bash` sink is added to the host services interface with three methods proxying to the existing `BashTool` instance (`getProcessLogs`, `stopProcess`, `listProcesses`). The Agent ctor binds the sink at construction via `setBashSink(this.bash)` — `BashTool` structurally satisfies `BashSink`, so we pass it directly. Sink is process-global, last-construct-wins, friendly-error fallback when unbound (matches `ScheduleSink` exactly). The new kernel-owned extension's three `process_*` tools call `api.services.bash.*` from inside `execute`. The `bash` tool itself stays in `createTools()` — its dynamic sandbox-aware description (`bash.getToolDescription()`) and pre/post-tool hook calls are preserved verbatim, no new mechanism required.

**Tech Stack:** TypeScript (strict), vitest, existing `src/core/extensions/*` host kernel.

**Reduced scope vs original spec.** The Phase 2 spec lists Step 7 as XL with three sub-moves: (7a) construct `BashTool` inside an extension's `activate()`, (7b) rewire all 47 `this.bash.*` references in `agent.ts` through `services.bash.*`, (7c) add `services.hooks` sink and migrate hook calls. **This plan ships only the equivalent of a slice of 7a (the three `process_*` tools) and defers 7b, 7c, and the BashTool-construction migration.** Rationale captured below in *Spec deviations* — the short version is that bash's dynamic sandbox description requires re-register-on-sandbox-change semantics in the fully-kernel-owned model, which would need a small kernel API change (`registerExtensionTool` dedup-by-name) plus reworking the 4 wiring tests in `tools.test.ts`. Mixed-mode (bash stays metadata-only with execution in `createTools()`) avoids both costs. Hooks sink defers because there are zero current consumers — `process_*` tools have no hook calls today, and `bash` keeps its existing direct hook calls in `tools.ts`.

**Spec deviations flagged in advance:**
1. **Scope reduction.** `bash` itself is NOT migrated to full kernel ownership; it stays in `createTools()`. Justified above.
2. **No `services.hooks` sink in this commit.** Original 7c is deferred. Will land when a kernel-owned tool actually needs to run hooks (none today).
3. **No activation-order rewrite.** Original 7b prerequisites — calling `loadBuiltinExtensions()` before `new Agent()` — already shipped in `src/index.ts` lines 66–67 as part of an earlier migration. No further changes to bootstrap order needed; the `setBashSink(this.bash)` call lands in the Agent ctor alongside the existing `setSubagentsSink` and `setScheduleSink` calls.
4. **Group string preserved.** The new extension keeps the `"bash"` group string the metadata-only extension used so user toggles via `services.tools.setEnabled(...)` and `/extensions` filters continue to work unchanged.

**Spec:** `docs/superpowers/plans/2026-04-29-phase-2-execution-plan.md` (Step 7). The closing-PR aspiration ("`createTools()` empty, file may be deleted") is sacrificed by this scope reduction; `createTools()` stays as the home for `bash` plus the remaining provider-coupled tools (Step 4 hard-blocked on Phase 3b).

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/core/extensions/api.ts` | modify | Add `BashSink` interface and `bash: BashSink` field on `ExtensionHostServices`. |
| `src/core/extensions/loader.ts` | modify | Add `bashSink` slot, `setBashSink()` exporter, `services.bash` proxies, sink reset in `shutdownExtensions` and `__resetExtensionsForTests`. |
| `src/core/extensions/index.ts` | modify | Re-export `setBashSink` and `BashSink`. |
| `src/core/extensions/builtin/bash-tools.ts` | create | New kernel-owned extension. Registers 4 tool names: `bash` (metadata-only, description string only), `process_logs`/`process_stop`/`process_list` (full `tool({...})` defs that proxy to `services.bash.*`). Replaces metadata-only `bashToolsExtension` from `groups.ts`. |
| `src/core/extensions/builtin/groups.ts` | modify | Delete the metadata-only `bashToolsExtension` export and its block comment header. Add a NOTE comment in the same place pointing readers to `./bash-tools.ts`, mirroring the pattern used for `scheduleToolsExtension` and `subagentsToolsExtension`. |
| `src/core/extensions/builtin/index.ts` | modify | Replace `bashToolsExtension` import path: `./groups` → `./bash-tools`. |
| `src/core/extensions/builtin/bash-tools.test.ts` | create | Sink-binding/unbinding behaviour, friendly-error fallback when unbound, forward + output-formatting coverage for all 3 process tools. Mirrors `subagents-tools.test.ts` and the planned `schedule-tools.test.ts` (both implied by the comment block in `groups.ts`). |
| `src/grok/tools.ts` | modify | Drop the three `process_logs`/`process_stop`/`process_list` entries from the `base` object. Add a NOTE comment block matching the ones for schedule/subagents migrations. |
| `src/grok/tools.test.ts` | none | Unchanged. The 4 sandbox-description tests stay valid because `bash` itself is unchanged. |
| `src/agent/agent.ts` | modify | Import `setBashSink` from `../core/extensions`. Call `setBashSink(this.bash)` in the constructor right after `setScheduleSink(this.schedules)`. |
| `HEARTBEAT.md` | modify | Append "Phase 2 Step 7 done" section. |
| `MEMORY.md` | modify | Update Phase 2 progress checklist. |

Each file has one clear responsibility — type contract, runtime sink, registration, host implementation, removal.

---

## Task 1: Kernel — `BashSink` type + `services.bash` sink

> **Owner-greenlight gate.** Pause here. Surface this plan to the owner and do NOT start Task 1 without explicit approval. Auto-mode must NOT bypass this gate — the prior task summary explicitly required owner sign-off before substantive work begins. Once approved, proceed.

**Files:**
- Modify: `src/core/extensions/api.ts`
- Modify: `src/core/extensions/loader.ts`
- Modify: `src/core/extensions/index.ts`
- Test: existing `src/core/extensions/loader.test.ts` (only the sink-existence tests are touched here; the per-tool tests live in Task 2's new file).

This task adds the kernel surface — types, sink slot, exposure through `services.bash`, exports — and tests the sink wiring at the kernel layer. No callers yet.

- [ ] **Step 1: Add `BashSink` interface and `services.bash` field in `api.ts`**

Open `src/core/extensions/api.ts`. Find the existing `ScheduleSink` interface (search for `export interface ScheduleSink` — currently around line 489 inside the `// ── Host Services ──` region of types). Just BELOW the `ScheduleSink` interface, add:

```ts
/**
 * Kernel sink for the `BashTool` background-process surface. Bound by the
 * Agent at construction via `setBashSink(this.bash)` — `BashTool`
 * structurally satisfies this shape. Process-global; last-construct wins.
 *
 * Unbound sink ⇒ each `services.bash.*` proxy throws
 * `BASH_NOT_ACTIVE_MESSAGE`; the kernel-owned tools wrap the throw in their
 * existing try/catch and surface a friendly `{ success: false, output: ... }`
 * ToolResult. Same pattern as `ScheduleSink`.
 */
export interface BashSink {
  getProcessLogs: (id: number, tail?: number) => Promise<ToolResult>;
  stopProcess: (id: number) => Promise<ToolResult>;
  listProcesses: () => ToolResult;
}
```

Then in the `ExtensionHostServices` interface (search for `schedule: ScheduleSink;` — the field added in Step 6), add a `bash` field immediately after it:

```ts
  /**
   * `BashTool` background-process bridge. Owned by the Agent; sink is bound
   * via `setBashSink(this.bash)` at construction. The `BashTool` instance
   * structurally satisfies `BashSink`. See
   * `src/core/extensions/builtin/bash-tools.ts` for the kernel-owned tools
   * that consume this sink.
   */
  bash: BashSink;
  schedule: ScheduleSink;
```

(Place `bash` BEFORE `schedule` for alphabetical ordering — match the order other field clusters use.)

`ToolResult` is already imported at the top of `api.ts`; no new import needed. If TypeScript reports `Cannot find name 'ToolResult'`, find the existing `import type { ToolResult }` line and confirm `BashSink` is defined inside the same module scope (it is; nothing to fix).

- [ ] **Step 2: Wire the sink slot in `loader.ts`**

Open `src/core/extensions/loader.ts`. In the type-import block at the top (around line 36), add `BashSink` alongside `ScheduleSink` and `SubagentsSink`:

```ts
import type {
  // ...existing entries...
  BashSink,
  ScheduleSink,
  SubagentsSink,
  // ...rest unchanged...
} from "./api";
```

Find the existing `subagentsSink` slot (around line 213). Just BELOW the `SubagentsSink` block (and above the `ScheduleSink` block at line 226), add:

```ts
// Bash tool sink — bound by the Agent's constructor via
// `setBashSink(this.bash)`. Lets kernel-owned background-process tools call
// back into the active `BashTool` instance. Cleared on shutdown / test reset.
// Unbound sink ⇒ each `services.bash.*` proxy throws; the kernel-owned tools
// wrap the throw in their existing try/catch and surface a friendly
// `{ success: false, output: ... }` ToolResult.
const BASH_NOT_ACTIVE_MESSAGE =
  "BashTool is not active. An Agent must be constructed and the sink bound.";

let bashSink: BashSink | null = null;

export function setBashSink(sink: BashSink | null) {
  bashSink = sink;
}

function requireBashSink(): BashSink {
  if (!bashSink) throw new Error(BASH_NOT_ACTIVE_MESSAGE);
  return bashSink;
}
```

Then find the `services.subagents` block (around line 404) inside `buildHostServices()`. Just BELOW the closing `},` of `subagents` and ABOVE `schedule:` (around line 462), add the `bash` proxy block:

```ts
    bash: {
      getProcessLogs: (id, tail) => requireBashSink().getProcessLogs(id, tail),
      stopProcess: (id) => requireBashSink().stopProcess(id),
      listProcesses: () => requireBashSink().listProcesses(),
    },
```

Reset the sink to `null` in both `shutdownExtensions` and `__resetExtensionsForTests`. Find the existing `subagentsSink = null;` line in each (around lines 800, 820 respectively) and add a sibling `bashSink = null;` line just below it:

```ts
  // inside shutdownExtensions:
  subagentsSink = null;
  bashSink = null;
  scheduleSink = null;
```

```ts
  // inside __resetExtensionsForTests:
  subagentsSink = null;
  bashSink = null;
  scheduleSink = null;
```

- [ ] **Step 3: Re-export from the barrel**

Open `src/core/extensions/index.ts`. In the type-only export block, add `BashSink`:

```ts
export {
  // ...existing entries...
  type BashSink,
  type ExtensionModule,
  // ...rest unchanged...
} from "./api";
```

In the value re-export block from `./loader`, add `setBashSink` (alphabetically — it should come BEFORE `setChatSink`):

```ts
export {
  // ...existing entries...
  setAssistantSink,
  setBashSink,
  setChatSink,
  // ...rest unchanged...
} from "./loader";
```

- [ ] **Step 4: Sanity-check sink wiring in `loader.test.ts`**

Open `src/core/extensions/loader.test.ts`. Find an existing sink-isolation test (search for `"isolates"` — there should be one for chat sinks and one for the schedule/subagents sinks). The existing tests confirm sink slots are independent. We don't need to add per-tool tests here — those land in Task 2's new file (`bash-tools.test.ts`). But verify the imports / type wiring compiled by running:

```bash
bun run typecheck
```

Expected: clean. If TypeScript reports `Property 'bash' does not exist on type 'ExtensionHostServices'`, the api.ts edit didn't land or has a typo. If it reports `Cannot find module './loader' has no exported member 'setBashSink'`, the index.ts re-export is missing.

- [ ] **Step 5: Run kernel-side tests**

Run: `bun run test src/core/extensions/loader.test.ts`

Expected: existing tests pass (no behavioural changes to wired sinks). Pre-existing test count unchanged.

- [ ] **Step 6: Run typecheck + full test suite**

Run: `bun run typecheck`
Expected: clean.

Run: `bun run test`
Expected: all pre-existing tests pass. Test count unchanged at this step.

- [ ] **Step 7: Commit**

Defer commit — Task 1 ships in the same single commit as Tasks 2–4. Per spec rationale at the top of this document, this entire migration is one logical change (kernel surface + extension + dropped registrations + Agent bind). Splitting would break partial states.

---

## Task 2: Builtin extension — `bash-tools.ts`

**Files:**
- Create: `src/core/extensions/builtin/bash-tools.ts`
- Modify: `src/core/extensions/builtin/groups.ts`
- Modify: `src/core/extensions/builtin/index.ts`
- Test: `src/core/extensions/builtin/bash-tools.test.ts` (create)

This task creates the new kernel-owned extension that owns the four bash-group tool names. Three of them (`process_logs`, `process_stop`, `process_list`) are full kernel-owned `tool({...})` defs proxying to `services.bash.*`. The fourth (`bash`) stays metadata-only — its description and execution remain in `createTools()` because the tool description is dynamic (sandbox-aware) and the kernel registry would otherwise capture the description at activate time, locking it.

- [ ] **Step 1: Create `src/core/extensions/builtin/bash-tools.ts`**

Write the new file:

```ts
// Kernel-owned bash background-process tools (mixed-mode extension).
//
// Phase 2 step 7 of the kernel-extensibility plan: takes the three
// background-process tools (`process_logs`, `process_stop`, `process_list`)
// out of the `base` object in `createTools()` (in `src/grok/tools.ts`) and
// into a kernel extension that owns the full ai-sdk `tool({...})` defs.
// Replaces the metadata-only `bashToolsExtension` that previously lived in
// `./groups.ts` (now removed in this same step).
//
// Mixed-mode rationale.
//
//   - `bash` itself stays metadata-only here. Its description is dynamic
//     (sandbox-aware via `BashTool.getToolDescription()`) and the ai-sdk
//     `tool({...})` factory captures `description` at call time, which would
//     freeze the description at activate time. Keeping execution in
//     `createTools()` preserves the per-turn dynamic-description behaviour
//     and the existing pre/post-tool hook calls verbatim. The metadata-only
//     entry here keeps `/extensions` UX and `services.tools.setEnabled(...)`
//     toggles working unchanged.
//
//   - `process_logs`, `process_stop`, `process_list` are fully kernel-owned.
//     They have static descriptions and no hook plumbing, so the migration
//     is mechanical: the old `execute` body becomes a one-liner calling
//     `api.services.bash.*`.
//
// Host coupling:
//
//   - `src/agent/agent.ts` binds the sink at Agent construction via
//     `setBashSink(this.bash)` (the `BashTool` instance structurally
//     satisfies `BashSink`). When the sink is unbound (e.g. headless boot
//     before an Agent is constructed, or after `shutdownExtensions()`) each
//     `services.bash.*` proxy throws `"BashTool is not active..."` — the
//     tool's existing try/catch wrapper turns the throw into a standard
//     `{ success: false, output: "Failed to <op>: ..." }` ToolResult.
//
//   - The three migrated tools were registered without a mode gate by
//     `createTools()` (always available across agent/plan/ask). The kernel-
//     owned versions omit the `modes` field so the kernel mode filter
//     leaves them in every mode's ToolSet. Same end-to-end visibility as
//     before.
//
// Group: keeps the `"bash"` group string the metadata-only extension used
// so user toggles via `services.tools.setEnabled(...)` and `/extensions`
// filters continue to work unchanged.

import { tool } from "ai";
import { z } from "zod";
import { EXTENSIONS_V1_API_VERSION, type ExtensionHostApi, type ExtensionModule } from "../api";
import type { ExtensionManifest } from "../manifest";

const manifest: ExtensionManifest = {
  schemaVersion: 1,
  id: "builtin.tools.bash",
  name: "Bash & Processes",
  version: "1.0.0",
  hostApiVersion: EXTENSIONS_V1_API_VERSION,
  kind: "builtin",
  description: "Shell command execution and background process management.",
  enabledByDefault: true,
  protected: true, // bash is load-bearing for most coding workflows
  capabilities: ["tools"],
};

export const bashToolsExtension: ExtensionModule = {
  manifest,
  activate(api: ExtensionHostApi) {
    // bash — metadata-only. Execution stays in `createTools()` because the
    // description is dynamic (sandbox-aware) and ai-sdk `tool({description})`
    // captures the string at call time. See file header for full rationale.
    api.registerTool({
      name: "bash",
      description: "Execute a shell command.",
      group: "bash",
    });

    api.registerTool({
      name: "process_logs",
      description: "Read logs from a background process.",
      group: "bash",
      tool: tool({
        description:
          "View recent output (stdout + stderr) from a background process by its ID. Returns the last N lines of the log.",
        inputSchema: z.object({
          id: z.number().describe("The background process ID"),
          tail: z.number().optional().describe("Number of lines to return from the end (default: 50)"),
        }),
        execute: async ({ id, tail }) => {
          try {
            return await api.services.bash.getProcessLogs(id, tail);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return { success: false, output: `Failed to read process logs: ${msg}` };
          }
        },
      }),
    });

    api.registerTool({
      name: "process_stop",
      description: "Stop a background process.",
      group: "bash",
      tool: tool({
        description:
          "Stop a running background process by its ID. Sends SIGTERM, then SIGKILL after 3 seconds if still alive.",
        inputSchema: z.object({
          id: z.number().describe("The background process ID to stop"),
        }),
        execute: async ({ id }) => {
          try {
            return await api.services.bash.stopProcess(id);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return { success: false, output: `Failed to stop process: ${msg}` };
          }
        },
      }),
    });

    api.registerTool({
      name: "process_list",
      description: "List active background processes.",
      group: "bash",
      tool: tool({
        description: "List all background processes with their ID, status, PID, age, and command.",
        inputSchema: z.object({}),
        execute: async () => {
          try {
            return api.services.bash.listProcesses();
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return { success: false, output: `Failed to list processes: ${msg}` };
          }
        },
      }),
    });
  },
};
```

- [ ] **Step 2: Remove the old `bashToolsExtension` from `groups.ts`**

Open `src/core/extensions/builtin/groups.ts`. Find the `bashToolsExtension` export (lines 10–22 in the current file). DELETE the entire block — both the leading file-level comment about it and the export itself. In its place, add a NOTE comment matching the existing schedule/subagents/computer-tools/lsp pattern at the bottom of the file:

```ts
// `bashToolsExtension` is now kernel-owned in `./bash-tools.ts`.
// Phase 2 step 7 promoted the three background-process tools (`process_logs`,
// `process_stop`, `process_list`) out of the `base` object in `createTools()`
// (in `src/grok/tools.ts`). The migration uses the mixed-mode pattern: the
// `bash` tool itself stays metadata-only with execution in `createTools()`
// (its description is dynamic / sandbox-aware, which the ai-sdk tool factory
// would otherwise freeze at activate time). The Agent now binds
// `this.bash` at construction via `setBashSink(...)`.
// `loadBuiltinExtensions()` imports the kernel-owned extension directly.
```

The remaining `groups.ts` file should compile and run unchanged — the deleted helper `defineToolGroupExtension` import may now be unused; see Step 3.

After the delete, run:

```bash
bun run typecheck
```

Expected output: a TypeScript error along the lines of

```
src/core/extensions/builtin/index.ts: Module './groups' has no exported member 'bashToolsExtension'.
```

This is expected — Task 2 Step 5 fixes it by re-routing the import. If `defineToolGroupExtension` is reported unused (`'defineToolGroupExtension' is declared but its value is never read`), confirm it's still referenced by `searchToolsExtension` and `mediaToolsExtension` in the same file. If neither references it, remove the import. (It almost certainly stays — search and media still use it.)

- [ ] **Step 3: Wire the new extension in the bundle**

Open `src/core/extensions/builtin/index.ts`. Currently the import block reads:

```ts
import { bashToolsExtension, mediaToolsExtension, searchToolsExtension } from "./groups";
```

Split it: keep `mediaToolsExtension`/`searchToolsExtension` from `./groups`, but pull `bashToolsExtension` from the new `./bash-tools` module:

```ts
import { bashToolsExtension } from "./bash-tools";
import { mediaToolsExtension, searchToolsExtension } from "./groups";
```

The `loadBuiltinExtensions()` function body — which lists `bashToolsExtension` among the tool groups — does not change. Same name, same registration order.

- [ ] **Step 4: Run typecheck**

Run: `bun run typecheck`

Expected: clean.

If TypeScript still complains about `groups` not exporting `bashToolsExtension`, the index.ts edit didn't land. If TypeScript complains about the new `./bash-tools` import path, the file path or `export const bashToolsExtension` is wrong.

- [ ] **Step 5: Write the new test file `src/core/extensions/builtin/bash-tools.test.ts`**

Mirror the structure used by other kernel-owned-tools test files. The tests live in this file because it's where the bash-tools registration code lives; it stays close to source, the way `subagents-tools.test.ts` does for subagents.

**Pre-write verification (advisor refinement).** Before pasting the test source, confirm the barrel re-exports are already wired by the Step 5/6 commits. Run:

```bash
grep -n "from \"../index\"" src/core/extensions/builtin/subagents-tools.test.ts
grep -nE "(__resetExtensionsForTests|bootstrapExtensions|getHostServices)" src/core/extensions/builtin/subagents-tools.test.ts
```

Expected: `subagents-tools.test.ts` already imports `__resetExtensionsForTests`, `bootstrapExtensions`, and `getHostServices` from `../index`. If the imports are absent or routed through a different barrel path, switch the new test's import line to match the existing convention rather than introducing a new one. (Step 1 Step 3 of THIS plan added `setBashSink` + `BashSink` to the same barrel — no further wiring should be needed.)

Create `src/core/extensions/builtin/bash-tools.test.ts`:

```ts
// Tests for the kernel-owned bash-tools extension. Phase 2 step 7.
//
// Coverage:
//   - Manifest shape (id, group string, capabilities).
//   - The four tool names appear in the registry post-bootstrap; `bash` is
//     metadata-only (no `tool` field), the three `process_*` are full
//     kernel-owned (have `tool` field).
//   - When the bash sink is unbound, each `process_*` tool returns a
//     friendly error ToolResult (no throw escapes execute).
//   - When the bash sink is bound, each `process_*` tool forwards correctly
//     and surfaces the ToolResult shape returned by the sink.
//   - Output formatting passthrough — the sink's ToolResult is returned
//     verbatim (no double-wrapping, no description loss).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetExtensionsForTests,
  bootstrapExtensions,
  getHostServices,
  setBashSink,
  type BashSink,
} from "../index";
import { bashToolsExtension } from "./bash-tools";

describe("bashToolsExtension", () => {
  beforeEach(() => {
    __resetExtensionsForTests();
  });

  afterEach(() => {
    setBashSink(null);
    __resetExtensionsForTests();
  });

  it("registers four tool names with the expected ownership model", async () => {
    await bootstrapExtensions([bashToolsExtension]);
    const services = getHostServices();
    const tools = services.tools.list();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["bash", "process_list", "process_logs", "process_stop"]);
    const bash = tools.find((t) => t.name === "bash");
    expect(bash?.tool).toBeUndefined();
    for (const procName of ["process_logs", "process_stop", "process_list"]) {
      const proc = tools.find((t) => t.name === procName);
      expect(proc?.tool, `${procName} must be full kernel-owned`).toBeDefined();
    }
  });

  it("preserves the `bash` group string for all four tools", async () => {
    await bootstrapExtensions([bashToolsExtension]);
    const services = getHostServices();
    const tools = services.tools.list();
    for (const t of tools) {
      expect(t.group).toBe("bash");
    }
  });

  it("returns a friendly error when the sink is unbound", async () => {
    await bootstrapExtensions([bashToolsExtension]);
    const services = getHostServices();
    const toolset = services.tools.toolSet();

    for (const name of ["process_logs", "process_stop", "process_list"] as const) {
      const result = await toolset[name]!.execute!(
        name === "process_logs" || name === "process_stop" ? { id: 1 } : {},
        { toolCallId: `test-${name}`, messages: [] },
      );
      // Single matchObject covers both the `success: false` shape and the
      // friendly-error string — avoids a typed-cast on `result`.
      expect(result, `${name} unbound`).toMatchObject({
        success: false,
        output: expect.stringMatching(/BashTool is not active/),
      });
    }
  });

  it("forwards process_logs to the sink and returns the sink's ToolResult", async () => {
    const sink: BashSink = {
      getProcessLogs: vi.fn(async (id, tail) => ({
        success: true,
        output: `[mock logs id=${id} tail=${tail}]`,
      })),
      stopProcess: vi.fn(),
      listProcesses: vi.fn(),
    };
    await bootstrapExtensions([bashToolsExtension]);
    setBashSink(sink);
    const services = getHostServices();
    const result = await services.tools.toolSet().process_logs!.execute!(
      { id: 7, tail: 30 },
      { toolCallId: "t", messages: [] },
    );
    expect(sink.getProcessLogs).toHaveBeenCalledWith(7, 30);
    expect(result).toEqual({ success: true, output: "[mock logs id=7 tail=30]" });
  });

  it("forwards process_stop to the sink and returns the sink's ToolResult", async () => {
    const sink: BashSink = {
      getProcessLogs: vi.fn(),
      stopProcess: vi.fn(async (id) => ({ success: true, output: `[stopped ${id}]` })),
      listProcesses: vi.fn(),
    };
    await bootstrapExtensions([bashToolsExtension]);
    setBashSink(sink);
    const services = getHostServices();
    const result = await services.tools.toolSet().process_stop!.execute!(
      { id: 9 },
      { toolCallId: "t", messages: [] },
    );
    expect(sink.stopProcess).toHaveBeenCalledWith(9);
    expect(result).toEqual({ success: true, output: "[stopped 9]" });
  });

  it("forwards process_list to the sink and returns the sink's ToolResult", async () => {
    const sink: BashSink = {
      getProcessLogs: vi.fn(),
      stopProcess: vi.fn(),
      listProcesses: vi.fn(() => ({ success: true, output: "[mock listing]" })),
    };
    await bootstrapExtensions([bashToolsExtension]);
    setBashSink(sink);
    const services = getHostServices();
    const result = await services.tools.toolSet().process_list!.execute!(
      {},
      { toolCallId: "t", messages: [] },
    );
    expect(sink.listProcesses).toHaveBeenCalledOnce();
    expect(result).toEqual({ success: true, output: "[mock listing]" });
  });
});
```

If `BashSink` is not exported from `../index`, fall back to importing from `../api` directly: `import type { BashSink } from "../api";` — but Task 1 Step 3 should have re-exported it. If the test compile fails on this import, fix the barrel re-export, not the test.

- [ ] **Step 6: Run the new test file**

Run: `bun run test src/core/extensions/builtin/bash-tools.test.ts`

Expected: all 6 tests pass. If `process_logs unbound` fails with a thrown error that escaped `execute`, the try/catch wrapping in `bash-tools.ts` is missing or wrong — re-check Step 1's `execute` blocks.

If the registry-shape test fails because all four names show up but `bash.tool` is defined, you accidentally added a `tool: tool({...})` field on the `bash` registration in `bash-tools.ts`. Remove it; metadata-only means `name`, `description`, `group` only.

**Worker-isolation sanity check (advisor refinement).** The `bashSink` slot in `loader.ts` is module-level state. vitest's default worker pool gives each test file its own module graph, so the slot is naturally isolated — but we want one explicit confirmation before relying on it. Run the file once with verbose output:

```bash
bun run test src/core/extensions/builtin/bash-tools.test.ts -- --reporter verbose
```

Expected: tests run sequentially within the file (vitest's per-file default) and the friendly-error test does NOT see leftover state from a prior test. If a test fails because the sink is unexpectedly bound or unbound, an `afterEach`/`beforeEach` hook is missing or running in the wrong order — recheck the `setBashSink(null)` + `__resetExtensionsForTests()` calls. Cheap insurance per the advisor's recommendation.

- [ ] **Step 7: Run full typecheck + test suite**

Run: `bun run typecheck`
Expected: clean.

Run: `bun run test`
Expected: all pre-existing tests pass + 6 new tests in `bash-tools.test.ts`. The 4 sandbox-description tests in `tools.test.ts` are unchanged because `bash` itself stayed in `createTools()`.

- [ ] **Step 8: Commit**

Defer commit — Task 2 ships alongside Tasks 1, 3, 4 in a single commit (see Task 1 Step 7 rationale).

---

## Task 3: Drop `process_*` tools from `createTools()`

**Files:**
- Modify: `src/grok/tools.ts`

This task removes the three migrated tools from the per-turn `createTools()` factory. Because the kernel-owned versions are merged into the active ToolSet via `getEnabledToolSet()` AFTER `createTools()`'s output (`{ ...baseTools, ...kernelTools }` at agent.ts:1289, 1966, 2297), the kernel versions would already win on key collision; this step makes the removal explicit and matches the "kernel is the only owner" pattern Step 5/6 used.

- [ ] **Step 1: Remove `process_logs`, `process_stop`, `process_list` from the `base` object**

Open `src/grok/tools.ts`. Find the three tool entries (currently lines 115–144). Delete all three blocks — including the trailing comma after `process_list`. After deletion, the `base` object should jump from the closing `},` of the `bash` tool's `execute` directly to the `read_file` NOTE comment (currently around line 146).

In place of the deleted entries, insert a NOTE comment block matching the existing migration NOTEs in the same file (search for `// read_file moved to` and `// grep moved to` for the pattern):

```ts
    // process_logs / process_stop / process_list moved to a kernel-owned
    // extension at `src/core/extensions/builtin/bash-tools.ts` — see Phase 2
    // step 7 of the kernel-extensibility plan. The extension's full
    // `tool({...})` defs are merged into the agent ToolSet via
    // `getEnabledToolSet()`. The same extension also declares `bash`
    // metadata-only — execution for `bash` itself remains here in
    // `createTools()` because its description is dynamic (sandbox-aware via
    // `bash.getToolDescription()`) and ai-sdk `tool({description})` would
    // capture the string at activate time. Pre/post-tool hook calls also
    // remain inline here. See the bash-tools.ts header for the full
    // mixed-mode rationale.
```

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: clean. If TypeScript complains about an unused import (`generateText`, `tool`, `z`, `BashTool`), confirm the rest of `createTools()` still uses them — `bash`, the search tools, and the media tools all call `tool({...})` and `z.object(...)`, and `BashTool` is the type of the first parameter. None should become unused.

- [ ] **Step 3: Run full test suite**

Run: `bun run test`
Expected: all tests pass — `tools.test.ts`'s 4 sandbox-description tests still pass because `bash` is unchanged. `bash-tools.test.ts`'s 6 new tests pass. No existing test exercised `process_*` via the per-turn `createTools()` path directly (the schedule/subagents Step 5/6 migrations confirmed createTools's output is wrapped via `getEnabledToolSet()` merge before reaching the model); the 6 new tests cover the kernel-owned execute path.

- [ ] **Step 4: Commit**

Defer — see Task 1 Step 7. All four tasks ship in one commit.

---

## Task 4: Bind the sink in the Agent ctor

**Files:**
- Modify: `src/agent/agent.ts`

This task wires the runtime sink. With the kernel-owned tools registered via Task 2 and the per-turn factory updated via Task 3, the only missing piece is the Agent telling the kernel which `BashTool` instance to call back into.

- [ ] **Step 1: Add `setBashSink` to the import**

Open `src/agent/agent.ts`. Find the existing import block from `../core/extensions` (around lines 6–15). Add `setBashSink` alphabetically — it should land BEFORE `setKernelMode`:

```ts
import {
  // ...existing entries...
  runtimeUsesSendTurn,
  setBashSink,
  setKernelMode,
  setScheduleSink,
  setSubagentsSink,
} from "../core/extensions";
```

- [ ] **Step 2: Bind the sink in the constructor**

Find the existing `setScheduleSink(this.schedules)` call (around line 623). Just BELOW it, add the bash sink bind:

```ts
    setScheduleSink(this.schedules);

    // BashTool sink binding. `BashTool` structurally satisfies `BashSink` so
    // we pass it directly. Sink is process-global; multiple Agents in the
    // same process overwrite each other (last-construct wins) — same shape
    // as `setSubagentsSink` and `setScheduleSink` above.
    setBashSink(this.bash);
  }
```

(Verify `this.bash` is already a constructed `BashTool` at this point in the ctor — Step 5/6 commits already put `setSubagentsSink` and `setScheduleSink` here, which run AFTER `this.bash = new BashTool(...)` at line 573. The new call slots in alongside them with no ordering risk.)

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: clean. If TypeScript reports `Argument of type 'BashTool' is not assignable to parameter of type 'BashSink'`, the `BashTool` class is missing one of the three methods or has a divergent signature. Open `src/tools/bash.ts` and confirm:
- `getProcessLogs(id: number, tail = 50): Promise<ToolResult>`
- `stopProcess(id: number): Promise<ToolResult>`
- `listProcesses(): ToolResult`

These match `BashSink` exactly (the optional `tail` defaulting to 50 inside BashTool is fine because `BashSink.getProcessLogs` declares `tail?: number`). If anything has drifted, fix the `BashSink` interface in `api.ts` to match the source method, not the other way around.

- [ ] **Step 4: Run full test suite**

Run: `bun run test`
Expected: all tests pass, including the 6 new bash-tools tests. The Agent-end-to-end tests now exercise the bound-sink path for `process_*` tools instead of the inline-`createTools()` path; behaviour should be byte-for-byte identical because the sink call is a pass-through to the same `BashTool` methods that used to be called inline.

- [ ] **Step 5: Manual smoke**

Run the CLI: `bun run dev`. In an agent-mode session, ask: `start a background process that runs "for i in 1 2 3; do echo $i; sleep 1; done"`. Expected:
- The model issues `bash({ command: "...", background: true })` — note `bash` itself still routes through `createTools()`'s execute, no change.
- Output reports a process ID (e.g. "Started process 1, pid …").
- Then ask: `read the logs for process 1`. The model issues `process_logs({ id: 1 })` — this now routes through the kernel-owned tool → `services.bash.getProcessLogs(1)` → `BashTool.getProcessLogs(1)`. Output should match the pre-migration format exactly: `[Process 1 — running — pid …] [for i in 1 2 3; …] 1\n2\n3` (after the process completes).
- Then ask: `list all background processes`. Issues `process_list({})` — routes through kernel. Output format unchanged.
- Then ask: `stop process 1`. Issues `process_stop({ id: 1 })`. Stops the (already-completed) process; output is "Process 1 already exited (code 0)." Format unchanged.

If any step misbehaves, the most likely cause is a typo in `bash-tools.ts`'s `execute` body (calling the wrong sink method or passing the wrong argument shape).

- [ ] **Step 6: Commit (single commit covering Tasks 1–4)**

```bash
git add src/core/extensions/api.ts src/core/extensions/loader.ts src/core/extensions/index.ts \
        src/core/extensions/builtin/bash-tools.ts src/core/extensions/builtin/groups.ts \
        src/core/extensions/builtin/index.ts src/core/extensions/builtin/bash-tools.test.ts \
        src/grok/tools.ts src/agent/agent.ts
git commit -m "Phase 2 step 7: migrate process_* tools to kernel-owned bash-tools extension"
```

(No `--no-verify` — this commit doesn't touch app.tsx, so the pre-commit biome hook should be clean. If the hook trips on something unexpected, fix the underlying issue rather than skipping.)

DO NOT include `src/core/extensions/catalog.ts` in this commit — per the prior Step 5/6 pattern, it stays excluded as unrelated.

---

## Task 5: Verification + HEARTBEAT/MEMORY update

**Files:**
- Modify: `HEARTBEAT.md`
- Modify: `MEMORY.md`

- [ ] **Step 1: Re-run all gates**

```bash
bun run typecheck
bun run test
bun run lint
bun run build
```

Expected: all four clean.

- [ ] **Step 2: Update HEARTBEAT.md**

Append a new section under today's date (`2026-04-29`):

```markdown
### Phase 2 step 7 — process_* tools to kernel ownership (done)

- New kernel sink: `services.bash` with `getProcessLogs`, `stopProcess`, `listProcesses`. Bound by Agent ctor via `setBashSink(this.bash)` — `BashTool` structurally satisfies `BashSink`. Process-global, last-construct-wins.
- New extension: `builtin.tools.bash` in `src/core/extensions/builtin/bash-tools.ts`. Mixed-mode: `bash` metadata-only (description-only entry; execution stays in `createTools()` because the description is dynamic / sandbox-aware), `process_logs`/`process_stop`/`process_list` fully kernel-owned.
- Removed metadata-only `bashToolsExtension` from `groups.ts`. `loadBuiltinExtensions()` now imports the kernel-owned version directly.
- `createTools()` lost the three `process_*` entries; `bash` and the search/media tools remain.
- Test count: +6 (bash-tools.test.ts). Existing `tools.test.ts` sandbox-description tests still pass — `bash` is unchanged.

**Reduced scope vs original Step 7 spec:**
- `bash` itself NOT migrated to full kernel ownership — preserves dynamic sandbox-aware description.
- `services.hooks` sink deferred — zero current consumers.
- 47 `this.bash.*` references in agent.ts NOT rewired — the Agent still owns the BashTool instance directly.
- Bootstrap activation order unchanged.

**Pending after step 7:** Step 4 (provider-coupled tools) is hard-blocked on Phase 3b. Phase 2 of the kernel-extensibility migration is otherwise complete pending step 4.
```

- [ ] **Step 3: Update MEMORY.md**

Find the Phase 2 progress section. Mark step 7 as done with the reduced-scope note. Match the formatting used for steps 5 and 6.

- [ ] **Step 4: Commit HEARTBEAT/MEMORY**

```bash
git add HEARTBEAT.md MEMORY.md
git commit -m "Phase 2 step 7: HEARTBEAT + MEMORY"
```

(No `--no-verify`; doc-only commit.)

---

## Self-Review Checklist (run after writing the plan)

1. **Spec coverage:**
   - "Three sub-moves, one commit" → reduced to one logical sub-move (process_* tools), single commit (Task 1–4).
   - "BashTool extension owns the 4 tools" → mixed-mode achieved: `bash` metadata-only + `process_*` kernel-owned, all four under `builtin.tools.bash`.
   - "Hooks sink" → deferred. Documented in spec deviations.
   - "Activation-order rewrite" → not needed under reduced scope. Documented.
2. **Placeholder scan:** No "TBD", "TODO", "implement later", "similar to Task N", "appropriate error handling". All code blocks are concrete.
3. **Type consistency:**
   - `BashSink` defined in Task 1 Step 1, referenced consistently in Task 1 Step 2 (loader.ts proxies), Task 1 Step 3 (barrel re-export), Task 2 Step 1 (extension consumes via `api.services.bash.*`), Task 4 Step 2 (Agent passes `this.bash` which structurally satisfies it).
   - `setBashSink` exporter: same name in `loader.ts`, barrel `index.ts`, Agent import. Aliased to nothing at the import site (matches existing `setSubagentsSink`/`setScheduleSink` convention — no `kernel*` prefix in agent.ts).
   - Tool names: `process_logs`/`process_stop`/`process_list` consistent across `createTools()` deletion (Task 3), kernel registration (Task 2 Step 1), test assertions (Task 2 Step 5).
4. **Mixed-mode rationale:** clearly stated at the top of `bash-tools.ts` header AND in the `groups.ts` NOTE comment AND in the `tools.ts` NOTE comment AND in HEARTBEAT. Future-readers will not have to reverse-engineer why `bash` stayed metadata-only.
5. **Commit boundaries:** all code changes in ONE commit (Tasks 1–4), docs in a separate commit (Task 5). Matches the Step 5/6 pattern. No dependency on partial states.

---

## Execution Handoff

Plan complete. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration.
**2. Inline Execution** — execute tasks in this session with checkpoints.

Pick one before starting Task 1. Reuse the existing branch (no worktree, per advisor's earlier guidance). Single commit covers Tasks 1–4; HEARTBEAT/MEMORY commit follows.
