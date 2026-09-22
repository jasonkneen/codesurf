// Terminal session store. Ported from termcast's services/terminal-manager.ts
// with a two-strategy spawn backend:
//
//   1. PREFERRED: spawn `python3 pty_bridge.py` (the same bridge termcast
//      uses). The bridge runs `pty.fork()` to give the target command a real
//      PTY, then emits JSON-line events over its stdout. This restores all
//      TTY semantics — `isatty(1)` returns true, curses apps render, stdin
//      routing works, SIGWINCH forwards through resize. Requires python3 on
//      PATH (macOS ships it; most Linux distros too).
//
//   2. FALLBACK: `Bun.spawn` with piped stdio. Used when python3 isn't
//      available. Non-interactive — commands that demand a TTY (like
//      `claude`, `vim`, `htop`) will fail loudly, but scripted pipelines
//      still work. Colors are forced via FORCE_COLOR / CLICOLOR_FORCE.
//
// In both cases raw bytes go through @xterm/headless so ANSI escapes, cursor
// moves, and scrollback render correctly; the UI only sees already-normalized
// viewport lines.

import { Terminal } from "@xterm/headless";
import * as fs from "fs";
import * as path from "path";
import { useSyncExternalStore } from "react";
import { fileURLToPath } from "url";

type Subprocess = ReturnType<typeof Bun.spawn>;

// ── PTY bridge resolution ────────────────────────────────────────────────────

function resolveBridgePath(): string | null {
  const candidates: string[] = [];
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    candidates.push(path.join(here, "pty_bridge.py"));
  } catch {
    // import.meta.url may be unavailable in bundled single-file mode.
  }
  candidates.push(
    path.join(process.cwd(), "src/ui/terminal/pty_bridge.py"),
    path.join(process.cwd(), "dist/ui/terminal/pty_bridge.py"),
  );
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const BRIDGE_PATH = resolveBridgePath();
// Cached result of `python3 --version` probe. Lazily populated on first
// spawn attempt; avoids a startup-time fork for users who never open /term.
let pythonProbed = false;
let pythonAvailable = false;
function hasPython3(): boolean {
  if (pythonProbed) return pythonAvailable;
  pythonProbed = true;
  try {
    const probe = Bun.spawnSync(["python3", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    pythonAvailable = probe.exitCode === 0;
  } catch {
    pythonAvailable = false;
  }
  return pythonAvailable;
}

interface BridgeEvent {
  type: "data" | "exit" | "error";
  data?: string;
  exitCode?: number;
  signal?: number | null;
  message?: string;
}

export type TerminalSessionStatus = "running" | "done" | "error" | "stopped";

export interface TerminalSessionSnapshot {
  id: string;
  command: string;
  cwd: string;
  shell: string;
  title: string;
  status: TerminalSessionStatus;
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
  cols: number;
  rows: number;
  viewportY: number;
  bufferLength: number;
  cursorX: number;
  cursorY: number;
  lines: readonly string[];
}

interface DisposableLike {
  dispose(): void;
}

interface TerminalSessionRecord {
  snapshot: TerminalSessionSnapshot;
  proc: Subprocess | null;
  term: Terminal;
  listeners: DisposableLike[];
  readers: AbortController[];
  pendingExit: { exitCode?: number; signal?: number | null } | null;
  restartRequested: boolean;
  /** Which spawn strategy is driving this session. Determines whether
   *  stdin writes/resizes are forwarded as JSON-line commands (bridge)
   *  or direct pipe writes (fallback). */
  backend: "bridge" | "pipe" | null;
  /** Buffer for incoming bridge JSON-line chunks split across reads. */
  bridgeStdoutBuffer: string;
}

interface SpawnTerminalSessionOptions {
  command: string;
  cwd?: string;
  shell?: string;
  cols?: number;
  rows?: number;
  title?: string;
}

const DEFAULT_COLS = 96;
const DEFAULT_ROWS = 18;
const MAX_SCROLLBACK = 4_000;

let sessionCounter = 1;
const records = new Map<string, TerminalSessionRecord>();
const subscribers = new Set<() => void>();
let allSessionsSnapshot: readonly TerminalSessionSnapshot[] = [];

function notify(): void {
  allSessionsSnapshot = Array.from(records.values())
    .map((record) => record.snapshot)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  for (const callback of subscribers) callback();
}

function subscribe(callback: () => void): () => void {
  subscribers.add(callback);
  return () => {
    subscribers.delete(callback);
  };
}

function makeSessionId(): string {
  return `term-${sessionCounter++}`;
}

function normalizeLine(text: string): string {
  return text.split("\0").join(" ");
}

function collectViewportLines(term: Terminal): string[] {
  const buffer = term.buffer.active;
  const start = buffer.viewportY;
  const end = start + term.rows;
  const lines: string[] = [];
  for (let index = start; index < end; index += 1) {
    const line = buffer.getLine(index);
    lines.push(normalizeLine(line?.translateToString(false, 0, term.cols) ?? ""));
  }
  return lines;
}

function syncSnapshot(id: string): void {
  const record = records.get(id);
  if (!record) return;
  const buffer = record.term.buffer.active;
  record.snapshot = {
    ...record.snapshot,
    title: record.snapshot.title || record.snapshot.command,
    cols: record.term.cols,
    rows: record.term.rows,
    viewportY: buffer.viewportY,
    bufferLength: buffer.length,
    cursorX: buffer.cursorX,
    cursorY: buffer.cursorY,
    lines: collectViewportLines(record.term),
  };
  notify();
}

function updateSnapshot(id: string, updater: (snapshot: TerminalSessionSnapshot) => TerminalSessionSnapshot): void {
  const record = records.get(id);
  if (!record) return;
  record.snapshot = updater(record.snapshot);
  notify();
}

function appendStatusLine(id: string, line: string): void {
  updateSnapshot(id, (snapshot) => ({
    ...snapshot,
    lines: [...snapshot.lines, line].slice(-Math.max(snapshot.rows, 4)),
  }));
}

function disposeRecordListeners(record: TerminalSessionRecord): void {
  for (const listener of record.listeners) listener.dispose();
  record.listeners = [];
  for (const controller of record.readers) controller.abort();
  record.readers = [];
}

function disposeRecord(record: TerminalSessionRecord): void {
  disposeRecordListeners(record);
  if (record.proc) {
    try {
      record.proc.kill("SIGTERM");
    } catch {
      // Already gone — ignore.
    }
  }
  record.proc = null;
  record.term.dispose();
}

function attachRecordListeners(id: string): void {
  const record = records.get(id);
  if (!record) return;
  record.listeners.push(
    record.term.onTitleChange((title) => {
      record.snapshot = { ...record.snapshot, title };
      notify();
    }),
    record.term.onScroll(() => {
      syncSnapshot(id);
    }),
    record.term.onResize(() => {
      syncSnapshot(id);
    }),
  );
}

/**
 * Read `stream` as text until it ends or `controller` aborts. Abort CANCELS
 * the pending read rather than waiting for the next chunk: a restart used to
 * leave the old reader parked in read(), and its late chunks then landed in
 * the new session's terminal.
 */
export async function readTextUntilAborted(
  stream: ReadableStream<Uint8Array>,
  controller: AbortController,
  onText: (text: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const cancel = () => {
    reader.cancel().catch(() => {});
  };
  controller.signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      if (controller.signal.aborted) break;
      const { value, done } = await reader.read();
      if (done || controller.signal.aborted) break;
      onText(decoder.decode(value, { stream: true }));
    }
  } catch {
    // Stream closed or aborted — fall through.
  } finally {
    controller.signal.removeEventListener("abort", cancel);
    try {
      reader.releaseLock();
    } catch {
      // Already released.
    }
  }
}

async function pumpReadable(
  id: string,
  stream: ReadableStream<Uint8Array>,
  controller: AbortController,
): Promise<void> {
  await readTextUntilAborted(stream, controller, (chunk) => {
    const record = records.get(id);
    if (!record) return;
    record.term.write(chunk, () => {
      syncSnapshot(id);
    });
  });
}

/** Bridge stdout arrives as newline-delimited JSON; decode each complete
 *  line, base64-decode data chunks, feed into xterm. Incomplete lines get
 *  buffered on the record for the next read. */
function handleBridgeStdout(id: string, text: string): void {
  const record = records.get(id);
  if (!record) return;
  record.bridgeStdoutBuffer += text;
  while (true) {
    const newlineIndex = record.bridgeStdoutBuffer.indexOf("\n");
    if (newlineIndex < 0) break;
    const line = record.bridgeStdoutBuffer.slice(0, newlineIndex).trim();
    record.bridgeStdoutBuffer = record.bridgeStdoutBuffer.slice(newlineIndex + 1);
    if (!line) continue;
    let event: BridgeEvent;
    try {
      event = JSON.parse(line) as BridgeEvent;
    } catch {
      appendStatusLine(id, `[bridge parse error] ${line}`);
      continue;
    }
    if (event.type === "data" && event.data) {
      const chunk = Buffer.from(event.data, "base64").toString("utf8");
      record.term.write(chunk, () => {
        syncSnapshot(id);
      });
      continue;
    }
    if (event.type === "error") {
      appendStatusLine(id, `[bridge error] ${event.message ?? "unknown error"}`);
      continue;
    }
    if (event.type === "exit") {
      record.pendingExit = {
        exitCode: event.exitCode,
        signal: event.signal ?? null,
      };
    }
  }
}

async function pumpBridgeStdout(
  id: string,
  stream: ReadableStream<Uint8Array>,
  controller: AbortController,
): Promise<void> {
  await readTextUntilAborted(stream, controller, (text) => handleBridgeStdout(id, text));
}

/**
 * Resolve once the process has exited AND its stdout pump has drained (or a
 * short grace elapsed). The bridge reports the child's real exit code as its
 * final stdout line; `proc.exited` can resolve before that line is parsed, and
 * the session then recorded the bridge's own exit code instead.
 */
export async function waitForExitAndDrain(
  exited: Promise<number>,
  drained: Promise<void>,
  graceMs = 500,
): Promise<number> {
  const exitCode = await exited;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([drained, new Promise<void>((resolve) => (timer = setTimeout(resolve, graceMs)))]);
  if (timer) clearTimeout(timer);
  return exitCode;
}

export const STOP_GRACE_MS = 1_500;

/**
 * Ask a process to stop, escalating only if it ignores the request: first the
 * polite request (bridge `stop` → SIGTERM to the PTY child), then SIGTERM to
 * the process itself after `graceMs`, then SIGKILL after another `graceMs`.
 * Killing the bridge immediately used to orphan the PTY child mid-shutdown.
 */
export function stopWithGrace(opts: {
  requestStop: () => void;
  kill: (signal: "SIGTERM" | "SIGKILL") => void;
  isAlive: () => boolean;
  graceMs?: number;
}): void {
  const graceMs = opts.graceMs ?? STOP_GRACE_MS;
  opts.requestStop();
  setTimeout(() => {
    if (!opts.isAlive()) return;
    opts.kill("SIGTERM");
    setTimeout(() => {
      if (opts.isAlive()) opts.kill("SIGKILL");
    }, graceMs);
  }, graceMs);
}

function sendBridgeCommand(record: TerminalSessionRecord, payload: Record<string, unknown>): void {
  if (!record.proc || record.backend !== "bridge") return;
  const stdin = record.proc.stdin;
  if (!stdin || typeof stdin !== "object" || !("write" in stdin)) return;
  try {
    (stdin as { write: (chunk: string) => void }).write(`${JSON.stringify(payload)}\n`);
  } catch {
    // stdin closed — ignore.
  }
}

function startSession(id: string): void {
  const record = records.get(id);
  if (!record) return;
  const { command, cwd, shell, cols, rows } = record.snapshot;

  record.term.dispose();
  record.term = new Terminal({
    allowProposedApi: true,
    cols,
    rows,
    scrollback: MAX_SCROLLBACK,
    convertEol: false,
  });

  disposeRecordListeners(record);
  attachRecordListeners(id);
  record.bridgeStdoutBuffer = "";

  // Strategy selection: prefer the Python PTY bridge for real TTY semantics.
  const useBridge = BRIDGE_PATH !== null && hasPython3();
  let proc: Subprocess;
  try {
    if (useBridge) {
      const config = Buffer.from(
        JSON.stringify({
          command,
          cwd,
          shell,
          cols,
          rows,
          env: {
            TERM: "xterm-256color",
            COLORTERM: process.env.COLORTERM ?? "truecolor",
          },
        }),
      ).toString("base64");
      proc = Bun.spawn(["python3", BRIDGE_PATH as string, config], {
        cwd,
        env: process.env as Record<string, string>,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      record.backend = "bridge";
    } else {
      proc = Bun.spawn([shell, "-lc", command], {
        cwd,
        env: {
          ...process.env,
          // No PTY — force-color the common CLIs so output still has hue.
          TERM: "xterm-256color",
          COLORTERM: process.env.COLORTERM ?? "truecolor",
          FORCE_COLOR: process.env.FORCE_COLOR ?? "3",
          CLICOLOR_FORCE: process.env.CLICOLOR_FORCE ?? "1",
          COLUMNS: String(cols),
          LINES: String(rows),
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      record.backend = "pipe";
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateSnapshot(id, (snapshot) => ({
      ...snapshot,
      status: "error",
      endedAt: new Date().toISOString(),
      lines: [...snapshot.lines, `[spawn error] ${message}`],
    }));
    return;
  }

  record.proc = proc;
  record.restartRequested = false;
  record.snapshot = {
    ...record.snapshot,
    title: command,
    status: "running",
    startedAt: new Date().toISOString(),
    endedAt: undefined,
    exitCode: undefined,
    viewportY: 0,
    bufferLength: 0,
    cursorX: 0,
    cursorY: 0,
    lines: Array.from({ length: rows }, () => ""),
  };
  notify();

  const stdoutController = new AbortController();
  const stderrController = new AbortController();
  record.readers.push(stdoutController, stderrController);
  let stdoutDrained: Promise<void>;
  if (record.backend === "bridge") {
    // Bridge emits JSON-line events on stdout and human-readable errors on
    // stderr. Feed each stream through its own pump.
    stdoutDrained = pumpBridgeStdout(id, proc.stdout as ReadableStream<Uint8Array>, stdoutController);
    void pumpReadable(id, proc.stderr as ReadableStream<Uint8Array>, stderrController);
  } else {
    stdoutDrained = pumpReadable(id, proc.stdout as ReadableStream<Uint8Array>, stdoutController);
    void pumpReadable(id, proc.stderr as ReadableStream<Uint8Array>, stderrController);
  }

  void waitForExitAndDrain(proc.exited, stdoutDrained).then((exitCode: number) => {
    const current = records.get(id);
    // A restart/remove may already have replaced this process.
    if (!current || current.proc !== proc) return;
    const shouldRestart = current.restartRequested;
    // The bridge sends us the true child exit via a `pendingExit` event; if
    // that happened, use it — otherwise fall back to the subprocess's own
    // exit code.
    const pending = current.pendingExit;
    const effectiveCode = pending?.exitCode ?? (typeof exitCode === "number" ? exitCode : undefined);
    const effectiveSignal = pending?.signal ?? null;
    const signalTerminated = !!effectiveSignal || (typeof effectiveCode === "number" && effectiveCode > 128);
    current.proc = null;
    current.restartRequested = false;
    current.pendingExit = null;
    updateSnapshot(id, (snapshot) => ({
      ...snapshot,
      status: signalTerminated ? "stopped" : effectiveCode === 0 ? "done" : "error",
      exitCode: effectiveCode,
      endedAt: new Date().toISOString(),
    }));
    syncSnapshot(id);
    if (shouldRestart) startSession(id);
  });
}

export function spawnTerminalSession({
  command,
  cwd = process.cwd(),
  shell = process.env.SHELL || "/bin/zsh",
  cols = DEFAULT_COLS,
  rows = DEFAULT_ROWS,
  title,
}: SpawnTerminalSessionOptions): string {
  const id = makeSessionId();
  records.set(id, {
    snapshot: {
      id,
      command,
      cwd,
      shell,
      title: title?.trim() || command,
      status: "running",
      startedAt: new Date().toISOString(),
      cols,
      rows,
      viewportY: 0,
      bufferLength: rows,
      cursorX: 0,
      cursorY: 0,
      lines: Array.from({ length: rows }, () => ""),
    },
    proc: null,
    term: new Terminal({
      allowProposedApi: true,
      cols,
      rows,
      scrollback: MAX_SCROLLBACK,
      convertEol: false,
    }),
    listeners: [],
    readers: [],
    pendingExit: null,
    restartRequested: false,
    backend: null,
    bridgeStdoutBuffer: "",
  });
  startSession(id);
  return id;
}

/** Kill every session's process. Registered for process exit so PTY bridges
 *  (and their children) don't outlive the app. */
export function disposeAllTerminalSessions(): void {
  for (const record of records.values()) {
    const proc = record.proc;
    record.proc = null;
    try {
      proc?.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

process.once("exit", disposeAllTerminalSessions);

export function removeTerminalSession(id: string): void {
  const record = records.get(id);
  if (!record) return;
  disposeRecord(record);
  records.delete(id);
  notify();
}

export function stopTerminalSession(id: string): void {
  const record = records.get(id);
  const proc = record?.proc;
  if (!record || !proc) return;
  record.restartRequested = false;
  const kill = (signal: "SIGTERM" | "SIGKILL") => {
    try {
      proc.kill(signal);
    } catch {
      // Already exited.
    }
  };
  stopWithGrace({
    // Bridge: ask it to SIGTERM the PTY child; it then exits on its own once
    // the child is gone. Pipe backend: SIGTERM is the polite request.
    requestStop: () => (record.backend === "bridge" ? sendBridgeCommand(record, { type: "stop" }) : kill("SIGTERM")),
    kill,
    isAlive: () => record.proc === proc,
  });
}

export function restartTerminalSession(id: string): void {
  const record = records.get(id);
  if (!record) return;
  if (record.proc) {
    record.restartRequested = true;
    try {
      record.proc.kill("SIGTERM");
    } catch {
      // Already exited — fall through to startSession below on next tick.
    }
    return;
  }
  startSession(id);
}

export function clearTerminalSession(id: string): void {
  const record = records.get(id);
  if (!record) return;
  record.term.reset();
  syncSnapshot(id);
}

export function writeTerminalSession(id: string, input: string): void {
  const record = records.get(id);
  if (!record?.proc || record.snapshot.status !== "running") return;
  if (record.backend === "bridge") {
    // Route through the bridge as a JSON-line `input` command with the raw
    // keystrokes base64-encoded. The bridge writes them to the PTY's master
    // fd so the child sees them like normal tty input.
    sendBridgeCommand(record, {
      type: "input",
      data: Buffer.from(input, "utf8").toString("base64"),
    });
    return;
  }
  const stdin = record.proc.stdin;
  if (stdin && typeof stdin === "object" && "write" in stdin) {
    try {
      (stdin as { write: (chunk: string) => void }).write(input);
    } catch {
      // stdin closed — non-interactive process.
    }
  }
}

export function resizeTerminalSession(id: string, cols: number, rows: number): void {
  const record = records.get(id);
  if (!record) return;
  const nextCols = Math.max(20, cols);
  const nextRows = Math.max(4, rows);
  record.term.resize(nextCols, nextRows);
  record.snapshot = {
    ...record.snapshot,
    cols: nextCols,
    rows: nextRows,
  };
  if (record.backend === "bridge") {
    // Forward to the bridge so it can issue TIOCSWINSZ and the child gets a
    // SIGWINCH. Without this, curses apps see stale dimensions.
    sendBridgeCommand(record, {
      type: "resize",
      cols: nextCols,
      rows: nextRows,
    });
  }
  syncSnapshot(id);
}

export function scrollTerminalSession(id: string, lines: number): void {
  const record = records.get(id);
  if (!record) return;
  record.term.scrollLines(lines);
  syncSnapshot(id);
}

export function scrollTerminalSessionPages(id: string, pages: number): void {
  const record = records.get(id);
  if (!record) return;
  record.term.scrollPages(pages);
  syncSnapshot(id);
}

export function scrollTerminalToBottom(id: string): void {
  const record = records.get(id);
  if (!record) return;
  record.term.scrollToBottom();
  syncSnapshot(id);
}

export function getTerminalSession(id: string): TerminalSessionSnapshot | null {
  return records.get(id)?.snapshot ?? null;
}

export function getTerminalSessions(): readonly TerminalSessionSnapshot[] {
  return allSessionsSnapshot;
}

export function useTerminalSession(id: string): TerminalSessionSnapshot | null {
  return useSyncExternalStore(
    subscribe,
    () => getTerminalSession(id),
    () => getTerminalSession(id),
  );
}

export function useTerminalSessions(): readonly TerminalSessionSnapshot[] {
  return useSyncExternalStore(
    subscribe,
    () => allSessionsSnapshot,
    () => allSessionsSnapshot,
  );
}
