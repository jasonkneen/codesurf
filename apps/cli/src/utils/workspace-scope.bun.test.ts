// The per-session workspace scope, on the runtime that actually ships.
//
// A node session's folder reaches its tools only through `AsyncLocalStorage`,
// and the node drives each turn as an async generator. Vitest runs on Node; the
// node runs on Bun. If Bun dropped the store across a generator resume, a
// session's tools would silently run in the node's folder. This is the check.

import { describe, expect, it } from "bun:test";
import type { BashSink } from "../core/plugins/sinks";
import { requireBashSink } from "../core/plugins/sinks";
import {
  createWorkspaceScope,
  currentWorkspaceScope,
  runInWorkspace,
  scopeAsyncIterable,
  workspaceRoot,
} from "./workspace-scope";

const shell = (cwd: string) => ({ cwd: () => cwd }) as unknown as BashSink;

async function* turn(label: string): AsyncGenerator<string> {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    await Promise.resolve();
    yield `${label}:${workspaceRoot()}:${requireBashSink().cwd()}`;
  }
}

async function drain(iterable: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const value of iterable) out.push(value);
  return out;
}

describe("workspace scope under Bun", () => {
  it("keeps each session's scope across async-generator resumes, interleaved", async () => {
    const a = createWorkspaceScope("/work/a", shell("/work/a"));
    const b = createWorkspaceScope("/work/b", shell("/work/b"));

    // The consumer runs OUTSIDE any scope, as the node's session host does.
    const [fromA, fromB] = await Promise.all([
      drain(scopeAsyncIterable(a, turn("a"))),
      drain(scopeAsyncIterable(b, turn("b"))),
    ]);

    expect(fromA).toEqual(Array(3).fill("a:/work/a:/work/a"));
    expect(fromB).toEqual(Array(3).fill("b:/work/b:/work/b"));
    expect(currentWorkspaceScope()).toBeUndefined();
    expect(workspaceRoot()).toBe(process.cwd());
  });

  it("carries the scope into work started inside it (timers, detached promises)", async () => {
    const scope = createWorkspaceScope("/work/c", shell("/work/c"));
    const detached = runInWorkspace(
      scope,
      () => new Promise<string>((resolve) => setTimeout(() => resolve(workspaceRoot()), 5)),
    );
    expect(await detached).toBe("/work/c");
  });
});
