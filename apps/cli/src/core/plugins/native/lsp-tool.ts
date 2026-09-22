// Native Cordis plugin: the `lsp` tool.
//
// Converted from the V1 `activate(api)` builtin to an ordinary Cordis module
// (`name`, `inject`, `apply`). The tool definition itself — the ai-sdk
// `tool({...})` block, its zod schema and every model-visible string — is
// carried over unchanged; only the host coupling moved from `api.services.*` to
// the `@codesurf/plugin-api` contracts (`ctx.tools`, `ctx.workspace`), and
// registration is now owned by `ctx.effect`, so disposing the fiber removes the
// tool instead of the loader doing it.
//
// Two gates worth keeping straight (don't conflate them):
//   1. `ctx.plugins.disable("builtin.tools.lsp")` — user-level toggle.
//      Drops the tool name end-to-end from the agent's ToolSet (the kernel's
//      `disabledPluginToolNames` filter strips it). Same contract as grep.
//   2. `settings.enabled && settings.tool` — runtime LSP configuration.
//      Checked lazily inside `execute` via `isLspToolEnabled()`. If the user
//      hasn't configured LSP, the tool stays visible to the model (the kernel
//      always exposes it) but `execute` returns a friendly "not enabled"
//      message instead of trying to query a nonexistent server.
//
// `isLspToolEnabled` / `queryLsp` are the same pure domain modules the V1 file
// imported: they own the language-server lifecycle and are not host API, so the
// answers this tool gives are the answers the LSP runtime itself gives.
//
// Host coupling: cwd is read lazily via `ctx.workspace.cwd()` (same pattern as
// grep) so post-`cd` drift inside bash stays correct.

import type { CodesurfPlugin, PluginContext, PluginManifest, ToolOutcome } from "@codesurf/plugin-api";
import { tool } from "ai";
import { z } from "zod";
import { isLspToolEnabled, queryLsp } from "../../../lsp/runtime";
import { LSP_TOOL_OPERATIONS } from "../../../lsp/types";

const manifest: PluginManifest = {
  id: "builtin.tools.lsp",
  name: "Language Server",
  version: "1.0.0",
  description: "LSP-driven semantic code navigation (definition, references, hover, symbols).",
  enabledByDefault: true,
  protected: false,
  capabilities: ["tools"],
};

/** Exactly the shape the zod schema parses, kept explicit as the V1 file did. */
interface LspToolInput {
  operation: (typeof LSP_TOOL_OPERATIONS)[number];
  filePath: string;
  line?: number;
  character?: number;
  query?: string;
}

export const lspToolPlugin: CodesurfPlugin = {
  name: "codesurf-lsp-tool",
  manifest,
  inject: ["contributions", "tools", "workspace"],
  apply(ctx: PluginContext) {
    ctx.effect(() =>
      ctx.contributions.registerTool({
        name: "lsp",
        description: "Query the workspace language server.",
        group: "lsp",
        tool: tool({
          description:
            "Experimental Language Server Protocol access for semantic code intelligence. Use for go-to-definition, references, hover, symbols, implementations, and call hierarchy when a matching LSP server is available.",
          inputSchema: z.object({
            operation: z.enum(LSP_TOOL_OPERATIONS).describe("The LSP operation to perform"),
            filePath: z.string().describe("The absolute or cwd-relative path to the target file"),
            line: z
              .number()
              .int()
              .min(1)
              .optional()
              .describe(
                "The 1-based line number. Required for position-based operations (definition, references, hover, implementation, callHierarchy). Not needed for documentSymbol or workspaceSymbol.",
              ),
            character: z
              .number()
              .int()
              .min(1)
              .optional()
              .describe(
                "The 1-based character offset. Required for position-based operations. Not needed for documentSymbol or workspaceSymbol.",
              ),
            query: z.string().optional().describe("Optional symbol query. Used primarily with workspaceSymbol."),
          }),
          // Wrapped at mount time, exactly as the V1 builtin wrapped at
          // activation: without this the host's pre/post/failure hooks stop
          // firing for `lsp`.
          execute: ctx.tools.wrapExecute<LspToolInput>(
            "lsp",
            async ({ operation, filePath, line, character, query }, execCtx) => {
              const cwd = ctx.workspace.cwd();
              if (!isLspToolEnabled(cwd)) {
                return {
                  success: false,
                  output:
                    "LSP tool is not enabled. Set `lsp.enabled = true` and `lsp.tool = true` in your grok settings to use semantic code intelligence.",
                };
              }
              return ctx.tools.safeExecute<ToolOutcome>({
                label: "query LSP",
                // Spread into a fresh object literal: `LspToolResponse` is an
                // interface, so it has no implicit index signature and does not
                // satisfy the structural `ToolOutcome` contract on its own. A
                // shallow copy carries every field (including the
                // `lspDiagnostics` array by reference) unchanged.
                fn: async () => ({
                  ...(await queryLsp(
                    cwd,
                    {
                      operation,
                      filePath,
                      line: line ?? 1,
                      character: character ?? 1,
                      query,
                    },
                    execCtx.abortSignal,
                  )),
                }),
              });
            },
          ),
        }),
      }),
    );
  },
};
