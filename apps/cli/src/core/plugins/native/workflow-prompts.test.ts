// Compatibility gate for the native workflow-prompts conversion.
//
// The five canned commands are the whole user-visible surface of this plugin,
// so this suite pins their identity (name, description, argsHint, aliases) and
// the exact prompt each one dispatches, plus the manifest fields that decide
// what a user sees after an upgrade. A prompt command is not visible through
// `contributions.listCommands()` (that lists `registerCommand` entries only),
// so the specs are captured through `HostBindings.registerPromptCommand` —
// the same path the real host bridge uses.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PluginManifest, PromptCommandSpec } from "@codesurf/plugin-api";
import { createCodesurfRoot, type HostBindings, mountPlugin } from "@codesurf/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildVerifyPrompt } from "../../../verify/entrypoint";
import { COMMIT_PR_PROMPT, COMMIT_PUSH_PROMPT, DREAM_PROMPT, REVIEW_PROMPT } from "../builtin/workflow-prompts-text";
import { workflowPromptsPlugin } from "./workflow-prompts";

const ID = "builtin.commands.workflows";

const originalConfigDir = process.env.CODESURF_CONFIG_DIR;
let configDir = "";
let workspaceDir = "";

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-workflow-prompts-cfg-"));
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-workflow-prompts-ws-"));
  process.env.CODESURF_CONFIG_DIR = configDir;
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.CODESURF_CONFIG_DIR;
  else process.env.CODESURF_CONFIG_DIR = originalConfigDir;
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

interface Booted {
  root: ReturnType<typeof createCodesurfRoot>;
  registered: Array<{ spec: PromptCommandSpec; manifest: PluginManifest }>;
  release: ReturnType<typeof vi.fn>;
  cwd: ReturnType<typeof vi.fn>;
  dispatched: string[];
}

function boot(overrides: Partial<HostBindings> = {}): Booted {
  const registered: Array<{ spec: PromptCommandSpec; manifest: PluginManifest }> = [];
  const release = vi.fn();
  const cwd = vi.fn(() => workspaceDir);
  const dispatched: string[] = [];
  const root = createCodesurfRoot({
    registerPromptCommand: (spec, manifest) => {
      registered.push({ spec, manifest });
      return release;
    },
    cwd,
    dispatchPrompt: async (prompt) => {
      dispatched.push(prompt);
    },
    ...overrides,
  });
  return { root, registered, release, cwd, dispatched };
}

/** What the host bridge does with a prompt command when the user runs it. */
async function invoke(spec: PromptCommandSpec, booted: Booted, args = ""): Promise<string> {
  const prompt = await spec.buildPrompt({ args });
  await booted.root.chat.dispatch(prompt);
  return prompt;
}

describe("native workflow prompts — manifest identity", () => {
  it("carries the V1 manifest fields unchanged", () => {
    const manifest = workflowPromptsPlugin.manifest;
    expect(manifest.id).toBe(ID);
    expect(manifest.name).toBe("Workflow Prompts");
    expect(manifest.version).toBe("1.0.0");
    expect(manifest.description).toBe(
      "Canned slash commands for repository-wide workflows: /review, /verify, /commit-push, /commit-pr, /dream.",
    );
    expect(manifest.enabledByDefault).toBe(true);
    expect(manifest.protected).toBe(false);
    expect(manifest.hidden).toBeUndefined();
    expect(manifest.group).toBeUndefined();
    expect(manifest.capabilities).toEqual(["commands"]);
  });
});

describe("native workflow prompts — command surface", () => {
  it("registers the five commands in the V1 order with the V1 metadata", async () => {
    const booted = boot();
    const fiber = mountPlugin(booted.root, workflowPromptsPlugin);
    await fiber;

    expect(booted.registered.map((entry) => entry.spec.name)).toEqual([
      "/review",
      "/verify",
      "/commit-push",
      "/commit-pr",
      "/dream",
    ]);
    expect(booted.registered.map((entry) => entry.spec.description)).toEqual([
      "Review uncommitted repository changes and produce a report.",
      "Verify the project locally via the verify sub-agent flow.",
      "Commit current changes and push the branch.",
      "Commit current changes, push, and open a pull request.",
      "Run an idle-time DREAMING consolidation pass.",
    ]);
    // The V1 entry declared no argsHint, aliases or hidden flag on any of them;
    // adding one would change the slash menu.
    for (const { spec, manifest } of booted.registered) {
      expect(spec.argsHint).toBeUndefined();
      expect(spec.aliases).toBeUndefined();
      // `/dream` alone is hidden: it assumes a DREAMING.md most repos lack.
      expect(spec.hidden).toBe(spec.name === "/dream" ? true : undefined);
      // The manifest travels with each registration so the host attributes all
      // five commands to the same extension id.
      expect(manifest.id).toBe(ID);
    }

    await fiber.dispose();
  });

  it("registers nothing as a plain command — every entry is a prompt command", async () => {
    const booted = boot();
    const fiber = mountPlugin(booted.root, workflowPromptsPlugin);
    await fiber;

    expect(booted.root.contributions.listCommands()).toEqual([]);
    expect(booted.root.contributions.listTools()).toEqual([]);
    expect(booted.root.contributions.listSettings()).toEqual([]);

    await fiber.dispose();
  });
});

describe("native workflow prompts — dispatched text", () => {
  it("dispatches the canned prompt body for each static command", async () => {
    const booted = boot();
    const fiber = mountPlugin(booted.root, workflowPromptsPlugin);
    await fiber;

    const byName = new Map(booted.registered.map((entry) => [entry.spec.name, entry.spec]));
    const expected: Array<[string, string]> = [
      ["/review", REVIEW_PROMPT],
      ["/commit-push", COMMIT_PUSH_PROMPT],
      ["/commit-pr", COMMIT_PR_PROMPT],
      ["/dream", DREAM_PROMPT],
    ];

    for (const [name, prompt] of expected) {
      const spec = byName.get(name);
      if (!spec) throw new Error(`${name} not registered`);
      expect(await invoke(spec, booted)).toBe(prompt);
    }

    expect(booted.dispatched).toEqual(expected.map(([, prompt]) => prompt));

    await fiber.dispose();
  });

  it("builds /verify from the agent's cwd, not process.cwd()", async () => {
    const booted = boot();
    const fiber = mountPlugin(booted.root, workflowPromptsPlugin);
    await fiber;

    const verify = booted.registered.find((entry) => entry.spec.name === "/verify")?.spec;
    if (!verify) throw new Error("/verify not registered");

    expect(booted.cwd).not.toHaveBeenCalled();
    const prompt = await invoke(verify, booted);
    // Read at invocation time, exactly as V1 did — the agent's directory can
    // drift from the process's after a `cd`.
    expect(booted.cwd).toHaveBeenCalledTimes(1);
    expect(prompt).toBe(buildVerifyPrompt(workspaceDir));
    expect(prompt).toContain("Verify this project locally.");
    expect(booted.dispatched).toEqual([prompt]);

    await fiber.dispose();
  });

  it("ignores arguments, as the V1 canned commands did", async () => {
    const booted = boot();
    const fiber = mountPlugin(booted.root, workflowPromptsPlugin);
    await fiber;

    const review = booted.registered.find((entry) => entry.spec.name === "/review")?.spec;
    if (!review) throw new Error("/review not registered");
    expect(await review.buildPrompt({ args: "anything at all" })).toBe(REVIEW_PROMPT);

    await fiber.dispose();
  });
});

describe("native workflow prompts — lifecycle", () => {
  it("releases all five host registrations when the fiber is disposed, and remounts cleanly", async () => {
    const booted = boot();
    const fiber = mountPlugin(booted.root, workflowPromptsPlugin);
    await fiber;
    expect(booted.registered).toHaveLength(5);
    expect(booted.release).not.toHaveBeenCalled();

    await fiber.dispose();
    expect(booted.release).toHaveBeenCalledTimes(5);

    const second = mountPlugin(booted.root, workflowPromptsPlugin);
    await second;
    expect(booted.registered).toHaveLength(10);
    await second.dispose();
    expect(booted.release).toHaveBeenCalledTimes(10);
  });

  it("injects only the services it uses, and mounts on a bare root", async () => {
    expect(workflowPromptsPlugin.inject).toEqual(["contributions", "workspace"]);

    const root = createCodesurfRoot();
    const fiber = mountPlugin(root, workflowPromptsPlugin);
    await fiber;
    // Both injected services are provided by every root, so a root booted with
    // no host bindings still activates the plugin (FiberState.ACTIVE === 2).
    expect(fiber.state).toBe(2);
    await fiber.dispose();
    expect(fiber.state).toBe(4);
  });
});

describe("native workflow prompts — shipped catalog", () => {
  // Importing the catalog pulls in every builtin's module graph; the default
  // 5s budget is not enough for that cold transform on a loaded machine.
  it("appears in the built-in catalog exactly once, as the native module", async () => {
    const { loadBuiltinPlugins } = await import("../builtin/index");
    const modules = await loadBuiltinPlugins();
    const entries = modules.filter((module) => module.manifest.id === ID);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.manifest.kind).toBe("builtin");
    expect(entries[0]?.manifest.name).toBe("Workflow Prompts");
    expect(entries[0]?.manifest.enabledByDefault).toBe(true);
    expect(entries[0]?.manifest.protected).toBe(false);
    expect(entries[0]?.manifest.capabilities).toEqual(["commands"]);
  }, 60_000);
});
