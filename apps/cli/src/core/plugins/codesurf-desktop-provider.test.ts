// Smoke tests for the Codesurf desktop daemon provider extension.
//
// We don't run a real daemon — we stub `fetch` and write a fake pid.json into
// a temp `CODESURF_HOME`. The asserts focus on the parts that are easy to
// regress: model id encoding, daemon discovery, SSE → ProviderStreamEvent
// translation, sessionId threading across turns, and tool event buffering.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderStreamEvent, ProviderTurnInput } from "./api";
import {
  CodesurfDesktopSession,
  decodeModelId,
  encodeModelId,
  MODELS,
  parseCodesurfModelCatalog,
  resolveCodesurfHome,
} from "./native/codesurf-desktop-provider";

// ── Helpers ──────────────────────────────────────────────────────────────────

let tempHome: string;
let originalHome: string | undefined;
let originalUserHome: string | undefined;
let originalCardIdEnv: string | undefined;

// The provider captures its ~/.codesurf default at module import (before the
// beforeAll HOME override); compare against the same import-time value.
// The global test setup sets CODESURF_HOME before any module imports, so that
// (not the real ~/.codesurf) is what the provider caches at import time.
const importTimeDefaultHome = process.env.CODESURF_HOME?.trim() || path.join(os.homedir(), ".codesurf");
let tempConfigDir: string;
let originalConfigDir: string | undefined;

function writePidFile(
  home: string,
  overrides: Partial<{ pid: number; port: number; token: string; appVersion: string | null }> = {},
): void {
  const dir = path.join(home, "daemon");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "pid.json"),
    JSON.stringify({
      // process.pid is always alive, so the kill(pid, 0) check passes.
      pid: overrides.pid ?? process.pid,
      port: overrides.port ?? 31415,
      token: overrides.token ?? "test-token",
      startedAt: new Date().toISOString(),
      protocolVersion: 1,
      appVersion: overrides.appVersion === undefined ? "0.0.0-test" : overrides.appVersion,
    }),
    "utf-8",
  );
}

function makeSseStream(events: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const evt of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(evt)}\n\n`));
      }
      controller.close();
    },
  });
}

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * A `/health` body that identifies the daemon recorded in `home`'s pid.json.
 *
 * The client rejects a health reply whose `pid` / `startedAt` do not match the
 * pid file — that is what stops it from adopting an unrelated process that
 * happens to hold the port. A bare `{ok:true}` therefore reads as a foreign
 * process, and discovery falls through to trying to start a real daemon.
 */
function makeHealthResponse(home: string): Response {
  const info = JSON.parse(fs.readFileSync(path.join(home, "daemon", "pid.json"), "utf-8")) as {
    pid: number;
    startedAt: string;
  };
  return makeJsonResponse({ ok: true, pid: info.pid, startedAt: info.startedAt });
}

/**
 * A `/workspace/list` body containing a workspace rooted at the test's cwd.
 *
 * The daemon rejects a chat request with no `workspaceId` and then checks the
 * supplied `workspaceDir` against that workspace's registered root, so the
 * provider has to look the id up by path before it can post a turn.
 */
function makeWorkspaceListResponse(): Response {
  return makeJsonResponse([
    { id: "ws-other", name: "Somewhere Else", path: "/nonexistent/other", projectPaths: [] },
    { id: "ws-cwd", name: "Under Test", path: process.cwd(), projectPaths: [process.cwd()] },
  ]);
}

function makeStreamResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function collectStream(): { events: ProviderStreamEvent[]; controller: { emit: (e: ProviderStreamEvent) => void } } {
  const events: ProviderStreamEvent[] = [];
  return {
    events,
    controller: {
      emit: (e: ProviderStreamEvent): void => {
        events.push(e);
      },
    },
  };
}

beforeAll(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-codesurf-test-"));
  tempConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-codesurf-cfg-"));
  originalHome = process.env.CODESURF_HOME;
  originalConfigDir = process.env.CODESURF_CONFIG_DIR;
  originalUserHome = process.env.HOME;
  originalCardIdEnv = process.env.CARD_ID;
  process.env.CODESURF_HOME = tempHome;
  // Isolate the extension persistence layer so enablePlugin doesn't write
  // to the developer's real ~/.grok/extensions.json.
  process.env.CODESURF_CONFIG_DIR = tempConfigDir;
  // Isolate cardId recovery: CodesurfDesktopSession falls back to
  // $HOME/.contex/.last-card-id (and $CARD_ID). A developer machine running
  // CodeSurf has a real saved tile id there, which would replace the
  // synthesized "codesurf-<conversationId>" cardId these tests assert on.
  process.env.HOME = tempHome;
  delete process.env.CARD_ID;
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.CODESURF_HOME;
  else process.env.CODESURF_HOME = originalHome;
  if (originalConfigDir === undefined) delete process.env.CODESURF_CONFIG_DIR;
  else process.env.CODESURF_CONFIG_DIR = originalConfigDir;
  if (originalUserHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalUserHome;
  if (originalCardIdEnv === undefined) delete process.env.CARD_ID;
  else process.env.CARD_ID = originalCardIdEnv;
  try {
    fs.rmSync(tempHome, { recursive: true, force: true });
  } catch {}
  try {
    fs.rmSync(tempConfigDir, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  // Clear the temp home + persistence between tests so enable/disable state
  // doesn't leak across cases.
  fs.rmSync(path.join(tempHome, "daemon"), { recursive: true, force: true });
  fs.rmSync(path.join(tempHome, "jobs"), { recursive: true, force: true });
  fs.rmSync(path.join(tempHome, "timelines"), { recursive: true, force: true });
  // .last-card-id persists the synthesized cardId across session constructions;
  // without this each test would inherit the previous test's cardId.
  fs.rmSync(path.join(tempHome, ".contex"), { recursive: true, force: true });
  for (const file of ["extensions.json", "credentials.json"]) {
    const p = path.join(tempConfigDir, file);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe("model id codec", () => {
  it("round-trips every shipped model", () => {
    for (const spec of MODELS) {
      const id = encodeModelId(spec);
      expect(id.startsWith("codesurf:")).toBe(true);
      const decoded = decodeModelId(id);
      expect(decoded).toEqual({ downstream: spec.downstream, model: spec.model });
    }
  });

  it("rejects malformed ids", () => {
    expect(decodeModelId("claude-sonnet-4-5")).toBeNull();
    expect(decodeModelId("codesurf:claude")).toBeNull();
    expect(decodeModelId("codesurf:bogus/whatever")).toBeNull();
    expect(decodeModelId("codesurf:/missing-provider")).toBeNull();
  });
});

describe("daemon model catalog parser", () => {
  it("normalizes provider-scoped daemon catalog payloads", () => {
    const models = parseCodesurfModelCatalog({
      providers: [
        {
          id: "codex",
          label: "Codex",
          models: [
            {
              id: "gpt-5.6",
              label: "GPT-5.6",
              description: "From daemon",
              contextWindow: 300_000,
              capabilities: { tools: true, reasoning: true },
            },
          ],
        },
      ],
    });

    expect(models).toEqual([
      {
        downstream: "codex",
        model: "gpt-5.6",
        label: "GPT-5.6",
        description: "From daemon",
        contextWindow: 300_000,
        maxOutputTokens: undefined,
        capabilities: { tools: true, reasoning: true, images: undefined },
      },
    ]);
  });

  it("fills Claude context windows from the Anthropic catalog when the daemon omits them", () => {
    const models = parseCodesurfModelCatalog({
      providers: [
        {
          id: "claude",
          models: [
            { id: "claude-opus-5-5" },
            { id: "claude-sonnet-5-5" },
            { id: "claude-haiku-5-5" },
            { id: "claude-haiku-4-5-20251001" },
            { id: "claude-opus-5-5", contextWindow: 123 },
          ],
        },
        { id: "opencode", models: [{ id: "anthropic/claude-sonnet-5-5" }, { id: "openai/o4-mini" }] },
      ],
    });

    expect(models.map((m) => [m.downstream, m.model, m.contextWindow])).toEqual([
      ["claude", "claude-opus-5-5", 1_000_000],
      ["claude", "claude-sonnet-5-5", 1_000_000],
      ["claude", "claude-haiku-5-5", 1_000_000],
      ["claude", "claude-haiku-4-5-20251001", 200_000],
      ["opencode", "anthropic/claude-sonnet-5-5", 1_000_000],
      ["opencode", "openai/o4-mini", undefined],
    ]);
  });
});

describe("home resolution", () => {
  it("prefers explicit override over env", () => {
    expect(resolveCodesurfHome("/tmp/explicit")).toBe("/tmp/explicit");
  });
  it("uses CODESURF_HOME env when no override given", () => {
    expect(resolveCodesurfHome("")).toBe(tempHome);
  });
  it("falls back to ~/.codesurf as the primary default", () => {
    delete process.env.CODESURF_HOME;
    try {
      // Neither ~/.codesurf nor ~/.contex have a daemon pid file in this
      // test env (we can't write to the real homedir), so the resolver
      // returns the primary default for clean error messaging.
      const resolved = resolveCodesurfHome("");
      expect(resolved).toBe(importTimeDefaultHome);
    } finally {
      process.env.CODESURF_HOME = tempHome;
    }
  });
});

// ── End-to-end sendTurn ──────────────────────────────────────────────────────

describe("CodesurfDesktopSession.sendTurn", () => {
  it("posts /chat/job/start, streams events, and translates them", async () => {
    writePidFile(tempHome, { appVersion: null });

    const session = new CodesurfDesktopSession({
      conversationId: "conv-1",
      resolveHome: () => tempHome,
      resolveExecutionTarget: () => "local",
      resolveRunMode: () => "foreground",
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (
      input: string | URL | Request,
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/chat/card/events")) return makeJsonResponse({ error: "not found" }, 404);
      if (url.includes("/health")) return makeHealthResponse(tempHome);
      if (url.includes("/workspace/list")) return makeWorkspaceListResponse();
      if (url.includes("/dashboard/api/jobs")) return makeJsonResponse({ jobs: [] });
      if (url.includes("/chat/job/start")) return makeJsonResponse({ id: "job-1", status: "running" });
      if (url.includes("/chat/job/events")) {
        const stream = makeSseStream([
          { type: "session", sessionId: "sess-xyz" },
          { type: "text", text: "Hello " },
          { type: "text", text: "world" },
          { type: "tool_start", toolId: "t1", toolName: "Read" },
          { type: "tool_input", toolId: "t1", text: '{"file":' },
          { type: "tool_input", toolId: "t1", text: '"x.ts"}' },
          { type: "tool_summary", toolId: "t1", text: "(file contents)" },
          { type: "done" },
        ]);
        return makeStreamResponse(stream);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch);

    const { events, controller } = collectStream();

    const turn: ProviderTurnInput = {
      conversationId: "conv-1",
      providerId: "codesurf",
      adapterId: "codesurf.daemon",
      modelId: "codesurf:claude/claude-sonnet-4-5",
      prompt: "Hi",
      messages: [{ role: "user", content: "Hi" }],
    };

    const result = await session.sendTurn(turn, controller);
    expect(result).toBeDefined();

    // Check the event sequence — status, text deltas joined, tool-call,
    // tool-result, done.
    const types = events.map((e) => e.type);
    expect(types).toContain("text-delta");
    expect(types).toContain("tool-call");
    expect(types).toContain("tool-result");
    expect(types[types.length - 1]).toBe("done");

    const textDeltas = events
      .filter((e): e is Extract<ProviderStreamEvent, { type: "text-delta" }> => e.type === "text-delta")
      .map((e) => e.delta)
      .join("");
    expect(textDeltas).toBe("Hello world");

    const toolCall = events.find(
      (e): e is Extract<ProviderStreamEvent, { type: "tool-call" }> => e.type === "tool-call",
    );
    expect(toolCall?.toolName).toBe("Read");
    expect(toolCall?.args).toEqual({ file: "x.ts" });

    // Verify the request payload sent to /chat/job/start.
    const startCall = fetchSpy.mock.calls.find((call) => String(call[0]).includes("/chat/job/start"));
    expect(startCall).toBeDefined();
    const init = startCall![1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
    const body = JSON.parse(init.body as string) as { request: Record<string, unknown> };
    expect(body.request.provider).toBe("claude");
    expect(body.request.model).toBe("claude-sonnet-4-5");
    expect(body.request.cardId).toBe("codesurf-conv-1");
    expect(body.request.sessionId).toBeNull(); // first turn

    // Second turn should reuse the sessionId emitted on turn 1.
    fetchSpy.mockClear();
    fetchSpy.mockImplementation((async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/chat/card/events")) return makeJsonResponse({ error: "not found" }, 404);
      if (url.includes("/health")) return makeHealthResponse(tempHome);
      if (url.includes("/workspace/list")) return makeWorkspaceListResponse();
      if (url.includes("/chat/job/start")) return makeJsonResponse({ id: "job-2", status: "running" });
      if (url.includes("/chat/job/events"))
        return makeStreamResponse(makeSseStream([{ type: "text", text: "ack" }, { type: "done" }]));
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch);

    await session.sendTurn(
      {
        ...turn,
        prompt: "Again",
        messages: [
          { role: "user", content: "Hi" },
          { role: "assistant", content: "Hello world" },
          { role: "user", content: "Again" },
        ],
      },
      collectStream().controller,
    );

    const startCall2 = fetchSpy.mock.calls.find((call) => String(call[0]).includes("/chat/job/start"));
    const body2 = JSON.parse((startCall2![1] as RequestInit).body as string) as { request: Record<string, unknown> };
    expect(body2.request.sessionId).toBe("sess-xyz");
  });

  it("shows a claude tool call at tool_use, before its result, and marks failed results", async () => {
    writePidFile(tempHome, { appVersion: null });
    const session = new CodesurfDesktopSession({
      conversationId: "conv-tooluse",
      resolveHome: () => tempHome,
      resolveExecutionTarget: () => "local",
      resolveRunMode: () => "foreground",
    });
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/chat/card/events")) return makeJsonResponse({ error: "not found" }, 404);
      if (url.includes("/health")) return makeHealthResponse(tempHome);
      if (url.includes("/workspace/list")) return makeWorkspaceListResponse();
      if (url.includes("/dashboard/api/jobs")) return makeJsonResponse({ jobs: [] });
      if (url.includes("/chat/job/start")) return makeJsonResponse({ id: "job-tu", status: "running" });
      if (url.includes("/chat/job/events")) {
        return makeStreamResponse(
          makeSseStream([
            { type: "tool_start", toolId: "t1", toolName: "Bash" },
            { type: "tool_input", toolId: "t1", text: '{"command":' },
            { type: "tool_use", toolId: "t1", toolName: "Bash", toolInput: '{"command":"ls"}' },
            { type: "text", text: "waiting" },
            { type: "tool_summary", toolId: "t1", text: "boom", isError: true },
            { type: "done" },
          ]),
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch);

    const { events, controller } = collectStream();
    await session.sendTurn(
      {
        conversationId: "conv-tooluse",
        providerId: "codesurf",
        adapterId: "codesurf.daemon",
        modelId: "codesurf:claude/claude-sonnet-5",
        prompt: "go",
        messages: [{ role: "user", content: "go" }],
      },
      controller,
    );

    const types = events.map((e) => e.type);
    const callIndex = types.indexOf("tool-call");
    expect(callIndex).toBeGreaterThanOrEqual(0);
    expect(callIndex).toBeLessThan(types.indexOf("text-delta"));
    expect(types.filter((t) => t === "tool-call")).toHaveLength(1);
    const call = events[callIndex] as Extract<ProviderStreamEvent, { type: "tool-call" }>;
    expect(call.args).toEqual({ command: "ls" });
    const result = events.find(
      (e): e is Extract<ProviderStreamEvent, { type: "tool-result" }> => e.type === "tool-result",
    );
    expect(result?.id).toBe("t1");
    expect(result?.isError).toBe(true);
  });

  it("puts a paragraph break between text blocks split by a tool", async () => {
    writePidFile(tempHome, { appVersion: null });
    const session = new CodesurfDesktopSession({
      conversationId: "conv-blocks",
      resolveHome: () => tempHome,
      resolveExecutionTarget: () => "local",
      resolveRunMode: () => "foreground",
    });
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/chat/card/events")) return makeJsonResponse({ error: "not found" }, 404);
      if (url.includes("/health")) return makeHealthResponse(tempHome);
      if (url.includes("/workspace/list")) return makeWorkspaceListResponse();
      if (url.includes("/dashboard/api/jobs")) return makeJsonResponse({ jobs: [] });
      if (url.includes("/chat/job/start")) return makeJsonResponse({ id: "job-blocks", status: "running" });
      if (url.includes("/chat/job/events")) {
        return makeStreamResponse(
          makeSseStream([
            { type: "text", text: "Let me look" },
            { type: "text", text: " at it." },
            { type: "block_stop", index: 0 },
            { type: "tool_use", toolId: "t1", toolName: "Read", toolInput: "{}" },
            { type: "block_stop", index: 1 },
            { type: "tool_summary", toolId: "t1", text: "ok" },
            { type: "text", text: "Found it." },
            { type: "done" },
          ]),
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch);
    const { events, controller } = collectStream();
    await session.sendTurn(
      {
        conversationId: "conv-blocks",
        providerId: "codesurf",
        adapterId: "codesurf.daemon",
        modelId: "codesurf:claude/claude-sonnet-5",
        prompt: "go",
        messages: [{ role: "user", content: "go" }],
      },
      controller,
    );
    const text = events
      .filter((e): e is Extract<ProviderStreamEvent, { type: "text-delta" }> => e.type === "text-delta")
      .map((e) => e.delta)
      .join("");
    expect(text).toBe("Let me look at it.\n\nFound it.");
  });

  it("pairs orphan daemon tool_summary events with a synthesized tool-call name", async () => {
    writePidFile(tempHome, { appVersion: null });

    const session = new CodesurfDesktopSession({
      conversationId: "conv-orphan-summary",
      resolveHome: () => tempHome,
      resolveExecutionTarget: () => "local",
      resolveRunMode: () => "foreground",
    });

    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/chat/card/events")) return makeJsonResponse({ error: "not found" }, 404);
      if (url.includes("/health")) return makeHealthResponse(tempHome);
      if (url.includes("/workspace/list")) return makeWorkspaceListResponse();
      if (url.includes("/dashboard/api/jobs")) return makeJsonResponse({ jobs: [] });
      if (url.includes("/chat/job/start")) return makeJsonResponse({ id: "job-orphan", status: "running" });
      if (url.includes("/chat/job/events")) {
        return makeStreamResponse(
          makeSseStream([
            { sequence: 1, type: "tool_start", toolId: "codex-file-changes", toolName: "Edited 1 file" },
            { sequence: 2, type: "tool_summary", toolId: "codex-file-changes", toolName: "Edited 1 file" },
            // The daemon can emit a follow-up summary for the same toolId after
            // the first summary has already closed the pending tool. This used
            // to become a bare tool-result, which the agent displayed as UNKNOWN.
            { sequence: 3, type: "tool_summary", toolId: "codex-file-changes", toolName: "Edited 1 file" },
            { sequence: 4, type: "done" },
          ]),
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch);

    const { events, controller } = collectStream();
    await session.sendTurn(
      {
        conversationId: "conv-orphan-summary",
        providerId: "codesurf",
        adapterId: "codesurf.daemon",
        modelId: "codesurf:claude/claude-sonnet-4-5",
        prompt: "Hi",
        messages: [{ role: "user", content: "Hi" }],
      },
      controller,
    );

    const toolCalls = events.filter(
      (e): e is Extract<ProviderStreamEvent, { type: "tool-call" }> => e.type === "tool-call",
    );
    const toolResults = events.filter(
      (e): e is Extract<ProviderStreamEvent, { type: "tool-result" }> => e.type === "tool-result",
    );

    expect(toolCalls).toHaveLength(2);
    expect(toolCalls.map((e) => e.toolName)).toEqual(["Edited 1 file", "Edited 1 file"]);
    expect(toolCalls[1]!.id).toBe("codex-file-changes:3");
    expect(toolResults.map((e) => e.id)).toEqual(toolCalls.map((e) => e.id));
    expect(toolResults.map((e) => e.result)).toEqual(["Success", "Success"]);
  });

  it("recovers the daemon session id from daemon job metadata for the same local session", async () => {
    writePidFile(tempHome);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (
      input: string | URL | Request,
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/chat/card/events")) return makeJsonResponse({ error: "not found" }, 404);
      if (url.includes("/health")) return makeHealthResponse(tempHome);
      if (url.includes("/workspace/list")) return makeWorkspaceListResponse();
      if (url.includes("/dashboard/api/jobs")) return makeJsonResponse({ jobs: [] });
      if (url.includes("/chat/job/start")) return makeJsonResponse({ id: "job-1", status: "running" });
      if (url.includes("/chat/job/events"))
        return makeStreamResponse(makeSseStream([{ type: "session", sessionId: "sess-persisted" }, { type: "done" }]));
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch);

    const first = new CodesurfDesktopSession({
      conversationId: "conv-persist",
      resolveHome: () => tempHome,
      resolveExecutionTarget: () => "local",
      resolveRunMode: () => "foreground",
    });

    const turn: ProviderTurnInput = {
      conversationId: "conv-persist",
      providerId: "codesurf",
      adapterId: "codesurf.daemon",
      modelId: "codesurf:claude/claude-sonnet-4-5",
      prompt: "Hi",
      messages: [{ role: "user", content: "Hi" }],
    };

    await first.sendTurn(turn, collectStream().controller);

    fetchSpy.mockClear();
    fetchSpy.mockImplementation((async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/chat/card/events")) return makeJsonResponse({ error: "not found" }, 404);
      if (url.includes("/health")) return makeHealthResponse(tempHome);
      if (url.includes("/workspace/list")) return makeWorkspaceListResponse();
      if (url.includes("/dashboard/api/jobs")) {
        return makeJsonResponse({
          jobs: [
            {
              cardId: "codesurf-conv-persist",
              sessionId: "sess-persisted",
              updatedAt: new Date().toISOString(),
            },
          ],
        });
      }
      if (url.includes("/chat/job/start")) return makeJsonResponse({ id: "job-2", status: "running" });
      if (url.includes("/chat/job/events")) return makeStreamResponse(makeSseStream([{ type: "done" }]));
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch);

    const second = new CodesurfDesktopSession({
      conversationId: "conv-persist",
      resolveHome: () => tempHome,
      resolveExecutionTarget: () => "local",
      resolveRunMode: () => "foreground",
    });

    await second.sendTurn({ ...turn, prompt: "Again" }, collectStream().controller);

    const startCall = fetchSpy.mock.calls.find((call) => String(call[0]).includes("/chat/job/start"));
    const body = JSON.parse((startCall![1] as RequestInit).body as string) as { request: Record<string, unknown> };
    expect(body.request.sessionId).toBe("sess-persisted");
  });

  it("does not recover a dashboard session id from another workspace", async () => {
    writePidFile(tempHome);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (
      input: string | URL | Request,
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/chat/card/events")) return makeJsonResponse({ error: "not found" }, 404);
      if (url.includes("/health")) return makeHealthResponse(tempHome);
      if (url.includes("/workspace/list")) return makeWorkspaceListResponse();
      if (url.includes("/dashboard/api/jobs")) {
        return makeJsonResponse({
          jobs: [
            {
              cardId: "codesurf-conv-dashboard-workspace",
              sessionId: "sess-other-workspace",
              workspaceDir: "/tmp/not-this-workspace",
              updatedAt: "2026-06-15T09:00:00.000Z",
            },
            {
              cardId: "codesurf-conv-dashboard-workspace",
              sessionId: "sess-current-workspace",
              workspaceDir: process.cwd(),
              updatedAt: "2026-06-15T08:00:00.000Z",
            },
          ],
        });
      }
      if (url.includes("/chat/job/start"))
        return makeJsonResponse({ id: "job-dashboard-workspace", status: "running" });
      if (url.includes("/chat/job/events")) return makeStreamResponse(makeSseStream([{ type: "done" }]));
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch);

    const session = new CodesurfDesktopSession({
      conversationId: "conv-dashboard-workspace",
      resolveHome: () => tempHome,
      resolveExecutionTarget: () => "local",
      resolveRunMode: () => "foreground",
    });

    await session.sendTurn(
      {
        conversationId: "conv-dashboard-workspace",
        providerId: "codesurf",
        adapterId: "codesurf.daemon",
        modelId: "codesurf:claude/claude-sonnet-4-5",
        prompt: "Again",
        messages: [{ role: "user", content: "Again" }],
      },
      collectStream().controller,
    );

    const startCall = fetchSpy.mock.calls.find((call) => String(call[0]).includes("/chat/job/start"));
    const body = JSON.parse((startCall![1] as RequestInit).body as string) as { request: Record<string, unknown> };
    expect(body.request.sessionId).toBe("sess-current-workspace");
  });

  it("recovers the daemon session id from local job files before posting", async () => {
    writePidFile(tempHome);
    fs.mkdirSync(path.join(tempHome, "jobs"), { recursive: true });
    fs.writeFileSync(
      path.join(tempHome, "jobs", "job-prior.json"),
      `${JSON.stringify({
        id: "job-prior",
        taskLabel: "Existing title",
        provider: "claude",
        model: "claude-sonnet-4-5",
        cardId: "codesurf-conv-disk",
        workspaceDir: process.cwd(),
        status: "done",
        sessionId: "sess-from-disk",
        requestedAt: "2026-05-04T10:00:00.000Z",
        updatedAt: "2026-05-04T10:00:00.000Z",
      })}\n`,
      "utf8",
    );

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (
      input: string | URL | Request,
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/chat/card/events")) return makeJsonResponse({ error: "not found" }, 404);
      if (url.includes("/health")) return makeHealthResponse(tempHome);
      if (url.includes("/workspace/list")) return makeWorkspaceListResponse();
      if (url.includes("/dashboard/api/jobs")) return makeJsonResponse({ jobs: [] });
      if (url.includes("/chat/job/start")) return makeJsonResponse({ id: "job-disk", status: "running" });
      if (url.includes("/chat/job/events")) return makeStreamResponse(makeSseStream([{ type: "done" }]));
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch);

    const session = new CodesurfDesktopSession({
      conversationId: "conv-disk",
      resolveHome: () => tempHome,
      resolveExecutionTarget: () => "local",
      resolveRunMode: () => "foreground",
    });

    await session.sendTurn(
      {
        conversationId: "conv-disk",
        providerId: "codesurf",
        adapterId: "codesurf.daemon",
        modelId: "codesurf:claude/claude-sonnet-4-5",
        prompt: "Again",
        messages: [{ role: "user", content: "Again" }],
      },
      collectStream().controller,
    );

    const startCall = fetchSpy.mock.calls.find((call) => String(call[0]).includes("/chat/job/start"));
    const body = JSON.parse((startCall![1] as RequestInit).body as string) as { request: Record<string, unknown> };
    expect(body.request.sessionId).toBe("sess-from-disk");
  });

  it("recovers a session id stored under the legacy grok-cli- cardId prefix", async () => {
    writePidFile(tempHome);
    fs.mkdirSync(path.join(tempHome, "jobs"), { recursive: true });
    // Job persisted by an older codesurf CLI build that synthesized cardIds as
    // grok-cli-<conv>. The new build synthesizes codesurf-<conv>, so without a
    // legacy-prefix fallback this on-disk record would be unreachable.
    fs.writeFileSync(
      path.join(tempHome, "jobs", "job-legacy.json"),
      `${JSON.stringify({
        id: "job-legacy",
        taskLabel: "Legacy title",
        provider: "claude",
        model: "claude-sonnet-4-5",
        cardId: "grok-cli-conv-legacy",
        workspaceDir: process.cwd(),
        status: "done",
        sessionId: "sess-legacy",
        requestedAt: "2026-05-04T09:00:00.000Z",
        updatedAt: "2026-05-04T09:00:00.000Z",
      })}\n`,
      "utf8",
    );

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (
      input: string | URL | Request,
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/chat/card/events")) return makeJsonResponse({ error: "not found" }, 404);
      if (url.includes("/health")) return makeHealthResponse(tempHome);
      if (url.includes("/workspace/list")) return makeWorkspaceListResponse();
      if (url.includes("/dashboard/api/jobs")) return makeJsonResponse({ jobs: [] });
      if (url.includes("/chat/job/start")) return makeJsonResponse({ id: "job-legacy-resume", status: "running" });
      if (url.includes("/chat/job/events")) return makeStreamResponse(makeSseStream([{ type: "done" }]));
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch);

    const session = new CodesurfDesktopSession({
      conversationId: "conv-legacy",
      resolveHome: () => tempHome,
      resolveExecutionTarget: () => "local",
      resolveRunMode: () => "foreground",
    });

    await session.sendTurn(
      {
        conversationId: "conv-legacy",
        providerId: "codesurf",
        adapterId: "codesurf.daemon",
        modelId: "codesurf:claude/claude-sonnet-4-5",
        prompt: "Hello",
        messages: [{ role: "user", content: "Hello" }],
      },
      collectStream().controller,
    );

    const startCall = fetchSpy.mock.calls.find((call) => String(call[0]).includes("/chat/job/start"));
    const body = JSON.parse((startCall![1] as RequestInit).body as string) as { request: Record<string, unknown> };
    expect(body.request.sessionId).toBe("sess-legacy");
    // The new request itself goes out under the codesurf- prefix even though the
    // recovered session originated from a grok-cli- record.
    expect(body.request.cardId).toBe("codesurf-conv-legacy");
  });

  it("resumes the daemon event stream when the SSE reader ends before a terminal event", async () => {
    writePidFile(tempHome);

    const session = new CodesurfDesktopSession({
      conversationId: "conv-resume",
      resolveHome: () => tempHome,
      resolveExecutionTarget: () => "local",
      resolveRunMode: () => "foreground",
    });

    const eventUrls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/chat/card/events")) return makeJsonResponse({ error: "not found" }, 404);
      if (url.includes("/health")) return makeHealthResponse(tempHome);
      if (url.includes("/workspace/list")) return makeWorkspaceListResponse();
      if (url.includes("/dashboard/api/jobs")) return makeJsonResponse({ jobs: [] });
      if (url.includes("/chat/job/start")) return makeJsonResponse({ id: "job-resume", status: "running" });
      if (url.includes("/chat/job/state")) {
        return makeJsonResponse({
          id: "job-resume",
          status: "running",
          lastSequence: 2,
          sessionId: "sess-resume",
        });
      }
      if (url.includes("/chat/job/events")) {
        eventUrls.push(url);
        if (url.includes("since=0")) {
          return makeStreamResponse(
            makeSseStream([
              { type: "session", sessionId: "sess-resume", sequence: 1 },
              { type: "text", text: "partial ", sequence: 2 },
            ]),
          );
        }
        if (url.includes("since=2")) {
          return makeStreamResponse(
            makeSseStream([
              { type: "text", text: "complete", sequence: 3 },
              { type: "done", sequence: 4 },
            ]),
          );
        }
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch);

    const { events, controller } = collectStream();

    await session.sendTurn(
      {
        conversationId: "conv-resume",
        providerId: "codesurf",
        adapterId: "codesurf.daemon",
        modelId: "codesurf:claude/claude-sonnet-4-5",
        prompt: "Hi",
        messages: [{ role: "user", content: "Hi" }],
      },
      controller,
    );

    expect(eventUrls).toHaveLength(2);
    expect(eventUrls[0]).toContain("since=0");
    expect(eventUrls[1]).toContain("since=2");
    const text = events
      .filter((e): e is Extract<ProviderStreamEvent, { type: "text-delta" }> => e.type === "text-delta")
      .map((e) => e.delta)
      .join("");
    expect(text).toBe("partial complete");
    expect(events[events.length - 1]?.type).toBe("done");
  });

  it("emits an error event when the daemon is not running", async () => {
    // No pid file written.
    const session = new CodesurfDesktopSession({
      conversationId: "conv-x",
      resolveHome: () => tempHome,
      resolveExecutionTarget: () => "local",
      resolveRunMode: () => "foreground",
      autoStartDaemon: false,
    });

    const { events, controller } = collectStream();

    await expect(
      session.sendTurn(
        {
          conversationId: "conv-x",
          providerId: "codesurf",
          adapterId: "codesurf.daemon",
          modelId: "codesurf:claude/claude-sonnet-4-5",
          prompt: "Hi",
          messages: [{ role: "user", content: "Hi" }],
        },
        controller,
      ),
    ).rejects.toThrow(/daemon is not running/i);

    // Reported once, by the rejection — the host turns that into the turn's
    // error event, so an emitted copy would paint the failure twice.
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("starts the daemon when auto-start is enabled and no running daemon is found", async () => {
    const ensureRunning = vi.fn(async () => ({
      pid: process.pid,
      port: 42424,
      token: "started-token",
      startedAt: new Date().toISOString(),
      protocolVersion: 1,
      appVersion: "0.0.0-test",
    }));
    const session = new CodesurfDesktopSession({
      conversationId: "conv-autostart",
      resolveHome: () => tempHome,
      resolveExecutionTarget: () => "local",
      resolveRunMode: () => "foreground",
      ensureRunning,
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (
      input: string | URL | Request,
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/chat/card/events")) return makeJsonResponse({ error: "not found" }, 404);
      if (url.includes("/workspace/list")) return makeWorkspaceListResponse();
      if (url.includes("/dashboard/api/jobs")) return makeJsonResponse({ jobs: [] });
      if (url.includes("/chat/job/start")) return makeJsonResponse({ id: "job-autostart", status: "running" });
      if (url.includes("/chat/job/events")) return makeStreamResponse(makeSseStream([{ type: "done" }]));
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch);

    await session.sendTurn(
      {
        conversationId: "conv-autostart",
        providerId: "codesurf",
        adapterId: "codesurf.daemon",
        modelId: "codesurf:claude/claude-sonnet-4-5",
        prompt: "Hi",
        messages: [{ role: "user", content: "Hi" }],
      },
      collectStream().controller,
    );

    expect(ensureRunning).toHaveBeenCalledTimes(1);
    const startCall = fetchSpy.mock.calls.find((call) => String(call[0]).includes("/chat/job/start"));
    expect(String(startCall?.[0])).toContain("http://127.0.0.1:42424/chat/job/start");
    expect(((startCall?.[1] as RequestInit).headers as Record<string, string>).Authorization).toBe(
      "Bearer started-token",
    );
  });

  it("rejects an unknown model id with a clear error", async () => {
    writePidFile(tempHome);
    const session = new CodesurfDesktopSession({
      conversationId: "conv-y",
      resolveHome: () => tempHome,
      resolveExecutionTarget: () => "local",
      resolveRunMode: () => "foreground",
    });

    const { events, controller } = collectStream();

    await expect(
      session.sendTurn(
        {
          conversationId: "conv-y",
          providerId: "codesurf",
          adapterId: "codesurf.daemon",
          modelId: "not-a-codesurf-id",
          prompt: "Hi",
          messages: [{ role: "user", content: "Hi" }],
        },
        controller,
      ),
    ).rejects.toThrow(/Unknown Codesurf model id/);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });
});

// ── Registry plumbing ────────────────────────────────────────────────────────

describe("registration via loadBuiltinPlugins", () => {
  it("appears in the bundle and exposes models when enabled", async () => {
    const { loadBuiltinPlugins } = await import("./builtin");
    const { __resetPluginsForTests, bootstrapPlugins, enablePlugin, getHostServices, getRegistrySnapshot } =
      await import("./index");

    __resetPluginsForTests();
    await bootstrapPlugins(await loadBuiltinPlugins());

    const record = getRegistrySnapshot().extensions.find((e) => e.manifest.id === "builtin.provider-codesurf-desktop");
    expect(record).toBeDefined();
    expect(record?.enabled).toBe(false); // off by default

    await enablePlugin("builtin.provider-codesurf-desktop");

    const codesurfModels = getHostServices()
      .models.list()
      .filter((m) => m.providerId === "codesurf");
    expect(codesurfModels.length).toBeGreaterThan(0);
    expect(codesurfModels.every((m) => m.id.startsWith("codesurf:"))).toBe(true);

    __resetPluginsForTests();
  });
});

describe("workspace binding (CHAT_WORKSPACE_REQUIRED)", () => {
  // The daemon rejects a chat request with no `workspaceId`, so the provider
  // could not complete a single turn: every `hello` came back as
  // {"error":"workspaceId must be a non-empty string"}. The stubs never
  // caught it because they answered /chat/job/start regardless of payload.
  it("resolves the workspace by path and sends its id with the turn", async () => {
    writePidFile(tempHome);
    const session = new CodesurfDesktopSession({
      conversationId: "conv-ws",
      resolveHome: () => tempHome,
      resolveExecutionTarget: () => "local",
      resolveRunMode: () => "foreground",
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (
      input: string | URL | Request,
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/chat/card/events")) return makeJsonResponse({ error: "not found" }, 404);
      if (url.includes("/health")) return makeHealthResponse(tempHome);
      if (url.includes("/workspace/list")) return makeWorkspaceListResponse();
      if (url.includes("/dashboard/api/jobs")) return makeJsonResponse({ jobs: [] });
      if (url.includes("/chat/job/start")) return makeJsonResponse({ id: "job-ws", status: "running" });
      if (url.includes("/chat/job/events")) return makeStreamResponse(makeSseStream([{ type: "done" }]));
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch);

    const { controller } = collectStream();
    await session.sendTurn(
      {
        conversationId: "conv-ws",
        providerId: "codesurf",
        adapterId: "codesurf.daemon",
        modelId: "codesurf:claude/claude-sonnet-4-5",
        prompt: "hello",
        messages: [{ role: "user", content: "hello" }],
      } satisfies ProviderTurnInput,
      controller,
    );

    const startCall = fetchSpy.mock.calls.find((call) => String(call[0]).includes("/chat/job/start"));
    expect(startCall).toBeDefined();
    const body = JSON.parse(String((startCall?.[1] as RequestInit).body)) as {
      request?: { workspaceId?: string; workspaceDir?: string };
    };
    // Matched by path — NOT the daemon's active workspace, which is whatever
    // the desktop app last focused and often has no project root at all.
    expect(body.request?.workspaceId).toBe("ws-cwd");
    expect(body.request?.workspaceDir).toBe(process.cwd());
  });

  it("registers an unregistered folder on first use, without switching the desktop, then runs the turn", async () => {
    writePidFile(tempHome);
    const session = new CodesurfDesktopSession({
      conversationId: "conv-unregistered",
      resolveHome: () => tempHome,
      resolveExecutionTarget: () => "local",
      resolveRunMode: () => "foreground",
    });
    // The test runs inside a git checkout: the repository root is what gets
    // registered, so later runs from any subdirectory land in the same project.
    const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (
      input: string | URL | Request,
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/chat/card/events")) return makeJsonResponse({ error: "not found" }, 404);
      if (url.includes("/health")) return makeHealthResponse(tempHome);
      // Registry holds workspaces, none of them containing this cwd.
      if (url.includes("/workspace/list")) {
        return makeJsonResponse([{ id: "ws-elsewhere", name: "Elsewhere", path: "/nope", projectPaths: [] }]);
      }
      if (url.includes("/workspace/create-from-folder")) {
        return makeJsonResponse({ id: "ws-registered", name: "repo", path: repoRoot, projectPaths: [repoRoot] });
      }
      if (url.includes("/dashboard/api/jobs")) return makeJsonResponse({ jobs: [] });
      if (url.includes("/chat/job/start")) return makeJsonResponse({ id: "job-registered", status: "running" });
      if (url.includes("/chat/job/events")) return makeStreamResponse(makeSseStream([{ type: "done" }]));
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch);

    await session.sendTurn(
      {
        conversationId: "conv-unregistered",
        providerId: "codesurf",
        adapterId: "codesurf.daemon",
        modelId: "codesurf:claude/claude-sonnet-4-5",
        prompt: "hello",
        messages: [{ role: "user", content: "hello" }],
      } satisfies ProviderTurnInput,
      collectStream().controller,
    );

    const registerCall = fetchSpy.mock.calls.find((call) => String(call[0]).includes("/workspace/create-from-folder"));
    expect(registerCall).toBeDefined();
    expect(JSON.parse((registerCall![1] as RequestInit).body as string)).toEqual({
      folderPath: repoRoot,
      activate: false,
    });
    const startCall = fetchSpy.mock.calls.find((call) => String(call[0]).includes("/chat/job/start"));
    const body = JSON.parse((startCall![1] as RequestInit).body as string) as { request: Record<string, unknown> };
    expect(body.request.workspaceId).toBe("ws-registered");
    expect(body.request.workspaceDir).toBe(repoRoot);
  });

  it("says how to fix it when registering the folder fails", async () => {
    writePidFile(tempHome);
    const session = new CodesurfDesktopSession({
      conversationId: "conv-register-fails",
      resolveHome: () => tempHome,
      resolveExecutionTarget: () => "local",
      resolveRunMode: () => "foreground",
    });

    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/chat/card/events")) return makeJsonResponse({ error: "not found" }, 404);
      if (url.includes("/health")) return makeHealthResponse(tempHome);
      if (url.includes("/workspace/list")) return makeJsonResponse([]);
      if (url.includes("/workspace/create-from-folder")) return makeJsonResponse({ error: "boom" }, 500);
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch);

    const { events, controller } = collectStream();
    await expect(
      session.sendTurn(
        {
          conversationId: "conv-register-fails",
          providerId: "codesurf",
          adapterId: "codesurf.daemon",
          modelId: "codesurf:claude/claude-sonnet-4-5",
          prompt: "hello",
          messages: [{ role: "user", content: "hello" }],
        } satisfies ProviderTurnInput,
        controller,
      ),
    ).rejects.toThrow(/Add it under Projects/i);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("looks the workspace up once and reuses it across turns", async () => {
    writePidFile(tempHome);
    const session = new CodesurfDesktopSession({
      conversationId: "conv-ws-cache",
      resolveHome: () => tempHome,
      resolveExecutionTarget: () => "local",
      resolveRunMode: () => "foreground",
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (
      input: string | URL | Request,
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/chat/card/events")) return makeJsonResponse({ error: "not found" }, 404);
      if (url.includes("/health")) return makeHealthResponse(tempHome);
      if (url.includes("/workspace/list")) return makeWorkspaceListResponse();
      if (url.includes("/dashboard/api/jobs")) return makeJsonResponse({ jobs: [] });
      if (url.includes("/chat/job/start")) return makeJsonResponse({ id: "job-ws-cache", status: "running" });
      if (url.includes("/chat/job/events")) return makeStreamResponse(makeSseStream([{ type: "done" }]));
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch);

    const turn = {
      conversationId: "conv-ws-cache",
      providerId: "codesurf",
      adapterId: "codesurf.daemon",
      modelId: "codesurf:claude/claude-sonnet-4-5",
      prompt: "hello",
      messages: [{ role: "user", content: "hello" }],
    } satisfies ProviderTurnInput;

    await session.sendTurn(turn, collectStream().controller);
    await session.sendTurn(turn, collectStream().controller);

    const listCalls = fetchSpy.mock.calls.filter((call) => String(call[0]).includes("/workspace/list"));
    expect(listCalls).toHaveLength(1);
  });
});

// ── Release-fix regressions ──────────────────────────────────────────────────

function urlOf(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

const baseTurn = (conversationId: string): ProviderTurnInput => ({
  conversationId,
  providerId: "codesurf",
  adapterId: "codesurf.daemon",
  modelId: "codesurf:claude/claude-sonnet-4-5",
  prompt: "hello",
  messages: [{ role: "user", content: "hello" }],
});

function newSession(conversationId: string, cardIdOverride?: string): CodesurfDesktopSession {
  return new CodesurfDesktopSession({
    conversationId,
    resolveHome: () => tempHome,
    resolveExecutionTarget: () => "local",
    resolveRunMode: () => "foreground",
    cardIdOverride,
  });
}

describe("release-fix regressions", () => {
  it("does not reuse the global last-card-id for a new conversation (H2)", async () => {
    writePidFile(tempHome);
    // A previous conversation (or a since-cleared tile override) left this
    // behind; a new chat must not resume its daemon session / tile.
    fs.mkdirSync(path.join(tempHome, ".contex"), { recursive: true });
    fs.writeFileSync(path.join(tempHome, ".contex", ".last-card-id"), "old-tile", "utf8");

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
      const url = urlOf(input);
      if (url.includes("/chat/card/events")) return makeJsonResponse({ error: "not found" }, 404);
      if (url.includes("/health")) return makeHealthResponse(tempHome);
      if (url.includes("/workspace/list")) return makeWorkspaceListResponse();
      if (url.includes("/dashboard/api/jobs")) {
        return makeJsonResponse({ jobs: [{ cardId: "old-tile", sessionId: "sess-old", workspaceDir: process.cwd() }] });
      }
      if (url.includes("/chat/job/start")) return makeJsonResponse({ id: "job-h2", status: "running" });
      if (url.includes("/chat/job/events")) return makeStreamResponse(makeSseStream([{ type: "done" }]));
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch);

    await newSession("conv-fresh").sendTurn(baseTurn("conv-fresh"), collectStream().controller);

    const startCall = fetchSpy.mock.calls.find((call) => String(call[0]).includes("/chat/job/start"));
    const body = JSON.parse((startCall![1] as RequestInit).body as string) as { request: Record<string, unknown> };
    expect(body.request.cardId).toBe("codesurf-conv-fresh");
    expect(body.request.sessionId).toBeNull();
  });

  it("still routes to the tile when this session sets an explicit cardId override (H2)", async () => {
    writePidFile(tempHome);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
      const url = urlOf(input);
      if (url.includes("/chat/card/events")) return makeJsonResponse({ error: "not found" }, 404);
      if (url.includes("/health")) return makeHealthResponse(tempHome);
      if (url.includes("/workspace/list")) return makeWorkspaceListResponse();
      if (url.includes("/dashboard/api/jobs")) return makeJsonResponse({ jobs: [] });
      if (url.includes("/chat/job/start")) return makeJsonResponse({ id: "job-h2-override", status: "running" });
      if (url.includes("/chat/job/events")) return makeStreamResponse(makeSseStream([{ type: "done" }]));
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch);

    await newSession("conv-tile", "tile-explicit").sendTurn(baseTurn("conv-tile"), collectStream().controller);

    const startCall = fetchSpy.mock.calls.find((call) => String(call[0]).includes("/chat/job/start"));
    const body = JSON.parse((startCall![1] as RequestInit).body as string) as { request: Record<string, unknown> };
    expect(body.request.cardId).toBe("tile-explicit");
  });

  it("cancels the daemon job when the turn is aborted while /chat/job/start is in flight (M8)", async () => {
    writePidFile(tempHome);
    const host = new AbortController();
    const cancelBodies: string[] = [];

    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.includes("/chat/card/events")) return makeJsonResponse({ error: "not found" }, 404);
      if (url.includes("/health")) return makeHealthResponse(tempHome);
      if (url.includes("/workspace/list")) return makeWorkspaceListResponse();
      if (url.includes("/dashboard/api/jobs")) return makeJsonResponse({ jobs: [] });
      if (url.includes("/chat/job/start")) {
        // Esc lands while the daemon is creating the job.
        host.abort();
        return makeJsonResponse({ id: "job-m8", status: "running" });
      }
      if (url.includes("/chat/job/cancel")) {
        cancelBodies.push(String(init?.body));
        return makeJsonResponse({ ok: true });
      }
      if (url.includes("/chat/job/events")) {
        if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        return makeStreamResponse(makeSseStream([{ type: "done" }]));
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch);

    await expect(
      newSession("conv-m8").sendTurn({ ...baseTurn("conv-m8"), abortSignal: host.signal }, collectStream().controller),
    ).rejects.toThrow();
    expect(cancelBodies.map((b) => JSON.parse(b))).toContainEqual({ jobId: "job-m8" });
  });

  it("disconnect() cancels the active daemon job (M8)", async () => {
    writePidFile(tempHome);
    const cancelBodies: string[] = [];
    let releaseStream: (() => void) | null = null;
    let streamStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      streamStarted = resolve;
    });

    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.includes("/chat/card/events")) return makeJsonResponse({ error: "not found" }, 404);
      if (url.includes("/health")) return makeHealthResponse(tempHome);
      if (url.includes("/workspace/list")) return makeWorkspaceListResponse();
      if (url.includes("/dashboard/api/jobs")) return makeJsonResponse({ jobs: [] });
      if (url.includes("/chat/job/start")) return makeJsonResponse({ id: "job-disc", status: "running" });
      if (url.includes("/chat/job/cancel")) {
        cancelBodies.push(String(init?.body));
        return makeJsonResponse({ ok: true });
      }
      if (url.includes("/chat/job/events")) {
        const signal = init?.signal;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            releaseStream = () => controller.error(new DOMException("Aborted", "AbortError"));
            signal?.addEventListener("abort", () => releaseStream?.(), { once: true });
            streamStarted();
          },
        });
        return makeStreamResponse(stream);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch);

    const session = newSession("conv-disc");
    const turn = session.sendTurn(baseTurn("conv-disc"), collectStream().controller);
    await started;
    await session.disconnect();
    await expect(turn).rejects.toThrow(/disconnected/i);
    expect(cancelBodies.map((b) => JSON.parse(b))).toContainEqual({ jobId: "job-disc" });
  });

  it("resolves a cwd inside a registered project root and sends the root as workspaceDir (M5)", async () => {
    writePidFile(tempHome);
    const root = path.dirname(process.cwd());
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
      const url = urlOf(input);
      if (url.includes("/chat/card/events")) return makeJsonResponse({ error: "not found" }, 404);
      if (url.includes("/health")) return makeHealthResponse(tempHome);
      if (url.includes("/workspace/list")) {
        return makeJsonResponse([
          { id: "ws-sibling", path: path.join(root, "definitely-not-cwd"), projectPaths: [] },
          { id: "ws-parent", path: root, projectPaths: [] },
        ]);
      }
      if (url.includes("/dashboard/api/jobs")) return makeJsonResponse({ jobs: [] });
      if (url.includes("/chat/job/start")) return makeJsonResponse({ id: "job-sub", status: "running" });
      if (url.includes("/chat/job/events")) return makeStreamResponse(makeSseStream([{ type: "done" }]));
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch);

    await newSession("conv-sub").sendTurn(baseTurn("conv-sub"), collectStream().controller);

    const startCall = fetchSpy.mock.calls.find((call) => String(call[0]).includes("/chat/job/start"));
    const body = JSON.parse((startCall![1] as RequestInit).body as string) as { request: Record<string, unknown> };
    expect(body.request.workspaceId).toBe("ws-parent");
    // The daemon rejects any workspaceDir that is not exactly the root.
    expect(body.request.workspaceDir).toBe(root);
  });

  it("times out the workspace lookup even when the host passes an abort signal (M5)", async () => {
    writePidFile(tempHome);
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    // Make the 5s lookup timeout fire immediately; leave other timeouts real.
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) =>
      ms === 5_000 ? AbortSignal.abort(new DOMException("timed out", "TimeoutError")) : realTimeout(ms),
    );
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.includes("/chat/card/events")) return makeJsonResponse({ error: "not found" }, 404);
      if (url.includes("/health")) return makeHealthResponse(tempHome);
      if (url.includes("/workspace/list")) {
        // A wedged daemon: never answers, only honours its abort signal.
        return await new Promise<Response>((_, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) reject(signal.reason);
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch);

    const host = new AbortController();
    await expect(
      newSession("conv-timeout").sendTurn(
        { ...baseTurn("conv-timeout"), abortSignal: host.signal },
        collectStream().controller,
      ),
    ).rejects.toThrow(/Could not read the CodeSurf workspace list/);
  }, 2_000);

  it("skips a single unparsable SSE frame instead of ending the turn with an error (M9)", async () => {
    writePidFile(tempHome);
    const encoder = new TextEncoder();
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
      const url = urlOf(input);
      if (url.includes("/chat/card/events")) return makeJsonResponse({ error: "not found" }, 404);
      if (url.includes("/health")) return makeHealthResponse(tempHome);
      if (url.includes("/workspace/list")) return makeWorkspaceListResponse();
      if (url.includes("/dashboard/api/jobs")) return makeJsonResponse({ jobs: [] });
      if (url.includes("/chat/job/start")) return makeJsonResponse({ id: "job-m9", status: "running" });
      if (url.includes("/chat/job/events")) {
        return makeStreamResponse(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode('data: {"type":"text","text":"a"}\n\n'));
              controller.enqueue(encoder.encode('data: {"type":"text","te\n\n'));
              controller.enqueue(encoder.encode('data: {"type":"text","text":"b"}\n\n'));
              controller.enqueue(encoder.encode('data: {"type":"done"}\n\n'));
              controller.close();
            },
          }),
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch);

    const { events, controller } = collectStream();
    await newSession("conv-m9").sendTurn(baseTurn("conv-m9"), controller);

    expect(events.some((e) => e.type === "error")).toBe(false);
    const text = events
      .filter((e): e is Extract<ProviderStreamEvent, { type: "text-delta" }> => e.type === "text-delta")
      .map((e) => e.delta)
      .join("");
    expect(text).toBe("ab");
    expect(events[events.length - 1]?.type).toBe("done");
  });

  it("reports a daemon error event once, by rejecting (L7)", async () => {
    writePidFile(tempHome);
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
      const url = urlOf(input);
      if (url.includes("/chat/card/events")) return makeJsonResponse({ error: "not found" }, 404);
      if (url.includes("/health")) return makeHealthResponse(tempHome);
      if (url.includes("/workspace/list")) return makeWorkspaceListResponse();
      if (url.includes("/dashboard/api/jobs")) return makeJsonResponse({ jobs: [] });
      if (url.includes("/chat/job/start")) return makeJsonResponse({ id: "job-l7", status: "running" });
      if (url.includes("/chat/job/events")) {
        return makeStreamResponse(makeSseStream([{ type: "error", error: "upstream exploded" }]));
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch);

    const { events, controller } = collectStream();
    await expect(newSession("conv-l7").sendTurn(baseTurn("conv-l7"), controller)).rejects.toThrow("upstream exploded");
    expect(events.some((e) => e.type === "error")).toBe(false);
  });
});

describe("persistent card stream integration", () => {
  it("keeps SSE connected between turns and skips repeated daemon discovery", async () => {
    writePidFile(tempHome);
    let sink!: ReadableStreamDefaultController<Uint8Array>;
    let jobs = 0;
    const upstream = new ReadableStream<Uint8Array>({ start: controller => { sink = controller; } });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
      const url = urlOf(input);
      if (url.includes("/health")) return makeHealthResponse(tempHome);
      if (url.includes("/workspace/list")) return makeWorkspaceListResponse();
      if (url.includes("/dashboard/api/jobs")) return makeJsonResponse({ jobs: [] });
      if (url.includes("/chat/card/events")) return makeStreamResponse(upstream);
      if (url.includes("/chat/job/session")) return makeJsonResponse({ ok: true });
      if (url.includes("/chat/job/start")) {
        const id = `persistent-${++jobs}`;
        // Deliberately send before the POST response: the subscription must
        // already exist and retain these until the job id is known.
        for (const event of [
          { jobId: id, sequence: 1, type: "session", sessionId: "persistent-session" },
          { jobId: id, sequence: 2, type: "text", text: id },
          { jobId: id, sequence: 3, type: "done" },
        ]) sink.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
        return makeJsonResponse({ id, status: "running" });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch);
    const session = newSession("persistent-integration");
    try {
      for (let i = 1; i <= 2; i++) {
        const { events, controller } = collectStream();
        await session.sendTurn(baseTurn("persistent-integration"), controller);
        expect(events.some(e => e.type === "text-delta" && e.delta === `persistent-${i}`)).toBe(true);
      }
      const urls = fetchSpy.mock.calls.map(([input]) => urlOf(input));
      expect(urls.filter(url => url.includes("/chat/card/events"))).toHaveLength(1);
      expect(urls.filter(url => url.includes("/chat/job/events"))).toHaveLength(0);
      expect(urls.filter(url => url.includes("/health"))).toHaveLength(1);
      expect(urls.filter(url => url.includes("/workspace/list"))).toHaveLength(1);
    } finally {
      await session.disconnect();
    }
  });
});
