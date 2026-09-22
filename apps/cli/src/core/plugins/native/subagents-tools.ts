// Kernel-owned Subagents bridge tools.
//
// Phase 2 step 5 of the kernel-extensibility plan: takes the four subagent
// tools (`task`, `delegate`, `delegation_read`, `delegation_list`) out of
// `createTools()` in `src/grok/tools.ts` and into a kernel extension that
// owns the full ai-sdk `tool({...})` defs. Replaces the metadata-only
// `subagentsToolsExtension` that previously lived in `./groups.ts` (now
// removed in this same step).
//
// Host coupling:
//
//   - `src/agent/agent.ts` binds the four callbacks at Agent construction
//     via `setSubagentsSink({ runTask, runDelegation, readDelegation,
//     listDelegations })`. When the sink is unbound (e.g. headless boot
//     before an Agent is constructed, or after `shutdownPlugins()`) each
//     tool returns a friendly
//     `{ success: false, error: "Subagents bridge is not active..." }` —
//     same shape as the lsp-disabled fallback.
//
//   - The original `task` tool used a strict zod enum for `agent`, rebuilt
//     per-turn from `loadValidSubAgents()` so newly-added user subagents
//     became callable on the next turn. The kernel-owned version registers
//     once at activation, so a strict enum would freeze custom-subagent
//     visibility at boot. To preserve the original "added subagents become
//     callable on the next turn" behavior, the schema accepts any string and
//     defers name validation to the runtime (`Agent.runTaskRequest`). The
//     description hints at the built-in names plus the custom names known at
//     boot time so models still get a useful catalog.
//
//   - `delegate`, `delegation_read`, `delegation_list` were registered only
//     in agent mode by `createTools()` (gated by `if (mode === "agent")`).
//     The kernel-owned versions use `modes: ["agent"]` so the kernel mode
//     filter (`setKernelMode`) drops them at ToolSet build time in plan/ask.
//     `task` was always-on.
//
// Group: keeps the `"subagents"` group string the metadata-only extension
// used so user toggles via `services.tools.setEnabled(...)` and `/extensions`
// filters continue to work unchanged.

import type { CodesurfPlugin, PluginContext, PluginManifest } from "@codesurf/plugin-api";
import { tool } from "ai";
import { z } from "zod";
import type { ToolResult } from "../../../types/index";

const manifest: PluginManifest = {
  id: "builtin.tools.subagents",
  name: "Sub-agents & Delegation",
  version: "1.0.0",
  description: "Foreground sub-agent tasks and background delegations.",
  enabledByDefault: true,
  capabilities: ["tools"],
  // Subagents transitively reuse the parent agent's full tool surface
  // (file write, bash, network, etc.), so declare the union here.
};

const BUILTIN_TASK_AGENTS = [
  "general",
  "explore",
  "vision",
  "verify",
  "verify-detect",
  "verify-manifest",
  "computer",
] as const;

// Custom sub-agents are deliberately NOT enumerated here. This runs once at
// activation, so any name added mid-session would be missing from the frozen
// description while the per-turn CUSTOM SUB-AGENTS prompt section (rebuilt from
// `loadValidSubAgents()` every turn) already lists it — two catalogs disagreeing.
// The schema accepts any string and `Agent.runTaskRequest` validates at call
// time, so the per-turn section is the single source of truth for names.

export const subagentsToolsPlugin: CodesurfPlugin = {
  name: "codesurf-subagents-tools",
  manifest,
  inject: ["contributions", "tools", "subagents"],
  apply(ctx: PluginContext) {
    // `task` — foreground sub-agent run. Always available across modes
    // (matches the original `createTools()` behavior — registered
    // unconditionally whenever `runTask` was provided).
    ctx.effect(() =>
      ctx.contributions.registerTool({
        name: "task",
        description: "Run a foreground sub-agent task.",
        group: "subagents",
        tool: tool({
          description: `Delegate a focused foreground task to a sub-agent. Prefer this proactively for review, research, investigation, code quality work, verification, and computer-use flows instead of waiting for the user to request a sub-agent. Use \`general\` for multi-step execution, \`explore\` for fast read-only investigation, \`vision\` for image validation, \`verify\` for sandbox-aware build, test, and smoke validation, \`verify-detect\` for read-only verification recipe detection, \`verify-manifest\` to create or update a verification manifest, and \`computer\` for host desktop screenshot/input workflows. Custom sub-agents configured by the user are listed in the CUSTOM SUB-AGENTS section of your system prompt and may be passed by exact name. Provide a short description plus a detailed prompt for the child agent.`,
          inputSchema: z.object({
            // Schema accepts any string (vs the original strict zod.enum) so
            // newly-added user subagents become callable on the next turn —
            // see file header for context.
            agent: z
              .string()
              .default("general")
              .describe(
                `Which sub-agent to use. Built-ins: ${BUILTIN_TASK_AGENTS.join(", ")}. Custom subagents from user settings are also accepted.`,
              ),
            description: z
              .string()
              .describe("A short label for the delegated task, such as 'Deep code quality analysis'"),
            prompt: z.string().describe("Detailed instructions for the sub-agent to complete"),
          }),
          execute: ctx.tools.wrapExecute<{ agent: string; description: string; prompt: string }>(
            "task",
            async ({ agent, description, prompt }, execCtx) =>
              (await ctx.subagents.runTask({ agent, description, prompt }, execCtx?.abortSignal)) as ToolResult,
          ),
        }),
      }),
    );

    // `delegate` — background read-only delegation. Agent-mode only.
    ctx.effect(() =>
      ctx.contributions.registerTool({
        name: "delegate",
        description: "Create a background delegation.",
        group: "subagents",
        modes: ["agent"],
        tool: tool({
          description:
            "Start a background `explore` agent and return immediately with a delegation id — NOT its findings. The result does not exist in this turn; you are notified on a later turn and read it with delegation_read(id). Use this only when you can keep making progress without the answer; if you need the findings to respond, use `task` instead. The agent is instructed to research only, but it does have shell access, so do not delegate anything you would not want run.",
          inputSchema: z.object({
            agent: z
              .enum(["explore"])
              .default("explore")
              .describe("Background delegations currently support only the read-only explore agent"),
            description: z.string().describe("A short label for the delegation, such as 'OAuth callback research'"),
            prompt: z.string().describe("Detailed instructions for the background agent to complete"),
          }),
          execute: ctx.tools.wrapExecute<{ agent: "explore"; description: string; prompt: string }>(
            "delegate",
            async ({ agent, description, prompt }, execCtx) =>
              (await ctx.subagents.runDelegation({ agent, description, prompt }, execCtx?.abortSignal)) as ToolResult,
          ),
        }),
      }),
    );

    // `delegation_read` — read saved delegation output. Agent-mode only.
    ctx.effect(() =>
      ctx.contributions.registerTool({
        name: "delegation_read",
        description: "Read the status/output of a delegation.",
        group: "subagents",
        modes: ["agent"],
        tool: tool({
          description:
            "Read the saved output of a background delegation by ID. Use this after a completion notice or when revisiting prior research.",
          inputSchema: z.object({
            id: z
              .string()
              .describe(
                "The delegation ID returned by delegate(), e.g. 'calm-blue-fox-9a3f2b71' (adjective-color-animal-8hex). Ids that do not match that shape are rejected.",
              ),
          }),
          execute: async ({ id }) => {
            return (await ctx.subagents.readDelegation(id)) as ToolResult;
          },
        }),
      }),
    );

    // `delegation_list` — list delegations. Agent-mode only.
    ctx.effect(() =>
      ctx.contributions.registerTool({
        name: "delegation_list",
        description: "List delegations in this session.",
        group: "subagents",
        modes: ["agent"],
        tool: tool({
          description:
            "List recent background delegations for the current project. Use sparingly to discover IDs or review prior results, not for repeated polling.",
          inputSchema: z.object({}),
          execute: async () => {
            return (await ctx.subagents.listDelegations()) as ToolResult;
          },
        }),
      }),
    );
  },
};
