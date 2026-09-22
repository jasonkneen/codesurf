import type { ToolResult } from "../types/index";

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Normalize every supported tool-output shape into a ToolResult.
 *
 * Callers persist tool results and rebuild the transcript from them, so any
 * variant that returns null here is stored as its raw wrapper and later shown
 * as a generic "Error" with its diagnostic gone. The variants are the AI SDK
 * `ToolResultOutput` union (`text`, `json`, `error-text`, `error-json`,
 * `execution-denied`) plus a bare ToolResult.
 */
export function extractToolResultFromOutput(output: unknown): ToolResult | null {
  if (!output || typeof output !== "object") return null;

  if ("success" in output) {
    const result = output as ToolResult;
    return {
      success: Boolean(result.success),
      output: result.output,
      error: result.error,
      diff: result.diff,
      plan: result.plan,
      task: result.task,
      delegation: result.delegation,
      backgroundProcess: result.backgroundProcess,
      media: result.media,
      computer: result.computer,
    };
  }

  if ("type" in output && output.type === "json" && "value" in output) {
    return extractToolResultFromOutput((output as { value: unknown }).value);
  }

  if ("type" in output && output.type === "error-json" && "value" in output) {
    // A structured failure. Keep whatever ToolResult fields the payload
    // carries (batch/provider paths serialize the failed ToolResult itself),
    // but the outcome is a failure regardless of what the payload claims.
    const value = (output as { value: unknown }).value;
    const nested = extractToolResultFromOutput(value);
    if (nested) {
      return {
        ...nested,
        success: false,
        error: nested.error ?? nested.output ?? stringifyValue(value),
      };
    }
    return {
      success: false,
      error: stringifyValue(value),
    };
  }

  if ("type" in output && output.type === "execution-denied") {
    const reason = (output as { reason?: unknown }).reason;
    return {
      success: false,
      error: typeof reason === "string" && reason.trim() ? reason : "Tool execution was denied.",
    };
  }

  if ("type" in output && output.type === "error-text" && "value" in output) {
    return {
      success: false,
      error: String((output as { value: unknown }).value),
    };
  }

  if ("type" in output && output.type === "text" && "value" in output) {
    return {
      success: true,
      output: String((output as { value: unknown }).value),
    };
  }

  return null;
}

export function getOutputKind(output: unknown): string {
  if (output && typeof output === "object" && "type" in output && typeof output.type === "string") {
    return output.type;
  }
  return "json";
}

export function isOutputSuccess(output: unknown): boolean {
  if (!output || typeof output !== "object") return true;
  if ("type" in output) {
    const kind = String(output.type);
    if (kind === "execution-denied") return false;
    return !kind.startsWith("error");
  }
  if ("success" in output) return Boolean((output as { success: unknown }).success);
  return true;
}
