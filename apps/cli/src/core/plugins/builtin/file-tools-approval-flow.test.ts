// End-to-end approval-flow integration test.
//
// Unlike file-tools.test.ts (which only verifies that `needsApproval` is set
// on the tool definition), this test drives the AI SDK 6 streamText loop with
// a MockLanguageModelV3 to prove the full handshake:
//
//   1. needsApproval=true causes streamText to emit a `tool-approval-request`
//      chunk and DOES NOT execute the tool.
//   2. After we push a `tool-approval-response` message and call streamText
//      AGAIN, the SDK executes the approved tool and the model sees the result.
//
// If (2) silently regressed (e.g. SDK upgrade changes the response shape),
// the approval UI would render but Accept would do nothing — which is exactly
// the bug this test is here to prevent.

import { type ModelMessage, streamText, tool } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

// The AI SDK v3 usage shape uses nested counters with a `total` property the
// runtime reads via asLanguageModelUsage(). We don't assert on usage values —
// just make the shape readable enough not to crash.
// biome-ignore lint/suspicious/noExplicitAny: test fixture
const emptyUsage = (): any => ({
  inputTokens: { total: 0 },
  outputTokens: { total: 0 },
  totalTokens: { total: 0 },
});

describe("AI SDK 6 tool-approval flow", () => {
  let tmpDir: string;
  let target: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "approval-flow-test-"));
    target = join(tmpDir, "out.txt");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeTool(executions: { count: number }) {
    return tool({
      description: "Write a file.",
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      needsApproval: () => true,
      execute: async ({ path, content }) => {
        executions.count++;
        const fs = await import("fs");
        fs.writeFileSync(path, content);
        return { success: true, path };
      },
    });
  }

  function makeMockModel(streamCalls: { count: number }, filePath: string) {
    // SDK's discriminated union is hard to satisfy from an inline literal array;
    // the runtime accepts these shapes (verified by the passing tests).
    // biome-ignore lint/suspicious/noExplicitAny: easier than satisfying the SDK union type
    const doStream: any = async () => {
      const idx = streamCalls.count++;
      if (idx === 0) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "response-metadata", id: "r1", timestamp: new Date(), modelId: "mock" },
              {
                type: "tool-call",
                toolCallId: "tc1",
                toolName: "write_file",
                input: JSON.stringify({ path: filePath, content: "hello" }),
              },
              { type: "finish", finishReason: "tool-calls", usage: emptyUsage() },
            ],
          }),
        };
      }
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "response-metadata", id: "r2", timestamp: new Date(), modelId: "mock" },
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "Done." },
            { type: "text-end", id: "t1" },
            { type: "finish", finishReason: "stop", usage: emptyUsage() },
          ],
        }),
      };
    };
    return new MockLanguageModelV3({ doStream });
  }

  it("emits tool-approval-request and does NOT execute when needsApproval=true", async () => {
    const executions = { count: 0 };
    const streamCalls = { count: 0 };
    const writeFileTool = makeTool(executions);
    const model = makeMockModel(streamCalls, target);

    const messages: ModelMessage[] = [{ role: "user", content: "write hello to a file" }];
    const result = streamText({ model, messages, tools: { write_file: writeFileTool } });

    let approvalId: string | undefined;
    let approvedToolCall: { toolCallId: string; toolName: string; input: unknown } | undefined;
    for await (const part of result.fullStream) {
      if (part.type === "tool-approval-request") {
        approvalId = (part as unknown as { approvalId: string }).approvalId;
        approvedToolCall = (part as unknown as { toolCall: typeof approvedToolCall }).toolCall;
      }
    }
    await result.response;

    expect(approvalId).toBeDefined();
    expect(approvedToolCall).toBeDefined();
    expect(approvedToolCall?.toolName).toBe("write_file");
    expect((approvedToolCall?.input as { path: string }).path).toBe(target);
    expect(executions.count).toBe(0);
    expect(existsSync(target)).toBe(false);
  });

  it("executes the tool when streamText is re-invoked with a tool-approval-response", async () => {
    const executions = { count: 0 };
    const streamCalls = { count: 0 };
    const writeFileTool = makeTool(executions);
    const model = makeMockModel(streamCalls, target);

    const initialMessages: ModelMessage[] = [{ role: "user", content: "write hello to a file" }];

    // Turn 1: emits approval-request, tool not executed.
    const turn1 = streamText({ model, messages: initialMessages, tools: { write_file: writeFileTool } });
    let approvalId: string | undefined;
    for await (const part of turn1.fullStream) {
      if (part.type === "tool-approval-request") {
        approvalId = (part as unknown as { approvalId: string }).approvalId;
      }
    }
    const turn1Response = await turn1.response;
    expect(approvalId).toBeDefined();
    expect(executions.count).toBe(0);

    // Turn 2: push the approval-response (this is what respondToToolApproval does)
    // and re-invoke streamText. SDK sees the response, executes the tool, model
    // continues with "Done.".
    const messagesAfter: ModelMessage[] = [
      ...initialMessages,
      ...turn1Response.messages,
      {
        role: "tool",
        content: [{ type: "tool-approval-response" as const, approvalId: approvalId!, approved: true }],
      },
    ];
    const turn2 = streamText({ model, messages: messagesAfter, tools: { write_file: writeFileTool } });
    let toolResultSeen = false;
    let finalText = "";
    for await (const part of turn2.fullStream) {
      if (part.type === "tool-result") toolResultSeen = true;
      if (part.type === "text-delta") finalText += (part as unknown as { text: string }).text;
    }
    await turn2.response;

    expect(executions.count).toBe(1);
    expect(toolResultSeen).toBe(true);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe("hello");
    expect(finalText).toBe("Done.");
  });

  it("does NOT execute when the approval-response is approved=false", async () => {
    const executions = { count: 0 };
    const streamCalls = { count: 0 };
    const writeFileTool = makeTool(executions);
    const model = makeMockModel(streamCalls, target);

    const initialMessages: ModelMessage[] = [{ role: "user", content: "write hello to a file" }];
    const turn1 = streamText({ model, messages: initialMessages, tools: { write_file: writeFileTool } });
    let approvalId: string | undefined;
    for await (const part of turn1.fullStream) {
      if (part.type === "tool-approval-request") {
        approvalId = (part as unknown as { approvalId: string }).approvalId;
      }
    }
    const turn1Response = await turn1.response;

    const messagesAfter: ModelMessage[] = [
      ...initialMessages,
      ...turn1Response.messages,
      {
        role: "tool",
        content: [{ type: "tool-approval-response" as const, approvalId: approvalId!, approved: false }],
      },
    ];
    const turn2 = streamText({ model, messages: messagesAfter, tools: { write_file: writeFileTool } });
    for await (const _ of turn2.fullStream) {
      // drain
    }
    await turn2.response;

    expect(executions.count).toBe(0);
    expect(existsSync(target)).toBe(false);
  });
});
