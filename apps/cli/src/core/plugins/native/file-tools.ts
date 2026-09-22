// Kernel-owned file-tools extension.
//
// Phase 2 #3 + #4 migration of the kernel-extensibility plan. All three names
// (`read_file`, `write_file`, `edit_file`) are now fully kernel-owned: the
// ai-sdk `tool({...})` definitions live here and are merged into the agent's
// ToolSet via `getEnabledToolSet()`. The Agent's `createTools()` factory no
// longer registers any of them.
//
// Mode gating
//   - `read_file` is always available — no `modes` field set.
//   - `write_file` and `edit_file` are gated to `modes: ["agent"]`. The
//     kernel's mode filter (loader.ts:setKernelMode + isModeFilteredOut)
//     hides them in plan/ask modes at the active-ToolSet level rather than
//     at registration time. `/extensions` always lists the same catalog.
//
// Why one extension for all three?
//   - One toggle (`builtin.tools.file`) governs all three names — same
//     pre-migration UX. The kernel's `disabledPluginToolNames` filter
//     strips by NAME, so disabling this extension drops all three end-to-end.
//
// Host coupling: cwd is read lazily through `deps.cwd()` (same pattern as
// grep/lsp) so post-`cd` drift inside bash stays correct. The definitions are
// built by a factory rather than inline so the Agent can rebuild them bound to
// a CHILD cwd for sub-agent runs — otherwise a sub-agent's relative paths
// resolved against the parent's (drifting) cwd while its shell ran somewhere
// else. See `agent.ts` `buildTurnToolset`'s `bashOverride` for the same pattern.

import type { CodesurfPlugin, PluginContext, PluginManifest, ToolsService } from "@codesurf/plugin-api";
import { type Tool as AiTool, tool as aiTool } from "ai";
import { isAbsolute, resolve } from "path";
import { z } from "zod";
import { editFile, readFile, writeFile, writePathRequiresApproval } from "../../../tools/file";
import type { AgentMode } from "../../../types/index";
import { loadEditApprovalMode, type SandboxMode, saveEditApprovalMode } from "../../../utils/settings";
import { getEditApprovalSessionState, shouldAutoApproveEdit } from "../builtin/file-tools-approval";

const manifest: PluginManifest = {
  id: "builtin.tools.file",
  name: "File I/O",
  version: "1.0.0",
  description: "Read, write, and edit files on disk.",
  enabledByDefault: true,
  protected: true, // file access is load-bearing for coding agents
  capabilities: ["tools", "commands"],
};

/** Accessors resolved at execute-time, never captured once. */
export interface FileToolDeps {
  cwd: () => string;
  /** Just the hook wrapper; supplying it is what keeps user hooks firing. */
  hooks: () => Pick<ToolsService, "wrapExecute">;
  /**
   * The live bash sandbox mode, which decides whether writes may leave the
   * workspace. Undefined (or an accessor returning undefined) falls back to
   * the settings-derived mode.
   */
  sandboxMode?: () => SandboxMode | undefined;
}

export interface FileToolDefinition {
  name: string;
  description: string;
  group: string;
  modes?: AgentMode[];
  tool: AiTool;
}

/**
 * Build the three file-group tool definitions bound to a specific cwd provider.
 * The extension registers these against the kernel workspace cwd; the Agent
 * rebuilds them against a child cwd for sub-agent / verify turns.
 */
export function createFileToolDefinitions(deps: FileToolDeps): FileToolDefinition[] {
  // Approval gate: bypassed when editApproval === "accept-all" (default), or
  // when the user has already accepted this session / this path — except for
  // writes outside the workspace (or to a shell rc file), which always ask.
  const needsApproval = ({ path }: { path: string }): boolean => {
    try {
      const cwd = deps.cwd();
      const abs = isAbsolute(path) ? path : resolve(cwd, path);
      return !shouldAutoApproveEdit(abs) || writePathRequiresApproval(abs, cwd);
    } catch {
      return false;
    }
  };
  const writeOptions = () => ({ sandboxMode: deps.sandboxMode?.() });

  return [
    {
      name: "read_file",
      description: "Read a file from the workspace.",
      group: "file",
      tool: aiTool({
        description:
          "Read the contents of a file. Returns numbered lines with a header showing the returned range; the total line count is reported only when the whole file was scanned. Use start_line/end_line to read specific sections of large files iteratively.",
        inputSchema: z.object({
          path: z.string().describe("File path (relative to cwd or absolute)"),
          start_line: z.number().optional().describe("First line to read (1-indexed, default: 1)"),
          end_line: z.number().optional().describe("Last line to read (inclusive, default: end of file)"),
        }),
        execute: deps
          .hooks()
          .wrapExecute<{ path: string; start_line?: number; end_line?: number }>(
            "read_file",
            async ({ path, start_line, end_line }, ctx) =>
              readFile(path, deps.cwd(), start_line, end_line, { signal: ctx?.abortSignal }),
          ),
      }),
    },
    {
      name: "write_file",
      description: "Write a file to the workspace.",
      group: "file",
      modes: ["agent"],
      tool: aiTool({
        description:
          "Create or overwrite a file with the given content. Use for creating new files or completely rewriting existing ones. Returns a diff of the changes.",
        inputSchema: z.object({
          path: z.string().describe("File path (relative to cwd or absolute)"),
          content: z.string().describe("The full file content to write"),
        }),
        needsApproval,
        execute: deps
          .hooks()
          .wrapExecute<{ path: string; content: string }>("write_file", async ({ path, content }) =>
            writeFile(path, content, deps.cwd(), writeOptions()),
          ),
      }),
    },
    {
      name: "edit_file",
      description: "Apply a patch to an existing file.",
      group: "file",
      modes: ["agent"],
      tool: aiTool({
        description:
          "Edit a file by replacing a unique string with new content. The old_string must appear exactly once in the file. Include enough surrounding context lines in old_string to make it unique. Returns a diff of the changes.",
        inputSchema: z.object({
          path: z.string().describe("File path (relative to cwd or absolute)"),
          old_string: z.string().describe("The exact text to find (must be unique in the file)"),
          new_string: z.string().describe("The replacement text"),
        }),
        needsApproval,
        execute: deps
          .hooks()
          .wrapExecute<{ path: string; old_string: string; new_string: string }>(
            "edit_file",
            async ({ path, old_string, new_string }) =>
              editFile(path, old_string, new_string, deps.cwd(), writeOptions()),
          ),
      }),
    },
  ];
}

export const fileToolsPlugin: CodesurfPlugin = {
  name: "codesurf-file-tools",
  manifest,
  inject: ["contributions", "tools", "workspace", "chat", "bash"],
  apply(ctx: PluginContext) {
    const definitions = createFileToolDefinitions({
      cwd: () => ctx.workspace.cwd(),
      // The bash plugin owns the live mode (it can change mid-session); when
      // no shell is bound, fall back to the settings-derived mode.
      sandboxMode: () => {
        try {
          const mode = ctx.bash.getSandboxMode();
          return mode === "off" || mode === "shuru" ? mode : undefined;
        } catch {
          return undefined;
        }
      },
      // The tool factory wants the host's hook surface; wrapExecute is the
      // contract's equivalent and is what keeps user hooks firing.
      hooks: () => ({ wrapExecute: ctx.tools.wrapExecute.bind(ctx.tools) }),
    });
    for (const def of definitions) {
      ctx.effect(() =>
        ctx.contributions.registerTool({
          name: def.name,
          description: def.description,
          group: def.group,
          ...(def.modes ? { modes: def.modes } : {}),
          tool: def.tool,
        }),
      );
    }

    // /edits — surface and toggle the edit-approval policy.
    ctx.effect(() =>
      ctx.contributions.registerCommand({
        name: "/edits",
        description: "Show or change the edit-approval policy (ask | auto | status).",
        argsHint: "[ask|auto|status]",
        handler: ({ args }) => {
          const sub = args.trim().toLowerCase().split(/\s+/)[0] ?? "";
          if (sub === "" || sub === "status") {
            const mode = loadEditApprovalMode();
            const session = getEditApprovalSessionState();
            const lines = [
              `Edit approval: **${mode}**${mode === "accept-all" ? " (write_file / edit_file run without prompting)" : " (every write/edit pauses for an Accept/Reject panel)"}`,
              session.acceptAll
                ? "Session override: accept-all (this session)"
                : session.approvedPaths.length > 0
                  ? `Session-approved paths (${session.approvedPaths.length}): ${session.approvedPaths.join(", ")}`
                  : "Session overrides: none",
            ];
            ctx.chat.appendAssistant(lines.join("\n"));
            return;
          }
          if (sub === "ask" || sub === "ask-always") {
            saveEditApprovalMode("ask-always");
            ctx.chat.appendAssistant(
              "Edit approval -> **ask-always**. Every write_file / edit_file will pause for an inline approval panel.",
            );
            return;
          }
          if (sub === "auto" || sub === "accept-all" || sub === "accept" || sub === "off") {
            saveEditApprovalMode("accept-all");
            ctx.chat.appendAssistant("Edit approval -> **accept-all**. Edits will apply immediately.");
            return;
          }
          ctx.chat.appendAssistant("Usage: /edits ask | auto | status");
        },
      }),
    );
  },
};
