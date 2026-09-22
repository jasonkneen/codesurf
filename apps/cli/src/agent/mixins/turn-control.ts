import type { ModelMessage } from "ai";
import {
  disposeAllProviderSessions,
  fireUserInterrupt,
  getHostServices,
  resolveModelRuntimeViaKernel,
} from "../../core/plugins";
import type { UserInterruptHookInput } from "../../hooks/types";
import { shutdownWorkspaceLspManager } from "../../lsp/runtime";
import type { SessionInfo, SubagentStatus, UsageSource } from "../../types/index";
import { runSideQuestion, type SideQuestionResult } from "../../utils/side-question";
import type { DelegationManager } from "./../delegations";
import type { SessionToolsets } from "./../session-toolsets";

interface TurnControlState {
  abortController: AbortController | null;
  apiKey: string | null;
  currentProviderSession: {
    abortTurn?(): Promise<unknown>;
    respondToToolApproval?(approvalId: string, approved: boolean): void;
  } | null;
  delegations: DelegationManager;
  manualCompactController: AbortController | null;
  messageSeqs: Array<number | null>;
  messages: ModelMessage[];
  modelAdapterId: string | undefined;
  modelId: string;
  pendingApprovalId: string | null;
  session: SessionInfo | null;
  toolsets: SessionToolsets;
  emitSubagentStatus(status: SubagentStatus | null, runKey?: string): void;
  fireHook(input: unknown): Promise<unknown>;
  getSessionId(): string | null;
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

function st(self: object): TurnControlState {
  return self as unknown as TurnControlState;
}

// biome-ignore lint/suspicious/noExplicitAny: TS mixin base constraint must accept any[] (TS2545).
type MixinConstructor = new (...args: any[]) => object;

export function TurnControlMixin<TBase extends MixinConstructor>(Base: TBase) {
  return class TurnControl extends Base {
    async askSideQuestion(question: string, signal?: AbortSignal): Promise<SideQuestionResult> {
      if (!st(this).apiKey) {
        return { response: "No API key configured." };
      }

      const contextParts: string[] = [];
      let charBudget = 2000;
      for (let i = st(this).messages.length - 1; i >= 0 && charBudget > 0; i--) {
        const msg = st(this).messages[i];
        if (msg.role !== "user" && msg.role !== "assistant") continue;
        const text =
          typeof msg.content === "string"
            ? msg.content
            : Array.isArray(msg.content)
              ? msg.content
                  .filter((p: { type: string }) => p.type === "text")
                  .map((p: { type: string; text?: string }) => p.text ?? "")
                  .join("")
              : "";
        if (!text) continue;
        const snippet = text.length > 400 ? `${text.slice(0, 400)}…` : text;
        contextParts.unshift(`[${msg.role}]: ${snippet}`);
        charBudget -= snippet.length;
      }
      const conversationContext = contextParts.join("\n\n");

      const runtime = await resolveModelRuntimeViaKernel(st(this).modelId, st(this).getSessionId() ?? "ephemeral", {
        adapterId: st(this).modelAdapterId,
      });
      const result = await runSideQuestion(question, runtime, conversationContext, signal);
      st(this).recordUsage(result.usage, "other");
      return result;
    }

    /**
     * Stop the in-flight turn.
     *
     * `userInitiated` (default true) says a HUMAN asked for the stop — Esc, the
     * stop button. Only then are the process-wide interrupt signals raised
     * (`fireUserInterrupt()` and the `UserInterrupt` event), which halt /loop,
     * voice and workflow scripts for EVERY session in the process. A host
     * aborting for its own reasons — an HTTP client disconnecting in
     * multi-session `serve` / `node` — passes `{ userInitiated: false }` so it
     * cancels this turn without stopping another session's loop.
     */
    abort(options: { userInitiated?: boolean } = {}): void {
      const userInitiated = options.userInitiated ?? true;
      const hadInFlightWork = st(this).abortController !== null || st(this).manualCompactController !== null;
      st(this).abortController?.abort();
      st(this).manualCompactController?.abort();
      // Owning-adapter turns (Claude Agent SDK, Codex, Codesurf desktop) run
      // their own loop behind `sendTurn`; aborting our AbortController alone does
      // not cancel them. Forward the interrupt to the active provider session so
      // its in-flight turn actually stops. Best-effort: swallow sync throws and
      // promise rejections — abort must never throw.
      try {
        void Promise.resolve(st(this).currentProviderSession?.abortTurn?.()).catch(() => {});
      } catch {
        // abortTurn threw synchronously — ignore.
      }
      st(this).emitSubagentStatus(null);
      if (!userInitiated) return;
      // Cancel extension work that owns its own loop (workflow scripts driving
      // sub-agents). Those run outside the turn's AbortController, so without
      // this they kept spending tokens after the user pressed Esc.
      fireUserInterrupt();
      // Tell in-process listeners (auto loops, voice, /loop) that the HUMAN
      // interrupted. `Stop` fires on every successful turn settle, so anything
      // that means "halt because the user said so" must key off this event.
      // Only fire when something was actually in flight so stray Esc presses
      // at an idle prompt don't cancel background loop state.
      if (hadInFlightWork) {
        const interruptInput: UserInterruptHookInput = {
          hook_event_name: "UserInterrupt",
          session_id: st(this).session?.id,
          cwd: getHostServices().bash.cwd(),
        };
        st(this)
          .fireHook(interruptInput)
          .catch(() => {});
      }
    }

    async cleanup(): Promise<void> {
      // Detached delegation children survive the parent by design (that is the
      // point of `delegate`), but they must not survive the SESSION: without this
      // they keep running, keep spending tokens, and — since an explore child has
      // a shell — keep touching the workspace after the TUI has exited.
      await st(this).delegations.killStarted();

      // The MCP bundle is session-scoped now, so this is the only place its
      // server subprocesses get torn down. `shutdown()` closes admission first,
      // so a connect completing after this point can neither publish its bundle
      // nor start another.
      await st(this).toolsets.shutdown();

      // The kernel's BashTool is owned by the `builtin.tools.bash` extension —
      // its `onDispose()` cleans up on extension teardown. We still call
      // `services.bash.cleanup()` here because the historical contract was
      // "Agent.cleanup tears down bash background processes," and headless
      // callers may invoke this without going through `shutdownPlugins()`.
      // Idempotent: the underlying `BashTool.cleanup()` no-ops on second call.
      //
      // Each call is wrapped in `Promise.resolve().then(...)` so a synchronous
      // throw from `requireBashSink()` (e.g. if `setBashSink(null)` ran ahead
      // of `agent.cleanup()` during a teardown race) becomes a rejected promise
      // that `Promise.allSettled` absorbs, rather than escaping the array
      // literal and rejecting the whole cleanup.
      const services = getHostServices().bash;
      await Promise.allSettled([
        Promise.resolve().then(() => services.cleanup()),
        Promise.resolve().then(() => shutdownWorkspaceLspManager(services.cwd())),
        Promise.resolve().then(() => disposeAllProviderSessions()),
      ]);
    }

    respondToToolApproval(approvalId: string, approved: boolean): void {
      // Answered — the next user message no longer has to settle it.
      if (st(this).pendingApprovalId === approvalId) {
        st(this).pendingApprovalId = null;
      }
      // Owning-adapter branch: the SDK subprocess is blocked inside `canUseTool`
      // waiting on a Promise resolved by the session. Route the response there
      // before falling through to the ai-sdk model-message path so we don't
      // hang the subprocess if both branches fire (rare, but cheap to guard).
      const providerSession = st(this).currentProviderSession;
      if (providerSession?.respondToToolApproval) {
        try {
          providerSession.respondToToolApproval(approvalId, approved);
          return;
        } catch (err) {
          console.error("[agent] provider respondToToolApproval failed:", err);
          // Fall through to the ai-sdk path so the model-message-based flow
          // (file edits, paid_request) still gets the response.
        }
      }
      const toolApprovalResponse: ModelMessage = {
        role: "tool",
        content: [
          {
            type: "tool-approval-response" as const,
            approvalId,
            approved,
          },
        ],
      };
      st(this).messages.push(toolApprovalResponse);
      st(this).messageSeqs.push(null);
    }
  };
}
