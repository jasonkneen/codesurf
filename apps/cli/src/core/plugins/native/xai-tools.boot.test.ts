// The xAI tools plugin as the host actually boots it.
//
// Ported from the V1 `builtin/__tests__/xai-tools.test.ts`: same three
// assertions, now against the native plugin mounted through
// `createNativePluginModule`. It goes through `bootstrapPlugins` and reads
// what the agent reads (`getHostServices().tools`), so it is the compatibility
// gate — the four tools, their groups, their mode gate and the missing-key
// result must be indistinguishable from the V1 entry this replaced.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetPluginsForTests, bootstrapPlugins, getHostServices, shutdownPlugins } from "../index";
import { __resetNativeRuntimeForTests } from "./host";

// Mock settings so tests are not affected by keys stored in ~/.grok/user-settings.json.
vi.mock("../../../utils/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../utils/settings")>();
  return {
    ...actual,
    getApiKey: vi.fn(actual.getApiKey),
  };
});

let tempDir: string;
let originalConfigDir: string | undefined;
let originalCodeSurfKey: string | undefined;
let originalGrokKey: string | undefined;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-xai-tools-test-"));
  originalConfigDir = process.env.CODESURF_CONFIG_DIR;
  originalCodeSurfKey = process.env.CODESURF_API_KEY;
  originalGrokKey = process.env.CODESURF_API_KEY;
  process.env.CODESURF_CONFIG_DIR = tempDir;
  // Warm the catalog once: `builtin/index` pulls every builtin's module graph,
  // which takes seconds to transform and would otherwise blow the first test's
  // default timeout.
  await import("../builtin/index");
}, 60_000);

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.CODESURF_CONFIG_DIR;
  else process.env.CODESURF_CONFIG_DIR = originalConfigDir;
  if (originalCodeSurfKey === undefined) delete process.env.CODESURF_API_KEY;
  else process.env.CODESURF_API_KEY = originalCodeSurfKey;
  if (originalGrokKey === undefined) delete process.env.CODESURF_API_KEY;
  else process.env.CODESURF_API_KEY = originalGrokKey;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  __resetPluginsForTests();
  __resetNativeRuntimeForTests();
});

afterEach(async () => {
  await shutdownPlugins();
  __resetPluginsForTests();
  __resetNativeRuntimeForTests();
  vi.restoreAllMocks();
});

/** The catalog entry, so the test boots exactly what ships. */
async function xaiToolsModule() {
  const { loadBuiltinPlugins } = await import("../builtin/index");
  const modules = await loadBuiltinPlugins();
  const entries = modules.filter((module) => module.manifest.id === "builtin.tools-xai");
  expect(entries).toHaveLength(1);
  const entry = entries[0];
  if (!entry) throw new Error("builtin.tools-xai is missing from the shipped catalog");
  return entry;
}

describe("builtin.tools-xai", () => {
  it("registers the four xAI tools in agent mode", async () => {
    process.env.CODESURF_API_KEY = "test-key";
    await bootstrapPlugins([await xaiToolsModule()]);
    const tools = getHostServices().tools.list();
    const names = tools.map((t) => t.name);
    expect(names).toContain("search_web");
    expect(names).toContain("search_x");
    expect(names).toContain("generate_image");
    expect(names).toContain("generate_video");
    for (const name of ["search_web", "search_x", "generate_image", "generate_video"]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.modes).toEqual(["agent"]);
      // The registry attributes the contribution to the plugin's stable id.
      expect(tool?.pluginId).toBe("builtin.tools-xai");
    }
  }, 30_000);

  it("preserves the search/media UI groups", async () => {
    process.env.CODESURF_API_KEY = "test-key";
    await bootstrapPlugins([await xaiToolsModule()]);
    const tools = getHostServices().tools.list();
    expect(tools.find((t) => t.name === "search_web")?.group).toBe("search");
    expect(tools.find((t) => t.name === "search_x")?.group).toBe("search");
    expect(tools.find((t) => t.name === "generate_image")?.group).toBe("media");
    expect(tools.find((t) => t.name === "generate_video")?.group).toBe("media");
  }, 30_000);

  it("returns a credential-error result when no API key is configured", async () => {
    // Force getApiKey to return undefined regardless of local user settings.
    const { getApiKey } = await import("../../../utils/settings");
    vi.mocked(getApiKey).mockReturnValue(undefined);

    await bootstrapPlugins([await xaiToolsModule()]);
    const toolSet = getHostServices().tools.toolSet();
    const searchWeb = toolSet.search_web;
    expect(searchWeb).toBeDefined();
    const result = await (
      searchWeb as unknown as {
        execute: (args: unknown, ctx?: { abortSignal?: AbortSignal }) => Promise<{ success: boolean; output: string }>;
      }
    ).execute({ query: "anything" }, { abortSignal: new AbortController().signal });
    expect(result).toMatchObject({ success: false });
    expect(String(result.output)).toMatch(/api key/i);
  }, 30_000);
});
