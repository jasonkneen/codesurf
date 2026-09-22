// Covers the mtime+size-keyed settings JSON read cache in settings.ts.
// Exercised through `loadProjectSettings` / `saveProjectSettings` because the
// project settings path is resolved per call from process.cwd(), so a chdir
// into a temp dir points the module-private readJson at a throwaway file
// without any module rewiring (USER_SETTINGS_PATH is resolved at import time).

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetSettingsReadCacheForTests, loadProjectSettings, saveProjectSettings } from "./settings";

// Spy mode: every export keeps its real implementation but records calls.
// (vi.spyOn can't patch the frozen node builtin namespace directly.)
vi.mock("fs", { spy: true });

describe("settings JSON read cache", () => {
  let tempDir: string;
  let originalCwd: string;
  let settingsPath: string;

  /** readFileSync calls that targeted the project settings file. */
  function settingsReadCount(): number {
    return vi.mocked(fs.readFileSync).mock.calls.filter(([file]) => file === settingsPath).length;
  }

  beforeEach(() => {
    originalCwd = process.cwd();
    // realpathSync: os.tmpdir() may sit behind a symlink (macOS /var ->
    // /private/var); process.cwd() reports the resolved path after chdir.
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-settings-cache-test-")));
    process.chdir(tempDir);
    settingsPath = path.join(tempDir, ".grok", "settings.json");
    __resetSettingsReadCacheForTests();
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    __resetSettingsReadCacheForTests();
  });

  function writeSettingsFile(data: unknown): void {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(data));
  }

  it("parses the file once for two consecutive loads", () => {
    writeSettingsFile({ model: "cached-model" });

    const first = loadProjectSettings();
    const second = loadProjectSettings();

    expect(first).toEqual({ model: "cached-model" });
    // Cache hit returns the same parsed object, not a re-parse.
    expect(second).toBe(first);
    expect(settingsReadCount()).toBe(1);
  });

  it("saveProjectSettings invalidates the cached read", () => {
    writeSettingsFile({ sandboxMode: "off" });
    const before = loadProjectSettings();
    expect(before.sandboxMode).toBe("off");
    const readsAfterWarmup = settingsReadCount();

    saveProjectSettings({ sandboxMode: "shuru" });
    const after = loadProjectSettings();

    expect(after.sandboxMode).toBe("shuru");
    expect(after).not.toBe(before);
    // saveProjectSettings' internal load hits the warm cache; the one extra
    // readFileSync is the post-invalidation reload.
    expect(settingsReadCount()).toBe(readsAfterWarmup + 1);
  });

  it("picks up external modifications to the file", () => {
    writeSettingsFile({ model: "before-external-edit" });
    expect(loadProjectSettings()).toEqual({ model: "before-external-edit" });

    // Same-length content on purpose: the size key alone would not change,
    // so this proves mtime participates in invalidation. Future-dated mtime
    // avoids same-millisecond flakiness.
    fs.writeFileSync(settingsPath, JSON.stringify({ model: "after--external-edit" }));
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(settingsPath, future, future);

    expect(loadProjectSettings()).toEqual({ model: "after--external-edit" });
  });

  it("returns {} for a missing file and reads the file once it appears", () => {
    expect(loadProjectSettings()).toEqual({});

    writeSettingsFile({ model: "appeared" });
    expect(loadProjectSettings()).toEqual({ model: "appeared" });
  });
});
