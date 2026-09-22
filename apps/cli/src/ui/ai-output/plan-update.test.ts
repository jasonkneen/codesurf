import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatPlanProgress, isPlanComplete, type PlanItem } from "./plan-update";

const item = (status: PlanItem["status"], label: string = status): PlanItem => ({ label, status });

describe("formatPlanProgress", () => {
  it("counts completed items against the total", () => {
    expect(formatPlanProgress([item("completed"), item("in_progress"), item("pending")])).toBe("1/3");
    expect(formatPlanProgress([])).toBe("0/0");
  });
});

describe("isPlanComplete", () => {
  it("is true only when every item is completed", () => {
    expect(isPlanComplete([item("completed", "a"), item("completed", "b")])).toBe(true);
    expect(isPlanComplete([item("completed", "a"), item("pending", "b")])).toBe(false);
  });

  it("is false for an empty plan", () => {
    expect(isPlanComplete([])).toBe(false);
  });
});

describe("PlanUpdate rows", () => {
  it("does not key rows by label (duplicate labels would collide)", () => {
    const source = readFileSync(fileURLToPath(new URL("./plan-update.tsx", import.meta.url)), "utf8");
    expect(source).not.toContain("key={item.label}");
  });
});
