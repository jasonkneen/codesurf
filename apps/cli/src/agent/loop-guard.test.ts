import { describe, expect, it } from "vitest";
import { LoopGuard, stableStringify, wrapToolSetWithLoopGuard } from "./loop-guard";

describe("stableStringify", () => {
  it("gives reordered but equivalent nested objects the same key", () => {
    const a = stableStringify({ config: { y: 2, x: 1 }, path: "f.ts" });
    const b = stableStringify({ path: "f.ts", config: { x: 1, y: 2 } });
    expect(a).toBe(b);
    expect(a).toBe('{"config":{"x":1,"y":2},"path":"f.ts"}');
  });

  it("keeps nested values, so distinct structured calls get distinct keys", () => {
    // Regression: the old implementation passed the top-level key list as a
    // JSON.stringify replacer, which is a whitelist at EVERY depth — nested
    // fields were dropped and `{config:{x:1}}` collided with `{config:{x:2}}`.
    expect(stableStringify({ config: { x: 1 } })).not.toBe(stableStringify({ config: { x: 2 } }));
    expect(stableStringify({ config: { x: 1 } })).toBe('{"config":{"x":1}}');
  });

  it("preserves array order, nulls and nested arrays of objects", () => {
    expect(stableStringify({ items: [{ b: 1, a: [null, 2] }, "x"] })).toBe('{"items":[{"a":[null,2],"b":1},"x"]}');
    expect(stableStringify({ items: [1, 2] })).not.toBe(stableStringify({ items: [2, 1] }));
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify(undefined)).toBe("null");
    expect(stableStringify("plain")).toBe('"plain"');
  });

  it("falls back to String() for circular input instead of throwing", () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    expect(() => stableStringify(circular)).not.toThrow();
    expect(typeof stableStringify(circular)).toBe("string");
  });

  it("does not block distinct nested tool arguments as repetition", () => {
    const g = new LoopGuard();
    for (let i = 0; i < 6; i++) {
      expect(g.checkCall("configure", stableStringify({ config: { x: i } })).blocked).toBe(false);
    }
  });
});

describe("LoopGuard", () => {
  it("blocks the 4th identical (tool, args) call", () => {
    const g = new LoopGuard();
    const call = () => g.checkCall("bash", '{"cmd":"ls"}');
    expect(call().blocked).toBe(false);
    expect(call().blocked).toBe(false);
    expect(call().blocked).toBe(false);
    const v = call();
    expect(v.blocked).toBe(true);
    expect(v.reason).toContain("identical arguments");
  });

  it("does NOT block the same tool with different args (normal multi-file work)", () => {
    const g = new LoopGuard();
    for (let i = 0; i < 12; i++) {
      expect(g.checkCall("read_file", JSON.stringify({ path: `f${i}.ts` })).blocked).toBe(false);
    }
  });

  it("does NOT block legitimate read/edit alternation with differing args", () => {
    const g = new LoopGuard();
    let blocked = false;
    for (let i = 0; i < 8; i++) {
      const tool = i % 2 === 0 ? "read_file" : "edit_file";
      blocked ||= g.checkCall(tool, JSON.stringify({ path: `f${i}.ts` })).blocked;
    }
    expect(blocked).toBe(false);
  });

  it("blocks exact A-B-A-B ping-pong of identical calls", () => {
    const g = new LoopGuard();
    const a = () => g.checkCall("bash", '{"cmd":"a"}');
    const b = () => g.checkCall("bash", '{"cmd":"b"}');
    expect(a().blocked).toBe(false); // a×1
    expect(b().blocked).toBe(false); // b×1
    expect(a().blocked).toBe(false); // a×2
    expect(b().blocked).toBe(false); // b×2
    expect(a().blocked).toBe(false); // a×3
    expect(b().blocked).toBe(true); // window reached → ping-pong
  });
});

describe("wrapToolSetWithLoopGuard", () => {
  it("executes normally until the loop threshold, then returns a corrective result", async () => {
    let calls = 0;
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake ToolSet for the test.
    const tools: any = {
      bash: {
        description: "run",
        execute: async (input: { cmd: string }) => {
          calls++;
          return { success: true, output: `ran ${input.cmd}` };
        },
      },
    };
    // biome-ignore lint/suspicious/noExplicitAny: invoke the wrapped tool loosely (ToolSet.execute is strictly typed).
    const wrapped = wrapToolSetWithLoopGuard(tools) as any;
    const run = () => wrapped.bash.execute({ cmd: "ls" }, { toolCallId: "t", messages: [] });

    expect(await run()).toMatchObject({ success: true });
    expect(await run()).toMatchObject({ success: true });
    expect(await run()).toMatchObject({ success: true });
    const blocked = await run(); // 4th identical → blocked
    expect(blocked).toMatchObject({ success: false });
    expect((blocked as { output: string }).output).toContain("identical arguments");
    expect(calls).toBe(3); // real tool ran 3×, the 4th was short-circuited
  });

  it("passes through tools that have no execute fn", () => {
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake ToolSet.
    const tools: any = { meta: { description: "no execute" } };
    const wrapped = wrapToolSetWithLoopGuard(tools);
    expect(wrapped.meta).toEqual(tools.meta);
  });
});
