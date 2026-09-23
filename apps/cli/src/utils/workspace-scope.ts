// Per-session workspace scope: "one server, many folders".
//
// A node process hosts sessions for many folders, but the Agent and the kernel
// tools resolve their folder through process-wide services (`services.bash`,
// `services.workspace`, `process.cwd()`). A session's turns run inside a
// `WorkspaceScope`; those resolvers consult it first and fall back to the
// process globals when there is none, so the in-process TUI (never scoped)
// behaves exactly as before. See docs/architecture/per-session-workspace.md.
//
// No runtime imports: settings.ts, sinks.ts and the providers all read this.

import { AsyncLocalStorage } from "node:async_hooks";
import type { BashSink, HooksSink, ScheduleSink, SubagentsSink } from "../core/plugins/sinks";

export interface WorkspaceScope {
  /** Realpath of the session folder. Fixed for the session's life. */
  readonly root: string;
  /** The session's own shell (its live cwd and sandbox). */
  readonly bash: BashSink;
  /** Bridges bound by the Agent constructed in this scope. */
  subagents: SubagentsSink | null;
  schedule: ScheduleSink | null;
  hooks: HooksSink | null;
}

const workspaceStorage = new AsyncLocalStorage<WorkspaceScope>();

export function createWorkspaceScope(root: string, bash: BashSink): WorkspaceScope {
  return { root, bash, subagents: null, schedule: null, hooks: null };
}

/** Run `fn` (and everything it starts) inside a session's workspace. */
export function runInWorkspace<T>(scope: WorkspaceScope, fn: () => T): T {
  return workspaceStorage.run(scope, fn);
}

export function currentWorkspaceScope(): WorkspaceScope | undefined {
  return workspaceStorage.getStore();
}

/** The session folder when scoped, else the process's own. */
export function workspaceRoot(): string {
  return workspaceStorage.getStore()?.root ?? process.cwd();
}

/**
 * Consume an async iterable inside a scope. An async generator resumes in the
 * context of whoever calls `next()`, not the one it was created in, so the
 * scope has to wrap every step, not just the call that made the generator.
 */
export function scopeAsyncIterable<T>(scope: WorkspaceScope, source: AsyncIterable<T>): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      const iterator = runInWorkspace(scope, () => source[Symbol.asyncIterator]());
      return {
        next: (...args: [] | [unknown]) => runInWorkspace(scope, () => iterator.next(...args)),
        return: (value?: unknown) =>
          runInWorkspace(scope, () =>
            iterator.return ? iterator.return(value) : Promise.resolve({ done: true as const, value: value as T }),
          ),
        throw: (error?: unknown) =>
          runInWorkspace(scope, () => (iterator.throw ? iterator.throw(error) : Promise.reject(error))),
      };
    },
  };
}
