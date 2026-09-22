// Shared transports for agent-CLI provider extensions.
//
// Each provider extension stays its own extension; this package is the wire
// plumbing they have in common so the same NDJSON framing and the same
// Anthropic stream-json decode are not re-implemented (and re-broken) per CLI.
//
// Pick by what the CLI can actually do:
//
//   PersistentStdioSession  — CLI accepts turns as JSON lines on stdin and
//                             stays alive between them. Warmable: the process
//                             boots at model-select, not inside the first turn.
//                             (amp)
//   runOneshotStreamJsonTurn — CLI takes the prompt as argv and exits at
//                             end of turn. Continuity via a session id flag.
//                             (grok, lazar, fractal)
//
// See each module's header for the per-CLI evidence behind that split.

export {
  AnthropicStreamJsonDecoder,
  type AnthropicStreamJsonDecoderOptions,
  type DecodedTurnState,
} from "./anthropic-stream-json";
export { NdjsonFramer, type NdjsonFramerOptions } from "./ndjson";
export { type OneshotTurnOptions, runOneshotStreamJsonTurn } from "./oneshot-stdio-turn";
export {
  PersistentStdioSession,
  type PersistentStdioSessionOptions,
  textContent,
} from "./persistent-stdio-session";
