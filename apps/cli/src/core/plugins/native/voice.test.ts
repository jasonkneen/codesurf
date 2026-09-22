// Tests for the voice extension. Focus on the pieces that are pure logic:
//   - parseKeystroke
//   - createPttHandler state machine
// Plus a smoke test that the extension activates without errors and
// registers its expected contributions (command, settings, status indicator).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { InputKey } from "../api";
import { createPttHandler, type HoldKeystroke, isBareChar, matchesKeystroke } from "../builtin/voice/ptt-handler";
import { getVoiceState, resetVoiceState } from "../builtin/voice/state";
import { __resetPluginsForTests, bootstrapPlugins, enablePlugin, getRegistrySnapshot } from "../index";
import { createNativePluginModule } from "./host";
import { parseKeystroke, voicePlugin } from "./voice";

// Redirect CODESURF_CONFIG_DIR + HOME to a temp dir for the entire suite so
// `enablePlugin` / `setVoiceState`-via-settings writes never touch the
// user's real ~/.codesurf/extensions.json. The smoke test below calls
// `enablePlugin("builtin.voice")` which persists to disk; without this
// guard the persisted `enabled` list would lock all OTHER builtins out at
// next boot (loader treats the list as authoritative). Mirrors the pattern
// in payments-tools.test.ts.
let tempDir: string;
let originalConfigDir: string | undefined;
let originalHome: string | undefined;

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-ext-voice-test-"));
  originalConfigDir = process.env.CODESURF_CONFIG_DIR;
  originalHome = process.env.HOME;
  process.env.CODESURF_CONFIG_DIR = tempDir;
  process.env.HOME = tempDir;
});

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.CODESURF_CONFIG_DIR;
  else process.env.CODESURF_CONFIG_DIR = originalConfigDir;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  // Wipe any persisted state from a prior test so each starts clean.
  const configFile = path.join(tempDir, "extensions.json");
  if (fs.existsSync(configFile)) fs.unlinkSync(configFile);
});

afterEach(() => {
  __resetPluginsForTests();
  resetVoiceState();
});

// ── parseKeystroke ────────────────────────────────────────────────────────────

describe("parseKeystroke", () => {
  it("parses bare keys", () => {
    expect(parseKeystroke("space")).toEqual({ key: "space" });
    expect(parseKeystroke("v")).toEqual({ key: "v" });
    expect(parseKeystroke("  V  ")).toEqual({ key: "v" });
  });
  it("parses modifier combos", () => {
    expect(parseKeystroke("ctrl+v")).toEqual({ key: "v", ctrl: true });
    expect(parseKeystroke("meta+space")).toEqual({ key: "space", meta: true });
    expect(parseKeystroke("CTRL+SHIFT+a")).toEqual({ key: "a", ctrl: true, shift: true });
    expect(parseKeystroke("cmd+v")).toEqual({ key: "v", meta: true });
  });
  it("rejects empty / invalid", () => {
    expect(parseKeystroke("")).toBeNull();
    expect(parseKeystroke("   ")).toBeNull();
    expect(parseKeystroke("xyz+v")).toBeNull(); // unknown modifier
  });
});

// ── isBareChar ────────────────────────────────────────────────────────────────

describe("isBareChar", () => {
  it("space is bare", () => {
    expect(isBareChar({ key: "space" })).toBe(true);
    // single-char "key" is bare; "space" is also conventionally bare
  });
  it("ctrl+v is not bare", () => {
    expect(isBareChar({ key: "v", ctrl: true })).toBe(false);
  });
});

// ── matchesKeystroke ──────────────────────────────────────────────────────────

function key(partial: Partial<InputKey> & { name: string; sequence: string }): InputKey {
  return {
    ctrl: false,
    meta: false,
    shift: false,
    ...partial,
  };
}

describe("matchesKeystroke", () => {
  it("matches bare space by name", () => {
    const ks: HoldKeystroke = { key: "space" };
    expect(matchesKeystroke(key({ name: "space", sequence: " " }), ks)).toBe(true);
  });
  it("rejects bare space when modifier held", () => {
    const ks: HoldKeystroke = { key: "space" };
    expect(matchesKeystroke(key({ name: "space", sequence: " ", ctrl: true }), ks)).toBe(false);
  });
  it("matches ctrl+v exactly", () => {
    const ks: HoldKeystroke = { key: "v", ctrl: true };
    expect(matchesKeystroke(key({ name: "v", sequence: "\\x16", ctrl: true }), ks)).toBe(true);
    expect(matchesKeystroke(key({ name: "v", sequence: "v" }), ks)).toBe(false); // no ctrl
  });
});

// ── PTT handler — bare-char hold ──────────────────────────────────────────────

describe("createPttHandler — bare-char hold", () => {
  let timers: Array<{ id: number; fn: () => void; ms: number }> = [];
  let nextId = 1;
  const setTimeoutImpl = ((fn: () => void, ms: number) => {
    const id = nextId++;
    timers.push({ id, fn, ms });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof globalThis.setTimeout;
  const clearTimeoutImpl = ((id: ReturnType<typeof setTimeout>) => {
    timers = timers.filter((t) => t.id !== (id as unknown as number));
  }) as typeof globalThis.clearTimeout;

  beforeEach(() => {
    timers = [];
    nextId = 1;
  });

  function fireTimer(predicate: (t: { ms: number }) => boolean): void {
    const t = timers.find(predicate);
    if (!t) throw new Error("no timer matched");
    timers = timers.filter((x) => x.id !== t.id);
    t.fn();
  }

  function spaceKey(): InputKey {
    return { name: "space", sequence: " ", ctrl: false, meta: false, shift: false };
  }

  it("first 2 presses flow through, after 5 it activates and strips 2", () => {
    const onActivate = vi.fn();
    const onRelease = vi.fn();
    const onWarmupTick = vi.fn();
    const onWarmupBegin = vi.fn();
    const handler = createPttHandler({
      keystroke: { key: "space" },
      callbacks: { onActivate, onRelease, onWarmupBegin, onWarmupTick },
      setTimeoutImpl,
      clearTimeoutImpl,
    });

    // Press 1 — flow through
    expect(handler.handleKey(spaceKey())).toBe(false);
    expect(onWarmupBegin).not.toHaveBeenCalled();
    expect(onWarmupTick).not.toHaveBeenCalled();
    // Press 2 — flow through
    expect(handler.handleKey(spaceKey())).toBe(false);
    expect(onWarmupBegin).not.toHaveBeenCalled();
    expect(onWarmupTick).not.toHaveBeenCalled();
    // Press 3 — swallowed (warmup ticking)
    expect(handler.handleKey(spaceKey())).toBe(true);
    expect(onWarmupBegin).toHaveBeenCalledTimes(1);
    expect(onWarmupTick).toHaveBeenLastCalledWith(3);
    // Press 4 — swallowed
    expect(handler.handleKey(spaceKey())).toBe(true);
    expect(onWarmupTick).toHaveBeenLastCalledWith(4);
    // Press 5 — ACTIVATE
    expect(handler.handleKey(spaceKey())).toBe(true);

    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledWith(2); // 2 chars leaked through
    expect(onRelease).not.toHaveBeenCalled();
    expect(handler.isActive()).toBe(true);
  });

  it("does not publish visible warmup for a quick space tap", () => {
    const onWarmupBegin = vi.fn();
    const onWarmupTick = vi.fn();
    const onWarmupAbandoned = vi.fn();
    const handler = createPttHandler({
      keystroke: { key: "space" },
      callbacks: {
        onActivate: vi.fn(),
        onRelease: vi.fn(),
        onWarmupBegin,
        onWarmupTick,
        onWarmupAbandoned,
      },
      setTimeoutImpl,
      clearTimeoutImpl,
    });

    expect(handler.handleKey(spaceKey())).toBe(false);
    expect(onWarmupBegin).not.toHaveBeenCalled();
    expect(onWarmupTick).not.toHaveBeenCalled();

    fireTimer((t) => t.ms === 120);
    expect(onWarmupAbandoned).toHaveBeenCalledTimes(1);
    expect(onWarmupBegin).not.toHaveBeenCalled();
    expect(onWarmupTick).not.toHaveBeenCalled();
  });

  it("release fires after RELEASE_TIMEOUT_MS gap with no presses", () => {
    const onRelease = vi.fn();
    const handler = createPttHandler({
      keystroke: { key: "space" },
      callbacks: { onActivate: vi.fn(), onRelease },
      setTimeoutImpl,
      clearTimeoutImpl,
    });
    // Activate
    for (let i = 0; i < 5; i++) handler.handleKey(spaceKey());
    expect(handler.isActive()).toBe(true);

    // Find the release timer (250ms) and fire it
    fireTimer((t) => t.ms === 250);
    expect(onRelease).toHaveBeenCalledTimes(1);
    expect(handler.isActive()).toBe(false);
  });

  it("warmup abandoned timer fires and resets state", () => {
    const onWarmupAbandoned = vi.fn();
    const handler = createPttHandler({
      keystroke: { key: "space" },
      callbacks: { onActivate: vi.fn(), onRelease: vi.fn(), onWarmupAbandoned },
      setTimeoutImpl,
      clearTimeoutImpl,
    });
    handler.handleKey(spaceKey());
    handler.handleKey(spaceKey());
    // Fire the 120ms warmup-reset timer
    fireTimer((t) => t.ms === 120);
    expect(onWarmupAbandoned).toHaveBeenCalledTimes(1);
  });

  it("non-matching key during warmup abandons", () => {
    const onWarmupAbandoned = vi.fn();
    const handler = createPttHandler({
      keystroke: { key: "space" },
      callbacks: { onActivate: vi.fn(), onRelease: vi.fn(), onWarmupAbandoned },
      setTimeoutImpl,
      clearTimeoutImpl,
    });
    handler.handleKey(spaceKey());
    // Hit a different key
    expect(handler.handleKey({ name: "a", sequence: "a", ctrl: false, meta: false, shift: false })).toBe(false);
    expect(onWarmupAbandoned).toHaveBeenCalledTimes(1);
  });
});

// ── PTT handler — modifier combo ──────────────────────────────────────────────

describe("createPttHandler — modifier combo activates on first press", () => {
  let timers: Array<{ id: number; fn: () => void; ms: number }> = [];
  let nextId = 1;
  const setTimeoutImpl = ((fn: () => void, ms: number) => {
    const id = nextId++;
    timers.push({ id, fn, ms });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof globalThis.setTimeout;
  const clearTimeoutImpl = ((id: ReturnType<typeof setTimeout>) => {
    timers = timers.filter((t) => t.id !== (id as unknown as number));
  }) as typeof globalThis.clearTimeout;

  beforeEach(() => {
    timers = [];
    nextId = 1;
  });

  it("ctrl+v activates immediately, no warmup", () => {
    const onActivate = vi.fn();
    const onWarmupBegin = vi.fn();
    const handler = createPttHandler({
      keystroke: { key: "v", ctrl: true },
      callbacks: { onActivate, onRelease: vi.fn(), onWarmupBegin },
      setTimeoutImpl,
      clearTimeoutImpl,
    });
    const ctrlV: InputKey = {
      name: "v",
      sequence: "\\x16",
      ctrl: true,
      meta: false,
      shift: false,
    };
    expect(handler.handleKey(ctrlV)).toBe(true);
    expect(onActivate).toHaveBeenCalledWith(0); // no flow-through for combos
    expect(onWarmupBegin).not.toHaveBeenCalled();
    expect(handler.isActive()).toBe(true);
  });
});

// ── Extension smoke test ─────────────────────────────────────────────────────

describe("voice extension activation", () => {
  it("registers /voice command, 3 settings, and a status indicator", async () => {
    await bootstrapPlugins([createNativePluginModule(voicePlugin)]);
    // Force-enable in case a persisted enabled-set from a previous run
    // omits this extension (loader treats persisted lists as authoritative,
    // ignoring enabledByDefault — see loader.ts bootstrapPlugins).
    await enablePlugin("builtin.voice");
    // Activation is fire-and-forget inside bootstrap (Promise.resolve(activate)) —
    // flush the microtask queue so contributions land before we read the snapshot.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const snap = getRegistrySnapshot();

    const cmds = snap.commands.filter((c) => c.pluginId === "builtin.voice");
    expect(cmds.map((c) => c.name)).toEqual(["/voice"]);

    const settings = snap.settings.filter((s) => s.pluginId === "builtin.voice");
    expect(settings.map((s) => s.key).sort()).toEqual(["voice.enabled", "voice.keystroke", "voice.language"]);

    const indicators = snap.statusIndicators.filter((i) => i.pluginId === "builtin.voice");
    expect(indicators.map((i) => i.id)).toEqual(["voice.status"]);
  });

  it("starts disabled by default", () => {
    expect(getVoiceState().phase).toBe("idle");
  });
});
