import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { mkdirSync, realpathSync } from "fs";
import { createRequire } from "module";
import { tmpdir } from "os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "path";
import type { ComputerToolMetadata, ToolResult } from "../types/index";

const COMPUTER_ARTIFACT_DIR = ".grok/computer";
const DEFAULT_SCREENSHOT_NAME = "computer-shot";

export interface ComputerScreenshotInput {
  output_path?: string;
  app?: string;
  window_id?: string;
}

export interface ComputerSnapshotInput {
  app?: string;
  window_id?: string;
  interactive_only?: boolean;
  include_bounds?: boolean;
  compact?: boolean;
  max_depth?: number;
  surface?: "window" | "focused" | "menu" | "menubar" | "sheet" | "popover" | "alert";
}

export interface ComputerClickInput {
  ref?: string;
  x?: number;
  y?: number;
  button?: "left" | "right" | "middle";
  count?: number;
}

export interface ComputerMouseMoveInput {
  ref?: string;
  x?: number;
  y?: number;
  duration_ms?: number;
}

export interface ComputerTypeInput {
  ref: string;
  text: string;
}

export interface ComputerPressInput {
  key: string;
  app?: string;
}

export interface ComputerScrollInput {
  ref: string;
  direction: "up" | "down" | "left" | "right";
  amount?: number;
}

export interface ComputerLaunchInput {
  app: string;
  timeout_ms?: number;
}

export interface ComputerListWindowsInput {
  app?: string;
}

export interface ComputerFocusWindowInput {
  app?: string;
  title?: string;
  window_id?: string;
}

export interface ComputerWaitInput {
  milliseconds?: number;
  element?: string;
  window?: string;
  text?: string;
  timeout_ms?: number;
  app?: string;
  menu?: boolean;
  menu_closed?: boolean;
}

export interface ComputerGetInput {
  ref: string;
  property?: "text" | "value" | "title" | "bounds" | "role" | "states";
}

interface AgentDesktopInvoker {
  command: string;
  prefixArgs: string[];
}

export interface AgentDesktopRunResult {
  success: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

export type AgentDesktopRunner = (
  args: string[],
  cwd: string,
  abortSignal?: AbortSignal,
) => Promise<AgentDesktopRunResult>;

interface AgentDesktopJson {
  version?: string;
  ok?: boolean;
  command?: string;
  data?: unknown;
  error?: {
    code?: string;
    message?: string;
    suggestion?: string;
  };
}

let cachedInvoker: AgentDesktopInvoker | null = null;

const AGENT_DESKTOP_ENV_ALLOWLIST = [
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "TMP",
  "TMPDIR",
  "TEMP",
  "USER",
  "__CF_USER_TEXT_ENCODING",
] as const;

export async function computerScreenshot(
  input: ComputerScreenshotInput,
  cwd: string,
  abortSignal?: AbortSignal,
  runner: AgentDesktopRunner = runAgentDesktop,
): Promise<ToolResult> {
  if (abortSignal?.aborted) return cancelledResult("screenshot");
  let outputPath: string;
  try {
    outputPath = buildScreenshotPath(cwd, input.output_path);
  } catch (error) {
    return failureResult("screenshot", {
      success: false,
      stdout: "",
      stderr: "",
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const args = ["screenshot", outputPath];
  if (input.app) args.push("--app", input.app);
  if (input.window_id) args.push("--window-id", input.window_id);

  const result = await runner(args, cwd, abortSignal);
  const parsed = parseAgentDesktopJson(result.stdout);
  if (!result.success || parsed?.ok === false) {
    return failureResult("screenshot", result, parsed);
  }

  const screenshotPath = outputPath;
  const lines = [`Captured desktop screenshot at ${screenshotPath}.`];
  if (input.app) lines.push(`app: ${input.app}`);
  if (input.window_id) lines.push(`windowId: ${input.window_id}`);

  return {
    success: true,
    output: lines.join("\n"),
    media: [{ kind: "image", path: screenshotPath, mediaType: "image/png" }],
    computer: {
      action: "screenshot",
      path: screenshotPath,
      app: input.app,
      windowId: input.window_id,
      hint: "Use computer_snapshot to inspect accessibility refs before clicking or typing.",
    },
  };
}

export async function computerSnapshot(
  input: ComputerSnapshotInput,
  cwd: string,
  abortSignal?: AbortSignal,
  runner: AgentDesktopRunner = runAgentDesktop,
): Promise<ToolResult> {
  if (abortSignal?.aborted) return cancelledResult("snapshot");
  const args = ["snapshot"];
  if (input.app) args.push("--app", input.app);
  if (input.window_id) args.push("--window-id", input.window_id);
  if (input.max_depth !== undefined) args.push("--max-depth", String(input.max_depth));
  if (input.include_bounds) args.push("--include-bounds");
  if (input.interactive_only !== false) args.push("--interactive-only");
  if (input.compact) args.push("--compact");
  if (input.surface) args.push("--surface", input.surface);

  const result = await runner(args, cwd, abortSignal);
  const parsed = parseAgentDesktopJson(result.stdout);
  if (!result.success || parsed?.ok === false) {
    return failureResult("snapshot", result, parsed);
  }

  const refs = extractRefs(parsed?.data);
  const lines = [
    `Captured desktop snapshot${input.app ? ` for ${input.app}` : ""}.`,
    "Refs remain valid until the next snapshot.",
    refs.length > 0 ? `Refs: ${refs.join(", ")}` : "No refs were returned.",
    parsed ? JSON.stringify(parsed, null, 2) : result.stdout.trim(),
  ];

  return successActionResult(lines.join("\n\n"), {
    action: "snapshot",
    app: input.app,
    windowId: input.window_id,
  });
}

export async function computerClick(
  input: ComputerClickInput,
  cwd: string,
  abortSignal?: AbortSignal,
  runner: AgentDesktopRunner = runAgentDesktop,
): Promise<ToolResult> {
  if (abortSignal?.aborted) return cancelledResult("click");
  if (input.ref && input.button && input.button !== "left") {
    return {
      success: false,
      output: `computer_click with \`ref\` supports only the left button. Use coordinates for ${input.button} clicks.`,
    };
  }
  if (input.ref && typeof input.count === "number" && (input.count < 1 || input.count > 3)) {
    return {
      success: false,
      output: "computer_click with `ref` supports only single, double, or triple clicks.",
    };
  }

  const args = buildClickArgs(input);
  if (!args) {
    return { success: false, output: "computer_click requires either `ref` or both `x` and `y`." };
  }

  const result = await runner(args, cwd, abortSignal);
  const parsed = parseAgentDesktopJson(result.stdout);
  if (!result.success || parsed?.ok === false) {
    return failureResult("click", result, parsed);
  }

  if (input.ref) {
    return successActionResult(`Clicked ${input.ref}.`, { action: "click", ref: input.ref });
  }
  return successActionResult(`Clicked at ${input.x},${input.y}.`, { action: "click" });
}

export async function computerMouseMove(
  input: ComputerMouseMoveInput,
  cwd: string,
  abortSignal?: AbortSignal,
  runner: AgentDesktopRunner = runAgentDesktop,
): Promise<ToolResult> {
  if (abortSignal?.aborted) return cancelledResult("mouse move");
  const args = ["hover"];
  if (input.ref) {
    args.push(input.ref);
  } else if (typeof input.x === "number" && typeof input.y === "number") {
    args.push("--xy", `${input.x},${input.y}`);
  } else {
    return { success: false, output: "computer_mouse_move requires either `ref` or both `x` and `y`." };
  }
  if (typeof input.duration_ms === "number") {
    args.push("--duration", String(input.duration_ms));
  }

  const result = await runner(args, cwd, abortSignal);
  const parsed = parseAgentDesktopJson(result.stdout);
  if (!result.success || parsed?.ok === false) {
    return failureResult("mouse move", result, parsed);
  }

  if (input.ref) {
    return successActionResult(`Hovered ${input.ref}.`, { action: "mouse_move", ref: input.ref });
  }
  return successActionResult(`Moved the mouse to ${input.x},${input.y}.`, { action: "mouse_move" });
}

export async function computerType(
  input: ComputerTypeInput,
  cwd: string,
  abortSignal?: AbortSignal,
  runner: AgentDesktopRunner = runAgentDesktop,
): Promise<ToolResult> {
  if (abortSignal?.aborted) return cancelledResult("type");
  const args = ["type", input.ref, input.text];
  const result = await runner(args, cwd, abortSignal);
  const parsed = parseAgentDesktopJson(result.stdout);
  if (!result.success || parsed?.ok === false) {
    return failureResult("type", result, parsed);
  }

  return successActionResult(`Typed into ${input.ref}.`, { action: "type", ref: input.ref });
}

export async function computerPress(
  input: ComputerPressInput,
  cwd: string,
  abortSignal?: AbortSignal,
  runner: AgentDesktopRunner = runAgentDesktop,
): Promise<ToolResult> {
  if (abortSignal?.aborted) return cancelledResult("press");
  const args = ["press", input.key];
  if (input.app) args.push("--app", input.app);
  const result = await runner(args, cwd, abortSignal);
  const parsed = parseAgentDesktopJson(result.stdout);
  if (!result.success || parsed?.ok === false) {
    return failureResult("press", result, parsed);
  }

  return successActionResult(`Pressed ${input.key}.`, { action: "press", app: input.app });
}

export async function computerScroll(
  input: ComputerScrollInput,
  cwd: string,
  abortSignal?: AbortSignal,
  runner: AgentDesktopRunner = runAgentDesktop,
): Promise<ToolResult> {
  if (abortSignal?.aborted) return cancelledResult("scroll");
  const args = ["scroll", input.ref, "--direction", input.direction];
  if (typeof input.amount === "number") args.push("--amount", String(input.amount));

  const result = await runner(args, cwd, abortSignal);
  const parsed = parseAgentDesktopJson(result.stdout);
  if (!result.success || parsed?.ok === false) {
    return failureResult("scroll", result, parsed);
  }

  return successActionResult(`Scrolled ${input.ref} ${input.direction}.`, {
    action: "scroll",
    ref: input.ref,
  });
}

export async function computerLaunch(
  input: ComputerLaunchInput,
  cwd: string,
  abortSignal?: AbortSignal,
  runner: AgentDesktopRunner = runAgentDesktop,
): Promise<ToolResult> {
  if (abortSignal?.aborted) return cancelledResult("launch");
  const args = ["launch", input.app];
  if (typeof input.timeout_ms === "number") args.push("--timeout", String(input.timeout_ms));

  const result = await runner(args, cwd, abortSignal);
  const parsed = parseAgentDesktopJson(result.stdout);
  if (!result.success || parsed?.ok === false) {
    return failureResult("launch", result, parsed);
  }

  return successActionResult(`Launched ${input.app}.`, { action: "launch", app: input.app });
}

export async function computerListWindows(
  input: ComputerListWindowsInput,
  cwd: string,
  abortSignal?: AbortSignal,
  runner: AgentDesktopRunner = runAgentDesktop,
): Promise<ToolResult> {
  if (abortSignal?.aborted) return cancelledResult("list windows");
  const args = ["list-windows"];
  if (input.app) args.push("--app", input.app);

  const result = await runner(args, cwd, abortSignal);
  const parsed = parseAgentDesktopJson(result.stdout);
  if (!result.success || parsed?.ok === false) {
    return failureResult("list windows", result, parsed);
  }

  const output = parsed ? JSON.stringify(parsed, null, 2) : result.stdout.trim();
  return successActionResult(output, { action: "list_windows", app: input.app });
}

export async function computerFocusWindow(
  input: ComputerFocusWindowInput,
  cwd: string,
  abortSignal?: AbortSignal,
  runner: AgentDesktopRunner = runAgentDesktop,
): Promise<ToolResult> {
  if (abortSignal?.aborted) return cancelledResult("focus window");
  const args = ["focus-window"];
  if (input.window_id) {
    args.push("--window-id", input.window_id);
  } else if (input.app) {
    args.push("--app", input.app);
  } else if (input.title) {
    args.push("--title", input.title);
  } else {
    return { success: false, output: "computer_focus_window requires `window_id`, `app`, or `title`." };
  }

  const result = await runner(args, cwd, abortSignal);
  const parsed = parseAgentDesktopJson(result.stdout);
  if (!result.success || parsed?.ok === false) {
    return failureResult("focus window", result, parsed);
  }

  return successActionResult("Focused window.", {
    action: "focus_window",
    app: input.app,
    windowId: input.window_id,
  });
}

export async function computerWait(
  input: ComputerWaitInput,
  cwd: string,
  abortSignal?: AbortSignal,
  runner: AgentDesktopRunner = runAgentDesktop,
): Promise<ToolResult> {
  if (abortSignal?.aborted) return cancelledResult("wait");
  const args = ["wait"];
  if (input.element) args.push("--element", input.element);
  if (input.window) args.push("--window", input.window);
  if (input.text) args.push("--text", input.text);
  if (typeof input.timeout_ms === "number") args.push("--timeout", String(input.timeout_ms));
  if (input.menu) args.push("--menu");
  if (input.menu_closed) args.push("--menu-closed");
  if (input.app) args.push("--app", input.app);
  if (typeof input.milliseconds === "number") args.push(String(input.milliseconds));

  const result = await runner(args, cwd, abortSignal);
  const parsed = parseAgentDesktopJson(result.stdout);
  if (!result.success || parsed?.ok === false) {
    return failureResult("wait", result, parsed);
  }

  return successActionResult("Wait completed.", { action: "wait", app: input.app, ref: input.element });
}

export async function computerGet(
  input: ComputerGetInput,
  cwd: string,
  abortSignal?: AbortSignal,
  runner: AgentDesktopRunner = runAgentDesktop,
): Promise<ToolResult> {
  if (abortSignal?.aborted) return cancelledResult("get");
  const args = ["get", input.ref];
  if (input.property) args.push("--property", input.property);

  const result = await runner(args, cwd, abortSignal);
  const parsed = parseAgentDesktopJson(result.stdout);
  if (!result.success || parsed?.ok === false) {
    return failureResult("get", result, parsed);
  }

  const output = parsed ? JSON.stringify(parsed, null, 2) : result.stdout.trim();
  return successActionResult(output, {
    action: "get",
    ref: input.ref,
  });
}

export function buildScreenshotPath(cwd: string, outputPath?: string): string {
  const resolved = outputPath
    ? resolveOutputPath(cwd, outputPath)
    : resolve(cwd, COMPUTER_ARTIFACT_DIR, `${DEFAULT_SCREENSHOT_NAME}-${Date.now()}-${randomUUID().slice(0, 8)}.png`);
  mkdirSync(dirname(resolved), { recursive: true });
  return resolved;
}

function buildClickArgs(input: ComputerClickInput): string[] | null {
  if (input.ref) {
    if (input.button && input.button !== "left") {
      return null;
    }
    if ((input.count ?? 1) === 1) return ["click", input.ref];
    if (input.count === 2) return ["double-click", input.ref];
    if (input.count === 3) return ["triple-click", input.ref];
    return null;
  }

  if (typeof input.x === "number" && typeof input.y === "number") {
    const args = ["mouse-click", "--xy", `${input.x},${input.y}`];
    if (input.button) args.push("--button", input.button);
    if (typeof input.count === "number") args.push("--count", String(input.count));
    return args;
  }

  return null;
}

/**
 * Screenshots may only be written inside the workspace or the temp dir: the
 * path is model-supplied and agent-desktop overwrites whatever is there.
 * Checked before any directory is created.
 */
function resolveOutputPath(cwd: string, outputPath: string): string {
  const resolved = isAbsolute(outputPath) ? outputPath : resolve(cwd, outputPath);
  const target = realpathLenient(resolved);
  const allowedRoots = [cwd, tmpdir()].map(realpathLenient);
  if (!allowedRoots.some((root) => isWithin(target, root))) {
    throw new Error(`Screenshot output_path must be inside the workspace or ${tmpdir()}: ${outputPath}`);
  }
  mkdirSync(dirname(resolved), { recursive: true });
  return resolved;
}

/** Resolve symlinks on the longest existing prefix of `p`, keeping the not-yet-created tail. */
function realpathLenient(p: string): string {
  let current = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(current), ...tail);
    } catch {
      const parent = dirname(current);
      if (parent === current) return join(current, ...tail);
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

function isWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function extractRefs(data: unknown): string[] {
  if (!data || typeof data !== "object") return [];
  const refs = (data as { refs?: unknown }).refs;
  if (!Array.isArray(refs)) return [];
  return refs.filter((item): item is string => typeof item === "string");
}

function successActionResult(output: string, computer: ComputerToolMetadata): ToolResult {
  return {
    success: true,
    output,
    computer,
  };
}

const CANCELLED_RESULT: AgentDesktopRunResult = { success: false, stdout: "", stderr: "", error: "[Cancelled]" };

function cancelledResult(action: string): ToolResult {
  return failureResult(action, CANCELLED_RESULT);
}

function failureResult(action: string, result: AgentDesktopRunResult, parsed?: AgentDesktopJson | null): ToolResult {
  return {
    success: false,
    output: `Computer ${action} failed: ${normalizeFailureDetail(result, parsed)}`,
  };
}

function normalizeFailureDetail(result: AgentDesktopRunResult, parsed?: AgentDesktopJson | null): string {
  const structuredMessage = parsed?.error?.message?.trim();
  const structuredSuggestion = parsed?.error?.suggestion?.trim();
  const detail = [structuredMessage, structuredSuggestion, result.error, result.stderr, result.stdout]
    .filter(Boolean)
    .join("\n")
    .trim();

  if (!detail) {
    return "Unknown agent-desktop error.";
  }

  const lower = detail.toLowerCase();
  if (lower.includes("accessibility")) {
    return `${detail}\nEnable Accessibility permission for your terminal app in System Settings > Privacy & Security > Accessibility and try again.`;
  }
  if (lower.includes("native binary not found")) {
    return `${detail}\nIf Bun blocked the install hook, run \`node ./node_modules/agent-desktop/scripts/postinstall.js\` from the repo root.`;
  }
  if (lower.includes("supports macos only") || lower.includes("macos only")) {
    return `${detail}\nagent-desktop currently supports macOS only.`;
  }
  return detail;
}

function parseAgentDesktopJson(stdout: string): AgentDesktopJson | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as AgentDesktopJson;
  } catch {
    return null;
  }
}

/** Minimal child handle the runner needs; satisfied by Node's ChildProcess. */
export interface AgentDesktopChildProcess {
  /** Present for real children; the process-group leader id when spawned detached. */
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit" | "error", listener: (...args: unknown[]) => void): unknown;
}

/** execFile seam so tests can substitute a fake child without touching the desktop. */
export type AgentDesktopExecFile = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; maxBuffer: number; detached?: boolean },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => AgentDesktopChildProcess;

export interface AgentDesktopRunnerOptions {
  execFile?: AgentDesktopExecFile;
  /** Time allowed for the child to exit after SIGTERM before SIGKILL is sent. */
  terminateGraceMs?: number;
  /** Time waited for exit after SIGKILL before cancellation is reported anyway. */
  killGraceMs?: number;
  /** Upper bound for one agent-desktop call; a call's own `--timeout` extends it. */
  timeoutMs?: number;
}

const DEFAULT_TERMINATE_GRACE_MS = 2000;
const DEFAULT_KILL_GRACE_MS = 1000;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
/** Headroom over a call's own `--timeout` (wait/launch) before we give up on the process. */
const CALL_TIMEOUT_SLACK_MS = 30_000;

function resolveCallTimeoutMs(args: string[], baseMs: number): number {
  const index = args.indexOf("--timeout");
  const own = index >= 0 ? Number(args[index + 1]) : Number.NaN;
  return Number.isFinite(own) && own > 0 ? Math.max(baseMs, own + CALL_TIMEOUT_SLACK_MS) : baseMs;
}

export function createAgentDesktopRunner(options: AgentDesktopRunnerOptions = {}): AgentDesktopRunner {
  return (args, cwd, abortSignal) => runAgentDesktopProcess(args, cwd, abortSignal, options);
}

async function runAgentDesktop(args: string[], cwd: string, abortSignal?: AbortSignal): Promise<AgentDesktopRunResult> {
  return runAgentDesktopProcess(args, cwd, abortSignal, {});
}

async function runAgentDesktopProcess(
  args: string[],
  cwd: string,
  abortSignal: AbortSignal | undefined,
  options: AgentDesktopRunnerOptions,
): Promise<AgentDesktopRunResult> {
  if (abortSignal?.aborted) {
    return { ...CANCELLED_RESULT };
  }

  const invoker = resolveAgentDesktopInvoker();
  const exec = options.execFile ?? execFile;
  const terminateGraceMs = options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const timeoutMs = resolveCallTimeoutMs(args, options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);
  try {
    return await new Promise<AgentDesktopRunResult>((resolveResult) => {
      let settled = false;
      let child: AgentDesktopChildProcess | undefined;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

      const stopWith = (result: AgentDesktopRunResult) => {
        if (settled) return;
        settled = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        abortSignal?.removeEventListener("abort", onAbort);
        const teardown = child ? terminateChild(child, terminateGraceMs, killGraceMs) : Promise.resolve();
        void teardown.then(() => resolveResult(result));
      };

      const onAbort = () => stopWith({ ...CANCELLED_RESULT });

      // Listener first, then spawn, with no await in between: an abort can
      // never land in a gap where the child exists but nothing will kill it.
      abortSignal?.addEventListener("abort", onAbort, { once: true });

      child = exec(
        invoker.command,
        [...invoker.prefixArgs, ...args],
        {
          cwd,
          env: buildAgentDesktopEnv(),
          maxBuffer: 10 * 1024 * 1024,
          // Own process group on POSIX so cancellation and timeout reach the
          // native binary the JS launcher spawns, not just the launcher.
          detached: process.platform !== "win32",
        },
        (error, stdout, stderr) => {
          if (settled) return;
          settled = true;
          if (timeoutTimer) clearTimeout(timeoutTimer);
          abortSignal?.removeEventListener("abort", onAbort);
          if (error) {
            resolveResult({
              success: false,
              stdout: stdout ?? "",
              stderr: stderr ?? "",
              error: error.message,
            });
            return;
          }
          resolveResult({
            success: true,
            stdout: stdout ?? "",
            stderr: stderr ?? "",
          });
        },
      );
      if (!settled) {
        timeoutTimer = setTimeout(
          () =>
            stopWith({ success: false, stdout: "", stderr: "", error: `agent-desktop timed out after ${timeoutMs}ms` }),
          timeoutMs,
        );
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      stdout: "",
      stderr: "",
      error: message,
    };
  }
}

/** SIGTERM, bounded wait, SIGKILL, bounded wait. Resolves once the child is gone or both graces elapsed. */
async function terminateChild(
  child: AgentDesktopChildProcess,
  terminateGraceMs: number,
  killGraceMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  const exited = new Promise<void>((resolveExit) => {
    child.once("exit", () => resolveExit());
    child.once("error", () => resolveExit());
  });

  safeKill(child, "SIGTERM");
  if (await settledWithin(exited, terminateGraceMs)) return;
  safeKill(child, "SIGKILL");
  await settledWithin(exited, killGraceMs);
}

function safeKill(child: AgentDesktopChildProcess, signal: NodeJS.Signals): void {
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // ESRCH: group already gone, or the child is not a group leader; fall through.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // ignore: the process may already be gone
  }
}

function settledWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolveWithin) => {
    const timer = setTimeout(() => resolveWithin(false), ms);
    void promise.then(() => {
      clearTimeout(timer);
      resolveWithin(true);
    });
  });
}

export function buildAgentDesktopEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { FORCE_COLOR: "0" };
  for (const key of AGENT_DESKTOP_ENV_ALLOWLIST) {
    const value = source[key];
    if (value) {
      env[key] = value;
    }
  }
  return env;
}

function resolveAgentDesktopInvoker(): AgentDesktopInvoker {
  if (cachedInvoker) {
    return cachedInvoker;
  }

  try {
    const require = createRequire(import.meta.url);
    const packagePath = require.resolve("agent-desktop/package.json");
    const packageDir = dirname(packagePath);
    cachedInvoker = {
      command: process.execPath,
      prefixArgs: [join(packageDir, "bin", "agent-desktop.js")],
    };
  } catch {
    cachedInvoker = {
      command: "agent-desktop",
      prefixArgs: [],
    };
  }

  return cachedInvoker;
}
