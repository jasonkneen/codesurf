import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCliCheckCache } from "../../../utils/cli-check-cache";
import type { ProviderConnectionContext, RegisteredModelProvider, RegisteredSetting } from "../api";
import type { PersistentStdioSessionOptions } from "../builtin/transports";

const transportMock = vi.hoisted(() => ({
  constructed: [] as PersistentStdioSessionOptions[],
}));

vi.mock("../builtin/transports", () => ({
  PersistentStdioSession: class {
    constructor(options: PersistentStdioSessionOptions) {
      transportMock.constructed.push(options);
    }
    warm(): void {}
    sendTurn(): Promise<{ usage?: undefined }> {
      return Promise.resolve({});
    }
    abortTurn(): void {}
    disconnect(): Promise<void> {
      return Promise.resolve();
    }
  },
  textContent: (text: string) => [{ type: "text", text }],
}));

import { createCodesurfRoot, mountPlugin } from "@codesurf/runtime";
import { AmpSession, ampProviderPlugin, checkAmpCredential, resolveAmpExecutable } from "./amp-provider";

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
    adapterId: "amp.cli",
    providerId: "amp",
    settings: makeSettings(store),
  };
}

describe("amp credential probe follows the configured executable", () => {
  let dir: string;
  let savedPath: string | undefined;
  let savedApiKey: string | undefined;
  let customBin: string;

  beforeEach(() => {
    clearCliCheckCache();
    transportMock.constructed.length = 0;
    dir = mkdtempSync(join(tmpdir(), "codesurf-amp-bin-"));
    savedPath = process.env.PATH;
    savedApiKey = process.env.AMP_API_KEY;
    // The default `amp` is absent from PATH; the configured one lives elsewhere.
    const emptyPathDir = join(dir, "empty-path");
    mkdirSync(emptyPathDir);
    process.env.PATH = emptyPathDir;
    process.env.AMP_API_KEY = "test-key";
    const binDir = join(dir, "custom");
    mkdirSync(binDir);
    customBin = join(binDir, "amp-custom");
    writeFileSync(customBin, "#!/bin/sh\nexit 0\n");
    chmodSync(customBin, 0o755);
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    if (savedApiKey === undefined) delete process.env.AMP_API_KEY;
    else process.env.AMP_API_KEY = savedApiKey;
    clearCliCheckCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports install-cli when the default executable is not on PATH", () => {
    expect(checkAmpCredential(makeCtx(new Map()))).toMatchObject({ ok: false, needsUserAction: "install-cli" });
  });

  it("passes the gate for a configured absolute executable outside PATH", () => {
    const store = new Map<string, unknown>([["amp.cli.bin", customBin]]);
    expect(checkAmpCredential(makeCtx(store))).toEqual({ ok: true });
  });

  it("names the configured path when it is missing", () => {
    const store = new Map<string, unknown>([["amp.cli.bin", join(dir, "nope")]]);
    expect(checkAmpCredential(makeCtx(store))).toMatchObject({
      ok: false,
      needsUserAction: "install-cli",
      reason: expect.stringContaining(join(dir, "nope")),
    });
  });

  it("runs the session from the same executable the probe resolved", () => {
    const store = new Map<string, unknown>([["amp.cli.bin", ` ${customBin} `]]);
    const ctx = makeCtx(store);
    expect(checkAmpCredential(ctx)).toEqual({ ok: true });

    new AmpSession(ctx).warm();

    expect(transportMock.constructed).toHaveLength(1);
    expect(transportMock.constructed[0]?.bin).toBe(customBin);
    expect(transportMock.constructed[0]?.bin).toBe(resolveAmpExecutable(ctx.settings));
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
    await mountPlugin(root, ampProviderPlugin);

    const provider = providers.find((item) => item.id === "amp.cli");
    if (!provider) throw new Error("amp provider was not registered");
    const store = new Map<string, unknown>([["amp.cli.bin", customBin]]);
    expect(provider.auth.check(makeCtx(store))).toEqual({ ok: true });
  });
});
