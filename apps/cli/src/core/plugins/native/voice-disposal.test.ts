// Regression test for Cordis plan P1 (disposal ordering): disabling the
// voice extension while a recording is live must await the recording
// handle's `cancel()` so SoX has exited and the temp WAV is gone before
// `disablePlugin` resolves.
//
// `./recording` is mocked so no `rec` subprocess is spawned. The keystroke is
// bound to `ctrl+v` so a single interceptor dispatch activates recording
// without the timing-sensitive bare-key warmup.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { InputKey } from "../api";
import { getVoiceState, resetVoiceState } from "../builtin/voice/state";
import {
  __resetPluginsForTests,
  bootstrapPlugins,
  disablePlugin,
  dispatchInputInterceptors,
  getHostServices,
  getRegistrySnapshot,
  setInputSink,
} from "../index";
import { createNativePluginModule } from "./host";
import { voicePlugin } from "./voice";

const recording = vi.hoisted(() => {
  let releaseCancel: () => void = () => {};
  const cancelDone = new Promise<void>((resolve) => {
    releaseCancel = resolve;
  });
  return {
    /** Fires when the mocked recorder actually starts, so the test can wait. */
    started: vi.fn(),
    cancel: vi.fn(() => cancelDone),
    stop: vi.fn(async () => {}),
    releaseCancel: () => releaseCancel(),
  };
});

vi.mock("../builtin/voice/recording", () => ({
  isRecAvailable: () => true,
  startRecording: async () => {
    recording.started();
    return { filePath: "/nonexistent/voice.wav", stop: recording.stop, cancel: recording.cancel };
  },
}));

let tempDir: string;
let originalConfigDir: string | undefined;
let originalHome: string | undefined;

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-ext-voice-disposal-"));
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
  const configFile = path.join(tempDir, "extensions.json");
  if (fs.existsSync(configFile)) fs.unlinkSync(configFile);
  __resetPluginsForTests();
  resetVoiceState();
  // Only the PTT release timers are faked; promises and setImmediate stay real.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  setInputSink(null);
  __resetPluginsForTests();
  resetVoiceState();
});

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("voice extension disposal", () => {
  it("awaits cancellation of a live recording before disablePlugin resolves", async () => {
    setInputSink({
      getValue: () => "",
      getCursor: () => 0,
      setValueWithCursor: () => {},
      insertText: () => {},
      clear: () => {},
      isFocused: () => true,
    });
    await bootstrapPlugins([createNativePluginModule(voicePlugin)]);
    expect(getRegistrySnapshot().extensions[0]).toMatchObject({ active: true, status: "active" });

    const services = getHostServices();
    services.settings.set("voice.keystroke", "ctrl+v");
    services.settings.set("voice.enabled", true);

    const key: InputKey = { name: "v", sequence: "\x16", ctrl: true, meta: false, shift: false };
    expect(dispatchInputInterceptors(key)).toBe(true);
    expect(getVoiceState().phase).toBe("recording");
    // Wait for the mocked `startRecording` to resolve AND for the extension to
    // store the handle; the handover crosses more microtask turns now that the
    // plugin runs inside a Cordis fiber, so a fixed flush count is fragile.
    await vi.waitFor(() => expect(recording.started).toHaveBeenCalled());
    await flush();
    await flush();
    expect(recording.cancel).not.toHaveBeenCalled();

    let settled = false;
    const disabling = disablePlugin("builtin.voice").then(() => {
      settled = true;
    });
    // Disposal now goes through a Cordis fiber, which settles over more
    // microtask turns than the V1 dispose callback did. Wait for the observable
    // effect rather than a fixed number of flushes; the ordering assertion
    // below is what this test is really about.
    await vi.waitFor(() => expect(recording.cancel).toHaveBeenCalledTimes(1));
    expect(getVoiceState().phase).toBe("idle");
    expect(settled).toBe(false);

    recording.releaseCancel();
    await disabling;
    expect(settled).toBe(true);
    expect(recording.cancel).toHaveBeenCalledTimes(1);
    expect(getRegistrySnapshot().extensions[0]).toMatchObject({ enabled: false, active: false, status: "inactive" });
  });
});
