import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractToken } from "./useTypeahead";

describe("typeahead token extraction", () => {
  it("recognizes @ mentions and bare relative paths at the cursor", () => {
    expect(extractToken("Read @src/ui", "Read @src/ui".length)).toEqual({
      token: "src/ui",
      startPos: 5,
      endPos: 12,
      hasAtPrefix: true,
    });
    expect(extractToken("Read src/ui", "Read src/ui".length)).toEqual({
      token: "src/ui",
      startPos: 5,
      endPos: 11,
      hasAtPrefix: false,
    });
  });

  it("keeps slash commands out of mention completion", () => {
    expect(extractToken("/review", "/review".length)).toBeNull();
  });

  it("refreshes from textarea events instead of polling the empty composer", () => {
    const source = readFileSync(fileURLToPath(new URL("./useTypeahead.ts", import.meta.url)), "utf8");

    expect(source).toContain("refresh: () => void;");
    expect(source).not.toContain("setInterval(");
  });
});
