// Node session host (Phase 2 W3, node-host slice). The host owns sessions and
// keeps work alive across front detach — the "client-death resilience"
// requirement: a front is just an observer; when it detaches (disconnects,
// dies), the in-flight turn is NOT cancelled. The turn continues in the host;
// a re-attaching front resumes receiving.
//
// This is the seam the relay node exposes: a front delegates a message to a
// session on the node; the node's host runs it regardless of front liveness.

import { recordIssue } from "../storage/issues";
import type { StreamChunk } from "../types/index";
import type { SandboxMode, SandboxSettings } from "../utils/settings";

/** Where and how a session runs, as the front asked for it at create time. */
export interface SessionWorkspaceOptions {
  /** Absolute folder the session's Agent and tools run in. Unset = the node's own. */
  cwd?: string;
  sandboxMode?: SandboxMode;
  sandboxSettings?: SandboxSettings;
}

/** A session's workspace after the node validated it: `cwd` is a realpath. */
export interface SessionWorkspace extends SessionWorkspaceOptions {
  cwd: string;
}

export type HostedTurnRunner = (
  sessionId: string,
  message: string,
  signal: AbortSignal,
  workspace?: SessionWorkspace,
) => AsyncIterable<StreamChunk>;

export interface SessionObserver {
  onChunk(chunk: StreamChunk): void;
  onEnd(): void;
}

export interface SessionStatus {
  id: string;
  /** The folder the session runs in (realpath). */
  cwd: string;
  createdAt: string;
  turning: boolean;
  observers: number;
  text: string;
  finished: boolean;
}

export interface SessionHostOptions {
  /** Evict sessions idle longer than this (ms). Default 30 min. */
  idleTtlMs?: number;
  /** Evict sessions older than this (ms), even if active. Optional. */
  maxTtlMs?: number;
  /** Called with the session id when the host evicts a session. */
  onEvict?: (sessionId: string) => void;
  /**
   * Validate and resolve a create request's workspace; throw to reject the
   * create. Default: the node's own folder, as given.
   */
  resolveWorkspace?: (options: SessionWorkspaceOptions) => SessionWorkspace;
}

interface SessionState {
  id: string;
  /** Front-supplied id of the current (or last) turn; echoed on its stream frames. */
  turnId?: string;
  workspace: SessionWorkspace;
  createdAt: string;
  observers: Set<SessionObserver>;
  turning: boolean;
  text: string;
  finished: boolean;
  lastActivityMs: number;
  /** Aborts the running turn (set while turning). */
  controller?: AbortController;
}

export class NodeSessionHost {
  private readonly sessions = new Map<string, SessionState>();
  private counter = 0;

  constructor(
    private readonly runner: HostedTurnRunner,
    private readonly options: SessionHostOptions = {},
  ) {}

  /** Create a session; returns its id. */
  /** Snapshot of live session summaries (for a node's session list). */
  list(): SessionStatus[] {
    return [...this.sessions.values()]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((s) => ({
        id: s.id,
        cwd: s.workspace.cwd,
        createdAt: s.createdAt,
        turning: s.turning,
        observers: s.observers.size,
        text: s.text,
        finished: s.finished,
      }));
  }

  createSession(id?: string, options: SessionWorkspaceOptions = {}): string {
    const sessionId = id ?? `sess-${++this.counter}`;
    if (this.sessions.has(sessionId)) throw new Error(`session ${sessionId} already exists`);
    const workspace = this.options.resolveWorkspace
      ? this.options.resolveWorkspace(options)
      : { ...options, cwd: options.cwd ?? process.cwd() };
    this.sessions.set(sessionId, {
      id: sessionId,
      workspace,
      createdAt: new Date().toISOString(),
      observers: new Set(),
      turning: false,
      text: "",
      finished: false,
      lastActivityMs: Date.now(),
    });
    return sessionId;
  }

  /** Attach a front as an observer; returns a detach function. */
  attach(sessionId: string, observer: SessionObserver): () => void {
    const session = this.require(sessionId);
    session.observers.add(observer);
    return () => session.observers.delete(observer);
  }

  /**
   * Begin a turn on a session. The host OWNS the turn: it proceeds even if every
   * observer detaches. Resolves when the turn ends. One turn at a time per
   * session: a message while a turn is running is rejected, not interleaved.
   */
  async message(sessionId: string, text: string, turnId?: string): Promise<void> {
    const session = this.require(sessionId);
    if (session.turning) throw new Error(`session ${sessionId} is busy with a running turn`);
    session.turnId = turnId;
    session.lastActivityMs = Date.now();
    const controller = new AbortController();
    session.controller = controller;
    session.turning = true;
    try {
      for await (const chunk of this.runner(sessionId, text, controller.signal, session.workspace)) {
        session.lastActivityMs = Date.now();
        if (chunk.type === "content" && typeof chunk.content === "string") session.text += chunk.content;
        for (const observer of [...session.observers]) observer.onChunk(chunk);
      }
      session.finished = true;
    } catch (error) {
      // A turn that fails before or outside the model stream (e.g. no API key,
      // so the provider cannot connect) must reach the front as an error, not
      // as a bare `done` that reads as an empty, successful turn.
      const message = error instanceof Error ? error.message : String(error);
      session.text += "\n[error: " + message + "]";
      const chunk: StreamChunk = { type: "error", content: message };
      for (const observer of [...session.observers]) observer.onChunk(chunk);
      throw error;
    } finally {
      session.turning = false;
      session.controller = undefined;
      for (const observer of [...session.observers]) observer.onEnd();
    }
  }

  /** Detach one observer without cancelling any in-flight turn. */
  detach(sessionId: string, observer: SessionObserver): void {
    this.require(sessionId).observers.delete(observer);
  }

  /** Id of the session's current (or last) turn, if the front supplied one. */
  turnIdOf(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.turnId;
  }

  status(sessionId: string): SessionStatus | null {
    const session = this.sessions.get(sessionId);
    if (session) session.lastActivityMs = Date.now();
    return session
      ? {
          id: session.id,
          cwd: session.workspace.cwd,
          createdAt: session.createdAt,
          turning: session.turning,
          observers: session.observers.size,
          text: session.text,
          finished: session.finished,
        }
      : null;
  }

  destroy(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    const removed = this.sessions.delete(sessionId);
    session?.controller?.abort();
    // Same owner hook as the reaper, so an explicit destroy disposes the Agent too.
    if (removed) this.options.onEvict?.(sessionId);
    return removed;
  }

  /** Live session count (for load/telemetry). */
  count(): number {
    return this.sessions.size;
  }

  /**
   * Evict sessions idle past idleTtlMs or alive past maxTtlMs. Returns the
   * number evicted; calls onEvict for each (so the owner can dispose an Agent).
   */
  reap(): number {
    const now = Date.now();
    const idleTtl = this.options.idleTtlMs ?? 30 * 60_000;
    const maxTtl = this.options.maxTtlMs;
    let evicted = 0;
    for (const [id, session] of [...this.sessions]) {
      // Never evict mid-turn: onEvict disposes the Agent the turn is running on.
      // A running turn keeps lastActivityMs fresh, so it is reaped once it ends.
      if (session.turning) continue;
      const idleMs = now - session.lastActivityMs;
      const ageMs = now - Date.parse(session.createdAt);
      if (idleMs > idleTtl || (maxTtl !== undefined && ageMs > maxTtl)) {
        this.sessions.delete(id);
        this.options.onEvict?.(id);
        evicted++;
      }
    }
    return evicted;
  }

  /** Begin a turn without awaiting (fire-and-forget so the node returns immediately). Returns false when busy. */
  enqueue(sessionId: string, text: string): boolean {
    if (this.sessions.get(sessionId)?.turning) return false;
    // `message` records the failure on the session and tells its observers.
    void this.message(sessionId, text).catch(() => {});
    return true;
  }

  private require(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId);
    if (!session) {
      recordIssue({ source: "relay.host", message: `unknown session ${sessionId}`, sessionId });
      throw new Error(`unknown session ${sessionId}`);
    }
    return session;
  }
}
