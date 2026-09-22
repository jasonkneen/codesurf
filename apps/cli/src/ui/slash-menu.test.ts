import { describe, expect, it } from "vitest";
import { filterSlashMenuItems, filterVisibleSlashItems, SLASH_MENU_ITEMS } from "./slash-menu";
import { formatSlashMenuInlineRow } from "./slash-menu-inline";

describe("filterSlashMenuItems", () => {
  it("finds the models command when searching with the full slash command", () => {
    expect(filterSlashMenuItems(SLASH_MENU_ITEMS, "/models")[0]?.id).toBe("models");
  });

  it("finds the models command from model and mode prefixes before description matches", () => {
    expect(filterSlashMenuItems(SLASH_MENU_ITEMS, "model")[0]?.id).toBe("models");
    expect(filterSlashMenuItems(SLASH_MENU_ITEMS, "mode")[0]?.id).toBe("models");
  });

  it("still includes description matches after stronger command matches", () => {
    const ids = filterSlashMenuItems(SLASH_MENU_ITEMS, "mode").map((item) => item.id);
    expect(ids).toContain("models");
    expect(ids).toContain("sandbox");
    expect(ids.indexOf("models")).toBeLessThan(ids.indexOf("sandbox"));
  });

  it("finds the recaps command from singular aliases", () => {
    expect(filterSlashMenuItems(SLASH_MENU_ITEMS, "recap")[0]?.id).toBe("recaps");
  });
});

describe("filterVisibleSlashItems", () => {
  it("does not show quit/exit when filtering for /ui", () => {
    const items = [
      { id: "quit", label: "quit", description: "Exit codesurf." },
      { id: "ui", label: "ui", description: "Toggle UI mode." },
    ];

    expect(filterVisibleSlashItems(items, "/ui").map((item) => item.id)).toEqual(["ui"]);
  });
});

describe("formatSlashMenuInlineRow", () => {
  it("keeps long command descriptions on one bounded line", () => {
    const row = formatSlashMenuInlineRow({
      id: "auto",
      label: "auto",
      description: "Start an Auto-mode run that loops until done, blocked, or max turns.",
    });

    expect(row.command).toBe("/auto");
    expect(row.description).toBe("Start an Auto-mode run that loops until don…");
    expect(row.description.length).toBeLessThanOrEqual(44);
  });

  it("does not prefix the freeform ask row with a slash", () => {
    const row = formatSlashMenuInlineRow({
      id: "__ask__",
      label: "Ask Grok",
      description: "Send this as a normal prompt",
    });

    expect(row.command).toBe("Ask Grok");
    expect(row.isAsk).toBe(true);
  });
});
