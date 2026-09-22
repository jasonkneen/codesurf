import { describe, expect, it, vi } from "vitest";
import { createIndexStore } from "./menu-nav-store.js";

describe("createIndexStore", () => {
  it("starts at 0 and returns the current value via get()", () => {
    const store = createIndexStore();
    expect(store.get()).toBe(0);
    store.set(3);
    expect(store.get()).toBe(3);
  });

  it("supports updater functions", () => {
    const store = createIndexStore();
    store.set(2);
    store.set((i) => i + 1);
    expect(store.get()).toBe(3);
    store.set((i) => Math.max(0, i - 5));
    expect(store.get()).toBe(0);
  });

  it("notifies subscribers on change", () => {
    const store = createIndexStore();
    const cb = vi.fn();
    store.subscribe(cb);
    store.set(1);
    store.set((i) => i + 1);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("does NOT notify when the value is unchanged (avoids needless re-renders)", () => {
    const store = createIndexStore();
    store.set(4);
    const cb = vi.fn();
    store.subscribe(cb);
    store.set(4); // same value
    store.set((i) => i); // updater returns same value
    expect(cb).not.toHaveBeenCalled();
  });

  it("stops notifying after unsubscribe", () => {
    const store = createIndexStore();
    const cb = vi.fn();
    const unsub = store.subscribe(cb);
    store.set(1);
    unsub();
    store.set(2);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(store.get()).toBe(2);
  });

  it("supports multiple independent subscribers", () => {
    const store = createIndexStore();
    const a = vi.fn();
    const b = vi.fn();
    store.subscribe(a);
    store.subscribe(b);
    store.set(1);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});
