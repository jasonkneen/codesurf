import { describe, expect, it } from "bun:test";
import { formatComposerChromeLabel, permissionModeComposerLabel } from "./prompt-bar";

describe("formatComposerChromeLabel", () => {
  it("joins model and mode with spaced dots", () => {
    expect(formatComposerChromeLabel("Grok Build 0.1", "Agent")).toBe(" Grok Build 0.1 · Agent ");
  });
});

describe("permissionModeComposerLabel", () => {
  it("maps bypass to always-approve", () => {
    expect(permissionModeComposerLabel("bypassPermissions")).toBe("always-approve");
  });

  it("maps dontAsk to dont-ask", () => {
    expect(permissionModeComposerLabel("dontAsk")).toBe("dont-ask");
  });
});
