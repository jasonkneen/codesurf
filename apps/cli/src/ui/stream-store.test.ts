import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getStreamContent,
  getStreamReasoning,
  setStreamContent,
  setStreamReasoning,
  subscribeStreamContent,
  subscribeStreamReasoning,
} from "./stream-store.js";

// The store is module-global; reset to empty after each test so cases don't
// leak state into one another.
afterEach(() => {
  setStreamContent("");
  setStreamReasoning("");
});

describe("stream-store content", () => {
  it("returns the latest set value", () => {
    setStreamContent("hello");
    expect(getStreamContent()).toBe("hello");
    setStreamContent("hello world");
    expect(getStreamContent()).toBe("hello world");
  });

  it("notifies subscribers on change", () => {
    const fn = vi.fn();
    const unsub = subscribeStreamContent(fn);
    setStreamContent("a");
    setStreamContent("ab");
    expect(fn).toHaveBeenCalledTimes(2);
    unsub();
  });

  it("does NOT notify when the value is unchanged", () => {
    setStreamContent("same");
    const fn = vi.fn();
    const unsub = subscribeStreamContent(fn);
    setStreamContent("same"); // identical → no emit
    expect(fn).not.toHaveBeenCalled();
    unsub();
  });

  it("stops notifying after unsubscribe", () => {
    const fn = vi.fn();
    const unsub = subscribeStreamContent(fn);
    setStreamContent("x");
    unsub();
    setStreamContent("y");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("stream-store reasoning", () => {
  it("tracks reasoning independently from content", () => {
    const contentFn = vi.fn();
    const reasoningFn = vi.fn();
    const unsubC = subscribeStreamContent(contentFn);
    const unsubR = subscribeStreamReasoning(reasoningFn);

    setStreamReasoning("thinking...");

    // A reasoning delta must NOT wake content subscribers, and vice versa.
    expect(reasoningFn).toHaveBeenCalledTimes(1);
    expect(contentFn).not.toHaveBeenCalled();
    expect(getStreamReasoning()).toBe("thinking...");

    unsubC();
    unsubR();
  });
});
