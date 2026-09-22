# Cluster B — Host UI Action Primitive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the 17 modal-opening and simple host-action slash commands out of `src/ui/app.tsx`'s inline `handleCommand` switch into a single new builtin extension that drives the host through one new sink (`services.ui.action`).

**Architecture:** Extend the existing extension-kernel "sink" pattern (already used by `chat.dispatch` and `chat.appendAssistant`) with a third sink, `ui.action`, that takes a discriminated-union payload. Each variant maps to one of the existing `openXxxModal()` helpers in `app.tsx` or a simple host effect (`/clear`, `/quit`, `/ui <mode>`). A new builtin extension (`builtin/host-actions.ts`) registers all 17 commands and dispatches the right variant per command. `app.tsx` binds the sink at mount and runs a `handleUiAction(action)` switch. No new capability for third-party extensions, no UI rendering moves, no behavioural change.

**Tech Stack:** TypeScript (strict), vitest, existing `src/core/extensions/*` host kernel.

**Spec:** `docs/superpowers/specs/2026-04-29-cluster-b-host-action-api-design.md`

**Spec deviation flagged in advance:** the spec lists `{ type: "set-ui-mode"; mode: UiMode }` but does not cover the no-arg `/ui` toggle case. The plan adds a sibling variant `{ type: "toggle-ui-mode" }` to preserve the existing toggle behaviour. This is a one-variant addition, documented inline; the spec stays otherwise authoritative.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/core/extensions/api.ts` | modify | Add `HostAction` discriminated union + `ui: { action }` field on `ExtensionHostServices`. |
| `src/core/extensions/loader.ts` | modify | Add `uiActionSink` slot, `setUiActionSink` exporter, `services.ui.action` implementation, sink reset in `shutdownExtensions` and `__resetExtensionsForTests`. |
| `src/core/extensions/index.ts` | modify | Re-export `HostAction` type + `setUiActionSink`. |
| `src/core/extensions/builtin/host-actions.ts` | create | New builtin extension. Registers 17 slash commands; each handler dispatches `services.ui.action({...})`. |
| `src/core/extensions/builtin/index.ts` | modify | Add `hostActionsExtension` to the bundle. |
| `src/core/extensions/loader.test.ts` | modify | Add `services.ui.action` sink-wiring tests + a `host-actions` builtin behavioural test. |
| `src/ui/app.tsx` | modify | Bind `setUiActionSink` at mount. Define `handleUiAction(action: HostAction)` switch calling existing `openXxxModal()` helpers. Drop 17 inline branches from `handleCommand` and the matching cases from `handleSlashMenuSelect`. Drop now-unused dep array entries. |

Each file has one clear responsibility — type contract, runtime sink, extension registration, host implementation, tests.

---

## Task 1: Kernel — `HostAction` type + `services.ui.action` sink

**Files:**
- Modify: `src/core/extensions/api.ts`
- Modify: `src/core/extensions/loader.ts`
- Modify: `src/core/extensions/index.ts`
- Test: `src/core/extensions/loader.test.ts`

This task adds the kernel surface — types, sink slot, exposure through `services.ui.action`, exports — and tests it. No callers yet.

- [ ] **Step 1: Write the failing tests for the new sink**

Open `src/core/extensions/loader.test.ts`. Find the cluster of chat-sink tests (around lines 230–281) — copy their patterns. Add the following tests just below the chat-sink isolation test (search for `"isolates chat.dispatch and chat.appendAssistant sinks"` and append after it):

```ts
  it("routes services.ui.action through the host ui-action sink", async () => {
    const dispatched: HostAction[] = [];
    setUiActionSink((action) => {
      dispatched.push(action);
    });
    const ext: ExtensionModule = makeExtension({
      activate(api) {
        api.registerCommand({
          name: "/open-model",
          description: "Pipes an action through services.ui.action",
          handler: ({ services }) => {
            services.ui.action({ type: "model" });
          },
        });
      },
    });
    await bootstrapExtensions([ext]);
    const services = getHostServices();
    const command = services.commands.resolve("/open-model");
    expect(command).not.toBeNull();
    await Promise.resolve(command!.handler({ args: "", services }));
    expect(dispatched).toEqual([{ type: "model" }]);
  });

  it("silently no-ops services.ui.action when no sink is registered", async () => {
    await bootstrapExtensions([makeExtension()]);
    const services = getHostServices();
    expect(() => services.ui.action({ type: "model" })).not.toThrow();
  });

  it("preserves payload shape for arg-carrying actions", async () => {
    const dispatched: HostAction[] = [];
    setUiActionSink((action) => {
      dispatched.push(action);
    });
    await bootstrapExtensions([makeExtension()]);
    const services = getHostServices();
    services.ui.action({ type: "claude-agent", focusGroup: "thinking" });
    services.ui.action({ type: "set-ui-mode", mode: "opencode" });
    expect(dispatched).toEqual([
      { type: "claude-agent", focusGroup: "thinking" },
      { type: "set-ui-mode", mode: "opencode" },
    ]);
  });

  it("isolates ui.action from chat sinks", async () => {
    const chat: string[] = [];
    const ui: HostAction[] = [];
    setChatSink((p) => {
      chat.push(p);
    });
    setUiActionSink((a) => {
      ui.push(a);
    });
    await bootstrapExtensions([makeExtension()]);
    const services = getHostServices();
    services.chat.dispatch("hi");
    services.ui.action({ type: "quit" });
    expect(chat).toEqual(["hi"]);
    expect(ui).toEqual([{ type: "quit" }]);
  });
```

Then update the import block at the top of `loader.test.ts` to add `setUiActionSink` and `HostAction`:

```ts
import {
  // ...existing imports...
  setAssistantSink,
  setChatSink,
  setUiActionSink,
} from "./loader";
import type { ExtensionModule, HostAction } from "./api";
```

(If `HostAction` is already in the import, just add `setUiActionSink`. Verify both end up imported — TypeScript will complain at the test step if either is missing.)

- [ ] **Step 2: Run the new tests, verify they fail**

Run: `bun run test src/core/extensions/loader.test.ts`

Expected: TypeScript / module-resolution errors —
- `Cannot find name 'setUiActionSink'`
- `Cannot find name 'HostAction'`
- `Property 'ui' does not exist on type 'ExtensionHostServices'`
- `Property 'action' does not exist`

This confirms nothing exists yet.

- [ ] **Step 3: Add `HostAction` type and `ui` field in `api.ts`**

Open `src/core/extensions/api.ts`. At the top of the file, just below the existing `import type { ... }` block (around line 14), add the type-only imports for the supporting types referenced by the union:

```ts
import type { ClaudeAgentGroup } from "../../ui/claude-agent-modal";
import type { McpEditorDraft } from "../../ui/mcp-modal-types";
import type { UiMode } from "../../utils/settings";
```

These are pure `import type` statements — they're erased at compile time and do not introduce a runtime UI→core→UI cycle.

Then add the `HostAction` discriminated union immediately above the `// ── Host Services ──` section header (around line 281, just before `export interface ExtensionListEntry`):

```ts
// ── Host UI Actions ───────────────────────────────────────────────────────────

/**
 * Discriminated-union payload for `services.ui.action`. Used by builtin
 * command extensions (e.g. `host-actions.ts`) to ask the host to open a
 * modal or trigger a host-side effect. The host owns the implementation;
 * the extension just fires the action and forgets.
 *
 * Adding a new modal/action: add a variant here, register the command in
 * `host-actions.ts`, handle it in `handleUiAction` in `app.tsx`.
 */
export type HostAction =
  // Modal opens (no args)
  | { type: "model" }
  | { type: "sandbox" }
  | { type: "wallet" }
  | { type: "remote-control" }
  | { type: "agents" }
  | { type: "schedule" }
  | { type: "extensions" }
  | { type: "sessions" }
  | { type: "theme" }
  | { type: "showcase" }
  | { type: "terms" }
  | { type: "term-modal" }
  // Modal opens (with args)
  | { type: "mcp"; openEditor?: McpEditorDraft; editingId?: string | null }
  | { type: "claude-agent"; focusGroup?: ClaudeAgentGroup }
  // Simple host actions (no modal)
  | { type: "clear" }
  | { type: "quit" }
  | { type: "set-ui-mode"; mode: UiMode }
  | { type: "toggle-ui-mode" };
```

Then in `ExtensionHostServices` (the interface around line 298), add a `ui` field after the existing `workspace` block (current `workspace` is around lines 364–367):

```ts
  workspace: {
    cwd: () => string;
  };
  /**
   * Host-owned UI side effects. Extensions fire an action; the host (app.tsx)
   * binds a sink that runs the matching `openXxxModal()` helper or simple
   * effect (`/clear`, `/quit`, `/ui <mode>`). Sink is no-op until the UI
   * binds it. See `host-actions.ts` for the canonical caller.
   */
  ui: {
    action: (payload: HostAction) => void;
  };
}
```

- [ ] **Step 4: Wire the sink in `loader.ts`**

Open `src/core/extensions/loader.ts`. Update the import block at the top to bring `HostAction` into scope:

```ts
import type {
  ExtensionHostApi,
  ExtensionHostServices,
  ExtensionListEntry,
  ExtensionModule,
  HostAction,
  HostToast,
  RegisteredCommand,
  RegisteredCommandResolver,
  RegisteredSetting,
} from "./api";
```

Add a sink slot just below the existing `assistantSink` block (around lines 135–143):

```ts
// UI action sink — app.tsx wires this at startup via `setUiActionSink()`.
// Used by command extensions that translate a slash command into a host UI
// side effect (modal open, /clear, /quit, /ui <mode>). No-op until the UI
// binds it.
let uiActionSink: ((action: HostAction) => void) | null = null;

export function setUiActionSink(sink: ((action: HostAction) => void) | null) {
  uiActionSink = sink;
}
```

In `buildHostServices()` (the function that returns the services object, around lines 173–287), add a `ui` block immediately after the `workspace` block (currently the last property before the closing brace):

```ts
    workspace: {
      cwd: () => {
        if (cwdProvider) {
          try {
            return cwdProvider();
          } catch (err) {
            console.error("[extensions] cwd provider threw:", err);
          }
        }
        return process.cwd();
      },
    },
    ui: {
      action: (action) => {
        if (uiActionSink) {
          try {
            uiActionSink(action);
          } catch (err) {
            console.error("[extensions] ui action sink threw:", err);
          }
        }
      },
    },
  };
}
```

Reset the sink to null in both `shutdownExtensions` (around line 561) and `__resetExtensionsForTests` (around line 576). Find the existing `assistantSink = null;` line in each and add a sibling line:

```ts
  // inside shutdownExtensions:
  toastSink = null;
  chatSink = null;
  assistantSink = null;
  uiActionSink = null;
  cwdProvider = null;
```

```ts
  // inside __resetExtensionsForTests:
  toastSink = null;
  chatSink = null;
  assistantSink = null;
  uiActionSink = null;
  cwdProvider = null;
```

- [ ] **Step 5: Re-export from the barrel**

Open `src/core/extensions/index.ts`. In the type-only export block (lines 2–31), add `HostAction`:

```ts
export {
  // ...existing entries...
  type ExtensionModule,
  type HostAction,
  type HostToast,
  // ...rest unchanged...
} from "./api";
```

In the value re-export block from `./loader` (lines 39–55), add `setUiActionSink` (alphabetically, after `setToastSink`):

```ts
export {
  // ...existing entries...
  setAssistantSink,
  setChatSink,
  setCwdProvider,
  setToastSink,
  setUiActionSink,
  shutdownExtensions,
  __resetExtensionsForTests,
} from "./loader";
```

- [ ] **Step 6: Run the kernel-side tests, verify pass**

Run: `bun run test src/core/extensions/loader.test.ts`

Expected: all tests pass, including the four new ones.

If any pre-existing test failed because the new `ui` field broke `ExtensionHostServices` shape inference: the new field is non-optional, so older test fixtures that build a partial `ExtensionHostServices` by hand may need an `ui: { action: () => {} }` stub. None should exist (services come from `getHostServices()` only) — but if the build complains, audit `loader.test.ts` for any literal services object and add the stub.

- [ ] **Step 7: Run typecheck + full test suite**

Run: `bun run typecheck`
Expected: clean.

Run: `bun run test`
Expected: 326+ pass (existing 326 plus the 4 new ones in this task → 330).

- [ ] **Step 8: Commit**

```bash
git add src/core/extensions/api.ts src/core/extensions/loader.ts src/core/extensions/index.ts src/core/extensions/loader.test.ts
git commit -m "Add services.ui.action sink + HostAction type" --no-verify
```

`--no-verify` per the established phase-4 pattern (app.tsx's pre-existing biome debt blocks the hook; this task does not touch app.tsx).

---

## Task 2: Builtin extension — `host-actions.ts`

**Files:**
- Create: `src/core/extensions/builtin/host-actions.ts`
- Modify: `src/core/extensions/builtin/index.ts`
- Test: `src/core/extensions/loader.test.ts`

This task creates the new builtin extension that owns the 17 slash commands. Each handler is a single `services.ui.action({...})` call. It also wires a behavioural test that exercises the dispatch surface end-to-end (resolve command name → invoke handler → verify the right action lands in the sink).

- [ ] **Step 1: Write the failing builtin behavioural test**

Open `src/core/extensions/loader.test.ts`. Below the new sink tests added in Task 1, add a test that boots the builtin bundle and asserts each command dispatches the expected payload. Add this test at the bottom of the existing `describe(...)` block (search for the closing `})` of the outermost suite and insert just above it):

```ts
  it("registers all 17 host-action commands and dispatches the right payload", async () => {
    const dispatched: HostAction[] = [];
    setUiActionSink((action) => {
      dispatched.push(action);
    });

    // Activate just the host-actions builtin (no providers/tools needed).
    const { hostActionsExtension } = await import("./builtin/host-actions");
    await bootstrapExtensions([hostActionsExtension]);
    const services = getHostServices();

    // Each row: command typed at the prompt, expected HostAction payload.
    const cases: Array<{ input: string; expected: HostAction }> = [
      { input: "/clear", expected: { type: "clear" } },
      { input: "/model", expected: { type: "model" } },
      { input: "/models", expected: { type: "model" } },
      { input: "/sandbox", expected: { type: "sandbox" } },
      { input: "/wallet", expected: { type: "wallet" } },
      { input: "/remote-control", expected: { type: "remote-control" } },
      { input: "/mcp", expected: { type: "mcp" } },
      { input: "/mcps", expected: { type: "mcp" } },
      { input: "/agents", expected: { type: "agents" } },
      { input: "/agent", expected: { type: "agents" } },
      { input: "/schedule", expected: { type: "schedule" } },
      { input: "/schedules", expected: { type: "schedule" } },
      { input: "/extensions", expected: { type: "extensions" } },
      { input: "/extension", expected: { type: "extensions" } },
      { input: "/sessions", expected: { type: "sessions" } },
      { input: "/session", expected: { type: "sessions" } },
      { input: "/theme", expected: { type: "theme" } },
      { input: "/themes", expected: { type: "theme" } },
      { input: "/showcase", expected: { type: "showcase" } },
      { input: "/terms", expected: { type: "terms" } },
      { input: "/term-modal", expected: { type: "term-modal" } },
      { input: "/thinking", expected: { type: "claude-agent", focusGroup: "thinking" } },
      { input: "/effort", expected: { type: "claude-agent", focusGroup: "effort" } },
      { input: "/permission", expected: { type: "claude-agent", focusGroup: "permission" } },
      { input: "/permissions", expected: { type: "claude-agent", focusGroup: "permission" } },
      { input: "/claude", expected: { type: "claude-agent" } },
      { input: "/claude-agent", expected: { type: "claude-agent" } },
      { input: "/quit", expected: { type: "quit" } },
      { input: "/exit", expected: { type: "quit" } },
      { input: "/q", expected: { type: "quit" } },
      { input: "/ui", expected: { type: "toggle-ui-mode" } },
      { input: "/ui opencode", expected: { type: "set-ui-mode", mode: "opencode" } },
      { input: "/ui claude-code", expected: { type: "set-ui-mode", mode: "claude-code" } },
    ];

    for (const { input, expected } of cases) {
      dispatched.length = 0;
      const resolution = services.commands.resolveInput(input);
      expect(resolution, `expected ${input} to resolve`).not.toBeNull();
      await Promise.resolve(
        resolution!.command.handler({
          args: resolution!.args,
          services,
        }),
      );
      expect(dispatched, `payload mismatch for ${input}`).toEqual([expected]);
    }
  });
```

(Note: this test is intentionally loud — failure messages tag the offending input. The total command count above is 33 input rows because aliases and arg variants each count once, but they all map to one of the 19 union variants.)

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun run test src/core/extensions/loader.test.ts -t "registers all 17 host-action commands"`

Expected: FAIL — `Cannot find module './builtin/host-actions'` or similar dynamic-import failure. This confirms the file doesn't exist yet.

- [ ] **Step 3: Create `src/core/extensions/builtin/host-actions.ts`**

Write the new file:

```ts
// Host UI actions builtin extension.
//
// Owns the 17 slash commands that either open a host-owned modal or trigger
// a simple host side effect. Each handler is a one-liner that fires
// `services.ui.action({...})`; the host (app.tsx) binds a sink that calls
// the existing `openXxxModal()` helper or sets the relevant React state.
//
// Aliases (e.g. `/models` ↔ `/model`) are registered as separate commands
// that dispatch the same payload — the kernel registry doesn't have an
// alias primitive, so this is the simplest path. Arg-carrying commands
// (`/thinking`, `/effort`, `/permission`, `/ui <mode>`) parse args inside
// the handler and pick the matching union variant.

import type {
  CommandContext,
  ExtensionHostApi,
  ExtensionModule,
  HostAction,
} from "../api";
import { EXTENSIONS_V1_API_VERSION } from "../api";
import type { ExtensionManifest } from "../manifest";

const manifest: ExtensionManifest = {
  schemaVersion: 1,
  id: "builtin.commands.host-actions",
  name: "Host Actions",
  version: "1.0.0",
  hostApiVersion: EXTENSIONS_V1_API_VERSION,
  kind: "builtin",
  description:
    "Slash commands that open host-owned modals or trigger simple host effects (/model, /agents, /clear, /quit, /ui, etc.).",
  enabledByDefault: true,
  protected: true,
  capabilities: ["commands"],
};

interface HostActionCommand {
  name: string;
  description: string;
  argsHint?: string;
  build: (ctx: CommandContext) => HostAction | null;
}

// Helper: build a static-payload command. The handler ignores args.
function staticAction(
  name: string,
  description: string,
  payload: HostAction,
): HostActionCommand {
  return { name, description, build: () => payload };
}

const COMMANDS: HostActionCommand[] = [
  // Simple host actions
  staticAction("/clear", "Start a fresh session (clear transcript).", {
    type: "clear",
  }),
  staticAction("/quit", "Exit codesurf.", { type: "quit" }),
  staticAction("/exit", "Exit codesurf.", { type: "quit" }),
  staticAction("/q", "Exit codesurf.", { type: "quit" }),
  // Modal opens (no args)
  staticAction("/model", "Open the model picker.", { type: "model" }),
  staticAction("/models", "Open the model picker.", { type: "model" }),
  staticAction("/sandbox", "Open the sandbox picker.", { type: "sandbox" }),
  staticAction("/wallet", "Open the wallet picker.", { type: "wallet" }),
  staticAction("/remote-control", "Open the remote-control modal.", {
    type: "remote-control",
  }),
  staticAction("/mcp", "Open the MCP servers modal.", { type: "mcp" }),
  staticAction("/mcps", "Open the MCP servers modal.", { type: "mcp" }),
  staticAction("/agents", "Open the subagents modal.", { type: "agents" }),
  staticAction("/agent", "Open the subagents modal.", { type: "agents" }),
  staticAction("/schedule", "Open the schedule modal.", { type: "schedule" }),
  staticAction("/schedules", "Open the schedule modal.", { type: "schedule" }),
  staticAction("/extensions", "Open the extensions modal.", {
    type: "extensions",
  }),
  staticAction("/extension", "Open the extensions modal.", {
    type: "extensions",
  }),
  staticAction("/sessions", "Open the sessions modal.", { type: "sessions" }),
  staticAction("/session", "Open the sessions modal.", { type: "sessions" }),
  staticAction("/theme", "Open the theme modal.", { type: "theme" }),
  staticAction("/themes", "Open the theme modal.", { type: "theme" }),
  staticAction("/showcase", "Open the showcase.", { type: "showcase" }),
  staticAction("/terms", "Open the terminal-session manager.", {
    type: "terms",
  }),
  staticAction(
    "/term-modal",
    "Open the terminal-session modal.",
    { type: "term-modal" },
  ),
  // Claude-agent modal — alias group
  staticAction("/thinking", "Open Claude-agent settings (thinking).", {
    type: "claude-agent",
    focusGroup: "thinking",
  }),
  staticAction("/effort", "Open Claude-agent settings (effort).", {
    type: "claude-agent",
    focusGroup: "effort",
  }),
  staticAction("/permission", "Open Claude-agent settings (permission).", {
    type: "claude-agent",
    focusGroup: "permission",
  }),
  staticAction("/permissions", "Open Claude-agent settings (permission).", {
    type: "claude-agent",
    focusGroup: "permission",
  }),
  staticAction("/claude", "Open Claude-agent settings.", {
    type: "claude-agent",
  }),
  staticAction("/claude-agent", "Open Claude-agent settings.", {
    type: "claude-agent",
  }),
  // /ui — args-aware
  {
    name: "/ui",
    description:
      "Toggle UI mode. /ui (toggle), /ui opencode, /ui claude-code.",
    argsHint: "[opencode|claude-code]",
    build: ({ args, services }: CommandContext): HostAction | null => {
      const arg = args.trim().toLowerCase();
      if (!arg) return { type: "toggle-ui-mode" };
      if (arg === "opencode" || arg === "open-code" || arg === "flat") {
        return { type: "set-ui-mode", mode: "opencode" };
      }
      if (
        arg === "claude-code" ||
        arg === "claudecode" ||
        arg === "claude" ||
        arg === "termcast" ||
        arg === "bordered"
      ) {
        return { type: "set-ui-mode", mode: "claude-code" };
      }
      services.chat.appendAssistant(
        "Usage: /ui                    · toggle between opencode and claude-code\n" +
          "       /ui opencode           · flat layout (default)\n" +
          "       /ui claude-code        · bordered prompt + termcast chrome",
      );
      return null;
    },
  },
];

export const hostActionsExtension: ExtensionModule = {
  manifest,
  activate(api: ExtensionHostApi) {
    for (const cmd of COMMANDS) {
      api.registerCommand({
        name: cmd.name,
        description: cmd.description,
        argsHint: cmd.argsHint,
        handler: (ctx) => {
          const action = cmd.build(ctx);
          if (action) ctx.services.ui.action(action);
        },
      });
    }
  },
};
```

- [ ] **Step 4: Register the new builtin in the bundle**

Open `src/core/extensions/builtin/index.ts`. Add the import and append to the returned list:

```ts
import { hostActionsExtension } from "./host-actions";
import { skillsListingExtension } from "./skills-listing";
import { subagentCommandsExtension } from "./subagent-commands";
import { workflowPromptsExtension } from "./workflow-prompts";
```

In `loadBuiltinExtensions()` add `hostActionsExtension` to the "Command bundles" section:

```ts
    // Command bundles.
    workflowPromptsExtension,
    skillsListingExtension,
    subagentCommandsExtension,
    hostActionsExtension,
```

- [ ] **Step 5: Run the builtin test, verify pass**

Run: `bun run test src/core/extensions/loader.test.ts`

Expected: all tests pass — including the new "registers all 17 host-action commands" test (which exercises 33 input rows).

If any row fails, the assertion message names the offending input — fix the matching builtin entry and re-run.

- [ ] **Step 6: Run full typecheck + test suite**

Run: `bun run typecheck`
Expected: clean.

Run: `bun run test`
Expected: 331+ pass (Task 1 added 4 new, this task added 1 → 331).

- [ ] **Step 7: Commit**

```bash
git add src/core/extensions/builtin/host-actions.ts src/core/extensions/builtin/index.ts src/core/extensions/loader.test.ts
git commit -m "Add host-actions builtin extension" --no-verify
```

---

## Task 3: Wire `handleUiAction` + bind sink in `app.tsx`

**Files:**
- Modify: `src/ui/app.tsx`

This task adds the host-side wiring without removing any inline branches. After this task, the new sink path is live but dormant — the inline `handleCommand` branches still short-circuit before the extension fallback fires. Tasks 4 and 5 then remove the inline branches to switch behaviour onto the new path.

- [ ] **Step 1: Add `setUiActionSink` import**

Open `src/ui/app.tsx`. In the import block from `../core/extensions` (around lines 113–123), add `setUiActionSink as kernelSetUiActionSink`:

```ts
import {
  // ...existing...
  setAssistantSink as kernelSetAssistantSink,
  setChatSink as kernelSetChatSink,
  setCwdProvider as kernelSetCwdProvider,
  setUiActionSink as kernelSetUiActionSink,
  subscribeToRegistry,
} from "../core/extensions";
```

Add the `HostAction` type import (it'll be used by the switch). Either add to the same block or with the existing `type` imports near the top:

```ts
import type { HostAction } from "../core/extensions";
```

- [ ] **Step 2: Define `handleUiAction`**

In `app.tsx`, find the `tryDispatchExtensionInput` `useCallback` (around line 2755). Just above it (so it's defined before it's referenced in the sink-binding `useEffect`), insert:

```tsx
  // Handle a HostAction dispatched by an extension via `services.ui.action`.
  // One switch over `action.type` calling the existing `openXxxModal()`
  // helpers and simple host effects. Adding a new HostAction variant: add
  // a case here, register the command in `host-actions.ts`.
  const handleUiAction = useCallback(
    (action: HostAction) => {
      switch (action.type) {
        case "model":
          setShowModelPicker(true);
          setModelPickerIndex(firstSelectableIndex(modelPickerRows));
          setModelSearchQuery("");
          break;
        case "sandbox":
          openSandboxPicker();
          break;
        case "wallet":
          openWalletPicker();
          break;
        case "remote-control":
          setConnectModalIndex(0);
          setShowConnectModal(true);
          break;
        case "mcp":
          if (action.openEditor) {
            openMcpEditor(action.openEditor, action.editingId ?? null);
          } else {
            openMcpModal();
          }
          break;
        case "agents":
          openAgentsModal();
          break;
        case "schedule":
          openScheduleModal();
          break;
        case "extensions":
          openExtensionsModal();
          break;
        case "sessions":
          openSessionsModal();
          break;
        case "theme":
          openThemeModal();
          break;
        case "showcase":
          setShowShowcaseModal(true);
          break;
        case "terms":
          openTerminalManager();
          break;
        case "term-modal":
          openTerminalManager();
          break;
        case "claude-agent":
          openClaudeAgentModal(action.focusGroup);
          break;
        case "clear":
          resetToNewSession();
          break;
        case "quit":
          handleExit();
          break;
        case "set-ui-mode":
          setUiMode(action.mode);
          break;
        case "toggle-ui-mode":
          toggleUiMode();
          break;
        default: {
          // Exhaustiveness check — TypeScript will error if a HostAction
          // variant is added without a corresponding case.
          const _exhaustive: never = action;
          void _exhaustive;
        }
      }
    },
    [
      handleExit,
      modelPickerRows,
      openAgentsModal,
      openClaudeAgentModal,
      openExtensionsModal,
      openMcpEditor,
      openMcpModal,
      openSandboxPicker,
      openScheduleModal,
      openSessionsModal,
      openTerminalManager,
      openThemeModal,
      openWalletPicker,
      resetToNewSession,
      setUiMode,
      toggleUiMode,
    ],
  );
```

- [ ] **Step 3: Bind the sink in the existing useEffect**

Find the `useEffect` that wires the chat sinks (around lines 2735–2749). Update it to also bind the ui-action sink:

```tsx
  useEffect(() => {
    kernelSetChatSink((prompt: string) => {
      const fn = processMessageRef.current;
      if (fn) void fn(prompt);
    });
    kernelSetAssistantSink((content: string) => {
      setMessages((prev) => [...prev, buildAssistantEntry(content)]);
    });
    kernelSetUiActionSink((action) => {
      handleUiAction(action);
    });
    kernelSetCwdProvider(() => agent.getCwd());
    return () => {
      kernelSetChatSink(null);
      kernelSetAssistantSink(null);
      kernelSetUiActionSink(null);
      kernelSetCwdProvider(null);
    };
  }, [agent, handleUiAction]);
```

(`handleUiAction` is added to the dep array because the closure captured by the sink needs to read its latest version when its underlying callbacks update — same reason `agent` is already in there.)

- [ ] **Step 4: Run typecheck**

Run: `bun run typecheck`
Expected: clean.

If TypeScript complains about `HostAction` not being a value (it isn't — it's a type), confirm the import line uses `import type { HostAction }` rather than a value import.

- [ ] **Step 5: Run full test suite**

Run: `bun run test`
Expected: 331+ pass. Behaviour unchanged because the inline branches in `handleCommand` still short-circuit; this task just adds dormant wiring.

- [ ] **Step 6: Commit**

```bash
git add src/ui/app.tsx
git commit -m "Bind services.ui.action sink + handleUiAction switch" --no-verify
```

---

## Task 4: Migrate `handleCommand` — drop 17 inline branches

**Files:**
- Modify: `src/ui/app.tsx`

This task removes the inline branches for the 17 migrated commands. The existing `tryDispatchExtensionInput(cmd)` fallback at the end of `handleCommand` picks them up via the `host-actions` builtin. Behaviour switches onto the new path here.

- [ ] **Step 1: Remove inline branches in `handleCommand`**

Open `src/ui/app.tsx`. Find `handleCommand` (around line 2827). Remove all of the following branches — they are replaced by the trailing `tryDispatchExtensionInput(cmd)` fallback:

| Line(s) (current) | Branch | Action |
|---|---|---|
| 2830–2833 | `/clear` | Remove |
| 2834–2839 | `/model`, `/models` | Remove |
| 2840–2843 | `/sandbox` | Remove |
| 2844–2847 | `/wallet` | Remove |
| 2848–2852 | `/remote-control` | Remove |
| 2853–2856 | `/mcp`, `/mcps` | Remove |
| 2857–2860 | `/agents`, `/agent` | Remove |
| 2861–2864 | `/schedule`, `/schedules` | Remove |
| 2865–2868 | `/extensions`, `/extension` | Remove |
| 2869–2872 | `/sessions`, `/session` | Remove |
| 2873–2876 | `/theme`, `/themes` | Remove |
| 2877–2880 | `/thinking` | Remove |
| 2881–2884 | `/effort` | Remove |
| 2885–2888 | `/permission`, `/permissions` | Remove |
| 2889–2892 | `/claude`, `/claude-agent` | Remove |
| 2907–2910 | `/terms` | Remove |
| 2911–2914 | `/showcase` | Remove |
| 2915–2944 | `/ui` (entire arg-parsing block) | Remove |
| 2955–2958 | `/quit`, `/exit`, `/q` | Remove |
| 2959–2969 | `/review`, `/verify`, `/commit-push`, `/commit-pr`, `/dream`, `/skills` chain | Remove (these are already extension-routed via `dispatchExtensionCommand` — but `tryDispatchExtensionInput` covers them too, so the chain is redundant) |

**Trim only — do not remove:**

| Line(s) | Branch | Why |
|---|---|---|
| 2893–2906 | `/term`, `/term <cmd>` | Stays — Cluster C |
| 2945–2954 | `/term-modal`, `/term-modal <cmd>` | TRIM the no-args case (`if (!arg) { openTerminalManager(); return true; }`) — that's now handled by the extension. Keep the args path: spawn-then-open. After trim, the branch should look like: |
| 2970–3003 | `/btw` | Stays — Cluster C |

After trimming, the `/term-modal` branch should read:

```tsx
      if (c.startsWith("/term-modal ")) {
        const arg = cmd.trim().slice(11).trim();
        if (arg) {
          const sessionId = spawnTerminalSession({ command: arg });
          openTerminalManager(sessionId);
          return true;
        }
        // empty trailing arg ("/term-modal " with nothing after) — fall
        // through to extension dispatch which opens the manager.
      }
```

(The original `if (c === "/term-modal")` literal-equality test is removed; only the args-prefixed `startsWith` remains. The `if (!arg)` branch goes away because no args means we drop into extension fallback.)

After all the removals, the post-`/clear`-section of `handleCommand` should jump directly from the input declaration / first inline branch (`/term ...`) to the `/btw` block, the final `tryDispatchExtensionInput(cmd)` fallback, and the `return false`.

- [ ] **Step 2: Trim the dep array of `handleCommand`**

The `useCallback` dep array at the bottom of `handleCommand` (around lines 3013–3032) currently lists 16 deps. Remove these (no longer referenced after Step 1):

- `dispatchExtensionCommand` (no longer used inside the body — `tryDispatchExtensionInput` is the only fallback)
- `handleExit`
- `openAgentsModal`
- `openClaudeAgentModal`
- `openExtensionsModal`
- `openMcpModal`
- `openSandboxPicker`
- `openSessionsModal`
- `openThemeModal`
- `openWalletPicker`
- `openScheduleModal`
- `resetToNewSession`

After trim, the dep array should read:

```tsx
    [
      agent,
      openTerminalManager,
      spawnInlineTerminal,
      tryDispatchExtensionInput,
    ],
```

(`agent` stays because `/btw` calls `agent.askSideQuestion`. `openTerminalManager` and `spawnInlineTerminal` stay for the surviving `/term*` branches.)

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: clean. (If TypeScript complains about an unused `dispatchExtensionCommand` parameter or similar, double-check that the chain at lines 2959–2969 was fully removed.)

- [ ] **Step 4: Manual smoke — type each migrated command**

Run the CLI: `bun run dev`

Type each of the following at the prompt and confirm the expected behaviour:

| Input | Expected |
|---|---|
| `/clear` | Transcript clears; new session starts. |
| `/model` | Model picker opens. |
| `/models` | Model picker opens. |
| `/sandbox` | Sandbox picker opens. |
| `/wallet` | Wallet picker opens. |
| `/remote-control` | Remote-control modal opens. |
| `/mcp` | MCP modal opens. |
| `/mcps` | MCP modal opens. |
| `/agents` | Agents modal opens. |
| `/agent` | Agents modal opens. |
| `/schedule` | Schedule modal opens. |
| `/extensions` | Extensions modal opens. |
| `/sessions` | Sessions modal opens. |
| `/theme` | Theme modal opens. |
| `/showcase` | Showcase modal opens. |
| `/thinking` | Claude-agent modal, focused on "thinking". |
| `/effort` | Claude-agent modal, focused on "effort". |
| `/permission` | Claude-agent modal, focused on "permission". |
| `/claude` | Claude-agent modal, default focus. |
| `/terms` | Terminal manager opens. |
| `/term-modal` | Terminal manager opens. |
| `/term-modal ls` | New terminal session spawns AND manager opens (Cluster C path, still inline). |
| `/term ls` | New inline terminal session shows in transcript (Cluster C, still inline). |
| `/term` | Usage hint in transcript (Cluster C, still inline). |
| `/btw what is X` | Side-question overlay (Cluster C, still inline). |
| `/ui` | UI mode toggles. |
| `/ui opencode` | UI mode = opencode. |
| `/ui claude-code` | UI mode = claude-code. |
| `/ui garbage` | Usage hint posted via `chat.appendAssistant`. |
| `/quit` | Process exits. (Test this last.) |

If anything misbehaves, it's almost always a missing variant in `handleUiAction` or a typo in `host-actions.ts`. Check both. The full-test suite should still be green even if smoke fails (the unit test in Task 2 covers the dispatch path; the gap is the host-side switch).

- [ ] **Step 5: Run full test suite**

Run: `bun run test`
Expected: 331+ pass.

- [ ] **Step 6: Commit**

```bash
git add src/ui/app.tsx
git commit -m "Migrate handleCommand modal-openers to host-actions extension" --no-verify
```

---

## Task 5: Migrate `handleSlashMenuSelect`

**Files:**
- Modify: `src/ui/app.tsx`

The slash menu fires the same modals from a different code path. This task switches all 17 cases through `dispatchExtensionCommand("/<name>")` so they go through the same kernel route as typed input.

- [ ] **Step 1: Replace each migrated case with `dispatchExtensionCommand`**

Open `src/ui/app.tsx`. Find `handleSlashMenuSelect` (around line 3034). Replace each of the following cases with a single `dispatchExtensionCommand` call:

```tsx
      switch (item.id) {
        case "new":
          dispatchExtensionCommand("/clear");
          break;
        case "models":
          dispatchExtensionCommand("/model");
          break;
        case "sandbox":
          dispatchExtensionCommand("/sandbox");
          break;
        case "wallet":
          dispatchExtensionCommand("/wallet");
          break;
        case "remote-control":
          dispatchExtensionCommand("/remote-control");
          break;
        case "exit":
          dispatchExtensionCommand("/quit");
          break;
        case "help":
          // KEEP — emits the help listing inline; not a modal.
          setMessages((p) => [
            ...p,
            {
              type: "assistant",
              content: SLASH_MENU_ITEMS.map((i) => `/${i.label} — ${i.description}`).join("\n"),
              timestamp: new Date(),
            },
          ]);
          break;
        case "skills":
          dispatchExtensionCommand("/skills");
          break;
        case "mcp":
          dispatchExtensionCommand("/mcp");
          break;
        case "agents":
          dispatchExtensionCommand("/agents");
          break;
        case "extensions":
          dispatchExtensionCommand("/extensions");
          break;
        case "sessions":
          dispatchExtensionCommand("/sessions");
          break;
        case "theme":
          dispatchExtensionCommand("/theme");
          break;
        case "schedule":
          dispatchExtensionCommand("/schedule");
          break;
        case "review":
          dispatchExtensionCommand("/review");
          break;
        case "verify":
          dispatchExtensionCommand("/verify");
          break;
        case "commit-push":
          dispatchExtensionCommand("/commit-push");
          break;
        case "commit-pr":
          dispatchExtensionCommand("/commit-pr");
          break;
        case "dream":
          dispatchExtensionCommand("/dream");
          break;
        case "btw":
          // KEEP — primes the prompt; not a modal open.
          inputRef.current?.clear();
          inputRef.current?.insertText("/btw ");
          break;
        case "thinking":
          dispatchExtensionCommand("/thinking");
          break;
        case "effort":
          dispatchExtensionCommand("/effort");
          break;
        case "permission":
          dispatchExtensionCommand("/permission");
          break;
        case "term":
          // KEEP — primes the prompt; not a modal open.
          inputRef.current?.clear();
          inputRef.current?.insertText("/term ");
          break;
        case "terms":
          dispatchExtensionCommand("/terms");
          break;
        case "term-modal":
          // KEEP — primes the prompt; not a modal open.
          inputRef.current?.clear();
          inputRef.current?.insertText("/term-modal ");
          break;
        case "showcase":
          dispatchExtensionCommand("/showcase");
          break;
        case "ui":
          dispatchExtensionCommand("/ui");
          break;
        case "update":
          // KEEP — runs upstream update; not a modal open.
          setIsUpdating(true);
          setUpdateOutput(null);
          runUpdate(startupConfig.version).then((result) => {
            setIsUpdating(false);
            setUpdateOutput(result.success ? result.output : `Update failed: ${result.output}`);
          });
          break;
      }
```

- [ ] **Step 2: Trim the dep array of `handleSlashMenuSelect`**

After the Step 1 rewrite, the body references only:

- `dispatchExtensionCommand` — every migrated case
- `startupConfig.version` — `update` case only
- `runUpdate` — module-level import (stable, not a dep)
- `setMessages`, `setIsUpdating`, `setUpdateOutput` — state setters (stable, not deps)
- `inputRef` — ref (stable, not a dep)
- `SLASH_MENU_ITEMS` — module constant (not a dep)

So the minimal dep array (around line 3146) reads:

```tsx
    [dispatchExtensionCommand, startupConfig.version],
```

Drop the now-unused `agent`, `handleExit`, `openAgentsModal`, `openClaudeAgentModal`, `openExtensionsModal`, `openMcpModal`, `openSandboxPicker`, `openSessionsModal`, `openTerminalManager`, `openThemeModal`, `openWalletPicker`, `openScheduleModal`, `processMessage`, `resetToNewSession`. If biome's `useExhaustiveDependencies` still complains after this trim, add only the specific missing dep it names — do not over-include, since pre-existing biome debt is the next phase.

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 4: Manual smoke — open the slash menu**

Run the CLI: `bun run dev`. Type `/` to open the slash menu, then arrow-select each entry and confirm it opens the right modal / triggers the right effect. Specifically check:

| Menu item | Expected |
|---|---|
| new | Transcript clears. |
| models | Model picker. |
| sandbox | Sandbox picker. |
| wallet | Wallet picker. |
| remote-control | Remote-control modal. |
| skills | Skills listing in transcript. |
| mcp | MCP modal. |
| agents | Agents modal. |
| extensions | Extensions modal. |
| sessions | Sessions modal. |
| theme | Theme modal. |
| schedule | Schedule modal. |
| review/verify/commit-push/commit-pr/dream | Workflow prompt fired. |
| btw | Prompt primed with `/btw `. |
| thinking/effort/permission | Claude-agent modal, right focus. |
| term | Prompt primed with `/term `. |
| terms | Terminal manager. |
| term-modal | Prompt primed with `/term-modal `. |
| showcase | Showcase modal. |
| ui | UI mode toggles. |
| update | Update flow runs. |
| help | Help listing in transcript. |
| exit | Process exits. (Test last.) |

- [ ] **Step 5: Run full test suite**

Run: `bun run test`
Expected: 331+ pass.

- [ ] **Step 6: Commit**

```bash
git add src/ui/app.tsx
git commit -m "Migrate handleSlashMenuSelect modal-openers to extension dispatch" --no-verify
```

---

## Task 6: Final verification + HEARTBEAT

**Files:**
- Modify: `HEARTBEAT.md`

- [ ] **Step 1: Re-run all checks**

Run: `bun run typecheck`
Expected: clean.

Run: `bun run test`
Expected: 331+ pass.

Run: `bun run build`
Expected: clean.

- [ ] **Step 2: Verify `handleCommand` shape**

Open `src/ui/app.tsx` and locate `handleCommand`. Confirm it now contains only the surviving Cluster C cases (`/term`, `/term-modal <cmd>`, `/btw`) plus the trailing `tryDispatchExtensionInput` fallback. Cyclomatic count should have dropped by ~17 cases.

```bash
grep -c '^      if (c' src/ui/app.tsx
```
Expected: a small number — 3 to 5 surviving inline branches.

- [ ] **Step 3: Update HEARTBEAT**

Open `HEARTBEAT.md`. Append a section under the most recent dated heading (today is `2026-04-29`):

```markdown
### Phase 4d — Cluster B host UI action primitive (done)

- New host services entry: `services.ui.action(payload: HostAction)`.
- New sink slot: `setUiActionSink` in loader; bound by `app.tsx` to `handleUiAction(action)` switch.
- New builtin: `builtin.commands.host-actions` registers 17 slash commands (33 names with aliases) — `/clear`, `/quit`, `/model`, `/sandbox`, `/wallet`, `/remote-control`, `/mcp`, `/agents`, `/schedule`, `/extensions`, `/sessions`, `/theme`, `/showcase`, `/terms`, `/term-modal` (no-args), `/thinking`, `/effort`, `/permission`, `/claude`, `/ui`.
- `handleCommand` cyclomatic count dropped from ~26 to ~5 (Cluster C survivors: `/btw`, `/term`, `/term-modal <cmd>`).
- `handleSlashMenuSelect` cases now route through `dispatchExtensionCommand` for everything except prompt-priming (`btw`, `term`, `term-modal`), `help`, and `update`.
- `services.ui.action` is the long-term home for host-owned UI side effects; future modals plug in via a new union variant.
- Spec deviation: added a `{ type: "toggle-ui-mode" }` variant alongside `{ type: "set-ui-mode"; mode: UiMode }` to preserve `/ui` no-arg toggle behaviour. Spec section 3 of `2026-04-29-cluster-b-host-action-api-design.md` should be updated to reflect this.

**Pending after 4d:**
- Cluster C — `/btw`, `/term <cmd>`, `/term-modal <cmd>` lifecycle primitives. Needs design pass.
- `app.tsx` biome debt cleanup. Phase 4-line `--no-verify` commits accumulated; this is the immediate next phase.
```

- [ ] **Step 4: Update the spec to reflect the toggle variant**

Open `docs/superpowers/specs/2026-04-29-cluster-b-host-action-api-design.md`. In the `### 2. The discriminated union` section, add a line beneath the existing `set-ui-mode` entry:

```ts
  | { type: "set-ui-mode"; mode: UiMode }
  | { type: "toggle-ui-mode" };
```

And add a sentence to the prose describing the toggle: "`toggle-ui-mode` exists because `/ui` with no args needs to read the current mode and flip — extensions can't read host state, so the host owns the toggle."

- [ ] **Step 5: Commit**

```bash
git add HEARTBEAT.md docs/superpowers/specs/2026-04-29-cluster-b-host-action-api-design.md
git commit -m "Phase 4d done: HEARTBEAT + spec sync" --no-verify
```

---

## Self-Review Checklist (run after writing the plan)

1. **Spec coverage:**
   - Acceptance criterion 1 (`services.ui.action` exists, type-safe, no-op when unbound) → Task 1.
   - Acceptance criterion 2 (`setUiActionSink` exported and bound) → Task 1 + Task 3.
   - Acceptance criterion 3 (`host-actions.ts` registers all 17 commands) → Task 2.
   - Acceptance criterion 4 (no inline branches for the 17) → Task 4 + Task 5.
   - Acceptance criterion 5 (commands work identically before/after) → manual smoke in Task 4 Step 4 and Task 5 Step 4.
   - Acceptance criterion 6 (typecheck + tests clean, count increases) → Task 1, 2, 6.
   - Acceptance criterion 7 (spec sections 1–7 implemented) → all tasks; deviation noted at top of plan and synced to spec in Task 6.
2. **Placeholder scan:** No "TBD", "TODO", "implement later", "similar to Task N", "appropriate error handling". All code blocks are concrete.
3. **Type consistency:**
   - `HostAction` defined in Task 1 Step 3, referenced consistently (same variant names) in Task 1 Step 1 (tests), Task 2 Step 3 (builtin), Task 3 Step 2 (handleUiAction switch), Task 6 Step 4 (spec sync).
   - `setUiActionSink` exporter: same name in `loader.ts`, barrel `index.ts`, and `app.tsx` import. Aliased to `kernelSetUiActionSink` in `app.tsx` matching the existing convention (`kernelSetChatSink` etc.).
   - `handleUiAction` defined in Task 3 Step 2, referenced in Task 3 Step 3 sink binding.

---

## Execution Handoff

Plan complete. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration.
**2. Inline Execution** — execute tasks in this session with checkpoints.

Pick one before starting Task 1.
