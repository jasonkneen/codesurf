// Parity acceptance for the converted `lsp` tool.
//
// The V1 builtin's whole surface is the tool it registered: the name and group
// the kernel filters on, the description and zod schema the model reads, and the
// two branches of `execute` (LSP disabled in settings vs a real query). All of
// that is asserted here against the real runtime — fiber lifecycle, contribution
// registry, `wrapExecute`/`safeExecute` plumbing — mounted on a root with fake
// `HostBindings`.
//
// `src/lsp/runtime` is mocked: the real `isLspToolEnabled` reads the user's
// settings file and the real `queryLsp` spawns language servers. `src/lsp/types`
// is NOT mocked, so the operation enum the model sees is the real one.
//
// The fake `tools` binding deliberately mimics the host's implementations
// (loader.ts `safeExecute`, api.ts `hooks.wrapExecute`) rather than leaning on
// the runtime's no-binding fallbacks, whose failure shape differs from the
// host's ("query LSP failed: …" vs "Failed to query LSP: …").

import type { PluginManifest, ToolOutcome, ToolSpec, ToolsService } from "@codesurf/plugin-api";
import { type Context, createCodesurfRoot, mountPlugin } from "@codesurf/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LSP_TOOL_OPERATIONS } from "../../../lsp/types";

const { isLspToolEnabledMock, queryLspMock } = vi.hoisted(() => ({
  isLspToolEnabledMock: vi.fn(),
  queryLspMock: vi.fn(),
}));
vi.mock("../../../lsp/runtime", () => ({
  isLspToolEnabled: isLspToolEnabledMock,
  queryLsp: queryLspMock,
}));

import { lspToolPlugin } from "./lsp-tool";

/** Structural view of the ai-sdk tool object the plugin hands the host. */
interface RegisteredLspTool {
  description: string;
  inputSchema: {
    safeParse(input: unknown): { success: boolean };
    shape: Record<string, { description?: string }>;
  };
  execute: (input: Record<string, unknown>, options?: { abortSignal?: AbortSignal }) => Promise<ToolOutcome>;
}

interface Harness {
  root: Context;
  /** Every tool the host binding was asked to register, with its manifest. */
  hostRegistrations: Array<{ spec: ToolSpec; manifest: PluginManifest }>;
  /** Names the host disposer was invoked for, in order. */
  hostDisposeCalls: string[];
  wrapExecuteCalls: string[];
  safeExecuteCalls: Array<{ label: string }>;
  setCwd(next: string): void;
}

function bootLspRoot(initialCwd = "/repo"): Harness {
  let cwd = initialCwd;
  const hostRegistrations: Harness["hostRegistrations"] = [];
  const hostDisposeCalls: string[] = [];
  const wrapExecuteCalls: string[] = [];
  const safeExecuteCalls: Array<{ label: string }> = [];

  // Mirrors loader.ts's real `services.tools.safeExecute` and api.ts's
  // `services.hooks.wrapExecute` (which the host binding routes `ctx.tools` to).
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
    async safeExecute(opts) {
      safeExecuteCalls.push({ label: opts.label });
      try {
        return await opts.fn();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, output: `Failed to ${opts.label}: ${msg}` };
      }
    },
    wrapExecute(toolName, fn) {
      wrapExecuteCalls.push(toolName);
      return (input, execCtx) => fn(input, execCtx ?? {});
    },
  };

  const root = createCodesurfRoot({
    cwd: () => cwd,
    tools,
    registerTool(spec, manifest) {
      hostRegistrations.push({ spec, manifest });
      return () => hostDisposeCalls.push(spec.name);
    },
  });

  return {
    root,
    hostRegistrations,
    hostDisposeCalls,
    wrapExecuteCalls,
    safeExecuteCalls,
    setCwd: (next) => {
      cwd = next;
    },
  };
}

function lspTool(root: Context): RegisteredLspTool {
  const spec = root.contributions.listTools()[0];
  if (!spec) throw new Error("the lsp tool was not registered");
  return spec.tool as RegisteredLspTool;
}

const NOT_ENABLED =
  "LSP tool is not enabled. Set `lsp.enabled = true` and `lsp.tool = true` in your grok settings to use semantic code intelligence.";

const MODEL_DESCRIPTION =
  "Experimental Language Server Protocol access for semantic code intelligence. Use for go-to-definition, references, hover, symbols, implementations, and call hierarchy when a matching LSP server is available.";

describe("native lsp tool", () => {
  beforeEach(() => {
    isLspToolEnabledMock.mockReset();
    queryLspMock.mockReset();
    isLspToolEnabledMock.mockReturnValue(true);
    queryLspMock.mockResolvedValue({ success: true, output: "ok" });
  });

  it("keeps the V1 manifest identity", async () => {
    expect(lspToolPlugin.manifest.id).toBe("builtin.tools.lsp");
    expect(lspToolPlugin.manifest.name).toBe("Language Server");
    expect(lspToolPlugin.manifest.version).toBe("1.0.0");
    expect(lspToolPlugin.manifest.description).toBe(
      "LSP-driven semantic code navigation (definition, references, hover, symbols).",
    );
    expect(lspToolPlugin.manifest.enabledByDefault).toBe(true);
    expect(lspToolPlugin.manifest.protected).toBe(false);
    expect(lspToolPlugin.manifest.hidden).toBeUndefined();
    expect(lspToolPlugin.manifest.group).toBeUndefined();
    expect(lspToolPlugin.manifest.capabilities).toEqual(["tools"]);
  });

  it("registers exactly one tool with the V1 registration metadata", async () => {
    const harness = bootLspRoot();
    const fiber = mountPlugin(harness.root, lspToolPlugin);
    await fiber;

    const specs = harness.root.contributions.listTools();
    expect(specs).toHaveLength(1);
    expect(specs[0]?.name).toBe("lsp");
    expect(specs[0]?.description).toBe("Query the workspace language server.");
    expect(specs[0]?.group).toBe("lsp");
    expect(specs[0]?.label).toBeUndefined();
    expect(specs[0]?.modes).toBeUndefined();

    // The host registry is what the agent's ToolSet and the enable/disable
    // filter read, so the manifest attribution has to reach it.
    expect(harness.hostRegistrations).toHaveLength(1);
    expect(harness.hostRegistrations[0]?.manifest.id).toBe("builtin.tools.lsp");
    expect(harness.hostRegistrations[0]?.spec.name).toBe("lsp");

    await fiber.dispose();
  });

  it("wraps execute through the host's hook wrapper at mount time", async () => {
    const harness = bootLspRoot();
    const fiber = mountPlugin(harness.root, lspToolPlugin);
    await fiber;

    // Before any invocation: losing this is how user hooks silently stop firing.
    expect(harness.wrapExecuteCalls).toEqual(["lsp"]);

    await fiber.dispose();
  });

  it("disposing the fiber removes the tool from the root and the host", async () => {
    const harness = bootLspRoot();
    const fiber = mountPlugin(harness.root, lspToolPlugin);
    await fiber;
    expect(harness.root.contributions.listTools().map((t) => t.name)).toEqual(["lsp"]);

    await fiber.dispose();
    expect(harness.root.contributions.listTools()).toEqual([]);
    expect(harness.hostDisposeCalls).toEqual(["lsp"]);
  });

  it("keeps every model-visible schema string", async () => {
    const harness = bootLspRoot();
    const fiber = mountPlugin(harness.root, lspToolPlugin);
    await fiber;

    const t = lspTool(harness.root);
    expect(t.description).toBe(MODEL_DESCRIPTION);
    expect(t.inputSchema.shape.operation?.description).toBe("The LSP operation to perform");
    expect(t.inputSchema.shape.filePath?.description).toBe("The absolute or cwd-relative path to the target file");
    expect(t.inputSchema.shape.line?.description).toBe(
      "The 1-based line number. Required for position-based operations (definition, references, hover, implementation, callHierarchy). Not needed for documentSymbol or workspaceSymbol.",
    );
    expect(t.inputSchema.shape.character?.description).toBe(
      "The 1-based character offset. Required for position-based operations. Not needed for documentSymbol or workspaceSymbol.",
    );
    expect(t.inputSchema.shape.query?.description).toBe("Optional symbol query. Used primarily with workspaceSymbol.");

    await fiber.dispose();
  });

  it("validates input exactly as the V1 schema did", async () => {
    const harness = bootLspRoot();
    const fiber = mountPlugin(harness.root, lspToolPlugin);
    await fiber;
    const schema = lspTool(harness.root).inputSchema;

    // Every real operation parses; nothing else does.
    for (const operation of LSP_TOOL_OPERATIONS) {
      expect(schema.safeParse({ operation, filePath: "a.ts" }).success).toBe(true);
    }
    expect(schema.safeParse({ operation: "renameSymbol", filePath: "a.ts" }).success).toBe(false);
    expect(schema.safeParse({ operation: "hover" }).success).toBe(false);
    // line/character are 1-based integers.
    expect(schema.safeParse({ operation: "hover", filePath: "a.ts", line: 0 }).success).toBe(false);
    expect(schema.safeParse({ operation: "hover", filePath: "a.ts", line: 1.5 }).success).toBe(false);
    expect(schema.safeParse({ operation: "hover", filePath: "a.ts", character: 0 }).success).toBe(false);
    expect(schema.safeParse({ operation: "hover", filePath: "a.ts", line: 3, character: 4, query: "x" }).success).toBe(
      true,
    );

    await fiber.dispose();
  });

  it("returns the friendly message and queries nothing when LSP is off in settings", async () => {
    isLspToolEnabledMock.mockReturnValue(false);
    const harness = bootLspRoot();
    const fiber = mountPlugin(harness.root, lspToolPlugin);
    await fiber;

    const result = await lspTool(harness.root).execute({ operation: "hover", filePath: "a.ts", line: 2, character: 3 });

    expect(result).toEqual({ success: false, output: NOT_ENABLED });
    expect(isLspToolEnabledMock).toHaveBeenCalledWith("/repo");
    expect(queryLspMock).not.toHaveBeenCalled();
    expect(harness.safeExecuteCalls).toEqual([]);

    await fiber.dispose();
  });

  it("forwards the query, defaults line/character to 1 and returns the response", async () => {
    queryLspMock.mockResolvedValue({ success: true, output: "symbols", lspDiagnostics: [{ file: "a.ts" }] });
    const harness = bootLspRoot();
    const fiber = mountPlugin(harness.root, lspToolPlugin);
    await fiber;

    const controller = new AbortController();
    const result = await lspTool(harness.root).execute(
      { operation: "documentSymbol", filePath: "a.ts" },
      { abortSignal: controller.signal },
    );

    expect(queryLspMock).toHaveBeenCalledWith(
      "/repo",
      { operation: "documentSymbol", filePath: "a.ts", line: 1, character: 1, query: undefined },
      controller.signal,
    );
    expect(harness.safeExecuteCalls).toEqual([{ label: "query LSP" }]);
    expect(result).toEqual({ success: true, output: "symbols", lspDiagnostics: [{ file: "a.ts" }] });

    await fiber.dispose();
  });

  it("passes explicit position and query arguments through unchanged", async () => {
    const harness = bootLspRoot();
    const fiber = mountPlugin(harness.root, lspToolPlugin);
    await fiber;

    await lspTool(harness.root).execute({
      operation: "workspaceSymbol",
      filePath: "src/a.ts",
      line: 12,
      character: 5,
      query: "createThing",
    });

    expect(queryLspMock).toHaveBeenCalledWith(
      "/repo",
      { operation: "workspaceSymbol", filePath: "src/a.ts", line: 12, character: 5, query: "createThing" },
      undefined,
    );

    await fiber.dispose();
  });

  it("reads cwd lazily so a post-`cd` drift is observed", async () => {
    const harness = bootLspRoot("/repo");
    const fiber = mountPlugin(harness.root, lspToolPlugin);
    await fiber;

    harness.setCwd("/repo/packages/inner");
    await lspTool(harness.root).execute({ operation: "hover", filePath: "a.ts", line: 1, character: 1 });

    expect(isLspToolEnabledMock).toHaveBeenCalledWith("/repo/packages/inner");
    expect(queryLspMock.mock.calls[0]?.[0]).toBe("/repo/packages/inner");

    await fiber.dispose();
  });

  it("turns a thrown query into the host's standard failure shape", async () => {
    queryLspMock.mockRejectedValue(new Error("no server for .ts"));
    const harness = bootLspRoot();
    const fiber = mountPlugin(harness.root, lspToolPlugin);
    await fiber;

    const result = await lspTool(harness.root).execute({ operation: "hover", filePath: "a.ts", line: 1, character: 1 });

    expect(result).toEqual({ success: false, output: "Failed to query LSP: no server for .ts" });

    await fiber.dispose();
  });
});
