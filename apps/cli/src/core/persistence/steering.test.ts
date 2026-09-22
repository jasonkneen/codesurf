import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatSteeringInstructions,
  loadSteeringPreferences,
  optionIndexForValue,
  STEER_DIMENSIONS,
  steerSettingKey,
} from "./steering";

const originalConfigDir = process.env.CODESURF_CONFIG_DIR;
let tmp: string;

function writeExtensionsSettings(settings: Record<string, unknown>): void {
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "extensions.json"),
    JSON.stringify({ enabled: null, disabled: [], tools: {}, settings }, null, 2),
  );
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "steer-cfg-"));
  process.env.CODESURF_CONFIG_DIR = tmp;
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.CODESURF_CONFIG_DIR;
  else process.env.CODESURF_CONFIG_DIR = originalConfigDir;
});

describe("steerSettingKey", () => {
  it("namespaces a dimension id under steer.", () => {
    expect(steerSettingKey("scope")).toBe("steer.scope");
    expect(steerSettingKey("risk")).toBe("steer.risk");
  });
});

describe("STEER_DIMENSIONS", () => {
  it("covers scope/risk/verify and keys are steer.<id>", () => {
    expect(STEER_DIMENSIONS.map((d) => d.id)).toEqual(["scope", "risk", "verify"]);
    for (const d of STEER_DIMENSIONS) {
      expect(d.settingKey).toBe(`steer.${d.id}`);
      expect(d.promptLabel.length).toBeGreaterThan(0);
    }
  });
});

describe("loadSteeringPreferences", () => {
  it("returns an empty object when nothing is persisted", () => {
    expect(loadSteeringPreferences()).toEqual({});
  });

  it("reads persisted steer.* string values into dimension ids", () => {
    writeExtensionsSettings({
      "steer.scope": "Tight fix",
      "steer.risk": "Low",
      "steer.verify": "Standard",
      "unrelated.key": "ignored",
    });
    expect(loadSteeringPreferences()).toEqual({
      scope: "Tight fix",
      risk: "Low",
      verify: "Standard",
    });
  });

  it("ignores blank strings and non-string values", () => {
    writeExtensionsSettings({ "steer.scope": "", "steer.risk": 3, "steer.verify": "Full" });
    expect(loadSteeringPreferences()).toEqual({ verify: "Full" });
  });
});

describe("formatSteeringInstructions", () => {
  it("returns null when no preferences are set", () => {
    expect(formatSteeringInstructions({})).toBeNull();
  });

  it("formats only the set dimensions, in canonical order", () => {
    const out = formatSteeringInstructions({ verify: "Full", scope: "Tight fix" });
    expect(out).toBe(
      [
        "# Active Steering Preferences",
        "",
        "Honor these steering selections (set via `/steer`) for this session:",
        "- Scope of change: Tight fix",
        "- Verification depth: Full",
      ].join("\n"),
    );
  });
});

describe("optionIndexForValue", () => {
  it("returns the index of the matching label", () => {
    expect(optionIndexForValue(["Low", "Medium", "High"], "High")).toBe(2);
  });

  it("returns -1 when the value is missing or absent", () => {
    expect(optionIndexForValue(["Low", "Medium"], "Nope")).toBe(-1);
    expect(optionIndexForValue(["Low"], undefined)).toBe(-1);
  });
});
