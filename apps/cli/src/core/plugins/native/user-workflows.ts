// Native Cordis plugin: user prompt-commands — `.claude/commands/*.md` and
// `.claude/workflows/*.md` as dynamic slash commands.
//
// Bridges the Claude Code custom-command convention into the command surface.
// Each discovered `<slug>.md` (under ~/.claude/commands or project
// .claude/commands — plus the legacy .claude/workflows dirs) is invocable as
// `/<slug>`; the file body is dispatched as a prompt via `ctx.chat.dispatch`
// (the LLM enacts it — there is no script engine, see workflow-orchestrator.ts).
//
// Claude Code parity:
//   - canonical `commands/` dir (workflows/ kept as a synonym; commands/ wins
//     on slug collision);
//   - frontmatter `description` + `argument-hint`;
//   - argument substitution in the body: `$ARGUMENTS`, `$1`..`$9`. Files that
//     use no placeholder fall back to an appended "Additional input" block so
//     a bare prompt file still receives typed args.
//
// Discovery is dynamic. A command RESOLVER routes typed input (re-scanning on
// every dispatch, so new files work without a restart; static builtins always
// win because resolvers run after static lookup). An `enumerate()` hook lists
// the same set into the `/` menu + Ctrl+K palette so they're discoverable, not
// just dispatchable. `/commands` (alias `/workflows`) lists what was found.
//
// Converted from the V1 `activate(api)` module: it injects `contributions`,
// `chat` and `workspace`, and both registrations are owned by `ctx.effect`, so
// unmounting the fiber removes the resolver and the listing command. Discovery
// itself stays in `utils/workflows` — a pure filesystem/frontmatter helper, not
// a host service.

import type { CodesurfPlugin, CommandSpec, PluginContext, PluginManifest } from "@codesurf/plugin-api";
import { type DiscoveredWorkflow, discoverUserPromptCommands, expandPromptArguments } from "../../../utils/workflows";

const manifest: PluginManifest = {
  id: "builtin.commands.user-workflows",
  name: "User Commands",
  version: "2.0.0",
  description:
    "Markdown slash commands from ~/.claude/commands and project .claude/commands (and legacy .claude/workflows) as dynamic /<name> commands, with $ARGUMENTS substitution and /commands to list them.",
  enabledByDefault: true,
  protected: false,
  capabilities: ["commands"],
};

/** Parse `/slug rest...` into its halves. Null when not a plain one-word slash command. */
export function parseWorkflowInput(input: string): { slug: string; rest: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const body = trimmed.slice(1);
  const firstSpace = body.search(/\s/);
  const slug = firstSpace === -1 ? body : body.slice(0, firstSpace);
  const rest = firstSpace === -1 ? "" : body.slice(firstSpace + 1).trim();
  if (!slug) return null;
  return { slug, rest };
}

/** Apply Claude Code-style arg substitution, falling back to an appended block. */
export function buildPromptWithArgs(wf: DiscoveredWorkflow, rest: string): string {
  const trimmed = (rest || "").trim();
  const { text, used } = expandPromptArguments(wf.prompt, trimmed);
  if (used) return text;
  return trimmed ? `${wf.prompt}\n\nAdditional input from the user:\n${trimmed}` : wf.prompt;
}

function buildWorkflowCommand(ctx: PluginContext, slug: string, description?: string, argsHint?: string): CommandSpec {
  return {
    name: `/${slug}`,
    description: description ?? `User command: ${slug}`,
    argsHint,
    handler: ({ args }) => {
      // Re-discover at dispatch time so the prompt reflects the file on disk
      // right now (and so a deleted file fails loudly instead of replaying a
      // stale body).
      const { workflows } = discoverUserPromptCommands(ctx.workspace.cwd());
      const wf = workflows.find((w) => w.slug === slug);
      if (!wf) {
        ctx.chat.appendAssistant(
          `Command "/${slug}" no longer resolves to a .md file under ~/.claude/commands, .claude/commands, or .claude/workflows.`,
        );
        return;
      }
      const rest = (args || "").trim();
      const prompt = buildPromptWithArgs(wf, rest);
      // Not awaited, exactly as in V1: the command returns as soon as the turn
      // is handed to the agent, so the composer is free again immediately.
      //
      // `displayText` keeps the transcript bubble, the generated session title
      // and the queue banner showing the typed `/slug args` instead of the whole
      // expanded .md body.
      void ctx.chat.dispatch(prompt, { displayText: `/${slug}${rest ? ` ${rest}` : ""}` });
    },
  };
}

function enumeratePromptCommands(ctx: PluginContext): CommandSpec[] {
  const { workflows } = discoverUserPromptCommands(ctx.workspace.cwd());
  return workflows.map((w) => buildWorkflowCommand(ctx, w.slug, w.description, w.argumentHint));
}

function renderListing(ctx: PluginContext): string {
  const { workflows, unsupported } = discoverUserPromptCommands(ctx.workspace.cwd());
  const lines: string[] = [];
  if (workflows.length === 0) {
    lines.push(
      "No markdown commands found.",
      "Drop a <name>.md file into ~/.claude/commands (or <project>/.claude/commands) and run it with /<name>.",
      "Use $ARGUMENTS or $1..$9 in the body to interpolate typed args.",
    );
  } else {
    lines.push(`Commands (${workflows.length}):`);
    for (const w of workflows) {
      const hint = w.argumentHint ? ` ${w.argumentHint}` : "";
      lines.push(`• /${w.slug}${hint} [${w.scope}] — ${w.description}`);
    }
  }
  if (unsupported.length > 0) {
    lines.push(
      "",
      `${unsupported.length} non-markdown file(s) (e.g. .js workflow scripts) — run these via /<name> (see /workflow-scripts):`,
      ...unsupported.map((f) => `  ${f}`),
    );
  }
  return lines.join("\n");
}

export const userWorkflowsPlugin: CodesurfPlugin = {
  name: "codesurf-user-workflows",
  manifest,
  inject: ["contributions", "chat", "workspace"],
  apply(ctx: PluginContext) {
    ctx.effect(() =>
      ctx.contributions.registerCommandResolver({
        label: "User commands (.claude/commands)",
        resolve: (input) => {
          const parsed = parseWorkflowInput(input);
          if (!parsed) return null;
          const { workflows } = discoverUserPromptCommands(ctx.workspace.cwd());
          if (!workflows.some((w) => w.slug === parsed.slug)) return null;
          return { command: buildWorkflowCommand(ctx, parsed.slug), args: parsed.rest };
        },
        enumerate: () => enumeratePromptCommands(ctx),
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerListingCommand({
        name: "/commands",
        aliases: ["/workflows"],
        description: "List markdown slash commands from ~/.claude/commands and project .claude/commands.",
        render: () => renderListing(ctx),
      }),
    );
  },
};
