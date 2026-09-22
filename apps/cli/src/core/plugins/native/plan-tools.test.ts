// Parity acceptance for the converted plan-tools plugin.
//
// `generate_plan` is what plan mode is built around: the model calls it, and
// `src/ui/components/message-list.tsx` renders `result.plan` as the plan view.
// So this file pins three layers:
//   1. The plugin on its own Cordis root with fake `HostBindings` — manifest
//      identity, the tool spec's exact name/description/group/modes, the input
//      schema, the returned `{ success, output, plan }` shape, and that
//      disposing the fiber releases the contribution.
//   2. The plugin through the real loader — this is the first native plugin to
//      register a *tool*, so `host.ts`'s `registerTool` binding is exercised
//      here for the first time: the registry entry the `/extensions` modal
//      reads, mode gating via `getEnabledToolSet()`, and executing the tool out
//      of the ToolSet the agent loop actually receives.
//   3. The shipped catalog — present exactly once, still `protected`.
//
// Ported from `builtin/__tests__/plan-tools.test.ts`, which this replaces.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Context, createCodesurfRoot, type HostBindings, mountPlugin } from "@codesurf/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetPluginsForTests,
  bootstrapPlugins,
  getEnabledToolSet,
  getHostServices,
  getRegistrySnapshot,
  setKernelMode,
  shutdownPlugins,
} from "../index";
import { __resetNativeRuntimeForTests, createNativePluginModule } from "./host";
import { planToolsPlugin } from "./plan-tools";

const ID = "builtin.tools.plan";

interface PlanResult {
  success: boolean;
  output: string;
  plan: {
    title: string;
    summary: string;
    steps: Array<{ title: string; description: string; filePaths?: string[] }>;
    questions?: Array<unknown>;
  };
}

interface ExecutableTool {
  inputSchema: { safeParse: (input: unknown) => { success: boolean } };
  execute: (args: unknown, ctx?: { abortSignal?: AbortSignal }) => Promise<PlanResult>;
}

/** The fixture the V1 suite executed, kept verbatim so the output string is comparable. */
const PLAN_INPUT = {
  title: "Refactor extension loader",
  summary: "Centralize sink cleanup behind clearAllSinks().",
  steps: [
    { title: "Audit sinks", description: "Find every setXxxSink callsite" },
    { title: "Add clearAllSinks", description: "Single helper", filePaths: ["src/core/plugins/loader.ts"] },
  ],
  questions: [
    {
      id: "q1",
      question: "Which file should own clearAllSinks?",
      type: "select",
      options: [
        { id: "loader", label: "loader.ts" },
        { id: "index", label: "index.ts" },
      ],
    },
  ],
};

function expectV1PlanResult(result: PlanResult): void {
  expect(result.success).toBe(true);
  expect(result.output).toBe('Plan "Refactor extension loader" generated with 2 steps');
  expect(result.plan.title).toBe("Refactor extension loader");
  expect(result.plan.summary).toBe("Centralize sink cleanup behind clearAllSinks().");
  expect(result.plan.steps).toHaveLength(2);
  expect(result.plan.steps[1]?.filePaths).toEqual(["src/core/plugins/loader.ts"]);
  expect(result.plan.questions).toHaveLength(1);
}

describe("native plan-tools — manifest identity", () => {
  it("carries the V1 manifest byte-for-byte", () => {
    expect(planToolsPlugin.manifest.id).toBe(ID);
    expect(planToolsPlugin.manifest.name).toBe("Plan");
    expect(planToolsPlugin.manifest.version).toBe("1.0.0");
    expect(planToolsPlugin.manifest.description).toBe("Interactive implementation-plan generation for plan mode.");
    expect(planToolsPlugin.manifest.enabledByDefault).toBe(true);
    // Plan mode is unusable without the tool, so `/extensions` must keep
    // refusing to disable it.
    expect(planToolsPlugin.manifest.protected).toBe(true);
    expect(planToolsPlugin.manifest.capabilities).toEqual(["tools"]);
    // V1 declared neither; adding either would change `/extensions`.
    expect(planToolsPlugin.manifest.hidden).toBeUndefined();
    expect(planToolsPlugin.manifest.group).toBeUndefined();
  });
});

describe("native plan-tools — tool contribution", () => {
  it("registers exactly the V1 tool spec", async () => {
    const root: Context = createCodesurfRoot();
    const fiber = mountPlugin(root, planToolsPlugin);
    await fiber;

    const tools = root.contributions.listTools();
    expect(tools).toHaveLength(1);
    const spec = tools[0];
    expect(spec?.name).toBe("generate_plan");
    expect(spec?.description).toBe("Generate an interactive implementation plan with steps and optional questions.");
    expect(spec?.group).toBe("plan");
    expect(spec?.modes).toEqual(["plan"]);
    // V1 set no label; the tool list must not grow a different display name.
    expect(spec?.label).toBeUndefined();
    // A kernel-owned tool: it carries its own executable definition.
    expect(spec?.tool).toBeDefined();

    await fiber.dispose();
  });

  it("keeps the model-facing description the V1 tool advertised", async () => {
    const root: Context = createCodesurfRoot();
    const fiber = mountPlugin(root, planToolsPlugin);
    await fiber;

    const definition = root.contributions.listTools()[0]?.tool as { description?: string };
    expect(definition?.description).toBe(
      "Generate an interactive implementation plan with steps and optional questions for the user. The plan is displayed in a structured UI where the user can review steps and answer questions. Always use this tool when creating plans.",
    );

    await fiber.dispose();
  });

  it("returns the exact { success, output, plan } shape consumed by the plan view", async () => {
    const root: Context = createCodesurfRoot();
    const fiber = mountPlugin(root, planToolsPlugin);
    await fiber;

    const definition = root.contributions.listTools()[0]?.tool as unknown as ExecutableTool;
    const result = await definition.execute(PLAN_INPUT, { abortSignal: new AbortController().signal });
    expectV1PlanResult(result);

    await fiber.dispose();
  });

  it("keeps the input schema as strict as V1's", async () => {
    const root: Context = createCodesurfRoot();
    const fiber = mountPlugin(root, planToolsPlugin);
    await fiber;

    const definition = root.contributions.listTools()[0]?.tool as unknown as ExecutableTool;
    expect(definition.inputSchema.safeParse(PLAN_INPUT).success).toBe(true);
    // `questions` is optional; `steps`, `title` and `summary` are not.
    expect(
      definition.inputSchema.safeParse({ title: "t", summary: "s", steps: [] }).success,
      "questions must stay optional",
    ).toBe(true);
    expect(definition.inputSchema.safeParse({ title: "t", summary: "s" }).success, "steps must stay required").toBe(
      false,
    );
    expect(
      definition.inputSchema.safeParse({
        title: "t",
        summary: "s",
        steps: [],
        questions: [{ id: "q", question: "?", type: "bogus" }],
      }).success,
      "question type must stay a closed enum",
    ).toBe(false);

    await fiber.dispose();
  });
});

describe("native plan-tools — lifecycle", () => {
  it("releases the host registration when the fiber is disposed", async () => {
    const release = vi.fn();
    const registered: Array<{ name: string; pluginId: string }> = [];
    const bindings: HostBindings = {
      registerTool: (spec, pluginManifest) => {
        registered.push({ name: spec.name, pluginId: pluginManifest.id });
        return release;
      },
    };
    const root = createCodesurfRoot(bindings);
    const fiber = mountPlugin(root, planToolsPlugin);
    await fiber;

    expect(registered).toEqual([{ name: "generate_plan", pluginId: ID }]);
    expect(release).not.toHaveBeenCalled();
    expect(root.contributions.listTools()).toHaveLength(1);

    await fiber.dispose();
    expect(release).toHaveBeenCalledTimes(1);
    expect(root.contributions.listTools()).toEqual([]);
  });
});

describe("native plan-tools — through the host loader", () => {
  // Own config dir per test: `bootstrapPlugins` reads persisted
  // enable/disable lists, and a shared dir would let one run's opt-out decide
  // another's result.
  const originalConfigDir = process.env.CODESURF_CONFIG_DIR;
  let configDir = "";

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-plan-tools-"));
    process.env.CODESURF_CONFIG_DIR = configDir;
    __resetPluginsForTests();
    __resetNativeRuntimeForTests();
  });

  afterEach(async () => {
    await shutdownPlugins();
    __resetPluginsForTests();
    __resetNativeRuntimeForTests();
    setKernelMode(null);
    if (originalConfigDir === undefined) delete process.env.CODESURF_CONFIG_DIR;
    else process.env.CODESURF_CONFIG_DIR = originalConfigDir;
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it("registers generate_plan as kernel-owned with modes: [plan] and group 'plan'", async () => {
    await bootstrapPlugins([createNativePluginModule(planToolsPlugin)]);

    const entry = getRegistrySnapshot().tools.find((t) => t.name === "generate_plan");
    expect(entry, "generate_plan should be registered").toBeDefined();
    expect(entry?.pluginId).toBe(ID);
    expect(entry?.tool, "generate_plan should have a kernel-owned tool def").toBeDefined();
    expect(entry?.group).toBe("plan");
    expect(entry?.modes).toEqual(["plan"]);
  });

  it("surfaces generate_plan in plan mode and hides it in agent / ask modes", async () => {
    await bootstrapPlugins([createNativePluginModule(planToolsPlugin)]);

    setKernelMode("plan");
    expect(Object.keys(getEnabledToolSet())).toContain("generate_plan");

    setKernelMode("agent");
    expect(Object.keys(getEnabledToolSet())).not.toContain("generate_plan");

    setKernelMode("ask");
    expect(Object.keys(getEnabledToolSet())).not.toContain("generate_plan");
  });

  it("executes out of the ToolSet the agent loop receives", async () => {
    await bootstrapPlugins([createNativePluginModule(planToolsPlugin)]);

    const toolSet = getHostServices().tools.toolSet();
    const generatePlan = toolSet.generate_plan as unknown as ExecutableTool;
    expect(generatePlan).toBeDefined();

    const result = await generatePlan.execute(PLAN_INPUT, { abortSignal: new AbortController().signal });
    expectV1PlanResult(result);
  });

  it("removes the tool from the registry when the plugin is shut down", async () => {
    await bootstrapPlugins([createNativePluginModule(planToolsPlugin)]);
    expect(getRegistrySnapshot().tools.some((t) => t.name === "generate_plan")).toBe(true);

    await shutdownPlugins();
    // Gone because the fiber's effect disposer ran, not because the loader
    // swept the extension id.
    expect(getRegistrySnapshot().tools.some((t) => t.name === "generate_plan")).toBe(false);
  });
});

describe("native plan-tools — shipped catalog", () => {
  // Importing the catalog pulls in every builtin's module graph; the default
  // 5s budget is not enough for that cold transform on a loaded machine.
  it("is present in the built-in catalog exactly once, as the native module", async () => {
    const { loadBuiltinPlugins } = await import("../builtin/index");
    const modules = await loadBuiltinPlugins();
    const entries = modules.filter((module) => module.manifest.id === ID);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.manifest.kind).toBe("builtin");
    // The native module disposes a fiber on deactivate; the V1 entry it
    // replaced had no `deactivate` at all, so this is what proves the catalog
    // now ships the conversion rather than the old `activate(api)` module.
    expect(typeof entries[0]?.deactivate).toBe("function");
    expect(entries[0]?.manifest.name).toBe("Plan");
    expect(entries[0]?.manifest.enabledByDefault).toBe(true);
    expect(entries[0]?.manifest.protected).toBe(true);
    expect(entries[0]?.manifest.capabilities).toEqual(["tools"]);
  }, 60_000);
});
