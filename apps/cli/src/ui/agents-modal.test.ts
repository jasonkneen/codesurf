// The /agents picker sizing.
//
// Regression for a reported bug: "agents doesn't work, can't save can't see".
// Three sub-agents were saved correctly and the rows were built correctly —
// `buildSubagentBrowseRows` returned all three — but the panel reserved 7 rows
// for chrome that actually occupies 10, so the list area collapsed and the
// modal rendered as an empty box. Saving looked broken because the saved agent
// never appeared.
//
// The sizing is asserted as "every row fits", not against a magic number, so
// this keeps working if the chrome changes and the constant is updated with it.

import { describe, expect, it } from "vitest";
import { buildSubagentBrowseRows, subagentPanelHeight } from "./agents-modal";

/**
 * Chrome rows MEASURED from the rendered panel, counted independently of the
 * component's own constant:
 *
 *   1 border top · 2 panel paddingTop · 3 title · 4 search paddingTop
 *   5 search text · 6 scrollbox paddingTop · … list … · N-2 footer
 *   N-1 panel paddingBottom · N border bottom
 *
 * Deriving this from `SUBAGENT_PANEL_CHROME_ROWS` would make every assertion
 * below tautological — the original bug was that constant being wrong, and a
 * test computed from it passes at any value. If the panel's JSX changes, count
 * again and update this number deliberately.
 */
const MEASURED_CHROME_ROWS = 10;

const agents = [
  { name: "images", model: "grok-build-0.1", instruction: "does images" },
  { name: "reviewer", model: "grok-4.3", instruction: "reviews" },
  { name: "testtest", model: "grok-4.3", instruction: "tests" },
];

/** Rows actually available to the list at a given panel height. */
const listRows = (panelHeight: number) => panelHeight - MEASURED_CHROME_ROWS;

describe("subagentPanelHeight", () => {
  it("leaves room for every agent on a normal-sized terminal", () => {
    // The reported case: three agents on a 50-row terminal showed none.
    expect(listRows(subagentPanelHeight(agents.length, 50))).toBeGreaterThanOrEqual(agents.length);
  });

  it("leaves at least one row for the empty-state placeholder", () => {
    // With no agents the box still has to render "No custom sub-agents yet".
    expect(listRows(subagentPanelHeight(0, 50))).toBeGreaterThanOrEqual(1);
  });

  it("scales with the list up to the half-screen cap", () => {
    for (const count of [1, 2, 5, 10]) {
      const height = subagentPanelHeight(count, 80);
      expect(listRows(height)).toBeGreaterThanOrEqual(count);
    }
  });

  it("caps at 55% of the screen so a long list does not swallow it", () => {
    const height = subagentPanelHeight(500, 50);
    expect(height).toBe(Math.floor(50 * 0.55));
    expect(height).toBeLessThan(50);
  });

  it("does not grow a giant box for an empty list", () => {
    // Content-sized: an empty picker must stay compact rather than take the cap.
    expect(subagentPanelHeight(0, 80)).toBeLessThan(Math.floor(80 * 0.55));
  });
});

describe("buildSubagentBrowseRows", () => {
  it("returns a row per agent when unfiltered", () => {
    expect(buildSubagentBrowseRows(agents, "")).toHaveLength(3);
  });

  it("filters on name, model and instruction", () => {
    expect(buildSubagentBrowseRows(agents, "images").map((r) => r.agent.name)).toEqual(["images"]);
    expect(buildSubagentBrowseRows(agents, "grok-4.3").map((r) => r.agent.name)).toEqual(["reviewer", "testtest"]);
    expect(buildSubagentBrowseRows(agents, "reviews").map((r) => r.agent.name)).toEqual(["reviewer"]);
  });

  it("ignores case and surrounding whitespace", () => {
    expect(buildSubagentBrowseRows(agents, "  IMAGES  ")).toHaveLength(1);
  });
});
