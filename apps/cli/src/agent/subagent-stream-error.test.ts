import { NoOutputGeneratedError } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMockBashSink } from "./mock-bash-sink";

// Regression: a sub-agent whose stream failed mid-run reported success.
//
// ai v6 surfaces a provider failure as an `error` stream part and then ends
// the stream; it does not throw from the iterator. The sub-agent loop only
// looked at text, tool calls and approval requests, so the error part was
// dropped and the run returned "Task completed" to the parent — which then
// built on work that never happened.

const streamTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, streamText: streamTextMock };
});

type TaskInternals = {
  runTaskRequest(
    request: { agent: string; description: string; prompt: string },
    onActivity?: (detail: string) => void,
    abortSignal?: AbortSignal,
  ): Promise<{ success: boolean; output: string }>;
};

async function newAgent() {
  vi.resetModules();
  vi.doMock("./../core/plugins", async () => {
    const actual = await vi.importActual<typeof import("./../core/plugins")>("./../core/plugins");
    return {
      ...actual,
      resolveModelRuntimeViaKernel: async () => ({
        model: {} as never,
        modelId: "test-model",
        modelInfo: undefined,
        providerOptions: undefined,
      }),
    };
  });
  const { setBashSink } = await import("./../core/plugins");
  setBashSink(buildMockBashSink().sink);
  const { Agent } = await import("./agent");
  return new Agent(undefined, undefined, undefined, undefined, { persistSession: false }) as unknown as TaskInternals;
}

function handledRejection(error: unknown): Promise<never> {
  const promise = Promise.reject(error);
  promise.catch(() => {});
  return promise;
}

afterEach(() => {
  streamTextMock.mockReset();
  vi.restoreAllMocks();
});

describe("sub-agent stream errors", () => {
  it("reports a mid-run stream error as a failure with the real cause", async () => {
    streamTextMock.mockImplementation(() => ({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "Looking at the repo" };
        yield { type: "error", error: new Error("overloaded_error: upstream is overloaded") };
      })(),
      response: handledRejection(new NoOutputGeneratedError()),
    }));
    const agent = await newAgent();

    const result = await agent.runTaskRequest({ agent: "explore", description: "d", prompt: "p" });

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/^Task failed: .*overloaded/);
    expect(result.output).not.toMatch(/Task completed/);
  });

  it("marks a failed tool call in the activity line and keeps running", async () => {
    streamTextMock.mockImplementation(() => ({
      fullStream: (async function* () {
        yield { type: "tool-call", toolCallId: "c1", toolName: "read_file", input: { path: "x" } };
        yield { type: "tool-error", toolCallId: "c1", toolName: "read_file", input: { path: "x" }, error: "EACCES" };
        yield { type: "text-delta", text: "Could not read x." };
      })(),
      response: Promise.resolve({ messages: [] }),
    }));
    const agent = await newAgent();
    const activity: string[] = [];

    const result = await agent.runTaskRequest({ agent: "explore", description: "d", prompt: "p" }, (detail) =>
      activity.push(detail),
    );

    expect(result).toMatchObject({ success: true, output: "Could not read x." });
    expect(activity.at(-1)).toMatch(/\(failed\)$/);
  });
});
