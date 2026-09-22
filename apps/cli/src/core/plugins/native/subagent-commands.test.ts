// Parity acceptance for the converted custom-subagents plugin.
//
// The V1 builtin registered a command resolver that turned
// `/<custom-agent-name> <prompt>` into a `task` delegation. This suite mounts
// the native plugin on a root built from `createCodesurfRoot()` with fake
// `HostBindings` and asserts the things a user would notice if the conversion
// drifted: the manifest identity, the synthesized command name/description,
// the usage text, the dispatch prompt, the reserved-name guard, the
// longest-prefix match, and that disposing the fiber removes the resolver.

import type { CommandResolverSpec, CommandSpec, CustomSubagentInfo, PluginManifest } from "@codesurf/plugin-api";
import { type Context, createCodesurfRoot, type HostBindings, mountPlugin } from "@codesurf/runtime";
import { describe, expect, it, vi } from "vitest";
import { buildSubagentDispatchPrompt, parseSubagentInput, subagentCommandsPlugin } from "./subagent-commands";

function agent(name: string): CustomSubagentInfo {
  return { name, model: "grok-4", instruction: `you are ${name}` };
}

function staticCommand(name: string, aliases?: string[]): CommandSpec {
  return { name, description: `static ${name}`, aliases, handler: () => {} };
}

interface Harness {
  root: Context;
  appended: string[];
  dispatched: string[];
  resolvers: Array<{ spec: CommandResolverSpec; manifest: PluginManifest }>;
  release: ReturnType<typeof vi.fn>;
  /** Swap the configured subagents mid-test, as the Settings UI would. */
  setAgents: (next: CustomSubagentInfo[]) => void;
}

function bootRoot(agents: CustomSubagentInfo[] = [], staticCommands: CommandSpec[] = []): Harness {
  const appended: string[] = [];
  const dispatched: string[] = [];
  const resolvers: Harness["resolvers"] = [];
  const release = vi.fn();
  // Held in the closure, not captured by value: the plugin re-reads
  // `listCustom()` per call, so a later `setAgents` must be visible to it.
  let configured = agents;
  const bindings: HostBindings = {
    appendAssistant: (text) => appended.push(text),
    dispatchPrompt: async (prompt) => {
      dispatched.push(prompt);
    },
    listCommands: () => staticCommands,
    listCustomSubagents: () => configured,
    registerCommandResolver: (spec, manifest) => {
      resolvers.push({ spec, manifest });
      return release;
    },
  };
  return {
    root: createCodesurfRoot(bindings),
    appended,
    dispatched,
    resolvers,
    release,
    setAgents: (next) => {
      configured = next;
    },
  };
}

describe("native custom-subagents plugin — identity", () => {
  it("carries the V1 manifest unchanged", () => {
    const { manifest } = subagentCommandsPlugin;
    expect(manifest.id).toBe("builtin.commands.subagents");
    expect(manifest.name).toBe("Custom Subagents");
    expect(manifest.version).toBe("1.0.0");
    expect(manifest.description).toBe(
      "Routes `/<custom-agent-name> <prompt>` slash commands to user-defined subagents from `~/.codesurf/user-settings.json`.",
    );
    expect(manifest.enabledByDefault).toBe(true);
    expect(manifest.protected).toBe(false);
    expect(manifest.hidden).toBeUndefined();
    expect(manifest.group).toBeUndefined();
    expect(manifest.capabilities).toEqual(["commands"]);
  });

  it("registers a single resolver, labelled as the V1 one was", async () => {
    const { root, resolvers } = bootRoot();
    const fiber = mountPlugin(root, subagentCommandsPlugin);
    await fiber;

    expect(resolvers).toHaveLength(1);
    expect(resolvers[0]?.spec.label).toBe("Custom subagents");
    // Registrations are attributed to the plugin, so the registry counts the
    // resolver against the same extension id the V1 entry used.
    expect(resolvers[0]?.manifest.id).toBe("builtin.commands.subagents");
    // The resolver is the plugin's only contribution: no static commands.
    expect(root.contributions.listCommands()).toEqual([]);

    await fiber.dispose();
  });

  it("removes the resolver when the fiber is disposed", async () => {
    const { root, release } = bootRoot();
    const fiber = mountPlugin(root, subagentCommandsPlugin);
    await fiber;
    expect(release).not.toHaveBeenCalled();

    await fiber.dispose();
    expect(release).toHaveBeenCalledTimes(1);

    // Remount is repeatable and re-registers exactly once.
    const second = mountPlugin(root, subagentCommandsPlugin);
    await second;
    expect(release).toHaveBeenCalledTimes(1);
    await second.dispose();
    expect(release).toHaveBeenCalledTimes(2);
  });
});

describe("native custom-subagents plugin — resolve", () => {
  async function mounted(agents: CustomSubagentInfo[] = [], staticCommands: CommandSpec[] = []) {
    const harness = bootRoot(agents, staticCommands);
    const fiber = mountPlugin(harness.root, subagentCommandsPlugin);
    await fiber;
    const spec = harness.resolvers[0]?.spec;
    if (!spec) throw new Error("resolver not registered");
    return { ...harness, fiber, spec };
  }

  it("synthesizes the command a matched subagent produces", async () => {
    const { spec, fiber } = await mounted([agent("reviewer")]);

    const match = spec.resolve("/reviewer check the latest diff");
    expect(match).not.toBeNull();
    expect(match?.command.name).toBe("/reviewer");
    expect(match?.command.description).toBe("Custom subagent: reviewer");
    expect(match?.command.argsHint).toBeUndefined();
    expect(match?.command.aliases).toBeUndefined();
    expect(match?.args).toBe("check the latest diff");

    await fiber.dispose();
  });

  it("dispatches the V1 delegation prompt verbatim", async () => {
    const { spec, dispatched, appended, fiber } = await mounted([agent("reviewer")]);

    await spec.resolve("/reviewer check the latest diff")?.command.handler({ args: "check the latest diff" });
    expect(appended).toEqual([]);
    expect(dispatched).toEqual([
      [
        'Use the custom sub-agent "reviewer" for this task.',
        "",
        "Delegate the work with the `task` tool using:",
        '- `agent`: "reviewer"',
        "- `description`: a short summary of the work",
        "- `prompt`: a detailed prompt based on the user's request",
        "",
        "User request:",
        "check the latest diff",
      ].join("\n"),
    ]);
    // The exported builder and the handler agree.
    expect(dispatched[0]).toBe(buildSubagentDispatchPrompt("reviewer", "check the latest diff"));

    await fiber.dispose();
  });

  it("prints usage instead of dispatching when no task follows the name", async () => {
    const { spec, dispatched, appended, fiber } = await mounted([agent("reviewer")]);

    await spec.resolve("/reviewer")?.command.handler({ args: "" });
    expect(dispatched).toEqual([]);
    expect(appended).toEqual(["Usage: /reviewer <task>\nExample: /reviewer review the latest changes"]);

    await fiber.dispose();
  });

  it("matches multi-word names longest-first and preserves the original casing", async () => {
    const { spec, fiber } = await mounted([agent("Code Review"), agent("Code Review Deep")]);

    const shallow = spec.resolve("/code review the parser");
    expect(shallow?.command.name).toBe("/Code Review");
    expect(shallow?.args).toBe("the parser");

    const deep = spec.resolve("/Code Review Deep the parser");
    expect(deep?.command.name).toBe("/Code Review Deep");
    expect(deep?.args).toBe("the parser");

    await fiber.dispose();
  });

  it("never shadows a registered command name or alias", async () => {
    const { spec, fiber } = await mounted(
      [agent("context"), agent("quit")],
      [staticCommand("/context"), staticCommand("/exit", ["/quit"])],
    );

    expect(spec.resolve("/context compact")).toBeNull();
    expect(spec.resolve("/quit now")).toBeNull();

    await fiber.dispose();
  });

  it("returns null for non-matching input", async () => {
    const { spec, fiber } = await mounted([agent("reviewer")]);

    expect(spec.resolve("reviewer check")).toBeNull();
    expect(spec.resolve("/")).toBeNull();
    expect(spec.resolve("   ")).toBeNull();
    expect(spec.resolve("/unknown thing")).toBeNull();
    // A prefix that is not followed by a space is not a match.
    expect(spec.resolve("/reviewers thing")).toBeNull();

    await fiber.dispose();
  });

  it("re-reads the subagent list on every resolve", async () => {
    const { spec, fiber, setAgents } = await mounted();
    expect(spec.resolve("/reviewer go")).toBeNull();

    setAgents([agent("reviewer")]);
    expect(spec.resolve("/reviewer go")?.command.name).toBe("/reviewer");

    await fiber.dispose();
  });
});

describe("native custom-subagents plugin — enumerate", () => {
  async function mounted(agents: CustomSubagentInfo[] = [], staticCommands: CommandSpec[] = []) {
    const harness = bootRoot(agents, staticCommands);
    const fiber = mountPlugin(harness.root, subagentCommandsPlugin);
    await fiber;
    const spec = harness.resolvers[0]?.spec;
    if (!spec) throw new Error("resolver not registered");
    return { ...harness, fiber, spec };
  }

  it("lists every subagent for the slash menu", async () => {
    const { spec, fiber } = await mounted([agent("reviewer"), agent("Code Review")]);

    const listed = spec.enumerate?.() ?? [];
    expect(listed.map((c) => c.name)).toEqual(["/reviewer", "/Code Review"]);
    expect(listed.map((c) => c.description)).toEqual(["Custom subagent: reviewer", "Custom subagent: Code Review"]);

    await fiber.dispose();
  });

  it("drops subagents whose first token collides with a static command", async () => {
    const { spec, fiber } = await mounted([agent("context deep"), agent("reviewer")], [staticCommand("/context")]);

    expect((spec.enumerate?.() ?? []).map((c) => c.name)).toEqual(["/reviewer"]);

    await fiber.dispose();
  });

  it("gives enumerated entries an empty prompt, so invoking one prints usage", async () => {
    const { spec, appended, dispatched, fiber } = await mounted([agent("reviewer")]);

    await spec.enumerate?.()[0]?.handler({ args: "" });
    expect(dispatched).toEqual([]);
    expect(appended).toEqual(["Usage: /reviewer <task>\nExample: /reviewer review the latest changes"]);

    await fiber.dispose();
  });
});

describe("parseSubagentInput", () => {
  const reserved = new Set(["/context", "/quit"]);

  it("keeps the V1 matching rules", () => {
    const agents = [agent("reviewer"), agent("Code Review")];
    expect(parseSubagentInput("  /reviewer  do it  ", agents, reserved)).toEqual({
      agentName: "reviewer",
      prompt: "do it",
    });
    expect(parseSubagentInput("/REVIEWER do it", agents, reserved)).toEqual({
      agentName: "reviewer",
      prompt: "do it",
    });
    expect(parseSubagentInput("/reviewer", agents, reserved)).toEqual({ agentName: "reviewer", prompt: "" });
    expect(parseSubagentInput("/context anything", [agent("context")], reserved)).toBeNull();
    expect(parseSubagentInput("hello", agents, reserved)).toBeNull();
    expect(parseSubagentInput("/", agents, reserved)).toBeNull();
    expect(parseSubagentInput("/nobody home", agents, reserved)).toBeNull();
  });
});
