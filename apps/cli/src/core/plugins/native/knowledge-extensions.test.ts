import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { __agentEventListenerCountForTests } from "../event-bus";
import {
  __resetPluginsForTests,
  bootstrapPlugins,
  type ChatDispatchOptions,
  getHostServices,
  setAssistantSink,
  setChatSink,
  setCwdProvider,
} from "../index";
import { createNativePluginModule } from "./host";
import { __knowledgeIndexSizesForTests, knowledgePlugin, safeFileSnippet } from "./knowledge-extensions";

let configDir: string;
let workspaceDir: string;
let originalConfigDir: string | undefined;

beforeAll(() => {
  originalConfigDir = process.env.CODESURF_CONFIG_DIR;
});

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.CODESURF_CONFIG_DIR;
  else process.env.CODESURF_CONFIG_DIR = originalConfigDir;
});

// A config dir PER TEST, not per file. `bootstrapPlugins` reads the
// persisted enable/disable list, so the case below that disables the extension
// was silently deciding whether later cases booted it at all.
beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-knowledge-config-"));
  process.env.CODESURF_CONFIG_DIR = configDir;
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-knowledge-workspace-"));
  __resetPluginsForTests();
});

afterEach(() => {
  __resetPluginsForTests();
  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe("knowledge extension", () => {
  it("marks the OpenAI embeddings API key as a secret setting", async () => {
    await bootstrapPlugins([createNativePluginModule(knowledgePlugin)]);
    const setting = getHostServices()
      .settings.list()
      .find((s) => s.key === "knowledge.openai.apiKey");
    expect(setting?.type).toBe("secret");
  });

  it("dispatches /rag as a retrieval prompt with a compact display label", async () => {
    fs.writeFileSync(
      path.join(workspaceDir, "knowledge-bootstrap.ts"),
      "export function initializeKnowledgeExtension() { return 'indexed context'; }\n",
      "utf-8",
    );

    const dispatched: Array<{ prompt: string; options?: ChatDispatchOptions }> = [];
    const appended: string[] = [];
    setCwdProvider(() => workspaceDir);
    setChatSink((prompt, options) => void dispatched.push({ prompt, options }));
    setAssistantSink((content) => appended.push(content));

    await bootstrapPlugins([createNativePluginModule(knowledgePlugin)]);
    const services = getHostServices();
    services.settings.set("knowledge.semantic.backend", "off");

    const resolution = services.commands.resolveInput("/rag how does knowledge bootstrap");
    expect(resolution?.command.name).toBe("/rag");

    await Promise.resolve(resolution!.command.handler({ args: resolution!.args, services }));

    expect(appended).toEqual([]);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.options).toEqual({ displayText: "/rag how does knowledge bootstrap" });
    expect(dispatched[0]!.prompt).toContain("Use only the indexed workspace context below");
    expect(dispatched[0]!.prompt).toContain("knowledge-bootstrap.ts");
    expect(dispatched[0]!.prompt).toContain("Question: how does knowledge bootstrap");
  });

  it("clears module-level index Maps on disable so a re-enable starts clean", async () => {
    fs.writeFileSync(path.join(workspaceDir, "alpha.ts"), "export const x = 1;\n", "utf-8");

    setCwdProvider(() => workspaceDir);
    setChatSink(() => {});
    setAssistantSink(() => {});

    await bootstrapPlugins([createNativePluginModule(knowledgePlugin)]);
    const services = getHostServices();
    services.settings.set("knowledge.semantic.backend", "off");

    // Building an index for the active cwd populates the module-level Map.
    await services.mentions.match("alpha");
    expect(__knowledgeIndexSizesForTests().files).toBeGreaterThanOrEqual(1);

    // Disabling the extension must run its onDispose and clear the Maps,
    // so a subsequent enable cannot observe stale index entries.
    await services.extensions.disable("builtin.knowledge");
    expect(__knowledgeIndexSizesForTests()).toEqual({ files: 0, semantic: 0 });
  });

  it("unsubscribes from the agent event bus on disable", async () => {
    // Regression: the conversion first wrote the two session subscriptions as
    // `ctx.effect(() => () => disposeSessionStart)`, whose disposer only NAMES
    // the handle and never calls it. A disabled plugin then kept warming its
    // index on every SessionStart — invisible except as a leak, which is why
    // this asserts on the observable effect rather than on a disposer running.
    setCwdProvider(() => workspaceDir);
    setChatSink(() => {});
    setAssistantSink(() => {});

    await bootstrapPlugins([createNativePluginModule(knowledgePlugin)]);
    expect(__agentEventListenerCountForTests("SessionStart")).toBe(1);
    expect(__agentEventListenerCountForTests("SessionEnd")).toBe(1);

    await getHostServices().extensions.disable("builtin.knowledge");

    expect(__agentEventListenerCountForTests("SessionStart")).toBe(0);
    expect(__agentEventListenerCountForTests("SessionEnd")).toBe(0);
  });
});

describe("safeFileSnippet", () => {
  it("numbers every line of a small file with no truncation note", () => {
    const file = path.join(workspaceDir, "small.ts");
    fs.writeFileSync(file, "line one\nline two\nline three", "utf-8");
    const snippet = safeFileSnippet(file);
    expect(snippet).toContain("   1 | line one");
    expect(snippet).toContain("   3 | line three");
    expect(snippet).toContain("first 3 of 3 lines");
    expect(snippet).not.toContain("truncated");
  });

  it("keeps line numbering and caps output for a file over the char budget", () => {
    const file = path.join(workspaceDir, "big.ts");
    const lines = Array.from({ length: 500 }, (_, i) => `const v${i} = ${"x".repeat(80)};`);
    fs.writeFileSync(file, lines.join("\n"), "utf-8");

    const snippet = safeFileSnippet(file, 2_000);
    expect(snippet).toContain("   1 | const v0");
    expect(snippet).toContain("truncated");
    // Body stays within the char budget (header/note excluded).
    const body = snippet!.split("\n").slice(1, -1).join("\n");
    expect(body.length).toBeLessThanOrEqual(2_000);
    // Every body line is numbered — the old raw-slice path was not.
    for (const line of body.split("\n")) {
      expect(line).toMatch(/^ *\d+ \| /);
    }
  });

  it("respects the line cap independent of byte size", () => {
    const file = path.join(workspaceDir, "many-lines.ts");
    fs.writeFileSync(file, Array.from({ length: 400 }, (_, i) => `l${i}`).join("\n"), "utf-8");
    const snippet = safeFileSnippet(file);
    expect(snippet).toContain("first 220 of 400 lines");
    expect(snippet).toContain("truncated: 180 more lines");
  });

  it("hard-slices a single line longer than the whole budget instead of returning empty", () => {
    const file = path.join(workspaceDir, "one-long-line.ts");
    fs.writeFileSync(file, "z".repeat(50_000), "utf-8");
    const snippet = safeFileSnippet(file, 1_000);
    expect(snippet).toContain("first 1 of 1 lines");
    expect(snippet).toContain("…");
  });

  it("returns null for directories and missing paths", () => {
    expect(safeFileSnippet(workspaceDir)).toBeNull();
    expect(safeFileSnippet(path.join(workspaceDir, "nope.ts"))).toBeNull();
  });
});
