// Shared OpenAI-compatible SSE stream consumer.
//
// Two providers (lightclaw, hermes-gateway) both hit a `/chat/completions`
// endpoint with `stream: true` and need to translate the resulting
// text/event-stream into ProviderStreamEvent. The wire format is OpenAI-
// shaped: each blank-line-delimited block carries one or more `data: <json>`
// lines, where the JSON is `{ choices: [{ delta: { content, reasoning,
// reasoning_content, tool_calls }, finish_reason }], usage }`.
//
// Framing is line-based per the SSE spec: a line ends at LF, CRLF or a bare
// CR, and a blank line dispatches the event. Line terminators and multi-byte
// UTF-8 sequences may be split across chunks. Any single line, any event, or
// any unterminated remainder longer than `maxEventChars` rejects the stream
// so a misbehaving server cannot make the consumer buffer without bound.
//
// Hermes layers a custom `event: hermes.tool.progress` block on top to surface
// gateway-side agent tool lifecycle. Other providers might extend this
// surface in the future. The consumer exposes `onNamedEvent` so extending
// adapters can intercept named events before the OpenAI default handler.

import type { ProviderStreamController, ProviderUsageSnapshot } from "../api";

interface SseReader {
  read: () => Promise<{ done: boolean; value?: Uint8Array }>;
  cancel: (reason?: unknown) => Promise<void>;
  releaseLock: () => void;
}

interface ToolCallPart {
  id: string;
  name: string;
  argsBuffer: string;
  emitted: boolean;
}

const MAX_TEXT_DELTA_CHARS = 160;

/** Default upper bound on the characters held for one SSE line or event. */
export const MAX_SSE_EVENT_CHARS = 4 * 1024 * 1024;

export interface ConsumeOpenAiSseOptions {
  controller: ProviderStreamController;
  /** Surface SSE parse errors as `error` events instead of swallowing them. */
  verbose?: boolean;
  abortSignal?: AbortSignal;
  /**
   * Reject the stream (and cancel the reader) when a single line, a whole
   * event, or the unterminated tail of the buffer exceeds this many
   * characters. Defaults to `MAX_SSE_EVENT_CHARS`.
   */
  maxEventChars?: number;
  /**
   * Pre-handler invoked for each SSE event whose `event:` line names a
   * non-default ("message") channel. Return `true` to mark the event
   * consumed — the default OpenAI handler is skipped. Return `false` /
   * `undefined` to fall through to the OpenAI handler with the same data.
   *
   * Hermes uses this to handle `event: hermes.tool.progress`.
   */
  onNamedEvent?: (eventName: string, data: string) => boolean | undefined;
}

interface OpenAiSseChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export async function consumeOpenAiSseStream(
  body: ReadableStream<Uint8Array>,
  options: ConsumeOpenAiSseOptions,
): Promise<ProviderUsageSnapshot | undefined> {
  const { controller, verbose = false, abortSignal, onNamedEvent, maxEventChars = MAX_SSE_EVENT_CHARS } = options;
  const reader = body.getReader() as SseReader;
  const decoder = new TextDecoder();
  let buffer = "";
  let finalUsage: ProviderUsageSnapshot | undefined;
  // The last finish_reason seen. `done` is emitted once, at [DONE] or EOF, so
  // a trailing usage-only chunk is counted before the host settles the turn.
  let stopReason: string | undefined;
  const toolCallParts: Record<number, ToolCallPart> = {};

  // Event under construction (SSE lines seen since the last blank line).
  let eventName = "message";
  let dataParts: string[] = [];
  let eventChars = 0;

  const oversized = () => new Error(`SSE event exceeded ${maxEventChars} characters`);

  /** Handle one complete event. Returns `true` when the stream is terminated by `[DONE]`. */
  const dispatchEvent = (name: string, data: string): boolean => {
    // Allow adapters to intercept their own named events before the
    // default OpenAI handler.
    if (name !== "message" && onNamedEvent?.(name, data)) return false;

    if (data === "[DONE]") return true;

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      if (verbose) {
        controller.emit({
          type: "error",
          message: `Failed to parse SSE chunk: ${data.slice(0, 120)}`,
        });
      }
      return false;
    }

    const event = parsed as OpenAiSseChunk;
    const choice = event.choices?.[0];
    if (choice) {
      const delta = choice.delta;
      if (typeof delta?.content === "string") {
        emitTextDeltas(controller, delta.content);
      }

      const reasoning = delta?.reasoning ?? delta?.reasoning_content;
      if (typeof reasoning === "string") {
        controller.emit({ type: "reasoning-delta", delta: reasoning });
      }

      if (Array.isArray(delta?.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = typeof tc.index === "number" ? tc.index : 0;
          if (!toolCallParts[idx]) {
            toolCallParts[idx] = { id: "", name: "", argsBuffer: "", emitted: false };
          }
          const part = toolCallParts[idx];
          if (typeof tc.id === "string" && tc.id) part.id = tc.id;
          if (tc.function?.name) part.name = tc.function.name;
          if (typeof tc.function?.arguments === "string") {
            part.argsBuffer += tc.function.arguments;
          }
        }
      }

      if (choice.finish_reason === "tool_calls") {
        emitToolCalls(toolCallParts, controller);
      }

      if (choice.finish_reason && choice.finish_reason !== "null") {
        if (choice.finish_reason === "stop") {
          emitToolCalls(toolCallParts, controller);
        }
        stopReason = choice.finish_reason;
        // Don't emit `done` yet — let the stream finish naturally so usage can arrive.
      }
    }

    // Usage is independent of choices: OpenAI-compatible servers send the
    // final accounting as `{ choices: [], usage }` after the finish chunk.
    if (event.usage) {
      finalUsage = {
        ...finalUsage,
        inputTokens: event.usage.prompt_tokens ?? finalUsage?.inputTokens,
        outputTokens: event.usage.completion_tokens ?? finalUsage?.outputTokens,
      };
      controller.emit({ type: "usage", usage: finalUsage });
    }
    return false;
  };

  /** Feed one complete line into the current event. Returns `true` on `[DONE]`. */
  const handleLine = (line: string): boolean => {
    if (line.length > maxEventChars) throw oversized();
    if (line === "") {
      const name = eventName;
      const parts = dataParts;
      eventName = "message";
      dataParts = [];
      eventChars = 0;
      if (parts.length === 0) return false;
      return dispatchEvent(name, parts.join("\n"));
    }
    eventChars += line.length;
    if (eventChars > maxEventChars) throw oversized();
    if (line.startsWith(":")) return false; // SSE comment
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      // Per spec, a single leading space after `data:` is stripped;
      // additional whitespace is preserved.
      const rest = line.slice(5);
      dataParts.push(rest.startsWith(" ") ? rest.slice(1) : rest);
    }
    return false;
  };

  /**
   * Pull every complete line out of `buffer`. A bare CR at the very end is
   * held back (unless `flush`, at EOF) because the next chunk may turn it
   * into CRLF. Returns `true` once `[DONE]` has been dispatched.
   */
  const drainLines = (flush: boolean): boolean => {
    let start = 0;
    while (start < buffer.length) {
      let end = -1;
      let skip = 0;
      for (let i = start; i < buffer.length; i++) {
        const code = buffer.charCodeAt(i);
        if (code === 10) {
          end = i;
          skip = 1;
          break;
        }
        if (code === 13) {
          if (i + 1 < buffer.length) {
            end = i;
            skip = buffer.charCodeAt(i + 1) === 10 ? 2 : 1;
          } else if (flush) {
            end = i;
            skip = 1;
          }
          break;
        }
      }
      if (end < 0) break;
      const line = buffer.slice(start, end);
      start = end + skip;
      if (handleLine(line)) {
        buffer = "";
        return true;
      }
    }
    buffer = buffer.slice(start);
    if (buffer.length > maxEventChars) throw oversized();
    return false;
  };

  try {
    while (true) {
      let readResult: { done: boolean; value?: Uint8Array };
      try {
        readResult = await readWithAbort(reader, abortSignal);
      } catch (err) {
        if (abortSignal?.aborted) throw new DOMException("Aborted", "AbortError");
        throw err;
      }
      const { done, value } = readResult;
      if (done) {
        buffer += decoder.decode();
        drainLines(true);
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      if (drainLines(false)) break;
    }

    // Exactly one terminal event, after any trailing usage. A stream that
    // ended without a finish_reason is reported as an ordinary stop.
    emitToolCalls(toolCallParts, controller);
    controller.emit({ type: "usage", usage: finalUsage ?? {} });
    controller.emit({ type: "done", stopReason: stopReason ?? "stop" });
  } catch (err) {
    // Release the wire on any failure so the server-side turn does not linger.
    await reader.cancel(err).catch(() => {});
    throw err;
  } finally {
    reader.releaseLock();
  }

  return finalUsage;
}

export function splitReadableTextDelta(delta: string, maxChars = MAX_TEXT_DELTA_CHARS): string[] {
  if (delta.length <= maxChars) return delta ? [delta] : [];
  const out: string[] = [];
  let rest = delta;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars + 1);
    const splitAt = Math.max(
      window.lastIndexOf("\n\n"),
      window.lastIndexOf("\n"),
      window.lastIndexOf(". "),
      window.lastIndexOf("? "),
      window.lastIndexOf("! "),
      window.lastIndexOf(", "),
      window.lastIndexOf(" "),
    );
    const cut = splitAt > Math.floor(maxChars * 0.45) ? splitAt + (window[splitAt] === " " ? 1 : 0) : maxChars;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) out.push(rest);
  return out;
}

function emitTextDeltas(controller: ProviderStreamController, delta: string): void {
  for (const part of splitReadableTextDelta(delta)) {
    controller.emit({ type: "text-delta", delta: part });
  }
}

function readWithAbort(reader: SseReader, abortSignal?: AbortSignal): Promise<{ done: boolean; value?: Uint8Array }> {
  if (!abortSignal) return reader.read();
  if (abortSignal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      void reader.cancel().catch(() => {});
      reject(new DOMException("Aborted", "AbortError"));
    };
    abortSignal.addEventListener("abort", onAbort, { once: true });
    reader
      .read()
      .then(resolve, reject)
      .finally(() => {
        abortSignal.removeEventListener("abort", onAbort);
      });
  });
}

function emitToolCalls(toolCallParts: Record<number, ToolCallPart>, controller: ProviderStreamController): void {
  for (const part of Object.values(toolCallParts)) {
    if (part.emitted || !part.id) continue;
    let args: unknown = {};
    try {
      args = JSON.parse(part.argsBuffer || "{}");
    } catch {
      args = { _raw: part.argsBuffer };
    }
    controller.emit({
      type: "tool-call",
      id: part.id,
      toolName: part.name || "unknown",
      args,
    });
    part.emitted = true;
  }
}
