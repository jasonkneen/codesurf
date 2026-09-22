import { describe, expect, it } from "vitest";
import { Steward } from "./steward";

describe("steward wildcard principal", () => {
  it("allows any principal when the allow list contains *", () => {
    const steward = new Steward({ allow: { s_tool: ["*"] } });
    expect(steward.authorize("anyone", "s_tool", "s").allowed).toBe(true);
    expect(steward.authorize("bob", "s_tool", "s").allowed).toBe(true);
  });

  it("still denies when the principal is not allowed", () => {
    const steward = new Steward({ allow: { s_tool: ["alice"] } });
    expect(steward.authorize("eve", "s_tool", "s").allowed).toBe(false);
  });
});
