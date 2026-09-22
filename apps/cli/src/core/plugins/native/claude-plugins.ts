// Claude Code plugins, surfaced and loaded inside CodeSurf.
//
// A Claude plugin is a directory of conventional folders rather than a module,
// and every one of those folders is a format CodeSurf already reads:
// `commands/*.md` are the same markdown slash commands as `~/.claude/commands`,
// `skills/<name>/SKILL.md` the same skills, `agents/*.md` the same sub-agents.
// So loading one is not a port — it is pointing existing readers at another
// directory.
//
// This plugin does three things:
//
//   1. discovers every Claude plugin visible from the workspace and registers
//      each one's `commands/*.md` as a real `/<slug>` command;
//   2. lists them in `/plugin`, labelled by where they came from, so a user can
//      see what is installed and what each contributes;
//   3. installs one from a folder with `/plugin install <path>`.
//
// It registers the DISCOVERED plugins' commands under its own manifest id. That
// is deliberate: they share one lifecycle, so disabling this plugin removes
// every Claude-plugin command at once, and no discovered plugin can outlive it.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CodesurfPlugin, PluginContext, PluginManifest } from "@codesurf/plugin-api";
import {
  type DiscoveredClaudePlugin,
  discoverClaudePlugins,
  expandClaudePluginRoot,
  nativeEquivalentFor,
  readClaudePlugin,
  summariseClaudePlugin,
} from "../../../utils/claude-plugins";
import { expandPromptArguments, parseWorkflowFile } from "../../../utils/workflows";
import { CODESURF_EXTERNAL_GROUP } from "../builtin/groups";

const manifest: PluginManifest = {
  id: "builtin.claude-plugins",
  name: "Claude plugins",
  version: "1.0.0",
  description:
    "Discovers Claude Code plugins from ~/.claude/plugins, the marketplace cache, ~/.codesurf/plugins and .claude/plugins, registers their slash commands, and installs new ones with /plugin install.",
  group: CODESURF_EXTERNAL_GROUP,
  enabledByDefault: true,
  protected: false,
  capabilities: ["commands"],
};

/** Where `/plugin install` puts a plugin: CodeSurf's own directory. */
function installRoot(): string {
  return path.join(os.homedir(), ".codesurf", "plugins");
}

function formatList(plugins: DiscoveredClaudePlugin[]): string {
  if (plugins.length === 0) {
    return [
      "No Claude plugins found.",
      "",
      "Looked in `~/.claude/plugins`, its marketplace cache, `~/.codesurf/plugins`",
      "and `.claude/plugins` in this project.",
      "",
      "Install one with `/plugin install <path-to-plugin-folder>`.",
    ].join("\n");
  }

  const bySource = new Map<string, DiscoveredClaudePlugin[]>();
  for (const plugin of plugins) {
    const list = bySource.get(plugin.source) ?? [];
    list.push(plugin);
    bySource.set(plugin.source, list);
  }

  const lines: string[] = [`**${plugins.length} Claude plugin(s)**`, ""];
  for (const [source, list] of [...bySource.entries()].sort()) {
    lines.push(`_${source}_`);
    for (const plugin of list) {
      const commands = plugin.commands.map((c) => `/${plugin.name}:${c.slug}`).join(", ");
      lines.push(`• **${plugin.name}** \`${plugin.version}\` — ${summariseClaudePlugin(plugin)}`);
      if (plugin.description) lines.push(`  ${plugin.description}`);
      const native = nativeEquivalentFor(plugin.name);
      if (native) lines.push(`  commands hidden — use \`${native}\` (needs Claude Code hooks)`);
      else if (commands) lines.push(`  commands: ${commands}`);
    }
    lines.push("");
  }
  lines.push("`/plugin install <path>` to add one · `/plugin remove <name>` to delete an installed copy.");
  return lines.join("\n");
}

/**
 * Copy a plugin folder into CodeSurf's plugin directory.
 *
 * A copy rather than a symlink: a link into someone's checkout means a `git
 * clean` there silently uninstalls the plugin here, and the failure would show
 * up as a command that stopped existing.
 */
function install(source: string): { ok: boolean; message: string } {
  const from = path.resolve(source.replace(/^~/, os.homedir()));
  if (!fs.existsSync(from) || !fs.statSync(from).isDirectory()) {
    return { ok: false, message: `Not a directory: \`${from}\`` };
  }

  const found = readClaudePlugin(from, "local");
  if (!found) {
    return {
      ok: false,
      message: [
        `No plugin manifest in \`${from}\`.`,
        "",
        "A Claude plugin needs `.claude-plugin/plugin.json` (or `plugin.json`) with a `name`.",
      ].join("\n"),
    };
  }

  const target = path.join(installRoot(), found.name);
  if (fs.existsSync(target)) {
    return { ok: false, message: `\`${found.name}\` is already installed at \`${target}\`. Remove it first.` };
  }

  try {
    fs.mkdirSync(installRoot(), { recursive: true });
    fs.cpSync(from, target, { recursive: true, filter: (src) => !src.includes(`${path.sep}.git${path.sep}`) });
  } catch (error) {
    return { ok: false, message: `Install failed: ${error instanceof Error ? error.message : String(error)}` };
  }

  const installed = readClaudePlugin(target, "local");
  return {
    ok: true,
    message: [
      `Installed **${found.name}** \`${found.version}\` → \`${target}\``,
      installed ? `Contributes: ${summariseClaudePlugin(installed)}` : "",
      installed && installed.commands.length > 0
        ? `Commands after restart: ${installed.commands.map((c) => `/${installed.name}:${c.slug}`).join(", ")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

/**
 * Scaffold a new Claude plugin, ready to edit.
 *
 * Written into CodeSurf's own plugin directory so it is discovered on the next
 * start with no further wiring — the point is that a user gets from "I want a
 * command" to a working command without reading the format first.
 */
function scaffold(name: string): { ok: boolean; message: string } {
  const safe = name.trim().replace(/[^a-zA-Z0-9._-]/g, "-");
  if (!safe) return { ok: false, message: "Usage: `/plugin new <name>`" };

  const target = path.join(installRoot(), safe);
  if (fs.existsSync(target)) {
    return { ok: false, message: `\`${safe}\` already exists at \`${target}\`.` };
  }

  try {
    fs.mkdirSync(path.join(target, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(target, ".claude-plugin", "plugin.json"),
      `${JSON.stringify({ name: safe, version: "0.1.0", description: `${safe} plugin` }, null, 2)}\n`,
      "utf-8",
    );

    fs.mkdirSync(path.join(target, "commands"), { recursive: true });
    fs.writeFileSync(
      path.join(target, "commands", "hello.md"),
      [
        "---",
        "description: Say hello",
        "---",
        "",
        `You are running the \`${safe}\` plugin's hello command.`,
        "",
        "Arguments: $ARGUMENTS",
        "",
        "Reply with a short greeting that quotes the arguments back.",
        "",
      ].join("\n"),
      "utf-8",
    );

    fs.mkdirSync(path.join(target, "skills", "example"), { recursive: true });
    fs.writeFileSync(
      path.join(target, "skills", "example", "SKILL.md"),
      [
        "---",
        "name: example",
        `description: Use when working on ${safe}. Replace this with a real trigger — the description is what decides whether the skill loads.`,
        "---",
        "",
        "# Example skill",
        "",
        "Replace this body with the instructions the model should follow.",
        "",
      ].join("\n"),
      "utf-8",
    );
  } catch (error) {
    return { ok: false, message: `Scaffold failed: ${error instanceof Error ? error.message : String(error)}` };
  }

  return {
    ok: true,
    message: [
      `Created **${safe}** at \`${target}\``,
      "",
      "```",
      `${safe}/`,
      "  .claude-plugin/plugin.json    manifest",
      "  commands/hello.md             → /" + safe + ":hello",
      "  skills/example/SKILL.md       a skill",
      "```",
      "",
      "Edit those, then restart CodeSurf to pick them up.",
    ].join("\n"),
  };
}

function remove(name: string): { ok: boolean; message: string } {
  const target = path.join(installRoot(), name);
  if (!fs.existsSync(target)) {
    return { ok: false, message: `\`${name}\` is not installed in \`${installRoot()}\`.` };
  }
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (error) {
    return { ok: false, message: `Remove failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { ok: true, message: `Removed **${name}** from \`${target}\`. Its commands go on the next start.` };
}

export const claudePluginsPlugin: CodesurfPlugin = {
  name: "codesurf-claude-plugins",
  manifest,
  inject: ["contributions", "chat", "workspace"],
  apply(ctx: PluginContext) {
    const cwd = ctx.workspace.cwd();
    const discovered = discoverClaudePlugins(cwd);

    // ── Each plugin's commands/*.md, as real slash commands ──────────────────
    //
    // Namespaced `/<plugin>:<command>`, which is Claude Code's own convention
    // and not decoration: a bare `/<slug>` collides the moment two plugins ship
    // the same verb, or one clashes with a command already in
    // `~/.claude/commands`. `/review` did exactly that on the first run here,
    // and the registry refused the whole plugin rather than shadow it.
    //
    // Registered under THIS plugin's manifest so they share one lifecycle:
    // disabling it removes every Claude-plugin command, and none can outlive it.
    for (const plugin of discovered) {
      // Replaced natively (see nativeEquivalentFor): listing them would offer
      // commands that start and then silently do nothing.
      if (nativeEquivalentFor(plugin.name)) continue;
      for (const command of plugin.commands) {
        ctx.effect(() =>
          ctx.contributions.registerPromptCommand({
            name: `/${plugin.name}:${command.slug}`,
            description: `${plugin.name} — ${command.slug}`,
            argsHint: "[arguments]",
            buildPrompt: ({ args }: { args: string }) => {
              let body: string;
              try {
                body = parseWorkflowFile(fs.readFileSync(command.file, "utf-8")).body;
              } catch {
                return `The command file for /${command.slug} could not be read (${command.file}).`;
              }
              // Same `$ARGUMENTS` / `$1` substitution the user's own markdown
              // commands get — a plugin's command is not a lesser one.
              return expandPromptArguments(expandClaudePluginRoot(body, plugin.root), args).text;
            },
            displayText: `/${plugin.name}:${command.slug}`,
          }),
        );
      }
    }

    ctx.effect(() =>
      ctx.contributions.registerCommand({
        name: "/plugin",
        aliases: ["/plugin-install"],
        description: "List, scaffold, install and remove Claude Code plugins.",
        argsHint: "[list | new <name> | install <path> | remove <name>]",
        handler: ({ args }) => {
          const [action = "list", ...rest] = args.trim().split(/\s+/).filter(Boolean);
          const argument = rest.join(" ");

          if (action === "install") {
            if (!argument) {
              ctx.chat.appendAssistant("Usage: `/plugin install <path-to-plugin-folder>`");
              return;
            }
            ctx.chat.appendAssistant(install(argument).message);
            return;
          }

          if (action === "new" || action === "create") {
            if (!argument) {
              ctx.chat.appendAssistant("Usage: `/plugin new <name>`");
              return;
            }
            ctx.chat.appendAssistant(scaffold(argument).message);
            return;
          }

          if (action === "remove" || action === "uninstall") {
            if (!argument) {
              ctx.chat.appendAssistant("Usage: `/plugin remove <name>`");
              return;
            }
            ctx.chat.appendAssistant(remove(argument).message);
            return;
          }

          // `list` is the default, including for an unrecognised verb: showing
          // what is installed is more useful than a usage error.
          ctx.chat.appendAssistant(formatList(discoverClaudePlugins(ctx.workspace.cwd())));
        },
      }),
    );
  },
};
