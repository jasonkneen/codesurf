// Native Cordis plugin: the `/context` slash command.
//
// This is the first built-in converted from the V1 `activate(api)` shape to an
// ordinary Cordis module (`name`, `inject`, `apply`). It imports only
// `@codesurf/plugin-api` — no host UI, Agent or concrete tool — and it owns its
// registration through `ctx.effect`, so unmounting the fiber removes the
// command.
//
// Behaviour is byte-for-byte the V1 command's: `/context` prints the live token
// breakdown, `/context compact` (or `compress`/`summarize`) forces a checkpoint
// summary, and `/context help` prints usage. The stable id, default-enabled and
// unprotected flags and the `commands` capability are carried over unchanged.

import type { CodesurfPlugin, PluginContext, PluginManifest } from "@codesurf/plugin-api";

const manifest: PluginManifest = {
  id: "builtin.commands.context",
  name: "Context Inspector",
  version: "1.0.0",
  description: "Slash command `/context` for token breakdown and manual compaction.",
  enabledByDefault: true,
  protected: false,
  capabilities: ["commands"],
};

const HELP_LINES = [
  "Usage:",
  "  /context           Show live token breakdown for current session.",
  "  /context compact   Force manual compaction now (checkpoint + recent tail).",
  "  /context compress  Alias for compact.",
  "  /context help      This message.",
  "",
  "Breakdown numbers are estimates (char count / 4) and match the",
  "logic used for the footer meter and automatic overflow compaction.",
];

/** Render the breakdown exactly as the V1 command did. */
function formatBreakdown(bd: NonNullable<ReturnType<PluginContext["contextMeter"]["getBreakdown"]>>): string {
  const pct = (bd.ratioUsed * 100).toFixed(1);
  const remPct = (bd.ratioRemaining * 100).toFixed(1);
  const summaryLine =
    bd.compactionSummaryTokens > 0
      ? `  Compaction summary: ~${bd.compactionSummaryTokens.toLocaleString()}`
      : "  (no prior compaction summary — full history in context)";

  return [
    `Context window usage: ${bd.usedTokens.toLocaleString()} / ${bd.contextWindow.toLocaleString()} tokens (${pct}%)`,
    `  System prompt:     ~${bd.systemTokens.toLocaleString()}`,
    `  In-flight input:   ~${bd.inFlightTokens.toLocaleString()}`,
    summaryLine,
    `  Recent history:    ~${bd.historyTokens.toLocaleString()}`,
    "",
    `Remaining headroom: ${bd.remainingTokens.toLocaleString()} (${remPct}%)`,
    "",
    "Commands:",
    "  /context compact   — replace older turns with a structured summary checkpoint",
    "  /context help",
  ].join("\n");
}

export const contextCommandPlugin: CodesurfPlugin = {
  name: "codesurf-context-command",
  manifest,
  inject: ["contributions", "chat", "contextMeter"],
  apply(ctx: PluginContext) {
    ctx.effect(() =>
      ctx.contributions.registerCommand({
        name: "/context",
        description: "Show context token breakdown; /context compact to force a checkpoint summary.",
        argsHint: "[compact|compress|help]",
        handler: async ({ args }) => {
          const trimmed = (args || "").trim().toLowerCase();

          if (["compact", "compress", "summarize"].includes(trimmed)) {
            const res = await ctx.contextMeter.compact();
            ctx.chat.appendAssistant(res.message);
            return;
          }

          if (trimmed && trimmed !== "help" && trimmed !== "?") {
            ctx.chat.appendAssistant(
              `Unknown /context argument: "${trimmed}". Usage: /context [compact|compress|help]`,
            );
            return;
          }

          if (trimmed === "help" || trimmed === "?") {
            ctx.chat.appendAssistant(HELP_LINES.join("\n"));
            return;
          }

          const bd = ctx.contextMeter.getBreakdown();
          if (!bd) {
            ctx.chat.appendAssistant("No active session or context stats not available yet. Send a message first.");
            return;
          }

          ctx.chat.appendAssistant(formatBreakdown(bd));
        },
      }),
    );
  },
};
