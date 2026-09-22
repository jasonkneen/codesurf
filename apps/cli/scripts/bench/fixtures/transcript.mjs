// A fixed local transcript, for deterministic replay.
//
// Every number this fixture produces has to be comparable across runs and
// machines, so nothing here is random, time-dependent or fetched. The shapes
// are the ones the plan names as expensive: long markdown, fenced code, tool
// results, and reasoning blocks.
//
// Sizes are deliberate. `LONG_ANSWER` is past the point where markdown parsing
// and wrapping dominate a frame; the code block is long enough to exercise
// syntax highlighting; the tool result is the shape that arrives mid-stream and
// forces a re-layout of everything below it.

const PARAGRAPH =
  "The registry keeps one entry per contribution and rebuilds its snapshot on every mutation, " +
  "so a plugin that registers in a loop pays for each step. That is fine at boot and wrong in a turn.";

const CODE = [
  "```ts",
  "export function buildSystemPrompt(cwd: string, mode: AgentMode): string {",
  "  const sections = getRegistrySnapshot().promptSections;",
  "  return sections.map((section) => `${section.title}:\\n${section.body}`).join('\\n\\n');",
  "}",
  "```",
].join("\n");

/** One assistant answer: heading, prose, list, code. ~1.4 KB. */
export const LONG_ANSWER = [
  "## What changed",
  "",
  PARAGRAPH,
  "",
  "- The catalog imports every entry, including ones that never activate.",
  "- Snapshot rebuilds are O(contributions), not O(change).",
  "- Disposal is concurrent across effects, sequential within one.",
  "",
  PARAGRAPH,
  "",
  CODE,
  "",
  PARAGRAPH,
].join("\n");

/** A tool result arriving mid-stream — the re-layout case. */
export const TOOL_RESULT = {
  name: "read_file",
  args: { path: "src/core/plugins/loader.ts" },
  output: Array.from({ length: 40 }, (_, i) => `${String(i + 1).padStart(4)} | const line = ${i};`).join("\n"),
};

/**
 * Chunk a message the way a provider streams it: small, uneven deltas.
 *
 * Uneven on purpose — equal chunks hide the cost of a delta that lands
 * mid-word or mid-fence, which is exactly when re-parsing is worst.
 */
export function streamChunks(text, sizes = [7, 23, 3, 41, 11, 67, 5]) {
  const chunks = [];
  let index = 0;
  let size = 0;
  while (index < text.length) {
    const take = sizes[size % sizes.length];
    chunks.push(text.slice(index, index + take));
    index += take;
    size += 1;
  }
  return chunks;
}

/** A whole conversation: `turns` exchanges, each with a tool call. */
export function buildTranscript(turns = 12) {
  const entries = [];
  for (let turn = 0; turn < turns; turn += 1) {
    entries.push({ type: "user", content: `Explain change ${turn} and read the loader.` });
    entries.push({ type: "tool_call", ...TOOL_RESULT });
    entries.push({ type: "assistant", content: `${LONG_ANSWER}\n\n_(turn ${turn})_` });
  }
  return entries;
}

export const FIXTURE_ID = "transcript-v1";
