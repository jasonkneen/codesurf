import { describe, expect, it } from "vitest";
import { buildCommandPaletteModel, buildCommandPaletteRows, type CommandPaletteAction } from "./command-palette";

const ACTIONS: CommandPaletteAction[] = [
  { id: "models", label: "/models", description: "Select a model", source: "Agent", suggested: true },
  { id: "init", label: "/init", description: "Initialise the project", source: "Agent", suggested: true },
  { id: "logout", label: "/logout", description: "Log out", source: "Agent" },
  { id: "extensions", label: "/plugins", description: "Manage plugins", source: "Agent" },
];

describe("buildCommandPaletteRows", () => {
  it("returns every action when the query is empty", () => {
    expect(buildCommandPaletteRows(ACTIONS, "").map((a) => a.id)).toEqual(["models", "init", "logout", "extensions"]);
  });

  it("filters by label, id, and description (case-insensitive)", () => {
    expect(buildCommandPaletteRows(ACTIONS, "MODEL").map((a) => a.id)).toEqual(["models"]);
    expect(buildCommandPaletteRows(ACTIONS, "logout").map((a) => a.id)).toEqual(["logout"]);
    expect(buildCommandPaletteRows(ACTIONS, "manage").map((a) => a.id)).toEqual(["extensions"]);
  });

  it("trims whitespace-only queries to the full list", () => {
    expect(buildCommandPaletteRows(ACTIONS, "   ").map((a) => a.id)).toEqual(ACTIONS.map((a) => a.id));
  });
});

describe("buildCommandPaletteModel — grouped (empty query)", () => {
  const model = buildCommandPaletteModel(ACTIONS, "");

  it("places the Suggested group first, then the Commands group", () => {
    const headers = model.rows.filter((r) => r.kind === "header").map((r) => (r.kind === "header" ? r.label : ""));
    expect(headers).toEqual(["Suggested", "Commands"]);
  });

  it("orders selectable actions as suggested-first then the rest", () => {
    expect(model.actions.map((a) => a.id)).toEqual(["models", "init", "logout", "extensions"]);
  });

  it("emits action rows whose actionIndex maps back to the actions array", () => {
    for (const row of model.rows) {
      if (row.kind !== "action") continue;
      expect(model.actions[row.actionIndex]).toBeDefined();
      expect(model.actions[row.actionIndex].id).toBe(row.action.id);
    }
  });

  it("assigns contiguous actionIndices 0..n-1 across both groups, skipping headers", () => {
    const indices = model.rows
      .filter((r) => r.kind === "action")
      .map((r) => (r.kind === "action" ? r.actionIndex : -1));
    expect(indices).toEqual([0, 1, 2, 3]);
  });

  it("never produces an actionIndex that lands on a header row", () => {
    // Every selectable position resolves to a real action, not a header.
    for (let i = 0; i < model.actions.length; i++) {
      expect(model.actions[i]).toBeDefined();
    }
    expect(model.actions.length).toBe(model.rows.filter((r) => r.kind === "action").length);
  });

  it("omits the Suggested group when nothing is tagged suggested", () => {
    const plain = buildCommandPaletteModel(
      ACTIONS.map((a) => ({ ...a, suggested: false })),
      "",
    );
    const headers = plain.rows.filter((r) => r.kind === "header").map((r) => (r.kind === "header" ? r.label : ""));
    expect(headers).toEqual(["Commands"]);
  });

  it("ignores a leadingAction in grouped mode", () => {
    const withLead = buildCommandPaletteModel(ACTIONS, "", {
      leadingAction: { id: "__ask__", label: "ask", source: "Ask" },
    });
    expect(withLead.actions.some((a) => a.id === "__ask__")).toBe(false);
  });
});

describe("buildCommandPaletteModel — flat (search query)", () => {
  it("produces a flat list with no header rows when searching", () => {
    const model = buildCommandPaletteModel(ACTIONS, "o");
    expect(model.rows.every((r) => r.kind === "action")).toBe(true);
  });

  it("filters the actions and keeps actionIndex aligned to the actions array", () => {
    const model = buildCommandPaletteModel(ACTIONS, "logout");
    expect(model.actions.map((a) => a.id)).toEqual(["logout"]);
    expect(model.rows).toEqual([{ kind: "action", action: ACTIONS[2], actionIndex: 0 }]);
  });

  it("prepends the leadingAction at index 0 in search mode and keeps it selectable", () => {
    const ask: CommandPaletteAction = { id: "__ask__", label: "deploy", source: "Ask" };
    const model = buildCommandPaletteModel(ACTIONS, "models", { leadingAction: ask });
    expect(model.actions[0].id).toBe("__ask__");
    expect(model.actions.map((a) => a.id)).toEqual(["__ask__", "models"]);
    expect(model.rows[0]).toEqual({ kind: "action", action: ask, actionIndex: 0 });
  });

  it("keeps every selectable index resolvable to an action (never a header) while searching", () => {
    const model = buildCommandPaletteModel(ACTIONS, "e", {
      leadingAction: { id: "__ask__", label: "e", source: "Ask" },
    });
    expect(model.rows.filter((r) => r.kind === "header")).toHaveLength(0);
    for (const row of model.rows) {
      if (row.kind === "action") expect(model.actions[row.actionIndex].id).toBe(row.action.id);
    }
  });
});
