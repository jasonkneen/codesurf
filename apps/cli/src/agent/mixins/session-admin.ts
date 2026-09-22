import { disposeProviderSession, resolveModelRuntimeViaKernel } from "../../core/plugins";
import { generateTitle as genTitle } from "../../grok/client";
import type { SessionStore } from "../../storage/index";
import type { ScheduleDaemonStatus, ScheduleManager, StoredSchedule } from "../../tools/schedule";
import type { DelegationRun, SessionInfo, UsageSource } from "../../types/index";
import { DEFAULT_TITLE_MODEL } from "./../constants";
import type { DelegationManager } from "./../delegations";

interface SessionAdminState {
  apiKey: string | null;
  delegations: DelegationManager;
  recapsEnabled: boolean;
  schedules: ScheduleManager;
  session: SessionInfo | null;
  captureSessionTarget(): { store: SessionStore; session: SessionInfo } | null;
  isCurrentSessionTarget(target: { store: SessionStore; session: SessionInfo }): boolean;
  recordUsage(
    usage?: {
      totalTokens?: number;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    },
    source?: UsageSource,
    model?: string,
  ): void;
}

function st(self: object): SessionAdminState {
  return self as unknown as SessionAdminState;
}

// biome-ignore lint/suspicious/noExplicitAny: TS mixin base constraint must accept any[] (TS2545).
type MixinConstructor = new (...args: any[]) => object;

export function SessionAdminMixin<TBase extends MixinConstructor>(Base: TBase) {
  return class SessionAdmin extends Base {
    async reconnectProviderSession(): Promise<boolean> {
      if (!st(this).session) return false;
      await disposeProviderSession(st(this).session!.id);
      return true;
    }

    async listSchedules(): Promise<StoredSchedule[]> {
      return st(this).schedules.list();
    }

    async removeSchedule(id: string): Promise<string> {
      const removed = await st(this).schedules.remove(id);
      return removed ? `Removed schedule "${removed.name}".` : `Schedule "${id}" not found.`;
    }

    async getScheduleDaemonStatus(): Promise<ScheduleDaemonStatus> {
      return st(this).schedules.getDaemonStatus();
    }

    /**
     * System prompt used for context-meter ESTIMATES only. `getContextStats` /
     * `getContextBreakdown` run on every UI render (including every stream
     * chunk), and `buildSystemPrompt` walks the persona/memory file chain with
     * sync fs reads — far too expensive per frame. A short TTL keeps the meter
     * honest (instruction files rarely change mid-stream) while making renders
     * O(messages) instead of O(filesystem). Real turns and compaction still
     * build the prompt fresh.
     */

    /**
     * Fold this turn's request into the disclosed skill set and render it.
     *
     * Returns null when nothing is disclosed AND nothing is indexed (no skills
     * installed), so a bare install carries no skills section at all.
     */

    async generateTitle(userMessage: string): Promise<string> {
      if (!st(this).apiKey) {
        return "New session";
      }

      // The UI launches this asynchronously, so the session can change under
      // the await. Capture the requesting session; if it is no longer current
      // when the title arrives, the result is stale and is discarded rather
      // than written (with its usage) onto whichever session replaced it.
      const target = st(this).captureSessionTarget();
      const titleRuntime = await resolveModelRuntimeViaKernel(DEFAULT_TITLE_MODEL, target?.session.id ?? "ephemeral");
      const generated = await genTitle(titleRuntime, userMessage);
      if (!target || !st(this).isCurrentSessionTarget(target)) {
        return generated.title;
      }
      st(this).recordUsage(generated.usage, "title", generated.modelId);
      if (st(this).session && !st(this).session!.title && generated.title) {
        target.store.setTitle(target.session.id, generated.title);
        st(this).session = target.store.getRequiredSession(target.session.id);
      }
      return generated.title;
    }

    /** Snapshot of which session (and store) a deferred request belongs to. */
    getSessionRecap(): string | null {
      return st(this).recapsEnabled ? st(this).session?.recap?.text || null : null;
    }

    getRecapsEnabled(): boolean {
      return st(this).recapsEnabled;
    }

    setRecapsEnabled(enabled: boolean): void {
      st(this).recapsEnabled = enabled;
    }

    async getDelegationRuns(): Promise<DelegationRun[]> {
      return st(this).delegations.list();
    }

    /** Saved output for a delegation. Returns a "still running" sentinel while in flight. */
    async getDelegationOutput(id: string): Promise<string> {
      return st(this).delegations.read(id);
    }
  };
}
