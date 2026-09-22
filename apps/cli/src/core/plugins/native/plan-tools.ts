// Native Cordis plugin: kernel-owned plan tools.
//
// Owns `generate_plan`, the tool plan mode is built around. Converted from the
// V1 `activate(api)` shape to an ordinary Cordis module (`name`, `inject`,
// `apply`); the only host contract it needs is `contributions`, so the fiber —
// not the loader — owns the registration and disposing it removes the tool.
//
// Why a dedicated plugin rather than inlining into agent.ts?
//   - Mirrors the pattern set by computer-tools / schedule-tools / xai-tools:
//     one plugin per cohesive tool group.
//   - The `/extensions` modal can toggle plan-mode tooling independently
//     (today the model still sees `generate_plan` in plan mode regardless,
//     but the toggle gives operators an escape hatch).
//   - Keeps the plan-mode UI contract (`result.plan` shape consumed in
//     `src/ui/app.tsx`) co-located with the tool definition.
//
// Mode filter semantics (unchanged, and enforced by the host, not here):
//   - When the kernel mode is "plan" → `generate_plan` surfaces to the model.
//   - When the kernel mode is "agent" or "ask" → it is stripped from the
//     active ToolSet by `filterToolSetByEnabled()` / `getEnabledToolSet()`.
//   - When the kernel mode is `null` (boot, tests) → the filter passes
//     through, preserving backward compat.
//
// `ai` and `zod` are the V1 file's own third-party imports, not host modules.
// `ToolSpec.tool` is deliberately `unknown` so the plugin API stays free of the
// model SDK while a plugin still hands the host a genuine AI SDK tool — which
// is what `buildEnabledToolSet()` drops straight into the model's ToolSet.

import type { CodesurfPlugin, PluginContext, PluginManifest } from "@codesurf/plugin-api";
import { tool } from "ai";
import { z } from "zod";

const manifest: PluginManifest = {
  id: "builtin.tools.plan",
  name: "Plan",
  version: "1.0.0",
  description: "Interactive implementation-plan generation for plan mode.",
  enabledByDefault: true,
  protected: true, // plan mode is unusable without it
  capabilities: ["tools"],
};

export const planToolsPlugin: CodesurfPlugin = {
  name: "codesurf-plan-tools",
  manifest,
  inject: ["contributions"],
  apply(ctx: PluginContext) {
    ctx.effect(() =>
      ctx.contributions.registerTool({
        name: "generate_plan",
        description: "Generate an interactive implementation plan with steps and optional questions.",
        group: "plan",
        modes: ["plan"],
        tool: tool({
          description:
            "Generate an interactive implementation plan with steps and optional questions for the user. The plan is displayed in a structured UI where the user can review steps and answer questions. Always use this tool when creating plans.",
          inputSchema: z.object({
            title: z.string().describe("Plan title"),
            summary: z.string().describe("Brief summary of what the plan accomplishes"),
            steps: z
              .array(
                z.object({
                  title: z.string().describe("Step title"),
                  description: z.string().describe("Detailed description of what this step involves"),
                  filePaths: z.array(z.string()).optional().describe("Files affected by this step"),
                }),
              )
              .describe("Ordered list of implementation steps"),
            questions: z
              .array(
                z.object({
                  id: z.string().describe("Unique question identifier"),
                  question: z.string().describe("The question to ask the user"),
                  header: z.string().optional().describe("Single-word tab label (e.g. 'Format', 'Storage', 'Testing')"),
                  type: z
                    .enum(["select", "multiselect", "text"])
                    .describe("Question type: select (pick one), multiselect (pick many), or text (free-form)"),
                  options: z
                    .array(
                      z.object({
                        id: z.string().describe("Option identifier"),
                        label: z.string().describe("Option display text"),
                      }),
                    )
                    .optional()
                    .describe("Options for select/multiselect questions"),
                }),
              )
              .optional()
              .describe("Questions for the user to answer before proceeding"),
          }),
          execute: async ({ title, summary, steps, questions }) => {
            // Preserve the exact return shape consumed by `src/ui/app.tsx`
            // (look for `result?.plan` on `generate_plan` tool results).
            return {
              success: true,
              output: `Plan "${title}" generated with ${steps.length} steps`,
              plan: { title, summary, steps, questions },
            };
          },
        }),
      }),
    );
  },
};
