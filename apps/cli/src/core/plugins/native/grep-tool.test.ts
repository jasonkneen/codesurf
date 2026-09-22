// Parity acceptance for the converted `grep` tool.
//
// A tool plugin's user-visible surface is what the model is shown and what the
// host registry receives: the registration name/description/group, the ai-sdk
// tool description, the input schema (field names, optionality and per-field
// descriptions) and the execute path — which must run through the host's hook
// wrapper and read the agent's *live* cwd, not one captured at mount.
//
// `executeGrep` is mocked so no ripgrep process is spawned; everything else
// (fiber lifecycle, contribution registry, tools service) is the real runtime,
// mounted on a root with fake `HostBindings`.

import type { PluginManifest, ToolExecutionContext, ToolOutcome, ToolSpec, ToolsService } from "@codesurf/plugin-api";
import { type Context, createCodesurfRoot, type HostBindings, mountPlugin } from "@codesurf/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolResult } from "../../../types/index";

const { executeGrepMock } = vi.hoisted(() => ({ executeGrepMock: vi.fn() }));
vi.mock("../../../tools/grep", () => ({ executeGrep: executeGrepMock }));

import { grepToolPlugin } from "./grep-tool";

/** The V1 prompt text, byte for byte. Changing it changes what the model sees. */
const TOOL_DESCRIPTION =
  'Fast content search tool that works with any codebase size. Searches file contents using regular expressions. Supports full regex syntax (e.g. "log.*Error", "function\\s+\\w+"). Filter files by pattern with the include parameter (e.g. "*.js", "*.{ts,tsx}"). Returns matching file paths and line numbers sorted by modification time. Use this tool when you need to find files containing specific patterns. If you need to count matches within files, use bash with `rg` directly.';

/** Structural view of the ai-sdk tool the plugin hands to the host. */
interface RegisteredGrepTool {
  description: string;
  inputSchema: {
    shape: Record<string, { description?: string }>;
    safeParse: (input: unknown) => { success: boolean };
  };
  execute: (input: unknown, ctx?: ToolExecutionContext) => Promise<ToolResult>;
}

interface GrepHarness {
  root: Context;
  hostRegistered: Array<{ spec: ToolSpec; manifest: PluginManifest }>;
  hostRemoved: string[];
  wrappedNames: string[];
  hookCalls: string[];
  cwd: { value: string };
}

function bootGrepRoot(overrides: Partial<HostBindings> = {}): GrepHarness {
  const hostRegistered: Array<{ spec: ToolSpec; manifest: PluginManifest }> = [];
  const hostRemoved: string[] = [];
  const wrappedNames: string[] = [];
  const hookCalls: string[] = [];
  const cwd = { value: "/agent/cwd" };

  // Stand-in for the host's hook wrapper: records that the body was wrapped and
  // brackets each call, which is how the test proves user hooks still fire.
  const tools: ToolsService = {
    setEnabled: () => {},
    // The hook methods a real ToolsService carries; these tools go through
    // wrapExecute, so a no-op outcome is enough to satisfy the contract.
    runPre: async () => ({ blocked: false, blockingErrors: [], preventContinuation: false, additionalContexts: [] }),
    runPost: async () => ({ blocked: false, blockingErrors: [], preventContinuation: false, additionalContexts: [] }),
    runFailure: async () => ({
      blocked: false,
      blockingErrors: [],
      preventContinuation: false,
      additionalContexts: [],
    }),
    isEnabled: () => true,
    safeExecute: async (opts) => opts.fn(),
    wrapExecute<I>(toolName: string, fn: (input: I, ctx: ToolExecutionContext) => Promise<ToolOutcome>) {
      wrappedNames.push(toolName);
      return async (input: I, ctx?: ToolExecutionContext) => {
        hookCalls.push(`pre:${toolName}`);
        const result = await fn(input, ctx ?? {});
        hookCalls.push(`post:${toolName}`);
        return result;
      };
    },
  };

  const root = createCodesurfRoot({
    cwd: () => cwd.value,
    registerTool: (spec, manifest) => {
      hostRegistered.push({ spec, manifest });
      return () => hostRemoved.push(spec.name);
    },
    tools,
    ...overrides,
  });

  return { root, hostRegistered, hostRemoved, wrappedNames, hookCalls, cwd };
}

function grepTool(root: Context): RegisteredGrepTool {
  const spec = root.contributions.listTools()[0];
  if (!spec) throw new Error("grep was not registered");
  return spec.tool as RegisteredGrepTool;
}

describe("native grep tool", () => {
  beforeEach(() => {
    executeGrepMock.mockReset();
    executeGrepMock.mockResolvedValue({ success: true, output: "src/a.ts:1: hit" });
  });

  it("keeps the V1 manifest identity", () => {
    expect(grepToolPlugin.manifest.id).toBe("builtin.tools.grep");
    expect(grepToolPlugin.manifest.name).toBe("Grep");
    expect(grepToolPlugin.manifest.version).toBe("1.0.0");
    expect(grepToolPlugin.manifest.description).toBe("Ripgrep-powered content search.");
    expect(grepToolPlugin.manifest.enabledByDefault).toBe(true);
    expect(grepToolPlugin.manifest.capabilities).toEqual(["tools"]);
    expect(grepToolPlugin.manifest.protected).toBeUndefined();
    expect(grepToolPlugin.manifest.hidden).toBeUndefined();
    expect(grepToolPlugin.manifest.group).toBeUndefined();
  });

  it("registers one tool with the V1 name, description and group", async () => {
    const { root, hostRegistered } = bootGrepRoot();
    const fiber = mountPlugin(root, grepToolPlugin);
    await fiber;

    const specs = root.contributions.listTools();
    expect(specs).toHaveLength(1);
    expect(specs[0]?.name).toBe("grep");
    expect(specs[0]?.description).toBe("Search file contents with ripgrep.");
    expect(specs[0]?.group).toBe("grep");
    expect(specs[0]?.label).toBeUndefined();
    expect(specs[0]?.modes).toBeUndefined();

    // The host registry sees the same spec, attributed to the V1 extension id.
    expect(hostRegistered).toHaveLength(1);
    expect(hostRegistered[0]?.spec.name).toBe("grep");
    expect(hostRegistered[0]?.manifest.id).toBe("builtin.tools.grep");

    await fiber.dispose();
  });

  it("keeps the model-facing tool description and input schema", async () => {
    const { root } = bootGrepRoot();
    const fiber = mountPlugin(root, grepToolPlugin);
    await fiber;

    const tool = grepTool(root);
    expect(tool.description).toBe(TOOL_DESCRIPTION);
    expect(Object.keys(tool.inputSchema.shape)).toEqual(["pattern", "path", "include"]);
    expect(tool.inputSchema.shape.pattern?.description).toBe("The regex pattern to search for in file contents");
    expect(tool.inputSchema.shape.path?.description).toBe(
      "The directory or file to search in. Defaults to the current working directory.",
    );
    expect(tool.inputSchema.shape.include?.description).toBe(
      'File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")',
    );

    // `pattern` required, the other two optional — unchanged from V1.
    expect(tool.inputSchema.safeParse({ pattern: "log.*Error" }).success).toBe(true);
    expect(tool.inputSchema.safeParse({ pattern: "x", path: "src", include: "*.ts" }).success).toBe(true);
    expect(tool.inputSchema.safeParse({ path: "src" }).success).toBe(false);

    await fiber.dispose();
  });

  it("runs the body through the host hook wrapper under the tool name `grep`", async () => {
    const { root, wrappedNames, hookCalls } = bootGrepRoot();
    const fiber = mountPlugin(root, grepToolPlugin);
    await fiber;

    expect(wrappedNames).toEqual(["grep"]);

    await grepTool(root).execute({ pattern: "needle" });
    expect(hookCalls).toEqual(["pre:grep", "post:grep"]);

    await fiber.dispose();
  });

  it("forwards params, the agent cwd and the abort signal to executeGrep", async () => {
    const { root } = bootGrepRoot();
    const fiber = mountPlugin(root, grepToolPlugin);
    await fiber;

    const controller = new AbortController();
    const result = await grepTool(root).execute(
      { pattern: "needle", path: "src", include: "*.ts" },
      { abortSignal: controller.signal },
    );

    expect(executeGrepMock).toHaveBeenCalledWith(
      { pattern: "needle", path: "src", include: "*.ts" },
      "/agent/cwd",
      controller.signal,
    );
    // The tool result is returned verbatim — no re-shaping between V1 and here.
    expect(result).toEqual({ success: true, output: "src/a.ts:1: hit" });

    await fiber.dispose();
  });

  it("reads the cwd per call, so a `cd` inside the bash tool moves the search", async () => {
    const harness = bootGrepRoot();
    const fiber = mountPlugin(harness.root, grepToolPlugin);
    await fiber;

    await grepTool(harness.root).execute({ pattern: "a" });
    harness.cwd.value = "/agent/cwd/packages/runtime";
    await grepTool(harness.root).execute({ pattern: "b" });

    expect(executeGrepMock.mock.calls.map((call) => call[1])).toEqual(["/agent/cwd", "/agent/cwd/packages/runtime"]);

    await fiber.dispose();
  });

  it("omits absent optional params exactly as V1 did", async () => {
    const { root } = bootGrepRoot();
    const fiber = mountPlugin(root, grepToolPlugin);
    await fiber;

    await grepTool(root).execute({ pattern: "needle" });
    expect(executeGrepMock).toHaveBeenCalledWith(
      { pattern: "needle", path: undefined, include: undefined },
      "/agent/cwd",
      undefined,
    );

    await fiber.dispose();
  });

  it("disposing the fiber removes the tool from the root and the host registry", async () => {
    const { root, hostRemoved } = bootGrepRoot();
    const fiber = mountPlugin(root, grepToolPlugin);
    await fiber;
    expect(root.contributions.listTools().map((spec) => spec.name)).toEqual(["grep"]);

    await fiber.dispose();
    expect(root.contributions.listTools()).toEqual([]);
    expect(hostRemoved).toEqual(["grep"]);
  });

  // The catalog is what actually ships; `filter.test.ts` proves the tool reaches
  // the host registry enabled through a real bootstrap, and this proves there is
  // exactly one entry for the id and no V1 `activate(api)` module behind it.
  it("is present in the shipped built-in catalog exactly once", async () => {
    const { loadBuiltinPlugins } = await import("../builtin/index");
    const modules = await loadBuiltinPlugins();
    const entries = modules.filter((module) => module.manifest.id === "builtin.tools.grep");

    expect(entries).toHaveLength(1);
    expect(entries[0]?.manifest.kind).toBe("builtin");
    expect(entries[0]?.manifest.name).toBe("Grep");
    expect(entries[0]?.manifest.version).toBe("1.0.0");
    expect(entries[0]?.manifest.description).toBe("Ripgrep-powered content search.");
    expect(entries[0]?.manifest.enabledByDefault).toBe(true);
    expect(entries[0]?.manifest.capabilities).toEqual(["tools"]);
  }, 30_000);
});
