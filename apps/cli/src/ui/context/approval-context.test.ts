import { describe, expect, it, vi } from "vitest";
import { mirrorToRef } from "./approval-context";

describe("mirrorToRef", () => {
  it("updates the ref synchronously for direct values so async turn code sees it before commit", () => {
    const setState = vi.fn();
    const ref = { current: null as { approvalId: string } | null };
    const set = mirrorToRef(setState, ref);

    set({ approvalId: "a1" });
    expect(ref.current).toEqual({ approvalId: "a1" });
    set(null);
    expect(ref.current).toBeNull();
    expect(setState).toHaveBeenCalledTimes(2);
  });

  it("leaves functional updates to the state commit", () => {
    const setState = vi.fn();
    const ref = { current: { approvalId: "a1" } as { approvalId: string } | null };
    const set = mirrorToRef(setState, ref);
    const updater = (p: { approvalId: string } | null) => p;

    set(updater);
    expect(ref.current).toEqual({ approvalId: "a1" });
    expect(setState).toHaveBeenCalledWith(updater);
  });
});
