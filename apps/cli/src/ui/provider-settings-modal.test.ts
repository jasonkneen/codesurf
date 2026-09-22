import { describe, expect, it } from "vitest";
import type { RegisteredSetting } from "../core/plugins";
import { coerceSettingInput, nextSelectValue, settingDisplayValue } from "./provider-settings-modal";

function setting(overrides: Partial<RegisteredSetting>): RegisteredSetting {
  return {
    pluginId: "test.provider",
    key: "test.setting",
    title: "Test setting",
    type: "string",
    default: "",
    ...overrides,
  };
}

describe("provider settings helpers", () => {
  it("masks secret values and labels empty secrets", () => {
    const secret = setting({ type: "secret", default: "" });
    expect(settingDisplayValue(secret, "sk-test")).toBe("******");
    expect(settingDisplayValue(secret, "")).toBe("(empty)");
  });

  it("uses select option labels for display", () => {
    const mode = setting({
      type: "select",
      default: "ask",
      options: [
        { value: "ask", label: "Ask" },
        { value: "never", label: "Never" },
      ],
    });
    expect(settingDisplayValue(mode, "never")).toBe("Never");
  });

  it("cycles select values in both directions", () => {
    const mode = setting({
      type: "select",
      default: "ask",
      options: [
        { value: "ask", label: "Ask" },
        { value: "never", label: "Never" },
        { value: "auto", label: "Auto" },
      ],
    });
    expect(nextSelectValue(mode, "ask", 1)).toBe("never");
    expect(nextSelectValue(mode, "ask", -1)).toBe("auto");
  });

  it("coerces number settings and rejects invalid values", () => {
    const timeout = setting({ type: "number", default: 1000 });
    expect(coerceSettingInput(timeout, "2500")).toBe(2500);
    expect(() => coerceSettingInput(timeout, "nope")).toThrow(/valid number/);
  });
});
