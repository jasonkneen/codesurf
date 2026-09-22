// The example plugin, actually mounted.
//
// The point of this file is that `hello-world.ts` is a REFERENCE — someone will
// copy it. An example that merely compiles can still be wrong: a registration
// in the wrong place, a disposer that never fires. So this mounts it on a real
// root, runs what it registers, and disposes it, which is the same treatment
// the shipped plugins get.

import type { CommandSpec, SettingSpec, ToolSpec } from "@codesurf/plugin-api";
import { createCodesurfRoot, mountPlugin } from "@codesurf/runtime";
import { describe, expect, it } from "vitest";
import { helloWorldPlugin } from "./hello-world";

function bootRoot() {
  const commands: CommandSpec[] = [];
  const tools: ToolSpec[] = [];
  const settings: SettingSpec[] = [];
  const released: string[] = [];
  const appended: string[] = [];
  const store = new Map<string, unknown>();

  const root = createCodesurfRoot({
    registerCommand: (spec) => {
      commands.push(spec);
      return () => released.push(`command:${spec.name}`);
    },
    registerTool: (spec) => {
      tools.push(spec);
      return () => released.push(`tool:${spec.name}`);
    },
    registerSetting: (spec) => {
      settings.push(spec);
      return () => released.push(`setting:${spec.key}`);
    },
    appendAssistant: (text) => appended.push(text),
    getSetting: (key, fallback) => (store.has(key) ? store.get(key) : fallback) as never,
    setSetting: (key, value) => {
      store.set(key, value);
    },
  });

  return { root, commands, tools, settings, released, appended, store };
}

describe("the hello-world example plugin", () => {
  it("registers one command, one setting and one tool", async () => {
    const h = bootRoot();
    const fiber = mountPlugin(h.root, helloWorldPlugin);
    await fiber;

    expect(h.commands.map((c) => c.name)).toEqual(["/hello"]);
    expect(h.settings.map((s) => s.key)).toEqual(["hello.defaultName"]);
    expect(h.tools.map((t) => t.name)).toEqual(["hello_greet"]);

    await fiber.dispose();
  });

  it("greets the argument, and falls back to the setting when given none", async () => {
    const h = bootRoot();
    const fiber = mountPlugin(h.root, helloWorldPlugin);
    await fiber;
    const hello = h.commands[0];

    await hello?.handler({ args: "Jason" } as never);
    expect(h.appended).toEqual(["Hello, Jason!"]);

    // No argument → the setting. Its registered default is "world".
    await hello?.handler({ args: "  " } as never);
    expect(h.appended[1]).toBe("Hello, world!");

    h.store.set("hello.defaultName", "CodeSurf");
    await hello?.handler({ args: "" } as never);
    expect(h.appended[2]).toBe("Hello, CodeSurf!");

    await fiber.dispose();
  });

  it("the tool and the command produce the same greeting", async () => {
    const h = bootRoot();
    const fiber = mountPlugin(h.root, helloWorldPlugin);
    await fiber;

    const execute = (h.tools[0]?.tool as { execute: (i: { name: string }) => Promise<{ output: string }> }).execute;
    expect((await execute({ name: "Jason" })).output).toBe("Hello, Jason!");

    await h.commands[0]?.handler({ args: "Jason" } as never);
    expect(h.appended[0]).toBe("Hello, Jason!");

    await fiber.dispose();
  });

  it("releases everything it registered on dispose", async () => {
    // This is the rule the example spends its longest comment on, so it is
    // worth proving rather than asserting in prose.
    const h = bootRoot();
    const fiber = mountPlugin(h.root, helloWorldPlugin);
    await fiber;
    expect(h.released).toEqual([]);

    await fiber.dispose();

    expect(h.released.sort()).toEqual(["command:/hello", "setting:hello.defaultName", "tool:hello_greet"]);
  });

  it("stays out of the shipped catalog", async () => {
    // An example that activates for real users is not an example.
    //
    // The generous timeout is the catalog import itself: it costs seconds,
    // which is the known startup finding (see the performance baseline), not
    // anything this test does.
    const { loadBuiltinPlugins } = await import("../builtin/index");
    const ids = (await loadBuiltinPlugins()).map((m) => m.manifest.id);
    expect(ids).not.toContain(helloWorldPlugin.manifest.id);
  }, 30_000);
});
