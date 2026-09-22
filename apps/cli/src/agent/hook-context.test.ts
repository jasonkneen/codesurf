import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMockBashSink } from "./mock-bash-sink";

function emptyHookResult(additionalContexts: string[] = []) {
  return {
    blocked: false,
    blockingErrors: [],
    commandErrors: [],
    additionalContexts,
  };
}

function firstStreamTextArgs(streamText: ReturnType<typeof vi.fn>): {
  messages: Array<{ role: string; content: unknown }>;
} {
  return streamText.mock.calls[0]?.[0] as unknown as { messages: Array<{ role: string; content: unknown }> };
}

async function importAgentWithHookContextMocks() {
  vi.resetModules();

  const streamText = vi.fn(() => ({
    fullStream: (async function* () {
      yield { type: "text-delta", text: "ok" };
    })(),
    response: Promise.resolve({ messages: [{ role: "assistant", content: "ok" }] }),
  }));

  vi.doMock("ai", async () => {
    const actual = await vi.importActual<typeof import("ai")>("ai");
    return {
      ...actual,
      streamText,
    };
  });

  const executeEventHooks = vi.fn(async (input: { hook_event_name: string }) => {
    if (input.hook_event_name === "SessionStart") {
      return emptyHookResult(["session-start context"]);
    }
    if (input.hook_event_name === "UserPromptSubmit") {
      return emptyHookResult(["prompt-submit context"]);
    }
    return emptyHookResult();
  });

  vi.doMock("../hooks/index", async () => {
    const actual = await vi.importActual<typeof import("../hooks/index")>("../hooks/index");
    return {
      ...actual,
      executeEventHooks,
    };
  });

  vi.doMock("../storage/index", () => ({
    appendCompaction: vi.fn(),
    appendMessages: vi.fn(() => []),
    buildChatEntries: vi.fn(() => []),
    getNextMessageSequence: vi.fn(() => 0),
    getSessionTotalTokens: vi.fn(() => 0),
    loadTranscript: vi.fn(() => []),
    loadTranscriptState: vi.fn(() => ({ messages: [], seqs: [] })),
    recordUsageEvent: vi.fn(),
    SessionStore: class {
      getWorkspace() {
        return null;
      }
      openSession() {
        return null;
      }
      createSession() {
        return null;
      }
      setModel() {}
      getRequiredSession() {
        return null;
      }
      setMode() {}
      touchSession() {}
    },
  }));

  vi.doMock("../core/plugins", async () => {
    const actual = await vi.importActual<typeof import("../core/plugins")>("../core/plugins");
    return {
      ...actual,
      getEnabledToolSet: vi.fn(() => ({})),
      resolveModelRuntimeViaKernel: vi.fn(async () => ({
        model: { specificationVersion: "v3", provider: "mock", modelId: "mock" },
        modelId: "mock-model",
        modelInfo: {
          contextWindow: 128_000,
          supportsClientTools: false,
          supportsMaxOutputTokens: true,
        },
        providerOptions: undefined,
      })),
      runtimeUsesSendTurn: vi.fn(() => false),
    };
  });

  const { setBashSink } = await import("../core/plugins");
  setBashSink(buildMockBashSink().sink);

  const mod = await import("./agent");
  return {
    ...mod,
    mocks: {
      executeEventHooks,
      streamText,
    },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  try {
    const { setBashSink, setHooksSink } = await import("../core/plugins");
    setBashSink(null);
    setHooksSink(null);
  } catch {}
  vi.resetModules();
  vi.doUnmock("ai");
  vi.doUnmock("../core/plugins");
  vi.doUnmock("../hooks/index");
  vi.doUnmock("../storage/index");
});

describe("Agent hook additionalContexts", () => {
  it("prepends hook context to the user message sent through the normal streamText path", async () => {
    const { Agent, mocks } = await importAgentWithHookContextMocks();
    const agent = new Agent(undefined, undefined, "mock-model", undefined, {
      persistSession: false,
    });

    for await (const _chunk of agent.processMessage("plain prompt")) {
      // Drain the turn.
    }

    const call = firstStreamTextArgs(mocks.streamText);
    expect(call.messages[0]).toMatchObject({ role: "user" });
    expect(call.messages[0]?.content).toBe(
      "<system-reminder>\nsession-start context\n\nprompt-submit context\n</system-reminder>\n\nplain prompt",
    );
  });

  it("keeps hook context in the text part when the prompt is multimodal", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-hook-context-"));
    try {
      const imagePath = path.join(tmpDir, "screen.png");
      fs.writeFileSync(imagePath, Buffer.from([1, 2, 3, 4]));

      const { Agent, mocks } = await importAgentWithHookContextMocks();
      const agent = new Agent(undefined, undefined, "mock-model", undefined, {
        persistSession: false,
      });

      for await (const _chunk of agent.processMessage(`inspect ${imagePath}`)) {
        // Drain the turn.
      }

      const call = firstStreamTextArgs(mocks.streamText);
      const content = call.messages[0]?.content as Array<Record<string, unknown>>;
      expect(content[0]).toMatchObject({ type: "file", mediaType: "image/png" });
      expect(content[1]).toMatchObject({
        type: "text",
        text: `<system-reminder>\nsession-start context\n\nprompt-submit context\n</system-reminder>\n\ninspect ${imagePath}`,
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
