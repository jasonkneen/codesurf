import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearLastCardId, hasSavedState, loadLastCardId, resolveCardId, saveLastCardId } from "./card-id";

describe("CARD_ID Management", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "card-id-test-"));
    // Mock HOME environment variable
    vi.stubEnv("HOME", tempHome);
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("should save and load CARD_ID", () => {
    const cardId = "tile-test-123";
    saveLastCardId(cardId);

    const loaded = loadLastCardId();
    expect(loaded).toBe(cardId);
  });

  it("should trim whitespace from CARD_ID", () => {
    saveLastCardId("  tile-with-spaces  ");

    const loaded = loadLastCardId();
    expect(loaded).toBe("tile-with-spaces");
  });

  it("should return null for non-existent file", () => {
    const loaded = loadLastCardId();
    expect(loaded).toBeNull();
  });

  it("should clear saved CARD_ID", () => {
    saveLastCardId("tile-to-clear");
    expect(loadLastCardId()).toBe("tile-to-clear");

    clearLastCardId();
    expect(loadLastCardId()).toBeNull();
  });

  it("should resolve CARD_ID from override", () => {
    const resolved = resolveCardId("override-tile");
    expect(resolved).toBe("override-tile");
    expect(loadLastCardId()).toBe("override-tile");
  });

  it("should resolve CARD_ID from environment variable", () => {
    vi.stubEnv("CARD_ID", "env-tile-123");
    const resolved = resolveCardId();
    expect(resolved).toBe("env-tile-123");
  });

  it("should resolve CARD_ID from saved file", () => {
    saveLastCardId("saved-tile-456");
    const resolved = resolveCardId();
    expect(resolved).toBe("saved-tile-456");
  });

  it("should respect override over saved file", () => {
    saveLastCardId("old-tile");
    const resolved = resolveCardId("new-override");
    expect(resolved).toBe("new-override");
  });

  it("should respect environment variable over saved file", () => {
    saveLastCardId("old-tile");
    vi.stubEnv("CARD_ID", "env-override");
    const resolved = resolveCardId();
    expect(resolved).toBe("env-override");
  });

  it("should check for saved state", () => {
    const cardId = "state-check-tile";
    const tileDir = path.join(tempHome, ".contex", `tile-${cardId}`);
    const stateFile = path.join(tileDir, "state.json");

    // No state initially
    expect(hasSavedState(cardId)).toBe(false);

    // Create state file
    fs.mkdirSync(tileDir, { recursive: true });
    fs.writeFileSync(stateFile, '{"cardId": "state-check-tile"}', "utf8");

    // Should find state now
    expect(hasSavedState(cardId)).toBe(true);
  });

  it("should handle empty CARD_ID gracefully", () => {
    saveLastCardId("   ");
    const loaded = loadLastCardId();
    expect(loaded).toBeNull();
  });
});
