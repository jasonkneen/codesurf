import { describe, expect, it } from "vitest";
import { buildThemeRows } from "./theme-modal";
import { DEFAULT_THEME_ID, getTheme, THEMES } from "./themes/catalog";

describe("buildThemeRows", () => {
  it("returns every theme when the query is empty", () => {
    const rows = buildThemeRows(THEMES, "");
    expect(rows.map((r) => r.descriptor.id)).toEqual(THEMES.map((t) => t.id));
  });

  it("filters by id, name, description, and kind (case-insensitive)", () => {
    expect(buildThemeRows(THEMES, "dracula").map((r) => r.descriptor.id)).toEqual(["dracula"]);
    expect(buildThemeRows(THEMES, "tokyo").map((r) => r.descriptor.id)).toEqual(["tokyonight"]);
    expect(buildThemeRows(THEMES, "light").map((r) => r.descriptor.kind)).toEqual(["light", "light"]);
    expect(buildThemeRows(THEMES, "GITHUB").map((r) => r.descriptor.id)).toEqual(["github-light"]);
  });

  it("trims whitespace from the query", () => {
    expect(buildThemeRows(THEMES, "   nord   ").map((r) => r.descriptor.id)).toEqual(["nord"]);
  });
});

describe("getTheme", () => {
  it("returns the default dark theme for null / undefined / unknown ids", () => {
    expect(getTheme(null).background).toBe(getTheme(DEFAULT_THEME_ID).background);
    expect(getTheme(undefined).background).toBe(getTheme(DEFAULT_THEME_ID).background);
    expect(getTheme("nonexistent").background).toBe(getTheme(DEFAULT_THEME_ID).background);
  });

  it("returns distinct theme objects for different ids", () => {
    const dark = getTheme("dark");
    const dracula = getTheme("dracula");
    const nord = getTheme("nord");
    expect(dark.background).not.toBe(dracula.background);
    expect(dracula.background).not.toBe(nord.background);
  });
});
