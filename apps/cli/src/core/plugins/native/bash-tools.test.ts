// Regression test for Cordis plan P1 (disposal ordering): the bash-tools
// extension must hand its `BashTool.cleanup()` promise back to the loader so
// shutdown resolves only after the owned process trees have exited.
//
// `builtin.tools.bash` is `protected`, so the only disposal path is
// `shutdownPlugins()`.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetPluginsForTests, bootstrapPlugins, getRegistrySnapshot, shutdownPlugins } from "../index";
import { bashToolsPlugin } from "./bash-tools";
import { createNativePluginModule } from "./host";

const bashMock = vi.hoisted(() => {
  let releaseCleanup: () => void = () => {};
  const cleanupDone = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  return {
    cleanup: vi.fn(() => cleanupDone),
    releaseCleanup: () => releaseCleanup(),
  };
});

vi.mock("../../../tools/bash", () => ({
  BashTool: class {
    constructor(private readonly cwd: string) {}
    getCwd() {
      return this.cwd;
    }
    cleanup() {
      return bashMock.cleanup();
    }
  },
}));

let tempDir: string;
let originalEnv: string | undefined;

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-ext-bash-tools-"));
  originalEnv = process.env.CODESURF_CONFIG_DIR;
  process.env.CODESURF_CONFIG_DIR = tempDir;
});

afterAll(() => {
  if (originalEnv === undefined) delete process.env.CODESURF_CONFIG_DIR;
  else process.env.CODESURF_CONFIG_DIR = originalEnv;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  const configFile = path.join(tempDir, "extensions.json");
  if (fs.existsSync(configFile)) fs.unlinkSync(configFile);
  __resetPluginsForTests();
});

afterEach(() => {
  __resetPluginsForTests();
});

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("bash-tools disposal", () => {
  it("keeps shutdownPlugins pending until BashTool.cleanup() resolves", async () => {
    await bootstrapPlugins([createNativePluginModule(bashToolsPlugin)]);
    expect(getRegistrySnapshot().extensions[0]).toMatchObject({ active: true, status: "active" });
    expect(bashMock.cleanup).not.toHaveBeenCalled();

    let settled = false;
    const shutdown = shutdownPlugins().then(() => {
      settled = true;
    });
    await flush();
    await flush();
    expect(bashMock.cleanup).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    bashMock.releaseCleanup();
    await shutdown;
    expect(settled).toBe(true);
    expect(bashMock.cleanup).toHaveBeenCalledTimes(1);
  });
});
