// The smallest useful CodeSurf plugin — the one to copy.
//
// It lives inside `src/` on purpose. An example under `examples/` would not be
// compiled or tested, and would drift from the real API within a release; this
// one is typechecked by the normal build and mounted by `hello-world.test.ts`,
// so it cannot silently rot.
//
// It is NOT in the catalog (`builtin/index.ts`), so it never activates. To try
// it, add `createNativePluginModule(helloWorldPlugin)` there and enable it in
// /plugins.
//
// The whole plugin surface hangs off `ctx`. This file imports exactly one
// package — `@codesurf/plugin-api` — and never host code. That direction is
// enforced by a test (`packages/plugin-api/src/boundaries.test.ts`), not by
// convention.

import type { CodesurfPlugin, PluginContext, PluginManifest } from "@codesurf/plugin-api";
import { tool } from "ai";
import { z } from "zod";

const manifest: PluginManifest = {
  // Stable forever. This id keys the user's enable/disable preference in
  // ~/.codesurf/plugins.json, so renaming it silently resets their choice —
  // that is not hypothetical, an id rename left a real opt-out dead for four
  // months.
  id: "example.hello-world",
  name: "Hello World",
  version: "1.0.0",
  description: "A minimal plugin: one command, one setting, one tool.",
  enabledByDefault: false,
  capabilities: ["commands", "settings", "tools"],
};

export const helloWorldPlugin: CodesurfPlugin = {
  name: "codesurf-hello-world",
  manifest,

  // Declare the services you use. A plugin naming a service the host has not
  // provided stays PENDING instead of crashing, and activates if that service
  // later appears.
  inject: ["contributions", "chat", "settings"],

  apply(ctx: PluginContext) {
    // ── Rule 1: every registration goes inside ctx.effect ──────────────────
    //
    // What the callback RETURNS is the disposer. Cordis runs it when the plugin
    // is disabled or the app shuts down, and that is the only thing that
    // removes your contribution — the host does not sweep up after you.
    //
    // `registerCommand` already returns a disposer, so returning its result is
    // the entire pattern.
    ctx.effect(() =>
      ctx.contributions.registerCommand({
        name: "/hello",
        description: "Say hello.",
        argsHint: "[name]",
        handler: ({ args }) => {
          const who = args.trim() || ctx.settings.get<string>("hello.defaultName", "world") || "world";
          ctx.chat.appendAssistant(greeting(who));
        },
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: "hello.defaultName",
        title: "Default name",
        description: "Who /hello greets when given no argument.",
        type: "string",
        default: "world",
        section: "Examples",
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerTool({
        name: "hello_greet",
        description: "Return a greeting for a name.",
        group: "examples",
        tool: tool({
          description: "Return a greeting for a name.",
          inputSchema: z.object({ name: z.string() }),
          execute: async ({ name }) => ({ success: true, output: greeting(name) }),
        }),
      }),
    );

    // ── Rule 2: a disposer you already hold is RETURNED, not wrapped ───────
    //
    //     ctx.effect(() => existingDisposer);         // correct
    //     ctx.effect(() => () => existingDisposer);   // LEAKS: the disposer
    //                                                 // names it, never calls it
    //
    // The second form typechecks and looks right. It shipped twelve times
    // during the Cordis migration and nothing behavioural caught it — only a
    // test counting live subscriptions did.
    //
    // To run cleanup of your own, return a function that DOES the work:
    ctx.effect(() => () => {
      // Runs on disable and on shutdown. Drop timers, caches, listeners here.
    });

    // ── Rule 3: never pass a ctx method as a bare reference ────────────────
    //
    // Services are classes, so `someHelper(ctx.settings.get)` loses its
    // receiver and throws on the first `this` read. Wrap it instead:
    //
    //     const get = <T,>(k: string, d?: T) => ctx.settings.get<T>(k, d);
    //     someHelper(get);
  },
};

/** Kept module-level so the command and the tool cannot drift apart. */
function greeting(name: string): string {
  return `Hello, ${name}!`;
}
