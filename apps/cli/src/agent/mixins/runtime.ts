import type { ModelMessage } from "ai";
import { getHostServices, type KernelModelRuntime } from "../../core/plugins";
import type { AggregatedHookResult, HookInput } from "../../hooks/index";
import type { PostCompactHookInput, PreCompactHookInput } from "../../hooks/types";
import { appendCompaction, getNextMessageSequence } from "../../storage/index";
import type { SessionInfo, StreamChunk, TaskRequest, ToolResult, VerifyRecipe } from "../../types/index";
import type { SandboxSettings } from "../../utils/settings";
import { buildVerifyDetectPrompt, normalizeVerifyRecipe } from "../../verify/entrypoint";
import { runVerifyOrchestration } from "../../verify/orchestrator";
import { composeAbortSignals, extractJsonObject } from "./../agent-helpers";
import {
  type CompactionSettings,
  compactionHeadMessages,
  DEFAULT_KEEP_RECENT_TOKENS,
  DEFAULT_RESERVE_TOKENS,
  generateCompactionSummary,
  prepareCompaction,
  shouldCompactContext,
} from "./../compaction";
import { runSessionTurn } from "./../turns/session-turn";
import type { ProcessMessageObserver, SubagentExecutionContext, TurnContext } from "./../turns/types";

interface RuntimeState {
  abortController: AbortController | null;
  maxTokens: number;
  messageSeqs: Array<number | null>;
  messages: ModelMessage[];
  session: SessionInfo | null;
  turnContext(): TurnContext;
  appendCompletedTurn(userMessage: ModelMessage, newMessages: ModelMessage[]): void;
  consumeBackgroundNotifications(): Promise<string[]>;
  runTaskRequest(
    request: TaskRequest,
    onActivity?: (detail: string) => void,
    abortSignal?: AbortSignal,
    context?: SubagentExecutionContext,
  ): Promise<ToolResult>;
}

function st(self: object): RuntimeState {
  return self as unknown as RuntimeState;
}

// biome-ignore lint/suspicious/noExplicitAny: TS mixin base constraint must accept any[] (TS2545).
type MixinConstructor = new (...args: any[]) => object;

export function RuntimeMixin<TBase extends MixinConstructor>(Base: TBase) {
  return class Runtime extends Base {
    getCompactionSettings(): CompactionSettings {
      return {
        reserveTokens: Math.max(st(this).maxTokens, DEFAULT_RESERVE_TOKENS),
        keepRecentTokens: DEFAULT_KEEP_RECENT_TOKENS,
      };
    }

    async compactForContext(
      runtime: Pick<KernelModelRuntime, "model" | "modelInfo" | "providerOptions">,
      system: string,
      contextWindow: number,
      signal: AbortSignal,
      settings = this.getCompactionSettings(),
      force = false,
    ): Promise<boolean> {
      if (!st(this).session) return false;

      const preparation = prepareCompaction(st(this).messages, system, settings);
      if (!preparation) return false;
      if (!force && !shouldCompactContext(preparation.tokensBefore, contextWindow, settings)) {
        return false;
      }

      const trigger = force ? "manual" : "auto";
      const preCompactInput: PreCompactHookInput = {
        hook_event_name: "PreCompact",
        trigger,
        session_id: st(this).session?.id,
        cwd: getHostServices().bash.cwd(),
      };
      await this.fireHook(preCompactInput, signal).catch(() => {});

      const keptSeqs = st(this).messageSeqs.slice(preparation.firstKeptIndex);
      const firstKeptSeq =
        keptSeqs.find((seq): seq is number => seq !== null) ?? getNextMessageSequence(st(this).session!.id);
      const summary = await generateCompactionSummary(runtime, preparation, undefined, signal);

      appendCompaction(st(this).session!.id, firstKeptSeq, summary, preparation.tokensBefore);
      const head = compactionHeadMessages(summary, preparation.keptMessages);
      st(this).messages = [...head, ...preparation.keptMessages];
      st(this).messageSeqs = [...head.map(() => null), ...keptSeqs];

      const postCompactInput: PostCompactHookInput = {
        hook_event_name: "PostCompact",
        trigger,
        session_id: st(this).session?.id,
        cwd: getHostServices().bash.cwd(),
      };
      await this.fireHook(postCompactInput, signal).catch(() => {});

      return true;
    }

    /**
     * Process one turn through a ProviderSession that owns its own turn loop
     * (Claude Agent SDK, Codex CLI). Implementation: ./turns/session-turn.ts.
     */
    async *processMessageViaSession(args: {
      userMessage: string;
      userModelMessage: ModelMessage;
      observer?: ProcessMessageObserver;
      runtime: KernelModelRuntime;
      signal: AbortSignal;
    }): AsyncGenerator<StreamChunk, void, unknown> {
      yield* runSessionTurn(st(this).turnContext(), args);
    }

    /** xAI batch-mode turn loop. Implementation: ./turns/batch-turn.ts. */
    fireHook(input: HookInput, signal?: AbortSignal): Promise<AggregatedHookResult> {
      return getHostServices().hooks.runEvent(input, signal);
    }

    /**
     * Continue a turn after the user responded to a `tool_approval_request`.
     *
     * Why this exists: when `needsApproval` returns true on a tool call, the AI
     * SDK pauses tool execution and emits a `tool-approval-request` chunk; the
     * outer `streamText` call then completes. The user's accept/reject is captured
     * by {@link respondToToolApproval}, which pushes a `tool-approval-response`
     * message into `st(this).messages`. But the SDK only consumes that response on
     * the **next** `streamText` invocation. Without this method nothing
     * re-invokes streamText, so the approved tool never executes and the model
     * never sees the result.
     *
     * This delegates to `processMessage("", _, { preExistingAnchor })` so the
     * full streaming loop runs again with `st(this).messages` (which now contains
     * the approval response on the tail). The prelude (user-message push, vision
     * messages, UserPromptSubmit hook) is skipped because there is no new user
     * input — this is the same turn continuing.
     */
    async detectVerifyRecipe(settings?: SandboxSettings, abortSignal?: AbortSignal): Promise<VerifyRecipe | null> {
      try {
        const result = await st(this).runTaskRequest(
          {
            agent: "verify-detect",
            description: "Detect verification recipe",
            prompt: buildVerifyDetectPrompt(
              getHostServices().bash.cwd(),
              settings ?? getHostServices().bash.getSandboxSettings(),
            ),
          },
          undefined,
          abortSignal,
        );
        if (!result.success || !result.output) return null;
        const maybeJson = extractJsonObject(result.output);
        if (!maybeJson) return null;
        return normalizeVerifyRecipe(JSON.parse(maybeJson));
      } catch {
        return null;
      }
    }

    async runVerify(onProgress?: (detail: string) => void, abortSignal?: AbortSignal): Promise<ToolResult> {
      // The Agent always owns a controller for this run so `Agent.abort()` (Esc)
      // cancels it even when the caller supplied its own signal; the two are
      // composed rather than one replacing the other.
      const owned = new AbortController();
      st(this).abortController = owned;
      const signal = composeAbortSignals(abortSignal, owned.signal);
      const userModelMessage: ModelMessage = { role: "user", content: "/verify" };
      st(this).messages.push(userModelMessage);
      st(this).messageSeqs.push(null);

      try {
        await st(this).consumeBackgroundNotifications();
        const result = await runVerifyOrchestration(this as unknown as Parameters<typeof runVerifyOrchestration>[0], {
          onProgress,
          abortSignal: signal,
        });
        const assistantText = result.output || result.error || "Verification completed.";
        st(this).appendCompletedTurn(userModelMessage, [{ role: "assistant", content: assistantText }]);
        return result;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const failureText = signal.aborted ? "Verification aborted." : `Verification failed: ${msg}`;
        st(this).appendCompletedTurn(userModelMessage, [{ role: "assistant", content: failureText }]);
        return { success: false, output: failureText };
      } finally {
        // Clear by controller identity: a run that was replaced while in flight
        // must not null out its successor's controller.
        if (st(this).abortController === owned) {
          st(this).abortController = null;
        }
      }
    }
  };
}
