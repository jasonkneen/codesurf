// MCP prompts as slash commands builtin extension.
//
// Registers a dynamic command resolver so each MCP-advertised prompt can be
// invoked as `/<server-id>__<prompt-name> [args]`. Mirrors the naming
// convention of MCP tools (`mcp_<server>__<tool>`), but with `/` prefix and
// double-underscore separator everywhere for symmetry with the slash menu.
//
// Why a resolver instead of pre-registered static commands:
//   - The set of MCP prompts depends on what each enabled server advertises
//     at runtime. Static registration would require subscribing to MCP server
//     state changes; a resolver re-validates on every dispatch instead.
//   - The cost of dispatch is one transient `buildMcpToolSet` (matches the
//     pattern already used by the modal's stats discovery in app.tsx) plus
//     one `getPrompt` RPC. Acceptable for slash-command frequency.
//
// Argument handling (v1):
//   - If the user supplies args after the command name, we first try
//     `JSON.parse(rest)`. If that yields an object, it's used directly as the
//     prompt's arguments map.
//   - Otherwise, if the prompt declares one or more arguments, we attach the
//     entire `rest` string to the first declared argument by name.
//   - Otherwise the args are ignored (prompt takes no arguments).
//   - Schema-driven multi-arg prompting can come in v2 if anyone needs it.
//
// All async work happens in the handler. The resolver is sync and only does
// shape matching (`/<word>__<word>` with non-empty halves on either side).

import type { ChatService, CodesurfPlugin, CommandSpec, PluginContext, PluginManifest } from "@codesurf/plugin-api";
import { buildMcpToolSet, type McpPromptResult, type McpPromptSummary } from "../../../mcp/runtime";
import { loadMcpServers } from "../../../utils/settings";

const EXTENSION_ID = "builtin.mcp";

const manifest: PluginManifest = {
  id: EXTENSION_ID,
  name: "MCP",
  version: "1.0.0",
  description:
    "MCP integration: dynamic tools (mcp_<server>__<tool>), prompt slash commands, server management modal, and resources/prompts discovery. Toggle to enable or disable the entire MCP surface.",
  enabledByDefault: true,
  protected: false,
  capabilities: ["commands", "tools"],
};

interface ParsedMcpPromptInput {
  serverId: string;
  promptName: string;
  rest: string;
}

/**
 * Parse a `/<server>__<prompt> rest` slash command into its parts. Returns
 * null if the input doesn't have the right shape; we don't validate that the
 * server/prompt actually exist here — the handler does that against a live
 * bundle so it can report a precise reason on the chat surface.
 */
export function parseMcpPromptInput(input: string): ParsedMcpPromptInput | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;

  const body = trimmed.slice(1);
  const firstSpace = body.search(/\s/);
  const head = firstSpace === -1 ? body : body.slice(0, firstSpace);
  const rest = firstSpace === -1 ? "" : body.slice(firstSpace + 1).trim();

  // Shape: `<server>__<prompt>` with both halves non-empty. Server ids and
  // prompt names can contain dashes; reject only the empty-half cases.
  const sep = head.indexOf("__");
  if (sep <= 0 || sep >= head.length - 2) return null;

  return {
    serverId: head.slice(0, sep),
    promptName: head.slice(sep + 2),
    rest,
  };
}

/**
 * Map the user's `rest` string into an MCP `arguments` object. JSON-shaped
 * input wins; otherwise we assign `rest` to the first declared argument by
 * name. Returns `undefined` when there are no args to send.
 */
export function buildPromptArguments(
  rest: string,
  promptArguments: McpPromptSummary["arguments"],
): Record<string, unknown> | undefined {
  if (!rest) return undefined;

  // JSON object → use as-is.
  try {
    const parsed: unknown = JSON.parse(rest);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }

  const first = promptArguments?.[0]?.name;
  if (!first) return undefined;
  return { [first]: rest };
}

/**
 * Render the MCP `getPrompt` result into a single string suitable for
 * `services.chat.dispatch`. Multi-message prompts (rare in the wild) are
 * concatenated with role-prefixes so context is preserved without losing the
 * authorship signal.
 */
export function renderPromptDispatch(result: McpPromptResult): string {
  if (result.messages.length === 0) return "";
  if (result.messages.length === 1 && result.messages[0]?.role === "user") {
    return result.messages[0].text;
  }
  return result.messages.map((m) => `[${m.role}]\n${m.text}`).join("\n\n");
}

function buildPromptCommand(parsed: ParsedMcpPromptInput, chat: ChatService): CommandSpec {
  const { serverId, promptName, rest } = parsed;
  const slashName = `/${serverId}__${promptName}`;
  return {
    name: slashName,
    description: `MCP prompt: ${serverId} → ${promptName}`,
    handler: async () => {
      const servers = loadMcpServers();
      const server = servers.find((s) => s.id === serverId);
      if (!server) {
        chat.appendAssistant(`MCP server "${serverId}" is not configured.`);
        return;
      }
      if (!server.enabled) {
        chat.appendAssistant(`MCP server "${serverId}" is configured but disabled.`);
        return;
      }

      const bundle = await buildMcpToolSet([server]);
      try {
        if (!bundle.serverIds.includes(serverId)) {
          const detail = bundle.errors[0] ?? "server failed to connect";
          chat.appendAssistant(`MCP server "${serverId}" did not connect: ${detail}`);
          return;
        }

        const prompts = await bundle.listPrompts(serverId);
        const prompt = prompts.find((p) => p.name === promptName);
        if (!prompt) {
          const available =
            prompts.length === 0
              ? "no prompts advertised"
              : `available prompts: ${prompts.map((p) => p.name).join(", ")}`;
          chat.appendAssistant(
            `MCP server "${serverId}" does not advertise a prompt named "${promptName}" — ${available}.`,
          );
          return;
        }

        const args = buildPromptArguments(rest, prompt.arguments);
        const rendered = await bundle.getPrompt(serverId, promptName, args);
        if (!rendered) {
          chat.appendAssistant(`MCP server "${serverId}" returned an error rendering prompt "${promptName}".`);
          return;
        }

        const dispatchText = renderPromptDispatch(rendered);
        if (!dispatchText) {
          chat.appendAssistant(`MCP prompt "${slashName}" rendered with no text content — nothing to dispatch.`);
          return;
        }

        void chat.dispatch(dispatchText);
      } finally {
        await bundle.close();
      }
    },
  };
}

export const mcpPromptCommandsPlugin: CodesurfPlugin = {
  name: "codesurf-mcp-prompt-commands",
  manifest,
  inject: ["contributions", "chat", "sinks", "mcp"],
  apply(ctx: PluginContext) {
    // MCP tool-bundle provider — drives `services.mcp.getToolBundle()`. The
    // agent's three call sites (and the modal's discovery effect) call this
    // through the host services, so when this extension is disabled the
    // loader returns an empty bundle and MCP tools / resources / prompts /
    // servers all disappear without kernel-side branching.
    // `bindKernelSink` auto-clears the provider on dispose.
    ctx.effect(() =>
      ctx.sinks.bind({
        mcp: async () => buildMcpToolSet(loadMcpServers()),
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerCommandResolver({
        label: "MCP prompts",
        resolve(input) {
          const parsed = parseMcpPromptInput(input);
          if (!parsed) return null;
          return {
            command: buildPromptCommand(parsed, ctx.chat),
            args: parsed.rest,
          };
        },
      }),
    );

    // /mcp (and /mcps alias) registered here — moved out of host-actions so
    // the command disappears from the slash menu / typed input when this
    // extension is disabled.
    ctx.effect(() =>
      ctx.contributions.registerCommand({
        name: "/mcp",
        description: "Open the MCP servers modal.",
        aliases: ["/mcps"],
        handler: () => {
          ctx.ui.action({ type: "mcp" });
        },
      }),
    );
  },
};
