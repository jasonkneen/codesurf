import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let interactiveUiActive = false;

export function setInteractiveUiActive(active: boolean): void {
  interactiveUiActive = active;
}

export const CRASH_LOG_SIZE_LIMIT = 512 * 1024;

export function shouldRotateCrashLog(size: number, limit: number = CRASH_LOG_SIZE_LIMIT): boolean {
  return size > limit;
}

/** Append a crash/rejection record to ~/.codesurf/crash.log so it survives the
 *  TUI alt-screen (OpenTUI patches console, so console.error output is lost
 *  when the process dies mid-render). Best-effort — never throws. */
export function writeCrashLog(kind: string, reason: unknown): string | undefined {
  try {
    const dir = join(homedir(), ".codesurf");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "crash.log");
    try {
      if (shouldRotateCrashLog(statSync(file).size)) {
        renameSync(file, `${file}.old`);
      }
    } catch {
      /* no existing file to rotate */
    }
    const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    appendFileSync(file, `\n=== ${kind} ${new Date().toISOString()} ===\n${detail}\n`);
    return file;
  } catch {
    return undefined;
  }
}

/** Interceptors get first crack at unhandled rejections. Returning true marks
 *  the rejection as handled: it's logged to crash.log but NOT echoed via
 *  console.error (which would pop OpenTUI's Console overlay over the TUI) and
 *  never exits the process. Used by the Telegram bridge to absorb grammy's
 *  fire-and-forget getUpdates 409s (another instance polling the same bot). */
type RejectionInterceptor = (reason: unknown) => boolean;
const rejectionInterceptors: RejectionInterceptor[] = [];

export function registerRejectionInterceptor(fn: RejectionInterceptor): void {
  if (!rejectionInterceptors.includes(fn)) rejectionInterceptors.push(fn);
}

export interface UnhandledRejectionDeps {
  interactive: boolean;
  exit: (code: number) => void;
  log: (message: string, reason: unknown) => void;
  intercepted?: boolean;
}

export function handleUnhandledRejection(reason: unknown, deps: UnhandledRejectionDeps): void {
  if (deps.intercepted) return;
  // Interactive TUI: never console.error (OpenTUI pops its Console overlay
  // over the app) and never exit — the rejection is already in crash.log.
  if (deps.interactive) return;
  deps.log("Unhandled rejection:", reason);
  deps.exit(1);
}

export function runRejectionInterceptors(reason: unknown): boolean {
  for (const fn of rejectionInterceptors) {
    try {
      if (fn(reason)) return true;
    } catch {
      /* interceptors must never throw */
    }
  }
  return false;
}

/**
 * Stop Node warnings from painting over the TUI.
 *
 * `process.emitWarning` reaches the screen through a listener Node installs
 * itself, which writes straight to stderr — behind OpenTUI, which owns the
 * frame and repaints by cell. The bytes land on rows OpenTUI believes it has
 * already drawn, so its model of the screen and the screen disagree until the
 * next full repaint, and the user sees half-overwritten lines.
 *
 * Adding a listener does NOT suppress that default (verified: the warning
 * still prints). Only removing it does, so this replaces it rather than
 * joining it. Warnings are not lost — they go to crash.log, the same channel
 * unhandled rejections already use, and still print when no TUI is running.
 */
let warningGuard: ((warning: Error & { code?: string }) => void) | null = null;

export function installWarningGuard(): void {
  // Only the runtime's own printer is removed (Node and Bun both name it
  // `onWarning`); listeners other code registered keep working. A previous
  // guard is replaced so reinstalling never double-logs.
  for (const listener of process.listeners("warning")) {
    if (listener === warningGuard || listener.name === "onWarning") {
      process.removeListener("warning", listener);
    }
  }
  warningGuard = (warning) => {
    writeCrashLog(warning.code ? `warning [${warning.code}]` : "warning", warning);
    if (!interactiveUiActive) {
      console.error(`Warning: ${warning.message}`);
    }
  };
  process.on("warning", warningGuard);
}

export function installProcessGuards(): void {
  installWarningGuard();

  process.on("uncaughtException", (err) => {
    const file = writeCrashLog("uncaughtException", err);
    console.error("Fatal:", err.message, file ? `(stack written to ${file})` : "");
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    const intercepted = runRejectionInterceptors(reason);
    writeCrashLog(intercepted ? "unhandledRejection (intercepted)" : "unhandledRejection", reason);
    handleUnhandledRejection(reason, {
      interactive: interactiveUiActive,
      exit: (code) => process.exit(code),
      log: (message, r) => console.error(message, r),
      intercepted,
    });
  });
}
