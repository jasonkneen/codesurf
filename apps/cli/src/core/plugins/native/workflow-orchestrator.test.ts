// Parity acceptance for the converted `/workflow` plugin.
//
// The V1 builtin is gone, so the numbers and strings below are an ORACLE
// captured from `builtin/workflow-orchestrator.ts` at commit 9de6ae4 by
// activating it with a fake api and recording `spec.prompt(...)` verbatim. They
// are deliberately exact: asserting a hand-copied spec against itself would
// prove nothing, whereas an exact byte length plus the head and tail of the
// rendered prompt fails loudly if the captured text drifts.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChatDispatchOptions, PluginManifest, PromptCommandSpec } from "@codesurf/plugin-api";
import { createCodesurfRoot, type HostBindings, mountPlugin } from "@codesurf/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetPluginsForTests, bootstrapPlugins, getHostServices, shutdownPlugins } from "../loader";
import { getRegistrySnapshot } from "../registry";
import { setChatSink } from "../sinks";
import { __resetNativeRuntimeForTests, createNativePluginModule } from "./host";
import { buildWorkflowDisplayText, workflowOrchestratorPlugin } from "./workflow-orchestrator";

/** Exact `prompt()` lengths V1 produced for these arguments. */
const V1_PROMPT_LENGTH_NO_ARGS = 6474;
const V1_PROMPT_LENGTH_WITH_TASK = 6401;

const V1_NO_ARGS_HEAD =
  "The user wants to run a task as a multi-agent workflow but did not specify one. Ask them, in one line, what task to orchestrate — then stop and wait.\n\n";
const V1_WITH_TASK_HEAD = "Run the following task as a multi-agent workflow:\n\n<task>\naudit auth\n</task>\n\n";
const V1_SHARED_INSTRUCTION =
  "Adopt and execute the workflow orchestration process below. First write a short PLAN: the phases, what fans out in parallel, what pipelines, and how findings get verified before synthesis. Then execute it using CodeSurf's real sub-agent tools (`task` for foreground fan-out, `delegate` for read-only background research), narrating each phase. Finish with a synthesized result and an explicit note of any coverage you deliberately bounded.\n\n---\n\n";
const V1_TAIL = "Use `delegate` only for read-only research you want to run in the background.";

/**
 * Boot a root that captures the prompt command.
 *
 * `ContributionsServiceImpl.listCommands()` only lists `registerCommand`
 * contributions — prompt commands have no lister — so the host binding is the
 * observation point, exactly as the real host bridge is.
 */
function bootRoot() {
  const registered: Array<{ spec: PromptCommandSpec; manifest: PluginManifest }> = [];
  const release = vi.fn();
  const bindings: HostBindings = {
    registerPromptCommand: (spec, manifest) => {
      registered.push({ spec, manifest });
      return release;
    },
  };
  return { root: createCodesurfRoot(bindings), registered, release };
}

describe("native /workflow plugin — command identity", () => {
  it("registers one prompt command with V1's exact name, argsHint and description", async () => {
    const { root, registered } = bootRoot();
    const fiber = mountPlugin(root, workflowOrchestratorPlugin);
    await fiber;

    expect(registered).toHaveLength(1);
    const spec = registered[0]?.spec;
    expect(spec?.name).toBe("/workflow");
    expect(spec?.argsHint).toBe("<task to orchestrate>");
    expect(spec?.description).toBe("Run a task as a multi-agent workflow (Claude Code orchestration process).");
    // V1 passed neither, and the bridge forwards undefined for both.
    expect(spec?.aliases).toBeUndefined();
    expect(spec?.hidden).toBeUndefined();

    await fiber.dispose();
  });

  it("carries the V1 manifest unchanged so persisted opt-outs keep applying", () => {
    const manifest = workflowOrchestratorPlugin.manifest;
    expect(manifest.id).toBe("builtin.commands.workflow-orchestrator");
    expect(manifest.name).toBe("Workflow Orchestrator");
    expect(manifest.version).toBe("1.0.0");
    expect(manifest.description).toBe(
      "Captures Claude Code's Workflow orchestration process as the /workflow command — fan-out, pipeline vs barrier, adversarial verify, synthesis — executed via CodeSurf's real sub-agent tools.",
    );
    expect(manifest.enabledByDefault).toBe(true);
    expect(manifest.protected).toBe(false);
    expect(manifest.capabilities).toEqual(["commands"]);
    expect(manifest.hidden).toBeUndefined();
    expect(manifest.group).toBeUndefined();
  });

  it("attributes the registration to its own manifest", async () => {
    const { root, registered } = bootRoot();
    const fiber = mountPlugin(root, workflowOrchestratorPlugin);
    await fiber;

    expect(registered[0]?.manifest.id).toBe("builtin.commands.workflow-orchestrator");
    await fiber.dispose();
  });
});

describe("native /workflow plugin — prompt branches", () => {
  async function buildPrompt(args: string): Promise<string> {
    const { root, registered } = bootRoot();
    const fiber = mountPlugin(root, workflowOrchestratorPlugin);
    await fiber;
    const spec = registered[0]?.spec;
    if (!spec) throw new Error("prompt command not registered");
    const prompt = await spec.buildPrompt({ args });
    await fiber.dispose();
    return prompt;
  }

  it("asks the user for a task when no arguments are given", async () => {
    const prompt = await buildPrompt("");

    expect(prompt.length).toBe(V1_PROMPT_LENGTH_NO_ARGS);
    expect(prompt.startsWith(V1_NO_ARGS_HEAD)).toBe(true);
    expect(prompt).toContain(V1_SHARED_INSTRUCTION);
    expect(prompt.endsWith(V1_TAIL)).toBe(true);
    // The no-task branch must not fabricate an empty <task> block.
    expect(prompt).not.toContain("<task>");
  });

  it("wraps the trimmed task in a <task> block when arguments are given", async () => {
    const prompt = await buildPrompt("  audit auth  ");

    expect(prompt.length).toBe(V1_PROMPT_LENGTH_WITH_TASK);
    expect(prompt.startsWith(V1_WITH_TASK_HEAD)).toBe(true);
    expect(prompt).toContain(V1_SHARED_INSTRUCTION);
    expect(prompt.endsWith(V1_TAIL)).toBe(true);
  });

  it("treats whitespace-only arguments as no task at all, exactly as V1 did", async () => {
    expect(await buildPrompt("   \t  ")).toBe(await buildPrompt(""));
  });

  it("embeds the orchestration spec verbatim in both branches", async () => {
    for (const args of ["", "audit auth"]) {
      const prompt = await buildPrompt(args);
      expect(prompt).toContain("# Workflow orchestration process (captured from Claude Code)");
      expect(prompt).toContain("## Orchestration primitives and their exact semantics");
      expect(prompt).toContain("### The rule that matters most: pipeline by default, barrier only when needed");
      expect(prompt).toContain("## Quality patterns — compose these, don't just fan out");
      expect(prompt).toContain("## The canonical multi-stage shape (pipeline + verify)");
      expect(prompt).toContain("## Executing this in CodeSurf");
      // Backticked tool names survive the template nesting.
      expect(prompt).toContain("**agent(prompt)**");
      expect(prompt).toContain("this\n  is a `task` tool call.");
    }
  });
});

describe("native /workflow plugin — transcript header", () => {
  // V1 passed `displayText: ctx => task ? `/workflow ${task}` : "/workflow"`, and
  // the loader forwarded it to `chat.dispatch(prompt, { displayText })`. Both the
  // user bubble (`use-turn-engine.ts:127`) and the auto-generated session title
  // (:132) read that string, so a drift here regresses two visible surfaces.
  it("collapses an empty invocation to the bare command name", () => {
    expect(buildWorkflowDisplayText({ args: "" })).toBe("/workflow");
  });

  it("collapses a whitespace-only invocation to the bare command name", () => {
    expect(buildWorkflowDisplayText({ args: "   \t  " })).toBe("/workflow");
  });

  it("trims the task and shows it after the command name, never the expanded prompt", () => {
    expect(buildWorkflowDisplayText({ args: "  audit auth  " })).toBe("/workflow audit auth");
  });

  it("carries the resolver on the registered spec so the bridge can forward it", async () => {
    const { root, registered } = bootRoot();
    const fiber = mountPlugin(root, workflowOrchestratorPlugin);
    await fiber;

    const spec = registered[0]?.spec;
    expect(spec?.displayText).toBe(buildWorkflowDisplayText);
    // The header must stay short whatever the prompt grows to.
    const prompt = await spec?.buildPrompt({ args: "audit auth" });
    expect((spec?.displayText as (i: { args: string }) => string)({ args: "audit auth" })).toBe("/workflow audit auth");
    expect(prompt?.length).toBeGreaterThan(1000);

    await fiber.dispose();
  });
});

// The end-to-end proof, through the code a user actually runs: the loader boots
// the native module, `native/host.ts` registers into the registry the typed-input
// dispatcher reads, and its handler resolves `displayText` before calling
// `chat.dispatch`. The chat sink here stands in for the TUI, so what it records
// is literally what `use-turn-engine.ts` puts in the bubble and feeds to
// `generateTitle`. A dropped `displayText` anywhere on that path fails here.
describe("native /workflow plugin — through the real host bridge", () => {
  const originalConfigDir = process.env.CODESURF_CONFIG_DIR;
  let configDir = "";
  let dispatched: Array<{ prompt: string; options?: ChatDispatchOptions }> = [];

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-workflow-bridge-"));
    process.env.CODESURF_CONFIG_DIR = configDir;
    __resetPluginsForTests();
    __resetNativeRuntimeForTests();
    dispatched = [];
    setChatSink((prompt, options) => {
      dispatched.push({ prompt, options });
    });
  });

  afterEach(async () => {
    setChatSink(null);
    await shutdownPlugins();
    __resetPluginsForTests();
    __resetNativeRuntimeForTests();
    if (originalConfigDir === undefined) delete process.env.CODESURF_CONFIG_DIR;
    else process.env.CODESURF_CONFIG_DIR = originalConfigDir;
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  async function runWorkflowCommand(args: string) {
    await bootstrapPlugins([createNativePluginModule(workflowOrchestratorPlugin)]);
    const command = getRegistrySnapshot().commands.find((entry) => entry.name === "/workflow");
    if (!command) throw new Error("/workflow not in the registry");
    expect(command.pluginId).toBe("builtin.commands.workflow-orchestrator");
    await command.handler({ args, services: getHostServices() });
    return command;
  }

  it("shows `/workflow <task>` in the transcript, not the 6.4KB prompt it dispatches", async () => {
    await runWorkflowCommand("  audit auth  ");

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.options).toEqual({ displayText: "/workflow audit auth" });
    // The prompt still travels in full — only the visible header is collapsed.
    expect(dispatched[0]?.prompt.length).toBe(V1_PROMPT_LENGTH_WITH_TASK);
  });

  it("shows the bare `/workflow` when the user supplies no task", async () => {
    await runWorkflowCommand("");

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.options).toEqual({ displayText: "/workflow" });
    expect(dispatched[0]?.prompt.length).toBe(V1_PROMPT_LENGTH_NO_ARGS);
  });

  it("surfaces the V1 slash-menu row — argsHint, description, no aliases, not hidden", async () => {
    const command = await runWorkflowCommand("audit auth");

    expect(command.argsHint).toBe("<task to orchestrate>");
    expect(command.description).toBe("Run a task as a multi-agent workflow (Claude Code orchestration process).");
    expect(command.aliases).toBeUndefined();
    expect(command.hidden).toBeUndefined();
    expect(command.visible).toBeUndefined();
  });

  it("is in the shipped catalog exactly once, with no V1 activate(api) entry left", async () => {
    const { loadBuiltinPlugins } = await import("../builtin/index");
    const modules = await loadBuiltinPlugins();
    const entries = modules.filter((module) => module.manifest.id === "builtin.commands.workflow-orchestrator");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.manifest.kind).toBe("builtin");
  });
});

describe("native /workflow plugin — lifecycle", () => {
  it("releases the host registration when the fiber is disposed", async () => {
    const { root, release } = bootRoot();
    const fiber = mountPlugin(root, workflowOrchestratorPlugin);
    await fiber;
    expect(release).not.toHaveBeenCalled();

    await fiber.dispose();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("remounts cleanly, registering exactly once per mount", async () => {
    const { root, registered, release } = bootRoot();

    const first = mountPlugin(root, workflowOrchestratorPlugin);
    await first;
    await first.dispose();

    const second = mountPlugin(root, workflowOrchestratorPlugin);
    await second;
    expect(registered).toHaveLength(2);
    expect(release).toHaveBeenCalledTimes(1);

    await second.dispose();
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("mounts on a root with no host bindings at all", async () => {
    const root = createCodesurfRoot();
    const fiber = mountPlugin(root, workflowOrchestratorPlugin);
    await fiber;
    expect(fiber.state).toBe(2 /* ACTIVE */);
    await fiber.dispose();
  });
});
