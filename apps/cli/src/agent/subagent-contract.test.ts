// Contract tests for the sub-agent surface.
//
// These pin the three things that silently drifted or broke before:
//   1. the mode prompts must not re-enumerate tool schemas (they drifted from
//      the registry and cost ~1k tokens/turn),
//   2. the delegation guidance must distinguish `task` (foreground, answer now)
//      from `delegate` (background, answer later),
//   3. ToolSet building must honour an EXPLICITLY passed mode rather than the
//      module-global kernel mode, which concurrent sub-agent builds race on.

import { beforeEach, describe, expect, it } from "vitest";
import { bootstrapPlugins, getEnabledToolSet, setKernelMode, shutdownPlugins } from "../core/plugins";
import { createNativePluginModule } from "../core/plugins/native/host";
import { subagentsToolsPlugin } from "../core/plugins/native/subagents-tools";
import { MODE_PROMPTS } from "./mode-prompts";

describe("mode prompts do not duplicate the tool registry", () => {
  it("no mode prompt re-enumerates tool schemas as a `- name:` catalog", () => {
    // The ai-sdk already sends name + description + JSON schema for every tool.
    // A hand-written second copy drifts (it once listed 4 of 7 `task` agents and
    // omitted 9 registered tools entirely) and is pure duplicate context.
    const catalogLine = /^- [a-z_]+: /m;
    for (const [mode, prompt] of Object.entries(MODE_PROMPTS)) {
      expect(catalogLine.test(prompt), `${mode} prompt still contains a hand-written tool catalog`).toBe(false);
    }
  });

  it("agent prompt stays under the size a catalog would push it past", () => {
    // Guards against the catalog creeping back in. Was 8,509 chars.
    expect(MODE_PROMPTS.agent.length).toBeLessThan(6_000);
  });
});

describe("delegation guidance", () => {
  const prompt = MODE_PROMPTS.agent;

  it("states that delegate's result is not available in the current turn", () => {
    expect(prompt).toMatch(/delegate/i);
    expect(prompt).toMatch(/NOT exist in this turn|later turn/i);
  });

  it("uses explicit task(...) / delegate(...) call forms in examples, not a bare verb", () => {
    // "delegate to explore first" was ambiguous between the `delegate` TOOL
    // (background, explore-only, agent-mode-only) and the generic verb. A model
    // that picked the tool could not answer in the same turn.
    const examples = prompt.slice(prompt.indexOf("EXAMPLES:"));
    expect(examples).toMatch(/task\(explore\)/);
    expect(examples).not.toMatch(/-> delegate to explore first/);
  });

  it("forbids reporting findings that have not arrived", () => {
    expect(prompt).toMatch(/FINDINGS/);
  });
});

describe("ToolSet building honours an explicit mode", () => {
  beforeEach(async () => {
    await shutdownPlugins();
    setKernelMode(null);
  });

  it("uses the passed mode, not the module global", async () => {
    await bootstrapPlugins([createNativePluginModule(subagentsToolsPlugin)]);

    // Global says agent; the explicit argument must win. Concurrent sub-agent
    // builds interleave across the MCP await, so a sibling leaving the global
    // at its own mode used to strip this child's tools mid-build.
    setKernelMode("agent");
    expect(Object.keys(getEnabledToolSet("plan"))).toEqual(["task"]);
    expect(Object.keys(getEnabledToolSet("ask"))).toEqual(["task"]);

    setKernelMode("plan");
    expect(Object.keys(getEnabledToolSet("agent")).sort()).toEqual(
      ["delegate", "delegation_list", "delegation_read", "task"].sort(),
    );
  });

  it("falls back to the global when no mode is passed", async () => {
    await bootstrapPlugins([createNativePluginModule(subagentsToolsPlugin)]);
    setKernelMode("plan");
    expect(Object.keys(getEnabledToolSet())).toEqual(["task"]);
  });
});
