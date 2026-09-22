import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TileState, TileStateStore } from "./tile-state";

describe("TileStateStore", () => {
  let tempDir: string;
  let store: TileStateStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tile-state-test-"));
    store = new TileStateStore(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("should create and save tile state", () => {
    const cardId = "test-tile-1";
    const state: TileState = {
      cardId,
      model: "claude-opus-4-6",
      mode: "agent",
      cwdAtStart: "/home/user",
      cwdLast: "/home/user/project",
      task: "Building feature X",
      peerStatus: "working",
      files: ["src/app.ts", "src/utils.ts"],
      daemonSessionId: "daemon-123",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    store.saveState(cardId, state);

    const loaded = store.loadState(cardId);
    expect(loaded).not.toBeNull();
    expect(loaded?.task).toBe("Building feature X");
    expect(loaded?.model).toBe("claude-opus-4-6");
  });

  it("should update partial state", () => {
    const cardId = "test-tile-2";
    store.updateState(cardId, {
      model: "claude-sonnet-4-6",
      task: "Initial task",
    });

    const state1 = store.loadState(cardId);
    expect(state1?.model).toBe("claude-sonnet-4-6");
    expect(state1?.task).toBe("Initial task");

    // Update only task
    store.updateState(cardId, {
      task: "Updated task",
    });

    const state2 = store.loadState(cardId);
    expect(state2?.model).toBe("claude-sonnet-4-6"); // Unchanged
    expect(state2?.task).toBe("Updated task"); // Changed
  });

  it("should set peer status", () => {
    const cardId = "test-tile-3";
    store.setPeerStatus(cardId, "working", "Task description", ["file1.ts"]);

    const state = store.loadState(cardId);
    expect(state?.peerStatus).toBe("working");
    expect(state?.task).toBe("Task description");
    expect(state?.files).toContain("file1.ts");
  });

  it("setPeerStatus preserves task and files when they are omitted (S1)", () => {
    const cardId = "peer-omitted";
    store.setPeerStatus(cardId, "working", "Task description", ["file1.ts", "file2.ts"]);

    store.setPeerStatus(cardId, "done");

    const state = store.loadState(cardId);
    expect(state?.peerStatus).toBe("done");
    expect(state?.task).toBe("Task description");
    expect(state?.files).toEqual(["file1.ts", "file2.ts"]);
    // The fields survive serialization rather than being dropped from the JSON.
    const raw = JSON.parse(fs.readFileSync(path.join(tempDir, `tile-${cardId}`, "state.json"), "utf8"));
    expect(Object.keys(raw)).toEqual(expect.arrayContaining(["task", "files"]));
  });

  it("setPeerStatus clears task and files when given explicit null / empty values", () => {
    const cardId = "peer-cleared";
    store.setPeerStatus(cardId, "working", "Task description", ["file1.ts"]);

    store.setPeerStatus(cardId, "idle", null, []);
    let state = store.loadState(cardId);
    expect(state?.task).toBeNull();
    expect(state?.files).toEqual([]);

    store.setPeerStatus(cardId, "working", "Second task", ["file2.ts"]);
    store.setPeerStatus(cardId, "done", "");
    state = store.loadState(cardId);
    expect(state?.task).toBe("");
    expect(state?.files).toEqual(["file2.ts"]);
  });

  it("updateState ignores keys whose value is explicitly undefined", () => {
    const cardId = "update-undefined";
    store.updateState(cardId, { task: "keep me", files: ["a.ts"], daemonSessionId: "d1" });

    store.updateState(cardId, { task: undefined, files: undefined, model: "claude-sonnet-4-6" });

    const state = store.loadState(cardId);
    expect(state?.task).toBe("keep me");
    expect(state?.files).toEqual(["a.ts"]);
    expect(state?.daemonSessionId).toBe("d1");
    expect(state?.model).toBe("claude-sonnet-4-6");
  });

  it("should find latest tile", () => {
    store.updateState("tile-a", { task: "Task A" });
    // Add slight delay to ensure different timestamps
    const time = Date.now();
    while (Date.now() - time < 10) {} // Busy wait for timing
    store.updateState("tile-b", { task: "Task B" });

    const latest = store.findLatestTile();
    expect(latest?.cardId).toBe("tile-b");
    expect(latest?.state.task).toBe("Task B");
  });

  it("should list multiple tiles", () => {
    store.updateState("tile-1", { task: "Task 1" });
    store.updateState("tile-2", { task: "Task 2" });
    store.updateState("tile-3", { task: "Task 3" });

    const tiles = store.listTiles(10);
    expect(tiles.length).toBe(3);
    expect(tiles[0].cardId).toMatch(/tile-[123]/);
  });

  it("should delete tile", () => {
    const cardId = "tile-to-delete";
    store.updateState(cardId, { task: "Will be deleted" });

    let state = store.loadState(cardId);
    expect(state).not.toBeNull();

    store.deleteTile(cardId);

    state = store.loadState(cardId);
    expect(state).toBeNull();
  });

  it("should handle non-existent tile gracefully", () => {
    const state = store.loadState("non-existent");
    expect(state).toBeNull();
  });

  it("should set daemon session ID", () => {
    const cardId = "test-daemon";
    const sessionId = "daemon-session-xyz";

    store.setDaemonSessionId(cardId, sessionId);

    const state = store.loadState(cardId);
    expect(state?.daemonSessionId).toBe(sessionId);
  });

  it("should update working directory", () => {
    const cardId = "test-cwd";
    store.updateState(cardId, { cwdAtStart: "/start" });

    store.updateCwd(cardId, "/new/path");

    const state = store.loadState(cardId);
    expect(state?.cwdAtStart).toBe("/start"); // Unchanged
    expect(state?.cwdLast).toBe("/new/path"); // Updated
  });

  it("should atomically write state file", () => {
    const cardId = "test-atomic";
    const state: TileState = {
      cardId,
      model: "claude-opus-4-6",
      mode: "agent",
      cwdAtStart: "/home",
      cwdLast: "/home",
      task: null,
      peerStatus: "idle",
      files: [],
      daemonSessionId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    store.saveState(cardId, state);

    // Verify file exists and is valid JSON
    const tileDir = path.join(tempDir, `tile-${cardId}`);
    const stateFile = path.join(tileDir, "state.json");
    expect(fs.existsSync(stateFile)).toBe(true);

    const content = fs.readFileSync(stateFile, "utf8");
    const parsed = JSON.parse(content);
    expect(parsed.cardId).toBe(cardId);
  });
});
