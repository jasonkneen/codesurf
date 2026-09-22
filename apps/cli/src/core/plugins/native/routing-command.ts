// Native Cordis plugin: the `/routing` slash command.
//
// Adaptive-routing inspector — a read-only view of the model-routing data the
// learning loop collects. Trace data (model, query class, outcome, feedback) is
// recorded on EVERY turn regardless of the `learning.adaptiveModelRouting`
// flag (see TraceCollector in agent.ts), so this inspector is always available:
// you read it to decide whether to enable routing, then again to see what
// routing is acting on. The flag only changes the banner — "acting on this" vs
// "collected but not acted on".
//
// Converted from the V1 `activate(api)` shape to an ordinary Cordis module
// (`name`, `inject`, `apply`). The only host service it needs is `chat`, for
// writing the report straight into the transcript, plus `settings` to read the
// routing flag; both come from `@codesurf/plugin-api`. Registration is owned by
// `ctx.effect`, so unmounting the fiber removes the command.
//
// The trace store and the scoring functions are pure domain modules, not host
// API: `listTraces` reads the local trace database and `rankModels` /
// `pickBestModel` are side-effect-free scoring helpers. They are imported
// directly, exactly as the V1 builtin did, so the numbers this prints are the
// same numbers the router itself acts on.

import type { CodesurfPlugin, PluginContext, PluginManifest } from "@codesurf/plugin-api";
import { pickBestModel, type RouterTraceSample, rankModels } from "../../../agent/learning/learned-router";
import type { QueryClass } from "../../../agent/routing/classify";
import { listTraces } from "../../../storage/traces";

const manifest: PluginManifest = {
  id: "builtin.commands.routing",
  name: "Routing Inspector",
  version: "1.0.0",
  description: "Slash command `/routing` that shows tracked models, scores and routing standings.",
  enabledByDefault: true,
  protected: false,
  capabilities: ["commands"],
};

const TRACE_LIMIT = 500;
const ALL_CLASSES: QueryClass[] = ["code", "math", "short", "long", "general"];

// The `learning.adaptiveModelRouting` feature flag, resolved through the
// plugin-api settings contract instead of importing the host's flag registry
// (which would drag the extension loader into a headless plugin's import
// graph). Key, env var and default mirror the descriptor in
// `src/ui/feature-flags.ts` — the resolution order there is settings → env →
// declared default, reproduced verbatim below.
const ROUTING_FLAG_SETTINGS_KEY = "featureFlags.learning.adaptiveModelRouting";
const ROUTING_FLAG_ENV_VAR = "LEARNING_ADAPTIVEMODELROUTING";
const ROUTING_FLAG_DEFAULT = false;

function readEnvBool(name: string): boolean | undefined {
  const v = process.env[name];
  if (v == null) return undefined;
  const norm = v.trim().toLowerCase();
  if (norm === "") return undefined;
  if (["1", "true", "yes", "on", "y"].includes(norm)) return true;
  if (["0", "false", "no", "off", "n"].includes(norm)) return false;
  return undefined;
}

/** Is adaptive routing actually acting on this data, or only collecting it? */
function isRoutingActive(ctx: PluginContext): boolean {
  try {
    const stored = ctx.settings.get<boolean>(ROUTING_FLAG_SETTINGS_KEY);
    if (typeof stored === "boolean") return stored;
  } catch {
    // Host services not yet wired during very early boot — fall through to env.
  }
  const fromEnv = readEnvBool(ROUTING_FLAG_ENV_VAR);
  if (typeof fromEnv === "boolean") return fromEnv;
  return ROUTING_FLAG_DEFAULT;
}

function samplesFor(queryClass: QueryClass): RouterTraceSample[] {
  return listTraces({ queryClass, limit: TRACE_LIMIT })
    .filter((trace) => trace.outcome !== "cancelled")
    .map((trace) => ({
      model: trace.model,
      outcome: trace.outcome,
      feedback: trace.feedback,
    }));
}

function formatClass(queryClass: QueryClass): string {
  const samples = samplesFor(queryClass);
  if (samples.length === 0) return `${queryClass}: no turns recorded yet`;

  const standings = rankModels(samples);
  const best = pickBestModel(samples);
  const lines = standings.map((s) => {
    const leader = best && s.model === best.model ? "* " : "  ";
    const gate = s.qualified ? "" : " (below 5-sample threshold - not yet eligible)";
    return `  ${leader}${s.model} - score ${s.score.toFixed(3)} over ${s.samples} turn(s)${gate}`;
  });

  const header = best
    ? `${queryClass}: best model -> ${best.model}`
    : `${queryClass}: no model qualifies yet (needs 5+ turns on one model)`;
  return [header, ...lines].join("\n");
}

export const routingCommandPlugin: CodesurfPlugin = {
  name: "codesurf-routing-command",
  manifest,
  inject: ["contributions", "chat", "settings"],
  apply(ctx: PluginContext) {
    ctx.effect(() =>
      ctx.contributions.registerCommand({
        name: "/routing",
        description: "Show tracked models and learned routing scores per query class.",
        argsHint: "[code|math|short|long|general]",
        handler: ({ args }) => {
          const arg = (args || "").trim().toLowerCase();
          const classes = (ALL_CLASSES as string[]).includes(arg) ? [arg as QueryClass] : ALL_CLASSES;

          const totalTurns = ALL_CLASSES.reduce((n, c) => n + samplesFor(c).length, 0);
          if (totalTurns === 0) {
            ctx.chat.appendAssistant(
              "No routing data yet. Models, scores and outcomes are recorded for every turn; rate turns with /feedback to enrich the scores. Check back after a few turns.",
            );
            return;
          }

          const acting = isRoutingActive(ctx);
          const banner = acting
            ? "Adaptive model routing is ON - each turn is routed to the best-scoring model below."
            : "Adaptive model routing is OFF - data below is collected but not acted on. Enable in /flags.";

          const body = classes.map(formatClass).join("\n\n");
          const legend =
            "score = 0.6*outcome + 0.4*feedback (feedback from /feedback, defaults to 0.5 when unrated). * = current leader.";
          ctx.chat.appendAssistant(`${banner}\n\n${body}\n\n${legend}`);
        },
      }),
    );
  },
};
