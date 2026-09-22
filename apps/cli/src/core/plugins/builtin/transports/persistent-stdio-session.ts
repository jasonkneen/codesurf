// Long-lived agent-CLI session over stdio.
//
// The shape CodeSurf wants from every agent CLI: spawn the process ONCE, hold
// it open for the life of the conversation, write each user turn as a JSON line
// on stdin, and read streamed events back on stdout. No per-turn process boot,
// so only the first turn of a conversation pays the CLI's cold start — and with
// `warm()` even that is paid while the user is still typing.
//
// Which CLIs can actually do this is narrower than it looks. A CLI qualifies
// only if it accepts turns on stdin after start; streaming *output* alone is not
// enough. As of this writing:
//
//   amp     `-x --stream-json --stream-json-input`   ✅ qualifies
//   claude  Agent SDK AsyncIterable prompt           ✅ (has its own impl)
//   codex   `app-server` JSON-RPC                    ✅ (has its own impl)
//   grok    `-p/--single` only                       ❌ one-shot per turn
//   lazar   `--input-format stream-json` is documented as
//           "Reserved: ... Currently treated as text" ❌ one-shot per turn
//   fractal `-p` + single JSON result                 ❌ one-shot per turn
//
// Do not add a provider here on the strength of its output format. Check that
// its --help documents a stdin turn loop, or it will hang on the second turn.

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { ProviderStreamController, ProviderStreamEvent, ProviderUsageSnapshot } from "../../api";
import { AnthropicStreamJsonDecoder } from "./anthropic-stream-json";
import { NdjsonFramer } from "./ndjson";

/** How long to wait for ANY output from the child before declaring the turn
 *  stalled. Mirrors the Claude Agent SDK adapter's watchdog so a dead upstream
 *  surfaces as an error instead of an indefinite spinner. */
const DEFAULT_STALL_MS = 120_000;

/** How long a retired child gets to honour SIGTERM before it is SIGKILLed,
 *  and how long we wait for exit after SIGKILL before giving up on it. */
const DEFAULT_TERMINATE_GRACE_MS = 2_000;

export interface PersistentStdioSessionOptions {
  /** Executable to spawn. */
  bin: string;
  /** Arguments. Must put the CLI into "read JSONL turns from stdin" mode. */
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Stall watchdog in ms; 0 disables. */
  stallMs?: number;
  /** SIGTERM→SIGKILL grace when a child is retired or the session closes. */
  terminateGraceMs?: number;
  /** Tool names to hide from the transcript (host renders them elsewhere). */
  suppressToolNames?: ReadonlySet<string>;
  /** Human label used in error messages ("amp", "grok", ...). */
  label: string;
  /** Called with the upstream session id when the CLI reports one. */
  onSessionId?: (sessionId: string) => void;
  /** Optional hook to observe raw stderr (progress lines, auth errors). */
  onStderrLine?: (line: string) => void;
}

interface ActiveTurn {
  decoder: AnthropicStreamJsonDecoder;
  controller: ProviderStreamController;
  resolve: (result: { usage?: ProviderUsageSnapshot }) => void;
  reject: (err: Error) => void;
  cleanup?: () => void;
}

/**
 * One spawned child and everything routed by it. Every stdio listener closes
 * over its own handle, so output from a process this session has moved on
 * from can never be decoded as the current turn.
 */
interface ChildHandle {
  child: ChildProcessWithoutNullStreams;
  exited: boolean;
  /**
   * Set when a turn was retired (stall timeout, host abort, `abortTurn()`)
   * while this child kept running. The stream-json protocol carries no turn
   * ids, so the retired turn's decoder keeps consuming until it sees the
   * terminal assistant stop — the only boundary that separates that turn's
   * tail from whatever comes next. Until then the child cannot take a turn.
   */
  draining: AnthropicStreamJsonDecoder | null;
}

/**
 * One persistent child process, many turns.
 *
 * Lifecycle: `warm()` (or the first `sendTurn`) spawns; `sendTurn` writes one
 * JSON line and resolves when the matching `result` arrives; `disconnect()`
 * closes stdin, terminates the child and resolves once it has exited.
 */
export class PersistentStdioSession {
  private current: ChildHandle | null = null;
  private activeTurn: ActiveTurn | null = null;
  private stallTimer: NodeJS.Timeout | null = null;
  private stderrTail = "";
  private disconnected = false;
  private disconnectPromise: Promise<void> | null = null;
  private startError: Error | null = null;

  constructor(private readonly options: PersistentStdioSessionOptions) {}

  /** True once the child is running and able to accept a turn. */
  get isRunning(): boolean {
    return this.current !== null && !this.disconnected;
  }

  /**
   * Boot the child process without sending a turn.
   *
   * This is the whole point of the class: called when the user *selects* the
   * model, the CLI's cold start overlaps with them typing their first message
   * instead of being charged to it. Idempotent and safe to call repeatedly.
   */
  warm(): void {
    if (this.disconnected || this.current) return;
    // A previous spawn failure must not poison a respawn that would succeed.
    this.startError = null;
    try {
      this.spawnChild();
    } catch (err) {
      // Remember it so the next sendTurn reports a real reason rather than
      // silently retrying a spawn that cannot succeed.
      this.startError = err instanceof Error ? err : new Error(String(err));
    }
  }

  private spawnChild(): void {
    const child = spawn(this.options.bin, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    const handle: ChildHandle = { child, exited: false, draining: null };
    this.current = handle;

    const framer = new NdjsonFramer({
      onValue: (value) => this.dispatch(handle, value),
    });

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      if (handle === this.current && this.activeTurn) this.armStallWatchdog();
      framer.push(chunk);
    });

    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      if (handle !== this.current) return;
      this.stderrTail += chunk;
      if (this.stderrTail.length > 64 * 1024) this.stderrTail = this.stderrTail.slice(-64 * 1024);
      if (this.options.onStderrLine) {
        for (const line of chunk.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed) this.options.onStderrLine(trimmed);
        }
      }
    });

    child.on("error", (err) => {
      if (handle !== this.current) return;
      // Retire the handle first: a turn failed here must not start draining a
      // child that is already gone.
      this.current = null;
      this.failActiveTurn(new Error(`${this.options.label}: ${err.message}`));
    });

    // A child that dies between turns makes the next write fail with EPIPE,
    // emitted asynchronously on stdin. Unhandled, that is an 'error' event with
    // no listener — the process-guards then exit the whole app. Fail the turn
    // and retire the child instead; its stdin can never carry another turn.
    child.stdin.on("error", (err) => {
      if (handle !== this.current) return;
      void this.terminateChild(handle);
      this.failActiveTurn(new Error(`${this.options.label}: stdin ${err.message}`));
    });

    child.on("exit", (code, signal) => {
      handle.exited = true;
      if (handle !== this.current) return; // A retired child; nobody is listening.
      framer.flush();
      this.clearStallWatchdog();
      this.current = null;
      // A persistent session's child should outlive every turn. If it exits
      // while a turn is in flight the turn can never complete — fail it with
      // whatever the CLI said on stderr, which is where auth/config errors go.
      if (this.activeTurn) {
        const detail = this.stderrTail.trim().split(/\r?\n/).slice(-4).join("\n");
        const why = signal ? `killed by ${signal}` : `exited with code ${code ?? "unknown"}`;
        this.failActiveTurn(new Error(`${this.options.label} ${why}${detail ? `:\n${detail}` : ""}`));
      }
    });
  }

  private dispatch(handle: ChildHandle, value: unknown): void {
    // Output from a child this session has retired is unattributable — drop it.
    if (handle !== this.current) return;
    if (handle.draining) {
      // The turn that produced this was already rejected. Consume until its
      // terminal stop so the tail is never credited to the next turn.
      handle.draining.push(value);
      if (handle.draining.state.finished) handle.draining = null;
      return;
    }
    const turn = this.activeTurn;
    if (!turn) return; // Between turns: init/status chatter, nothing to render.
    for (const event of turn.decoder.push(value)) {
      turn.controller.emit(event);
    }
    if (turn.decoder.state.finished) this.settleActiveTurn();
  }

  private settleActiveTurn(): void {
    const turn = this.activeTurn;
    if (!turn) return;
    this.activeTurn = null;
    this.clearStallWatchdog();
    turn.cleanup?.();
    const { usage, stopReason, errorMessage } = turn.decoder.state;
    turn.controller.emit({ type: "done", stopReason: errorMessage ? "error" : (stopReason ?? "end_turn") });
    turn.resolve({ usage });
  }

  /**
   * Reject the in-flight turn. If the child that was serving it is still
   * running, it enters the draining state: its remaining output for this turn
   * is consumed silently and it is not handed another turn until the boundary
   * has passed (or it is recreated by the next `sendTurn`).
   */
  private failActiveTurn(err: Error): void {
    const turn = this.activeTurn;
    if (!turn) return;
    this.activeTurn = null;
    this.clearStallWatchdog();
    turn.cleanup?.();
    if (this.current && !this.current.exited) this.current.draining = turn.decoder;
    try {
      turn.controller.emit({ type: "error", message: err.message });
    } catch {
      // Controller already torn down.
    }
    turn.reject(err);
  }

  private armStallWatchdog(): void {
    const stallMs = this.options.stallMs ?? DEFAULT_STALL_MS;
    if (stallMs <= 0) return;
    this.clearStallWatchdog();
    this.stallTimer = setTimeout(() => {
      this.failActiveTurn(new Error(`${this.options.label} produced no output for ${Math.round(stallMs / 1000)}s.`));
    }, stallMs);
    this.stallTimer.unref?.();
  }

  private clearStallWatchdog(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = null;
  }

  /**
   * Stop owning `handle` and terminate it: stdin EOF + SIGTERM, SIGKILL after
   * the grace period, and a final bounded wait so a caller awaiting disposal
   * is never held hostage by a process that will not die. Never rejects.
   */
  private terminateChild(handle: ChildHandle): Promise<void> {
    if (this.current === handle) this.current = null;
    if (handle.exited) return Promise.resolve();
    const grace = this.options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS;
    const { child } = handle;
    return new Promise<void>((resolve) => {
      let termTimer: NodeJS.Timeout | null = null;
      let killTimer: NodeJS.Timeout | null = null;
      const finish = () => {
        if (termTimer) clearTimeout(termTimer);
        if (killTimer) clearTimeout(killTimer);
        termTimer = null;
        killTimer = null;
        resolve();
      };
      child.once("exit", finish);
      try {
        child.stdin.end();
      } catch {
        // Best-effort.
      }
      try {
        child.kill("SIGTERM");
      } catch {
        // Best-effort.
      }
      termTimer = setTimeout(() => {
        termTimer = null;
        if (handle.exited) return;
        try {
          child.kill("SIGKILL");
        } catch {
          // Best-effort.
        }
        killTimer = setTimeout(finish, grace);
        killTimer.unref?.();
      }, grace);
      termTimer.unref?.();
    });
  }

  /**
   * Send one user turn. Resolves when the CLI emits its terminal `result`.
   *
   * `content` is the Anthropic content-block array so callers can attach
   * images or multiple text blocks; most send a single text block.
   */
  sendTurn(
    content: Array<Record<string, unknown>>,
    controller: ProviderStreamController,
    abortSignal?: AbortSignal,
  ): Promise<{ usage?: ProviderUsageSnapshot }> {
    if (this.disconnected) {
      return Promise.reject(new Error(`${this.options.label} session has been disconnected.`));
    }
    if (this.activeTurn) {
      return Promise.reject(new Error(`${this.options.label} session already has a turn in flight.`));
    }
    if (abortSignal?.aborted) {
      // Nothing was written, so there is nothing to interrupt or drain.
      return Promise.reject(new Error(`${this.options.label} turn aborted.`));
    }
    if (this.current?.draining) {
      // The previous turn's tail has not reached its boundary, so this child
      // cannot tell us where the new turn starts. Replace it rather than guess.
      void this.terminateChild(this.current);
    }
    if (!this.current) {
      this.warm();
      if (this.startError) return Promise.reject(this.startError);
      if (!this.current) {
        return Promise.reject(new Error(`${this.options.label}: failed to start (${this.options.bin}).`));
      }
    }

    const handle = this.current;
    return new Promise<{ usage?: ProviderUsageSnapshot }>((resolve, reject) => {
      const decoder = new AnthropicStreamJsonDecoder({
        suppressToolNames: this.options.suppressToolNames,
        onSessionId: this.options.onSessionId,
        // A session-holding CLI emits `result` once, at EOF — never per turn.
        // The turn ends at the assistant message's terminal stop_reason.
        turnEndsOn: "assistant-stop",
      });

      const onAbort = () => this.interruptActiveTurn(handle);
      const cleanup = () => {
        abortSignal?.removeEventListener("abort", onAbort);
      };

      this.activeTurn = { decoder, controller, resolve, reject, cleanup };
      abortSignal?.addEventListener("abort", onAbort, { once: true });

      controller.emit({ type: "status", status: "streaming" });
      this.armStallWatchdog();

      const line = `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`;
      try {
        handle.child.stdin.write(line);
      } catch (err) {
        this.failActiveTurn(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Reject the active turn now and ask the child to stop it. SIGINT is the
   * cooperative stop; a CLI that honours it ends the turn with a terminal stop,
   * which drains the child and makes it reusable. One that ignores it stays in
   * draining and is replaced on the next `sendTurn`.
   */
  private interruptActiveTurn(handle: ChildHandle): void {
    if (!this.activeTurn) return;
    this.failActiveTurn(new Error(`${this.options.label} turn aborted.`));
    if (handle !== this.current || handle.exited) return;
    try {
      handle.child.kill("SIGINT");
    } catch {
      // Best-effort.
    }
  }

  abortTurn(): void {
    if (!this.activeTurn || !this.current) return;
    this.interruptActiveTurn(this.current);
  }

  /** Close the session. Resolves once the child has exited (or the bounded
   *  SIGTERM→SIGKILL escalation has given up on it). */
  disconnect(): Promise<void> {
    if (this.disconnectPromise) return this.disconnectPromise;
    this.disconnected = true;
    this.clearStallWatchdog();
    this.failActiveTurn(new Error(`${this.options.label} session closed.`));
    const handle = this.current;
    this.current = null;
    this.disconnectPromise = handle ? this.terminateChild(handle) : Promise.resolve();
    return this.disconnectPromise;
  }
}

/** Convenience: the single-text-block content array most turns send. */
export function textContent(text: string): Array<Record<string, unknown>> {
  return [{ type: "text", text }];
}

export type { ProviderStreamEvent };
