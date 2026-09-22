import { describe, expect, it, vi } from "vitest";
import type { ProviderStreamEvent, ProviderTurnInput } from "../api";
import {
  chooseOmnigentHost,
  decodeOmnigentModelId,
  encodeOmnigentModelId,
  mapOmnigentEvent,
  OmnigentSession,
  parseOmnigentAgents,
  parseOmnigentHosts,
  parseOmnigentServerUrl,
  parseOmnigentStatusJson,
  readOmnigentSseStream,
  toRegisteredModels,
} from "./omnigent-provider";

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeSseStream(events: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const evt of events) {
        const type = typeof evt.type === "string" ? evt.type : "message";
        controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(evt)}\n\n`));
      }
      controller.close();
    },
  });
}

function makeStreamResponse(events: Array<Record<string, unknown>>): Response {
  return new Response(makeSseStream(events), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function collectStream(): { events: ProviderStreamEvent[]; controller: { emit: (e: ProviderStreamEvent) => void } } {
  const events: ProviderStreamEvent[] = [];
  return {
    events,
    controller: {
      emit: (event: ProviderStreamEvent) => events.push(event),
    },
  };
}

function turn(modelId: string): ProviderTurnInput {
  return {
    conversationId: "codesurf-conv",
    providerId: "omnigent",
    adapterId: "omnigent.server",
    modelId,
    prompt: "Hello Omni",
    messages: [{ role: "user", content: "Hello Omni" }],
  };
}

describe("Omnigent provider helpers", () => {
  it("parses server URLs from omni CLI output", () => {
    expect(parseOmnigentServerUrl("Started background server at http://127.0.0.1:6767\n  log: /tmp/x")).toBe(
      "http://127.0.0.1:6767",
    );
    expect(parseOmnigentServerUrl("Background server already running at http://localhost:8123")).toBe(
      "http://localhost:8123",
    );
  });

  it("parses status JSON even when omni prints update notices first", () => {
    const status = parseOmnigentStatusJson('Update check\n{"running":true,"url":"http://127.0.0.1:6767","pid":42}');
    expect(status).toMatchObject({ running: true, url: "http://127.0.0.1:6767", pid: 42 });
  });

  it("normalizes agents into model rows", () => {
    const agents = parseOmnigentAgents({
      data: [{ id: "ag_builtin_codex", name: "codex", description: "Code agent", harness: "codex-native" }],
    });
    expect(agents).toEqual([
      { id: "ag_builtin_codex", name: "codex", description: "Code agent", harness: "codex-native" },
    ]);
    const id = encodeOmnigentModelId("ag_builtin_codex");
    expect(decodeOmnigentModelId(id)).toBe("ag_builtin_codex");
    expect(toRegisteredModels(agents).map((model) => model.id)).toEqual(["omnigent:default", id]);
  });

  it("chooses the first online Omnigent host", () => {
    const hosts = parseOmnigentHosts({
      hosts: [
        { host_id: "host_offline", name: "old", status: "offline" },
        { host_id: "host_online", name: "local", status: "online" },
      ],
    });
    expect(chooseOmnigentHost(hosts)).toEqual({ id: "host_online", name: "local", status: "online" });
  });

  it("maps Omnigent stream events to provider stream events", () => {
    const { events, controller } = collectStream();
    const result = mapOmnigentEvent(
      {
        type: "response.completed",
        response: { usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 2 } },
      },
      controller,
    );
    expect(result.terminal).toBe("done");
    expect(events).toEqual([
      { type: "usage", usage: { inputTokens: 12, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: undefined } },
      { type: "done", stopReason: "complete" },
    ]);
  });

  it("cancels a pending SSE read when the turn is aborted", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const abortController = new AbortController();

    const promise = readOmnigentSseStream(stream, collectStream().controller, abortController.signal);
    abortController.abort();

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toBe(true);
  });

  it("skips an unparsable SSE frame instead of emitting a turn-ending error", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("event: response.output_text.delta\ndata: {not json\n\n"));
        controller.enqueue(
          encoder.encode(
            `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}\n\n`,
          ),
        );
        controller.enqueue(
          encoder.encode(
            `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: {} })}\n\n`,
          ),
        );
        controller.close();
      },
    });
    const { events, controller } = collectStream();

    await readOmnigentSseStream(stream, controller, new AbortController().signal);

    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events).toContainEqual({ type: "text-delta", delta: "ok" });
    expect(events[events.length - 1]).toEqual({ type: "done", stopReason: "complete" });
  });

  it("cancels the SSE body when the turn completes on a terminal event", async () => {
    const encoder = new TextEncoder();
    let cancelled = false;
    // The server keeps the stream open after response.completed.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: {} })}\n\n`,
          ),
        );
      },
      cancel() {
        cancelled = true;
      },
    });

    await readOmnigentSseStream(stream, collectStream().controller, new AbortController().signal);

    expect(cancelled).toBe(true);
    expect(stream.locked).toBe(false);
  });

  it("maps tool calls keyed on call_id", () => {
    const { events, controller } = collectStream();

    // `.added` arrives before arguments are populated; it must not emit a chip.
    mapOmnigentEvent(
      {
        type: "response.output_item.added",
        item: { id: "fc_1", type: "function_call", name: "search.web", call_id: "call_1" },
      },
      controller,
    );
    expect(events).toEqual([]);

    // `.done` carries the fully-populated JSON-string arguments -> emit once.
    mapOmnigentEvent(
      {
        type: "response.output_item.done",
        item: { id: "fc_1", type: "function_call", name: "search.web", call_id: "call_1", arguments: '{"q":"x"}' },
      },
      controller,
    );
    expect(events).toEqual([{ type: "tool-call", id: "call_1", toolName: "search.web", args: { q: "x" } }]);

    // function_call_output -> tool-result keyed on the same call_id.
    mapOmnigentEvent(
      {
        type: "response.output_item.done",
        item: { type: "function_call_output", call_id: "call_1", output: "done" },
      },
      controller,
    );
    expect(events[events.length - 1]).toEqual({ type: "tool-result", id: "call_1", result: "done" });
  });

  it("ignores message/reasoning output items (surfaced via deltas)", () => {
    const { events, controller } = collectStream();
    mapOmnigentEvent({ type: "response.output_item.done", item: { type: "message", content: [] } }, controller);
    expect(events).toEqual([]);
  });

  it("falls back to the raw string when tool arguments are not valid JSON", () => {
    const { events, controller } = collectStream();
    mapOmnigentEvent(
      {
        type: "response.output_item.done",
        item: { id: "fc_2", type: "function_call", name: "shell", call_id: "call_2", arguments: "not-json" },
      },
      controller,
    );
    expect(events).toEqual([{ type: "tool-call", id: "call_2", toolName: "shell", args: "not-json" }]);
  });
});

describe("OmnigentSession", () => {
  it("creates a backend session, opens a live stream, posts the turn, and emits deltas", async () => {
    const order: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/v1/agents?limit=100&order=asc")) {
        order.push("agents");
        return makeJsonResponse({ data: [{ id: "ag_codex", name: "codex" }] });
      }
      if (url.endsWith("/v1/hosts")) {
        order.push("hosts");
        return makeJsonResponse({ hosts: [{ host_id: "host_local", name: "local", status: "online" }] });
      }
      if (url.endsWith("/v1/sessions") && init?.method === "POST") {
        order.push("create");
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        expect(body.host_id).toBe("host_local");
        expect(body.workspace).toBe(process.cwd());
        return makeJsonResponse({ id: "conv_omni" }, 201);
      }
      if (url.endsWith("/v1/sessions/conv_omni/stream")) {
        order.push("stream");
        return makeStreamResponse([
          { type: "session.heartbeat" },
          { type: "response.output_text.delta", delta: "Hello " },
          {
            type: "response.completed",
            response: { usage: { input_tokens: 10, output_tokens: 2 } },
          },
        ]);
      }
      if (url.endsWith("/v1/sessions/conv_omni/events") && init?.method === "POST") {
        order.push("event");
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        expect(body).toMatchObject({
          type: "message",
          data: { role: "user", content: [{ type: "input_text", text: "Hello Omni" }] },
        });
        return makeJsonResponse({ ok: true });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch);

    const session = new OmnigentSession({
      baseUrl: () => "http://127.0.0.1:6767",
      apiKey: () => "",
      autoStart: () => false,
      cli: () => "omni",
      dataDir: () => "",
      hostId: () => "",
      agentId: () => "",
      agentName: () => "",
      modelOverride: () => "",
      timeoutMs: () => 30_000,
    });
    const { events, controller } = collectStream();

    const result = await session.sendTurn(turn("omnigent:default"), controller);

    expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 2 });
    expect(events.filter((event) => event.type === "text-delta")).toEqual([{ type: "text-delta", delta: "Hello " }]);
    expect(events[events.length - 1]).toEqual({ type: "done", stopReason: "complete" });
    expect(order).toEqual(["agents", "hosts", "create", "stream", "event"]);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("auto-starts the local omni server when no base URL is configured", async () => {
    const cliRunner = vi.fn(async () => "Started background server at http://127.0.0.1:7777\n");
    vi.spyOn(globalThis, "fetch").mockImplementation((async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      expect(url).toContain("http://127.0.0.1:7777");
      if (url.endsWith("/v1/sessions") && init?.method === "POST") return makeJsonResponse({ id: "conv_auto" }, 201);
      if (url.endsWith("/v1/sessions/conv_auto/stream")) {
        return makeStreamResponse([{ type: "response.completed", response: {} }]);
      }
      if (url.endsWith("/v1/sessions/conv_auto/events") && init?.method === "POST") {
        return makeJsonResponse({ ok: true });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch);

    const session = new OmnigentSession({
      baseUrl: () => "",
      apiKey: () => "",
      autoStart: () => true,
      cli: () => "omni",
      dataDir: () => "/tmp/omni-test-data",
      hostId: () => "host_configured",
      agentId: () => "ag_direct",
      agentName: () => "",
      modelOverride: () => "",
      timeoutMs: () => 30_000,
      cliRunner,
    });

    await session.sendTurn(turn(encodeOmnigentModelId("ag_direct")), collectStream().controller);

    expect(cliRunner).toHaveBeenCalledWith("omni", ["server", "start"], { OMNIGENT_DATA_DIR: "/tmp/omni-test-data" });
  });

  it("runs `omni server start` once per session, not on every turn", async () => {
    const cliRunner = vi.fn(async () => "Started background server at http://127.0.0.1:7777\n");
    vi.spyOn(globalThis, "fetch").mockImplementation((async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/v1/sessions") && init?.method === "POST") return makeJsonResponse({ id: "conv_cache" }, 201);
      if (url.endsWith("/v1/sessions/conv_cache/stream")) {
        return makeStreamResponse([{ type: "response.completed", response: {} }]);
      }
      if (url.endsWith("/v1/sessions/conv_cache/events") && init?.method === "POST") {
        return makeJsonResponse({ ok: true });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch);

    const session = new OmnigentSession({
      baseUrl: () => "",
      apiKey: () => "",
      autoStart: () => true,
      cli: () => "omni",
      dataDir: () => "/tmp/omni-test-data",
      hostId: () => "host_configured",
      agentId: () => "ag_direct",
      agentName: () => "",
      modelOverride: () => "",
      timeoutMs: () => 30_000,
      cliRunner,
    });

    await session.sendTurn(turn(encodeOmnigentModelId("ag_direct")), collectStream().controller);
    await session.sendTurn(turn(encodeOmnigentModelId("ag_direct")), collectStream().controller);

    expect(cliRunner).toHaveBeenCalledTimes(1);
  });

  it("cancels the already-open stream and releases the turn when the POST fails", async () => {
    let cancelled = false;
    let firstBody: ReadableStream<Uint8Array> | null = null;
    const encoder = new TextEncoder();
    const source: { controller: ReadableStreamDefaultController<Uint8Array> | null } = { controller: null };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        source.controller = controller;
      },
      cancel() {
        cancelled = true;
      },
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    let streamOpens = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/v1/sessions") && init?.method === "POST") return makeJsonResponse({ id: "conv_fail" }, 201);
      if (url.endsWith("/v1/sessions/conv_fail/stream")) {
        streamOpens += 1;
        if (streamOpens > 1) return makeStreamResponse([{ type: "response.completed", response: {} }]);
        const response = new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
        firstBody = response.body;
        return response;
      }
      if (url.endsWith("/v1/sessions/conv_fail/events") && init?.method === "POST") {
        if (streamOpens === 1) throw new Error("post exploded");
        return makeJsonResponse({ ok: true });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch);

    const session = new OmnigentSession({
      baseUrl: () => "http://127.0.0.1:6767",
      apiKey: () => "",
      autoStart: () => false,
      cli: () => "omni",
      dataDir: () => "",
      hostId: () => "host_configured",
      agentId: () => "ag_direct",
      agentName: () => "",
      modelOverride: () => "",
      timeoutMs: () => 30_000,
    });
    const { events, controller } = collectStream();

    try {
      await expect(session.sendTurn(turn(encodeOmnigentModelId("ag_direct")), controller)).rejects.toThrow(
        "post exploded",
      );

      // The reader was cancelled and has released the body: no task outlives the turn.
      expect(cancelled).toBe(true);
      expect((firstBody as ReadableStream<Uint8Array> | null)?.locked).toBe(false);
      expect(events[events.length - 1]).toEqual({ type: "error", message: "post exploded" });

      // Anything the server pushes after the failure must not reach the controller.
      const emittedBefore = events.length;
      try {
        source.controller?.enqueue(
          encoder.encode(
            `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "late" })}\n\n`,
          ),
        );
      } catch {
        // A cancelled stream rejects enqueue; either way nothing may be emitted.
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(events.length).toBe(emittedBefore);
      expect(events.some((event) => event.type === "text-delta")).toBe(false);

      // Ownership was released: the next turn is accepted, not "already active".
      await expect(
        session.sendTurn(turn(encodeOmnigentModelId("ag_direct")), collectStream().controller),
      ).resolves.toBeDefined();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
