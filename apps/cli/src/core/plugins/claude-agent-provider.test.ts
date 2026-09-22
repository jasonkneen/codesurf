import type {
  Options as ClaudeAgentOptions,
  Query as ClaudeAgentQuery,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import type { ProviderStreamEvent, ProviderTurnInput } from "./api";
import { AsyncPushQueue, ClaudeAgentSession, hostAutoAllowsTool } from "./native/claude-agent-provider";

function makeTurnInput(overrides: Partial<ProviderTurnInput> = {}): ProviderTurnInput {
  return {
    conversationId: "test-conv",
    providerId: "anthropic",
    adapterId: "anthropic.agent-sdk",
    modelId: "claude-sonnet-4-5",
    prompt: "hello",
    messages: [],
    ...overrides,
  };
}

function makeMockQuery(messages: SDKMessage[]): { query: ClaudeAgentQuery; interrupt: ReturnType<typeof vi.fn> } {
  // Async generator that yields each message, returning done when exhausted.
  const interrupt = vi.fn(async () => undefined);
  async function* iterator() {
    for (const msg of messages) {
      yield msg;
    }
  }
  const generator = iterator();
  const query = Object.assign(generator, {
    interrupt,
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    setMaxThinkingTokens: vi.fn(async () => undefined),
    supportedCommands: vi.fn(async () => ({ commands: [] })),
    supportedModels: vi.fn(async () => []),
    mcpServerStatus: vi.fn(async () => ({ mcpServers: [] })),
    streamInput: vi.fn(async () => undefined),
  }) as unknown as ClaudeAgentQuery;
  return { query, interrupt };
}

/** A query whose stream stays open until `queue.close()` — the shape of a live
 *  SDK subprocess. An exhausted stream means the subprocess is gone. */
function makeOpenQuery(): {
  query: ClaudeAgentQuery;
  queue: AsyncPushQueue<SDKMessage>;
  interrupt: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
} {
  const queue = new AsyncPushQueue<SDKMessage>();
  const interrupt = vi.fn(async () => undefined);
  const setModel = vi.fn(async () => undefined);
  const query = Object.assign(queue.iterable, {
    interrupt,
    setPermissionMode: vi.fn(async () => undefined),
    setModel,
    setMaxThinkingTokens: vi.fn(async () => undefined),
    supportedCommands: vi.fn(async () => ({ commands: [] })),
    supportedModels: vi.fn(async () => []),
    mcpServerStatus: vi.fn(async () => ({ mcpServers: [] })),
    streamInput: vi.fn(async () => undefined),
  }) as unknown as ClaudeAgentQuery;
  return { query, queue, interrupt, setModel };
}

describe("hostAutoAllowsTool", () => {
  it("auto-allows every tool under yolo and dontAsk", () => {
    expect(hostAutoAllowsTool("bypassPermissions", "Bash")).toBe(true);
    expect(hostAutoAllowsTool("dontAsk", "Bash")).toBe(true);
    expect(hostAutoAllowsTool("bypassPermissions", "Write")).toBe(true);
  });

  it("auto-allows file edits only under acceptEdits", () => {
    expect(hostAutoAllowsTool("acceptEdits", "Write")).toBe(true);
    expect(hostAutoAllowsTool("acceptEdits", "Edit")).toBe(true);
    expect(hostAutoAllowsTool("acceptEdits", "MultiEdit")).toBe(true);
    expect(hostAutoAllowsTool("acceptEdits", "Bash")).toBe(false);
  });

  it("still prompts in default / auto / plan", () => {
    expect(hostAutoAllowsTool("default", "Bash")).toBe(false);
    expect(hostAutoAllowsTool("auto", "Bash")).toBe(false);
    expect(hostAutoAllowsTool("plan", "Bash")).toBe(false);
  });
});

describe("AsyncPushQueue", () => {
  it("delivers pushed values in order", async () => {
    const q = new AsyncPushQueue<number>();
    q.push(1);
    q.push(2);
    q.push(3);
    q.close();
    const collected: number[] = [];
    for await (const v of q.iterable) collected.push(v);
    expect(collected).toEqual([1, 2, 3]);
  });

  it("supports interleaved push + await", async () => {
    const q = new AsyncPushQueue<string>();
    const iter = q.iterable[Symbol.asyncIterator]();
    const firstPromise = iter.next();
    q.push("a");
    const first = await firstPromise;
    expect(first).toEqual({ value: "a", done: false });
    q.push("b");
    q.close();
    expect(await iter.next()).toEqual({ value: "b", done: false });
    expect(await iter.next()).toEqual({ value: undefined, done: true });
  });

  it("drops pushes after close", async () => {
    const q = new AsyncPushQueue<number>();
    q.close();
    q.push(1);
    const collected: number[] = [];
    for await (const v of q.iterable) collected.push(v);
    expect(collected).toEqual([]);
  });
});

describe("ClaudeAgentSession", () => {
  function sessionWith(messages: SDKMessage[]): {
    session: ClaudeAgentSession;
    interrupt: ReturnType<typeof vi.fn>;
  } {
    const { query, interrupt } = makeMockQuery(messages);
    const session = new ClaudeAgentSession({
      adapterId: "anthropic.agent-sdk",
      queryFactory: (_params: { prompt: AsyncIterable<SDKUserMessage>; options: ClaudeAgentOptions }) => query,
      options: { model: "claude-sonnet-4-5" },
    });
    return { session, interrupt };
  }

  it("resolves sendTurn with usage from a success result", async () => {
    const { session } = sessionWith([
      {
        type: "assistant",
        message: {
          id: "m1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Hello " }],
          model: "claude-sonnet-4-5",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        uuid: "u1" as unknown as ReturnType<typeof crypto.randomUUID>,
        session_id: "s1",
      } as unknown as SDKMessage,
      {
        type: "assistant",
        message: {
          id: "m2",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "world!" }],
          model: "claude-sonnet-4-5",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        uuid: "u2" as unknown as ReturnType<typeof crypto.randomUUID>,
        session_id: "s1",
      } as unknown as SDKMessage,
      {
        type: "result",
        subtype: "success",
        duration_ms: 100,
        duration_api_ms: 90,
        is_error: false,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        total_cost_usd: 0.01,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        modelUsage: {},
        permission_denials: [],
        uuid: "u3" as unknown as ReturnType<typeof crypto.randomUUID>,
        session_id: "s1",
      } as unknown as SDKMessage,
    ]);

    const events: ProviderStreamEvent[] = [];
    const result = await session.sendTurn(makeTurnInput(), {
      emit: (event) => events.push(event),
    });

    expect(result.usage?.inputTokens).toBe(10);
    expect(result.usage?.outputTokens).toBe(5);
    const deltas = events.filter((e) => e.type === "text-delta");
    expect(deltas.map((e) => (e as { delta: string }).delta)).toEqual(["Hello ", "world!"]);
    expect(events.some((e) => e.type === "done")).toBe(true);
    await session.disconnect();
  });

  it("rejects sendTurn on a result error", async () => {
    const { session } = sessionWith([
      {
        type: "result",
        subtype: "error_max_turns",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: true,
        num_turns: 1,
        total_cost_usd: 0,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        modelUsage: {},
        permission_denials: [],
        uuid: "u-err" as unknown as ReturnType<typeof crypto.randomUUID>,
        session_id: "s1",
      } as unknown as SDKMessage,
    ]);

    const events: ProviderStreamEvent[] = [];
    await expect(session.sendTurn(makeTurnInput(), { emit: (e) => events.push(e) })).rejects.toThrow(
      /Claude Agent SDK error/,
    );
    expect(events.some((e) => e.type === "error")).toBe(true);
    await session.disconnect();
  });

  it("steers a concurrent sendTurn: settles old turn, interrupts SDK, drains old result", async () => {
    // Build a controllable query backed by AsyncPushQueue so we can
    // push messages on demand and verify the drain behavior.
    const queue = new AsyncPushQueue<SDKMessage>();
    const interrupt = vi.fn(async () => undefined);
    const query = Object.assign(queue.iterable, {
      interrupt,
      setPermissionMode: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined),
      setMaxThinkingTokens: vi.fn(async () => undefined),
      supportedCommands: vi.fn(async () => ({ commands: [] })),
      supportedModels: vi.fn(async () => []),
      mcpServerStatus: vi.fn(async () => ({ mcpServers: [] })),
      streamInput: vi.fn(async () => undefined),
    }) as unknown as ClaudeAgentQuery;
    const session = new ClaudeAgentSession({
      adapterId: "anthropic.agent-sdk",
      queryFactory: () => query,
      options: {},
    });

    const firstEvents: ProviderStreamEvent[] = [];
    const firstTurn = session.sendTurn(makeTurnInput(), { emit: (e) => firstEvents.push(e) });
    await new Promise((r) => setTimeout(r, 10));

    const secondEvents: ProviderStreamEvent[] = [];
    const secondTurn = session.sendTurn(makeTurnInput(), { emit: (e) => secondEvents.push(e) });

    expect(interrupt).toHaveBeenCalled();
    expect(firstEvents.some((e) => e.type === "done" && (e as { stopReason?: string }).stopReason === "aborted")).toBe(
      true,
    );
    await expect(firstTurn).resolves.toBeDefined();

    // A stray assistant message from the interrupted old turn must be dropped.
    queue.push({
      type: "assistant",
      message: {
        id: "old",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "old-stray" }],
        model: "claude-sonnet-4-5",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: "u-old" as unknown as ReturnType<typeof crypto.randomUUID>,
      session_id: "s1",
    } as unknown as SDKMessage);
    await new Promise((r) => setTimeout(r, 20));
    expect(secondEvents.some((e) => e.type === "text-delta" && (e as { delta?: string }).delta === "old-stray")).toBe(
      false,
    );

    // Old turn's `result` clears the drain flag.
    queue.push({
      type: "result",
      subtype: "error_during_execution",
      duration_ms: 0,
      duration_api_ms: 0,
      is_error: true,
      num_turns: 1,
      session_id: "s1",
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {},
      permission_denials: [],
      uuid: "u-old-result" as unknown as ReturnType<typeof crypto.randomUUID>,
    } as unknown as SDKMessage);
    await new Promise((r) => setTimeout(r, 20));

    // Now an assistant message reaches the second turn.
    queue.push({
      type: "assistant",
      message: {
        id: "new",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "new-text" }],
        model: "claude-sonnet-4-5",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: "u-new" as unknown as ReturnType<typeof crypto.randomUUID>,
      session_id: "s1",
    } as unknown as SDKMessage);
    await new Promise((r) => setTimeout(r, 20));
    expect(secondEvents.some((e) => e.type === "text-delta" && (e as { delta?: string }).delta === "new-text")).toBe(
      true,
    );

    queue.close();
    await session.disconnect();
    await secondTurn.catch(() => {});
  });

  it("calls query.interrupt() on abortTurn", async () => {
    const { session, interrupt } = sessionWith([]);
    // Fire a turn so the query is actually instantiated (lazyStart).
    const turnPromise = session.sendTurn(makeTurnInput(), { emit: () => {} });
    await session.abortTurn();
    expect(interrupt).toHaveBeenCalled();
    await session.disconnect();
    await turnPromise.catch(() => {});
  });

  it("bakes the resolved permission mode into query() options at lazyStart", async () => {
    const { query } = makeMockQuery([]);
    const capturedOptions: ClaudeAgentOptions[] = [];
    const session = new ClaudeAgentSession({
      adapterId: "anthropic.agent-sdk",
      queryFactory: (params) => {
        capturedOptions.push(params.options);
        return query;
      },
      options: { model: "claude-sonnet-4-5" },
      getPermissionMode: () => "plan",
    });

    // Drive the lazyStart by firing a turn — we don't wait for its result.
    // Catch so the disconnect-induced rejection below doesn't become an
    // unhandled rejection.
    const turnPromise = session.sendTurn(makeTurnInput(), { emit: () => {} });
    turnPromise.catch(() => {});
    // Let the async IIFE reach lazyStart.
    await new Promise((r) => setTimeout(r, 10));

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0]?.permissionMode).toBe("plan");
    // Always-on so a later `/permissions yolo` can enter bypassPermissions
    // live without respawning the subprocess.
    expect((capturedOptions[0] as { allowDangerouslySkipPermissions?: boolean }).allowDangerouslySkipPermissions).toBe(
      true,
    );

    await session.disconnect();
    await turnPromise.catch(() => {});
  });

  it("bakes thinking and effort into query() options at lazyStart", async () => {
    const { query } = makeMockQuery([]);
    const capturedOptions: ClaudeAgentOptions[] = [];
    const session = new ClaudeAgentSession({
      adapterId: "anthropic.agent-sdk",
      queryFactory: (params) => {
        capturedOptions.push(params.options);
        return query;
      },
      options: { model: "claude-opus-4-7" },
      getThinking: () => ({ type: "enabled" }),
      getEffort: () => "xhigh",
    });

    const turnPromise = session.sendTurn(makeTurnInput(), { emit: () => {} });
    turnPromise.catch(() => {});
    await new Promise((r) => setTimeout(r, 10));

    expect(capturedOptions[0]?.thinking).toEqual({ type: "enabled" });
    expect(capturedOptions[0]?.effort).toBe("xhigh");

    await session.disconnect();
    await turnPromise.catch(() => {});
  });

  it("defaults to adaptive thinking and high effort when no resolvers are supplied", async () => {
    const { query } = makeMockQuery([]);
    const capturedOptions: ClaudeAgentOptions[] = [];
    const session = new ClaudeAgentSession({
      adapterId: "anthropic.agent-sdk",
      queryFactory: (params) => {
        capturedOptions.push(params.options);
        return query;
      },
      options: { model: "claude-sonnet-4-6" },
    });

    const turnPromise = session.sendTurn(makeTurnInput(), { emit: () => {} });
    turnPromise.catch(() => {});
    await new Promise((r) => setTimeout(r, 10));

    expect(capturedOptions[0]?.thinking).toEqual({ type: "adaptive" });
    expect(capturedOptions[0]?.effort).toBe("high");

    await session.disconnect();
    await turnPromise.catch(() => {});
  });

  it("sets allowDangerouslySkipPermissions:true when starting in bypassPermissions", async () => {
    const { query } = makeMockQuery([]);
    const capturedOptions: ClaudeAgentOptions[] = [];
    const session = new ClaudeAgentSession({
      adapterId: "anthropic.agent-sdk",
      queryFactory: (params) => {
        capturedOptions.push(params.options);
        return query;
      },
      options: { model: "claude-sonnet-4-5" },
      getPermissionMode: () => "bypassPermissions",
    });

    const turnPromise = session.sendTurn(makeTurnInput(), { emit: () => {} });
    turnPromise.catch(() => {});
    await new Promise((r) => setTimeout(r, 10));

    expect(capturedOptions[0]?.permissionMode).toBe("bypassPermissions");
    expect((capturedOptions[0] as { allowDangerouslySkipPermissions?: boolean }).allowDangerouslySkipPermissions).toBe(
      true,
    );

    await session.disconnect();
    await turnPromise.catch(() => {});
  });

  it("always sets allowDangerouslySkipPermissions so yolo can be entered live", async () => {
    const { query } = makeMockQuery([]);
    const capturedOptions: ClaudeAgentOptions[] = [];
    const session = new ClaudeAgentSession({
      adapterId: "anthropic.agent-sdk",
      queryFactory: (params) => {
        capturedOptions.push(params.options);
        return query;
      },
      options: { model: "claude-sonnet-4-5" },
      getPermissionMode: () => "default",
    });

    const turnPromise = session.sendTurn(makeTurnInput(), { emit: () => {} });
    turnPromise.catch(() => {});
    await new Promise((r) => setTimeout(r, 10));

    expect((capturedOptions[0] as { allowDangerouslySkipPermissions?: boolean }).allowDangerouslySkipPermissions).toBe(
      true,
    );

    await session.disconnect();
    await turnPromise.catch(() => {});
  });

  it("forwards a live switch into bypassPermissions via setPermissionMode", async () => {
    let mode: "default" | "bypassPermissions" = "default";
    const queue = new AsyncPushQueue<SDKMessage>();
    const setPermissionMode = vi.fn(async () => undefined);
    const query = Object.assign(queue.iterable, {
      interrupt: vi.fn(async () => undefined),
      setPermissionMode,
      setModel: vi.fn(async () => undefined),
      setMaxThinkingTokens: vi.fn(async () => undefined),
      supportedCommands: vi.fn(async () => ({ commands: [] })),
      supportedModels: vi.fn(async () => []),
      mcpServerStatus: vi.fn(async () => ({ mcpServers: [] })),
      streamInput: vi.fn(async () => undefined),
    }) as unknown as ClaudeAgentQuery;

    const session = new ClaudeAgentSession({
      adapterId: "anthropic.agent-sdk",
      queryFactory: () => query,
      options: { model: "claude-sonnet-4-5" },
      getPermissionMode: () => mode,
    });

    const first = session.sendTurn(makeTurnInput(), { emit: () => {} });
    await new Promise((r) => setTimeout(r, 10));
    queue.push({
      type: "result",
      subtype: "success",
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: false,
      num_turns: 1,
      result: "done",
      stop_reason: "end_turn",
      total_cost_usd: 0,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      modelUsage: {},
      permission_denials: [],
      uuid: "u-r1" as unknown as ReturnType<typeof crypto.randomUUID>,
      session_id: "s1",
    } as unknown as SDKMessage);
    await first;
    expect(setPermissionMode).not.toHaveBeenCalled();

    mode = "bypassPermissions";
    const second = session.sendTurn(makeTurnInput({ prompt: "again" }), { emit: () => {} });
    await new Promise((r) => setTimeout(r, 10));
    expect(setPermissionMode).toHaveBeenCalledWith("bypassPermissions");
    queue.push({
      type: "result",
      subtype: "success",
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: false,
      num_turns: 1,
      result: "done",
      stop_reason: "end_turn",
      total_cost_usd: 0,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      modelUsage: {},
      permission_denials: [],
      uuid: "u-r2" as unknown as ReturnType<typeof crypto.randomUUID>,
      session_id: "s1",
    } as unknown as SDKMessage);
    queue.close();
    await second;
    await session.disconnect();
  });

  it("canUseTool auto-allows Bash under dontAsk without emitting a permission prompt", async () => {
    const queue = new AsyncPushQueue<SDKMessage>();
    let captured:
      | ((toolName: string, input: Record<string, unknown>, options: unknown) => Promise<unknown>)
      | undefined;
    const query = Object.assign(queue.iterable, {
      interrupt: vi.fn(async () => undefined),
      setPermissionMode: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined),
      setMaxThinkingTokens: vi.fn(async () => undefined),
      supportedCommands: vi.fn(async () => ({ commands: [] })),
      supportedModels: vi.fn(async () => []),
      mcpServerStatus: vi.fn(async () => ({ mcpServers: [] })),
      streamInput: vi.fn(async () => undefined),
    }) as unknown as ClaudeAgentQuery;
    const events: ProviderStreamEvent[] = [];
    const session = new ClaudeAgentSession({
      adapterId: "anthropic.agent-sdk",
      queryFactory: (params) => {
        captured = params.options.canUseTool as unknown as typeof captured;
        return query;
      },
      options: { model: "claude-sonnet-4-5" },
      getPermissionMode: () => "dontAsk",
    });

    const turnPromise = session.sendTurn(makeTurnInput(), { emit: (e) => events.push(e) });
    turnPromise.catch(() => {});
    await new Promise((r) => setTimeout(r, 10));

    const ac = new AbortController();
    const result = (await captured?.("Bash", { command: "ls" }, { signal: ac.signal, toolUseID: "tu-1" })) as {
      behavior: string;
    };
    expect(result.behavior).toBe("allow");
    expect(events.some((e) => e.type === "tool-approval-request")).toBe(false);

    queue.close();
    await session.disconnect();
    await turnPromise.catch(() => {});
  });

  it("canUseTool auto-allows Bash under bypassPermissions (yolo)", async () => {
    const queue = new AsyncPushQueue<SDKMessage>();
    let captured:
      | ((toolName: string, input: Record<string, unknown>, options: unknown) => Promise<unknown>)
      | undefined;
    const query = Object.assign(queue.iterable, {
      interrupt: vi.fn(async () => undefined),
      setPermissionMode: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined),
      setMaxThinkingTokens: vi.fn(async () => undefined),
      supportedCommands: vi.fn(async () => ({ commands: [] })),
      supportedModels: vi.fn(async () => []),
      mcpServerStatus: vi.fn(async () => ({ mcpServers: [] })),
      streamInput: vi.fn(async () => undefined),
    }) as unknown as ClaudeAgentQuery;
    const events: ProviderStreamEvent[] = [];
    const session = new ClaudeAgentSession({
      adapterId: "anthropic.agent-sdk",
      queryFactory: (params) => {
        captured = params.options.canUseTool as unknown as typeof captured;
        return query;
      },
      options: { model: "claude-sonnet-4-5" },
      getPermissionMode: () => "bypassPermissions",
    });

    const turnPromise = session.sendTurn(makeTurnInput(), { emit: (e) => events.push(e) });
    turnPromise.catch(() => {});
    await new Promise((r) => setTimeout(r, 10));

    const ac = new AbortController();
    const result = (await captured?.("Bash", { command: "ls" }, { signal: ac.signal, toolUseID: "tu-1" })) as {
      behavior: string;
    };
    expect(result.behavior).toBe("allow");
    expect(events.some((e) => e.type === "tool-approval-request")).toBe(false);

    queue.close();
    await session.disconnect();
    await turnPromise.catch(() => {});
  });

  it("canUseTool still prompts in default mode", async () => {
    const queue = new AsyncPushQueue<SDKMessage>();
    let captured:
      | ((toolName: string, input: Record<string, unknown>, options: unknown) => Promise<unknown>)
      | undefined;
    const query = Object.assign(queue.iterable, {
      interrupt: vi.fn(async () => undefined),
      setPermissionMode: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined),
      setMaxThinkingTokens: vi.fn(async () => undefined),
      supportedCommands: vi.fn(async () => ({ commands: [] })),
      supportedModels: vi.fn(async () => []),
      mcpServerStatus: vi.fn(async () => ({ mcpServers: [] })),
      streamInput: vi.fn(async () => undefined),
    }) as unknown as ClaudeAgentQuery;
    const events: ProviderStreamEvent[] = [];
    const session = new ClaudeAgentSession({
      adapterId: "anthropic.agent-sdk",
      queryFactory: (params) => {
        captured = params.options.canUseTool as unknown as typeof captured;
        return query;
      },
      options: { model: "claude-sonnet-4-5" },
    });

    const turnPromise = session.sendTurn(makeTurnInput(), { emit: (e) => events.push(e) });
    turnPromise.catch(() => {});
    await new Promise((r) => setTimeout(r, 10));

    const ac = new AbortController();
    const pending = captured?.("Bash", { command: "ls" }, { signal: ac.signal, toolUseID: "tu-1" });
    await new Promise((r) => setTimeout(r, 10));
    const prompt = events.find((e) => e.type === "tool-approval-request") as
      | { type: "tool-approval-request"; approvalId: string }
      | undefined;
    expect(prompt).toBeTruthy();
    session.respondToToolApproval(prompt!.approvalId, true);
    const result = (await pending) as { behavior: string };
    expect(result.behavior).toBe("allow");

    queue.close();
    await session.disconnect();
    await turnPromise.catch(() => {});
  });

  it("synthesizes a history preface on the first sendTurn when the host has prior messages", async () => {
    // Capture the SDKUserMessage that the session pushes onto the SDK's input
    // iterable. This is the only observable side-effect we have for the
    // preface logic, so we drain the prompt iterable from the queryFactory.
    const pushed: SDKUserMessage[] = [];
    let captureDone: (() => void) | undefined;
    const captureCompletion = new Promise<void>((resolve) => {
      captureDone = resolve;
    });

    const { query, queue } = makeOpenQuery();
    const session = new ClaudeAgentSession({
      adapterId: "anthropic.agent-sdk",
      queryFactory: (params) => {
        // Drain the prompt iterable in the background — this is what the
        // SDK subprocess would normally do.
        (async () => {
          for await (const msg of params.prompt) {
            pushed.push(msg);
            captureDone?.();
            break; // We only care about the first push for this test.
          }
        })().catch(() => {});
        return query;
      },
      options: { model: "claude-sonnet-4-5" },
    });

    // Simulate a /sessions resume: prior transcript rehydrated, last entry
    // is the new user prompt. The agent passes both.
    const turnPromise = session.sendTurn(
      makeTurnInput({
        prompt: "what file did we edit?",
        messages: [
          { role: "user", content: "please refactor foo.ts" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "I'll start by reading it." },
              {
                type: "tool-call",
                toolName: "Read",
                args: { file_path: "/tmp/foo.ts" },
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolName: "Read",
                result: "export const foo = 1;",
              },
            ],
          },
          { role: "assistant", content: "Done — renamed to bar." },
          { role: "user", content: "what file did we edit?" },
        ],
      }),
      { emit: () => {} },
    );
    turnPromise.catch(() => {});

    await captureCompletion;

    expect(pushed).toHaveLength(1);
    const content = pushed[0]?.message?.content;
    expect(typeof content).toBe("string");
    const text = String(content);
    // Preface markers must appear, prior turns must be embedded, and the
    // current prompt must follow the closing tag.
    expect(text).toContain("<restored_context>");
    expect(text).toContain("</restored_context>");
    expect(text).toContain("please refactor foo.ts");
    expect(text).toContain("Done — renamed to bar.");
    expect(text).toContain("[tool call: Read]");
    expect(text).toContain("[tool result: Read]");
    // The actual prompt is appended after the preface.
    expect(text.endsWith("what file did we edit?")).toBe(true);

    queue.close();
    await session.disconnect();
    await turnPromise.catch(() => {});
  });

  it("does NOT inject a preface on a fresh single-message session", async () => {
    const pushed: SDKUserMessage[] = [];
    let captureDone: (() => void) | undefined;
    const captureCompletion = new Promise<void>((resolve) => {
      captureDone = resolve;
    });

    const { query, queue } = makeOpenQuery();
    const session = new ClaudeAgentSession({
      adapterId: "anthropic.agent-sdk",
      queryFactory: (params) => {
        (async () => {
          for await (const msg of params.prompt) {
            pushed.push(msg);
            captureDone?.();
            break;
          }
        })().catch(() => {});
        return query;
      },
      options: { model: "claude-sonnet-4-5" },
    });

    const turnPromise = session.sendTurn(
      makeTurnInput({
        prompt: "first message",
        messages: [{ role: "user", content: "first message" }],
      }),
      { emit: () => {} },
    );
    turnPromise.catch(() => {});

    await captureCompletion;

    expect(pushed).toHaveLength(1);
    const content = String(pushed[0]?.message?.content);
    expect(content).toBe("first message");
    expect(content).not.toContain("<restored_context>");

    queue.close();
    await session.disconnect();
    await turnPromise.catch(() => {});
  });

  it("marks session disconnected when the consumer throws (no zombie reuse)", async () => {
    // Build a query whose output iterator throws mid-stream — simulates the
    // Claude CLI subprocess dying. The consumer's catch must tear down the
    // session so a second sendTurn fails fast instead of hanging on a dead
    // iterable with no reader.
    const interrupt = vi.fn(async () => undefined);
    async function* explodingIterator() {
      throw new Error("subprocess died");
      // biome-ignore lint/correctness/noUnreachable: required to keep this a generator.
      yield undefined as unknown as SDKMessage;
    }
    const generator = explodingIterator();
    const query = Object.assign(generator, {
      interrupt,
      setPermissionMode: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined),
      setMaxThinkingTokens: vi.fn(async () => undefined),
      supportedCommands: vi.fn(async () => ({ commands: [] })),
      supportedModels: vi.fn(async () => []),
      mcpServerStatus: vi.fn(async () => ({ mcpServers: [] })),
      streamInput: vi.fn(async () => undefined),
    }) as unknown as ClaudeAgentQuery;

    const session = new ClaudeAgentSession({
      adapterId: "anthropic.agent-sdk",
      queryFactory: (_params: { prompt: AsyncIterable<SDKUserMessage>; options: ClaudeAgentOptions }) => query,
      options: { model: "claude-sonnet-4-5" },
    });

    // First turn triggers lazyStart + consumer, which throws.
    await expect(session.sendTurn(makeTurnInput(), { emit: () => {} })).rejects.toThrow(/subprocess died/);

    // Second turn must reject immediately with the disconnected error —
    // NOT hang waiting for events from a dead consumer.
    await expect(session.sendTurn(makeTurnInput(), { emit: () => {} })).rejects.toThrow(/disconnected/i);

    await session.disconnect();
  });

  it("emits a skills_loaded tool-call when emitSkillsInitChip is true and init carries skills", async () => {
    const messages: SDKMessage[] = [
      {
        type: "system",
        subtype: "init",
        agents: [],
        apiKeySource: "user" as unknown as never,
        claude_code_version: "0.0.0",
        cwd: "/tmp",
        tools: ["Bash"],
        mcp_servers: [],
        model: "claude-sonnet-4-5",
        permissionMode: "default",
        slash_commands: [],
        output_style: "default",
        skills: ["opentui", "ascii-art", "agent-browser"],
        plugins: [{ name: "codesurf-claude-skills", path: "/tmp/plugin" }],
        uuid: "u-init" as unknown as ReturnType<typeof crypto.randomUUID>,
        session_id: "s1",
      } as unknown as SDKMessage,
      {
        type: "result",
        subtype: "success",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        total_cost_usd: 0,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        modelUsage: {},
        permission_denials: [],
        uuid: "u-r" as unknown as ReturnType<typeof crypto.randomUUID>,
        session_id: "s1",
      } as unknown as SDKMessage,
    ];
    const { query } = makeMockQuery(messages);
    const session = new ClaudeAgentSession({
      adapterId: "anthropic.agent-sdk-claude-skills",
      queryFactory: (_p: { prompt: AsyncIterable<SDKUserMessage>; options: ClaudeAgentOptions }) => query,
      options: { model: "claude-sonnet-4-5" },
      emitSkillsInitChip: true,
    });

    const events: ProviderStreamEvent[] = [];
    await session.sendTurn(makeTurnInput(), { emit: (event) => events.push(event) });

    const initChips = events.filter(
      (e) => e.type === "tool-call" && (e as { toolName: string }).toolName === "skills_loaded",
    );
    expect(initChips).toHaveLength(1);
    const chip = initChips[0] as { toolName: string; args: { count: number; names: string[] } };
    expect(chip.args.count).toBe(3);
    expect(chip.args.names).toEqual(["opentui", "ascii-art", "agent-browser"]);

    // Paired tool-result with the same id so the chip persists in the
    // transcript instead of disappearing after live-feed teardown.
    const initResults = events.filter(
      (e) => e.type === "tool-result" && (e as { id: string }).id === (chip as unknown as { id: string }).id,
    );
    expect(initResults).toHaveLength(1);
    const result = initResults[0] as { id: string; result: string; isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(result.result).toContain("3 skills loaded");
    expect(result.result).toContain("- opentui");
    expect(result.result).toContain("- ascii-art");
    expect(result.result).toContain("- agent-browser");
    await session.disconnect();
  });

  it("surfaces system/permission_denied as a persistent notice chip with the fix hint", async () => {
    // dontAsk-mode (and auto-classifier / deny-rule) denials never reach
    // canUseTool — the SDK denies them itself and emits this system message.
    // Regression: these used to be silently dropped, so tools appeared to
    // vanish with no explanation (the "Bash hard-denied, no prompt" incident).
    const messages: SDKMessage[] = [
      {
        type: "system",
        subtype: "permission_denied",
        tool_name: "Bash",
        tool_use_id: "tu-denied-1",
        decision_reason_type: "mode",
        message: "Permission denied",
        uuid: "u-pd" as unknown as ReturnType<typeof crypto.randomUUID>,
        session_id: "s1",
      } as unknown as SDKMessage,
      {
        type: "result",
        subtype: "success",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        total_cost_usd: 0,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        modelUsage: {},
        permission_denials: [],
        uuid: "u-r" as unknown as ReturnType<typeof crypto.randomUUID>,
        session_id: "s1",
      } as unknown as SDKMessage,
    ];
    const { query } = makeMockQuery(messages);
    const session = new ClaudeAgentSession({
      adapterId: "anthropic.agent-sdk",
      queryFactory: (_p: { prompt: AsyncIterable<SDKUserMessage>; options: ClaudeAgentOptions }) => query,
      options: { model: "claude-sonnet-4-5" },
      getPermissionMode: () => "dontAsk",
    });

    const events: ProviderStreamEvent[] = [];
    await session.sendTurn(makeTurnInput(), { emit: (event) => events.push(event) });

    const chips = events.filter(
      (e) => e.type === "tool-call" && (e as { toolName: string }).toolName === "permission_denied",
    );
    expect(chips).toHaveLength(1);
    const chip = chips[0] as { id: string; args: { tool: string; mode: string; reason: string } };
    expect(chip.args.tool).toBe("Bash");
    expect(chip.args.mode).toBe("dontAsk");
    expect(chip.args.reason).toBe("mode");

    const results = events.filter((e) => e.type === "tool-result" && (e as { id: string }).id === chip.id);
    expect(results).toHaveLength(1);
    const denial = results[0] as { result: string; isError?: boolean };
    expect(denial.isError).toBe(true);
    expect(denial.result).toContain("Bash was auto-denied without a prompt");
    expect(denial.result).toContain("/permissions ask");
    await session.disconnect();
  });

  it("surfaces server-side tool blocks (server_tool_use + *_tool_result) instead of dropping them", async () => {
    // Regression: a `server_tool_use` block (web_search, hosted reviewer, etc.)
    // was previously dropped as "unknown assistant block type", so the UI
    // rendered nothing while the tool ran and the agent looked frozen.
    const { session } = sessionWith([
      {
        type: "assistant",
        message: {
          id: "m1",
          type: "message",
          role: "assistant",
          content: [
            { type: "server_tool_use", id: "st1", name: "web_search", input: { query: "x" } },
            { type: "web_search_tool_result", tool_use_id: "st1", content: [{ title: "r" }], is_error: false },
          ],
          model: "claude-sonnet-4-5",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        uuid: "u1" as unknown as ReturnType<typeof crypto.randomUUID>,
        session_id: "s1",
      } as unknown as SDKMessage,
      {
        type: "result",
        subtype: "success",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        modelUsage: {},
        permission_denials: [],
        uuid: "u2" as unknown as ReturnType<typeof crypto.randomUUID>,
        session_id: "s1",
      } as unknown as SDKMessage,
    ]);

    const events: ProviderStreamEvent[] = [];
    await session.sendTurn(makeTurnInput(), { emit: (e) => events.push(e) });

    const call = events.find((e) => e.type === "tool-call" && (e as { id: string }).id === "st1") as
      | { type: "tool-call"; toolName: string }
      | undefined;
    expect(call).toBeTruthy();
    expect(call?.toolName).toBe("web_search");
    expect(events.some((e) => e.type === "tool-result" && (e as { id: string }).id === "st1")).toBe(true);
    await session.disconnect();
  });

  it("suppresses the tool-call card and tool-result echo for AskUserQuestion (but not other tools)", async () => {
    const { session } = sessionWith([
      {
        type: "assistant",
        message: {
          id: "m1",
          type: "message",
          role: "assistant",
          content: [
            { type: "tool_use", id: "tu-ask", name: "AskUserQuestion", input: { questions: [] } },
            { type: "tool_use", id: "tu-bash", name: "Bash", input: { command: "ls" } },
          ],
          model: "claude-sonnet-4-5",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        uuid: "u1" as unknown as ReturnType<typeof crypto.randomUUID>,
        session_id: "s1",
      } as unknown as SDKMessage,
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu-ask", content: "denied", is_error: true }],
        },
        parent_tool_use_id: null,
        uuid: "u2" as unknown as ReturnType<typeof crypto.randomUUID>,
        session_id: "s1",
      } as unknown as SDKMessage,
      {
        type: "result",
        subtype: "success",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        modelUsage: {},
        permission_denials: [],
        uuid: "u3" as unknown as ReturnType<typeof crypto.randomUUID>,
        session_id: "s1",
      } as unknown as SDKMessage,
    ]);

    const events: ProviderStreamEvent[] = [];
    await session.sendTurn(makeTurnInput(), { emit: (e) => events.push(e) });

    // The AskUserQuestion tool_use must NOT surface as a generic tool-call card.
    expect(
      events.some((e) => e.type === "tool-call" && (e as { toolName: string }).toolName === "AskUserQuestion"),
    ).toBe(false);
    // Its denied tool_result echo must be suppressed too.
    expect(events.some((e) => e.type === "tool-result" && (e as { id: string }).id === "tu-ask")).toBe(false);
    // A normal tool in the same message is unaffected.
    expect(events.some((e) => e.type === "tool-call" && (e as { toolName: string }).toolName === "Bash")).toBe(true);
    await session.disconnect();
  });

  it("routes AskUserQuestion through canUseTool: emits questionnaire-request and denies with interrupt", async () => {
    const queue = new AsyncPushQueue<SDKMessage>();
    let captured:
      | ((toolName: string, input: Record<string, unknown>, options: unknown) => Promise<unknown>)
      | undefined;
    const query = Object.assign(queue.iterable, {
      interrupt: vi.fn(async () => undefined),
      setPermissionMode: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined),
      setMaxThinkingTokens: vi.fn(async () => undefined),
      supportedCommands: vi.fn(async () => ({ commands: [] })),
      supportedModels: vi.fn(async () => []),
      mcpServerStatus: vi.fn(async () => ({ mcpServers: [] })),
      streamInput: vi.fn(async () => undefined),
    }) as unknown as ClaudeAgentQuery;
    const session = new ClaudeAgentSession({
      adapterId: "anthropic.agent-sdk",
      queryFactory: (params) => {
        captured = params.options.canUseTool as unknown as typeof captured;
        return query;
      },
      options: { model: "claude-sonnet-4-5" },
    });

    const events: ProviderStreamEvent[] = [];
    const turnPromise = session.sendTurn(makeTurnInput(), { emit: (e) => events.push(e) });
    turnPromise.catch(() => {});
    // Let lazyStart assemble canUseTool and set the active turn.
    await new Promise((r) => setTimeout(r, 10));

    expect(captured).toBeTypeOf("function");
    const ac = new AbortController();
    const result = (await captured?.(
      "AskUserQuestion",
      { title: "steering", questions: [{ question: "Scope?", header: "Scope", options: [] }] },
      { signal: ac.signal, toolUseID: "tu-ask" },
    )) as { behavior: string; interrupt?: boolean; message?: string };

    expect(result.behavior).toBe("deny");
    expect(result.interrupt).toBe(true);
    expect(result.message).toContain("CodeSurf");

    const q = events.find((e) => e.type === "questionnaire-request") as
      | { type: "questionnaire-request"; title?: string; questions: unknown }
      | undefined;
    expect(q).toBeTruthy();
    expect(q?.title).toBe("steering");
    expect(Array.isArray(q?.questions)).toBe(true);

    queue.close();
    await session.disconnect();
    await turnPromise.catch(() => {});
  });

  it("does NOT emit skills_loaded when the flag is off (default)", async () => {
    const messages: SDKMessage[] = [
      {
        type: "system",
        subtype: "init",
        skills: ["opentui"],
        uuid: "u-init" as unknown as ReturnType<typeof crypto.randomUUID>,
        session_id: "s1",
      } as unknown as SDKMessage,
      {
        type: "result",
        subtype: "success",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        modelUsage: {},
        permission_denials: [],
        uuid: "u-r" as unknown as ReturnType<typeof crypto.randomUUID>,
        session_id: "s1",
      } as unknown as SDKMessage,
    ];
    const { query } = makeMockQuery(messages);
    const session = new ClaudeAgentSession({
      adapterId: "anthropic.agent-sdk",
      queryFactory: (_p: { prompt: AsyncIterable<SDKUserMessage>; options: ClaudeAgentOptions }) => query,
      options: { model: "claude-sonnet-4-5" },
    });

    const events: ProviderStreamEvent[] = [];
    await session.sendTurn(makeTurnInput(), { emit: (event) => events.push(event) });

    const initChips = events.filter(
      (e) => e.type === "tool-call" && (e as { toolName: string }).toolName === "skills_loaded",
    );
    expect(initChips).toHaveLength(0);
    await session.disconnect();
  });

  it("settles the turn with an error when the stream stalls (stall watchdog)", async () => {
    // A query whose generator never yields and never returns models a dead /
    // rate-limited stream: the consumer loop blocks on `.next()` forever.
    const interrupt = vi.fn(async () => undefined);
    // Releasable hang: the generator blocks until `releaseHang` is called, so
    // the test can let the consumer loop finish (and disconnect cleanly) after
    // the watchdog has fired.
    let releaseHang: () => void = () => {};
    async function* hangingIterator() {
      await new Promise<void>((resolve) => {
        releaseHang = resolve;
      });
      // After release the generator returns — no message is ever yielded.
    }
    const generator = hangingIterator();
    const query = Object.assign(generator, {
      interrupt,
      setPermissionMode: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined),
      setMaxThinkingTokens: vi.fn(async () => undefined),
      supportedCommands: vi.fn(async () => ({ commands: [] })),
      supportedModels: vi.fn(async () => []),
      mcpServerStatus: vi.fn(async () => ({ mcpServers: [] })),
      streamInput: vi.fn(async () => undefined),
    }) as unknown as ClaudeAgentQuery;

    const session = new ClaudeAgentSession({
      adapterId: "anthropic.agent-sdk",
      queryFactory: (_p: { prompt: AsyncIterable<SDKUserMessage>; options: ClaudeAgentOptions }) => query,
      options: { model: "claude-sonnet-4-5" },
    });

    vi.useFakeTimers();
    try {
      const events: ProviderStreamEvent[] = [];
      const turn = session.sendTurn(makeTurnInput(), { emit: (event) => events.push(event) });
      const assertion = expect(turn).rejects.toThrow(/stalled/i);
      // Default STALL_TIMEOUT_MS is 120_000; advance past it, flushing the
      // microtasks the setup IIFE needs to arm the watchdog first.
      await vi.advanceTimersByTimeAsync(120_000);
      await assertion;
      expect(events.some((e) => e.type === "error")).toBe(true);
      expect(interrupt).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      releaseHang();
      await session.disconnect();
    }
  });
});

// ── Fine-grained streaming (includePartialMessages) ──────────────────────────
// The session enables `includePartialMessages: true` at lazyStart, so the SDK
// emits `stream_event` partials during generation. These tests cover the
// forwarding of partial deltas and the dedupe against the complete assistant
// message that still arrives at the end of each message.

function makeStreamEvent(delta: { type: string; text?: string; thinking?: string }): SDKMessage {
  return {
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta },
    parent_tool_use_id: null,
    uuid: "u-se" as unknown as ReturnType<typeof crypto.randomUUID>,
    session_id: "s1",
  } as unknown as SDKMessage;
}

function makeAssistantMessage(content: Array<Record<string, unknown>>): SDKMessage {
  return {
    type: "assistant",
    message: {
      id: "m-a",
      type: "message",
      role: "assistant",
      content,
      model: "claude-sonnet-4-5",
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    parent_tool_use_id: null,
    uuid: "u-a" as unknown as ReturnType<typeof crypto.randomUUID>,
    session_id: "s1",
  } as unknown as SDKMessage;
}

function makeSuccessResult(): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: "done",
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
    uuid: "u-r" as unknown as ReturnType<typeof crypto.randomUUID>,
    session_id: "s1",
  } as unknown as SDKMessage;
}

describe("ClaudeAgentSession streaming (stream_event partials)", () => {
  function sessionWith(messages: SDKMessage[]): ClaudeAgentSession {
    const { query } = makeMockQuery(messages);
    return new ClaudeAgentSession({
      adapterId: "anthropic.agent-sdk",
      queryFactory: (_p: { prompt: AsyncIterable<SDKUserMessage>; options: ClaudeAgentOptions }) => query,
      options: { model: "claude-sonnet-4-5" },
    });
  }

  it("enables includePartialMessages in the query options at lazyStart", async () => {
    let capturedOptions: ClaudeAgentOptions | undefined;
    const { query } = makeMockQuery([makeSuccessResult()]);
    const session = new ClaudeAgentSession({
      adapterId: "anthropic.agent-sdk",
      queryFactory: (p: { prompt: AsyncIterable<SDKUserMessage>; options: ClaudeAgentOptions }) => {
        capturedOptions = p.options;
        return query;
      },
      options: { model: "claude-sonnet-4-5" },
    });
    await session.sendTurn(makeTurnInput(), { emit: () => {} });
    expect(capturedOptions?.includePartialMessages).toBe(true);
    await session.disconnect();
  });

  it("forwards text_delta partials as text-delta and thinking_delta partials as reasoning-delta", async () => {
    const session = sessionWith([
      makeStreamEvent({ type: "thinking_delta", thinking: "let me " }),
      makeStreamEvent({ type: "thinking_delta", thinking: "think" }),
      makeStreamEvent({ type: "text_delta", text: "Hello" }),
      makeStreamEvent({ type: "text_delta", text: " world" }),
      makeSuccessResult(),
    ]);

    const events: ProviderStreamEvent[] = [];
    await session.sendTurn(makeTurnInput(), { emit: (event) => events.push(event) });

    const reasoning = events.filter((e) => e.type === "reasoning-delta").map((e) => (e as { delta: string }).delta);
    const text = events.filter((e) => e.type === "text-delta").map((e) => (e as { delta: string }).delta);
    expect(reasoning).toEqual(["let me ", "think"]);
    expect(text).toEqual(["Hello", " world"]);
    await session.disconnect();
  });

  it("does NOT re-emit text/thinking from the complete assistant message after partials streamed", async () => {
    const session = sessionWith([
      makeStreamEvent({ type: "thinking_delta", thinking: "thinking..." }),
      makeStreamEvent({ type: "text_delta", text: "Hello" }),
      // Complete message carries the full text/thinking again — must be deduped.
      makeAssistantMessage([
        { type: "thinking", thinking: "thinking..." },
        { type: "text", text: "Hello" },
      ]),
      makeSuccessResult(),
    ]);

    const events: ProviderStreamEvent[] = [];
    await session.sendTurn(makeTurnInput(), { emit: (event) => events.push(event) });

    const reasoning = events.filter((e) => e.type === "reasoning-delta");
    const text = events.filter((e) => e.type === "text-delta");
    expect(reasoning).toHaveLength(1);
    expect(text).toHaveLength(1);
    await session.disconnect();
  });

  it("still emits text/thinking from a complete assistant message when no partials streamed", async () => {
    const session = sessionWith([
      makeAssistantMessage([
        { type: "thinking", thinking: "pondering" },
        { type: "text", text: "Full answer" },
      ]),
      makeSuccessResult(),
    ]);

    const events: ProviderStreamEvent[] = [];
    await session.sendTurn(makeTurnInput(), { emit: (event) => events.push(event) });

    const reasoning = events.filter((e) => e.type === "reasoning-delta").map((e) => (e as { delta: string }).delta);
    const text = events.filter((e) => e.type === "text-delta").map((e) => (e as { delta: string }).delta);
    expect(reasoning).toEqual(["pondering"]);
    expect(text).toEqual(["Full answer"]);
    await session.disconnect();
  });

  it("still emits tool-call exactly once from the complete assistant message when partials streamed", async () => {
    const session = sessionWith([
      makeStreamEvent({ type: "text_delta", text: "Running a command" }),
      // input_json_delta partials are ignored; args come from the complete message.
      {
        type: "stream_event",
        event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } },
        parent_tool_use_id: null,
        uuid: "u-ij" as unknown as ReturnType<typeof crypto.randomUUID>,
        session_id: "s1",
      } as unknown as SDKMessage,
      makeAssistantMessage([
        { type: "text", text: "Running a command" },
        { type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } },
      ]),
      makeSuccessResult(),
    ]);

    const events: ProviderStreamEvent[] = [];
    await session.sendTurn(makeTurnInput(), { emit: (event) => events.push(event) });

    const toolCalls = events.filter((e) => e.type === "tool-call");
    expect(toolCalls).toHaveLength(1);
    expect((toolCalls[0] as { toolName: string }).toolName).toBe("Bash");
    expect((toolCalls[0] as { args: unknown }).args).toEqual({ command: "ls" });
    const text = events.filter((e) => e.type === "text-delta");
    expect(text).toHaveLength(1);
    await session.disconnect();
  });
});

// ── Turn retirement: setup races, back-to-back steers, dead streams ──────────

function makeErrorResult(): SDKMessage {
  return {
    type: "result",
    subtype: "error_during_execution",
    duration_ms: 0,
    duration_api_ms: 0,
    is_error: true,
    num_turns: 1,
    session_id: "s1",
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
    uuid: "u-err" as unknown as ReturnType<typeof crypto.randomUUID>,
  } as unknown as SDKMessage;
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const textOf = (events: ProviderStreamEvent[]): string =>
  events
    .filter((e): e is Extract<ProviderStreamEvent, { type: "text-delta" }> => e.type === "text-delta")
    .map((e) => e.delta)
    .join("");

describe("ClaudeAgentSession turn retirement", () => {
  function openSession(options: ClaudeAgentOptions = {}) {
    const open = makeOpenQuery();
    const pushed: SDKUserMessage[] = [];
    let canUseTool:
      | ((toolName: string, input: Record<string, unknown>, options: unknown) => Promise<unknown>)
      | undefined;
    const session = new ClaudeAgentSession({
      adapterId: "anthropic.agent-sdk",
      queryFactory: (params) => {
        canUseTool = params.options.canUseTool as unknown as typeof canUseTool;
        (async () => {
          for await (const msg of params.prompt) pushed.push(msg);
        })().catch(() => {});
        return open.query;
      },
      options,
    });
    return { ...open, session, pushed, canUseTool: () => canUseTool };
  }

  it("never pushes the prompt of a turn aborted while setup is suspended (H3)", async () => {
    const { session, queue, pushed, setModel } = openSession({ model: "claude-sonnet-4-5" });
    let releaseSetModel: () => void = () => {};
    setModel.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          releaseSetModel = () => resolve(undefined);
        }),
    );
    const ac = new AbortController();
    const events: ProviderStreamEvent[] = [];
    const turn = session.sendTurn(makeTurnInput({ modelId: "claude-opus-4-1", abortSignal: ac.signal }), {
      emit: (e) => events.push(e),
    });
    await tick();
    expect(setModel).toHaveBeenCalled();

    ac.abort();
    releaseSetModel();
    await tick();

    await expect(turn).resolves.toBeDefined();
    expect(pushed).toHaveLength(0);
    expect(events.some((e) => e.type === "status" && (e as { status?: string }).status === "streaming")).toBe(false);

    // Nothing was pushed, so nothing drains: the next turn's output is its own.
    const next: ProviderStreamEvent[] = [];
    const nextTurn = session.sendTurn(makeTurnInput(), { emit: (e) => next.push(e) });
    await tick();
    expect(pushed).toHaveLength(1);
    queue.push(makeAssistantMessage([{ type: "text", text: "fresh" }]));
    queue.push(makeSuccessResult());
    await expect(nextTurn).resolves.toBeDefined();
    expect(textOf(next)).toBe("fresh");

    queue.close();
    await session.disconnect();
  });

  it("drains every retired turn when two steers land back to back (H5)", async () => {
    const { session, queue, pushed } = openSession();
    const a = session.sendTurn(makeTurnInput({ prompt: "A" }), { emit: () => {} });
    await tick();
    const b = session.sendTurn(makeTurnInput({ prompt: "B" }), { emit: () => {} });
    await tick();
    const cEvents: ProviderStreamEvent[] = [];
    const c = session.sendTurn(makeTurnInput({ prompt: "C" }), { emit: (e) => cEvents.push(e) });
    await tick();
    expect(pushed.map((m) => m.message.content)).toEqual(["A", "B", "C"]);
    await expect(a).resolves.toBeDefined();
    await expect(b).resolves.toBeDefined();

    // The SDK answers A, then B, then C — one result each.
    queue.push(makeErrorResult());
    queue.push(makeAssistantMessage([{ type: "text", text: "B-stray" }]));
    queue.push(makeErrorResult());
    queue.push(makeAssistantMessage([{ type: "text", text: "C-text" }]));
    queue.push(makeSuccessResult());

    await expect(c).resolves.toBeDefined();
    expect(textOf(cEvents)).toBe("C-text");

    queue.close();
    await session.disconnect();
  });

  it("keeps a draining turn's AskUserQuestion off the live turn (L15)", async () => {
    const { session, queue, canUseTool } = openSession();
    const a = session.sendTurn(makeTurnInput({ prompt: "A" }), { emit: () => {} });
    await tick();
    const bEvents: ProviderStreamEvent[] = [];
    const b = session.sendTurn(makeTurnInput({ prompt: "B" }), { emit: (e) => bEvents.push(e) });
    b.catch(() => {});
    await tick();
    await a;

    // Still draining A: this request is A's.
    const result = (await canUseTool()?.(
      "AskUserQuestion",
      { title: "late", questions: [] },
      { signal: new AbortController().signal, toolUseID: "tu-late" },
    )) as { behavior: string };
    expect(result.behavior).toBe("deny");
    expect(bEvents.some((e) => e.type === "questionnaire-request")).toBe(false);

    // A's result is swallowed; B's own failure must still read as a failure,
    // not as a questionnaire hand-off.
    queue.push(makeErrorResult());
    queue.push(makeErrorResult());
    await expect(b).rejects.toThrow(/Claude Agent SDK error/);

    queue.close();
    await session.disconnect();
  });

  it("settles the active turn and marks the session dead when the stream just ends (M6)", async () => {
    const { session, queue } = openSession();
    const events: ProviderStreamEvent[] = [];
    const turn = session.sendTurn(makeTurnInput(), { emit: (e) => events.push(e) });
    await tick();

    queue.close(); // Subprocess gone: the stream ends without an error.

    await expect(turn).rejects.toThrow(/ended unexpectedly/);
    expect(events.at(-1)).toMatchObject({ type: "error" });
    await expect(session.sendTurn(makeTurnInput(), { emit: () => {} })).rejects.toThrow(/disconnected/i);
  });

  it("keeps prompt text out of the SDK log unless CODESURF_CLAUDE_AGENT_LOG_CONTENT=1", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    // A private log file: the default one is shared with every other worker
    // importing this module, any of which may truncate it mid-test.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-agent-log-"));
    const logFile = path.join(dir, "sdk.log");
    const secret = `prompt-secret-${Math.random().toString(36).slice(2)}`;
    const read = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf-8") : "");
    const saved = {
      file: process.env.CODESURF_CLAUDE_AGENT_LOG_FILE,
      content: process.env.CODESURF_CLAUDE_AGENT_LOG_CONTENT,
    };
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    process.env.CODESURF_CLAUDE_AGENT_LOG_FILE = logFile;
    delete process.env.CODESURF_CLAUDE_AGENT_LOG_CONTENT;
    try {
      const quiet = openSession();
      void quiet.session.sendTurn(makeTurnInput({ prompt: secret }), { emit: () => {} }).catch(() => {});
      await tick();
      expect(read()).toContain("sendTurn:");
      expect(read()).not.toContain(secret);
      quiet.queue.close();
      await quiet.session.disconnect();

      process.env.CODESURF_CLAUDE_AGENT_LOG_CONTENT = "1";
      const loud = openSession();
      void loud.session.sendTurn(makeTurnInput({ prompt: secret }), { emit: () => {} }).catch(() => {});
      await tick();
      expect(read()).toContain(secret);
      loud.queue.close();
      await loud.session.disconnect();
    } finally {
      restore("CODESURF_CLAUDE_AGENT_LOG_FILE", saved.file);
      restore("CODESURF_CLAUDE_AGENT_LOG_CONTENT", saved.content);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
