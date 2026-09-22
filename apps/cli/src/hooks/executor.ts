import { type ChildProcess, spawn } from "child_process";
import type { AggregatedHookResult, CommandHook, HookInput, HookOutput, HookResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const BLOCKING_EXIT_CODE = 2;
/** Grace period between SIGTERM and SIGKILL when a hook ignores termination. */
export const HOOK_KILL_ESCALATION_MS = 3_000;

/**
 * Execute a single command hook by spawning a shell process.
 * The hook input is piped as JSON to stdin.
 * stdout is parsed as JSON if it starts with '{'.
 * Exit code semantics: 0 = success, 2 = blocking, other = non-blocking error.
 *
 * Settling the returned promise and cleaning up the process are separate
 * concerns: a timeout or abort resolves the caller immediately but keeps the
 * SIGTERM → SIGKILL escalation alive until the child (and its process group)
 * has actually exited. Previously `finish` cleared the escalation timer it had
 * just armed, so a hook that ignored SIGTERM kept running — and kept touching
 * the workspace — after the caller had already moved on.
 */
export function execCommandHook(
  hook: CommandHook,
  input: HookInput,
  cwd: string,
  signal?: AbortSignal,
): Promise<HookResult> {
  const timeoutMs = hook.timeout ? hook.timeout * 1000 : DEFAULT_TIMEOUT_MS;
  const jsonInput = JSON.stringify(input);

  return new Promise<HookResult>((resolve) => {
    if (signal?.aborted) {
      resolve({ outcome: "cancelled", exitCode: null, command: hook.command });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let exited = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const clearKillTimer = () => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
    };

    // Resolve the caller. Deliberately does NOT touch `killTimer`: process
    // cleanup outlives promise settlement (see the doc comment above).
    const finish = (result: HookResult) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    // Ask the hook to stop, and escalate to SIGKILL if it is still alive after
    // the grace period. Idempotent: a timeout followed by an abort (or vice
    // versa) arms a single escalation.
    const requestTermination = () => {
      if (exited) return;
      terminateProcessTree(child, "SIGTERM");
      if (killTimer) return;
      killTimer = setTimeout(() => {
        killTimer = undefined;
        if (!exited) terminateProcessTree(child, "SIGKILL");
      }, HOOK_KILL_ESCALATION_MS);
    };

    const child = spawn("sh", ["-c", hook.command], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CODESURF_HOOK_EVENT: input.hook_event_name },
      detached: process.platform !== "win32",
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (settled) return;
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      // A spawn failure means there is no process to escalate against.
      if (!child.pid) {
        exited = true;
        clearKillTimer();
      }
      finish({
        outcome: "non_blocking_error",
        stderr: err.message,
        exitCode: null,
        command: hook.command,
      });
    });

    child.on("exit", () => {
      exited = true;
      clearKillTimer();
    });

    child.on("close", (code) => {
      exited = true;
      clearKillTimer();
      const exitCode = code ?? null;
      const output = parseHookOutput(stdout);

      if (exitCode === BLOCKING_EXIT_CODE) {
        finish({
          outcome: "blocking",
          output,
          stderr: stderr.trim(),
          exitCode,
          command: hook.command,
        });
        return;
      }

      if (exitCode !== null && exitCode !== 0) {
        finish({
          outcome: "non_blocking_error",
          output,
          stderr: stderr.trim(),
          exitCode,
          command: hook.command,
        });
        return;
      }

      finish({
        outcome: "success",
        output,
        stderr: stderr.trim() || undefined,
        exitCode: exitCode ?? 0,
        command: hook.command,
      });
    });

    // A hook that exits without reading stdin closes the pipe; the write then
    // fails with EPIPE asynchronously, which is an unhandled `error` event
    // (process exit) without a listener. The hook's exit code still decides.
    child.stdin?.on("error", () => {});
    try {
      child.stdin?.write(jsonInput);
      child.stdin?.end();
    } catch {
      /* stdin may already be closed */
    }

    const timeoutTimer = setTimeout(() => {
      requestTermination();
      finish({
        outcome: "non_blocking_error",
        stderr: `Hook timed out after ${hook.timeout ?? 30}s`,
        exitCode: null,
        command: hook.command,
      });
    }, timeoutMs);

    const onAbort = () => {
      requestTermination();
      finish({ outcome: "cancelled", exitCode: null, command: hook.command });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  // `child.killed` only records that a signal was SENT, not that the process
  // died, so it must not gate escalation. Callers track actual exit instead.
  if (!child.pid) return;

  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      const code =
        typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
      if (code !== "ESRCH") {
        try {
          child.kill(signal);
        } catch {
          /* already exited */
        }
      }
      return;
    }
  }

  try {
    child.kill(signal);
  } catch {
    /* already exited */
  }
}

/**
 * Execute an array of hook commands in parallel and aggregate results.
 */
export async function executeHooks(
  hooks: CommandHook[],
  input: HookInput,
  cwd: string,
  signal?: AbortSignal,
): Promise<AggregatedHookResult> {
  if (hooks.length === 0) {
    return {
      blocked: false,
      blockingErrors: [],
      preventContinuation: false,
      additionalContexts: [],
      results: [],
    };
  }

  const results = await Promise.all(hooks.map((hook) => execCommandHook(hook, input, cwd, signal)));

  return aggregateResults(results);
}

function aggregateResults(results: HookResult[]): AggregatedHookResult {
  const blockingErrors: Array<{ command: string; stderr: string }> = [];
  const additionalContexts: string[] = [];
  let blocked = false;
  let preventContinuation = false;
  let stopReason: string | undefined;
  let decision: "approve" | "block" | undefined;

  for (const result of results) {
    if (result.outcome === "blocking") {
      blocked = true;
      blockingErrors.push({
        command: result.command,
        stderr: result.stderr ?? "Hook returned exit code 2",
      });
    }

    if (result.output) {
      if (result.output.continue === false) {
        preventContinuation = true;
        stopReason = result.output.stopReason ?? stopReason;
      }
      if (result.output.decision === "block") {
        blocked = true;
        decision = "block";
      } else if (result.output.decision === "approve" && !blocked) {
        decision = "approve";
      }
      if (result.output.additionalContext) {
        additionalContexts.push(result.output.additionalContext);
      }
    }
  }

  return {
    blocked,
    blockingErrors,
    preventContinuation,
    stopReason,
    additionalContexts,
    decision,
    results,
  };
}

function parseHookOutput(stdout: string): HookOutput | undefined {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{")) return undefined;

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null) return undefined;

    const output: HookOutput = {};
    if (typeof parsed.continue === "boolean") output.continue = parsed.continue;
    if (typeof parsed.stopReason === "string") output.stopReason = parsed.stopReason;
    if (parsed.decision === "approve" || parsed.decision === "block") output.decision = parsed.decision;
    if (typeof parsed.reason === "string") output.reason = parsed.reason;
    if (typeof parsed.additionalContext === "string") output.additionalContext = parsed.additionalContext;

    return Object.keys(output).length > 0 ? output : undefined;
  } catch {
    return undefined;
  }
}
