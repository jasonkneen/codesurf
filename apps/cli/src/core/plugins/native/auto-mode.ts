// Auto mode builtin extension.
//
// A fire-and-forget agent loop. The user kicks off a task with `/auto <task>`
// and the loop runs until one of four things happens:
//   1. The model declares the task done (state="done")
//   2. The model declares itself blocked (state="blocked")
//   3. The turn counter hits the max-turns cap
//   4. The user calls `/auto stop` (or presses Esc on an active run)
//
// Mechanism
// ---------
// The extension contributes a single tool (`auto_status`) and instructs the
// model — via the seed prompt — to call that tool at the end of every Auto
// turn. The tool's execute() inspects the structured status:
//
//   - state="continue" → call `services.chat.dispatch("Continue. Next: …")`
//     to queue the next user turn (the chat sink queues during an active
//     turn and fires it once the current turn settles).
//   - state="done"     → mark Auto inactive and write a summary via
//     `services.chat.appendAssistant(...)`.
//   - state="blocked"  → mark Auto inactive, write a summary including the
//     model's "why_blocked" reason, and surface resume commands.
//
// Auto-approve policy is intentionally not handled here. Tier-(a) is enforced
// in the seed prompt: the model is told to set state="blocked" before any
// destructive/irreversible op. The existing `tool.needsApproval` flow still
// gates approval-required tools (paid_request, etc.) — Auto doesn't bypass
// permission prompts, it just stops asking the model to second-guess
// reversible work.
//
// State lifetime
// --------------
// Module-local singleton state. Only one Auto run at a time per CLI instance.
// Resets on extension dispose and via the test-only __resetAutoState() hook.

import type { CodesurfPlugin, PluginContext, PluginManifest } from "@codesurf/plugin-api";
import { tool } from "ai";
import { createElement, type ReactNode, useSyncExternalStore } from "react";
import { z } from "zod";

const MAX_TURNS_DEFAULT = 200;
const MAX_TURNS_HARD_CAP = 1000;

type AutoStateValue = "continue" | "blocked" | "done";
type AutoRisk = "reversible" | "needs-approval" | "irreversible-pending";

export interface AutoStatusEntry {
  turn: number;
  state: AutoStateValue;
  phase: string;
  did: string;
  next: string;
  risk: AutoRisk;
  checkpoint: string | null;
  whyBlocked?: string;
  recordedAt: number;
}

interface AutoRunState {
  active: boolean;
  task: string;
  turnCount: number;
  maxTurns: number;
  history: AutoStatusEntry[];
  startedAt: number;
  stoppedReason: "running" | "done" | "blocked" | "max-turns" | "user-stop" | "idle" | "stalled";
  // Cleared on UserPromptSubmit, set on auto_status execute. Read by the
  // Stop subscriber as a safety-net: if a turn ends without the model
  // emitting auto_status the loop would otherwise stall silently — we
  // declare it stalled and surface the issue to the user.
  autoStatusEmittedThisTurn: boolean;
}

const state: AutoRunState = {
  active: false,
  task: "",
  turnCount: 0,
  maxTurns: MAX_TURNS_DEFAULT,
  history: [],
  startedAt: 0,
  stoppedReason: "idle",
  autoStatusEmittedThisTurn: false,
};

const AUTO_PREAMBLE = [
  "You are running in AUTO mode. The user will not be available to answer questions until this run ends. Your contract:",
  "",
  "1. EXECUTE reversible work without asking. Do not say 'shall I continue?' or 'should I do X?'. Just do the work.",
  "",
  "2. END EVERY TURN with a single call to the `auto_status` tool. The tool arguments ARE your end-of-turn status block. Do not emit a markdown status block in prose — only the tool call. Do not emit additional text after calling auto_status.",
  "",
  "3. STATE SEMANTICS:",
  "   - continue: more work to do; you have a concrete next step.",
  "   - blocked:  cannot proceed without human input. Set whenever you would otherwise want to ask a question.",
  "   - done:     the original task is complete AND verified (tests pass, build clean, behaviour confirmed).",
  "",
  '4. SELF-ENFORCED STOP CONDITIONS — set state="blocked" whenever any of these is true:',
  "   - Two-attempt rule: same approach has failed twice.",
  "   - Test / typecheck / build regression after a fix attempt.",
  "   - Requirement is ambiguous or under-specified.",
  "   - Destructive or irreversible operation needed: `git push --force`, `git reset --hard`, `rm -rf` outside cwd, `paid_request`, force-deleting branches, dropping tables, anything you wouldn't want to do silently.",
  "   - Approval-required tool would be invoked.",
  "",
  "5. CHECKPOINT with a `git commit` after each completed sub-goal. Record the resulting SHA in the `checkpoint` field of auto_status. If no commit happened this turn, set checkpoint to null.",
  "",
  "6. RISK FIELD on auto_status:",
  "   - reversible:           this turn only touched reversible state.",
  "   - needs-approval:       you are about to invoke an approval-required tool next turn (set state=blocked).",
  "   - irreversible-pending: an irreversible op is required next (set state=blocked).",
  "",
  "Begin work on the task below. End this turn with a single auto_status tool call.",
  "",
  "TASK:",
].join("\n");

function buildSeedPrompt(task: string): string {
  return `${AUTO_PREAMBLE}\n${task}`;
}

function buildContinuePrompt(nextHint: string): string {
  if (!nextHint.trim()) {
    return "Continue. End this turn with auto_status.";
  }
  return `Continue. Next: ${nextHint}\n\nEnd this turn with auto_status.`;
}

function shortSha(sha: string | null): string {
  if (!sha) return "-";
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}

function formatHistoryLine(entry: AutoStatusEntry): string {
  const parts = [
    `turn ${entry.turn}`,
    entry.state,
    entry.risk,
    entry.checkpoint ? shortSha(entry.checkpoint) : "no-checkpoint",
  ];
  const head = `[${parts.join(" · ")}]`;
  const next = entry.next ? ` → ${entry.next}` : "";
  return `${head} ${entry.did}${next}`;
}

export function formatRunSummary(s: AutoRunState = state): string {
  const last = s.history.at(-1);
  const lines: string[] = [
    "Auto run summary",
    `  task: ${s.task || "(none)"}`,
    `  turns: ${s.turnCount}/${s.maxTurns}`,
    `  state: ${last?.state ?? s.stoppedReason}`,
    `  stopped: ${s.stoppedReason}`,
  ];
  if (s.history.length > 0) {
    lines.push("", "  history:");
    for (const entry of s.history) {
      lines.push(`    ${formatHistoryLine(entry)}`);
    }
  }
  if (last?.state === "blocked" && last.whyBlocked) {
    lines.push("", `  why-blocked: ${last.whyBlocked}`);
  }
  return lines.join("\n");
}

function resetState(): void {
  state.active = false;
  state.task = "";
  state.turnCount = 0;
  state.maxTurns = MAX_TURNS_DEFAULT;
  state.history = [];
  state.startedAt = 0;
  state.stoppedReason = "idle";
  state.autoStatusEmittedThisTurn = false;
}

/** Test-only state reset. Do not call from production code. */
export function __resetAutoState(): void {
  resetState();
}

/** Test-only state snapshot. */
export function __getAutoState(): Readonly<AutoRunState> {
  return state;
}

const STATUS_INPUT_SCHEMA = z.object({
  state: z.enum(["continue", "blocked", "done"]).describe("Run state for this turn."),
  phase: z.string().describe("Short label for the current sub-goal in flight."),
  did: z.string().describe("One-line summary of what this turn accomplished."),
  next: z.string().describe("One-line plan for the next turn. Empty string if state=done or state=blocked."),
  risk: z
    .enum(["reversible", "needs-approval", "irreversible-pending"])
    .describe("Risk classification for this turn's effects and the next planned step."),
  checkpoint: z.string().nullable().describe("Git commit SHA written this turn, or null if no commit happened."),
  why_blocked: z
    .string()
    .optional()
    .describe("Required when state=blocked. Plain-English reason the model cannot proceed."),
});

interface AutoStatusIndicatorState {
  active: boolean;
  turnCount: number;
  maxTurns: number;
}

// Tiny pub-sub so the status indicator re-renders only when Auto state moves,
// not on every host render.
const indicatorListeners = new Set<() => void>();

function snapshotIndicator(): AutoStatusIndicatorState {
  return { active: state.active, turnCount: state.turnCount, maxTurns: state.maxTurns };
}

let lastIndicatorSnapshot: AutoStatusIndicatorState = snapshotIndicator();

function notifyIndicator(): void {
  lastIndicatorSnapshot = snapshotIndicator();
  for (const listener of indicatorListeners) listener();
}

function getIndicatorSnapshot(): AutoStatusIndicatorState {
  return lastIndicatorSnapshot;
}

function subscribeIndicator(listener: () => void): () => void {
  indicatorListeners.add(listener);
  return () => {
    indicatorListeners.delete(listener);
  };
}

function AutoStatusIndicator(): ReactNode {
  const snap = useSyncExternalStore(subscribeIndicator, getIndicatorSnapshot, getIndicatorSnapshot);
  if (!snap.active) return null;
  return createElement("text", { fg: "#e5c07b", wrapMode: "none" }, `▶ AUTO ${snap.turnCount}/${snap.maxTurns}`);
}

function parseTurnsFlag(args: string): { maxTurns: number; task: string } {
  const match = args.match(/--turns\s+(\d+)/);
  if (!match) return { maxTurns: MAX_TURNS_DEFAULT, task: args.trim() };
  const requested = Number.parseInt(match[1], 10);
  const maxTurns = Number.isFinite(requested)
    ? Math.min(Math.max(1, requested), MAX_TURNS_HARD_CAP)
    : MAX_TURNS_DEFAULT;
  const task = args.replace(/--turns\s+\d+/, "").trim();
  return { maxTurns, task };
}

const manifest: PluginManifest = {
  id: "builtin.auto-mode",
  name: "Auto Mode",
  version: "1.0.0",
  description:
    "Fire-and-forget agent loop. `/auto <task>` runs until done, blocked, or max turns. Structured status block via the `auto_status` tool.",
  enabledByDefault: true,
  protected: false,
  capabilities: ["tools", "commands", "status-indicators"],
};

export const autoModePlugin: CodesurfPlugin = {
  name: "codesurf-auto-mode",
  manifest,
  inject: ["contributions", "screens", "tools", "chat", "ui", "settings"],
  apply(ctx: PluginContext) {
    // ── Tool: auto_status ────────────────────────────────────────────────
    ctx.effect(() =>
      ctx.contributions.registerTool({
        name: "auto_status",
        label: "Auto Status",
        description: "Required end-of-turn status block for Auto mode. The model emits this once per turn.",
        group: "auto",
        tool: tool({
          description:
            "Emit a structured Auto-mode status block at the end of a turn. MUST be called exactly once per Auto turn. Calling this tool ends the turn — do not emit additional text afterwards. The host inspects the state field to decide whether to continue the loop, stop on completion, or pause for human input.",
          inputSchema: STATUS_INPUT_SCHEMA,
          execute: async (args) => {
            if (!state.active) {
              return {
                success: true,
                output:
                  "Auto mode is not active. Status was recorded but the loop will not continue. Use `/auto <task>` to start a run.",
              };
            }

            state.turnCount += 1;
            state.autoStatusEmittedThisTurn = true;

            const entry: AutoStatusEntry = {
              turn: state.turnCount,
              state: args.state,
              phase: args.phase,
              did: args.did,
              next: args.next,
              risk: args.risk,
              checkpoint: args.checkpoint,
              whyBlocked: args.why_blocked,
              recordedAt: Date.now(),
            };
            state.history.push(entry);

            if (args.state === "done") {
              state.active = false;
              state.stoppedReason = "done";
              notifyIndicator();
              ctx.chat.appendAssistant(`✓ Auto run complete.\n\n${formatRunSummary()}`);
              return { success: true, output: "Auto run complete; loop ended." };
            }

            if (args.state === "blocked") {
              state.active = false;
              state.stoppedReason = "blocked";
              notifyIndicator();
              const reason = args.why_blocked?.trim() || "(no reason given)";
              ctx.chat.appendAssistant(
                [
                  `⏸ Auto run blocked: ${reason}`,
                  "",
                  formatRunSummary(),
                  "",
                  "Resume options:",
                  "  `/auto continue [extra instruction]` — keep going with the same task.",
                  "  `/auto <new task>`                   — start a fresh run.",
                  "  `/auto stop`                         — clear the run state.",
                ].join("\n"),
              );
              return { success: true, output: `Auto run paused: ${reason}` };
            }

            // state === "continue"
            if (state.turnCount >= state.maxTurns) {
              state.active = false;
              state.stoppedReason = "max-turns";
              notifyIndicator();
              ctx.chat.appendAssistant(
                [
                  `⏸ Auto run hit max turns (${state.maxTurns}).`,
                  "",
                  formatRunSummary(),
                  "",
                  "Resume with `/auto continue --turns N` to extend the cap.",
                ].join("\n"),
              );
              return { success: true, output: `Auto run hit max turns cap (${state.maxTurns}).` };
            }

            notifyIndicator();
            ctx.chat.dispatch(buildContinuePrompt(entry.next), {
              displayText: `→ auto turn ${state.turnCount + 1}`,
            });
            return {
              success: true,
              output: `Turn ${state.turnCount} recorded. Loop continues; next prompt queued.`,
            };
          },
        }),
      }),
    );

    // ── Slash command actions ────────────────────────────────────────────
    const continueRun = (args: string): void => {
      if (state.active) {
        ctx.chat.appendAssistant(`Auto run already active (turn ${state.turnCount}/${state.maxTurns}).`);
        return;
      }
      if (!state.task) {
        ctx.chat.appendAssistant("No previous Auto run to resume. Start one with `/auto <task>`.");
        return;
      }

      const raw = args.trim();
      const { maxTurns: extraMax, task: extraInstruction } = parseTurnsFlag(raw);

      if (raw.includes("--turns")) {
        state.maxTurns = extraMax;
      }

      state.active = true;
      state.stoppedReason = "running";
      notifyIndicator();

      const continuationHint = extraInstruction
        ? `Resume the prior task. Additional instruction from the user: ${extraInstruction}`
        : "Resume the prior task from where you paused.";
      ctx.chat.appendAssistant(`▶ Auto run resumed at turn ${state.turnCount}/${state.maxTurns}.`);
      ctx.chat.dispatch(buildContinuePrompt(continuationHint), {
        displayText: `/auto continue ${extraInstruction}`.trim(),
      });
    };

    const stopRun = (): void => {
      if (!state.active && state.stoppedReason === "idle") {
        ctx.chat.appendAssistant("No Auto run to stop.");
        return;
      }
      const wasActive = state.active;
      state.active = false;
      state.stoppedReason = wasActive ? "user-stop" : state.stoppedReason;
      notifyIndicator();
      ctx.chat.appendAssistant(
        [`⏹ Auto run stopped${wasActive ? "" : " (was already paused)"}.`, "", formatRunSummary()].join("\n"),
      );
    };

    const showStatus = (): void => {
      if (!state.active && state.history.length === 0) {
        ctx.chat.appendAssistant("No Auto run history.");
        return;
      }
      ctx.chat.appendAssistant(formatRunSummary());
    };

    // ── Slash command: /auto (with continue | stop | status sub-verbs) ──
    //
    // `stop` and `status` are verbs only on their own, so `/auto stop the
    // flaky test` still starts a task. `continue` is a verb only when there
    // is a run to resume; without one it is the start of a task.
    ctx.effect(() =>
      ctx.contributions.registerCommand({
        name: "/auto",
        description: "Start an Auto-mode run that loops until done, blocked, or max turns.",
        argsHint: "<task> [--turns N] | continue [instruction] | stop | status",
        handler: ({ args }) => {
          const raw = args.trim();
          const [verb = "", ...rest] = raw.split(/\s+/);
          if (verb === "stop" && rest.length === 0) return stopRun();
          if (verb === "status" && rest.length === 0) return showStatus();
          if (verb === "continue" && state.task && !state.active) return continueRun(rest.join(" "));
          if (!raw) {
            ctx.chat.appendAssistant(
              [
                "Auto mode — fire-and-forget agent loop.",
                "",
                "Usage:",
                "  /auto <task description> [--turns N]   — start a run",
                "  /auto continue [extra instruction]     — resume after a blocker",
                "  /auto stop                             — stop the current run",
                "  /auto status                           — show run state and history",
                "",
                `Defaults: ${MAX_TURNS_DEFAULT} turns. Hard cap: ${MAX_TURNS_HARD_CAP}.`,
                "",
                "The agent ends every turn with an `auto_status` tool call carrying a structured status block.",
                "It will pause (state=blocked) before any destructive op, ambiguous requirement, or two-attempt rule trip.",
                "",
                'Trouble: if dispatching the seed prompt fails with "Invalid prompt: The messages do not',
                'match the ModelMessage[] schema", your session history has a malformed message (often',
                "a leftover tool call from a cancelled turn). Run `/clear` and try again.",
              ].join("\n"),
            );
            return;
          }

          if (state.active) {
            ctx.chat.appendAssistant(
              `Auto run already active (turn ${state.turnCount}/${state.maxTurns}). Use /auto stop first, or wait for the current run to settle.`,
            );
            return;
          }

          const { maxTurns, task } = parseTurnsFlag(raw);
          if (!task) {
            ctx.chat.appendAssistant("No task given. Usage: /auto <task description> [--turns N]");
            return;
          }

          state.active = true;
          state.task = task;
          state.turnCount = 0;
          state.maxTurns = maxTurns;
          state.history = [];
          state.startedAt = Date.now();
          state.stoppedReason = "running";
          notifyIndicator();

          ctx.chat.appendAssistant(
            `▶ Auto mode active. Task: ${task}\n  max turns: ${maxTurns} (hard cap ${MAX_TURNS_HARD_CAP})`,
          );
          ctx.chat.dispatch(buildSeedPrompt(task), { displayText: `/auto ${task}` });
        },
      }),
    );

    // The pre-sub-verb names still dispatch when typed, but stay out of the
    // menu so `/auto` is the one entry.
    for (const [name, run] of [
      ["/auto-continue", ({ args }: { args: string }) => continueRun(args)],
      ["/auto-stop", () => stopRun()],
      ["/auto-status", () => showStatus()],
    ] as const) {
      ctx.effect(() =>
        ctx.contributions.registerCommand({
          name,
          description: `Same as /auto ${name.slice("/auto-".length)}.`,
          handler: run,
          visible: () => false,
        }),
      );
    }

    // ── Status indicator (footer chip) ───────────────────────────────────
    const disposeIndicator = ctx.effect(() =>
      ctx.screens.registerStatusIndicator({
        id: "auto-mode.turns",
        placement: "input-footer",
        render: () => createElement(AutoStatusIndicator),
      }),
    );
    ctx.effect(() => disposeIndicator);

    // ── Event subscriptions ─────────────────────────────────────────────
    // Safety net: if a turn ends without the model emitting `auto_status`,
    // the dispatcher won't be called and the loop stalls silently. The
    // Stop event fires every time a turn settles — if `state.active` is
    // still true but we never saw an auto_status, declare stalled and
    // surface a one-liner so the user notices.
    const disposePromptSub = ctx.hostEvents.subscribe("UserPromptSubmit", () => {
      state.autoStatusEmittedThisTurn = false;
    });
    const disposeStopSub = ctx.hostEvents.subscribe("Stop", () => {
      if (state.active && !state.autoStatusEmittedThisTurn) {
        state.active = false;
        state.stoppedReason = "stalled";
        notifyIndicator();
        ctx.chat.appendAssistant(
          [
            "⚠ Auto run halted: the model finished a turn without calling `auto_status`.",
            "  Resume the task manually with `/auto <task>` if you want to continue.",
          ].join("\n"),
        );
      }
    });
    // A human interrupt (Esc / Ctrl-X → Agent.abort) must halt the loop.
    // `Stop` fires on every settled turn, so it can't tell a normal turn end
    // from a user halt — `UserInterrupt` is the dedicated human-halt signal and
    // the only one we can key off to stop dispatching the next auto turn.
    const disposeInterruptSub = ctx.hostEvents.subscribe("UserInterrupt", () => {
      if (!state.active) return;
      state.active = false;
      state.stoppedReason = "user-stop";
      notifyIndicator();
      ctx.chat.appendAssistant("⏹ Auto run halted: interrupted by the user.");
    });
    ctx.effect(() => disposePromptSub);
    ctx.effect(() => disposeStopSub);
    ctx.effect(() => disposeInterruptSub);

    ctx.effect(() => () => {
      resetState();
      notifyIndicator();
    });
  },
};
