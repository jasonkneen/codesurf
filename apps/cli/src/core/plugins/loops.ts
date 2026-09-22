// Kernel loop manager — the implementation behind `services.loops`.
//
// Owns named LoopState records (spec + iteration counter + history) for the
// "agent looping" pattern: discovery → planning → execution → verification →
// iteration, bounded by an explicit spec. The /loop builtin command drives
// this manager; see src/core/plugins/native/loop-command.ts for the
// continuation model (Stop = heartbeat, UserInterrupt = halt).
//
// State lives in an in-memory map; an optional LoopStore (see
// src/core/persistence/loops.ts) makes it durable — seeded at creation,
// saved after every mutation.

import type { LoopIterationRecord, LoopSpec, LoopState, PluginHostServices } from "./api";

export type LoopManager = PluginHostServices["loops"];

/** Durability hooks for the manager. Both are best-effort and synchronous. */
export interface LoopStore {
  load(): LoopState[];
  save(loops: LoopState[]): void;
}

function getDefaultSpec(name: string, maxIterations = 30, goal?: string): LoopSpec {
  const defaultGoal = goal || `Achieve the objective for loop "${name}" using a tight, closed loop.`;
  return {
    name,
    goal: defaultGoal,
    maxIterations,
    closed: true,
    useFleet: false,
    phases: [
      {
        name: "discovery",
        instructions:
          "Find what you need to know. Research, read files, explore the workspace, clarify unknowns. Be explicit about assumptions.",
      },
      {
        name: "planning",
        instructions:
          "Break the work into clear, verifiable steps. Produce a short plan with success criteria for each phase.",
      },
      {
        name: "execution",
        instructions: "Do the work. Make the changes. Use tools. Produce concrete output (code, docs, assets, etc.).",
      },
      {
        name: "verification",
        instructions:
          "Check the output rigorously against the goal and the verificationCriteria. Prefer deterministic checks (tests, typecheck, lint, exact string matches) over self-review. Self-review is a rubber stamp — call it out if you only did vibes.",
      },
      {
        name: "iteration",
        instructions:
          "If verification failed or gaps remain, explicitly list what to fix, then loop back to discovery/planning for the next iteration. Do not declare victory until verification passes cleanly.",
      },
    ],
    verificationCriteria:
      "The delivered work fully satisfies the stated goal. All phases were executed. No critical gaps remain. Output is production-ready or clearly marked as a checkpoint. Human taste and standards are honored (the spec is the contract).",
    rules:
      "This is a CLOSED loop. Stay inside the spec. End every iteration with a loop_record call. Use subagents (task/delegate) if the spec says useFleet or the work clearly decomposes.",
  };
}

export function createLoopManager(store?: LoopStore): LoopManager {
  const loopsByName = new Map<string, LoopState>();
  for (const state of store?.load() ?? []) {
    loopsByName.set(state.spec.name, state);
  }

  function persist(): void {
    store?.save(Array.from(loopsByName.values()));
  }

  function ensureLoop(name: string, maxIterations?: number, goal?: string): LoopState {
    let state = loopsByName.get(name);
    if (!state) {
      const spec = getDefaultSpec(name, maxIterations ?? 30, goal);
      state = {
        spec,
        currentIteration: 0,
        status: "idle",
        history: [],
      };
      loopsByName.set(name, state);
    } else if (maxIterations) {
      state.spec.maxIterations = maxIterations;
    }
    return state;
  }

  return {
    list: () => Array.from(loopsByName.values()).map((s) => s.spec),
    get: (name: string) => loopsByName.get(name) ?? null,
    start: (name: string, maxIterations?: number, goal?: string) => {
      const state = ensureLoop(name, maxIterations, goal);
      // Only a COMPLETED loop restarts from scratch. A stopped loop resumes
      // where it left off — wiping history on resume would contradict the
      // "review the last iteration's outcome" contract the /loop command
      // gives the model.
      if (state.status === "complete") {
        state.currentIteration = 0;
        state.history = [];
        state.status = "idle";
      }
      const resumed = state.currentIteration > 0;
      state.status = "running";
      if (state.currentIteration === 0) state.currentIteration = 1;
      const msg = `Loop "${name}" ${resumed ? "resumed" : "started"} (iteration ${state.currentIteration}/${state.spec.maxIterations}, ${state.spec.closed ? "CLOSED" : "OPEN"}). Goal: ${state.spec.goal}`;
      state.lastMessage = msg;
      persist();
      return { started: true, message: msg, state };
    },
    stop: (name?: string) => {
      if (!name) {
        // No name → stop the currently running loop, if any.
        const active = Array.from(loopsByName.values()).find((s) => s.status === "running");
        if (active) {
          active.status = "stopped";
          active.lastMessage = `Stopped loop "${active.spec.name}".`;
          persist();
          return { stopped: true, message: active.lastMessage };
        }
        return { stopped: false, message: "No running loop to stop." };
      }
      const state = loopsByName.get(name);
      if (!state) return { stopped: false, message: `No such loop "${name}".` };
      state.status = "stopped";
      state.lastMessage = `Loop "${name}" stopped.`;
      persist();
      return { stopped: true, message: state.lastMessage };
    },
    advance: async (name: string) => {
      const state = loopsByName.get(name);
      if (!state) {
        return { advanced: false, message: `No such loop "${name}".` };
      }
      if (state.status !== "running") {
        return { advanced: false, message: `Loop "${name}" is not running (status: ${state.status}).`, state };
      }
      // Advancing ends the iteration that just ran. Only when that was the
      // last one in the budget is the loop complete; otherwise the next one
      // starts. (Completing on arrival at the last number meant a budget of N
      // ran N-1 iterations.)
      if (state.currentIteration >= state.spec.maxIterations) {
        state.status = "complete";
      } else {
        state.currentIteration += 1;
      }
      const msg =
        state.status === "complete"
          ? `Loop "${name}" reached its iteration budget (${state.spec.maxIterations}) and is complete.`
          : `Advanced loop "${name}" to iteration ${state.currentIteration}/${state.spec.maxIterations}.`;
      state.lastMessage = msg;
      persist();
      return { advanced: true, message: msg, state };
    },
    record: (
      name: string,
      entry: {
        status: LoopIterationRecord["status"];
        summary?: string;
        verificationNotes?: string;
      },
    ) => {
      const state = loopsByName.get(name);
      if (!state) return { ok: false, message: `No such loop "${name}".` };
      state.history.push({
        iteration: state.currentIteration,
        startedAt: new Date().toISOString(),
        status: entry.status,
        summary: entry.summary,
        verificationNotes: entry.verificationNotes,
        tokensUsed: state.pendingTokens ?? 0,
      });
      state.pendingTokens = 0;
      if (entry.status === "complete") {
        state.status = "complete";
      }
      const msg = `Iteration ${state.currentIteration} of loop "${name}" recorded as ${entry.status}.`;
      state.lastMessage = msg;
      persist();
      return { ok: true, message: msg, state };
    },
    setSpec: (spec: LoopSpec) => {
      const existing = loopsByName.get(spec.name);
      const newState: LoopState = existing
        ? { ...existing, spec }
        : {
            spec,
            currentIteration: 0,
            status: "idle",
            history: [],
          };
      loopsByName.set(spec.name, newState);
      persist();
      return { ok: true, message: `Spec for loop "${spec.name}" updated.` };
    },
    getActive: () => {
      return Array.from(loopsByName.values()).find((s) => s.status === "running") ?? null;
    },
    noteUsage: (totalTokens: number) => {
      const active = Array.from(loopsByName.values()).find((s) => s.status === "running");
      if (!active) return;
      active.pendingTokens = (active.pendingTokens ?? 0) + totalTokens;
      persist();
    },
  };
}
