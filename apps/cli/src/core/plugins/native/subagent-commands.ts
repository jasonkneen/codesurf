// Native Cordis plugin: `/<custom-agent-name> <prompt>` slash commands.
//
// Converted from the V1 `activate(api)` builtin to an ordinary Cordis module
// (`name`, `inject`, `apply`). The resolver is registered through `ctx.effect`,
// so disposing the fiber — not a loader sweep — is what removes it.
//
// User-defined subagents (configured via `~/.codesurf/user-settings.json`) get
// a virtual `/<agent-name> <prompt>` slash command each. Names can include
// spaces, so the resolver does a longest-prefix match against the input rather
// than pre-registering each agent as a static command at boot.
//
// Subagents change at runtime via the Settings → Agents UI; rather than
// subscribing to that, the resolver simply re-reads `ctx.subagents.listCustom()`
// on every dispatch. The host binds that to the user-settings reader, so the
// cost is one tiny JSON read per slash invocation — and the plugin's own module
// graph stays free of `src/utils/settings` and everything it drags in.

import type {
  CodesurfPlugin,
  CommandSpec,
  CustomSubagentInfo,
  PluginContext,
  PluginManifest,
} from "@codesurf/plugin-api";

const manifest: PluginManifest = {
  id: "builtin.commands.subagents",
  name: "Custom Subagents",
  version: "1.0.0",
  description:
    "Routes `/<custom-agent-name> <prompt>` slash commands to user-defined subagents from `~/.codesurf/user-settings.json`.",
  enabledByDefault: true,
  protected: false,
  capabilities: ["commands"],
};

interface ParsedSubagentInput {
  agentName: string;
  prompt: string;
}

/** Every static command name and alias, so a subagent can never shadow one. */
function buildReservedSet(commands: readonly CommandSpec[]): Set<string> {
  const reserved = new Set<string>();
  for (const cmd of commands) {
    reserved.add(cmd.name);
    for (const alias of cmd.aliases ?? []) {
      reserved.add(alias);
    }
  }
  return reserved;
}

/**
 * Parse a slash-command input against the current subagent list. Performs
 * a longest-prefix match because subagent names can contain spaces.
 *
 * Returns null if:
 * - input is empty or not a slash command,
 * - the first whitespace-delimited token matches a registered command/alias, or
 * - no subagent name prefixes the body.
 */
export function parseSubagentInput(
  input: string,
  subagents: readonly CustomSubagentInfo[],
  reserved: Set<string>,
): ParsedSubagentInput | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;

  const body = trimmed.slice(1).trim();
  if (!body) return null;

  const commandToken = body.split(/\s+/, 1)[0]?.toLowerCase();
  if (commandToken && reserved.has(`/${commandToken}`)) {
    return null;
  }

  const lowerBody = body.toLowerCase();
  const sortedSubagents = [...subagents].sort((a, b) => b.name.length - a.name.length);
  const match = sortedSubagents.find((item) => {
    const lowerName = item.name.trim().toLowerCase();
    return lowerBody === lowerName || lowerBody.startsWith(`${lowerName} `);
  });
  if (!match) return null;

  return {
    agentName: match.name,
    prompt: body.slice(match.name.length).trim(),
  };
}

export function buildSubagentDispatchPrompt(agentName: string, prompt: string): string {
  return `Use the custom sub-agent "${agentName}" for this task.

Delegate the work with the \`task\` tool using:
- \`agent\`: "${agentName}"
- \`description\`: a short summary of the work
- \`prompt\`: a detailed prompt based on the user's request

User request:
${prompt}`;
}

/**
 * Synthesize the command for one parsed invocation.
 *
 * The prompt is captured here rather than read from `invocation.args`, exactly
 * as the V1 command did: an enumerated entry carries an empty prompt and prints
 * usage, while a resolved one carries the text the user typed.
 */
function buildSubagentCommand(ctx: PluginContext, parsed: ParsedSubagentInput): CommandSpec {
  const { agentName, prompt } = parsed;
  return {
    name: `/${agentName}`,
    description: `Custom subagent: ${agentName}`,
    handler: () => {
      if (!prompt) {
        ctx.chat.appendAssistant(`Usage: /${agentName} <task>\nExample: /${agentName} review the latest changes`);
        return;
      }
      // Deliberately not awaited, matching V1: the handler returns as soon as
      // the turn is handed to the agent rather than when the agent finishes.
      void ctx.chat.dispatch(buildSubagentDispatchPrompt(agentName, prompt));
    },
  };
}

export const subagentCommandsPlugin: CodesurfPlugin = {
  name: "codesurf-subagent-commands",
  manifest,
  inject: ["contributions", "chat", "commands", "subagents"],
  apply(ctx: PluginContext) {
    ctx.effect(() =>
      ctx.contributions.registerCommandResolver({
        label: "Custom subagents",
        resolve(input) {
          const reserved = buildReservedSet(ctx.commands.list());
          const parsed = parseSubagentInput(input, ctx.subagents.listCustom(), reserved);
          if (!parsed) return null;
          return {
            command: buildSubagentCommand(ctx, parsed),
            args: parsed.prompt,
          };
        },
        enumerate() {
          const reserved = buildReservedSet(ctx.commands.list());
          return (
            ctx.subagents
              .listCustom()
              // Drop any subagent whose name collides with a static command.
              .filter((a) => !reserved.has(`/${a.name.trim().toLowerCase().split(/\s+/)[0]}`))
              .map((a) => buildSubagentCommand(ctx, { agentName: a.name, prompt: "" }))
          );
        },
      }),
    );
  },
};
