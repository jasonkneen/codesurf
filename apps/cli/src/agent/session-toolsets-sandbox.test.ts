import { afterEach, describe, expect, it, vi } from "vitest";

// Regression: a sub-agent's file tools were rebuilt against the child's cwd
// but not its sandbox mode, so they fell back to the settings-derived default
// even when the child's shell was running sandboxed (or unsandboxed) live.

type FileDeps = { sandboxMode?: () => "off" | "shuru" | undefined };
const captured = vi.hoisted(() => ({ deps: [] as FileDeps[] }));

vi.mock("../core/plugins/native/file-tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/plugins/native/file-tools")>();
  return {
    ...actual,
    createFileToolDefinitions: (deps: FileDeps & Parameters<typeof actual.createFileToolDefinitions>[0]) => {
      captured.deps.push(deps);
      return actual.createFileToolDefinitions(deps);
    },
  };
});

afterEach(() => {
  captured.deps.length = 0;
});

function childBash(mode: string) {
  const ok = async () => ({ success: true, output: "" });
  return {
    execute: ok,
    startBackground: ok,
    getProcessLogs: ok,
    stopProcess: ok,
    listProcesses: () => ({ success: true, output: "" }),
    getSandboxMode: vi.fn(() => mode),
  };
}

describe("sub-agent file tools and the sandbox", () => {
  it("read the child shell's live sandbox mode", async () => {
    const { SessionToolsets } = await import("./session-toolsets");
    const toolsets = new SessionToolsets({ runTask: vi.fn() });
    const bash = childBash("shuru");

    await toolsets.buildTurn({
      runtime: { model: {} as never, modelId: "m", modelInfo: undefined },
      mode: "ask",
      bashOverride: bash,
      cwdOverride: () => "/tmp",
    });

    const deps = captured.deps.at(-1);
    expect(deps?.sandboxMode?.()).toBe("shuru");
    // Live, not captured at build time.
    bash.getSandboxMode.mockReturnValue("off");
    expect(deps?.sandboxMode?.()).toBe("off");
  });

  it("ignores a mode the file tools do not understand", async () => {
    const { SessionToolsets } = await import("./session-toolsets");
    const toolsets = new SessionToolsets({ runTask: vi.fn() });

    await toolsets.buildTurn({
      runtime: { model: {} as never, modelId: "m", modelInfo: undefined },
      mode: "ask",
      bashOverride: childBash("docker"),
      cwdOverride: () => "/tmp",
    });

    expect(captured.deps.at(-1)?.sandboxMode?.()).toBeUndefined();
  });
});
