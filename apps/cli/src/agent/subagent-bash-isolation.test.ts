// Regression test for the subagent / verify bash sandbox bypass: the child
// `BashTool` created in `runTaskRequest` was described in the prompt but tool
// execution still ran through the GLOBAL bash service, so delegated commands
// mutated the parent cwd. `SessionToolsets.buildTurn({ bashOverride })` now rebuilds the
// bash-group tools against the child backend. This proves the override lands on
// the `bash` tool and routes execution to the child, not the global sink.

import { tool } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { BashToolBackend } from "../core/plugins/native/bash-tools";
import { buildMockBashSink } from "./mock-bash-sink";

function emptyHookResult() {
  return {
    blocked: false,
    blockingErrors: [],
    commandErrors: [],
    additionalContexts: [],
  };
}

async function importAgentForToolset(globalBashExecute: () => Promise<{ success: boolean; output: string }>) {
  vi.resetModules();

  // No-op every hook path so the child bash tool's runPre/runPost ceremony
  // never touches disk and never blocks.
  vi.doMock("../hooks/index", async () => {
    const actual = await vi.importActual<typeof import("../hooks/index")>("../hooks/index");
    return {
      ...actual,
      executeEventHooks: vi.fn(async () => emptyHookResult()),
      executePreToolHooks: vi.fn(async () => emptyHookResult()),
      executePostToolHooks: vi.fn(async () => emptyHookResult()),
      executePostToolFailureHooks: vi.fn(async () => emptyHookResult()),
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

  // Seed the kernel toolset with a "global-bound" bash tool. If the override
  // fails, executing `tools.bash` would run this and hit the global sink.
  const globalBashTool = tool({
    description: "global bash",
    inputSchema: z.object({ command: z.string() }),
    execute: async () => globalBashExecute(),
  });
  vi.doMock("../core/plugins", async () => {
    const actual = await vi.importActual<typeof import("../core/plugins")>("../core/plugins");
    return {
      ...actual,
      getEnabledToolSet: vi.fn(() => ({ bash: globalBashTool })),
    };
  });

  const { setBashSink } = await import("../core/plugins");
  setBashSink(buildMockBashSink().sink);

  return import("./agent");
}

afterEach(async () => {
  vi.restoreAllMocks();
  try {
    const { setBashSink, setHooksSink } = await import("../core/plugins");
    setBashSink(null);
    setHooksSink(null);
  } catch {}
  vi.resetModules();
  vi.doUnmock("../core/plugins");
  vi.doUnmock("../hooks/index");
  vi.doUnmock("../storage/index");
});

interface ExecutableTool {
  execute: (args: unknown, ctx?: { abortSignal?: AbortSignal }) => Promise<{ success: boolean; output?: string }>;
}

describe("subagent bash isolation — buildTurn bashOverride", () => {
  it("routes the child's bash tool through the child backend, never the global sink", async () => {
    const globalExecute = vi.fn(async () => ({ success: true, output: "GLOBAL" }));
    const { Agent } = await importAgentForToolset(globalExecute);
    const agent = new Agent(undefined, undefined, undefined, undefined, { persistSession: false });

    const childCalls: Array<{ command: string; timeout?: number }> = [];
    const childBash: BashToolBackend = {
      execute: async (command, timeout) => {
        childCalls.push({ command, timeout });
        return { success: true, output: "CHILD" };
      },
      startBackground: async () => ({ success: true, output: "" }),
      getProcessLogs: async () => ({ success: true, output: "" }),
      stopProcess: async () => ({ success: true, output: "" }),
      listProcesses: () => ({ success: true, output: "" }),
    };

    const toolset = await (
      agent as unknown as {
        toolsets: {
          buildTurn: (args: {
            runtime: { modelInfo?: { supportsClientTools?: boolean } };
            mode: string;
            bashOverride?: BashToolBackend;
          }) => Promise<{ tools: Record<string, ExecutableTool> }>;
        };
      }
    ).toolsets.buildTurn({
      runtime: { modelInfo: { supportsClientTools: true } },
      mode: "ask", // ask mode skips the MCP bundle fetch
      bashOverride: childBash,
    });

    expect(toolset.tools.bash).toBeDefined();
    const result = await toolset.tools.bash.execute({ command: "cd /tmp && touch x" });
    expect(result.output).toBe("CHILD");
    expect(childCalls).toEqual([{ command: "cd /tmp && touch x", timeout: undefined }]);
    expect(globalExecute).not.toHaveBeenCalled();
  });

  it("without a bashOverride the global-bound bash tool is left in place", async () => {
    const globalExecute = vi.fn(async () => ({ success: true, output: "GLOBAL" }));
    const { Agent } = await importAgentForToolset(globalExecute);
    const agent = new Agent(undefined, undefined, undefined, undefined, { persistSession: false });

    const toolset = await (
      agent as unknown as {
        toolsets: {
          buildTurn: (args: {
            runtime: { modelInfo?: { supportsClientTools?: boolean } };
            mode: string;
            bashOverride?: BashToolBackend;
          }) => Promise<{ tools: Record<string, ExecutableTool> }>;
        };
      }
    ).toolsets.buildTurn({
      runtime: { modelInfo: { supportsClientTools: true } },
      mode: "ask",
    });

    const result = await toolset.tools.bash.execute({ command: "pwd" });
    expect(result.output).toBe("GLOBAL");
    expect(globalExecute).toHaveBeenCalledTimes(1);
  });
});
