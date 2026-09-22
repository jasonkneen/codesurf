// Smoke tests for the subagents-tools extension.
//
// Phase 2 step 5 of the kernel-extensibility plan. Verifies that the four
// subagent tools (`task`, `delegate`, `delegation_read`, `delegation_list`)
// register correctly with the kernel, that `services.subagents.*` returns
// friendly errors when the bridge sink is unbound (no Agent constructed),
// and that when the Agent binds the sink via `setSubagentsSink({...})` each
// tool forwards args to the matching method at execute time.
//
// We don't exercise the real Agent — `setSubagentsSink` accepts an arbitrary
// `SubagentsSink`, so we install spies that record calls and return canned
// `ToolResult`s.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  __resetPluginsForTests,
  bootstrapPlugins,
  EXTENSIONS_V1_API_VERSION,
  getEnabledToolSet,
  getRegistrySnapshot,
  setKernelMode,
  setSubagentsSink,
} from "../index";
import { createNativePluginModule } from "./host";
import { subagentsToolsPlugin } from "./subagents-tools";

let tempDir: string;
let originalConfigDir: string | undefined;

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-ext-subagents-test-"));
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
  setSubagentsSink(null);
  setKernelMode(null);
});

interface ToolResultLike {
  success: boolean;
  output?: string;
  error?: string;
}

interface ExecutableTool {
  execute: (args: unknown, ctx?: { abortSignal?: AbortSignal }) => Promise<ToolResultLike>;
}

const SUBAGENT_TOOLS = ["task", "delegate", "delegation_read", "delegation_list"] as const;

describe("subagents-tools extension", () => {
  it("declares the expected manifest shape", () => {
    expect(subagentsToolsPlugin.manifest.id).toBe("builtin.tools.subagents");
    // kind and hostApiVersion are supplied by the loader adapter, so assert
    // them on the adapted module rather than the plugin's own manifest.
    const adapted = createNativePluginModule(subagentsToolsPlugin);
    expect(adapted.manifest.kind).toBe("builtin");
    expect(adapted.manifest.hostApiVersion).toBe(EXTENSIONS_V1_API_VERSION);
    expect(subagentsToolsPlugin.manifest.capabilities).toContain("tools");
    expect(subagentsToolsPlugin.manifest.enabledByDefault).toBe(true);
  });

  it("registers all 4 subagent tools as kernel-owned with the 'subagents' group", async () => {
    await bootstrapPlugins([createNativePluginModule(subagentsToolsPlugin)]);
    const snapshot = getRegistrySnapshot();
    const names = snapshot.tools.map((t) => t.name).sort();
    expect(names).toEqual([...SUBAGENT_TOOLS].sort());
    for (const name of SUBAGENT_TOOLS) {
      const entry = snapshot.tools.find((t) => t.name === name)!;
      expect(entry.tool, `${name} should have a kernel-owned tool def`).toBeDefined();
      expect(entry.group).toBe("subagents");
    }
  });

  it("mode-gates delegate / delegation_read / delegation_list to agent mode only; task is always available", async () => {
    await bootstrapPlugins([createNativePluginModule(subagentsToolsPlugin)]);
    const snapshot = getRegistrySnapshot();

    expect(snapshot.tools.find((t) => t.name === "task")!.modes ?? []).toEqual([]);
    for (const name of ["delegate", "delegation_read", "delegation_list"] as const) {
      expect(snapshot.tools.find((t) => t.name === name)!.modes).toEqual(["agent"]);
    }

    // Agent mode → all four available.
    setKernelMode("agent");
    expect(Object.keys(getEnabledToolSet()).sort()).toEqual([...SUBAGENT_TOOLS].sort());

    // Plan mode → only `task` survives.
    setKernelMode("plan");
    expect(Object.keys(getEnabledToolSet())).toEqual(["task"]);

    // Ask mode → only `task` survives.
    setKernelMode("ask");
    expect(Object.keys(getEnabledToolSet())).toEqual(["task"]);
  });

  it("returns friendly errors for all 4 tools when the bridge sink is unbound", async () => {
    await bootstrapPlugins([createNativePluginModule(subagentsToolsPlugin)]);
    const snapshot = getRegistrySnapshot();

    const task = snapshot.tools.find((t) => t.name === "task")!.tool as unknown as ExecutableTool;
    const delegate = snapshot.tools.find((t) => t.name === "delegate")!.tool as unknown as ExecutableTool;
    const read = snapshot.tools.find((t) => t.name === "delegation_read")!.tool as unknown as ExecutableTool;
    const list = snapshot.tools.find((t) => t.name === "delegation_list")!.tool as unknown as ExecutableTool;

    const taskResult = await task.execute({ agent: "general", description: "x", prompt: "y" });
    expect(taskResult.success).toBe(false);
    expect(taskResult.error ?? "").toMatch(/subagents bridge is not active/i);

    const delegateResult = await delegate.execute({ agent: "explore", description: "x", prompt: "y" });
    expect(delegateResult.success).toBe(false);
    expect(delegateResult.error ?? "").toMatch(/subagents bridge is not active/i);

    const readResult = await read.execute({ id: "calm-blue-fox" });
    expect(readResult.success).toBe(false);
    expect(readResult.error ?? "").toMatch(/subagents bridge is not active/i);

    const listResult = await list.execute({});
    expect(listResult.success).toBe(false);
    expect(listResult.error ?? "").toMatch(/subagents bridge is not active/i);
  });

  it("forwards task / delegate / delegation_read / delegation_list args to the bound sink", async () => {
    await bootstrapPlugins([createNativePluginModule(subagentsToolsPlugin)]);

    const calls: Array<{ method: string; payload: unknown }> = [];
    setSubagentsSink({
      runTask: async (request) => {
        calls.push({ method: "runTask", payload: request });
        return { success: true, output: `task ran for ${request.agent}` };
      },
      runDelegation: async (request) => {
        calls.push({ method: "runDelegation", payload: request });
        return { success: true, output: `delegation started for ${request.agent}` };
      },
      readDelegation: async (id) => {
        calls.push({ method: "readDelegation", payload: id });
        return { success: true, output: `read ${id}` };
      },
      listDelegations: async () => {
        calls.push({ method: "listDelegations", payload: null });
        return { success: true, output: "listed" };
      },
    });

    const snapshot = getRegistrySnapshot();
    const task = snapshot.tools.find((t) => t.name === "task")!.tool as unknown as ExecutableTool;
    const delegate = snapshot.tools.find((t) => t.name === "delegate")!.tool as unknown as ExecutableTool;
    const read = snapshot.tools.find((t) => t.name === "delegation_read")!.tool as unknown as ExecutableTool;
    const list = snapshot.tools.find((t) => t.name === "delegation_list")!.tool as unknown as ExecutableTool;

    const taskResult = await task.execute({
      agent: "explore",
      description: "investigate auth",
      prompt: "look at the OAuth flow",
    });
    expect(taskResult.success).toBe(true);
    expect(taskResult.output).toBe("task ran for explore");

    const delegateResult = await delegate.execute({
      agent: "explore",
      description: "background research",
      prompt: "research caching",
    });
    expect(delegateResult.success).toBe(true);

    const readResult = await read.execute({ id: "calm-blue-fox" });
    expect(readResult.success).toBe(true);

    const listResult = await list.execute({});
    expect(listResult.success).toBe(true);

    expect(calls).toEqual([
      {
        method: "runTask",
        payload: { agent: "explore", description: "investigate auth", prompt: "look at the OAuth flow" },
      },
      {
        method: "runDelegation",
        payload: { agent: "explore", description: "background research", prompt: "research caching" },
      },
      { method: "readDelegation", payload: "calm-blue-fox" },
      { method: "listDelegations", payload: null },
    ]);
  });

  it("propagates sink rejections as friendly error results instead of throwing", async () => {
    await bootstrapPlugins([createNativePluginModule(subagentsToolsPlugin)]);
    setSubagentsSink({
      runTask: async () => {
        throw new Error("task boom");
      },
      runDelegation: async () => {
        throw new Error("delegation boom");
      },
      readDelegation: async () => {
        throw new Error("read boom");
      },
      listDelegations: async () => {
        throw new Error("list boom");
      },
    });

    const snapshot = getRegistrySnapshot();
    const task = snapshot.tools.find((t) => t.name === "task")!.tool as unknown as ExecutableTool;
    const delegate = snapshot.tools.find((t) => t.name === "delegate")!.tool as unknown as ExecutableTool;
    const read = snapshot.tools.find((t) => t.name === "delegation_read")!.tool as unknown as ExecutableTool;
    const list = snapshot.tools.find((t) => t.name === "delegation_list")!.tool as unknown as ExecutableTool;

    const taskResult = await task.execute({ agent: "general", description: "x", prompt: "y" });
    expect(taskResult.success).toBe(false);
    expect(taskResult.error ?? "").toContain("task boom");

    const delegateResult = await delegate.execute({ agent: "explore", description: "x", prompt: "y" });
    expect(delegateResult.success).toBe(false);
    expect(delegateResult.error ?? "").toContain("delegation boom");

    const readResult = await read.execute({ id: "calm-blue-fox" });
    expect(readResult.success).toBe(false);
    expect(readResult.error ?? "").toContain("read boom");

    const listResult = await list.execute({});
    expect(listResult.success).toBe(false);
    expect(listResult.error ?? "").toContain("list boom");
  });

  it("treats setSubagentsSink(null) as 'unbound again' after a previous bind", async () => {
    await bootstrapPlugins([createNativePluginModule(subagentsToolsPlugin)]);
    setSubagentsSink({
      runTask: async () => ({ success: true, output: "ok" }),
      runDelegation: async () => ({ success: true, output: "ok" }),
      readDelegation: async () => ({ success: true, output: "ok" }),
      listDelegations: async () => ({ success: true, output: "ok" }),
    });
    setSubagentsSink(null);

    const snapshot = getRegistrySnapshot();
    const task = snapshot.tools.find((t) => t.name === "task")!.tool as unknown as ExecutableTool;

    const result = await task.execute({ agent: "general", description: "x", prompt: "y" });
    expect(result.success).toBe(false);
    expect(result.error ?? "").toMatch(/subagents bridge is not active/i);
  });

  it("accepts arbitrary agent names on `task` (custom subagents pass through to the sink)", async () => {
    // Phase 2 #5 dropped the strict zod.enum on `agent` in favor of z.string()
    // so user-defined subagents added after boot become callable on the next
    // turn without re-bootstrapping. This test exercises that the schema
    // doesn't reject custom names — the sink receives them verbatim and the
    // runtime handles validation.
    await bootstrapPlugins([createNativePluginModule(subagentsToolsPlugin)]);

    let lastAgent: string | null = null;
    setSubagentsSink({
      runTask: async (request) => {
        lastAgent = request.agent;
        return { success: true, output: `forwarded ${request.agent}` };
      },
      runDelegation: async () => ({ success: false }),
      readDelegation: async () => ({ success: false }),
      listDelegations: async () => ({ success: false }),
    });

    const task = getRegistrySnapshot().tools.find((t) => t.name === "task")!.tool as unknown as ExecutableTool;

    // Built-in name still works.
    const builtinResult = await task.execute({ agent: "general", description: "x", prompt: "y" });
    expect(builtinResult.success).toBe(true);
    expect(lastAgent).toBe("general");

    // A custom-looking name passes through to the sink (no zod rejection).
    const customResult = await task.execute({
      agent: "my-custom-research-agent",
      description: "custom",
      prompt: "do thing",
    });
    expect(customResult.success).toBe(true);
    expect(lastAgent).toBe("my-custom-research-agent");
  });

  it("`task` description hints at all built-in sub-agent names so the model can pick the right one", async () => {
    // Migrated from `src/grok/tools.test.ts` as part of Phase 2 #5: the
    // four `routes <X> task requests through the task tool` cases that used
    // to live there each verified the description's agent-name tag plus the
    // sink forward path. Forward-path coverage is in the "forwards args"
    // test above; this case consolidates the description-tag coverage.
    await bootstrapPlugins([createNativePluginModule(subagentsToolsPlugin)]);
    const taskEntry = getRegistrySnapshot().tools.find((t) => t.name === "task")!;
    const description = (taskEntry.tool as unknown as { description?: string }).description ?? "";
    for (const tag of [
      "`general`",
      "`explore`",
      "`vision`",
      "`verify`",
      "`verify-detect`",
      "`verify-manifest`",
      "`computer`",
    ]) {
      expect(description, `task description should mention ${tag}`).toContain(tag);
    }
  });

  it("forwards abortSignal from the ai-sdk execute context to runTask / runDelegation", async () => {
    await bootstrapPlugins([createNativePluginModule(subagentsToolsPlugin)]);

    const seenSignals: Array<AbortSignal | undefined> = [];
    setSubagentsSink({
      runTask: async (_request, abortSignal) => {
        seenSignals.push(abortSignal);
        return { success: true, output: "ok" };
      },
      runDelegation: async (_request, abortSignal) => {
        seenSignals.push(abortSignal);
        return { success: true, output: "ok" };
      },
      readDelegation: async () => ({ success: true, output: "ok" }),
      listDelegations: async () => ({ success: true, output: "ok" }),
    });

    const snapshot = getRegistrySnapshot();
    const task = snapshot.tools.find((t) => t.name === "task")!.tool as unknown as ExecutableTool;
    const delegate = snapshot.tools.find((t) => t.name === "delegate")!.tool as unknown as ExecutableTool;

    const controller = new AbortController();
    await task.execute({ agent: "general", description: "x", prompt: "y" }, { abortSignal: controller.signal });
    await delegate.execute({ agent: "explore", description: "x", prompt: "y" }, { abortSignal: controller.signal });

    expect(seenSignals).toHaveLength(2);
    expect(seenSignals[0]).toBe(controller.signal);
    expect(seenSignals[1]).toBe(controller.signal);
  });
});
