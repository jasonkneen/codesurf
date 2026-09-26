import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase } from "./db";
import { loadPromptHistory, recordPrompt } from "./prompt-history";

const originalHome = process.env.HOME;
// The global test setup (test/setup/isolate-config-dir.ts) now sets
// CODESURF_HOME once for the whole run, which takes precedence over the
// os.homedir() mock below inside defaultCodesurfHome(). Without also pinning
// CODESURF_HOME per test, every test in this file shares that one global
// database instead of its own tempHome, and prompt rows leak across tests.
const originalCodesurfHome = process.env.CODESURF_HOME;

describe("prompt-history storage", () => {
  const tempRoot = path.join(os.tmpdir(), "grok-prompt-history-tests");
  let tempHome = "";

  beforeEach(() => {
    fs.mkdirSync(tempRoot, { recursive: true });
    tempHome = fs.mkdtempSync(path.join(tempRoot, "grok-ph-home-"));
    process.env.HOME = tempHome;
    process.env.CODESURF_HOME = tempHome;
    vi.spyOn(os, "homedir").mockReturnValue(tempHome);
    closeDatabase();
  });

  afterEach(() => {
    closeDatabase();
    vi.restoreAllMocks();
    process.env.HOME = originalHome;
    if (originalCodesurfHome === undefined) delete process.env.CODESURF_HOME;
    else process.env.CODESURF_HOME = originalCodesurfHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
    // NOT tempRoot: it is a fixed shared path, so removing it deletes the
    // home directories of any other suite running this file concurrently.
  });

  it("stores and retrieves prompts for a workspace", () => {
    recordPrompt({ workspaceId: "ws1", text: "hello world" });
    recordPrompt({ workspaceId: "ws1", text: "second prompt" });
    const history = loadPromptHistory("ws1");
    expect(history).toEqual(["hello world", "second prompt"]);
  });

  it("returns empty array when no history exists", () => {
    expect(loadPromptHistory("ws-empty")).toEqual([]);
  });

  it("applies consecutive-dedup: skips identical consecutive entries", () => {
    recordPrompt({ workspaceId: "ws1", text: "hello" });
    recordPrompt({ workspaceId: "ws1", text: "hello" }); // duplicate
    recordPrompt({ workspaceId: "ws1", text: "world" });
    const history = loadPromptHistory("ws1");
    expect(history).toEqual(["hello", "world"]);
  });

  it("does NOT dedup non-consecutive identical entries", () => {
    recordPrompt({ workspaceId: "ws1", text: "hello" });
    recordPrompt({ workspaceId: "ws1", text: "world" });
    recordPrompt({ workspaceId: "ws1", text: "hello" }); // same as first but not consecutive
    const history = loadPromptHistory("ws1");
    expect(history).toEqual(["hello", "world", "hello"]);
  });

  it("respects the limit parameter", () => {
    for (let i = 0; i < 10; i++) {
      recordPrompt({ workspaceId: "ws1", text: `prompt ${i}` });
    }
    const history = loadPromptHistory("ws1", 3);
    expect(history).toHaveLength(3);
    // Should return the 3 most recent in ascending order.
    expect(history).toEqual(["prompt 7", "prompt 8", "prompt 9"]);
  });

  it("scopes history per workspace — ws1 and ws2 are independent", () => {
    recordPrompt({ workspaceId: "ws1", text: "from-ws1" });
    recordPrompt({ workspaceId: "ws2", text: "from-ws2" });
    expect(loadPromptHistory("ws1")).toEqual(["from-ws1"]);
    expect(loadPromptHistory("ws2")).toEqual(["from-ws2"]);
  });

  it("ignores empty/whitespace-only text", () => {
    recordPrompt({ workspaceId: "ws1", text: "   " });
    recordPrompt({ workspaceId: "ws1", text: "" });
    expect(loadPromptHistory("ws1")).toEqual([]);
  });

  it("returns entries in ascending chronological order", () => {
    recordPrompt({ workspaceId: "ws1", text: "first" });
    recordPrompt({ workspaceId: "ws1", text: "second" });
    recordPrompt({ workspaceId: "ws1", text: "third" });
    const history = loadPromptHistory("ws1");
    expect(history[0]).toBe("first");
    expect(history[2]).toBe("third");
  });
});
