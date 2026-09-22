import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase } from "./db";
import { SessionStore } from "./sessions";

const originalHome = process.env.HOME;

describe("SessionStore recap persistence", () => {
  // Must live OUTSIDE the repo: workspace identity is keyed on the git root,
  // so temp cwds under process.cwd() would all resolve to the same workspace
  // and break the cross-workspace isolation test.
  const tempRoot = path.join(os.tmpdir(), "grok-session-tests");
  let tempHome = "";
  let tempCwd = "";
  let otherCwd = "";

  beforeEach(() => {
    fs.mkdirSync(tempRoot, { recursive: true });
    tempHome = fs.mkdtempSync(path.join(tempRoot, "grok-session-home-"));
    tempCwd = fs.mkdtempSync(path.join(tempRoot, "grok-session-cwd-"));
    otherCwd = fs.mkdtempSync(path.join(tempRoot, "grok-session-other-cwd-"));
    process.env.HOME = tempHome;
    vi.spyOn(os, "homedir").mockReturnValue(tempHome);
    closeDatabase();
  });

  afterEach(() => {
    closeDatabase();
    vi.restoreAllMocks();
    process.env.HOME = originalHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(tempCwd, { recursive: true, force: true });
    fs.rmSync(otherCwd, { recursive: true, force: true });
    // NOT tempRoot: it is a fixed shared path, so removing it deletes the
    // fixtures of any other suite running this file concurrently.
  });

  it("stores and reloads the latest recap metadata with the session", () => {
    const store = new SessionStore(tempCwd);
    const session = store.createSession("grok-4.3", "agent", tempCwd);
    const updatedAt = new Date("2026-04-22T15:00:00.000Z");

    store.setRecap(session.id, {
      text: "Migrated billing sessions to the new schema. Next step is wiring the prompt banner.",
      model: "grok-4.20-non-reasoning",
      updatedAt,
    });

    expect(store.getRequiredSession(session.id).recap).toEqual({
      text: "Migrated billing sessions to the new schema. Next step is wiring the prompt banner.",
      model: "grok-4.20-non-reasoning",
      updatedAt,
    });
  });

  it("clears recap metadata when the recap is removed", () => {
    const store = new SessionStore(tempCwd);
    const session = store.createSession("grok-4.3", "agent", tempCwd);

    store.setRecap(session.id, {
      text: "Temporary recap",
      model: "grok-4.20-non-reasoning",
      updatedAt: new Date("2026-04-22T15:00:00.000Z"),
    });
    store.setRecap(session.id, null);

    expect(store.getRequiredSession(session.id).recap).toBeNull();
  });

  it("does not read or update sessions from another workspace", () => {
    const ownerStore = new SessionStore(tempCwd);
    const foreignStore = new SessionStore(otherCwd);
    const ownerSession = ownerStore.createSession("grok-4.3", "agent", tempCwd);

    expect(foreignStore.getSessionById(ownerSession.id)).toBeNull();
    expect(() => foreignStore.getRequiredSession(ownerSession.id)).toThrow(
      `Session "${ownerSession.id}" was not found.`,
    );

    foreignStore.setTitle(ownerSession.id, "foreign title");
    foreignStore.setModel(ownerSession.id, "grok-4.1");
    foreignStore.setMode(ownerSession.id, "ask");
    foreignStore.setRecap(ownerSession.id, {
      text: "foreign recap",
      model: "grok-4.1",
      updatedAt: new Date("2026-05-23T12:00:00.000Z"),
    });
    foreignStore.touchSession(ownerSession.id, otherCwd);

    expect(ownerStore.getRequiredSession(ownerSession.id)).toMatchObject({
      title: null,
      model: "grok-4.3",
      mode: "agent",
      cwdLast: tempCwd,
      recap: null,
    });
  });

  it("does not let an unknown selector create a new latest", () => {
    const store = new SessionStore(tempCwd);
    const existing = store.createSession("grok-4.3", "agent", tempCwd);
    const opened = store.openSession("fresh-observe-1", "grok-4.3", "agent", tempCwd);
    expect(opened.id).toBe(existing.id);
    expect(store.listSessions()).toHaveLength(1);
    expect(store.getLatestSession()?.id).toBe(existing.id);
  });

  it("opens an existing session by real id", () => {
    const store = new SessionStore(tempCwd);
    const existing = store.createSession("grok-4.3", "agent", tempCwd);
    expect(store.openSession(existing.id, "grok-4.3", "agent", tempCwd).id).toBe(existing.id);
  });

  it("latest returns the most recently updated existing session", async () => {
    const store = new SessionStore(tempCwd);
    store.createSession("grok-4.3", "agent", tempCwd);
    await new Promise((r) => setTimeout(r, 15));
    const second = store.createSession("grok-4.3", "agent", tempCwd);
    expect(store.getLatestSession()?.id).toBe(second.id);
    expect(store.openSession("latest", "grok-4.3", "agent", tempCwd).id).toBe(second.id);
  });
});
