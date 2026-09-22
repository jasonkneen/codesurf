// Native Cordis plugin: the kernel-owned `ask_user_structured` tool.
//
// Gives the model a structured way to ask the user a multiple-choice
// question (or several) mid-turn and get the answer back. Mirrors the
// pattern set by plan-tools.ts (generate_plan) but targets the agent/ask
// working modes rather than plan mode.
//
// UI contract:
//   The tool call is intercepted in `src/ui/hooks/use-turn-engine.ts` (next to
//   the TodoWrite interceptor) and mapped into `pendingQuestionnaire`, which
//   renders the already-wired `QuestionnaireTabs` control in
//   MessageList.trailingSlot.
//   When the user finishes answering, that surface submits a follow-up
//   "Answered: ..." message, so the answers arrive on the model's next turn.
//   This tool's own result therefore just acknowledges that the questions
//   were presented — it does NOT block for the answer.
//
// Mode filter semantics mirror generate_plan: surfaced in agent + ask modes,
// stripped elsewhere; a null kernel mode (boot, tests) passes through.
//
// Converted from the V1 `activate(api)` shape to an ordinary Cordis module
// (`name`, `inject`, `apply`). It needs no host service at all — only the
// contribution registry — so the whole plugin is one `ctx.effect` that owns the
// registration; disposing the fiber removes the tool. `ai` and `zod` are the
// same model-facing libraries the V1 builtin imported: the tool definition and
// its schema are unchanged, so the model sees exactly the same tool.
//
// Deliberately NOT wrapped in `ctx.tools.wrapExecute`: the V1 builtin handed
// `api.registerTool` a raw `ai` tool object with no hook wrapping, so wrapping
// it here would start firing pre/post/failure hooks that never fired for this
// tool before — a behaviour change, not a conversion. The body is pure anyway
// (it formats a sentence; the questionnaire is rendered by the UI interceptor
// above), so there is nothing for a hook to guard.

import type { CodesurfPlugin, PluginContext, PluginManifest } from "@codesurf/plugin-api";
import { tool } from "ai";
import { z } from "zod";

// `protected` is deliberately absent, as it was in the V1 manifest: the ask
// tool is a convenience, so users may disable it from `/extensions`.
const manifest: PluginManifest = {
  id: "builtin.tools.ask",
  name: "Ask",
  version: "1.0.0",
  description: "Structured multiple-choice questions for the user, mid-turn.",
  enabledByDefault: true,
  capabilities: ["tools"],
};

export const askToolsPlugin: CodesurfPlugin = {
  name: "codesurf-ask-tools",
  manifest,
  inject: ["contributions"],
  apply(ctx: PluginContext) {
    ctx.effect(() =>
      ctx.contributions.registerTool({
        name: "ask_user_structured",
        description: "Ask the user one or more multiple-choice questions and wait for their answer.",
        group: "ask",
        modes: ["agent", "ask"],
        tool: tool({
          description:
            "Ask the user one or more multiple-choice questions when you need a decision before proceeding. " +
            "Each question is shown as a tab with selectable options; the user's answers arrive as a follow-up " +
            "message on your next turn, so after calling this tool you should stop and wait rather than guessing. " +
            "Prefer this over free-form questions when the choices are well-defined. Mark the safest/default option " +
            "as recommended.",
          inputSchema: z.object({
            title: z.string().optional().describe("Optional overall title shown above the questions"),
            questions: z
              .array(
                z.object({
                  id: z.string().describe("Unique question identifier"),
                  header: z.string().describe("Short tab label (1-2 words, e.g. 'Scope', 'Storage')"),
                  prompt: z.string().describe("The question to ask the user"),
                  options: z
                    .array(
                      z.object({
                        id: z.string().optional().describe("Option identifier"),
                        label: z.string().describe("Option display text"),
                        description: z.string().optional().describe("Optional one-line explanation of this option"),
                        recommended: z.boolean().optional().describe("Mark the recommended/default option"),
                      }),
                    )
                    .min(2)
                    .describe("The choices for this question (at least two)"),
                }),
              )
              .min(1)
              .describe("One or more questions to present to the user"),
          }),
          execute: async ({ title, questions }) => {
            const count = questions.length;
            return {
              success: true,
              output:
                `Presented ${count} question${count === 1 ? "" : "s"} to the user` +
                (title ? ` ("${title}")` : "") +
                ". Their answers will arrive as a follow-up message — wait for it before proceeding.",
            };
          },
        }),
      }),
    );
  },
};
