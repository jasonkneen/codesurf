// M7 (telegram side): a turn cancelled after onUserMessage must tell the UI it
// ended (onTurnAborted) instead of returning silently, in both streaming modes.

import { afterEach, describe, expect, it, vi } from "vitest";
import { resetSinkState } from "../core/plugins/sinks";
import { createTelegramBridge, type TelegramBridgeOptions } from "./bridge";
import { createTurnCoordinator } from "./turn-coordinator";

const harness = vi.hoisted(() => ({
  on: undefined as unknown as { mock: { calls: unknown[][] } },
  streaming: "off" as "off" | "partial",
}));

vi.mock("grammy", () => ({
  Bot: vi.fn().mockImplementation(function BotMock() {
    const on = vi.fn();
    harness.on = on;
    return {
      api: {
        sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
        sendChatAction: vi.fn().mockResolvedValue(true),
        editMessageText: vi.fn().mockResolvedValue(true),
      },
      start: vi.fn(),
      stop: vi.fn(),
      catch: vi.fn(),
      command: vi.fn(),
      on,
    };
  }),
  GrammyError: class GrammyErrorMock extends Error {},
  InputFile: class InputFileMock {},
}));

vi.mock("../utils/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/settings")>()),
  loadUserSettings: () => ({ telegram: { streaming: harness.streaming, typingIndicator: false } }),
}));

afterEach(() => resetSinkState());

/** Streams one chunk, then waits until aborted and ends like a cancelled Agent turn. */
function abortableAgent() {
  let aborted: () => void = () => {};
  const stopped = new Promise<void>((resolve) => (aborted = resolve));
  return {
    abort: vi.fn(() => aborted()),
    getChatEntries: () => [],
    processMessage: async function* () {
      yield { type: "content", content: "partial" };
      await stopped;
    },
  };
}

async function runAbortedTurn(streaming: "off" | "partial") {
  harness.streaming = streaming;
  const coordinator = createTurnCoordinator();
  const agent = abortableAgent();
  const onTurnAborted = vi.fn();
  const onAssistantMessage = vi.fn();
  createTelegramBridge({
    token: "t",
    getApprovedUserIds: () => [42],
    coordinator,
    getTelegramAgent: () => agent as never,
    onAssistantMessage,
    onTurnAborted,
  } satisfies TelegramBridgeOptions);
  const call = harness.on.mock.calls.find(([name]) => name === "message:text");
  const onText = call?.[1] as (ctx: Record<string, unknown>) => Promise<void>;
  const turn = onText({
    chat: { id: 42, type: "private" },
    from: { id: 42 },
    message: { message_id: 7, text: "hi" },
    reply: vi.fn().mockResolvedValue(undefined),
  });
  await vi.waitFor(() => expect(onAssistantMessage).toHaveBeenCalled());
  coordinator.reset(); // the TUI's abort
  await turn;
  return { onTurnAborted, onAssistantMessage };
}

describe("createTelegramBridge onTurnAborted", () => {
  for (const streaming of ["off", "partial"] as const) {
    it(`reports a cancelled turn once, with no done:true message (streaming ${streaming})`, async () => {
      const { onTurnAborted, onAssistantMessage } = await runAbortedTurn(streaming);
      expect(onTurnAborted).toHaveBeenCalledTimes(1);
      expect(onTurnAborted).toHaveBeenCalledWith({ turnKey: "telegram:42:7", userId: 42 });
      expect(onAssistantMessage.mock.calls.some(([e]) => (e as { done: boolean }).done)).toBe(false);
    });
  }
});
