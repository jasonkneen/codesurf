import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../../agent/agent";
import type { AppStartupConfig } from "../app-helpers";

// Render-free harness (see use-plan-actions.test.ts): useCallback is identity,
// useEffect runs inline, and useRef returns the same box per call slot across
// "renders" (render() resets the slot cursor), like React does.
const slots = vi.hoisted(() => ({ refs: [] as Array<{ current: unknown }>, cursor: 0 }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: <T>(fn: T) => fn,
    useRef: <T>(init: T) => {
      const index = slots.cursor++;
      slots.refs[index] ??= { current: init };
      return slots.refs[index] as { current: T };
    },
    useEffect: (fn: () => unknown) => {
      fn();
    },
  };
});

const h = vi.hoisted(() => {
  const token = { current: undefined as string | undefined };
  const bridgeOpts: Array<{
    getTelegramAgent: (userId: number) => unknown;
    onTurnAborted?: (event: { turnKey: string; userId: number }) => void;
  }> = [];
  const agentOptions: Array<Record<string, unknown>> = [];
  const telegram = {
    coordinatorRef: { current: { run: vi.fn(), reset: vi.fn() } },
    bridgeRef: { current: null as unknown },
    telegramAgentsRef: { current: new Map<number, unknown>() },
    telegramEntryCountsRef: { current: new Map<number, number>() },
    telegramSubagentUnsubsRef: { current: new Map<number, () => void>() },
    stoppedTelegramTurnKeysRef: { current: new Set<string>() },
  };
  const activeTurnRef = { current: null as { kind: string; remoteKey?: string } | null };
  return { token, bridgeOpts, agentOptions, telegram, activeTurnRef };
});

vi.mock("../../agent/agent", () => ({
  Agent: class {
    constructor(_k: unknown, _b: unknown, _m: unknown, _r: unknown, options: Record<string, unknown>) {
      h.agentOptions.push(options);
    }
    getSessionId() {
      return "sess";
    }
    getChatEntries() {
      return [];
    }
    onSubagentStatus() {
      return () => {};
    }
  },
}));
vi.mock("../../core/plugins", () => ({ listPlugins: () => [] }));
vi.mock("../../utils/settings", () => ({
  getTelegramBotToken: () => h.token.current,
  loadUserSettings: () => ({ telegram: { sessionsByUserId: { "1": "sess" } } }),
  saveUserSettings: vi.fn(),
}));
vi.mock("../context/conversation-state-context.js", () => ({
  useConversationState: () => ({
    activeTurnRef: h.activeTurnRef,
    contentAccRef: { current: "" },
    setMessages: vi.fn(),
    setActiveSubagent: vi.fn(),
  }),
}));
vi.mock("../context/telegram-context.js", () => ({ useTelegram: () => h.telegram }));
vi.mock("../context/toast-context.js", () => ({ useToast: () => ({ pushToast: vi.fn() }) }));
vi.mock("../../telegram/bridge", () => ({
  createTelegramBridge: (opts: (typeof h.bridgeOpts)[number]) => {
    h.bridgeOpts.push(opts);
    return { start: vi.fn(), stop: vi.fn(async () => {}) };
  },
}));

import { type TelegramBridgeParams, useTelegramBridge } from "./use-telegram-bridge";

const flush = () => new Promise<void>((r) => setImmediate(r));

// Named as a hook: it calls the hook under test (rules-of-hooks lint).
function useRender(p: TelegramBridgeParams) {
  slots.cursor = 0;
  return useTelegramBridge(p);
}

function params(sandboxMode: TelegramBridgeParams["sandboxMode"]): TelegramBridgeParams {
  return {
    agent: {} as Agent,
    beginLiveTurn: vi.fn(),
    scrollToBottom: vi.fn(),
    finalizeActiveTurn: vi.fn(),
    showLiveToolCalls: vi.fn(),
    appendLiveToolResult: vi.fn(),
    startupConfig: { apiKey: "k", model: "m" } as unknown as AppStartupConfig,
    getApiKey: () => "k",
    sandboxMode,
    sandboxSettings: {},
  };
}

beforeEach(() => {
  slots.refs = [];
  h.token.current = undefined;
  h.bridgeOpts.length = 0;
  h.agentOptions.length = 0;
  h.telegram.bridgeRef.current = null;
  h.telegram.telegramAgentsRef.current = new Map();
  h.telegram.stoppedTelegramTurnKeysRef.current = new Set();
  h.activeTurnRef.current = null;
});

describe("useTelegramBridge start ref", () => {
  it("is a real starter even when no token existed at mount", async () => {
    const { startTelegramBridgeRef } = useRender(params("off"));
    expect(h.bridgeOpts).toHaveLength(0);

    // No token yet: reports that nothing started.
    expect(startTelegramBridgeRef.current()).toBe(false);

    // Token added later (via /connect) -> the ref starts polling.
    h.token.current = "123:abc";
    expect(startTelegramBridgeRef.current()).toBe(true);
    await flush();
    expect(h.bridgeOpts).toHaveLength(1);
  });
});

describe("useTelegramBridge sandbox settings", () => {
  it("creates telegram agents with the current sandbox mode, not the one at bridge start", async () => {
    h.token.current = "123:abc";
    useRender(params("off"));
    await flush();
    expect(h.bridgeOpts).toHaveLength(1);

    // Re-render after the user changed the sandbox mode; the bridge object
    // (and the getTelegramAgent it captured) is unchanged.
    h.telegram.bridgeRef.current = { start: vi.fn(), stop: vi.fn() };
    useRender(params("shuru"));

    h.bridgeOpts[0]!.getTelegramAgent(1);
    expect(h.agentOptions.at(-1)?.sandboxMode).toBe("shuru");
  });
});

describe("useTelegramBridge after the user stops a telegram turn", () => {
  it("drops late bridge events for the stopped turn instead of re-opening a live turn", () => {
    const p = params("off");
    const bridge = useRender(p);
    h.telegram.stoppedTelegramTurnKeysRef.current.add("chat1:msg7");

    bridge.upsertTelegramAssistantMessage({ turnKey: "chat1:msg7", userId: 1, content: "late", done: false });
    bridge.showTelegramToolCalls({ turnKey: "chat1:msg7", userId: 1, toolCalls: [] });
    bridge.appendTelegramToolResult({
      turnKey: "chat1:msg7",
      userId: 1,
      toolCall: { id: "t", type: "function", function: { name: "bash", arguments: "{}" } },
      toolResult: { success: true, output: "" },
    });

    expect(p.beginLiveTurn).not.toHaveBeenCalled();
    expect(p.showLiveToolCalls).not.toHaveBeenCalled();
    expect(p.appendLiveToolResult).not.toHaveBeenCalled();

    // A different (new) turn still opens normally.
    bridge.upsertTelegramAssistantMessage({ turnKey: "chat1:msg8", userId: 1, content: "hi", done: false });
    expect(p.beginLiveTurn).toHaveBeenCalledTimes(1);
  });
});

describe("useTelegramBridge onTurnAborted", () => {
  it("is passed to the bridge and closes the matching live turn as interrupted", async () => {
    h.token.current = "123:abc";
    const p = params("off");
    useRender(p);
    await flush();
    const onTurnAborted = h.bridgeOpts[0]!.onTurnAborted;
    expect(onTurnAborted).toBeTypeOf("function");

    h.activeTurnRef.current = { kind: "telegram", remoteKey: "chat1:msg7" };
    onTurnAborted!({ turnKey: "chat1:msg7", userId: 1 });

    expect(p.finalizeActiveTurn).toHaveBeenCalledWith({ wasInterrupted: true });
    expect(h.telegram.stoppedTelegramTurnKeysRef.current.has("chat1:msg7")).toBe(true);
  });

  it("only marks the key when the UI already moved on (no finalize of another turn)", () => {
    const p = params("off");
    const bridge = useRender(p);
    h.activeTurnRef.current = { kind: "local" };

    bridge.handleTelegramTurnAborted({ turnKey: "chat1:msg7", userId: 1 });

    expect(p.finalizeActiveTurn).not.toHaveBeenCalled();
    expect(h.telegram.stoppedTelegramTurnKeysRef.current.has("chat1:msg7")).toBe(true);
  });
});
