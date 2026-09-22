// /loop command — named, spec-driven, closed-loop agent looping.
//
// Implements the "agent looping" model: single-agent or fleet, cycling through
//   DISCOVERY → PLANNING → EXECUTION → VERIFICATION → ITERATION
// until the explicit goal + verificationCriteria are met (or budget exhausted).
//
// /loop                 → status of active loop or help (bare never auto-starts)
// /loop ralph           → start/resume the "ralph" loop (default 30 iters, closed)
// /loop ralph 12        → same but with explicit length=12
// /loop mytask 20 <goal description...> → custom named loop (goal is REQUIRED on first start)
// /loop list            → all known loops
// /loop status [name]   → detailed state
// /loop stop [name]     → stop one or the active loop
//
// A loop cannot be started unless there is explicit context (the goal) for
// what is being carried out.
//
// ── Continuation model ───────────────────────────────────────────────────────
// Starting a loop dispatches one "kick" turn. From then on the loop drives
// itself off agent events:
//
//   Stop (fires every time a turn settles successfully)
//     → if a loop is running: check progress, advance the iteration, and
//       dispatch the next kick — until the loop completes, hits its budget,
//       stalls, or is stopped.
//   UserInterrupt (fires ONLY when the human presses Esc / the stop button)
//     → halt the running loop. NOTE: `Stop` does NOT mean "the user pressed
//       stop" — see src/hooks/types.ts. Subscribing the halt path to `Stop`
//       would kill the loop after its first successful turn.
//
// Stall protection mirrors auto-mode: the model must call `loop_record` (or
// `loop_advance`) each iteration. Two consecutive turns settling without
// either call halt the loop with a visible warning, so a non-cooperative
// model can't burn the whole budget doing nothing.
//
// The loop spec (LoopSpec) is the "human designs the standard first" artifact.
// It lives in the kernel's loop manager (services.loops), which persists to
// loops.json in the config dir — a CLI restart rehydrates loops as stopped
// with history intact, and /loop <name> resumes. `/loop spec [name]` dumps
// the stored contract. A footer chip (⟳ name i/N) shows the active loop.

import type {
  CodesurfPlugin,
  LoopIterationRecord,
  LoopSpec,
  LoopState,
  PluginContext,
  PluginManifest,
} from "@codesurf/plugin-api";
import { tool } from "ai";
import { createElement, type ReactNode, useSyncExternalStore } from "react";
import { z } from "zod";

// ── Footer status chip ────────────────────────────────────────────────────────
// Tiny pub-sub mirroring auto-mode's indicator: re-renders only when loop
// state moves, not on every host render.
interface LoopIndicatorState {
  active: boolean;
  name: string;
  iteration: number;
  maxIterations: number;
}

const IDLE_INDICATOR: LoopIndicatorState = { active: false, name: "", iteration: 0, maxIterations: 0 };
const indicatorListeners = new Set<() => void>();
let lastIndicatorSnapshot: LoopIndicatorState = IDLE_INDICATOR;

function notifyIndicator(state: LoopState | null): void {
  lastIndicatorSnapshot =
    state && state.status === "running"
      ? {
          active: true,
          name: state.spec.name,
          iteration: state.currentIteration,
          maxIterations: state.spec.maxIterations,
        }
      : IDLE_INDICATOR;
  for (const listener of indicatorListeners) listener();
}

function getIndicatorSnapshot(): LoopIndicatorState {
  return lastIndicatorSnapshot;
}

function subscribeIndicator(listener: () => void): () => void {
  indicatorListeners.add(listener);
  return () => {
    indicatorListeners.delete(listener);
  };
}

function LoopStatusIndicator(): ReactNode {
  const snap = useSyncExternalStore(subscribeIndicator, getIndicatorSnapshot, getIndicatorSnapshot);
  if (!snap.active) return null;
  return createElement(
    "text",
    { fg: "#61afef", wrapMode: "none" },
    `⟳ ${snap.name} ${snap.iteration}/${snap.maxIterations}`,
  );
}

const manifest: PluginManifest = {
  id: "builtin.commands.loop",
  name: "Agent Looping",
  version: "1.0.0",
  description:
    "Named closed-loop agent cycling (discovery→plan→exec→verify→iterate) with explicit standards and iteration budgets. Loops require goal context on start, auto-continue between turns, and halt on user interrupt. /loop ralph 30",
  enabledByDefault: true,
  protected: false,
  capabilities: ["commands", "tools", "status-indicators"],
};

const DEFAULT_MAX_ITERATIONS = 30;
/** Consecutive turns that may settle without loop_record/loop_advance before the loop halts. */
const MAX_STALLED_TURNS = 2;

function formatLoopBlock(state: LoopState): string {
  const { spec, currentIteration, status, history } = state;
  const phaseNames = spec.phases.map((p) => p.name).join(" → ");
  const h =
    history.length > 0
      ? history
          .map((r) => {
            const tokSuffix = r.tokensUsed != null && r.tokensUsed > 0 ? ` — ${r.tokensUsed.toLocaleString()} tok` : "";
            return `  ${r.iteration}. ${r.status}${r.summary ? ` — ${r.summary.slice(0, 60)}` : ""}${tokSuffix}`;
          })
          .join("\n")
      : "  (no iterations recorded yet)";

  return [
    "═══════════════════════════════════════════════════════════════",
    `ACTIVE LOOP: ${spec.name.toUpperCase()}   iteration ${currentIteration}/${spec.maxIterations}   [${spec.closed ? "CLOSED" : "OPEN"}]   status=${status}`,
    `GOAL: ${spec.goal}`,
    "",
    `PHASES (cycle every iteration): ${phaseNames}`,
    "",
    "VERIFICATION STANDARD (this is the contract — do not loosen):",
    spec.verificationCriteria,
    "",
    spec.rules ? `RULES:\n${spec.rules}\n` : "",
    "HISTORY:",
    h,
    "",
    "INSTRUCTIONS FOR THIS TURN:",
    "• You are inside a governed loop. Follow the phases in order.",
    "• After execution, run a real verification pass (tests, typecheck, exact matches, second model, etc.). Self-review alone is not enough.",
    "• REQUIRED at the end of every iteration: call `loop_record` with status 'passed', 'failed', or 'complete' plus a one-line summary.",
    "    - 'complete' means the overall GOAL is solidly met and verified — the loop ends.",
    "    - 'passed'/'failed' continue the cycle on the next turn (the loop auto-continues; you do not need to ask).",
    "    - A turn that ends without `loop_record` counts as a stall; repeated stalls halt the loop.",
    "• If the spec has useFleet or the work decomposes cleanly, use the task/delegate tools to hand sub-work to specialists.",
    "═══════════════════════════════════════════════════════════════",
  ].join("\n");
}

function createDefaultRalphSpec(maxIterations = DEFAULT_MAX_ITERATIONS): LoopSpec {
  return {
    name: "ralph",
    goal: "Autonomously execute a high-quality, closed-loop task (research, build, review, refactor, etc.) by repeatedly cycling through the five phases until the explicit verification standard is satisfied or the iteration budget is reached.",
    maxIterations,
    closed: true,
    useFleet: false,
    phases: [
      {
        name: "discovery",
        instructions:
          "Find what you need to know. Read relevant code, docs, specs, and context. Clarify the real problem. Surface hidden requirements and risks. Be explicit about what you still don't know.",
      },
      {
        name: "planning",
        instructions:
          "Produce a tight, verifiable plan. Break the goal into ordered steps with clear success criteria per step. Identify which steps can be delegated to subagents.",
      },
      {
        name: "execution",
        instructions:
          "Do the concrete work. Write code, edit files, run commands, generate artifacts. Make real changes. Do not just describe.",
      },
      {
        name: "verification",
        instructions:
          "Rigorously check the result against the goal and the verificationCriteria. Use deterministic signals (tests passing, typecheck clean, lint clean, exact output matches, build succeeds). Call out when you are only doing vibe checks. If verification is weak, say so.",
      },
      {
        name: "iteration",
        instructions:
          "If verification failed or gaps remain, write a short 'what broke / what to fix next' note, then loop back into discovery or planning for the next iteration. Do not claim success until verification is clean.",
      },
    ],
    verificationCriteria:
      "The delivered artifact(s) fully satisfy the original goal with no critical gaps. All required phases were visibly executed in the transcript. The output meets or exceeds the human taste / quality bar implied by the spec. The loop only ends when this bar is cleared or the budget is exhausted.",
    rules:
      "This is a CLOSED loop (the default and recommended mode). The spec is the law. Stay inside it. End every iteration with a loop_record call. Human judgement lives in the initial spec + the verification gates — not in ad-hoc steering mid-loop.",
    notes:
      "Named after the public discussion of agent looping. A good 'ralph' run feels like a disciplined senior engineer redoing their own draft until it passes their own high bar.",
  };
}

function buildKickPrompt(state: LoopState): string {
  const { spec, currentIteration, history } = state;
  const isFirst = currentIteration <= 1 && history.length === 0;
  if (isFirst) {
    return `Begin loop "${spec.name}" now. You are at iteration ${currentIteration}/${spec.maxIterations}. Follow the phases in the control block above. Start with DISCOVERY. End the iteration with a loop_record call.`;
  }
  return `Continue loop "${spec.name}" at iteration ${currentIteration}/${spec.maxIterations}. The control block above shows the current spec, goal, verification standard and prior history. Review the last iteration's outcome, then continue the phase cycle (do not restart from scratch). End the iteration with a loop_record call. Use loop_status if you need to re-orient.`;
}

export const loopCommandPlugin: CodesurfPlugin = {
  name: "codesurf-loop-command",
  manifest,
  inject: ["contributions", "screens", "tools", "chat", "ui", "settings"],
  apply(ctx: PluginContext) {
    // ── Continuation state (per process, reset on dispose) ────────────────
    // `progressSeenThisTurn` flips true when the model calls loop_record /
    // loop_advance; UserPromptSubmit resets it at the top of each turn.
    // `continuationPending` prevents double-dispatch if Stop fires again
    // before the scheduled kick runs.
    let progressSeenThisTurn = false;
    let advancedThisTurn = false;
    let stalledTurns = 0;
    let continuationPending = false;
    let disposed = false;

    function announce(message: string): void {
      ctx.chat.appendAssistant(message);
    }

    /** Sync the footer chip with the manager's current active loop. */
    function refreshIndicator(): void {
      notifyIndicator(ctx.loops.getActive());
    }

    const disposeIndicator = ctx.effect(() =>
      ctx.screens.registerStatusIndicator({
        id: "loop.active",
        placement: "input-footer",
        render: () => createElement(LoopStatusIndicator),
      }),
    );
    ctx.effect(() => disposeIndicator);
    refreshIndicator();

    /** Dispatch the next iteration kick for a still-running loop. */
    function scheduleContinuation(name: string): void {
      if (continuationPending) return;
      continuationPending = true;
      // Scheduled async per the event-bus contract: listeners must not do
      // meaningful work on the emitting thread (the turn is still settling).
      setTimeout(() => {
        continuationPending = false;
        if (disposed) return;
        const state = ctx.loops.get(name);
        if (!state || state.status !== "running") return;
        announce(formatLoopBlock(state));
        ctx.chat
          .dispatch(buildKickPrompt(state), {
            displayText: `▶ /loop ${name} (iteration ${state.currentIteration})`,
          })
          .catch((err) => {
            console.error("[loop] continuation dispatch failed:", err);
          });
      }, 0);
    }

    // ── Model-facing tools ─────────────────────────────────────────────────
    ctx.effect(() =>
      ctx.contributions.registerTool({
        name: "loop_status",
        label: "Loop Status",
        description:
          "Return the current state of the active loop (or a named one). Use inside a loop to know where you are in the cycle and what the verification standard still requires.",
        group: "loop",
        tool: tool({
          description:
            "Return current loop state (name, iteration, goal, status, history summary). Call this to orient yourself before or after a phase.",
          inputSchema: z.object({
            name: z.string().optional().describe("Optional loop name. If omitted, uses the currently active loop."),
          }),
          execute: async ({ name }) => {
            const svc = ctx.loops;
            const state = name ? svc.get(name) : svc.getActive();
            if (!state) {
              return { success: true, output: "No active loop. Start one with /loop <name> [N] <goal>." };
            }
            return {
              success: true,
              output: JSON.stringify(
                {
                  name: state.spec.name,
                  iteration: `${state.currentIteration}/${state.spec.maxIterations}`,
                  status: state.status,
                  goal: state.spec.goal,
                  closed: state.spec.closed,
                  lastMessage: state.lastMessage,
                  historyCount: state.history.length,
                },
                null,
                2,
              ),
            };
          },
        }),
      }),
    );

    ctx.effect(async () =>
      ctx.contributions.registerTool({
        name: "loop_advance",
        label: "Loop Advance",
        description:
          "Explicitly advance the named (or active) loop to the next iteration number. Usually unnecessary — the loop advances automatically when a turn settles; prefer loop_record.",
        group: "loop",
        tool: tool({
          description:
            "Advance the loop counter. The loop also advances automatically between turns, so only call this when you complete more than one full cycle within a single turn.",
          inputSchema: z.object({
            name: z.string().optional().describe("Optional loop name. Defaults to the active loop."),
          }),
          execute: async ({ name }) => {
            const svc = ctx.loops;
            const target = name || svc.getActive()?.spec.name;
            if (!target) return { success: false, output: "No loop to advance." };
            const res = await svc.advance(target);
            if (res.advanced) {
              progressSeenThisTurn = true;
              advancedThisTurn = true;
            }
            return { success: res.advanced, output: res.message };
          },
        }),
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerTool({
        name: "loop_record",
        label: "Loop Record",
        description:
          "Record the outcome of the current iteration (status + summary + verification notes). REQUIRED at the end of every loop iteration — it populates history and keeps the loop alive. Status 'complete' ends the loop.",
        group: "loop",
        tool: tool({
          description:
            "Record the iteration result into the loop's history. Status: 'passed' (verification clean, goal not yet met), 'failed' (gaps remain), or 'complete' (overall goal met + verified — ends the loop).",
          inputSchema: z.object({
            name: z.string().optional().describe("Optional loop name. Defaults to the active loop."),
            status: z.enum(["passed", "failed", "complete", "in-progress"]).default("in-progress"),
            summary: z.string().optional().describe("One line: what this iteration accomplished."),
            verificationNotes: z.string().optional().describe("What was verified and how (deterministic signals)."),
          }),
          execute: async ({ name, status, summary, verificationNotes }) => {
            const svc = ctx.loops;
            const target = name || svc.getActive()?.spec.name;
            if (!target) return { success: false, output: "No active loop to record into." };
            const res = svc.record(target, {
              status: status as LoopIterationRecord["status"],
              summary,
              verificationNotes,
            });
            if (res.ok) {
              progressSeenThisTurn = true;
              refreshIndicator();
            }
            return { success: res.ok, output: res.message };
          },
        }),
      }),
    );

    // ── Slash command ──────────────────────────────────────────────────────
    ctx.effect(async () =>
      ctx.contributions.registerCommand({
        name: "/loop",
        description:
          "Start or manage a named closed agent loop (/loop ralph 30). Cycles discovery→planning→execution→verification→iteration until goal + spec are met.",
        argsHint: "[name] [N] [<goal for new loop>] | list | status [name] | stop [name]",
        handler: async ({ args }) => {
          const trimmed = (args || "").trim();
          const parts = trimmed ? trimmed.split(/\s+/).filter(Boolean) : [];
          const sub = (parts[0] || "").toLowerCase();

          const loops = ctx.loops;

          if (!trimmed) {
            // bare "/loop" → show active or help (never auto-start with no context)
            const active = loops.getActive();
            if (active) {
              ctx.chat.appendAssistant(formatLoopBlock(active));
            } else {
              ctx.chat.appendAssistant(
                "No active loop.\n\n" +
                  "Start with explicit context: /loop <name> [N] <goal description>\n" +
                  "  e.g. /loop profile-editor 20 Build a user profile editor with validation, avatar upload and tests\n\n" +
                  "Special built-in: /loop ralph  (high-bar closed loop with discovery→plan→exec→verify→iterate)\n" +
                  "Other: /loop list | /loop status | /loop stop | /loop help",
              );
            }
            return;
          }

          if (sub === "list" || sub === "ls") {
            const all = loops.list();
            if (all.length === 0) {
              ctx.chat.appendAssistant(
                "No loops defined yet. Start one with `/loop <name> [N] <goal...>` (e.g. `/loop ralph 30`).",
              );
              return;
            }
            const lines = all.map(
              (s) =>
                `• ${s.name} — ${s.maxIterations} iters, ${s.closed ? "closed" : "open"}${s.useFleet ? ", fleet" : ""} — ${s.goal.slice(0, 70)}…`,
            );
            ctx.chat.appendAssistant(`Known loops:\n${lines.join("\n")}`);
            return;
          }

          if (sub === "status") {
            const name = parts[1];
            const state = name ? loops.get(name) : loops.getActive();
            if (!state) {
              ctx.chat.appendAssistant(
                name ? `No loop named "${name}".` : "No active loop. Start one with /loop <name> [N] <goal>.",
              );
              return;
            }
            ctx.chat.appendAssistant(formatLoopBlock(state));
            return;
          }

          if (sub === "spec") {
            const name = parts[1];
            const state = name ? loops.get(name) : loops.getActive();
            if (!state) {
              ctx.chat.appendAssistant(
                name ? `No loop named "${name}".` : "No active loop. /loop spec <name> shows a stored spec.",
              );
              return;
            }
            ctx.chat.appendAssistant(
              [
                `Spec for loop "${state.spec.name}" (the contract — edit and re-apply via loops.setSpec):`,
                "```json",
                JSON.stringify(state.spec, null, 2),
                "```",
              ].join("\n"),
            );
            return;
          }

          if (sub === "stop") {
            const res = loops.stop(parts[1]);
            refreshIndicator();
            ctx.chat.appendAssistant(res.message);
            return;
          }

          if (sub === "help" || sub === "?") {
            ctx.chat.appendAssistant(
              "Usage:\n" +
                "  /loop                 Show active loop or quick help\n" +
                "  /loop ralph           Start/resume the 'ralph' high-bar loop (default 30 iters, closed)\n" +
                "  /loop ralph 12        Same but cap at 12 iterations\n" +
                "  /loop mytask 20 Fix the auth bug with rate limits and tests\n" +
                "  /loop list            All known loops\n" +
                "  /loop status [name]   Detailed state + control block\n" +
                "  /loop spec [name]     Dump the stored spec (the contract) as JSON\n" +
                "  /loop stop [name]     Stop a loop (or the active one)\n\n" +
                "A loop cannot start unless you supply context for what is being carried out (the goal).\n" +
                "Custom named loops require /loop <name> [N] <goal description...> on first use.\n" +
                "Loops auto-continue between turns and halt on Esc / the stop button.\n" +
                "The spec (goal + verificationCriteria) is the contract the agent must honor each iteration.",
            );
            return;
          }

          // Start or resume a named loop. First token is name (or number for
          // bare-iter ralph). `maxI` stays undefined unless the user supplied
          // it, so resuming never silently resets a previously-chosen budget.
          let rawName = parts[0] || "ralph";
          let maxI: number | undefined;
          let goalFromArgs: string | undefined;

          if (/^\d+$/.test(rawName)) {
            // bare "/loop 30" → ralph with that length
            maxI = parseInt(rawName, 10);
            rawName = "ralph";
          } else if (parts[1] && /^\d+$/.test(parts[1])) {
            maxI = parseInt(parts[1], 10);
            goalFromArgs = parts.slice(2).join(" ").trim() || undefined;
          } else if (parts.length > 1) {
            goalFromArgs = parts.slice(1).join(" ").trim() || undefined;
          }

          let name = rawName;
          if (name === "default") name = "ralph";

          // Guard: do not start another dispatch if the same loop is already running.
          const active = loops.getActive();
          if (active && active.spec.name === name && active.status === "running") {
            ctx.chat.appendAssistant(
              `Loop "${active.spec.name}" is already running (iteration ${active.currentIteration}/${active.spec.maxIterations}). Use /loop stop or the stop button first.`,
            );
            return;
          }
          if (active && active.spec.name !== name) {
            ctx.chat.appendAssistant(
              `Loop "${active.spec.name}" is already running. Stop it first (/loop stop) — one loop drives the session at a time.`,
            );
            return;
          }

          // Core rule: a loop cannot start (first time) if there is no context of what is being carried out.
          const prior = loops.get(name);
          const creatingNew = !prior;
          if (creatingNew && !goalFromArgs && name !== "ralph") {
            ctx.chat.appendAssistant(
              `Cannot start loop "${name}" — no context of what is being carried out.\n` +
                `Provide the objective on creation: /loop ${name} [maxIters] <goal / task description>\n` +
                `Example: /loop ${name} 15 Implement profile editing with validation, persistence and e2e tests.\n` +
                `Use the built-in high-standard loop with: /loop ralph [N]`,
            );
            return;
          }

          // The built-in "ralph" loop gets its rich default spec on first start.
          if (name === "ralph" && creatingNew) {
            loops.setSpec(createDefaultRalphSpec(maxI ?? DEFAULT_MAX_ITERATIONS));
          }

          // Re-supplying a goal on resume updates the spec (silently ignoring
          // it would leave the user thinking they re-aimed the loop).
          if (prior && goalFromArgs && goalFromArgs !== prior.spec.goal) {
            loops.setSpec({ ...prior.spec, goal: goalFromArgs });
          }

          const res = loops.start(name, maxI, goalFromArgs);
          refreshIndicator();
          stalledTurns = 0;
          progressSeenThisTurn = false;
          ctx.chat.appendAssistant(`${res.message}\n\n${formatLoopBlock(res.state)}`);

          // Kick the first/next turn. From here the Stop-event continuation
          // keeps the loop moving until complete / stalled / interrupted.
          await ctx.chat.dispatch(buildKickPrompt(res.state), {
            displayText: `▶ /loop ${name} (iteration ${res.state.currentIteration})`,
          });
        },
      }),
    );

    // ── Event subscriptions ────────────────────────────────────────────────
    // UserPromptSubmit fires at the top of every turn (including our own
    // dispatched kicks): reset the per-turn progress flag.
    const disposePromptSub = ctx.hostEvents.subscribe("UserPromptSubmit", () => {
      progressSeenThisTurn = false;
      advancedThisTurn = false;
    });

    // Stop fires every time a turn settles successfully — this is the loop's
    // heartbeat, NOT a user halt (that's UserInterrupt below).
    const disposeStopSub = ctx.hostEvents.subscribe("Stop", () => {
      const svc = ctx.loops;
      const active = svc.getActive();
      if (!active || active.status !== "running") return;
      const name = active.spec.name;

      // The model recorded completion this turn → announce and stop driving.
      const refreshed = svc.get(name);
      if (!refreshed || refreshed.status !== "running") {
        refreshIndicator();
        if (refreshed?.status === "complete") {
          announce(`✓ Loop "${name}" complete after ${refreshed.history.length} recorded iteration(s).`);
        }
        return;
      }

      // Stall guard: a cooperative loop turn always ends in loop_record (or
      // loop_advance). Repeated turns without either mean the model has lost
      // the plot — halt instead of burning the budget.
      if (!progressSeenThisTurn) {
        stalledTurns += 1;
        if (stalledTurns >= MAX_STALLED_TURNS) {
          svc.stop(name);
          refreshIndicator();
          announce(
            [
              `⚠ Loop "${name}" halted: ${stalledTurns} consecutive turns settled without a loop_record call.`,
              `  Resume with /loop ${name} when ready — history is preserved.`,
            ].join("\n"),
          );
          stalledTurns = 0;
          return;
        }
      } else {
        stalledTurns = 0;
      }

      // Advance to the next iteration — unless the model already advanced
      // manually via loop_advance this turn (advancing again would skip an
      // iteration number). svc.advance completes the loop at the budget.
      if (advancedThisTurn) {
        scheduleContinuation(name);
        return;
      }
      void svc.advance(name).then((advanced) => {
        if (disposed) return;
        refreshIndicator();
        if (!advanced.advanced) return;
        if (advanced.state?.status === "complete") {
          announce(`✓ Loop "${name}" reached its iteration budget (${advanced.state.spec.maxIterations}) and ended.`);
          return;
        }
        scheduleContinuation(name);
      });
    });

    // UserInterrupt fires ONLY on a human Esc / stop-button press: halt the loop.
    const disposeInterruptSub = ctx.hostEvents.subscribe("UserInterrupt", () => {
      const svc = ctx.loops;
      const active = svc.getActive();
      if (active && active.status === "running") {
        const name = active.spec.name;
        const res = svc.stop(name);
        refreshIndicator();
        if (res.stopped) {
          announce(`⏹ Loop "${name}" stopped (user interrupt). Resume with /loop ${name} — history is preserved.`);
        }
      }
    });

    ctx.effect(() => disposePromptSub);
    ctx.effect(() => disposeStopSub);
    ctx.effect(() => disposeInterruptSub);
    ctx.effect(() => () => {
      disposed = true;
      progressSeenThisTurn = false;
      stalledTurns = 0;
      continuationPending = false;
    });
  },
};
