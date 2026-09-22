// Native Cordis plugin: the kernel-owned `grep` tool.
//
// Ripgrep-powered content search. The tool definition itself is unchanged from
// the V1 builtin — same ai-sdk `tool({...})`, same description, same input
// schema, same body — because that text is prompt surface the model reads and
// the schema is the contract it calls against.
//
// Converted from the V1 `activate(api)` shape to an ordinary Cordis module
// (`name`, `inject`, `apply`). Two host services are needed and both come from
// `@codesurf/plugin-api`:
//
//   * `tools.wrapExecute` — runs the host's Pre/PostToolUse hooks around every
//     invocation. Dropping it would silently stop user hooks firing for `grep`,
//     so the wrapper stays exactly where V1 put it.
//   * `workspace.cwd()` — read lazily *inside* execute, not captured at mount:
//     the agent's cwd drifts from `process.cwd()` after a `cd` in the bash tool,
//     and the search must follow it.
//
// `executeGrep` is a pure domain module (child_process + fs only), imported
// directly exactly as the V1 builtin did, so the search behaviour is the same
// code path.
//
// Group: keeps the same `"grep"` group string, so existing `/extensions`
// filters and any user toggles via `tools.setEnabled("grep", …)` continue to
// work unchanged. Registration is owned by `ctx.effect`, so unmounting the
// fiber removes the tool.

import type {
  CodesurfPlugin,
  PluginContext,
  PluginManifest,
  ToolExecutionContext,
  ToolOutcome,
} from "@codesurf/plugin-api";
import { tool } from "ai";
import { z } from "zod";
import { executeGrep } from "../../../tools/grep";

const manifest: PluginManifest = {
  id: "builtin.tools.grep",
  name: "Grep",
  version: "1.0.0",
  description: "Ripgrep-powered content search.",
  enabledByDefault: true,
  capabilities: ["tools"],
};

interface GrepToolInput {
  pattern: string;
  path?: string;
  include?: string;
}

export const grepToolPlugin: CodesurfPlugin = {
  name: "codesurf-grep-tool",
  manifest,
  inject: ["contributions", "tools", "workspace"],
  apply(ctx: PluginContext) {
    ctx.effect(() =>
      ctx.contributions.registerTool({
        name: "grep",
        description: "Search file contents with ripgrep.",
        group: "grep",
        tool: tool({
          description:
            'Fast content search tool that works with any codebase size. Searches file contents using regular expressions. Supports full regex syntax (e.g. "log.*Error", "function\\s+\\w+"). Filter files by pattern with the include parameter (e.g. "*.js", "*.{ts,tsx}"). Returns matching file paths and line numbers sorted by modification time. Use this tool when you need to find files containing specific patterns. If you need to count matches within files, use bash with `rg` directly.',
          inputSchema: z.object({
            pattern: z.string().describe("The regex pattern to search for in file contents"),
            path: z
              .string()
              .optional()
              .describe("The directory or file to search in. Defaults to the current working directory."),
            include: z
              .string()
              .optional()
              .describe('File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")'),
          }),
          execute: ctx.tools.wrapExecute<GrepToolInput>(
            "grep",
            async ({ pattern, path, include }, execCtx: ToolExecutionContext) =>
              // Type-only widening: `ToolResult` is an interface, so TypeScript
              // gives it no implicit index signature and it is not assignable to
              // the plugin API's `ToolOutcome` (which declares one). The object
              // is passed through untouched — the host receives exactly what
              // `executeGrep` returned, as it did in V1.
              (await executeGrep({ pattern, path, include }, ctx.workspace.cwd(), execCtx?.abortSignal)) as ToolOutcome,
          ),
        }),
      }),
    );
  },
};
