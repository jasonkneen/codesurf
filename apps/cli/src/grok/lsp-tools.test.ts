import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetPluginsForTests, bootstrapPlugins, getEnabledToolSet, getHostServices } from "../core/plugins";
import { loadBuiltinPlugins } from "../core/plugins/builtin";
import { toolSetToBatchTools } from "./tool-schemas";

// Mocks for the kernel-owned lsp tool's runtime dependencies. The extension at
// `src/core/plugins/builtin/lsp-tool.ts` imports both via the same
// `../lsp/runtime` absolute module identity, so vitest's path-keyed mock
// applies regardless of where the importer sits.
const isLspToolEnabledMock = vi.fn<(cwd: string) => boolean>(() => true);
const queryLspMock = vi.fn<(cwd: string, input: unknown) => Promise<{ success: boolean; output: string }>>(
  async () => ({
    success: true,
    output: "[]",
  }),
);

vi.mock("../lsp/runtime", () => ({
  isLspToolEnabled: (cwd: string) => isLspToolEnabledMock(cwd),
  queryLsp: (cwd: string, input: unknown) => queryLspMock(cwd, input),
}));

// Redirect kernel persistence to an isolated temp dir (mirrors filter.test.ts)
// so this test doesn't read or write the real `~/.grok/extensions.json`.
let tempDir: string;
let originalEnv: string | undefined;

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-lsp-tools-test-"));
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

beforeEach(async () => {
  const configFile = path.join(tempDir, "extensions.json");
  if (fs.existsSync(configFile)) fs.unlinkSync(configFile);
  __resetPluginsForTests();
  await bootstrapPlugins(await loadBuiltinPlugins());
  isLspToolEnabledMock.mockReset();
  isLspToolEnabledMock.mockImplementation(() => true);
  queryLspMock.mockClear();
});

afterEach(() => {
  __resetPluginsForTests();
});

describe("lsp tool", () => {
  it("registers and routes the kernel-owned lsp tool", async () => {
    const tools = getEnabledToolSet() as Record<
      string,
      { execute: (input: unknown, context?: unknown) => Promise<unknown>; description?: string }
    >;

    expect(tools).toHaveProperty("lsp");
    expect(tools.lsp.description).toContain("Language Server Protocol");

    const result = await tools.lsp.execute(
      {
        operation: "hover",
        filePath: "src/index.ts",
        line: 3,
        character: 7,
      },
      { abortSignal: undefined },
    );

    const expectedCwd = getHostServices().workspace.cwd();
    expect(queryLspMock).toHaveBeenCalledWith(expectedCwd, {
      operation: "hover",
      filePath: "src/index.ts",
      line: 3,
      character: 7,
      query: undefined,
    });
    expect(result).toEqual({ success: true, output: "[]" });
  });

  it("is compatible with batch tool schema conversion", async () => {
    const tools = getEnabledToolSet();
    const batchTools = await toolSetToBatchTools(tools);
    const lspTool = batchTools.find((entry) => entry.function.name === "lsp");

    expect(lspTool).toBeDefined();
    expect(lspTool?.function.parameters).toMatchObject({
      properties: {
        operation: {
          type: "string",
        },
        filePath: {
          type: "string",
        },
      },
    });
  });

  // Behavior change vs the pre-migration `createTools()` gate: when the user
  // hasn't enabled LSP in settings, the tool stays visible to the model (the
  // kernel always exposes it) but `execute` returns a friendly "not enabled"
  // message instead of querying a nonexistent server. This regression test
  // pins that contract so future refactors don't accidentally hide the tool
  // again or swallow the message.
  it("returns a friendly error when LSP is disabled in settings", async () => {
    isLspToolEnabledMock.mockImplementationOnce(() => false);
    const tools = getEnabledToolSet() as Record<
      string,
      { execute: (input: unknown, context?: unknown) => Promise<unknown> }
    >;

    expect(tools).toHaveProperty("lsp");
    const result = (await tools.lsp.execute(
      { operation: "hover", filePath: "src/index.ts", line: 1, character: 1 },
      { abortSignal: undefined },
    )) as { success: boolean; output: string };

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/not enabled/i);
    // queryLsp should NOT be called when isLspToolEnabled returns false.
    expect(queryLspMock).not.toHaveBeenCalled();
  });
});
