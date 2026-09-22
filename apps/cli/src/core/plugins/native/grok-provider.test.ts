import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCliCheckCache } from "../../../utils/cli-check-cache";
import type { ProviderConnectionContext, RegisteredModelProvider, RegisteredSetting } from "../api";
import type { OneshotTurnOptions } from "../builtin/transports";

const transportMock = vi.hoisted(() => ({
  runs: [] as OneshotTurnOptions[],
}));

vi.mock("../builtin/transports", () => ({
  runOneshotStreamJsonTurn: async (options: OneshotTurnOptions) => {
    transportMock.runs.push(options);
    return {};
  },
}));

import { createCodesurfRoot, mountPlugin } from "@codesurf/runtime";
import { checkGrokCredential, GrokCliSession, grokCliProviderPlugin, resolveGrokExecutable } from "./grok-provider";

function makeSettings(store: Map<string, unknown>): ProviderConnectionContext["settings"] {
  return {
    get: <T>(key: string, fallback?: T): T | undefined => (store.has(key) ? (store.get(key) as T) : fallback),
    set: (key: string, value: unknown) => {
      store.set(key, value);
    },
    list: () => [] as RegisteredSetting[],
    subscribe: () => () => {},
  } as unknown as ProviderConnectionContext["settings"];
}

function makeCtx(store: Map<string, unknown>): ProviderConnectionContext {
  return {
    conversationId: "conv-1",
    adapterId: "grok.cli",
    providerId: "grok-cli",
    settings: makeSettings(store),
  };
}

describe("grok credential probe follows the configured executable", () => {
  let dir: string;
  let savedPath: string | undefined;
  let customBin: string;

  beforeEach(() => {
    clearCliCheckCache();
    transportMock.runs.length = 0;
    dir = mkdtempSync(join(tmpdir(), "codesurf-grok-bin-"));
    savedPath = process.env.PATH;
    // The default `grok` is absent from PATH; the configured one lives elsewhere.
    const emptyPathDir = join(dir, "empty-path");
    mkdirSync(emptyPathDir);
    process.env.PATH = emptyPathDir;
    const binDir = join(dir, "custom");
    mkdirSync(binDir);
    customBin = join(binDir, "grok-custom");
    writeFileSync(customBin, "#!/bin/sh\nexit 0\n");
    chmodSync(customBin, 0o755);
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    clearCliCheckCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports install-cli when the default executable is not on PATH", () => {
    expect(checkGrokCredential(makeCtx(new Map()))).toMatchObject({ ok: false, needsUserAction: "install-cli" });
  });

  it("passes the gate for a configured absolute executable outside PATH", () => {
    const store = new Map<string, unknown>([["grok.cli.bin", customBin]]);
    expect(checkGrokCredential(makeCtx(store))).toEqual({ ok: true });
  });

  it("names the configured path when it is missing", () => {
    const store = new Map<string, unknown>([["grok.cli.bin", join(dir, "nope")]]);
    expect(checkGrokCredential(makeCtx(store))).toMatchObject({
      ok: false,
      needsUserAction: "install-cli",
      reason: expect.stringContaining(join(dir, "nope")),
    });
  });

  it("runs the turn from the same executable the probe resolved", async () => {
    const store = new Map<string, unknown>([["grok.cli.bin", ` ${customBin} `]]);
    const ctx = makeCtx(store);
    expect(checkGrokCredential(ctx)).toEqual({ ok: true });

    const session = new GrokCliSession(ctx);
    await session.sendTurn(
      {
        conversationId: "conv-1",
        providerId: "grok-cli",
        adapterId: "grok.cli",
        modelId: "grok-4.5",
        prompt: "hello",
        messages: [],
      },
      { emit: () => {} },
    );

    expect(transportMock.runs).toHaveLength(1);
    expect(transportMock.runs[0]?.bin).toBe(customBin);
    expect(transportMock.runs[0]?.bin).toBe(resolveGrokExecutable(ctx.settings));
  });

  it("wires the registered auth check through the same resolver", async () => {
    const providers: RegisteredModelProvider[] = [];
    // A native plugin has no `activate`; mount it on a real root whose
    // bindings record what it registers.
    const root = createCodesurfRoot({
      registerSetting: () => () => {},
      registerModelProvider: (spec: unknown) => {
        providers.push(spec as unknown as RegisteredModelProvider);
        return () => {};
      },
    });
    await mountPlugin(root, grokCliProviderPlugin);

    const provider = providers.find((item) => item.id === "grok.cli");
    if (!provider) throw new Error("grok provider was not registered");
    const store = new Map<string, unknown>([["grok.cli.bin", customBin]]);
    expect(provider.auth.check(makeCtx(store))).toEqual({ ok: true });
  });
});
