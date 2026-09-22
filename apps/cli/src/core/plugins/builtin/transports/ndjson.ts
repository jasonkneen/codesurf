// NDJSON line framing for agent-CLI stdout.
//
// Every streaming agent CLI CodeSurf talks to (claude, amp, grok, lazar) emits
// one JSON object per line on stdout. Chunk boundaries from a child process
// never align with line boundaries, so each provider used to hand-roll the same
// "accumulate into a tail buffer, split on \n, parse each line" loop. Getting it
// subtly wrong truncates the last event of a turn or drops a delta mid-token.
//
// This is that loop, once.

/** Bound on retained partial-line bytes. A CLI that emits a megabyte-long line
 *  with no newline is malfunctioning; without a cap we would buffer forever. */
const MAX_PENDING_BYTES = 8 * 1024 * 1024;

export interface NdjsonFramerOptions {
  /** Called for each successfully parsed line. */
  onValue: (value: unknown) => void;
  /** Called for each line that is not valid JSON. Defaults to ignoring it —
   *  agent CLIs routinely interleave a stray banner or warning on stdout. */
  onInvalidLine?: (line: string) => void;
}

/**
 * Incremental NDJSON decoder.
 *
 * Feed it raw stdout chunks with `push()`; it invokes `onValue` for every
 * complete line. Call `flush()` when the stream ends so a final line with no
 * trailing newline is not silently dropped — several CLIs (fractal, grok in
 * `--single` mode) end their last line without one.
 */
export class NdjsonFramer {
  private pending = "";
  private readonly onValue: (value: unknown) => void;
  private readonly onInvalidLine: (line: string) => void;

  constructor(options: NdjsonFramerOptions) {
    this.onValue = options.onValue;
    this.onInvalidLine = options.onInvalidLine ?? (() => {});
  }

  push(chunk: string): void {
    this.pending += chunk;
    if (this.pending.length > MAX_PENDING_BYTES) {
      // Drop the unterminated head rather than grow without bound. Emitting a
      // truncated JSON fragment would be worse than losing it.
      this.pending = this.pending.slice(-MAX_PENDING_BYTES);
    }
    let nl = this.pending.indexOf("\n");
    while (nl !== -1) {
      const line = this.pending.slice(0, nl);
      this.pending = this.pending.slice(nl + 1);
      this.consume(line);
      nl = this.pending.indexOf("\n");
    }
  }

  /** Parse any trailing partial line. Call once on stream close. */
  flush(): void {
    const rest = this.pending;
    this.pending = "";
    if (rest.trim().length > 0) this.consume(rest);
  }

  private consume(rawLine: string): void {
    // Tolerate \r\n and stray indentation.
    const line = rawLine.trim();
    if (!line) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.onInvalidLine(line);
      return;
    }
    this.onValue(parsed);
  }
}
