import { describe, expect, it } from "vitest";
import { truncate } from "./text";

describe("truncate", () => {
  it("passes short strings through unchanged", () => {
    expect(truncate("hello", 10)).toBe("hello");
    expect(truncate("", 10)).toBe("");
  });

  it("passes exact-max strings through unchanged", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });

  it("cuts long strings to max chars ending in an ellipsis", () => {
    const result = truncate("hello world", 8);
    expect(result).toBe("hello w…");
    expect(result.length).toBe(8);
  });

  it("returns empty string when max <= 1", () => {
    expect(truncate("hello", 1)).toBe("");
    expect(truncate("hello", 0)).toBe("");
    expect(truncate("hello", -3)).toBe("");
  });
});
