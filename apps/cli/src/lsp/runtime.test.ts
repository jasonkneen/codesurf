import { mkdir, mkdtemp, rm } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceLspManager } from "./manager";

const managersByCwd = new Map<string, WorkspaceLspManager & { close: ReturnType<typeof vi.fn> }>();
const createWorkspaceLspManager = vi.fn((cwd: string) => {
  const manager = {
    touchFile: vi.fn(async () => []),
    syncFile: vi.fn(async () => []),
    query: vi.fn(async () => ({ success: true, output: cwd })),
    close: vi.fn(async () => {}),
  };
  managersByCwd.set(cwd, manager);
  return manager;
});

vi.mock("./manager", () => ({
  createWorkspaceLspManager: (cwd: string) => createWorkspaceLspManager(cwd),
  summarizeLspDiagnostics: () => null,
}));

vi.mock("../utils/settings", () => ({
  getCurrentLspSettings: () => ({
    enabled: true,
    tool: true,
    autoInstall: false,
    startupTimeoutMs: 5_000,
    diagnosticsDebounceMs: 0,
    builtins: {},
    servers: [],
  }),
}));

const { queryLsp, resolveManagerKey, shutdownWorkspaceLspManager } = await import("./runtime");

const tempDirs: string[] = [];

afterEach(async () => {
  createWorkspaceLspManager.mockClear();
  managersByCwd.clear();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// T7: two unrelated, unmarked projects must not collapse onto one manager
// rooted at "/" and share settings, clients and shutdown.
describe("resolveManagerKey", () => {
  it("keeps an unmarked workspace's own cwd as its identity", async () => {
    const first = await createTempDir();
    const second = await createTempDir();

    expect(resolveManagerKey(first)).toBe(first);
    expect(resolveManagerKey(second)).toBe(second);
    expect(resolveManagerKey(first)).not.toBe(resolveManagerKey(second));
  });

  it("resolves to the nearest repository root for nested repositories", async () => {
    const outer = await createTempDir();
    await mkdir(path.join(outer, ".git"));
    const inner = path.join(outer, "packages", "inner");
    await mkdir(path.join(inner, ".git"), { recursive: true });
    const innerSrc = path.join(inner, "src");
    await mkdir(innerSrc);
    const outerSrc = path.join(outer, "src");
    await mkdir(outerSrc);

    expect(resolveManagerKey(innerSrc)).toBe(inner);
    expect(resolveManagerKey(outerSrc)).toBe(outer);
  });

  it("recognizes a .codesurf marker without a repository", async () => {
    const workspace = await createTempDir();
    await mkdir(path.join(workspace, ".codesurf"));
    const nested = path.join(workspace, "lib", "deep");
    await mkdir(nested, { recursive: true });

    expect(resolveManagerKey(nested)).toBe(workspace);
  });
});

describe("workspace manager isolation", () => {
  it("gives markerless workspaces separate managers and shuts down only the requested one", async () => {
    const first = await createTempDir();
    const second = await createTempDir();

    await queryLsp(first, { operation: "hover", filePath: "a.ts", line: 1, character: 1 });
    await queryLsp(second, { operation: "hover", filePath: "b.ts", line: 1, character: 1 });

    expect(createWorkspaceLspManager).toHaveBeenCalledTimes(2);
    expect(createWorkspaceLspManager).toHaveBeenCalledWith(first);
    expect(createWorkspaceLspManager).toHaveBeenCalledWith(second);

    await shutdownWorkspaceLspManager(first);
    expect(managersByCwd.get(first)!.close).toHaveBeenCalledTimes(1);
    expect(managersByCwd.get(second)!.close).not.toHaveBeenCalled();

    // The second workspace keeps its manager; the first gets a fresh one.
    await queryLsp(second, { operation: "hover", filePath: "b.ts", line: 1, character: 1 });
    expect(createWorkspaceLspManager).toHaveBeenCalledTimes(2);
    await queryLsp(first, { operation: "hover", filePath: "a.ts", line: 1, character: 1 });
    expect(createWorkspaceLspManager).toHaveBeenCalledTimes(3);

    await shutdownWorkspaceLspManager(second);
    await shutdownWorkspaceLspManager(first);
  });
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codesurf-lsp-runtime-"));
  tempDirs.push(dir);
  return dir;
}
