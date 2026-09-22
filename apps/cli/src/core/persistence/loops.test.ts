import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createLoopManager } from "../plugins/loops";
import { loadPersistedLoops, savePersistedLoops } from "./loops";

let configDir: string;
let originalConfigDir: string | undefined;

beforeAll(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-loops-config-"));
  originalConfigDir = process.env.CODESURF_CONFIG_DIR;
  process.env.CODESURF_CONFIG_DIR = configDir;
});

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.CODESURF_CONFIG_DIR;
  else process.env.CODESURF_CONFIG_DIR = originalConfigDir;
  fs.rmSync(configDir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(configDir, "loops.json"), { force: true });
});

const store = { load: loadPersistedLoops, save: savePersistedLoops };

describe("loop persistence", () => {
  it("returns an empty list when no file exists", () => {
    expect(loadPersistedLoops()).toEqual([]);
  });

  it("round-trips loop state through the store", () => {
    const first = createLoopManager(store);
    first.start("alpha", 5, "Ship the thing");
    first.record("alpha", { status: "passed", summary: "iteration one" });

    const second = createLoopManager(store);
    const restored = second.get("alpha");
    expect(restored?.spec.goal).toBe("Ship the thing");
    expect(restored?.history).toHaveLength(1);
    expect(restored?.currentIteration).toBe(1);
  });

  it("rehydrates a running loop as stopped (restart = implicit interrupt)", () => {
    const first = createLoopManager(store);
    first.start("alpha", 5, "goal");
    expect(first.get("alpha")?.status).toBe("running");

    const second = createLoopManager(store);
    const restored = second.get("alpha");
    expect(restored?.status).toBe("stopped");
    expect(restored?.lastMessage).toContain("resume with /loop alpha");

    // Resuming keeps history and iteration (start() resume semantics).
    const resumed = second.start("alpha");
    expect(resumed.message).toContain("resumed");
    expect(resumed.state.currentIteration).toBe(1);
  });

  it("persists every mutating operation", () => {
    const manager = createLoopManager(store);
    manager.start("alpha", 5, "goal");
    manager.record("alpha", { status: "passed" });
    manager.stop("alpha");
    const onDisk = loadPersistedLoops();
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0]?.status).toBe("stopped");
    expect(onDisk[0]?.history).toHaveLength(1);
  });

  it("survives a corrupt file by starting fresh", () => {
    fs.writeFileSync(path.join(configDir, "loops.json"), "{not json", "utf-8");
    expect(loadPersistedLoops()).toEqual([]);
    const manager = createLoopManager(store);
    expect(manager.list()).toEqual([]);
  });

  it("drops malformed loop entries on load", () => {
    fs.writeFileSync(
      path.join(configDir, "loops.json"),
      JSON.stringify({ version: 1, loops: [{ bogus: true }, null, 42] }),
      "utf-8",
    );
    expect(loadPersistedLoops()).toEqual([]);
  });
});
