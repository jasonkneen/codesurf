import { describe, expect, it } from "vitest";
import { countHooksForTool } from "./count";

describe("countHooksForTool", () => {
  it("returns a non-negative number without throwing", () => {
    expect(countHooksForTool("read_file")).toBeGreaterThanOrEqual(0);
  });
});
