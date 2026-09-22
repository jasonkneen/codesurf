import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cachedCliCheck, clearCliCheckCache } from "./cli-check-cache";

describe("cachedCliCheck", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearCliCheckCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the probe once within the TTL", () => {
    const probe = vi.fn(() => true);
    expect(cachedCliCheck("a", probe, 1000)).toBe(true);
    expect(cachedCliCheck("a", probe, 1000)).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("re-runs the probe after the TTL expires", () => {
    const probe = vi.fn(() => "v");
    cachedCliCheck("a", probe, 1000);
    vi.advanceTimersByTime(1001);
    cachedCliCheck("a", probe, 1000);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("caches negative results too", () => {
    const probe = vi.fn(() => false);
    expect(cachedCliCheck("a", probe, 1000)).toBe(false);
    expect(cachedCliCheck("a", probe, 1000)).toBe(false);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("keys are independent", () => {
    const a = vi.fn(() => 1);
    const b = vi.fn(() => 2);
    expect(cachedCliCheck("a", a, 1000)).toBe(1);
    expect(cachedCliCheck("b", b, 1000)).toBe(2);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("clearCliCheckCache forces a fresh probe", () => {
    const probe = vi.fn(() => true);
    cachedCliCheck("a", probe, 1000);
    clearCliCheckCache();
    cachedCliCheck("a", probe, 1000);
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
