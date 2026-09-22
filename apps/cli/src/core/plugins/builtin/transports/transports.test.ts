// Fixtures below are REAL captured output, not invented shapes:
//   amp  → `printf '<user jsonl>' | amp -x --stream-json --stream-json-input`
//   grok → `grok -p "..." --output-format streaming-messages-json --include-partial-messages`
// Trimmed of the huge tools/skills arrays on the init lines; everything the
// decoder reads is verbatim.

import { describe, expect, it } from "vitest";
import type { ProviderStreamEvent } from "../../api";
import { parseGrokModels } from "../../native/grok-provider";
import { AnthropicStreamJsonDecoder } from "./anthropic-stream-json";
import { NdjsonFramer } from "./ndjson";

function drain(lines: string[], decoder = new AnthropicStreamJsonDecoder()): ProviderStreamEvent[] {
  const out: ProviderStreamEvent[] = [];
  const framer = new NdjsonFramer({ onValue: (v) => out.push(...decoder.push(v)) });
  for (const line of lines) framer.push(line);
  framer.flush();
  return out;
}

const text = (events: ProviderStreamEvent[]): string =>
  events
    .filter((e): e is Extract<ProviderStreamEvent, { type: "text-delta" }> => e.type === "text-delta")
    .map((e) => e.delta)
    .join("");

const reasoning = (events: ProviderStreamEvent[]): string =>
  events
    .filter((e): e is Extract<ProviderStreamEvent, { type: "reasoning-delta" }> => e.type === "reasoning-delta")
    .map((e) => e.delta)
    .join("");

describe("NdjsonFramer", () => {
  it("reassembles values split across arbitrary chunk boundaries", () => {
    const values: unknown[] = [];
    const framer = new NdjsonFramer({ onValue: (v) => values.push(v) });
    // A single JSON object delivered one character at a time — the pathological
    // case for the hand-rolled loops this replaces.
    for (const ch of '{"type":"a"}\n{"type":"b"}\n') framer.push(ch);
    expect(values).toEqual([{ type: "a" }, { type: "b" }]);
  });

  it("does not drop a final line lacking a trailing newline", () => {
    const values: unknown[] = [];
    const framer = new NdjsonFramer({ onValue: (v) => values.push(v) });
    framer.push('{"type":"a"}\n{"type":"last"}');
    expect(values).toEqual([{ type: "a" }]);
    framer.flush();
    expect(values).toEqual([{ type: "a" }, { type: "last" }]);
  });

  it("skips non-JSON banner lines instead of aborting the stream", () => {
    const values: unknown[] = [];
    const bad: string[] = [];
    const framer = new NdjsonFramer({ onValue: (v) => values.push(v), onInvalidLine: (l) => bad.push(l) });
    framer.push('Warning: something\n{"type":"a"}\n');
    expect(bad).toEqual(["Warning: something"]);
    expect(values).toEqual([{ type: "a" }]);
  });
});

describe("AnthropicStreamJsonDecoder — grok (token-level partials)", () => {
  // Captured from grok --include-partial-messages.
  const GROK = [
    '{"type":"system","subtype":"init","session_id":"019fc6d0-f483-7ac3-afda-4ab7e7f5ba4d","model":"grok-4.5"}\n',
    '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}}\n',
    '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"The"}}}\n',
    '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" user"}}}\n',
    '{"type":"stream_event","event":{"type":"content_block_stop","index":0}}\n',
    '{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"ok"}}}\n',
    // The trailing complete message repeats BOTH blocks in full.
    '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"The user","signature":"UyaxHrM9"},{"type":"text","text":"ok"}],"stop_reason":"end_turn","usage":{"input_tokens":55218,"output_tokens":19,"cache_read_input_tokens":2560}}}\n',
    '{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn","usage":{"input_tokens":55218,"output_tokens":19,"cache_read_input_tokens":2560}}\n',
  ];

  it("emits each token exactly once despite the trailing complete message", () => {
    const events = drain(GROK);
    // The whole point: "ok" not "okok", "The user" not "The userThe user".
    expect(text(events)).toBe("ok");
    expect(reasoning(events)).toBe("The user");
  });

  it("reports usage and stop reason from the result message", () => {
    const decoder = new AnthropicStreamJsonDecoder();
    drain(GROK, decoder);
    expect(decoder.state.finished).toBe(true);
    expect(decoder.state.stopReason).toBe("end_turn");
    expect(decoder.state.usage).toEqual({
      inputTokens: 55218,
      outputTokens: 19,
      cacheReadTokens: 2560,
    });
  });

  it("surfaces the session id so the next turn can --resume", () => {
    let seen: string | null = null;
    const decoder = new AnthropicStreamJsonDecoder({ onSessionId: (id) => (seen = id) });
    drain(GROK, decoder);
    expect(seen).toBe("019fc6d0-f483-7ac3-afda-4ab7e7f5ba4d");
  });
});

describe("AnthropicStreamJsonDecoder — amp (message-level, no partials)", () => {
  // Captured from amp -x --stream-json --stream-json-input. Note: no
  // stream_event lines at all, and stop_reason lives on the assistant message.
  const AMP = [
    '{"type":"system","subtype":"init","session_id":"T-019fc6d0-194a-75ab-9195-b1a3e9b131e5"}\n',
    '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Reply with exactly: ok"}]}}\n',
    '{"type":"assistant","message":{"type":"message","role":"assistant","content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn","usage":{"input_tokens":0,"cache_creation_input_tokens":67996,"output_tokens":5}}}\n',
    '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"ok"}\n',
  ];

  it("emits the complete message when no partials preceded it", () => {
    expect(text(drain(AMP))).toBe("ok");
  });

  it("does not echo our own user message back into the transcript", () => {
    const events = drain(AMP);
    // amp echoes the input turn; rendering it would duplicate the prompt.
    expect(text(events)).not.toContain("Reply with exactly");
  });

  it("takes stop_reason from the assistant message when result omits it", () => {
    const decoder = new AnthropicStreamJsonDecoder();
    drain(AMP, decoder);
    expect(decoder.state.stopReason).toBe("end_turn");
    expect(decoder.state.usage).toEqual({
      inputTokens: 0,
      outputTokens: 5,
      cacheWriteTokens: 67996,
    });
  });
});

describe("parseGrokModels", () => {
  // Verbatim `grok models` output.
  const OUT = [
    "You are logged in with grok.com.",
    "",
    "Default model: grok-4.5",
    "",
    "Available models:",
    "  * grok-4.5 (default)",
    "  - alex/claude-opus-4-8",
    "  - alex/gpt-5.5",
    "  - alex/grok-code-fast-1",
  ].join("\n");

  it("extracts every model including the starred default", () => {
    const models = parseGrokModels(OUT);
    expect(models.map((m) => m.id)).toEqual([
      "grok-4.5",
      "alex/claude-opus-4-8",
      "alex/gpt-5.5",
      "alex/grok-code-fast-1",
    ]);
  });

  it("keeps namespaced ids verbatim — grok expects its own id back on --model", () => {
    const models = parseGrokModels(OUT);
    const proxied = models.find((m) => m.id === "alex/gpt-5.5");
    expect(proxied?.id).toBe("alex/gpt-5.5");
    // Label is humanised, id is not.
    expect(proxied?.label).toContain("gpt-5.5");
  });

  it("marks the default and ignores prose lines", () => {
    const models = parseGrokModels(OUT);
    expect(models[0].label).toContain("default");
    // "You are logged in..." and "Default model:" must not become models.
    expect(models.some((m) => m.id.startsWith("You"))).toBe(false);
    expect(models.some((m) => m.id === "model:")).toBe(false);
  });

  it("returns nothing for unparseable output so the caller can fall back", () => {
    expect(parseGrokModels("command not found")).toEqual([]);
  });
});

describe("turn boundary — the two families disagree", () => {
  // Captured by feeding amp TWO turns on one held-open stdin and timestamping:
  //   10:06:09  assistant "alpha" stop_reason:end_turn   <- turn 1 ends
  //   10:06:56  assistant "beta"  stop_reason:end_turn   <- turn 2 ends
  //   10:07:46  result num_turns:2                       <- only after EOF
  const AMP_TURN_1 =
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"alpha"}],"stop_reason":"end_turn"}}\n';

  it("assistant-stop settles a turn without waiting for result", () => {
    const decoder = new AnthropicStreamJsonDecoder({ turnEndsOn: "assistant-stop" });
    drain([AMP_TURN_1], decoder);
    // Regression: with the default "result" rule this stayed false and the
    // turn hung until the 180s stall watchdog killed it.
    expect(decoder.state.finished).toBe(true);
    expect(decoder.state.stopReason).toBe("end_turn");
  });

  it("result-mode ignores the assistant stop_reason and waits for result", () => {
    const decoder = new AnthropicStreamJsonDecoder({ turnEndsOn: "result" });
    drain([AMP_TURN_1], decoder);
    expect(decoder.state.finished).toBe(false);
    drain(['{"type":"result","subtype":"success","is_error":false}\n'], decoder);
    expect(decoder.state.finished).toBe(true);
  });

  it("assistant-stop does NOT settle on tool_use — the agent is still going", () => {
    const decoder = new AnthropicStreamJsonDecoder({ turnEndsOn: "assistant-stop" });
    drain(
      [
        '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"read_file","input":{}}],"stop_reason":"tool_use"}}\n',
      ],
      decoder,
    );
    // Settling here would cut the turn off mid-tool-loop and strand the result.
    expect(decoder.state.finished).toBe(false);
  });

  it("assistant-stop settles on max_tokens and refusal too", () => {
    for (const stop of ["max_tokens", "refusal", "stop_sequence"]) {
      const decoder = new AnthropicStreamJsonDecoder({ turnEndsOn: "assistant-stop" });
      drain([`{"type":"assistant","message":{"content":[],"stop_reason":"${stop}"}}\n`], decoder);
      expect(decoder.state.finished, `stop_reason=${stop}`).toBe(true);
    }
  });
});

describe("AnthropicStreamJsonDecoder — tools and errors", () => {
  it("emits tool calls from the complete message and pairs results by id", () => {
    const events = drain([
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_1","name":"read_file","input":{"path":"a.ts"}}]}}\n',
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_1","content":"file body"}]}}\n',
    ]);
    expect(events).toEqual([
      { type: "tool-call", id: "tu_1", toolName: "read_file", args: { path: "a.ts" } },
      { type: "tool-result", id: "tu_1", result: "file body", isError: false },
    ]);
  });

  it("suppresses both halves of a suppressed tool", () => {
    const decoder = new AnthropicStreamJsonDecoder({ suppressToolNames: new Set(["AskUserQuestion"]) });
    const events = drain(
      [
        '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_9","name":"AskUserQuestion","input":{"q":1}}]}}\n',
        '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_9","content":"raw json"}]}}\n',
      ],
      decoder,
    );
    // Suppressing only the call would leak the result card into the transcript.
    expect(events).toEqual([]);
  });

  it("ignores input_json_delta so fragmentary tool args never render", () => {
    const events = drain([
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"pa"}}}\n',
    ]);
    expect(events).toEqual([]);
  });

  it("reports an errored result as an error event", () => {
    const decoder = new AnthropicStreamJsonDecoder();
    const events = drain(['{"type":"result","subtype":"error","is_error":true,"error":"rate limited"}\n'], decoder);
    expect(events).toContainEqual({ type: "error", message: "rate limited" });
    expect(decoder.state.errorMessage).toBe("rate limited");
    expect(decoder.state.finished).toBe(true);
  });
});
