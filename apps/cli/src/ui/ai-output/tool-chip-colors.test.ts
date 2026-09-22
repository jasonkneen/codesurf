import { describe, expect, it } from "vitest";
import { envVarFor, FEATURE_FLAGS } from "../feature-flags";
import { resolveToolChipColors } from "./tool-chip-colors";

const theme = {
  accent: "accent",
  background: "background",
  text: "text",
  textDim: "text-dim",
  textMuted: "text-muted",
} as const;

describe("resolveToolChipColors", () => {
  it("uses the subdued chip colours when the feature is enabled", () => {
    expect(resolveToolChipColors(theme, { dimToolChips: true, expanded: false })).toEqual({
      background: "text-dim",
      foreground: "text",
    });
  });

  it("restores the brighter legacy colours when the feature is disabled", () => {
    expect(resolveToolChipColors(theme, { dimToolChips: false, expanded: false })).toEqual({
      background: "text-muted",
      foreground: "background",
    });
  });

  it("keeps expanded chips on the accent treatment regardless of the feature", () => {
    expect(resolveToolChipColors(theme, { dimToolChips: true, expanded: true })).toEqual({
      background: "accent",
      foreground: "background",
    });
    expect(resolveToolChipColors(theme, { dimToolChips: false, expanded: true })).toEqual({
      background: "accent",
      foreground: "background",
    });
  });
});

describe("tool-chip colour feature flag", () => {
  it("keeps the subdued treatment enabled by default and exposes an env override", () => {
    const flag = FEATURE_FLAGS.find((candidate) => candidate.id === "render.toolChips.dim");

    expect(flag).toMatchObject({
      id: "render.toolChips.dim",
      label: "Subdued tool chips",
      default: true,
    });
    expect(flag).toBeDefined();
    expect(envVarFor(flag!)).toBe("RENDER_TOOLCHIPS_DIM");
  });
});
