// The kernel services a node session's tools read resolve to that session's
// workspace scope, and fall back to the process globals (the TUI) outside one.

import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceScope, runInWorkspace } from "../../utils/workspace-scope";
import { getHostServices } from "./loader";
import {
  type BashSink,
  getHooksSink,
  getSubagentsSink,
  requireBashSink,
  requireScheduleSink,
  resetSinkState,
  type ScheduleSink,
  type SubagentsSink,
  setBashSink,
  setCwdProvider,
  setScheduleSink,
  setSubagentsSink,
} from "./sinks";

const shell = (cwd: string) => ({ cwd: () => cwd }) as unknown as BashSink;

function subagents(label: string): SubagentsSink {
  const result = async () => ({ success: true, output: label });
  return { runTask: result, runDelegation: result, readDelegation: result, listDelegations: result };
}

afterEach(() => {
  resetSinkState();
});

describe("workspace scope over the kernel sinks", () => {
  it("resolves bash and workspace cwd to the scope, the globals outside it", () => {
    setBashSink(shell("/global"));
    setCwdProvider(() => "/tui");
    const scope = createWorkspaceScope("/work/a", shell("/work/a"));

    runInWorkspace(scope, () => {
      expect(requireBashSink().cwd()).toBe("/work/a");
      expect(getHostServices().bash.cwd()).toBe("/work/a");
      expect(getHostServices().workspace.cwd()).toBe("/work/a");
    });
    expect(getHostServices().bash.cwd()).toBe("/global");
    expect(getHostServices().workspace.cwd()).toBe("/tui");
  });

  it("binds an Agent's bridges to its scope without touching the globals or other scopes", async () => {
    setSubagentsSink(subagents("tui"));
    const a = createWorkspaceScope("/work/a", shell("/work/a"));
    const b = createWorkspaceScope("/work/b", shell("/work/b"));
    runInWorkspace(a, () => setSubagentsSink(subagents("a")));
    runInWorkspace(b, () => {
      setSubagentsSink(subagents("b"));
      setScheduleSink({ list: async () => [] } as unknown as ScheduleSink);
    });

    expect((await runInWorkspace(a, () => getHostServices().subagents.runTask({} as never))).output).toBe("a");
    expect((await runInWorkspace(b, () => getHostServices().subagents.runTask({} as never))).output).toBe("b");
    expect((await getHostServices().subagents.runTask({} as never)).output).toBe("tui");

    // Scope A never bound a schedule or hooks bridge: it must not borrow B's or the global's.
    expect(() => runInWorkspace(a, () => requireScheduleSink())).toThrow(/not active/);
    expect(runInWorkspace(b, () => requireScheduleSink())).toBeDefined();
    expect(runInWorkspace(a, () => getHooksSink())).toBeNull();
    expect(getSubagentsSink()).not.toBeNull();
  });
});
