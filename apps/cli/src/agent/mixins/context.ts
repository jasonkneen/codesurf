import type { ModelMessage } from "ai";
import {
  type ContextBreakdown,
  type ContextStats,
  getHostServices,
  type KernelModelRuntime,
  resolveModelRuntimeViaKernel,
} from "../../core/plugins";
import type { AgentMode, SessionInfo } from "../../types/index";
import { formatCacheStatsLine } from "../../utils/skill-context";
import { type CompactionSettings, computeContextBreakdown } from "./../compaction";
import type { SessionPromptContext } from "./../prompt-context";
import { buildSystemPrompt } from "./../prompts";
import type { SessionToolsets } from "./../session-toolsets";

interface ContextState {
  promptContext: SessionPromptContext;
  toolsets: SessionToolsets;
  lastTurnUsage: { cacheReadTokens?: number; cacheWriteTokens?: number; inputTokens?: number } | null;
  estimateSystemPromptCache: { key: string; system: string; builtAt: number } | null;
  manualCompactController: AbortController | null;
  mode: AgentMode;
  planContext: string | null;
  session: SessionInfo | null;
  modelId: string;
  modelAdapterId: string | undefined;
  messages: ModelMessage[];
  getSessionId(): string | null;
  compactForContext(
    runtime: Pick<KernelModelRuntime, "model" | "modelInfo" | "providerOptions">,
    system: string,
    contextWindow: number,
    signal: AbortSignal,
    settings?: CompactionSettings,
    force?: boolean,
  ): Promise<boolean>;
  getCompactionSettings(): CompactionSettings;
}

function st(self: object): ContextState {
  return self as unknown as ContextState;
}

// biome-ignore lint/suspicious/noExplicitAny: TS mixin base constraint must accept any[] (TS2545).
type MixinConstructor = new (...args: any[]) => object;

export function ContextMixin<TBase extends MixinConstructor>(Base: TBase) {
  return class ContextMethods extends Base {
    getCacheStatsLine(usage?: {
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      inputTokens?: number;
    }): string | null {
      if (!usage) return null;
      return formatCacheStatsLine(usage, st(this).promptContext.stats()?.skills);
    }

    /**
     * The cache-stats line for the most recent turn, or null before any usage has
     * been reported. This is the only instrument for prefix-cache health: a large
     * `read` with a small `written` is the healthy steady state, and a large
     * `written` on a later turn means something ahead of the cached span changed.
     */
    getLastCacheStatsLine(): string | null {
      const s = st(this);
      const line = this.getCacheStatsLine(s.lastTurnUsage ?? undefined);
      if (!line) return null;
      // Surfaced because MCP tool churn invalidates the prefix ahead of the system
      // prompt — a large `written` with this flag set has a known cause.
      return s.toolsets.mcpToolsChurned ? `${line} · mcp tools changed` : line;
    }

    /** Drop progressive-context state. Call where the cache is discarded anyway
     *  (session switch, compaction) — never mid-conversation. */
    resetProgressiveContext(): void {
      const s = st(this);
      s.promptContext.reset();
      // A new cache generation is also the right point to drop the churn canary
      // and the MCP connections: the schemas no longer need to stay stable
      // against the old prefix, and a reconnect picks up server config changed
      // since the session started.
      s.toolsets.resetForNewCacheGeneration();
      s.lastTurnUsage = null;
    }

    getSystemPromptForEstimate(): string {
      const s = st(this);
      const TTL_MS = 3_000;
      const host = getHostServices();
      const key = [host.bash.cwd(), s.mode, host.bash.getSandboxMode(), s.planContext ?? ""].join("\u0000");
      const cached = s.estimateSystemPromptCache;
      if (cached && cached.key === key && Date.now() - cached.builtAt < TTL_MS) {
        return cached.system;
      }
      const system = buildSystemPrompt(
        host.bash.cwd(),
        s.mode,
        host.bash.getSandboxMode(),
        s.planContext,
        undefined,
        host.bash.getSandboxSettings(),
      );
      s.estimateSystemPromptCache = { key, system, builtAt: Date.now() };
      return system;
    }

    getContextStats(contextWindow: number, inFlightText = ""): ContextStats {
      return this.getContextBreakdown(contextWindow, inFlightText);
    }

    /**
     * Per-component token estimate. Used by the footer meter, the /context
     * command (via services.context.getBreakdown), and auto-compaction
     * diagnostics. Single math path: `computeContextBreakdown` in compaction.ts.
     */
    getContextBreakdown(contextWindow: number, inFlightText = ""): ContextBreakdown {
      const s = st(this);
      return computeContextBreakdown(this.getSystemPromptForEstimate(), s.messages, contextWindow, inFlightText);
    }

    /**
     * Force a compaction outside a turn (the `/context compact` path). Abortable
     * via `Agent.abort()` so Esc cancels the summarizer LLM call.
     */
    async manualCompact(): Promise<boolean> {
      const s = st(this);
      if (!s.session || !s.modelId) return false;
      const controller = new AbortController();
      s.manualCompactController = controller;
      try {
        const runtime = await resolveModelRuntimeViaKernel(s.modelId, s.getSessionId() ?? "ephemeral", {
          adapterId: s.modelAdapterId,
        });
        const system = buildSystemPrompt(
          getHostServices().bash.cwd(),
          s.mode,
          getHostServices().bash.getSandboxMode(),
          s.planContext,
          undefined,
          getHostServices().bash.getSandboxSettings(),
        );
        const contextWindow = (runtime.modelInfo as { contextWindow?: number })?.contextWindow ?? 200_000;
        return await s.compactForContext(
          runtime,
          system,
          contextWindow,
          controller.signal,
          s.getCompactionSettings(),
          true, // force
        );
      } catch (err) {
        if (controller.signal.aborted) return false;
        console.error("[agent] manualCompact failed:", err);
        return false;
      } finally {
        if (s.manualCompactController === controller) {
          s.manualCompactController = null;
        }
      }
    }
  };
}
