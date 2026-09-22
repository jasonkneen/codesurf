// Parity acceptance for the converted `ask_user_structured` tool plugin.
//
// The V1 builtin had no service dependencies at all: it registered one
// kernel-owned tool whose result is a fixed acknowledgement sentence (the real
// answers arrive out-of-band as a follow-up user message). So the compatibility
// surface is exactly three things — the manifest, the tool's registered
// metadata plus its model-facing description/schema, and the sentence the model
// reads back. All three are pinned here.
//
// The first half mounts the plugin on its own root with fake `HostBindings`;
// the second half is the ported V1 smoke test, driven through the real loader
// so the registry snapshot, the kernel mode filter and the executable ToolSet
// the agent consumes are all exercised end to end.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PluginManifest, ToolSpec } from "@codesurf/plugin-api";
import { type Context, createCodesurfRoot, type HostBindings, mountPlugin } from "@codesurf/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetPluginsForTests,
  bootstrapPlugins,
  EXTENSIONS_V1_API_VERSION,
  getEnabledToolSet,
  getHostServices,
  getRegistrySnapshot,
  setKernelMode,
  shutdownPlugins,
} from "../index";
import { askToolsPlugin } from "./ask-tools";
import { __resetNativeRuntimeForTests, createNativePluginModule } from "./host";

const ID = "builtin.tools.ask";
const TOOL_NAME = "ask_user_structured";

/** The V1 model-facing description, verbatim. Drift here changes tool choice. */
const MODEL_DESCRIPTION =
  "Ask the user one or more multiple-choice questions when you need a decision before proceeding. " +
  "Each question is shown as a tab with selectable options; the user's answers arrive as a follow-up " +
  "message on your next turn, so after calling this tool you should stop and wait rather than guessing. " +
  "Prefer this over free-form questions when the choices are well-defined. Mark the safest/default option " +
  "as recommended.";

const TAIL = ". Their answers will arrive as a follow-up message — wait for it before proceeding.";

interface AskResult {
  success: boolean;
  output: string;
}

/** The structural shape of the `ai` tool definition the plugin registers. */
interface AskTool {
  description: string;
  inputSchema: { safeParse: (value: unknown) => { success: boolean } };
  execute: (input: unknown, ctx?: { abortSignal?: AbortSignal }) => Promise<AskResult>;
}

function question(id: string): Record<string, unknown> {
  return {
    id,
    header: "Store",
    prompt: "Where should the cache live?",
    options: [
      { id: "redis", label: "Redis", recommended: true },
      { id: "memory", label: "In-memory" },
    ],
  };
}

function bootRoot(overrides: Partial<HostBindings> = {}): Context {
  return createCodesurfRoot(overrides);
}

/** Mount on a bare root and hand back the registered tool definition. */
async function mountAndGetTool(root: Context): Promise<{ fiber: ReturnType<typeof mountPlugin>; tool: AskTool }> {
  const fiber = mountPlugin(root, askToolsPlugin);
  await fiber;
  const spec = root.contributions.listTools()[0];
  if (!spec) throw new Error(`${TOOL_NAME} was not registered`);
  return { fiber, tool: spec.tool as AskTool };
}

describe("native ask-tools — manifest identity", () => {
  it("carries the V1 manifest byte-for-byte", () => {
    expect(askToolsPlugin.manifest.id).toBe(ID);
    expect(askToolsPlugin.manifest.name).toBe("Ask");
    expect(askToolsPlugin.manifest.version).toBe("1.0.0");
    expect(askToolsPlugin.manifest.description).toBe("Structured multiple-choice questions for the user, mid-turn.");
    expect(askToolsPlugin.manifest.enabledByDefault).toBe(true);
    expect(askToolsPlugin.manifest.capabilities).toEqual(["tools"]);
    // V1 declared none of these; adding one would change `/extensions` (and
    // `protected` would take the disable toggle away from users).
    expect(askToolsPlugin.manifest.protected).toBeUndefined();
    expect(askToolsPlugin.manifest.hidden).toBeUndefined();
    expect(askToolsPlugin.manifest.group).toBeUndefined();
  });

  it("declares only the contribution registry — the V1 activate() used no service", () => {
    expect(askToolsPlugin.inject).toEqual(["contributions"]);
  });
});

describe("native ask-tools — tool identity", () => {
  it("registers exactly the V1 tool spec", async () => {
    const root = bootRoot();
    const fiber = mountPlugin(root, askToolsPlugin);
    await fiber;

    const specs = root.contributions.listTools();
    expect(specs).toHaveLength(1);
    const spec = specs[0];
    expect(spec?.name).toBe(TOOL_NAME);
    expect(spec?.description).toBe("Ask the user one or more multiple-choice questions and wait for their answer.");
    expect(spec?.group).toBe("ask");
    expect(spec?.modes).toEqual(["agent", "ask"]);
    expect(spec?.label).toBeUndefined();
    // The command registry stays untouched: this plugin contributes tools only.
    expect(root.contributions.listCommands()).toEqual([]);
    expect(root.contributions.listSettings()).toEqual([]);

    await fiber.dispose();
  });

  it("keeps the model-facing description verbatim", async () => {
    const root = bootRoot();
    const { fiber, tool } = await mountAndGetTool(root);
    expect(tool.description).toBe(MODEL_DESCRIPTION);
    await fiber.dispose();
  });

  it("mirrors the tool into the host under the V1 extension id and releases it on dispose", async () => {
    const release = vi.fn();
    const registered: Array<{ spec: ToolSpec; manifest: PluginManifest }> = [];
    const root = bootRoot({
      registerTool: (spec, manifest) => {
        registered.push({ spec, manifest });
        return release;
      },
    });
    const fiber = mountPlugin(root, askToolsPlugin);
    await fiber;

    expect(registered).toHaveLength(1);
    expect(registered[0]?.spec.name).toBe(TOOL_NAME);
    expect(registered[0]?.manifest.id).toBe(ID);
    expect(release).not.toHaveBeenCalled();

    await fiber.dispose();
    // The fiber's effect owns the disposer, so unmounting removes the tool from
    // both the root and the host registry.
    expect(release).toHaveBeenCalledTimes(1);
    expect(root.contributions.listTools()).toEqual([]);
  });
});

describe("native ask-tools — acknowledgement text", () => {
  it("names a single question and quotes the title", async () => {
    const root = bootRoot();
    const { fiber, tool } = await mountAndGetTool(root);

    const result = await tool.execute(
      { title: "Caching approach", questions: [question("store")] },
      { abortSignal: new AbortController().signal },
    );

    expect(result.success).toBe(true);
    expect(result.output).toBe(`Presented 1 question to the user ("Caching approach")${TAIL}`);
    await fiber.dispose();
  });

  it("omits the parenthetical when no title is given", async () => {
    const root = bootRoot();
    const { fiber, tool } = await mountAndGetTool(root);

    const result = await tool.execute({ questions: [question("store")] });
    expect(result.output).toBe(`Presented 1 question to the user${TAIL}`);
    await fiber.dispose();
  });

  it("pluralises for more than one question", async () => {
    const root = bootRoot();
    const { fiber, tool } = await mountAndGetTool(root);

    const result = await tool.execute({ questions: [question("a"), question("b"), question("c")] });
    expect(result.output).toBe(`Presented 3 questions to the user${TAIL}`);
    await fiber.dispose();
  });

  it("returns an acknowledge-only { success, output } shape (no answers in the result)", async () => {
    const root = bootRoot();
    const { fiber, tool } = await mountAndGetTool(root);

    const result = await tool.execute({ title: "Caching approach", questions: [question("store")] });
    expect(Object.keys(result).sort()).toEqual(["output", "success"]);
    // The answers arrive as a follow-up message; echoing them here would make
    // the model act on stale input.
    expect(result).not.toHaveProperty("answers");
    expect(result).not.toHaveProperty("questionnaire");
    await fiber.dispose();
  });
});

describe("native ask-tools — input schema", () => {
  it("keeps the V1 minimums: one question, two options each", async () => {
    const root = bootRoot();
    const { fiber, tool } = await mountAndGetTool(root);
    const schema = tool.inputSchema;

    expect(schema.safeParse({ questions: [question("store")] }).success).toBe(true);
    expect(schema.safeParse({ title: "T", questions: [question("store")] }).success).toBe(true);
    expect(schema.safeParse({ questions: [] }).success).toBe(false);
    expect(schema.safeParse({ questions: [{ ...question("store"), options: [{ label: "Only one" }] }] }).success).toBe(
      false,
    );
    // `header` and `prompt` stay required; `id`/`description`/`recommended` on
    // an option stay optional.
    expect(schema.safeParse({ questions: [{ id: "q", options: question("q").options }] }).success).toBe(false);
    expect(
      schema.safeParse({
        questions: [{ id: "q", header: "H", prompt: "P", options: [{ label: "A" }, { label: "B" }] }],
      }).success,
    ).toBe(true);

    await fiber.dispose();
  });
});

describe("native ask-tools through the host loader", () => {
  // Own config dir per test: `bootstrapPlugins` reads persisted
  // enable/disable lists, and a shared dir would let one run decide another's.
  const originalConfigDir = process.env.CODESURF_CONFIG_DIR;
  let configDir = "";

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-ask-tools-"));
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

  it("registers ask_user_structured as kernel-owned with modes: [agent, ask] and group 'ask'", async () => {
    await bootstrapPlugins([createNativePluginModule(askToolsPlugin)]);

    const entry = getRegistrySnapshot().tools.find((t) => t.name === TOOL_NAME);
    expect(entry, "ask_user_structured should be registered").toBeDefined();
    expect(entry?.tool, "ask_user_structured should have a kernel-owned tool def").toBeDefined();
    expect(entry?.pluginId).toBe(ID);
    expect(entry?.group).toBe("ask");
    expect(entry?.modes).toEqual(["agent", "ask"]);
  });

  it("presents the V1 extension manifest to the loader", async () => {
    const module = createNativePluginModule(askToolsPlugin);
    expect(module.manifest.id).toBe(ID);
    expect(module.manifest.kind).toBe("builtin");
    expect(module.manifest.hostApiVersion).toBe(EXTENSIONS_V1_API_VERSION);
    expect(module.manifest.capabilities).toContain("tools");
    expect(module.manifest.enabledByDefault).toBe(true);
    expect(module.manifest.protected).toBeUndefined();
  });

  it("surfaces ask_user_structured in agent / ask modes and hides it in plan mode", async () => {
    await bootstrapPlugins([createNativePluginModule(askToolsPlugin)]);

    setKernelMode("agent");
    expect(Object.keys(getEnabledToolSet())).toContain(TOOL_NAME);

    setKernelMode("ask");
    expect(Object.keys(getEnabledToolSet())).toContain(TOOL_NAME);

    setKernelMode("plan");
    expect(Object.keys(getEnabledToolSet())).not.toContain(TOOL_NAME);
  });

  it("is executable from the ToolSet the agent consumes", async () => {
    await bootstrapPlugins([createNativePluginModule(askToolsPlugin)]);

    const askUser = getHostServices().tools.toolSet()[TOOL_NAME] as unknown as AskTool;
    expect(askUser).toBeDefined();

    const result = await askUser.execute(
      { title: "Caching approach", questions: [question("store")] },
      { abortSignal: new AbortController().signal },
    );

    expect(result.success).toBe(true);
    expect(result.output).toBe(`Presented 1 question to the user ("Caching approach")${TAIL}`);
  });

  it("shutdown removes the tool through fiber disposal", async () => {
    await bootstrapPlugins([createNativePluginModule(askToolsPlugin)]);
    expect(getRegistrySnapshot().tools.some((t) => t.name === TOOL_NAME)).toBe(true);

    await shutdownPlugins();
    expect(getRegistrySnapshot().tools.some((t) => t.name === TOOL_NAME)).toBe(false);
  });

  // Importing the catalog pulls in every builtin's module graph; the default
  // 5s budget is not enough for that cold transform on a loaded machine.
  it("is present in the built-in catalog exactly once, as the native module", async () => {
    const { loadBuiltinPlugins } = await import("../builtin/index");
    const modules = await loadBuiltinPlugins();
    const entries = modules.filter((module) => module.manifest.id === ID);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.manifest.kind).toBe("builtin");
    expect(entries[0]?.manifest.name).toBe("Ask");
    expect(entries[0]?.manifest.enabledByDefault).toBe(true);
    expect(entries[0]?.manifest.capabilities).toEqual(["tools"]);
  }, 60_000);
});
