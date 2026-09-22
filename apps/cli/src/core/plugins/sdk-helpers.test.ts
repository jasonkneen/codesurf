// Tests for the Tier-2 SDK additions:
//   - services.tools.safeExecute
//   - services.hooks.wrapExecute
//   - api.bindKernelSink
//
// These three helpers are the foundation for wiring write-side tool hooks
// (Tier 3) and collapsing the boilerplate the audit flagged.

import type { PluginContext } from "@codesurf/plugin-api";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AggregatedHookResult } from "../../hooks/index";
import type { ToolResult } from "../../types/index";
import type { KernelSinkBindings } from "./api";
import { __resetPluginsForTests, bootstrapPlugins, getHostServices, setHooksSink } from "./loader";
import { createNativePluginModule } from "./native/host";

let tempDir: string;
let originalEnv: string | undefined;

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-sdk-helpers-test-"));
  originalEnv = process.env.CODESURF_CONFIG_DIR;
  process.env.CODESURF_CONFIG_DIR = tempDir;
});

afterAll(() => {
  if (originalEnv === undefined) delete process.env.CODESURF_CONFIG_DIR;
  else process.env.CODESURF_CONFIG_DIR = originalEnv;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  __resetPluginsForTests();
});

afterEach(() => {
  __resetPluginsForTests();
});

function emptyResult(): AggregatedHookResult {
  return { blocked: false, blockingErrors: [], preventContinuation: false, additionalContexts: [], results: [] };
}

describe("services.tools.safeExecute", () => {
  it("returns the inner ToolResult when fn resolves", async () => {
    const services = getHostServices();
    const result = await services.tools.safeExecute({
      label: "do thing",
      fn: async () => ({ success: true, output: "ok" }),
    });
    expect(result).toEqual({ success: true, output: "ok" });
  });

  it("returns a failure ToolResult with the label when fn throws", async () => {
    const services = getHostServices();
    const result = await services.tools.safeExecute({
      label: "do thing",
      fn: async () => {
        throw new Error("nope");
      },
    });
    expect(result.success).toBe(false);
    expect(result.output).toBe("Failed to do thing: nope");
  });

  it("stringifies non-Error throws", async () => {
    const services = getHostServices();
    const result = await services.tools.safeExecute({
      label: "x",
      fn: async () => {
        throw "string-rejection";
      },
    });
    expect(result.output).toBe("Failed to x: string-rejection");
  });
});

describe("services.hooks.wrapExecute", () => {
  afterEach(() => {
    setHooksSink(null);
  });

  it("calls runPre, then the inner fn, then runPost on success", async () => {
    const order: string[] = [];
    setHooksSink({
      runPre: async (toolName) => {
        order.push(`pre:${toolName}`);
        return emptyResult();
      },
      runPost: async (toolName) => {
        order.push(`post:${toolName}`);
        return emptyResult();
      },
      runFailure: async () => emptyResult(),
      runEvent: async () => emptyResult(),
    });

    const services = getHostServices();
    const wrapped = services.hooks.wrapExecute<{ x: number }>("my_tool", async (input) => {
      order.push(`fn:${input.x}`);
      return { success: true, output: "done" };
    });

    const result = await wrapped({ x: 42 });
    // runPost fires-and-forgets, so flush microtasks.
    await new Promise((r) => setTimeout(r, 0));

    expect(result).toEqual({ success: true, output: "done" });
    expect(order).toEqual(["pre:my_tool", "fn:42", "post:my_tool"]);
  });

  it("calls runFailure (not runPost) when the inner fn returns success:false", async () => {
    const calls: string[] = [];
    setHooksSink({
      runPre: async () => emptyResult(),
      runPost: async () => {
        calls.push("post");
        return emptyResult();
      },
      runFailure: async (_toolName, _input, error) => {
        calls.push(`failure:${error}`);
        return emptyResult();
      },
      runEvent: async () => emptyResult(),
    });

    const services = getHostServices();
    const wrapped = services.hooks.wrapExecute("my_tool", async () => ({
      success: false,
      error: "boom",
    }));

    const result = await wrapped({});
    await new Promise((r) => setTimeout(r, 0));

    expect(result.success).toBe(false);
    expect(calls).toEqual(["failure:boom"]);
  });

  it("short-circuits with a hook-blocked failure when runPre returns blocked:true", async () => {
    let innerCalled = false;
    setHooksSink({
      runPre: async () => ({
        blocked: true,
        blockingErrors: [{ command: "test-hook", stderr: "denied by policy" }],
        preventContinuation: false,
        additionalContexts: [],
        results: [],
      }),
      runPost: async () => emptyResult(),
      runFailure: async () => emptyResult(),
      runEvent: async () => emptyResult(),
    });

    const services = getHostServices();
    const wrapped = services.hooks.wrapExecute("my_tool", async () => {
      innerCalled = true;
      return { success: true, output: "should not reach" };
    });

    const result = await wrapped({});
    expect(innerCalled).toBe(false);
    expect(result).toEqual({ success: false, output: "[Hook blocked] denied by policy" });
  });

  it("passes abortSignal through to the inner fn", async () => {
    setHooksSink({
      runPre: async () => emptyResult(),
      runPost: async () => emptyResult(),
      runFailure: async () => emptyResult(),
      runEvent: async () => emptyResult(),
    });

    const services = getHostServices();
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const wrapped = services.hooks.wrapExecute("my_tool", async (_input, ctx) => {
      seenSignal = ctx.abortSignal;
      return { success: true, output: "ok" };
    });

    await wrapped({}, { abortSignal: controller.signal });
    expect(seenSignal).toBe(controller.signal);
  });

  it("works when no hooks sink is bound (no-op pre/post)", async () => {
    setHooksSink(null);
    const services = getHostServices();
    const wrapped = services.hooks.wrapExecute("my_tool", async () => ({
      success: true,
      output: "ok",
    }));
    const result = await wrapped({});
    expect(result).toEqual({ success: true, output: "ok" });
  });
});

describe("api.bindKernelSink", () => {
  it("binds the bash sink and clears it on extension dispose", async () => {
    const mockBash = {
      cwd: () => "/tmp/test",
      execute: async (): Promise<ToolResult> => ({ success: true, output: "" }),
      startBackground: async (): Promise<ToolResult> => ({ success: true, output: "" }),
      getProcessLogs: async (): Promise<ToolResult> => ({ success: true, output: "" }),
      stopProcess: async (): Promise<ToolResult> => ({ success: true, output: "" }),
      listProcesses: (): ToolResult => ({ success: true, output: "" }),
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      spawnChild: () => null as any,
      cleanup: async () => {},
      getSandboxMode: () => "off" as const,
      setSandboxMode: () => {},
      getSandboxSettings: () => ({}) as never,
      setSandboxSettings: () => {},
    };

    const ext = createNativePluginModule({
      name: "ext",
      inject: ["sinks"],
      manifest: {
        id: "test.bind-bash",
        name: "Test bind bash",
        version: "0.0.1",
        description: "",
        enabledByDefault: true,
        capabilities: ["tools"],
      },
      apply(ctx: PluginContext) {
        ctx.sinks.bind({ bash: mockBash });
      },
    });

    await bootstrapPlugins([ext]);
    expect(getHostServices().bash.cwd()).toBe("/tmp/test");

    __resetPluginsForTests();
    // After reset, the sink is cleared — accessing it should throw the
    // "Bash sink is not active" message.
    expect(() => getHostServices().bash.cwd()).toThrow(/Bash sink is not active/);
  });

  it("binds the mcp provider and clears it on dispose", async () => {
    const mockBundle = {
      tools: {},
      serverIds: [],
      toolCountsByServerId: new Map(),
      listResources: async () => [],
      listPrompts: async () => [],
      readResource: async () => null,
      getPrompt: async () => null,
      errors: [],
      close: async () => {},
    };

    const ext = createNativePluginModule({
      name: "ext",
      inject: ["contributions"],
      manifest: {
        id: "test.bind-mcp",
        name: "Test bind mcp",
        version: "0.0.1",
        description: "",
        enabledByDefault: true,
        capabilities: ["tools"],
      },
      apply(ctx: PluginContext) {
        ctx.sinks.bind({ mcp: async () => mockBundle });
      },
    });

    await bootstrapPlugins([ext]);
    const services = getHostServices();
    expect(services.mcp.isEnabled()).toBe(true);
    const bundle = await services.mcp.getToolBundle();
    expect(bundle).toBe(mockBundle);

    __resetPluginsForTests();
    // After reset, isEnabled is false and getToolBundle returns the empty bundle.
    const services2 = getHostServices();
    expect(services2.mcp.isEnabled()).toBe(false);
  });

  it("supports binding multiple sinks in a single call", async () => {
    const calls: string[] = [];
    const bindings: KernelSinkBindings = {
      icons: (name) => {
        calls.push(`icon:${name}`);
        return name === "x" ? "X" : null;
      },
    };
    const ext = createNativePluginModule({
      name: "ext",
      inject: ["contributions"],
      manifest: {
        id: "test.bind-multi",
        name: "Test bind multi",
        version: "0.0.1",
        description: "",
        enabledByDefault: true,
        capabilities: [],
      },
      apply(ctx: PluginContext) {
        ctx.sinks.bind(bindings);
      },
    });

    await bootstrapPlugins([ext]);
    // Icons module is bound — verify via getIcon
    const { getIcon } = await import("./icons");
    expect(getIcon("x")).toBe("X");
    expect(getIcon("y")).toBe("");
    expect(calls).toEqual(["icon:x", "icon:y"]);
  });
});

describe("services.icons", () => {
  it("setResolver binds a glyph catalog and resolve looks it up", () => {
    const services = getHostServices();
    services.icons.setResolver((name) => (name === "bash" ? "" : null));
    expect(services.icons.resolve("bash")).toBe("");
    expect(services.icons.resolve("unknown")).toBe("");
    services.icons.setResolver(null);
    expect(services.icons.resolve("bash")).toBe("");
  });
});
