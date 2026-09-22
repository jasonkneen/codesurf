// Test-only helper: builds a mock `BashSink` for tests that construct an Agent
// without bootstrapping the full extension stack.
//
// Phase 2 step 7b: the Agent reads through `services.bash.*` from the kernel
// host services rather than holding its own `BashTool`. Tests that don't load
// `loadBuiltinPlugins()` first must `setBashSink(buildMockBashSink().sink)`
// before constructing the Agent — otherwise the constructor's
// `services.bash.setSandboxMode(...)` call throws "Bash sink is not active".
//
// Returns `{ state, sink }` so tests can read live state through the same
// reference the sink mutates. `state.cwd`, `state.sandboxMode`,
// `state.sandboxSettings` reflect every `set*` call routed through the sink.

import type { SandboxMode, SandboxSettings } from "../utils/settings";

export interface MockBashState {
  sandboxMode: SandboxMode;
  sandboxSettings: SandboxSettings;
  cwd: string;
}

export interface MockBashSinkOptions {
  initialCwd?: string;
  initialSandboxMode?: SandboxMode;
  initialSandboxSettings?: SandboxSettings;
}

export function buildMockBashSink(opts: MockBashSinkOptions = {}) {
  const state: MockBashState = {
    sandboxMode: opts.initialSandboxMode ?? "off",
    sandboxSettings: opts.initialSandboxSettings ?? {},
    cwd: opts.initialCwd ?? "/mock/cwd",
  };

  const sink = {
    cwd: () => state.cwd,
    execute: async () => ({ success: true, output: "" }),
    startBackground: async () => ({ success: true, output: "" }),
    getProcessLogs: async () => ({ success: true, output: "" }),
    stopProcess: async () => ({ success: true, output: "" }),
    listProcesses: () => ({ success: true, output: "" }),
    // Returns a structurally-shaped BashTool stand-in. `spawnChild` is called
    // by `runTask` to build a child Agent's bash sink (`childBash` —
    // `getCwd`/`getSandboxMode`/`getSandboxSettings` accessors are read when
    // constructing subagent prompts), so the stub satisfies that surface.
    spawnChild: () =>
      ({
        getCwd: () => state.cwd,
        getSandboxMode: () => state.sandboxMode,
        getSandboxSettings: () => state.sandboxSettings,
        cleanup: async () => {},
      }) as never,
    cleanup: async () => {},
    getSandboxMode: () => state.sandboxMode,
    setSandboxMode: (mode: SandboxMode) => {
      state.sandboxMode = mode;
    },
    getSandboxSettings: () => state.sandboxSettings,
    setSandboxSettings: (settings: SandboxSettings) => {
      state.sandboxSettings = settings;
    },
  };

  return { state, sink };
}
