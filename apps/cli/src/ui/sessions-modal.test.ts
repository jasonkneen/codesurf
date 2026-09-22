import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../types/index";
import { buildSessionsRows } from "./sessions-modal";

function fake(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  const now = new Date("2025-01-01T12:00:00Z");
  return {
    id,
    workspaceId: "ws-1",
    title: null,
    recap: null,
    model: "grok-4-1-fast-reasoning",
    mode: "agent",
    cwdAtStart: "/tmp",
    cwdLast: "/tmp",
    status: "active",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("buildSessionsRows", () => {
  it("returns every session when the query is empty", () => {
    const rows = buildSessionsRows([fake("a"), fake("b")], null, "");
    expect(rows.map((r) => r.session.id)).toEqual(["a", "b"]);
  });

  it("filters by id, title, model, and mode (case-insensitive)", () => {
    const list = [
      fake("session-a", { title: "Refactor agent" }),
      fake("session-b", { title: "Debug build", mode: "ask" }),
      fake("session-c", { model: "grok-code-fast-1" }),
    ];
    expect(buildSessionsRows(list, null, "refactor").map((r) => r.session.id)).toEqual(["session-a"]);
    expect(buildSessionsRows(list, null, "ask").map((r) => r.session.id)).toEqual(["session-b"]);
    expect(buildSessionsRows(list, null, "CODE").map((r) => r.session.id)).toEqual(["session-c"]);
  });

  it("marks the active session", () => {
    const rows = buildSessionsRows([fake("a"), fake("b"), fake("c")], "b", "");
    expect(rows.find((r) => r.isActive)?.session.id).toBe("b");
    expect(rows.filter((r) => !r.isActive).map((r) => r.session.id)).toEqual(["a", "c"]);
  });

  it("returns no active flag when the current id is null", () => {
    const rows = buildSessionsRows([fake("a"), fake("b")], null, "");
    expect(rows.every((r) => !r.isActive)).toBe(true);
  });
});
