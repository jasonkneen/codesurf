// PTC tool presentation ("code" / "both") for the codesurf engine.
//
// Presentation-only: the tool registry, policy stack, and session log stay on
// the host plane. Under `code` the model's wire tool list is exactly `run_code`
// plus a generated SDK section in the system prompt; every native tool remains
// reachable as a binding the program calls. Sub-calls run through the SAME
// native tool `execute` closures that native turns use (approval wrappers and
// the loop-guard are already inside them), so dispatch is same-pipeline by
// construction — no second execution path. See docs/architecture/phase1-agent-gateway.md.

import type { CodeBindingNamespace, CodeRunRequest, CodeRunResult } from "@deepseek-ai/dsh-code-runtime";
import { type ToolSet, tool } from "ai";
import { z } from "zod";

export type ToolPresentation = "native" | "code" | "both";

/** The reserved transport tool name. The only model-callable tool under `code`. */
export const RUN_CODE_TOOL = "run_code";

/** The execution seam: runs one model-written program against host bindings. */
export type CodeRunner = (request: CodeRunRequest) => Promise<CodeRunResult>;

const runCodeInputSchema = z.object({
  code: z
    .string()
    .describe(
      "The body of an async function (top-level await and return work; the completion value becomes the result).",
    ),
  description: z
    .string()
    .describe("A short human-facing summary of what the program does (used as the call's UI label)."),
});

/** One line of the SDK per visible native tool, in deterministic order. */
function sdkToolLine(name: string, def: { description?: string; inputSchema?: unknown }): string {
  const args = summarizeArgs(def.inputSchema);
  const description = (def.description ?? "").split("\n")[0] ?? "";
  return `- ${name}: ${description || "(no description)"}${args ? `\n  args: ${args}` : ""}`;
}

/** Compact zod-shape summary for the SDK; degrades to `unknown` per construct. */
function summarizeArgs(inputSchema: unknown): string {
  const shape = (inputSchema as { shape?: Record<string, unknown> } | undefined)?.shape;
  if (!shape || typeof shape !== "object") return "";
  const fields = Object.entries(shape)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, schema]) => `${key}: ${zodTypeName(schema)}`)
    .join(", ");
  return `{ ${fields} }`;
}

function zodTypeName(schema: unknown): string {
  const value = schema as { _def?: unknown; typeName?: string } | undefined;
  const def = value?._def as
    | {
        type?: string;
        typeName?: string;
        innerType?: unknown;
        element?: unknown;
        options?: unknown[];
        value?: unknown;
      }
    | undefined;
  const kind = (def?.type ?? def?.typeName ?? value?.typeName ?? "").toLowerCase();
  const inner = def?.innerType ?? def?.element;
  switch (kind) {
    case "zodstring":
    case "zodenum":
    case "string":
    case "enum":
      return "string";
    case "zodnumber":
    case "zodinteger":
    case "number":
    case "integer":
      return "number";
    case "zodboolean":
    case "boolean":
      return "boolean";
    case "zodarray":
    case "array":
      return `${zodTypeName(inner)}[]`;
    case "zodobject":
    case "object":
      return "object";
    case "zodrecord":
    case "record":
      return "record<string, unknown>";
    case "zodoptional":
    case "zodnullable":
    case "zodnull":
    case "optional":
    case "nullable":
    case "null":
      return zodTypeName(inner);
    case "zodunion":
    case "union":
      return (def?.options as unknown[])?.map(zodTypeName).join(" | ") || "unknown";
    case "zodliteral":
    case "literal":
      return JSON.stringify(def?.value);
    case "zodunknown":
    case "unknown":
    case "any":
      return "unknown";
    default:
      return kind.replace(/^zod/, "").trim() || "unknown";
  }
}

/** The SDK usage-instructions block (TS flavor). Keep byte-stable for caching. */
const SDK_INSTRUCTIONS = `## Writing code for run_code

run_code takes two required arguments: code — the body of an async function (top-level await and return work) — and description, a short summary of what the program does. Inside the program:

- Call tools as await tools.name(args). Every call resolves to that tool's result. Tool arguments must be JSON values.
- A FAILED tool call rejects with ToolCallError, whose toolName identifies the failed tool and whose message is human-readable — try/catch it to handle and continue.
- Independent read-only calls MAY overlap under Promise.all (safe calls run concurrently; mutating calls run alone, in submission order). Sequence dependent work with await.
- Emit results with return and/or console.log(...). Only what you print or return is program output; every other intermediate result stays out of the conversation, so extract just what you need.`;

/**
 * Render the SDK system-prompt section for a native tool set.
 *
 * Lexicographic tool order and fixed instruction text keep the section
 * byte-stable for a given tool set (request-prefix cache friendly).
 */
export function renderSdkSection(tools: ToolSet): string {
  const lines = Object.entries(tools)
    .map(([name, def]) => ({ name, def }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name, def }) => sdkToolLine(name, def));
  return `${SDK_INSTRUCTIONS}

The available tools:

${lines.join("\n") || "(no native tools)"}`;
}

interface PresentOptions {
  tools: ToolSet;
  presentation: ToolPresentation;
  runner: CodeRunner;
}

interface Presented {
  /** The ToolSet the model sees on the wire. */
  tools: ToolSet;
  /** SDK section to append to the system prompt (undefined under `native`). */
  sdkSection: string | undefined;
}

function buildBindingNamespace(tools: ToolSet, signal: AbortSignal | undefined): CodeBindingNamespace {
  const functions: CodeBindingNamespace["functions"] = {};
  for (const [name, def] of Object.entries(tools)) {
    functions[name] = (async (args: unknown) => {
      const execute = def.execute as ((input: unknown, options?: unknown) => unknown) | undefined;
      if (typeof execute !== "function") {
        throw new Error(`${name}: no execute implementation`);
      }
      // Sub-calls traverse the same native execute closures (approval + loop
      // guard included); a policy denial rejects and surfaces in the program.
      // Native executes only read options.abortSignal; the SDK's full options
      // object is not available at binding time.
      return execute(args, { abortSignal: signal });
    }) as CodeBindingNamespace["functions"][string];
  }
  return {
    global: "tools",
    functions,
    errorClass: { name: "ToolCallError", memberNameProperty: "toolName" },
  };
}

function buildRunCodeTool(tools: ToolSet, runner: CodeRunner) {
  return tool({
    description: `Execute a TypeScript program that composes the available tools, returning only what it prints or returns. Takes two required arguments: code and description.`,
    inputSchema: runCodeInputSchema,
    execute: async (args: { code: string; description: string }, options?: { abortSignal?: AbortSignal }) => {
      const signal = options?.abortSignal;
      const result = await runner({
        program: args.code,
        bindings: [buildBindingNamespace(tools, signal)],
        ...(signal ? { signal } : {}),
      });
      if (result.error) {
        const logs = result.logs.length > 0 ? `\nCaptured output:\n${result.logs.join("\n")}` : "";
        throw new Error(`code run failed (${result.error.kind}): ${result.error.message}${logs}`);
      }
      return { logs: result.logs, result: result.value };
    },
  });
}

/** Present a native tool set per the session presentation mode. */
export function presentToolSet(options: PresentOptions): Presented {
  const { tools, presentation, runner } = options;
  if (presentation === "native") {
    return { tools, sdkSection: undefined };
  }
  const runCodeTool = buildRunCodeTool(tools, runner);
  const wireTools: ToolSet =
    presentation === "code" ? { [RUN_CODE_TOOL]: runCodeTool } : { ...tools, [RUN_CODE_TOOL]: runCodeTool };
  return { tools: wireTools, sdkSection: renderSdkSection(tools) };
}

let defaultPresentation: ToolPresentation = "native";

/** Set the deployment/session default presentation (API + CLI call this). */
export function setDefaultPresentation(presentation: ToolPresentation): void {
  defaultPresentation = presentation;
}

/** Resolution order: explicit option, module default, environment, native. */
export function resolvePresentation(option?: ToolPresentation): ToolPresentation {
  if (option === "code" || option === "both") return option;
  if (defaultPresentation === "code" || defaultPresentation === "both") return defaultPresentation;
  const fromEnv = process.env.CODESURF_TOOL_PRESENTATION;
  if (fromEnv === "code" || fromEnv === "both") return fromEnv;
  return "native";
}
