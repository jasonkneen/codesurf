import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Bot } from "grammy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSinkState, sinks } from "../core/plugins/sinks";
import { createTelegramBridge } from "./bridge";
import { createTurnCoordinator, type TurnCoordinator } from "./turn-coordinator";

let mockSendMessage: ReturnType<typeof vi.fn>;
let mockSendDocument: ReturnType<typeof vi.fn>;
let mockOn: ReturnType<typeof vi.fn>;
let mockCommand: ReturnType<typeof vi.fn>;

vi.mock("grammy", () => ({
  Bot: vi.fn().mockImplementation(function BotMock() {
    return {
      api: { sendMessage: mockSendMessage },
      start: vi.fn(),
      stop: vi.fn(),
      catch: vi.fn(),
      command: vi.fn(),
      on: vi.fn(),
    };
  }),
  GrammyError: class GrammyErrorMock extends Error {},
  InputFile: class InputFileMock {
    constructor(
      public readonly file: string,
      public readonly filename?: string,
    ) {}
  },
}));

const MockedBot = vi.mocked(Bot);

function mockCoordinator(): TurnCoordinator {
  return { run: vi.fn((fn) => fn({ signal: new AbortController().signal })) } as unknown as TurnCoordinator;
}

describe("createTelegramBridge", () => {
  describe("sendDm", () => {
    beforeEach(() => {
      mockSendMessage = vi.fn().mockResolvedValue(undefined);
      MockedBot.mockImplementation(function BotMock() {
        return {
          api: { sendMessage: mockSendMessage },
          start: vi.fn(),
          stop: vi.fn(),
          catch: vi.fn(),
          command: vi.fn(),
          on: vi.fn(),
        } as never;
      } as never);
    });

    it("sends short messages without splitting", async () => {
      const bridge = createTelegramBridge({
        token: "test-token",
        getApprovedUserIds: () => [],
        coordinator: mockCoordinator(),
        getTelegramAgent: vi.fn(),
      });

      await bridge.sendDm(123, "Hello, world!");

      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      expect(mockSendMessage).toHaveBeenCalledWith(123, "Hello, world!");
    });

    it("splits long messages and sends each part", async () => {
      const bridge = createTelegramBridge({
        token: "test-token",
        getApprovedUserIds: () => [],
        coordinator: mockCoordinator(),
        getTelegramAgent: vi.fn(),
      });

      const longMessage = "a".repeat(5000);
      await bridge.sendDm(123, longMessage);

      expect(mockSendMessage).toHaveBeenCalledTimes(2);
      expect(mockSendMessage).toHaveBeenNthCalledWith(1, 123, "a".repeat(4096));
      expect(mockSendMessage).toHaveBeenNthCalledWith(2, 123, "a".repeat(904));
    });

    it("handles empty messages", async () => {
      const bridge = createTelegramBridge({
        token: "test-token",
        getApprovedUserIds: () => [],
        coordinator: mockCoordinator(),
        getTelegramAgent: vi.fn(),
      });

      await bridge.sendDm(123, "");

      expect(mockSendMessage).toHaveBeenCalledTimes(0);
    });

    it("sends multiple parts for message exactly at limit", async () => {
      const bridge = createTelegramBridge({
        token: "test-token",
        getApprovedUserIds: () => [],
        coordinator: mockCoordinator(),
        getTelegramAgent: vi.fn(),
      });

      const exactLimitMessage = "a".repeat(4096);
      await bridge.sendDm(123, exactLimitMessage);

      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      expect(mockSendMessage).toHaveBeenCalledWith(123, "a".repeat(4096));
    });
  });
});

describe("createTelegramBridge chat isolation", () => {
  type Handler = (ctx: Record<string, unknown>) => Promise<void>;

  function setupBot() {
    mockSendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
    mockSendDocument = vi.fn().mockResolvedValue({ message_id: 2 });
    mockOn = vi.fn();
    mockCommand = vi.fn();
    MockedBot.mockImplementation(function BotMock() {
      return {
        api: {
          sendMessage: mockSendMessage,
          sendDocument: mockSendDocument,
          sendChatAction: vi.fn().mockResolvedValue(true),
          editMessageText: vi.fn().mockResolvedValue(true),
        },
        start: vi.fn(),
        stop: vi.fn(),
        catch: vi.fn(),
        command: mockCommand,
        on: mockOn,
      } as never;
    } as never);
  }

  function handlerFor(mock: ReturnType<typeof vi.fn>, event: string): Handler {
    const call = mock.mock.calls.find(([name]) => name === event);
    if (!call) throw new Error(`no handler registered for ${event}`);
    return call[1] as Handler;
  }

  function fakeAgent() {
    return {
      abort: vi.fn(),
      getChatEntries: () => [],
      processMessage: async function* () {
        yield { type: "content", content: "hello from agent" };
      },
    } as never;
  }

  afterEach(() => {
    resetSinkState();
  });

  it("ignores messages from an approved user that arrive in a group chat", async () => {
    setupBot();
    const getTelegramAgent = vi.fn(() => fakeAgent());
    const coordinator = mockCoordinator();
    createTelegramBridge({
      token: "test-token",
      getApprovedUserIds: () => [42],
      coordinator,
      getTelegramAgent,
    });

    const reply = vi.fn().mockResolvedValue(undefined);
    await handlerFor(
      mockOn,
      "message:text",
    )({
      chat: { id: -100123, type: "supergroup" },
      from: { id: 42 },
      message: { message_id: 7, text: "what did we discuss privately?" },
      reply,
    });

    expect(getTelegramAgent).not.toHaveBeenCalled();
    expect(coordinator.run).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("does not hand out pairing codes in group chats", async () => {
    setupBot();
    createTelegramBridge({
      token: "test-token",
      getApprovedUserIds: () => [],
      coordinator: mockCoordinator(),
      getTelegramAgent: vi.fn(),
    });

    const reply = vi.fn().mockResolvedValue(undefined);
    await handlerFor(mockCommand, "pair")({ chat: { id: -1, type: "group" }, from: { id: 9 }, reply });
    expect(reply).not.toHaveBeenCalled();
  });

  it("still routes a private-chat message from an approved user to their agent", async () => {
    setupBot();
    const getTelegramAgent = vi.fn(() => fakeAgent());
    const coordinator = mockCoordinator();
    createTelegramBridge({
      token: "test-token",
      getApprovedUserIds: () => [42],
      coordinator,
      getTelegramAgent,
    });

    const reply = vi.fn().mockResolvedValue(undefined);
    await handlerFor(
      mockOn,
      "message:text",
    )({
      chat: { id: 42, type: "private" },
      from: { id: 42 },
      message: { message_id: 8, text: "hello" },
      reply,
    });

    expect(getTelegramAgent).toHaveBeenCalledWith(42);
    expect(coordinator.run).toHaveBeenCalledTimes(1);
  });
});

// NET-6: `coordinator.reset()` (the TUI's abort) only fenced *queued* turns.
// A Telegram turn already running kept the global sink and cleared it
// unconditionally in `finally`, so a late finalizer could unbind the sink of
// the turn that replaced it, and the stale turn could keep sending.
describe("createTelegramBridge sink ownership (NET-6)", () => {
  type Handler = (ctx: Record<string, unknown>) => Promise<void>;

  function handlerFor(mock: ReturnType<typeof vi.fn>, event: string): Handler {
    const call = mock.mock.calls.find(([name]) => name === event);
    if (!call) throw new Error(`no handler registered for ${event}`);
    return call[1] as Handler;
  }

  /** Streams one chunk, then holds the turn open until released. */
  function hangingAgent(label: string) {
    let release: () => void = () => {};
    const agent = {
      abort: vi.fn(),
      getChatEntries: () => [],
      processMessage: async function* () {
        yield { type: "content", content: `${label} partial` };
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    };
    return { agent, release: () => release() };
  }

  let tempDir: string;
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-bridge-sink-"));
  });
  afterEach(() => {
    resetSinkState();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("a turn fenced out by reset cannot send and cannot unbind its successor's sink", async () => {
    mockSendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
    mockSendDocument = vi.fn().mockResolvedValue({ message_id: 2 });
    mockOn = vi.fn();
    mockCommand = vi.fn();
    MockedBot.mockImplementation(function BotMock() {
      return {
        api: {
          sendMessage: mockSendMessage,
          sendDocument: mockSendDocument,
          sendChatAction: vi.fn().mockResolvedValue(true),
          editMessageText: vi.fn().mockResolvedValue(true),
        },
        start: vi.fn(),
        stop: vi.fn(),
        catch: vi.fn(),
        command: mockCommand,
        on: mockOn,
      } as never;
    } as never);

    const coordinator = createTurnCoordinator();
    const a = hangingAgent("A");
    const b = hangingAgent("B");
    createTelegramBridge({
      token: "test-token",
      getApprovedUserIds: () => [42, 43],
      coordinator,
      getTelegramAgent: (userId) => (userId === 42 ? a.agent : b.agent) as never,
    });
    const onText = handlerFor(mockOn, "message:text");
    const message = (chatId: number, messageId: number, text: string) => ({
      chat: { id: chatId, type: "private" },
      from: { id: chatId },
      message: { message_id: messageId, text },
      reply: vi.fn().mockResolvedValue(undefined),
    });

    // Turn A holds the sink.
    const turnA = onText(message(42, 1, "a"));
    await vi.waitFor(() => expect(sinks.telegram).not.toBeNull());
    const sinkA = sinks.telegram as NonNullable<typeof sinks.telegram>;

    // The user aborts (Ctrl+X → coordinator.reset()). A is fenced and told to stop.
    coordinator.reset();
    expect(a.agent.abort).toHaveBeenCalledTimes(1);

    // Turn B starts on the fresh chain with its own destination.
    const turnB = onText(message(43, 2, "b"));
    await vi.waitFor(() => expect(sinks.telegram).not.toBe(sinkA));
    const sinkB = sinks.telegram as NonNullable<typeof sinks.telegram>;

    // A finishes late: its finalizer must not unbind B.
    a.release();
    await turnA;
    expect(sinks.telegram).toBe(sinkB);
    expect(b.agent.abort).not.toHaveBeenCalled();

    // B still owns the destination: a send through the global sink lands in chat 43.
    const file = path.join(tempDir, "report.txt");
    fs.writeFileSync(file, "report");
    await expect(sinks.telegram?.(file)).resolves.toMatchObject({ success: true });
    expect(mockSendDocument).toHaveBeenCalledTimes(1);
    expect(mockSendDocument.mock.calls[0]?.[0]).toBe(43);

    // A cannot send: its own sink is fenced and never reaches the API.
    await expect(sinkA(file)).resolves.toMatchObject({ success: false });
    expect(mockSendDocument).toHaveBeenCalledTimes(1);

    b.release();
    await turnB;
    expect(sinks.telegram).toBeNull();
  });
});
