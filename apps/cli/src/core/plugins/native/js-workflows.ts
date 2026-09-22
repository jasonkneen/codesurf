// Native Cordis plugin: `.claude/workflows/*.js` as dynamic, executable slash
// commands.
//
// Converted from the V1 `activate(api)` built-in. The sibling markdown handler
// (`user-workflows.ts`) still owns PROMPT commands; this owns `.js` WORKFLOW
// SCRIPTS: real orchestration programs that drive a model chain via an injected
// `agent()` primitive (see workflow-script-runner.ts). Each `<slug>.js`
// exporting a `meta` object is invocable as `/<slug>`; the script body runs in
// the harness and its `return` value is rendered into the transcript.
//
// `agent(prompt, { model, schema, label, phase })` maps onto a real sub-agent
// turn through `ctx.subagents.runTask`. The `model` per call is honoured via the
// `TaskRequest.model` override threaded through `Agent.runTaskRequest`
// (childModelId). `schema` is enforced + parsed inside the runner. `phase()` /
// `log()` stream progress to the transcript.
//
// Discovery stays dynamic: a resolver routes typed input (re-scanning each
// dispatch so new files work without a restart; static builtins win) and
// `enumerate()` lists scripts into the `/` menu + palette. `/workflow-scripts`
// lists what was found, including phase chains.
//
// The only non-`@codesurf/plugin-api` imports are the two pure `src/utils`
// modules that ARE the ported logic (script discovery and the sandboxed
// runner). Both are host-free: no loader, no registry, no concrete tool.

import type { CodesurfPlugin, CommandSpec, PluginContext, PluginManifest } from "@codesurf/plugin-api";
import { runWorkflowScript } from "../../../utils/workflow-script-runner";
import { discoverWorkflowScripts, type WorkflowScript } from "../../../utils/workflows";

const manifest: PluginManifest = {
  id: "builtin.commands.js-workflows",
  name: "JS Workflows",
  version: "1.0.0",
  description:
    "Executable `.js` workflow scripts from ~/.claude/workflows and project .claude/workflows as dynamic /<name> commands. Each script drives a model chain via an injected agent() primitive.",
  enabledByDefault: true,
  protected: false,
  capabilities: ["commands"],
};

/**
 * What the plugin reads back from a sub-agent turn.
 *
 * `SubagentsService.runTask` is deliberately typed `unknown` on both sides: the
 * concrete `TaskRequest`/`ToolResult` shapes belong to the agent runtime, which
 * the plugin API must not depend on. The cast lives here, at the boundary,
 * rather than widening the contract.
 */
interface SubagentTaskResult {
  output?: string;
}

/** Parse `/slug rest...` into its halves. Null when not a plain slash command. */
export function parseScriptInput(input: string): { slug: string; rest: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const body = trimmed.slice(1);
  const firstSpace = body.search(/\s/);
  const slug = firstSpace === -1 ? body : body.slice(0, firstSpace);
  const rest = firstSpace === -1 ? "" : body.slice(firstSpace + 1).trim();
  if (!slug) return null;
  return { slug, rest };
}

export const jsWorkflowsPlugin: CodesurfPlugin = {
  name: "codesurf-js-workflows",
  manifest,
  inject: ["contributions", "chat", "workspace", "subagents", "lifecycle"],
  apply(ctx: PluginContext) {
    /**
     * Controllers for workflow runs currently in flight, aborted by the
     * interrupt handler registered below. A workflow drives sub-agents from its
     * own loop, outside the turn's AbortController, so without this a script
     * kept running (and spending tokens) after the user pressed Esc.
     *
     * Fiber-scoped rather than module-scoped: unmounting the plugin drops the
     * set with it, so a remount never inherits a previous fiber's controllers.
     */
    const inFlightWorkflowRuns = new Set<AbortController>();

    /** Abort every in-flight workflow run. Wired to the host's interrupt event. */
    const abortWorkflowRuns = (): void => {
      for (const controller of inFlightWorkflowRuns) controller.abort();
      inFlightWorkflowRuns.clear();
    };

    /** Run a discovered workflow script end-to-end, streaming progress to chat. */
    async function executeScript(script: WorkflowScript, rest: string): Promise<void> {
      const { slug } = script;
      ctx.chat.appendAssistant(`▶ Running workflow /${slug}${rest ? ` ${rest}` : ""}`);

      const controller = new AbortController();
      inFlightWorkflowRuns.add(controller);

      const runAgent = async (
        prompt: string,
        opts: { model?: string; label?: string; phase?: string },
      ): Promise<string> => {
        if (controller.signal.aborted) return "";
        try {
          const result = (await ctx.subagents.runTask(
            {
              agent: "general",
              description: opts.label ?? `${slug}:${opts.phase ?? "phase"}`,
              prompt,
              model: opts.model,
            },
            controller.signal,
          )) as SubagentTaskResult;
          return result.output ?? "";
        } catch (err) {
          // Degrade rather than crash the whole workflow: a failed phase returns
          // its error text. For schema calls the runner parses null → the script's
          // optional-chaining (`result?.solved`) treats it as "not solved" and the
          // workflow's own escalation logic takes over.
          return `Sub-agent failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      };

      try {
        const result = await runWorkflowScript({
          source: script.source,
          // The slash command supplies a raw string; scripts accept a string or
          // `{ task, context }` and normalise internally.
          args: rest,
          runAgent,
          onPhase: (title) => ctx.chat.appendAssistant(`▶ Phase: ${title}`),
          onLog: (message) => ctx.chat.appendAssistant(`  ${message}`),
        });
        const rendered = typeof result === "string" ? result : JSON.stringify(result ?? null, null, 2);
        ctx.chat.appendAssistant(`✓ Workflow /${slug} complete:\n\`\`\`json\n${rendered}\n\`\`\``);
      } catch (err) {
        if (controller.signal.aborted) {
          ctx.chat.appendAssistant(`✗ Workflow /${slug} interrupted.`);
        } else {
          ctx.chat.appendAssistant(`✗ Workflow /${slug} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      } finally {
        inFlightWorkflowRuns.delete(controller);
      }
    }

    function buildScriptCommand(slug: string, description?: string): CommandSpec {
      return {
        name: `/${slug}`,
        description: description ?? `Workflow script: ${slug}`,
        argsHint: "[task]",
        handler: async ({ args }) => {
          const { scripts } = discoverWorkflowScripts(ctx.workspace.cwd());
          const script = scripts.find((s) => s.slug === slug);
          if (!script) {
            ctx.chat.appendAssistant(
              `Workflow "/${slug}" no longer resolves to a .js file under ~/.claude/workflows or project .claude/workflows.`,
            );
            return;
          }
          await executeScript(script, (args || "").trim());
        },
      };
    }

    function enumerateScripts(): CommandSpec[] {
      const { scripts } = discoverWorkflowScripts(ctx.workspace.cwd());
      return scripts.map((s) => buildScriptCommand(s.slug, s.description));
    }

    function renderListing(): string {
      const { scripts, untrusted, shadowed } = discoverWorkflowScripts(ctx.workspace.cwd());
      // Scripts discovery skipped, so a missing one is explained rather than
      // silently absent.
      const skipped: string[] = [];
      if (untrusted.length > 0) {
        skipped.push(
          `Not loaded — workspace not trusted to run its own scripts on the host (${untrusted.length}):`,
          ...untrusted.map((file) => `  ${file}`),
        );
      }
      if (shadowed.length > 0) {
        skipped.push(
          `Hidden by a user script with the same name (${shadowed.length}):`,
          ...shadowed.map((file) => `  ${file}`),
        );
      }
      if (scripts.length === 0) {
        return [
          "No workflow scripts found.",
          "Drop a <name>.js file (exporting `const meta = { name, description, phases }`) into",
          "~/.claude/workflows (or <project>/.claude/workflows) and run it with /<name>.",
          ...skipped,
        ].join("\n");
      }
      const lines: string[] = [`Workflow scripts (${scripts.length}):`];
      for (const s of scripts) {
        lines.push(`• /${s.slug} [${s.scope}] — ${s.description}`);
        if (s.phases && s.phases.length > 0) {
          const chain = s.phases.map((p) => `${p.title ?? "?"}${p.model ? `(${p.model})` : ""}`).join(" → ");
          lines.push(`    chain: ${chain}`);
        }
      }
      lines.push(...skipped);
      return lines.join("\n");
    }

    // Esc during a workflow cancels its remaining phases instead of letting the
    // script keep driving sub-agents after the user stopped the turn.
    ctx.effect(() => ctx.lifecycle.onUserInterrupt(abortWorkflowRuns));

    ctx.effect(() =>
      ctx.contributions.registerCommandResolver({
        label: "JS workflow scripts (.claude/workflows/*.js)",
        resolve(input) {
          const parsed = parseScriptInput(input);
          if (!parsed) return null;
          const { scripts } = discoverWorkflowScripts(ctx.workspace.cwd());
          if (!scripts.some((s) => s.slug === parsed.slug)) return null;
          return { command: buildScriptCommand(parsed.slug), args: parsed.rest };
        },
        enumerate: () => enumerateScripts(),
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerListingCommand({
        name: "/workflow-scripts",
        description: "List executable .js workflow scripts and their model chains.",
        render: () => renderListing(),
      }),
    );
  },
};
