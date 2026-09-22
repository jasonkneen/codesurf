import { describe, expect, it } from "vitest";
import { extractToolResultFromOutput, getOutputKind, isOutputSuccess } from "./tool-results";

describe("extractToolResultFromOutput", () => {
  it("unwraps json and text outputs", () => {
    expect(extractToolResultFromOutput({ type: "json", value: { success: true, output: "ok" } })).toEqual(
      expect.objectContaining({ success: true, output: "ok" }),
    );
    expect(extractToolResultFromOutput({ type: "text", value: "hello" })).toEqual({ success: true, output: "hello" });
    expect(extractToolResultFromOutput({ type: "error-text", value: "nope" })).toEqual({
      success: false,
      error: "nope",
    });
  });

  it("maps error-json to a failed result that keeps its diagnostic", () => {
    // Batch/provider turns serialize a failed ToolResult as error-json
    // (see buildToolBatchMessage in agent/turns/helpers.ts).
    const result = extractToolResultFromOutput({
      type: "error-json",
      value: { success: false, error: "permission denied", output: "detail" },
    });
    expect(result).toEqual(expect.objectContaining({ success: false, error: "permission denied", output: "detail" }));
  });

  it("never reports an error-json payload as a success, whatever the payload claims", () => {
    const result = extractToolResultFromOutput({ type: "error-json", value: { success: true, output: "misleading" } });
    expect(result?.success).toBe(false);
    expect(result?.error).toBe("misleading");
  });

  it("stringifies error-json payloads that are not ToolResult-shaped", () => {
    expect(extractToolResultFromOutput({ type: "error-json", value: { code: 42 } })).toEqual({
      success: false,
      error: '{"code":42}',
    });
  });

  it("maps execution-denied to a failed result preserving the reason", () => {
    expect(extractToolResultFromOutput({ type: "execution-denied", reason: "user refused" })).toEqual({
      success: false,
      error: "user refused",
    });
    expect(extractToolResultFromOutput({ type: "execution-denied" })).toEqual({
      success: false,
      error: "Tool execution was denied.",
    });
  });

  it("returns null for shapes it does not understand", () => {
    expect(extractToolResultFromOutput(null)).toBeNull();
    expect(extractToolResultFromOutput("text")).toBeNull();
    expect(extractToolResultFromOutput({ type: "mystery" })).toBeNull();
  });
});

describe("isOutputSuccess / getOutputKind", () => {
  it("classifies denied execution and structured failures as failures", () => {
    expect(isOutputSuccess({ type: "execution-denied", reason: "user refused" })).toBe(false);
    expect(isOutputSuccess({ type: "error-json", value: {} })).toBe(false);
    expect(isOutputSuccess({ type: "error-text", value: "x" })).toBe(false);
    expect(isOutputSuccess({ type: "json", value: {} })).toBe(true);
    expect(isOutputSuccess({ type: "text", value: "x" })).toBe(true);
  });

  it("honors the success flag of a bare ToolResult", () => {
    expect(isOutputSuccess({ success: false, error: "boom" })).toBe(false);
    expect(isOutputSuccess({ success: true, output: "ok" })).toBe(true);
  });

  it("reports the wrapper kind", () => {
    expect(getOutputKind({ type: "execution-denied" })).toBe("execution-denied");
    expect(getOutputKind({ success: true })).toBe("json");
  });
});
