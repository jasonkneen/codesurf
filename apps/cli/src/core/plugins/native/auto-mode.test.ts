// Ported from the V1 suite. The hand-rolled `api` stub is gone: the plugin now
// mounts on a real Cordis root, so the harness supplies host BINDINGS and the
// runtime builds the services the plugin actually reads. Every assertion below
// is the V1 assertion — what changed is how the plugin is booted, not what it
// is held to.

import { createCodesurfRoot, mountPlugin } from "@codesurf/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __getAutoState, __resetAutoState, autoModePlugin, formatRunSummary } from "./auto-mode";

interface RegisteredTool {
  name: string;
  description: string;
  group?: string;
  tool: {
    execute: (args: unknown, ctx?: unknown) => Promise<unknown>;
  };
}

interface RegisteredCommand {
  name: string;
  description: string;
  argsHint?: string;
  handler: (ctx: { args: string }) => void | Promise<void>;
  visible?: () => boolean;
}

interface RegisteredIndicator {
  id: string;
  placement?: string;
  render: () => unknown;
}

interface StubServices {
  chat: {
    dispatch: ReturnType<typeof vi.fn>;
    appendAssistant: ReturnType<typeof vi.fn>;
  };
  events: {
    /** Test hook: fire a previously-subscribed event handler. */
    emit: (event: string, input?: unknown) => void;
    /** Test hook: how many handlers are still subscribed to an event. */
    count: (event: string) => number;
  };
}

interface Stub {
  tools: RegisteredTool[];
  commands: RegisteredCommand[];
  indicators: RegisteredIndicator[];
  services: StubServices;
  dispose: () => Promise<void>;
}

const mounted: Stub[] = [];

/**
 * Mount the plugin on its own root and collect what it contributes.
 *
 * Async because `mountPlugin` returns a fiber: awaiting it is what guarantees
 * `apply` has run and every effect has registered before a case asserts.
 */
async function boot(): Promise<Stub> {
  const tools: RegisteredTool[] = [];
  const commands: RegisteredCommand[] = [];
  const indicators: RegisteredIndicator[] = [];
  const settingsStore = new Map<string, unknown>();
  const subscriptions = new Map<string, Set<(input: unknown) => void>>();

  const dispatch = vi.fn(async () => {});
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
    registerStatusIndicator: (spec) => {
      indicators.push(spec as unknown as RegisteredIndicator);
      return () => {};
    },
    appendAssistant,
    dispatchPrompt: dispatch,
    cwd: () => "/tmp/auto-test",
    getSetting: (key, fallback) => (settingsStore.has(key) ? settingsStore.get(key) : fallback) as never,
    setSetting: (key, value) => {
      settingsStore.set(key, value);
    },
    sessionId: () => "sess-1",
    toast: { show: vi.fn() },
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

  const fiber = mountPlugin(root, autoModePlugin);
  await fiber;

  const stub: Stub = {
    tools,
    commands,
    indicators,
    services: {
      chat: { dispatch, appendAssistant },
      events: {
        emit: (event, input) => {
          for (const handler of subscriptions.get(event) ?? []) handler(input);
        },
        count: (event) => subscriptions.get(event)?.size ?? 0,
      },
    },
    dispose: () => fiber.dispose(),
  };
  mounted.push(stub);
  return stub;
}

async function callCommand(stub: Stub, name: string, args: string): Promise<void> {
  const cmd = stub.commands.find((c) => c.name === name);
  if (!cmd) throw new Error(`command ${name} not registered`);
  await cmd.handler({ args });
}

async function callStatusTool(stub: Stub, args: Record<string, unknown>): Promise<unknown> {
  const tool = stub.tools.find((t) => t.name === "auto_status");
  if (!tool) throw new Error("auto_status tool not registered");
  return tool.tool.execute(args);
}

describe("builtin.auto-mode extension", () => {
  beforeEach(() => {
    __resetAutoState();
  });

  afterEach(async () => {
    // Disposal is per-root now: leaving a fiber mounted would leave its event
    // subscriptions live and let one case drive another's plugin instance.
    while (mounted.length > 0) await mounted.pop()?.dispose();
  });

  it("declares the expected manifest shape", () => {
    const m = autoModePlugin.manifest;
    expect(m.id).toBe("builtin.auto-mode");
    expect(m.enabledByDefault).toBe(true);
    expect(m.capabilities).toEqual(expect.arrayContaining(["tools", "commands"]));
  });

  it("registers the auto_status tool with the auto group", async () => {
    const stub = await boot();
    const t = stub.tools.find((x) => x.name === "auto_status");
    expect(t).toBeDefined();
    expect(t?.group).toBe("auto");
    expect(typeof t?.tool.execute).toBe("function");
  });

  it("registers /auto, /auto-continue, /auto-stop, /auto-status slash commands", async () => {
    const stub = await boot();
    const names = stub.commands.map((c) => c.name).sort();
    expect(names).toEqual(["/auto", "/auto-continue", "/auto-status", "/auto-stop"]);
  });

  it("registers an input-footer status indicator", async () => {
    const stub = await boot();
    const ind = stub.indicators.find((i) => i.id === "auto-mode.turns");
    expect(ind).toBeDefined();
    expect(ind?.placement ?? "input-footer").toBe("input-footer");
  });

  it("/auto with no args prints usage and does not start a run", async () => {
    const stub = await boot();
    await callCommand(stub, "/auto", "");
    expect(stub.services.chat.appendAssistant).toHaveBeenCalledTimes(1);
    expect(stub.services.chat.dispatch).not.toHaveBeenCalled();
    expect(__getAutoState().active).toBe(false);
  });

  it("/auto <task> activates the run and dispatches the seed prompt", async () => {
    const stub = await boot();
    await callCommand(stub, "/auto", "refactor the queue handler");
    const s = __getAutoState();
    expect(s.active).toBe(true);
    expect(s.task).toBe("refactor the queue handler");
    expect(s.maxTurns).toBe(200);
    expect(s.turnCount).toBe(0);
    expect(stub.services.chat.dispatch).toHaveBeenCalledTimes(1);
    const [prompt, opts] = stub.services.chat.dispatch.mock.calls[0];
    expect(prompt).toContain("AUTO mode");
    expect(prompt).toContain("refactor the queue handler");
    expect((opts as { displayText?: string } | undefined)?.displayText).toBe("/auto refactor the queue handler");
  });

  it("/auto parses --turns flag and clamps to the hard cap", async () => {
    const stub = await boot();
    await callCommand(stub, "/auto", "do a thing --turns 5000");
    const s = __getAutoState();
    expect(s.maxTurns).toBe(1000);
    expect(s.task).toBe("do a thing");
  });

  it("/auto refuses to start a second run while one is active", async () => {
    const stub = await boot();
    await callCommand(stub, "/auto", "first task");
    stub.services.chat.appendAssistant.mockClear();
    stub.services.chat.dispatch.mockClear();
    await callCommand(stub, "/auto", "second task");
    expect(stub.services.chat.dispatch).not.toHaveBeenCalled();
    expect(stub.services.chat.appendAssistant).toHaveBeenCalledTimes(1);
    const msg = stub.services.chat.appendAssistant.mock.calls[0][0] as string;
    expect(msg).toContain("already active");
  });

  it("auto_status with state=continue dispatches the next turn and increments turn count", async () => {
    const stub = await boot();
    await callCommand(stub, "/auto", "ship the feature");
    stub.services.chat.dispatch.mockClear();

    await callStatusTool(stub, {
      state: "continue",
      phase: "scaffolding",
      did: "Added the new module skeleton.",
      next: "Wire it up to the registry.",
      risk: "reversible",
      checkpoint: "abc1234567",
    });

    const s = __getAutoState();
    expect(s.turnCount).toBe(1);
    expect(s.active).toBe(true);
    expect(s.history).toHaveLength(1);
    expect(s.history[0].state).toBe("continue");
    expect(stub.services.chat.dispatch).toHaveBeenCalledTimes(1);
    const [prompt, opts] = stub.services.chat.dispatch.mock.calls[0];
    expect(prompt).toContain("Wire it up to the registry");
    expect((opts as { displayText?: string } | undefined)?.displayText).toBe("→ auto turn 2");
  });

  it("auto_status with state=done ends the run and appends summary", async () => {
    const stub = await boot();
    await callCommand(stub, "/auto", "make X work");
    stub.services.chat.appendAssistant.mockClear();
    stub.services.chat.dispatch.mockClear();

    await callStatusTool(stub, {
      state: "done",
      phase: "verified",
      did: "All tests pass, build is clean.",
      next: "",
      risk: "reversible",
      checkpoint: "deadbee",
    });

    const s = __getAutoState();
    expect(s.active).toBe(false);
    expect(s.stoppedReason).toBe("done");
    expect(stub.services.chat.dispatch).not.toHaveBeenCalled();
    expect(stub.services.chat.appendAssistant).toHaveBeenCalledTimes(1);
    const msg = stub.services.chat.appendAssistant.mock.calls[0][0] as string;
    expect(msg).toContain("Auto run complete");
  });

  it("auto_status with state=blocked surfaces why_blocked and resume hints", async () => {
    const stub = await boot();
    await callCommand(stub, "/auto", "delete the old API");
    stub.services.chat.appendAssistant.mockClear();
    stub.services.chat.dispatch.mockClear();

    await callStatusTool(stub, {
      state: "blocked",
      phase: "destructive-op-pending",
      did: "Drafted the migration script.",
      next: "",
      risk: "irreversible-pending",
      checkpoint: null,
      why_blocked: "Need confirmation before dropping legacy_users table.",
    });

    const s = __getAutoState();
    expect(s.active).toBe(false);
    expect(s.stoppedReason).toBe("blocked");
    expect(stub.services.chat.dispatch).not.toHaveBeenCalled();
    const msg = stub.services.chat.appendAssistant.mock.calls[0][0] as string;
    expect(msg).toContain("blocked");
    expect(msg).toContain("legacy_users");
    expect(msg).toContain("/auto continue");
  });

  it("auto_status enforces the max-turns cap", async () => {
    const stub = await boot();
    await callCommand(stub, "/auto", "loop forever --turns 2");
    stub.services.chat.appendAssistant.mockClear();
    stub.services.chat.dispatch.mockClear();

    // Turn 1 — continues
    await callStatusTool(stub, {
      state: "continue",
      phase: "p1",
      did: "step 1",
      next: "step 2",
      risk: "reversible",
      checkpoint: null,
    });
    expect(__getAutoState().active).toBe(true);
    expect(stub.services.chat.dispatch).toHaveBeenCalledTimes(1);

    // Turn 2 — hits cap (maxTurns=2)
    stub.services.chat.dispatch.mockClear();
    await callStatusTool(stub, {
      state: "continue",
      phase: "p2",
      did: "step 2",
      next: "step 3",
      risk: "reversible",
      checkpoint: null,
    });
    const s = __getAutoState();
    expect(s.active).toBe(false);
    expect(s.stoppedReason).toBe("max-turns");
    expect(stub.services.chat.dispatch).not.toHaveBeenCalled();
    const msg = stub.services.chat.appendAssistant.mock.calls.at(-1)?.[0] as string;
    expect(msg).toContain("max turns");
  });

  it("auto_status when inactive is a no-op that does not increment turn count", async () => {
    const stub = await boot();
    // Do NOT call /auto — run stays inactive
    const result = (await callStatusTool(stub, {
      state: "continue",
      phase: "p1",
      did: "step",
      next: "more",
      risk: "reversible",
      checkpoint: null,
    })) as { success: boolean; output: string };
    expect(result.success).toBe(true);
    expect(result.output).toContain("not active");
    expect(__getAutoState().turnCount).toBe(0);
    expect(stub.services.chat.dispatch).not.toHaveBeenCalled();
  });

  it("/auto-stop on an active run ends it and writes a summary", async () => {
    const stub = await boot();
    await callCommand(stub, "/auto", "task X");
    stub.services.chat.appendAssistant.mockClear();
    await callCommand(stub, "/auto-stop", "");
    const s = __getAutoState();
    expect(s.active).toBe(false);
    expect(s.stoppedReason).toBe("user-stop");
    expect(stub.services.chat.appendAssistant).toHaveBeenCalledTimes(1);
  });

  it("/auto-stop on no active run prints a friendly message", async () => {
    const stub = await boot();
    await callCommand(stub, "/auto-stop", "");
    expect(stub.services.chat.appendAssistant).toHaveBeenCalledTimes(1);
    const msg = stub.services.chat.appendAssistant.mock.calls[0][0] as string;
    expect(msg).toContain("No Auto run");
  });

  it("/auto-continue resumes a blocked run and dispatches a continuation", async () => {
    const stub = await boot();
    await callCommand(stub, "/auto", "the task");
    await callStatusTool(stub, {
      state: "blocked",
      phase: "stuck",
      did: "tried thing",
      next: "",
      risk: "reversible",
      checkpoint: null,
      why_blocked: "needed confirmation",
    });

    stub.services.chat.appendAssistant.mockClear();
    stub.services.chat.dispatch.mockClear();
    await callCommand(stub, "/auto-continue", "use approach B");

    const s = __getAutoState();
    expect(s.active).toBe(true);
    expect(stub.services.chat.dispatch).toHaveBeenCalledTimes(1);
    const [prompt] = stub.services.chat.dispatch.mock.calls[0];
    expect(prompt).toContain("use approach B");
  });

  it("/auto-status with no run prints empty-state message", async () => {
    const stub = await boot();
    await callCommand(stub, "/auto-status", "");
    expect(stub.services.chat.appendAssistant).toHaveBeenCalledTimes(1);
    const msg = stub.services.chat.appendAssistant.mock.calls[0][0] as string;
    expect(msg).toContain("No Auto run");
  });

  it("lists only /auto in the menu; the old hyphenated names are hidden but still registered", async () => {
    const stub = await boot();
    const visible = stub.commands.filter((c) => c.visible?.() !== false).map((c) => c.name);
    expect(visible).toEqual(["/auto"]);
  });

  it("/auto stop stops an active run", async () => {
    const stub = await boot();
    await callCommand(stub, "/auto", "task X");
    await callCommand(stub, "/auto", "stop");
    const s = __getAutoState();
    expect(s.active).toBe(false);
    expect(s.stoppedReason).toBe("user-stop");
  });

  it("/auto status shows the run summary", async () => {
    const stub = await boot();
    await callCommand(stub, "/auto", "status");
    const msg = stub.services.chat.appendAssistant.mock.calls[0][0] as string;
    expect(msg).toContain("No Auto run");
  });

  it("/auto continue resumes a paused run with the extra instruction", async () => {
    const stub = await boot();
    await callCommand(stub, "/auto", "the task");
    await callCommand(stub, "/auto", "stop");
    stub.services.chat.dispatch.mockClear();
    await callCommand(stub, "/auto", "continue use approach B");

    expect(__getAutoState().active).toBe(true);
    const [prompt] = stub.services.chat.dispatch.mock.calls[0];
    expect(prompt).toContain("use approach B");
  });

  it("treats `stop …` with more words as a task, not the stop verb", async () => {
    const stub = await boot();
    await callCommand(stub, "/auto", "stop the flaky test from timing out");
    const s = __getAutoState();
    expect(s.active).toBe(true);
    expect(s.task).toBe("stop the flaky test from timing out");
  });

  it("treats `continue …` as a task when there is no run to resume", async () => {
    const stub = await boot();
    await callCommand(stub, "/auto", "continue the migration");
    expect(__getAutoState().task).toBe("continue the migration");
  });

  it("formatRunSummary includes task, turn count, and history", async () => {
    const stub = await boot();
    await callCommand(stub, "/auto", "summary task");
    await callStatusTool(stub, {
      state: "continue",
      phase: "step-1",
      did: "did the thing",
      next: "next thing",
      risk: "reversible",
      checkpoint: "abc1234567",
    });
    const summary = formatRunSummary();
    expect(summary).toContain("summary task");
    expect(summary).toContain("turn 1");
    expect(summary).toContain("did the thing");
    expect(summary).toContain("abc1234");
  });

  it("Stop event halts an active run that never emitted auto_status", async () => {
    const stub = await boot();
    await callCommand(stub, "/auto", "do the thing");
    const stateBefore = __getAutoState();
    expect(stateBefore.active).toBe(true);

    // UserPromptSubmit resets the per-turn flag; Stop with no
    // auto_status emit should declare the run stalled.
    stub.services.events.emit("UserPromptSubmit");
    stub.services.events.emit("Stop");

    const stateAfter = __getAutoState();
    expect(stateAfter.active).toBe(false);
    expect(stateAfter.stoppedReason).toBe("stalled");
    expect(stub.services.chat.appendAssistant).toHaveBeenCalledWith(expect.stringContaining("Auto run halted"));
  });

  it("UserInterrupt event halts an active run (human Esc/Ctrl-X)", async () => {
    const stub = await boot();
    await callCommand(stub, "/auto", "do the thing");
    expect(__getAutoState().active).toBe(true);
    stub.services.chat.appendAssistant.mockClear();

    // Agent.abort() fires UserInterrupt on a human halt — auto-mode must stop
    // dispatching the next turn (Stop alone can't distinguish a halt).
    stub.services.events.emit("UserInterrupt");

    const s = __getAutoState();
    expect(s.active).toBe(false);
    expect(s.stoppedReason).toBe("user-stop");
    expect(stub.services.chat.appendAssistant).toHaveBeenCalledWith(expect.stringContaining("interrupted"));
  });

  it("UserInterrupt event is a no-op when no run is active", async () => {
    const stub = await boot();
    // No /auto — run inactive. A stray Esc must not append noise.
    stub.services.events.emit("UserInterrupt");
    expect(__getAutoState().active).toBe(false);
    expect(stub.services.chat.appendAssistant).not.toHaveBeenCalled();
  });

  it("Stop event leaves an active run alone if auto_status fired this turn", async () => {
    const stub = await boot();
    await callCommand(stub, "/auto", "do the thing");

    // Simulate a normal turn: prompt → auto_status emit → Stop.
    stub.services.events.emit("UserPromptSubmit");
    await callStatusTool(stub, {
      state: "continue",
      phase: "x",
      did: "y",
      next: "z",
      risk: "reversible",
      checkpoint: null,
    });
    stub.services.events.emit("Stop");

    // Still active — `auto_status` was called this turn.
    expect(__getAutoState().active).toBe(true);
  });

  it("stops listening once the fiber is disposed", async () => {
    // Regression: the conversion first wrote these three subscriptions as
    // `ctx.effect(() => () => disposeStopSub)`, whose disposer merely NAMES the
    // handle and never calls it — so a disposed plugin kept driving turns off
    // the host event bus. Emitting after dispose must be inert.
    const stub = await boot();
    await callCommand(stub, "/auto", "do the thing");
    expect(__getAutoState().active).toBe(true);

    await stub.dispose();
    stub.services.chat.appendAssistant.mockClear();
    stub.services.chat.dispatch.mockClear();

    // The subscription itself must be gone. Asserting only that emitting is
    // inert would pass even with the leak, because the handlers also check a
    // `disposed` flag — the flag masks the leak rather than fixing it.
    for (const event of ["UserPromptSubmit", "Stop", "UserInterrupt"]) {
      expect(stub.services.events.count(event)).toBe(0);
    }

    stub.services.events.emit("UserPromptSubmit");
    stub.services.events.emit("Stop");
    stub.services.events.emit("UserInterrupt");

    expect(stub.services.chat.appendAssistant).not.toHaveBeenCalled();
    expect(stub.services.chat.dispatch).not.toHaveBeenCalled();
  });
});
