import { getHostServices } from "../../core/plugins";
import { totalBilledTokens, usageFromAiSdk, usageFromRecord } from "../../core/plugins/builtin/provider-usage";
import { createProvider, generateRecap as genRecap } from "../../grok/client";
import { listTraces, recordUsageEvent, type SessionStore } from "../../storage/index";
import type { SessionInfo, UsageSource } from "../../types/index";
import { withAbortTimeout } from "./../agent-helpers";
import { ADAPTIVE_ROUTING_SETTING, ADAPTIVE_ROUTING_TRACE_LIMIT } from "./../constants";
import { pickBestModel } from "./../learning/learned-router";
import { buildRecapPrompt } from "./../prompts";
import { classifyQuery } from "./../routing/classify";

interface TelemetryState {
  sessionStore: SessionStore | null;
  session: SessionInfo | null;
  recapsEnabled: boolean;
  apiKey: string | null;
  baseURL: string | null;
  activeTrace: { addUsage(usage: { totalTokens?: number; inputTokens?: number; outputTokens?: number }): void } | null;
  lastTurnUsage: { cacheReadTokens?: number; cacheWriteTokens?: number; inputTokens?: number } | null;
  modelId: string;
}

function st(self: object): TelemetryState {
  return self as unknown as TelemetryState;
}

// biome-ignore lint/suspicious/noExplicitAny: TS mixin base constraint must accept any[] (TS2545).
type MixinConstructor = new (...args: any[]) => object;

export function TelemetryMixin<TBase extends MixinConstructor>(Base: TBase) {
  return class Telemetry extends Base {
    captureSessionTarget(): { store: SessionStore; session: SessionInfo } | null {
      const s = st(this);
      return s.sessionStore && s.session ? { store: s.sessionStore, session: s.session } : null;
    }

    /** True while `target` is still this Agent's current session and store. */
    isCurrentSessionTarget(target: { store: SessionStore; session: SessionInfo }): boolean {
      const s = st(this);
      return s.sessionStore === target.store && s.session?.id === target.session.id;
    }

    async refreshSessionRecap(signal?: AbortSignal): Promise<void> {
      const s = st(this);
      if (!s.recapsEnabled || !s.apiKey) {
        return;
      }
      const target = this.captureSessionTarget();
      if (!target) {
        return;
      }
      try {
        const prompt = buildRecapPrompt(target.session);
        if (!prompt) {
          return;
        }
        const provider = createProvider(s.apiKey, s.baseURL ?? undefined);
        const generated = await genRecap(provider, prompt, withAbortTimeout(signal, 8_000));
        if (!this.isCurrentSessionTarget(target)) {
          return;
        }
        this.recordUsage(generated.usage, "recap", generated.modelId);
        if (!generated.recap) {
          return;
        }
        target.store.setRecap(target.session.id, {
          text: generated.recap,
          model: generated.modelId,
          updatedAt: new Date(),
        });
        s.session = target.store.getRequiredSession(target.session.id);
      } catch {
        // Recaps are best-effort and should never make the completed turn fail.
      }
    }

    recordUsage(
      usage?: {
        totalTokens?: number;
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
      },
      source: UsageSource = "message",
      model = st(this).modelId,
    ): void {
      const s = st(this);
      if (!usage) return;
      // Two input conventions arrive here. Provider sessions report
      // `inputTokens` as the cache-MISS remainder; the AI SDK (v6, recognised
      // by `inputTokenDetails`) reports the whole prompt with cache reads and
      // writes folded in. Normalize the SDK shape to the miss remainder, or
      // the cached prefix is billed twice.
      const normalized = "inputTokenDetails" in usage ? usageFromAiSdk(usage) : usageFromRecord(usage);
      // A reported total built from miss + output silently drops everything
      // the prefix cache was billed for. Only override when a cache slice is
      // actually present: without one the provider's own total is the
      // authoritative number.
      const cached = (normalized?.cacheReadTokens ?? 0) + (normalized?.cacheWriteTokens ?? 0);
      const billed =
        cached > 0 && normalized
          ? totalBilledTokens(normalized)
          : (usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0));
      const effective = {
        ...usage,
        inputTokens: normalized?.inputTokens ?? usage.inputTokens,
        cacheReadTokens: normalized?.cacheReadTokens,
        cacheWriteTokens: normalized?.cacheWriteTokens,
        totalTokens: billed,
      };

      if (s.session) {
        recordUsageEvent(s.session.id, source, model, effective);
      }
      if (source === "message") {
        s.activeTrace?.addUsage(effective);
        if (normalized) {
          s.lastTurnUsage = {
            cacheReadTokens: normalized.cacheReadTokens,
            cacheWriteTokens: normalized.cacheWriteTokens,
            inputTokens: normalized.inputTokens ?? usage.inputTokens,
          };
        }
        try {
          const loops = getHostServices().loops;
          if (loops?.getActive()) {
            loops.noteUsage(billed);
          }
        } catch {
          // host services may not be bound in test environments
        }
      }
    }

    resolveAdaptiveModel(userMessage: string): { modelId: string; note?: string } {
      const s = st(this);
      try {
        const enabled = getHostServices().settings.get<boolean>(ADAPTIVE_ROUTING_SETTING) === true;
        if (!enabled) return { modelId: s.modelId };
        const queryClass = classifyQuery(userMessage);
        const samples = listTraces({ queryClass, limit: ADAPTIVE_ROUTING_TRACE_LIMIT }).map((t) => ({
          model: t.model,
          outcome: t.outcome,
          feedback: t.feedback,
        }));
        const choice = pickBestModel(samples);
        if (choice && choice.model !== s.modelId) {
          if (getHostServices().models.get(choice.model)) {
            return {
              modelId: choice.model,
              note: `↪ routed to ${choice.model} for ${queryClass} queries (learned from ${choice.samples} turns)\n\n`,
            };
          }
        }
      } catch {
        // Routing is best-effort; never break a turn over it.
      }
      return { modelId: s.modelId };
    }
  };
}
