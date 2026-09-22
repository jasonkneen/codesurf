// Tests for the /loop builtin: continuation model (Stop = heartbeat,
// UserInterrupt = halt), stall protection, and arg handling. Uses the real
// kernel loop manager (createLoopManager) bound into the root as the host's
// loops binding, so the command is exercised against production semantics.
//
// Ported from the V1 suite: the hand-rolled `api` stub is replaced by a real
// Cordis root with host bindings. The assertions are unchanged.

import { createCodesurfRoot, mountPlugin } from "@codesurf/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLoopManager } from "../loops";
import { loopCommandPlugin } from "./loop-command";

interface RegisteredTool {
  name: string;
  tool: { execute: (args: Record<string, unknown>, ctx?: unknown) => Promise<{ success: boolean; output: string }> };
}

interface RegisteredCommand {
  name: string;
  handler: (ctx: { args: string }) => void | Promise<void>;
}

interface StubServices {
  loops: ReturnType<typeof createLoopManager>;
  chat: {
    dispatch: ReturnType<typeof vi.fn>;
    appendAssistant: ReturnType<typeof vi.fn>;
  };
  events: {
    emit: (event: string, input?: unknown) => void;
  };
}

interface Stub {
  tools: RegisteredTool[];
  commands: RegisteredCommand[];
  services: StubServices;
  dispose: () => Promise<void>;
}

async function makeStub(): Promise<Stub> {
  const tools: RegisteredTool[] = [];
  const commands: RegisteredCommand[] = [];
  const subscriptions = new Map<string, Set<(input: unknown) => void>>();

  const loops = createLoopManager();
  const dispatch = vi.fn().mockResolvedValue(undefined);
  const appendAssistant = vi.fn();

  const root = createCodesurfRoot({
    registerTool: (spec) => {
      tools.push(spec as unknown as RegisteredTool);
      return () => {};
    },
    registerCommand: (spec) => {
      commands.push(spec as unknown as RegisteredCommand);
      return () => {};
    },
    registerStatusIndicator: () => () => {},
    appendAssistant,
    dispatchPrompt: dispatch,
    cwd: () => "/tmp/loop-test",
    sessionId: () => "sess-loop",
    loops,
    hostEvents: {
      subscribe: (event: string, handler: (input: unknown) => void) => {
        let set = subscriptions.get(event);
        if (!set) {
          set = new Set();
          subscriptions.set(event, set);
        }
        set.add(handler);
        return () => {
          set?.delete(handler);
        };
      },
    } as never,
  });

  const fiber = mountPlugin(root, loopCommandPlugin);
  await fiber;

  return {
    tools,
    commands,
    services: {
      loops,
      chat: { dispatch, appendAssistant },
      events: {
        emit: (event, input) => {
          for (const handler of subscriptions.get(event) ?? []) handler(input);
        },
      },
    },
    dispose: () => fiber.dispose(),
  };
}

async function runCommand(stub: Stub, args: string): Promise<void> {
  const cmd = stub.commands.find((c) => c.name === "/loop");
  if (!cmd) throw new Error("/loop not registered");
  await cmd.handler({ args });
}

async function callTool(stub: Stub, name: string, args: Record<string, unknown>) {
  const tool = stub.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`${name} not registered`);
  return tool.tool.execute(args);
}

/** Let the scheduled continuation (setTimeout 0) run. */
async function flushTimers(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

let stub: Stub;

beforeEach(async () => {
  stub = await makeStub();
});

afterEach(async () => {
  await stub.dispose();
});

describe("/loop command", () => {
  it("registers the loop tools and command", () => {
    expect(stub.tools.map((t) => t.name).sort()).toEqual(["loop_advance", "loop_record", "loop_status"]);
    expect(stub.commands.some((c) => c.name === "/loop")).toBe(true);
  });

  it("bare /loop never auto-starts", async () => {
    await runCommand(stub, "");
    expect(stub.services.loops.getActive()).toBeNull();
    expect(stub.services.chat.dispatch).not.toHaveBeenCalled();
  });

  it("refuses to create a custom loop without a goal", async () => {
    await runCommand(stub, "mytask 10");
    expect(stub.services.loops.get("mytask")).toBeNull();
    expect(stub.services.chat.appendAssistant).toHaveBeenCalledWith(
      expect.stringContaining("no context of what is being carried out"),
    );
  });

  it("starts a goal-bearing loop and dispatches the first kick", async () => {
    await runCommand(stub, "mytask 10 Build the profile editor with tests");
    const state = stub.services.loops.get("mytask");
    expect(state?.status).toBe("running");
    expect(state?.spec.goal).toBe("Build the profile editor with tests");
    expect(state?.spec.maxIterations).toBe(10);
    expect(stub.services.chat.dispatch).toHaveBeenCalledTimes(1);
    expect(stub.services.chat.dispatch.mock.calls[0]?.[0]).toContain('Begin loop "mytask"');
  });

  it("ralph starts without an explicit goal (built-in spec)", async () => {
    await runCommand(stub, "ralph 12");
    const state = stub.services.loops.get("ralph");
    expect(state?.status).toBe("running");
    expect(state?.spec.maxIterations).toBe(12);
    expect(state?.spec.phases.map((p) => p.name)).toEqual([
      "discovery",
      "planning",
      "execution",
      "verification",
      "iteration",
    ]);
  });

  it("Stop is a heartbeat: a productive turn advances the loop and dispatches the next kick", async () => {
    await runCommand(stub, "mytask 10 Some goal");
    stub.services.chat.dispatch.mockClear();

    stub.services.events.emit("UserPromptSubmit"); // turn starts
    await callTool(stub, "loop_record", { status: "passed", summary: "iteration one done" });
    stub.services.events.emit("Stop"); // turn settles
    await flushTimers();

    const state = stub.services.loops.get("mytask");
    expect(state?.status).toBe("running");
    expect(state?.currentIteration).toBe(2);
    expect(stub.services.chat.dispatch).toHaveBeenCalledTimes(1);
    expect(stub.services.chat.dispatch.mock.calls[0]?.[0]).toContain('Continue loop "mytask" at iteration 2/10');
  });

  it("Stop after the FIRST turn does not kill the loop (regression: Stop ≠ user halt)", async () => {
    await runCommand(stub, "mytask 10 Some goal");
    stub.services.events.emit("UserPromptSubmit");
    await callTool(stub, "loop_record", { status: "passed" });
    stub.services.events.emit("Stop");
    await flushTimers();
    expect(stub.services.loops.get("mytask")?.status).toBe("running");
  });

  it("halts after two consecutive turns without loop_record (stall protection)", async () => {
    await runCommand(stub, "mytask 10 Some goal");
    stub.services.chat.dispatch.mockClear();

    stub.services.events.emit("UserPromptSubmit");
    stub.services.events.emit("Stop"); // stall 1 → still continues
    await flushTimers();
    expect(stub.services.loops.get("mytask")?.status).toBe("running");

    stub.services.events.emit("UserPromptSubmit");
    stub.services.events.emit("Stop"); // stall 2 → halt
    await flushTimers();

    const state = stub.services.loops.get("mytask");
    expect(state?.status).toBe("stopped");
    expect(stub.services.chat.appendAssistant).toHaveBeenCalledWith(expect.stringContaining("halted"));
  });

  it("a loop_record with status complete ends the loop without further dispatch", async () => {
    await runCommand(stub, "mytask 10 Some goal");
    stub.services.chat.dispatch.mockClear();

    stub.services.events.emit("UserPromptSubmit");
    await callTool(stub, "loop_record", { status: "complete", summary: "goal met" });
    stub.services.events.emit("Stop");
    await flushTimers();

    expect(stub.services.loops.get("mytask")?.status).toBe("complete");
    expect(stub.services.chat.dispatch).not.toHaveBeenCalled();
    expect(stub.services.chat.appendAssistant).toHaveBeenCalledWith(expect.stringContaining("complete"));
  });

  it("stops at the iteration budget instead of looping forever", async () => {
    await runCommand(stub, "mytask 2 Some goal");
    stub.services.chat.dispatch.mockClear();

    stub.services.events.emit("UserPromptSubmit");
    await callTool(stub, "loop_record", { status: "passed" });
    stub.services.events.emit("Stop"); // iteration 1 done → iteration 2 runs
    await flushTimers();

    // A budget of 2 runs two iterations, not one.
    expect(stub.services.loops.get("mytask")?.status).toBe("running");
    expect(stub.services.loops.get("mytask")?.currentIteration).toBe(2);
    expect(stub.services.chat.dispatch).toHaveBeenCalledTimes(1);
    stub.services.chat.dispatch.mockClear();

    stub.services.events.emit("UserPromptSubmit");
    await callTool(stub, "loop_record", { status: "passed" });
    stub.services.events.emit("Stop"); // iteration 2 done → budget spent
    await flushTimers();

    expect(stub.services.loops.get("mytask")?.status).toBe("complete");
    expect(stub.services.chat.dispatch).not.toHaveBeenCalled();
  });

  it("UserInterrupt halts the running loop and resume preserves history", async () => {
    await runCommand(stub, "mytask 10 Some goal");
    stub.services.events.emit("UserPromptSubmit");
    await callTool(stub, "loop_record", { status: "passed", summary: "first" });

    stub.services.events.emit("UserInterrupt");
    expect(stub.services.loops.get("mytask")?.status).toBe("stopped");

    stub.services.chat.dispatch.mockClear();
    await runCommand(stub, "mytask");
    const state = stub.services.loops.get("mytask");
    expect(state?.status).toBe("running");
    expect(state?.history).toHaveLength(1);
    expect(stub.services.chat.dispatch.mock.calls[0]?.[0]).toContain("Continue loop");
  });

  it("does not double-advance when the model called loop_advance itself", async () => {
    await runCommand(stub, "mytask 10 Some goal");
    stub.services.events.emit("UserPromptSubmit");
    await callTool(stub, "loop_record", { status: "passed" });
    await callTool(stub, "loop_advance", {});
    expect(stub.services.loops.get("mytask")?.currentIteration).toBe(2);

    stub.services.events.emit("Stop");
    await flushTimers();
    expect(stub.services.loops.get("mytask")?.currentIteration).toBe(2);
  });

  it("rejects starting a second loop while one is running", async () => {
    await runCommand(stub, "mytask 10 Some goal");
    stub.services.chat.dispatch.mockClear();
    await runCommand(stub, "other 5 Another goal");
    expect(stub.services.loops.get("other")).toBeNull();
    expect(stub.services.chat.dispatch).not.toHaveBeenCalled();
    expect(stub.services.chat.appendAssistant).toHaveBeenCalledWith(expect.stringContaining("already running"));
  });

  it("re-supplying a goal on resume updates the spec", async () => {
    await runCommand(stub, "mytask 10 Original goal");
    stub.services.events.emit("UserInterrupt");
    await runCommand(stub, "mytask 10 Refined goal with tests");
    expect(stub.services.loops.get("mytask")?.spec.goal).toBe("Refined goal with tests");
  });

  it("no continuation fires after dispose", async () => {
    await runCommand(stub, "mytask 10 Some goal");
    stub.services.chat.dispatch.mockClear();
    stub.services.events.emit("UserPromptSubmit");
    await callTool(stub, "loop_record", { status: "passed" });
    await stub.dispose();
    stub.services.events.emit("Stop"); // unsubscribed → no-op
    await flushTimers();
    expect(stub.services.chat.dispatch).not.toHaveBeenCalled();
  });

  it("/loop status shows per-iteration token count when tokens were recorded", async () => {
    await runCommand(stub, "mytask 10 Some goal");
    stub.services.loops.noteUsage(1234);
    stub.services.loops.record("mytask", { status: "passed", summary: "first pass" });
    stub.services.chat.appendAssistant.mockClear();
    await runCommand(stub, "status mytask");
    const output = stub.services.chat.appendAssistant.mock.calls[0]?.[0] as string;
    expect(output).toContain("1,234 tok");
  });

  it("/loop status omits token suffix when no tokens were recorded", async () => {
    await runCommand(stub, "mytask 10 Some goal");
    stub.services.loops.record("mytask", { status: "passed", summary: "first pass" });
    stub.services.chat.appendAssistant.mockClear();
    await runCommand(stub, "status mytask");
    const output = stub.services.chat.appendAssistant.mock.calls[0]?.[0] as string;
    expect(output).not.toContain("tok");
  });
});
