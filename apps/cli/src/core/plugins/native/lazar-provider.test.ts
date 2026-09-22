import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("lazar-provider models loading", () => {
  let originalFetch: typeof fetch;

  function mockFetch(fetchMock: ReturnType<typeof vi.fn>) {
    global.fetch = fetchMock as unknown as typeof fetch;
  }

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns null on fetch error (proxy down)", async () => {
    mockFetch(vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const { fetchModelsFromProxy } = await import("./lazar-provider");
    const result = await fetchModelsFromProxy();
    expect(result).toBeNull();
  });

  it("returns null on non-ok response", async () => {
    mockFetch(vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const { fetchModelsFromProxy } = await import("./lazar-provider");
    const result = await fetchModelsFromProxy();
    expect(result).toBeNull();
  });

  it("returns null on empty data", async () => {
    mockFetch(vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) }));
    const { fetchModelsFromProxy } = await import("./lazar-provider");
    const result = await fetchModelsFromProxy();
    expect(result).toBeNull();
  });

  it("returns mapped models on success", async () => {
    mockFetch(
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { id: "minimax-m2.7", provider: "minimax", free: false },
            { id: "gpt-oss-20b", provider: "openrouter", free: true, aliases: ["gpt-oss"] },
          ],
        }),
      }),
    );
    const { fetchModelsFromProxy } = await import("./lazar-provider");
    const result = await fetchModelsFromProxy();
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result?.[0]?.id).toBe("minimax-m2.7");
    expect(result?.[0]?.label).toBe("minimax-m2.7 (minimax)");
    expect(result?.[1]?.aliases).toEqual(["gpt-oss"]);
    expect(result?.[1]?.description).toContain("free tier");
  });

  it("aborts when signal fires", async () => {
    mockFetch(
      vi.fn().mockImplementation(
        (_url, opts) =>
          new Promise((_, reject) => {
            opts?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
          }),
      ),
    );
    const { fetchModelsFromProxy } = await import("./lazar-provider");
    const start = Date.now();
    const result = await fetchModelsFromProxy();
    const elapsed = Date.now() - start;
    expect(result).toBeNull();
    expect(elapsed).toBeLessThan(2000);
  });
});

describe("LazarSession — lazar error event (L14)", () => {
  let dir: string;
  let bin: string;
  let savedKey: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "lazar-l14-"));
    bin = path.join(dir, "lazar");
    // Reports an error, then keeps running with a tool subprocess of its own —
    // the shape that used to leave the kernel alive and the session wedged.
    writeFileSync(
      bin,
      `#!${process.execPath}
const { spawn } = require("node:child_process");
const tool = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
require("node:fs").writeFileSync(${JSON.stringify(path.join(dir, "tool.pid"))}, String(tool.pid));
process.stdout.write(JSON.stringify({ type: "error", message: "kernel boom" }) + "\\n");
setInterval(() => {}, 1000);
`,
    );
    chmodSync(bin, 0o755);
    savedKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
    rmSync(dir, { recursive: true, force: true });
  });

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("ends the turn, kills the kernel's process group and frees the session", async () => {
    const { LazarSession } = await import("./lazar-provider");
    const session = new LazarSession({ adapterId: "lazar.cli", conversationId: "c1" } as never, {
      binPath: () => bin,
      lazarHome: () => dir,
      verbose: () => false,
      toolTimeoutSecs: () => 30,
      inheritApiKeyToTools: () => false,
    });
    const input = { prompt: "hi", modelId: "m", messages: [] } as never;
    const events: Array<{ type: string }> = [];

    await expect(session.sendTurn(input, { emit: (e) => events.push(e) })).rejects.toThrow("kernel boom");
    expect(events.filter((e) => e.type === "error")).toHaveLength(1);

    await vi.waitFor(() => expect(existsSync(path.join(dir, "tool.pid"))).toBe(true));
    const toolPid = Number(readFileSync(path.join(dir, "tool.pid"), "utf-8"));
    await vi.waitFor(() => expect(alive(toolPid)).toBe(false), { timeout: 3000 });

    // The session is free for the next turn instead of "already has an active turn".
    await expect(session.sendTurn(input, { emit: () => {} })).rejects.toThrow("kernel boom");
  });
});
