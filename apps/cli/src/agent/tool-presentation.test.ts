import { type ToolSet, tool } from "ai";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { disposeCodeRuntimeService, getCodeRuntimeService } from "../core/code-runtime";
import {
  type CodeRunner,
  presentToolSet,
  RUN_CODE_TOOL,
  renderSdkSection,
  resolvePresentation,
  setDefaultPresentation,
} from "./tool-presentation";

function nativeTools(overrides: Record<string, () => unknown> = {}): ToolSet {
  const alphaExec = overrides.alpha ?? (() => ({ value: 10 }));
  const betaExec = overrides.beta ?? (() => ({ value: 20 }));
  return {
    alpha: tool({
      description: "Alpha tool",
      inputSchema: z.object({ x: z.number().optional() }),
      execute: async (_args: { x?: number }) => alphaExec(),
    }),
    beta: tool({
      description: "Beta tool",
      inputSchema: z.object({ x: z.number().optional() }),
      execute: async (_args: { x?: number }) => betaExec(),
    }),
  } as ToolSet;
}

const noopRunner: CodeRunner = async () => ({ logs: [], value: undefined });

afterAll(async () => {
  await disposeCodeRuntimeService();
});

describe("presentToolSet", () => {
  it("collapses the wire to exactly run_code under 'code' and keeps bindings native", () => {
    const native = nativeTools();
    const presented = presentToolSet({ tools: native, presentation: "code", runner: noopRunner });
    expect(Object.keys(presented.tools).sort()).toEqual([RUN_CODE_TOOL]);
    expect(presented.sdkSection).toBeDefined();
    expect(presented.sdkSection).toContain("run_code");
  });

  it("offers native plus run_code under 'both'", () => {
    const native = nativeTools();
    const presented = presentToolSet({ tools: native, presentation: "both", runner: noopRunner });
    expect(Object.keys(presented.tools).sort()).toEqual(["alpha", "beta", RUN_CODE_TOOL]);
    expect(presented.sdkSection).toBeDefined();
  });

  it("leaves the wire untouched under 'native'", () => {
    const native = nativeTools();
    const presented = presentToolSet({ tools: native, presentation: "native", runner: noopRunner });
    expect(Object.keys(presented.tools).sort()).toEqual(["alpha", "beta"]);
    expect(presented.sdkSection).toBeUndefined();
  });
});

describe("renderSdkSection", () => {
  it("lists every native tool in lexicographic order with arg types", () => {
    const section = renderSdkSection(nativeTools());
    const alphaAt = section.indexOf("- alpha:");
    const betaAt = section.indexOf("- beta:");
    expect(alphaAt).toBeGreaterThan(0);
    expect(betaAt).toBeGreaterThan(alphaAt);
    expect(section).toContain("args: { x: number }");
    expect(section).toContain("await tools.name(args)");
  });

  it("is byte-stable for the same tool set", () => {
    const a = renderSdkSection(nativeTools());
    const b = renderSdkSection(nativeTools());
    expect(a).toBe(b);
  });
});

describe("resolvePresentation", () => {
  it("honours explicit, then module default, then env, then native", () => {
    const prior = process.env.CODESURF_TOOL_PRESENTATION;
    delete process.env.CODESURF_TOOL_PRESENTATION;
    setDefaultPresentation("native");
    expect(resolvePresentation("code")).toBe("code");
    expect(resolvePresentation()).toBe("native");
    setDefaultPresentation("both");
    expect(resolvePresentation()).toBe("both");
    process.env.CODESURF_TOOL_PRESENTATION = "code";
    setDefaultPresentation("native");
    expect(resolvePresentation()).toBe("code");
    if (prior === undefined) delete process.env.CODESURF_TOOL_PRESENTATION;
    else process.env.CODESURF_TOOL_PRESENTATION = prior;
    setDefaultPresentation("native");
  });
});

type UnwrappedExecute = (input: unknown, options?: { abortSignal?: AbortSignal }) => Promise<unknown>;

async function invokeRunCode(runCode: ToolSet[string], input: { code: string; description: string }): Promise<unknown> {
  const execute = runCode.execute as unknown as UnwrappedExecute;
  return execute(input, { abortSignal: undefined });
}

describe("run_code over the real worker runtime", () => {
  it("composes two native bindings in one program and returns curated output", async () => {
    const native = nativeTools();
    const presented = presentToolSet({
      tools: native,
      presentation: "code",
      runner: async (request) => (await getCodeRuntimeService()).run(request),
    });
    const runCode = presented.tools[RUN_CODE_TOOL];
    expect(runCode).toBeDefined();
    const output = await invokeRunCode(runCode as ToolSet[string], {
      code: `const a = await tools.alpha({ x: 1 });
const b = await tools.beta({ x: 2 });
return { a, b };`,
      description: "compose two tools",
    });
    expect(output).toEqual({ logs: [], result: { a: { value: 10 }, b: { value: 20 } } });
  });

  it("surfaces a rejected binding to the program as a typed error", async () => {
    const native = nativeTools({
      alpha: () => {
        throw new Error("denied by policy");
      },
    });
    const presented = presentToolSet({
      tools: native,
      presentation: "code",
      runner: async (request) => (await getCodeRuntimeService()).run(request),
    });
    const runCode = presented.tools[RUN_CODE_TOOL];
    const output = await invokeRunCode(runCode as ToolSet[string], {
      code: `try { await tools.alpha({}); return { ok: false } } catch (e) { return { ok: true, name: e.constructor.name, tool: e.toolName, message: String(e.message) } }`,
      description: "catch a rejection",
    });
    const value = (output as { result: Record<string, unknown> }).result;
    expect(value.ok).toBe(true);
    expect(value.tool).toBe("alpha");
  });
});
