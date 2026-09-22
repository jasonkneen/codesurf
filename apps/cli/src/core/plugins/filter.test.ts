import { type ToolSet, tool } from "ai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadBuiltinPlugins } from "./builtin";
import {
  __resetPluginsForTests,
  bootstrapPlugins,
  filterToolSetByEnabled,
  getEnabledToolSet,
  getHostServices,
} from "./index";
import { createNativePluginModule } from "./native/host";

// Redirect persistence to an isolated temp dir (see loader.test.ts).
let tempDir: string;
let originalEnv: string | undefined;

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-ext-filter-test-"));
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
  const configFile = path.join(tempDir, "extensions.json");
  if (fs.existsSync(configFile)) fs.unlinkSync(configFile);
  __resetPluginsForTests();
});

afterEach(() => {
  __resetPluginsForTests();
});

function fakeTool(name: string) {
  return tool({
    description: name,
    inputSchema: z.object({ q: z.string() }),
    execute: async ({ q }) => ({ name, q }),
  });
}

describe("filterToolSetByEnabled", () => {
  it("registers every builtin tool group and leaves all tools enabled by default", async () => {
    await bootstrapPlugins(await loadBuiltinPlugins());
    const snapshot = getHostServices();
    const registered = snapshot.tools.list();
    // Spot-check a few known builtins.
    const names = registered.map((t) => t.name);
    expect(names).toContain("bash");
    expect(names).toContain("read_file");
    expect(names).toContain("grep");
    expect(names).toContain("search_web");
    expect(names).toContain("generate_image");
    expect(names).toContain("computer_click");
    expect(names).toContain("schedule_create");
    expect(names).toContain("task");
    expect(names).toContain("telegram_send_file");
    // All builtins start enabled (sanity check).
    for (const tool of registered) {
      expect(snapshot.tools.isEnabled(tool.name)).toBe(true);
    }
  });

  it("passes through unknown tool names untouched (e.g. MCP-provided tools)", async () => {
    await bootstrapPlugins(await loadBuiltinPlugins());
    const fake = {
      mcp_github_create_issue: fakeTool("mcp_github_create_issue"),
      mcp_supabase_query: fakeTool("mcp_supabase_query"),
    };
    const filtered = filterToolSetByEnabled(fake);
    expect(Object.keys(filtered).sort()).toEqual(["mcp_github_create_issue", "mcp_supabase_query"]);
  });

  it("removes disabled tool names from an externally-produced ToolSet", async () => {
    await bootstrapPlugins(await loadBuiltinPlugins());
    const services = getHostServices();
    const external = {
      bash: fakeTool("bash"),
      grep: fakeTool("grep"),
      read_file: fakeTool("read_file"),
    };

    services.tools.setEnabled("grep", false);
    const filtered = filterToolSetByEnabled(external);
    expect(Object.keys(filtered).sort()).toEqual(["bash", "read_file"]);

    // Re-enabling restores the tool.
    services.tools.setEnabled("grep", true);
    const refiltered = filterToolSetByEnabled(external);
    expect(Object.keys(refiltered).sort()).toEqual(["bash", "grep", "read_file"]);
  });

  it("removes a disabled extension's tools from the Agent's ToolSet", async () => {
    await bootstrapPlugins(await loadBuiltinPlugins());
    const services = getHostServices();
    const external = {
      generate_image: fakeTool("generate_image"),
      generate_video: fakeTool("generate_video"),
      bash: fakeTool("bash"),
    };

    // Phase 3b step 4: media tools moved from builtin.tools.media to builtin.tools-xai.
    await services.extensions.disable("builtin.tools-xai");
    const filtered = filterToolSetByEnabled(external);
    expect(Object.keys(filtered).sort()).toEqual(["bash"]);

    // Re-enabling the extension restores its tools.
    await services.extensions.enable("builtin.tools-xai");
    const refiltered = filterToolSetByEnabled(external);
    expect(Object.keys(refiltered).sort()).toEqual(["bash", "generate_image", "generate_video"]);
  });

  it("hosts the payments group enabled by default and toggleable", async () => {
    // The kernel-owned payments extension ships enabledByDefault: true (its
    // tools are individually gated by the payment approval flow). This pins
    // the manifest policy and that users can still opt out.
    await bootstrapPlugins(await loadBuiltinPlugins());
    const services = getHostServices();
    const payments = services.extensions.list().find((e) => e.id === "builtin.tools.payments");
    expect(payments?.enabled).toBe(true);
    await services.extensions.disable("builtin.tools.payments");
    expect(services.extensions.list().find((e) => e.id === "builtin.tools.payments")?.enabled).toBe(false);
  });

  it("marks bash and file groups as protected", async () => {
    await bootstrapPlugins(await loadBuiltinPlugins());
    const list = getHostServices().extensions.list();
    const bash = list.find((e) => e.id === "builtin.tools.bash");
    const file = list.find((e) => e.id === "builtin.tools.file");
    expect(bash?.protected).toBe(true);
    expect(file?.protected).toBe(true);
  });

  // Regression coverage for Phase 0 item 2: extension-contributed tools with a
  // real `tool: tool({...})` def must reach the agent's ToolSet so streamText
  // can execute them. Builtins are metadata-only; this is the only test that
  // proves the kernel-owned execution path actually wires through.
  it("includes extension-registered tools with execute() in services.tools.toolSet()", async () => {
    // A native Cordis plugin: the V1 `activate(api)` surface no longer exists.
    const fakeExt = createNativePluginModule({
      name: "test-kernel-tool",
      manifest: {
        id: "test.kernel.tool",
        name: "Kernel Tool Test",
        version: "1.0.0",
        capabilities: ["tools"],
      },
      inject: ["contributions"],
      apply(ctx) {
        ctx.effect(() =>
          ctx.contributions.registerTool({
            name: "kernel_owned_echo",
            description: "Echoes input via kernel-owned execution",
            tool: tool({
              description: "Echoes input via kernel-owned execution",
              inputSchema: z.object({ msg: z.string() }),
              execute: async ({ msg }) => ({ echoed: msg }),
            }),
          }),
        );
      },
    });

    await bootstrapPlugins([...(await loadBuiltinPlugins()), fakeExt]);
    const toolSet = getHostServices().tools.toolSet();
    expect(Object.keys(toolSet)).toContain("kernel_owned_echo");

    // Sanity: getEnabledToolSet() (the helper agent.ts now calls) sees it too.
    expect(Object.keys(getEnabledToolSet())).toContain("kernel_owned_echo");

    // Disabling the extension removes the tool from the assembled set,
    // proving the disabled-extension gate flows through end-to-end.
    await getHostServices().extensions.disable("test.kernel.tool");
    expect(Object.keys(getHostServices().tools.toolSet())).not.toContain("kernel_owned_echo");
    expect(Object.keys(getEnabledToolSet())).not.toContain("kernel_owned_echo");
  });

  // Regression coverage for Phase 2 prerequisite: the agent merge order in
  // `Agent.buildTurnToolset()` seeds from kernelTools then overlays MCP, so
  // a kernel-owned tool wins over any entry with the same name. This is the
  // property that lets us migrate one tool group at a time without a cutover —
  // kernel can ship alongside the legacy set and the kernel one runs. See the
  // Phase-2-#9 note in `Agent.buildTurnToolset` for the original regression.
  it("kernel-owned tool wins over a baseTools entry with the same name", async () => {
    const KERNEL_SENTINEL = "from-kernel";
    const BASE_SENTINEL = "from-base";

    const overrideExt = createNativePluginModule({
      name: "test-kernel-override",
      manifest: {
        id: "test.kernel.override",
        name: "Kernel Override Test",
        version: "1.0.0",
        capabilities: ["tools"],
      },
      inject: ["contributions"],
      apply(ctx) {
        ctx.effect(() =>
          ctx.contributions.registerTool({
            name: "collide",
            description: "Kernel-owned implementation of `collide`",
            tool: tool({
              description: "Kernel-owned implementation of `collide`",
              inputSchema: z.object({ q: z.string() }),
              execute: async () => ({ source: KERNEL_SENTINEL }),
            }),
          }),
        );
      },
    });

    await bootstrapPlugins([...(await loadBuiltinPlugins()), overrideExt]);

    // Build the agent's merged ToolSet shape: baseTools first, kernel last.
    const baseTools: ToolSet = {
      collide: tool({
        description: "Base impl",
        inputSchema: z.object({ q: z.string() }),
        execute: async () => ({ source: BASE_SENTINEL }),
      }),
    };
    const kernelTools = getEnabledToolSet();
    const merged: ToolSet = filterToolSetByEnabled({ ...baseTools, ...kernelTools });

    expect(Object.keys(merged)).toContain("collide");

    // Run the merged tool's execute() and verify the kernel sentinel comes
    // back — proving the kernel-owned `tool` def displaced the base one.
    const collide = merged.collide;
    expect(collide).toBeDefined();
    const result = await (collide as unknown as { execute: (i: { q: string }) => Promise<{ source: string }> }).execute(
      { q: "ignored" },
    );
    expect(result.source).toBe(KERNEL_SENTINEL);

    // Disabling the extension drops the tool entirely — once the kernel
    // claims a name, `disabledPluginToolNames` strips it on filter, and
    // the baseTools fallback does NOT survive. This is the correct contract
    // for migrated tools: enable/disable means enable/disable end-to-end.
    await getHostServices().extensions.disable("test.kernel.override");
    const afterDisable: ToolSet = filterToolSetByEnabled({ ...baseTools, ...getEnabledToolSet() });
    expect(Object.keys(afterDisable)).not.toContain("collide");
  });
});
