// Shared OpenAI-compatible HTTP provider session.
//
// Two providers (lightclaw, local-llm) stream chat turns through an
// OpenAI-compatible `/chat/completions` endpoint with `stream: true`:
// each `sendTurn` POSTs one stateless request and pipes the SSE response
// through the shared `consumeOpenAiSseStream`. Their session classes were
// byte-identical apart from the provider name in two error strings, so both
// now construct this class with their own label, identity, and settings
// resolvers. Future OpenAI-compatible HTTP providers should do the same
// rather than copy the body.
//
// One AbortController owns the whole turn — connect, headers, and body
// consumption. The `timeoutMs` deadline and the host signal both feed it and
// it is only released in `finally`, so a server that sends headers and then
// stalls mid-stream is still bounded by the configured timeout, and
// `abortTurn` / `disconnect` can terminate active work.

import type { ProviderSession, ProviderStreamController, ProviderTurnInput, ProviderUsageSnapshot } from "../api";
import { normalizeOpenAiMessages, toolsToOpenAi } from "./openai-chat-utils";
import { consumeOpenAiSseStream } from "./openai-sse-consumer";

/** Late-bound settings lookups so each turn sees current values. */
export interface OpenAiHttpResolvers {
  baseUrl: () => string;
  apiKey: () => string;
  timeoutMs: () => number;
  verbose: () => boolean;
}

type TurnAbortReason = "timeout" | "host" | "session";

export class OpenAiHttpSession implements ProviderSession {
  readonly adapterId: string;
  readonly providerId: string;
  readonly mode = "stateless" as const;
  readonly strategy = "per-turn" as const;

  /** Aborts the in-flight turn, if any. Set for the lifetime of `sendTurn`. */
  private activeAbort: ((reason: TurnAbortReason) => void) | null = null;

  constructor(
    /** Provider name used in error messages (e.g. "lightclaw", "local-llm"). */
    private readonly providerLabel: string,
    private readonly resolvers: OpenAiHttpResolvers,
    ids: { adapterId: string; providerId: string },
  ) {
    this.adapterId = ids.adapterId;
    this.providerId = ids.providerId;
  }

  sendTurn = async (
    input: ProviderTurnInput,
    controller: ProviderStreamController,
  ): Promise<{ usage?: ProviderUsageSnapshot }> => {
    const baseUrl = this.resolvers.baseUrl();
    const apiKey = this.resolvers.apiKey();
    const timeoutMs = this.resolvers.timeoutMs();
    const verbose = this.resolvers.verbose();

    const messages = normalizeOpenAiMessages(input);
    const tools = toolsToOpenAi(input);

    const body: Record<string, unknown> = {
      model: input.modelId,
      messages,
      stream: true,
    };
    if (tools) body.tools = tools;

    controller.emit({ type: "status", status: "connecting" });

    const turn = new AbortController();
    let abortReason: TurnAbortReason | null = null;
    const abort = (reason: TurnAbortReason) => {
      abortReason ??= reason;
      turn.abort();
    };
    this.activeAbort = abort;
    const deadline = setTimeout(() => abort("timeout"), timeoutMs);
    const abortFromHost = () => abort("host");
    if (input.abortSignal) {
      if (input.abortSignal.aborted) abortFromHost();
      else input.abortSignal.addEventListener("abort", abortFromHost, { once: true });
    }

    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: turn.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(text || `${this.providerLabel} /chat/completions returned ${response.status}`);
      }

      if (!response.body) {
        throw new Error(`${this.providerLabel} /chat/completions returned no body`);
      }

      controller.emit({ type: "status", status: "streaming" });

      const usage = await consumeOpenAiSseStream(response.body, {
        controller,
        verbose,
        abortSignal: turn.signal,
      });
      return { usage };
    } catch (err) {
      const message =
        abortReason === "timeout"
          ? `${this.providerLabel} timed out after ${timeoutMs}ms`
          : abortReason
            ? `${this.providerLabel} turn aborted`
            : err instanceof Error
              ? err.message
              : String(err);
      controller.emit({ type: "error", message });
      throw abortReason || !(err instanceof Error) ? new Error(message) : err;
    } finally {
      clearTimeout(deadline);
      input.abortSignal?.removeEventListener("abort", abortFromHost);
      if (this.activeAbort === abort) this.activeAbort = null;
    }
  };

  abortTurn = async (): Promise<void> => {
    this.activeAbort?.("session");
  };

  disconnect = async (): Promise<void> => {
    await this.abortTurn();
  };
}
