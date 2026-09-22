// One turn = one child process, for agent CLIs that cannot hold a session.
//
// The honest counterpart to `PersistentStdioSession`. Several CLIs stream their
// output beautifully but only accept a prompt as argv and exit when the turn
// ends — there is no stdin turn loop to keep alive:
//
//   grok     `-p <prompt> --output-format streaming-messages-json
//             --include-partial-messages`   (token-level deltas, then exits)
//   lazar    `-p <prompt> --output-format stream-json`
//   fractal  `-p <prompt> --json`           (single object, no streaming)
//
// For these, conversation continuity comes from a session id passed back in on
// the next turn (`--resume` / `--session`), not from process lifetime. The CLI
// cold start is therefore paid once per TURN and cannot be warmed away. That is
// a property of the CLI, not of this code — do not "fix" it by reaching for
// PersistentStdioSession, which will hang waiting for a stdin reader that the
// CLI never installs.

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { ProviderStreamController, ProviderUsageSnapshot } from "../../api";
import { AnthropicStreamJsonDecoder } from "./anthropic-stream-json";
import { NdjsonFramer } from "./ndjson";

/** How long a cancelled child gets to honour SIGTERM before SIGKILL, and how
 *  long we then wait for its exit before settling the turn regardless. */
const DEFAULT_TERMINATE_GRACE_MS = 2_000;

/** How long the child may stream nothing at all before the turn gives up on
 *  it. A one-shot CLI that wedges has no other way to end, since nothing but
 *  its own exit settles the turn. Generous for the same reason as the
 *  session-turn backstop (900s): a CLI running a long build or test suite
 *  inside a tool call is silent, not stalled. Kept under that backstop so this
 *  tighter guard — which also reclaims the child — fires first.
 *  `CODESURF_ONESHOT_STALL_MS` overrides it; 0 disables. */
const DEFAULT_STALL_MS = 600_000;

export function resolveOneshotStallMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CODESURF_ONESHOT_STALL_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_STALL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_STALL_MS;
}

export interface OneshotTurnOptions {
  bin: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Human label for error messages ("grok", "lazar", ...). */
  label: string;
  /** Prompt to write on stdin instead of argv, when the CLI reads it that way. */
  stdinPrompt?: string;
  suppressToolNames?: ReadonlySet<string>;
  onSessionId?: (sessionId: string) => void;
  onStderrLine?: (line: string) => void;
  abortSignal?: AbortSignal;
  /** SIGTERM→SIGKILL grace on cancellation. */
  terminateGraceMs?: number;
  /** Silence budget before the turn fails; 0 disables the watchdog. */
  stallMs?: number;
}

/**
 * Run one turn to completion against a one-shot CLI.
 *
 * Resolves when the process exits. The decoder's terminal `result` is preferred
 * for usage/stop-reason, but exit is what actually ends the turn — several of
 * these CLIs exit without a `result` line when they fail early (bad auth, no
 * model configured), and the turn must still settle.
 *
 * Cancellation owns the child's termination: SIGTERM, SIGKILL after the grace
 * period, and the turn settles on the child's exit (or a final bounded wait)
 * rather than on `close`, which a descendant holding the inherited pipes can
 * postpone forever.
 */
export function runOneshotStreamJsonTurn(
  options: OneshotTurnOptions,
  controller: ProviderStreamController,
): Promise<{ usage?: ProviderUsageSnapshot }> {
  return new Promise((resolve, reject) => {
    const abortedError = () => new Error(`${options.label} turn aborted.`);

    // Check before spawning: a pre-cancelled turn must not launch a process
    // only to hunt it down.
    if (options.abortSignal?.aborted) {
      const err = abortedError();
      controller.emit({ type: "error", message: err.message });
      reject(err);
      return;
    }

    const decoder = new AnthropicStreamJsonDecoder({
      suppressToolNames: options.suppressToolNames,
      onSessionId: options.onSessionId,
    });

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(options.bin, options.args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
      }) as ChildProcessWithoutNullStreams;
    } catch (err) {
      const message = `Failed to launch \`${options.bin}\`: ${err instanceof Error ? err.message : String(err)}`;
      controller.emit({ type: "error", message });
      reject(new Error(message));
      return;
    }

    let settled = false;
    let exited = false;
    let termTimer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    const framer = new NdjsonFramer({
      onValue: (value) => {
        if (settled) return;
        for (const event of decoder.push(value)) controller.emit(event);
      },
    });

    let stallTimer: NodeJS.Timeout | null = null;
    const clearStallWatchdog = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = null;
    };
    const stallMs = options.stallMs ?? resolveOneshotStallMs();
    const armStallWatchdog = () => {
      if (stallMs <= 0 || settled) return;
      clearStallWatchdog();
      stallTimer = setTimeout(() => {
        stallTimer = null;
        if (settled) return;
        // Wedged, not slow. Reclaim the child first — settling the turn while
        // it still runs would leak the process for the life of the session.
        try {
          child.kill("SIGKILL");
        } catch {
          // Best-effort; the turn settles either way.
        }
        finish(new Error(`${options.label} produced no output for ${Math.round(stallMs / 1000)}s.`));
      }, stallMs);
      stallTimer.unref?.();
    };

    const grace = options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS;
    const onAbort = () => {
      if (settled) return;
      if (exited) {
        // The owned process is already gone, so there is nothing left to
        // signal and no bounded wait worth arming. Anything still holding the
        // pipes is a descendant we do not own, and `close` may never arrive —
        // waiting for it would hand the cancellation to that descendant.
        finish(abortedError());
        return;
      }
      try {
        child.kill("SIGTERM");
      } catch {
        // Best-effort.
      }
      termTimer = setTimeout(() => {
        termTimer = null;
        if (settled || exited) return;
        try {
          child.kill("SIGKILL");
        } catch {
          // Best-effort.
        }
        // SIGKILL cannot be ignored; if exit still has not arrived the process
        // is beyond our reach and the turn must not wait on it.
        killTimer = setTimeout(() => finish(abortedError()), grace);
        killTimer.unref?.();
      }, grace);
      termTimer.unref?.();
    };
    options.abortSignal?.addEventListener("abort", onAbort, { once: true });

    let stderrTail = "";
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      armStallWatchdog();
      framer.push(chunk);
    });

    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      if (settled) return;
      stderrTail += chunk;
      if (stderrTail.length > 64 * 1024) stderrTail = stderrTail.slice(-64 * 1024);
      if (options.onStderrLine) {
        for (const line of chunk.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed) options.onStderrLine(trimmed);
        }
      }
    });

    if (options.stdinPrompt !== undefined) {
      try {
        child.stdin.write(options.stdinPrompt);
        child.stdin.end();
      } catch {
        // The exit handler reports the real failure.
      }
    } else {
      // Close stdin so a CLI that probes for piped input does not block.
      try {
        child.stdin.end();
      } catch {
        // Best-effort.
      }
    }

    controller.emit({ type: "status", status: "streaming" });
    armStallWatchdog();

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearStallWatchdog();
      options.abortSignal?.removeEventListener("abort", onAbort);
      if (termTimer) clearTimeout(termTimer);
      if (killTimer) clearTimeout(killTimer);
      termTimer = null;
      killTimer = null;
      if (err) {
        controller.emit({ type: "error", message: err.message });
        reject(err);
        return;
      }
      const { usage, stopReason, errorMessage } = decoder.state;
      controller.emit({ type: "done", stopReason: errorMessage ? "error" : (stopReason ?? "end_turn") });
      resolve({ usage });
    };

    child.on("error", (err) => finish(new Error(`${options.label}: ${err.message}`)));

    child.on("exit", () => {
      exited = true;
      // A cancelled turn settles as soon as the process is gone; waiting for
      // `close` would hand the cancellation to whatever still holds the pipes.
      if (options.abortSignal?.aborted) finish(abortedError());
    });

    child.on("close", (code, signal) => {
      framer.flush();
      if (options.abortSignal?.aborted) {
        finish(abortedError());
        return;
      }
      // A non-zero exit with no decoded result means the CLI failed before it
      // could report structurally — stderr is the only diagnosis available.
      if (!decoder.state.finished && code !== 0) {
        const detail = stderrTail.trim().split(/\r?\n/).slice(-4).join("\n");
        const why = signal ? `killed by ${signal}` : `exited with code ${code ?? "unknown"}`;
        finish(new Error(`${options.label} ${why}${detail ? `:\n${detail}` : ""}`));
        return;
      }
      finish();
    });
  });
}
