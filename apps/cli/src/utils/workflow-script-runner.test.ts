import { describe, expect, it, vi } from "vitest";
import { parseJsonResult, runWorkflowScript, stripWorkflowMeta } from "./workflow-script-runner";

describe("stripWorkflowMeta", () => {
  it("removes the export const meta block including nested braces/strings", () => {
    const src = `export const meta = { name: "x", phases: [{ title: "a }not-a-brace" }] }\nconst y = 1\nreturn y`;
    const out = stripWorkflowMeta(src);
    expect(out).not.toContain("export const meta");
    expect(out).toContain("const y = 1");
    expect(out).toContain("return y");
  });

  it("neutralises stray export keywords", () => {
    const src = `export const meta = {}\nexport const helper = 2\nreturn helper`;
    const out = stripWorkflowMeta(src);
    expect(out).not.toMatch(/(^|\n)\s*export\s/);
    expect(out).toContain("const helper = 2");
  });
});

describe("parseJsonResult", () => {
  it("parses a fenced json block", () => {
    expect(parseJsonResult('prose\n```json\n{"solved":true}\n```\nmore')).toEqual({ solved: true });
  });
  it("parses a bare balanced object", () => {
    expect(parseJsonResult('here: {"a":1} done')).toEqual({ a: 1 });
  });
  it("returns null on unparseable text", () => {
    expect(parseJsonResult("no json here")).toBeNull();
  });
});

describe("runWorkflowScript", () => {
  it("injects args/phase/agent/log and returns the body's value", async () => {
    const phases: string[] = [];
    const logs: string[] = [];
    const runAgent = vi.fn(async (prompt: string) => `echo:${prompt}`);
    const src = `export const meta = { name: "t" }
phase("Start")
log("working")
const out = await agent("hi " + args, { label: "l" })
return { out }`;
    const result = (await runWorkflowScript({
      source: src,
      args: "world",
      runAgent,
      onPhase: (t) => phases.push(t),
      onLog: (m) => logs.push(m),
    })) as { out: string };
    expect(result.out).toBe("echo:hi world");
    expect(phases).toEqual(["Start"]);
    expect(logs).toEqual(["working"]);
  });

  it("augments the prompt with the schema and parses the json result", async () => {
    let seenPrompt = "";
    const runAgent = vi.fn(async (prompt: string) => {
      seenPrompt = prompt;
      return '```json\n{"solved":false,"blocker":"x"}\n```';
    });
    const src = `export const meta = {}
const r = await agent("do it", { schema: { type: "object" } })
return r`;
    const result = await runWorkflowScript({ source: src, args: "", runAgent });
    expect(seenPrompt).toContain("JSON schema");
    expect(result).toEqual({ solved: false, blocker: "x" });
  });

  it("returns null from a schema call when the model returns no json", async () => {
    const runAgent = vi.fn(async () => "sorry, I cannot");
    const src = `export const meta = {}
return await agent("x", { schema: {} })`;
    expect(await runWorkflowScript({ source: src, args: "", runAgent })).toBeNull();
  });
});
