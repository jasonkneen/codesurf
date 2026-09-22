import { afterEach, describe, expect, it, vi } from "vitest";
import { executeEventHooks } from "../../hooks/index";
import type { HookInput } from "../../hooks/types";
import {
  __agentEventListenerCountForTests,
  __resetAgentEventBusForTests,
  emitAgentEvent,
  subscribeAgentEvent,
} from "./event-bus";

afterEach(() => {
  __resetAgentEventBusForTests();
});

function userPromptInput(prompt = "hi"): HookInput {
  return {
    hook_event_name: "UserPromptSubmit",
    user_prompt: prompt,
    cwd: "/tmp",
  };
}

function stopInput(): HookInput {
  return {
    hook_event_name: "Stop",
    cwd: "/tmp",
  };
}

describe("agent event bus", () => {
  it("delivers events to subscribers and isolates them by event name", () => {
    const onPrompt = vi.fn();
    const onStop = vi.fn();
    subscribeAgentEvent("UserPromptSubmit", onPrompt);
    subscribeAgentEvent("Stop", onStop);

    emitAgentEvent(userPromptInput("hello"));
    expect(onPrompt).toHaveBeenCalledTimes(1);
    expect(onPrompt.mock.calls[0]?.[0]).toMatchObject({
      hook_event_name: "UserPromptSubmit",
      user_prompt: "hello",
    });
    expect(onStop).not.toHaveBeenCalled();

    emitAgentEvent(stopInput());
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onPrompt).toHaveBeenCalledTimes(1);
  });

  it("returns a disposer that removes the handler and cleans empty sets", () => {
    const handler = vi.fn();
    const dispose = subscribeAgentEvent("UserPromptSubmit", handler);
    expect(__agentEventListenerCountForTests("UserPromptSubmit")).toBe(1);

    dispose();
    expect(__agentEventListenerCountForTests("UserPromptSubmit")).toBe(0);

    emitAgentEvent(userPromptInput());
    expect(handler).not.toHaveBeenCalled();
  });

  it("swallows handler exceptions so one broken subscriber doesn't break others", () => {
    const broken = vi.fn(() => {
      throw new Error("boom");
    });
    const healthy = vi.fn();
    subscribeAgentEvent("UserPromptSubmit", broken);
    subscribeAgentEvent("UserPromptSubmit", healthy);

    expect(() => emitAgentEvent(userPromptInput())).not.toThrow();
    expect(broken).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it("fires for every executeEventHooks call, even with no shell hooks configured", async () => {
    const handler = vi.fn();
    subscribeAgentEvent("UserPromptSubmit", handler);

    // No hooks config provided — should still notify in-process subscribers.
    await executeEventHooks(userPromptInput("from-hooks"), "/tmp");

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toMatchObject({
      hook_event_name: "UserPromptSubmit",
      user_prompt: "from-hooks",
    });
  });

  it("does nothing when emitting with no subscribers", () => {
    expect(() => emitAgentEvent(userPromptInput())).not.toThrow();
  });
});
