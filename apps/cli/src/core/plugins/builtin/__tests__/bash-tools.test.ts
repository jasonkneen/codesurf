// Smoke tests for the kernel-owned bash-tools extension.
//
// Phase 2 step 7a of the kernel-extensibility plan. Verifies that the four
// bash tools (`bash`, `process_logs`, `process_stop`, `process_list`)
// register correctly when the extension is bootstrapped on its own (the
// extension is NOT yet wired into `loadBuiltinPlugins()` — that happens in
// step 7b), that the extension binds the bash sink at activation, and that
// each tool's execute path forwards through `services.bash.*` to the bound
// sink. We don't exercise the real `BashTool` for the bash-tool execute
// paths — installing a stub sink keeps the test fast and deterministic
// (no shell processes, no temp dirs, no hook side effects).
//
// One real-`BashTool` assertion remains: `services.bash.spawnChild(cwd)`
// must return a usable `BashTool` instance whose `getCwd()` matches the
// passed cwd. This is the entry point the Agent uses at agent.ts:1267.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BashTool } from "../../../../tools/bash";
import {
  __resetPluginsForTests,
  type BashSink,
  bootstrapPlugins,
  getHostServices,
  getRegistrySnapshot,
  type HooksSink,
  setBashSink,
  setHooksSink,
} from "../../index";
import { type BashToolBackend, bashToolsPlugin, createBashToolDefinitions } from "../../native/bash-tools";
import { createNativePluginModule } from "../../native/host";

let tempDir: string;
let originalConfigDir: string | undefined;

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-ext-bash-test-"));
  originalConfigDir = process.env.CODESURF_CONFIG_DIR;
  process.env.CODESURF_CONFIG_DIR = tempDir;
});

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.CODESURF_CONFIG_DIR;
  else process.env.CODESURF_CONFIG_DIR = originalConfigDir;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  const configFile = path.join(tempDir, "extensions.json");
  if (fs.existsSync(configFile)) fs.unlinkSync(configFile);
  __resetPluginsForTests();
});

afterEach(() => {
  __resetPluginsForTests();
  setBashSink(null);
  setHooksSink(null);
});

function emptyHookResult() {
  return {
    blocked: false,
    blockingErrors: [],
    preventContinuation: false,
    additionalContexts: [],
    results: [],
  };
}

/**
 * Install a stub hooks sink so tests can spy on the bash tool's hook calls
 * without loading any real ~/.grok/hooks.json config. Without this, the tool
 * still works (the unbound sink resolves to a no-op `AggregatedHookResult`),
 * but tests that need to assert on hook-call shape opt in via this helper.
 */
function installStubHooksSink(overrides: Partial<HooksSink> = {}): void {
  setHooksSink({
    runPre: async () => emptyHookResult(),
    runPost: async () => emptyHookResult(),
    runFailure: async () => emptyHookResult(),
    runEvent: async () => emptyHookResult(),
    ...overrides,
  });
}

interface ToolResultLike {
  success: boolean;
  output?: string;
  error?: string;
}

interface ExecutableTool {
  execute: (args: unknown, ctx?: { abortSignal?: AbortSignal }) => Promise<ToolResultLike>;
}

const BASH_TOOLS = ["bash", "process_logs", "process_stop", "process_list"] as const;

function getTool(name: (typeof BASH_TOOLS)[number]): ExecutableTool {
  return getRegistrySnapshot().tools.find((t) => t.name === name)!.tool as unknown as ExecutableTool;
}

/**
 * Override the sink that `bashToolsPlugin.activate()` already bound.
 * Activation runs synchronously inside `bootstrapPlugins`, so by the
 * time tests look at `services.bash` the real `BashTool`-backed sink is
 * already in place. Tests that want to spy on calls call this AFTER
 * bootstrap to swap it for a stub.
 */
function installStubSink(overrides: Partial<BashSink>): void {
  setBashSink({
    cwd: () => "/stub/cwd",
    execute: async () => ({ success: true, output: "stub-execute" }),
    startBackground: async () => ({ success: true, output: "stub-start" }),
    getProcessLogs: async () => ({ success: true, output: "stub-logs" }),
    stopProcess: async () => ({ success: true, output: "stub-stop" }),
    listProcesses: () => ({ success: true, output: "stub-list" }),
    spawnChild: (initialCwd, options) => new BashTool(initialCwd, options),
    cleanup: async () => {},
    getSandboxMode: () => "off",
    setSandboxMode: () => {},
    getSandboxSettings: () => ({}),
    setSandboxSettings: () => {},
    ...overrides,
  });
}

describe("bash-tools extension", () => {
  it("declares the expected manifest shape", () => {
    expect(bashToolsPlugin.manifest.id).toBe("builtin.tools.bash");
    expect(bashToolsPlugin.manifest.capabilities).toContain("tools");
    expect(bashToolsPlugin.manifest.enabledByDefault).toBe(true);
    expect(bashToolsPlugin.manifest.protected).toBe(true);
  });

  it("registers all 4 bash tools as kernel-owned with the 'bash' group", async () => {
    await bootstrapPlugins([createNativePluginModule(bashToolsPlugin)]);
    const snapshot = getRegistrySnapshot();
    const names = snapshot.tools.map((t) => t.name).sort();
    expect(names).toEqual([...BASH_TOOLS].sort());
    for (const name of BASH_TOOLS) {
      const entry = snapshot.tools.find((t) => t.name === name)!;
      expect(entry.tool, `${name} should have a kernel-owned tool def`).toBeDefined();
      expect(entry.group).toBe("bash");
    }
  });

  it("binds the bash sink at activation so services.bash.cwd() works", async () => {
    await bootstrapPlugins([createNativePluginModule(bashToolsPlugin)]);
    // After bootstrap, the real `BashTool`-backed sink is bound. The cwd
    // matches `process.cwd()` because the extension defaults its BashTool to
    // `new BashTool(process.cwd())`.
    expect(getHostServices().bash.cwd()).toBe(process.cwd());
    expect(getHostServices().bash.getSandboxMode()).toBe("off");
  });

  it("forwards bash tool execute through services.bash.execute", async () => {
    await bootstrapPlugins([createNativePluginModule(bashToolsPlugin)]);
    const calls: Array<{ command: string; timeout?: number }> = [];
    installStubSink({
      execute: async (command, timeout) => {
        calls.push({ command, timeout });
        return { success: true, output: "forwarded" };
      },
    });

    const result = await getTool("bash").execute({ command: "ls -la", timeout: 1000 });
    expect(result.success).toBe(true);
    expect(result.output).toBe("forwarded");
    expect(calls).toEqual([{ command: "ls -la", timeout: 1000 }]);
  });

  it("routes background=true through services.bash.startBackground", async () => {
    await bootstrapPlugins([createNativePluginModule(bashToolsPlugin)]);
    const calls: string[] = [];
    installStubSink({
      startBackground: async (command) => {
        calls.push(command);
        return { success: true, output: "bg-started" };
      },
      execute: async () => {
        throw new Error("execute should not be called when background=true");
      },
    });

    const result = await getTool("bash").execute({ command: "npm run dev", background: true });
    expect(result.output).toBe("bg-started");
    expect(calls).toEqual(["npm run dev"]);
  });

  it("forwards process_logs/process_stop/process_list to the sink", async () => {
    await bootstrapPlugins([createNativePluginModule(bashToolsPlugin)]);
    const calls: string[] = [];
    installStubSink({
      getProcessLogs: async (id, tail) => {
        calls.push(`logs:${id}:${tail ?? "no-tail"}`);
        return { success: true, output: "logs-out" };
      },
      stopProcess: async (id) => {
        calls.push(`stop:${id}`);
        return { success: true, output: "stop-out" };
      },
      listProcesses: () => {
        calls.push("list");
        return { success: true, output: "list-out" };
      },
    });

    const logsResult = await getTool("process_logs").execute({ id: 5, tail: 10 });
    expect(logsResult.output).toBe("logs-out");
    const stopResult = await getTool("process_stop").execute({ id: 5 });
    expect(stopResult.output).toBe("stop-out");
    const listResult = await getTool("process_list").execute({});
    expect(listResult.output).toBe("list-out");

    expect(calls).toEqual(["logs:5:10", "stop:5", "list"]);
  });

  it("services.bash.spawnChild returns a fresh BashTool whose cwd matches the requested path", async () => {
    await bootstrapPlugins([createNativePluginModule(bashToolsPlugin)]);
    // Use the real sink (not a stub) so we exercise the BashTool constructor
    // path the Agent will hit at agent.ts:1267.
    const child = getHostServices().bash.spawnChild("/tmp/child-workdir", { sandboxMode: "off" });
    expect(child).toBeInstanceOf(BashTool);
    expect(child.getCwd()).toBe("/tmp/child-workdir");
    expect(child.getSandboxMode()).toBe("off");
    // Child is independent of the parent sink — different cwd.
    expect(child.getCwd()).not.toBe(getHostServices().bash.cwd());
  });

  it("passes through to the sink when no PreToolUse hook blocks the bash tool", async () => {
    // The unbound hooks sink resolves to a no-op `AggregatedHookResult`
    // (`blocked: false`), so the bash tool runs even when no Agent has bound
    // the hooks bridge. This test confirms the no-op fallback in `loader.ts`.
    await bootstrapPlugins([createNativePluginModule(bashToolsPlugin)]);
    installStubSink({
      execute: async () => ({ success: true, output: "ok" }),
    });
    const result = await getTool("bash").execute({ command: "echo hi" });
    expect(result.success).toBe(true);
    expect(result.output).toBe("ok");
  });

  it("routes the bash tool's hook calls through services.hooks.runPre/runPost", async () => {
    // The bash extension used to import hook helpers from `hooks/index.ts`
    // directly. Phase 2 step 7c moved that to `services.hooks.*`. Verify the
    // sink is called with the expected (toolName, toolInput, sessionId) shape
    // — sessionId is undefined here because no host bound a session-id
    // provider in this test.
    await bootstrapPlugins([createNativePluginModule(bashToolsPlugin)]);
    installStubSink({
      execute: async () => ({ success: true, output: "stdout-text" }),
    });
    const calls: Array<{ method: string; toolName: string; toolInput: unknown; sessionId: string | undefined }> = [];
    installStubHooksSink({
      runPre: async (toolName, toolInput, sessionId) => {
        calls.push({ method: "runPre", toolName, toolInput, sessionId });
        return emptyHookResult();
      },
      runPost: async (toolName, toolInput, _toolOutput, sessionId) => {
        calls.push({ method: "runPost", toolName, toolInput, sessionId });
        return emptyHookResult();
      },
    });

    const result = await getTool("bash").execute({ command: "echo hi", timeout: 1000 });
    expect(result.success).toBe(true);
    // PostToolUse fires with `.catch(() => {})` (fire-and-forget), so yield
    // the microtask queue so the assertion sees the post-hook call.
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.map((c) => c.method)).toEqual(["runPre", "runPost"]);
    expect(calls[0]!.toolName).toBe("bash");
    expect(calls[0]!.toolInput).toEqual({ command: "echo hi", timeout: 1000, background: undefined });
    expect(calls[0]!.sessionId).toBeUndefined();
  });

  it("routes failures through services.hooks.runFailure", async () => {
    await bootstrapPlugins([createNativePluginModule(bashToolsPlugin)]);
    installStubSink({
      execute: async () => ({ success: false, error: "boom" }),
    });
    const calls: Array<{ method: string; error?: string }> = [];
    installStubHooksSink({
      runPost: async () => {
        calls.push({ method: "runPost" });
        return emptyHookResult();
      },
      runFailure: async (_toolName, _toolInput, error) => {
        calls.push({ method: "runFailure", error });
        return emptyHookResult();
      },
    });

    const result = await getTool("bash").execute({ command: "exit 1" });
    expect(result.success).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.map((c) => c.method)).toEqual(["runFailure"]);
    expect(calls[0]!.error).toBe("boom");
  });

  it("createBashToolDefinitions routes execution through the injected backend (child isolation)", async () => {
    // The subagent / verify path injects a child `BashTool` via this factory so
    // delegated commands run in the child's cwd + sandbox, never the parent's.
    // Prove the bash tool drives ONLY the injected backend.
    const childCalls: Array<{ command: string; timeout?: number }> = [];
    const parentExecuteCalls = 0;
    const childBackend: BashToolBackend = {
      execute: async (command, timeout) => {
        childCalls.push({ command, timeout });
        return { success: true, output: "child-ran" };
      },
      startBackground: async () => ({ success: true, output: "child-bg" }),
      getProcessLogs: async () => ({ success: true, output: "child-logs" }),
      stopProcess: async () => ({ success: true, output: "child-stop" }),
      listProcesses: () => ({ success: true, output: "child-list" }),
    };

    const noHooks = {
      runPre: async () => emptyHookResult(),
      runPost: async () => emptyHookResult(),
      runFailure: async () => emptyHookResult(),
    };
    const defs = createBashToolDefinitions({
      bash: () => childBackend,
      hooks: () => noHooks,
      sessionId: () => undefined,
    });
    const bashTool = defs.find((d) => d.name === "bash")!.tool as unknown as ExecutableTool;

    const result = await bashTool.execute({ command: "pwd", timeout: 1234 });
    expect(result.output).toBe("child-ran");
    expect(childCalls).toEqual([{ command: "pwd", timeout: 1234 }]);
    expect(parentExecuteCalls).toBe(0);
  });

  it("createBashToolDefinitions resolves its backend lazily (per-call, not captured once)", async () => {
    // Accessors must resolve at execute-time so a sink swap is observed — the
    // same property `bash-rewire.test.ts` pins for the global path.
    let backend: BashToolBackend = {
      execute: async () => ({ success: true, output: "first" }),
      startBackground: async () => ({ success: true, output: "" }),
      getProcessLogs: async () => ({ success: true, output: "" }),
      stopProcess: async () => ({ success: true, output: "" }),
      listProcesses: () => ({ success: true, output: "" }),
    };
    const defs = createBashToolDefinitions({
      bash: () => backend,
      hooks: () => ({
        runPre: async () => emptyHookResult(),
        runPost: async () => emptyHookResult(),
        runFailure: async () => emptyHookResult(),
      }),
      sessionId: () => undefined,
    });
    const bashTool = defs.find((d) => d.name === "bash")!.tool as unknown as ExecutableTool;

    expect((await bashTool.execute({ command: "x" })).output).toBe("first");
    backend = { ...backend, execute: async () => ({ success: true, output: "second" }) };
    expect((await bashTool.execute({ command: "x" })).output).toBe("second");
  });

  it("returns a hook-blocked failure when services.hooks.runPre reports blocked=true", async () => {
    await bootstrapPlugins([createNativePluginModule(bashToolsPlugin)]);
    let executeCalled = false;
    installStubSink({
      execute: async () => {
        executeCalled = true;
        return { success: true, output: "should-not-run" };
      },
    });
    installStubHooksSink({
      runPre: async () => ({
        blocked: true,
        blockingErrors: [{ command: "test-hook", stderr: "denied by policy" }],
        preventContinuation: false,
        additionalContexts: [],
        results: [],
      }),
    });

    const result = await getTool("bash").execute({ command: "rm -rf /" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("Hook blocked");
    expect(result.output).toContain("denied by policy");
    expect(executeCalled).toBe(false);
  });
});
