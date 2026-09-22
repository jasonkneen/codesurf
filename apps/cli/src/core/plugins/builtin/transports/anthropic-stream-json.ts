// Anthropic "stream-json" wire format -> CodeSurf ProviderStreamEvent.
//
// This is the lingua franca of the agent-CLI ecosystem. Three of the CLIs we
// drive speak it verbatim:
//
//   claude  Agent SDK messages (`includePartialMessages: true`)
//   amp     `-x --stream-json --stream-json-input`  ("Claude Code-compatible
//           stream JSON format" per its own --help)
//   grok    `--output-format streaming-messages-json --include-partial-messages`
//           ("NDJSON in the Anthropic Messages API wire format")
//
// The message envelope:
//
//   {"type":"system","subtype":"init",...}
//   {"type":"assistant","message":{"content":[ ...blocks ],"usage":{...}}}
//   {"type":"user","message":{"content":[{"type":"tool_result",...}]}}
//   {"type":"stream_event","event":{"type":"content_block_delta","delta":{...}}}
//   {"type":"result","subtype":"success","usage":{...}}
//
// THE DEDUPE RULE (the subtle part, and why this lives in one place):
// when partial streaming is on, each text/thinking block arrives TWICE — once
// as a run of `stream_event` deltas, then again whole inside the following
// complete `assistant` message. Emitting both duplicates every response. We
// latch "partials were seen for this turn" and let the complete message's
// text/thinking blocks fall through silently. Tool-use blocks are the reverse:
// they only ever arrive complete (their `input_json_delta` partials carry
// fragmentary JSON), so those are always taken from the assistant message.

import type { ProviderStreamEvent, ProviderUsageSnapshot } from "../../api";

interface WireUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface WireBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface WireMessage {
  type?: string;
  subtype?: string;
  message?: { content?: WireBlock[]; usage?: WireUsage; stop_reason?: string | null };
  event?: { type?: string; delta?: { type?: string; text?: string; thinking?: string } };
  usage?: WireUsage;
  is_error?: boolean;
  error?: unknown;
  result?: unknown;
  stop_reason?: string | null;
  session_id?: string;
}

function usageFromWire(usage: WireUsage | undefined): ProviderUsageSnapshot | undefined {
  if (!usage) return undefined;
  const snapshot: ProviderUsageSnapshot = {};
  if (typeof usage.input_tokens === "number") snapshot.inputTokens = usage.input_tokens;
  if (typeof usage.output_tokens === "number") snapshot.outputTokens = usage.output_tokens;
  if (typeof usage.cache_read_input_tokens === "number") snapshot.cacheReadTokens = usage.cache_read_input_tokens;
  if (typeof usage.cache_creation_input_tokens === "number") {
    snapshot.cacheWriteTokens = usage.cache_creation_input_tokens;
  }
  return Object.keys(snapshot).length > 0 ? snapshot : undefined;
}

/**
 * Which message ends a turn. This is NOT cosmetic — the two families disagree,
 * and picking wrong either hangs the turn or truncates it.
 *
 * `"result"` — one-shot CLIs (grok, lazar, fractal). The process runs one turn
 *   and exits; its `result` line is both turn end and session end.
 *
 * `"assistant-stop"` — CLIs holding a session open on stdin (amp). Verified by
 *   feeding amp two turns on one stdin and timestamping its output:
 *
 *     assistant "alpha"  stop_reason:end_turn   ← turn 1 ends here
 *     assistant "beta"   stop_reason:end_turn   ← turn 2 ends here
 *     result             num_turns:2            ← only after stdin closed
 *
 *   `result` arrives ONCE, at EOF. Waiting for it per-turn deadlocks: the user
 *   never gets turn 1 back, and the stall watchdog eventually kills the turn.
 */
export type TurnBoundary = "result" | "assistant-stop";

/** Stop reasons that actually end a turn. `tool_use` and `pause_turn` mean the
 *  agent is continuing, so an assistant message carrying them must not settle. */
const TERMINAL_STOP_REASONS = new Set(["end_turn", "stop_sequence", "max_tokens", "refusal"]);

export interface AnthropicStreamJsonDecoderOptions {
  /** Tool names whose `tool-call` / `tool-result` cards should be suppressed
   *  (the host renders them through a bespoke surface instead). */
  suppressToolNames?: ReadonlySet<string>;
  /** Session id sink — amp/grok/claude all report theirs on the init message,
   *  and we need it to resume the conversation on the next turn. */
  onSessionId?: (sessionId: string) => void;
  /** Defaults to `"result"` (one-shot CLI semantics). */
  turnEndsOn?: TurnBoundary;
}

export interface DecodedTurnState {
  /** Terminal usage, taken from the last `result` (or assistant) message. */
  usage: ProviderUsageSnapshot;
  /** Set once a `result` message arrives — the turn is over. */
  finished: boolean;
  stopReason?: string;
  /** Populated when the CLI reported a hard error for the turn. */
  errorMessage?: string;
}

/**
 * Stateful per-turn decoder. Construct one per turn (the dedupe latches are
 * turn-scoped), feed it parsed NDJSON values, and emit whatever it returns.
 */
export class AnthropicStreamJsonDecoder {
  readonly state: DecodedTurnState = { usage: {}, finished: false };

  private streamedText = false;
  private streamedThinking = false;
  private readonly suppressToolNames: ReadonlySet<string>;
  private readonly suppressedToolUseIds = new Set<string>();
  private readonly onSessionId?: (sessionId: string) => void;
  private readonly turnEndsOn: TurnBoundary;

  constructor(options: AnthropicStreamJsonDecoderOptions = {}) {
    this.suppressToolNames = options.suppressToolNames ?? new Set();
    this.onSessionId = options.onSessionId;
    this.turnEndsOn = options.turnEndsOn ?? "result";
  }

  /** Decode one NDJSON value into zero or more host stream events. */
  push(value: unknown): ProviderStreamEvent[] {
    if (!value || typeof value !== "object") return [];
    const message = value as WireMessage;

    switch (message.type) {
      case "system":
        if (typeof message.session_id === "string" && message.session_id) {
          this.onSessionId?.(message.session_id);
        }
        return [];

      case "stream_event":
        return this.pushStreamEvent(message);

      case "assistant":
        return this.pushAssistant(message);

      case "user":
        return this.pushUser(message);

      case "result":
        return this.pushResult(message);

      default:
        return [];
    }
  }

  private pushStreamEvent(message: WireMessage): ProviderStreamEvent[] {
    const event = message.event;
    if (event?.type !== "content_block_delta") return [];
    const delta = event.delta;
    if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
      this.streamedText = true;
      return [{ type: "text-delta", delta: delta.text }];
    }
    if (delta?.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking.length > 0) {
      this.streamedThinking = true;
      return [{ type: "reasoning-delta", delta: delta.thinking }];
    }
    // signature_delta / input_json_delta carry no user-visible content:
    // tool arguments are taken whole from the assistant message below.
    return [];
  }

  private pushAssistant(message: WireMessage): ProviderStreamEvent[] {
    const events: ProviderStreamEvent[] = [];
    for (const block of message.message?.content ?? []) {
      if (block.type === "text" && typeof block.text === "string") {
        // Already emitted delta-by-delta — see THE DEDUPE RULE above.
        if (!this.streamedText && block.text.length > 0) {
          events.push({ type: "text-delta", delta: block.text });
        }
      } else if (block.type === "thinking" && typeof block.thinking === "string") {
        if (!this.streamedThinking && block.thinking.length > 0) {
          events.push({ type: "reasoning-delta", delta: block.thinking });
        }
      } else if (block.type === "tool_use") {
        const name = block.name ?? "";
        if (this.suppressToolNames.has(name)) {
          // Remember the id so the matching tool_result is suppressed too.
          if (block.id) this.suppressedToolUseIds.add(block.id);
          continue;
        }
        events.push({ type: "tool-call", id: block.id ?? "", toolName: name, args: block.input });
      }
    }
    const usage = usageFromWire(message.message?.usage);
    if (usage) this.state.usage = { ...this.state.usage, ...usage };
    // amp reports the terminal stop_reason here and NOT on its per-turn output
    // (its `result` only arrives at EOF); grok reports it in both places. Take
    // it from whichever arrives — `result` wins later, since it is last.
    const stopReason = message.message?.stop_reason;
    if (typeof stopReason === "string") {
      this.state.stopReason = stopReason;
      // For stdin-session CLIs this message IS the end of the turn.
      if (this.turnEndsOn === "assistant-stop" && TERMINAL_STOP_REASONS.has(stopReason)) {
        this.state.finished = true;
      }
    }
    return events;
  }

  private pushUser(message: WireMessage): ProviderStreamEvent[] {
    const events: ProviderStreamEvent[] = [];
    for (const block of message.message?.content ?? []) {
      if (block.type !== "tool_result") continue;
      const id = block.tool_use_id ?? "";
      if (id && this.suppressedToolUseIds.has(id)) continue;
      events.push({ type: "tool-result", id, result: block.content, isError: block.is_error === true });
    }
    return events;
  }

  private pushResult(message: WireMessage): ProviderStreamEvent[] {
    this.state.finished = true;
    const usage = usageFromWire(message.usage);
    if (usage) this.state.usage = { ...this.state.usage, ...usage };
    if (typeof message.stop_reason === "string") this.state.stopReason = message.stop_reason;

    const events: ProviderStreamEvent[] = [];
    const failed = message.is_error === true || message.subtype === "error";
    if (failed) {
      const detail =
        typeof message.error === "string"
          ? message.error
          : typeof message.result === "string"
            ? message.result
            : (message.subtype ?? "unknown error");
      this.state.errorMessage = detail;
      events.push({ type: "error", message: detail });
    }
    if (this.state.usage.inputTokens !== undefined || this.state.usage.outputTokens !== undefined) {
      events.push({ type: "usage", usage: this.state.usage });
    }
    return events;
  }
}
