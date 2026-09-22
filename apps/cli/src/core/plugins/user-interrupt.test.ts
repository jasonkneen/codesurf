// `api.onUserInterrupt` — the host-side hook that lets extensions cancel work
// they own when the HUMAN interrupts (Esc / Agent.abort()).
//
// Turn-scoped AbortControllers do not reach extension-owned loops: a workflow
// script drives sub-agents from its own loop, so before this existed a script
// kept running (and spending tokens) after the user had stopped the turn.

import type { PluginContext } from "@codesurf/plugin-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginModule } from "./api";
import { bootstrapPlugins, fireUserInterrupt, shutdownPlugins } from "./index";
import { createNativePluginModule } from "./native/host";

function makeExtension(id: string, onInterrupt: () => void): PluginModule {
  return createNativePluginModule({
    name: id,
    inject: ["lifecycle"],
    manifest: {
      id,
      name: id,
      version: "1.0.0",
      description: "test",
      enabledByDefault: true,
      capabilities: [],
    },
    apply(ctx: PluginContext) {
      ctx.effect(() => ctx.lifecycle.onUserInterrupt(onInterrupt));
    },
  });
}

describe("lifecycle.onUserInterrupt", () => {
  beforeEach(async () => {
    await shutdownPlugins();
  });

  it("fans out to every registered handler", async () => {
    const a = vi.fn();
    const b = vi.fn();
    await bootstrapPlugins([makeExtension("test.a", a), makeExtension("test.b", b)]);

    fireUserInterrupt();

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("removes handlers on dispose so disabled extensions stop receiving interrupts", async () => {
    const handler = vi.fn();
    await bootstrapPlugins([makeExtension("test.a", handler)]);
    await shutdownPlugins();

    fireUserInterrupt();

    expect(handler).not.toHaveBeenCalled();
  });

  it("a throwing handler cannot break abort for the others", async () => {
    const good = vi.fn();
    await bootstrapPlugins([
      makeExtension("test.bad", () => {
        throw new Error("boom");
      }),
      makeExtension("test.good", good),
    ]);

    expect(() => fireUserInterrupt()).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });
});
