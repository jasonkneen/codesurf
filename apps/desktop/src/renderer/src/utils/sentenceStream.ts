/**
 * Sentence stream chunker for live agent output.
 *
 * Feeds incoming text deltas (from token-streaming) into an accumulator;
 * emits a complete sentence as soon as one is detected. Supports both:
 *   - feed(delta) → array of sentences (zero or more) extracted now
 *   - finish()    → array of sentences, plus any final tail not yet
 *                   terminated by punctuation (treated as a "sentence" so
 *                   nothing is dropped at end-of-stream)
 *
 * What counts as a sentence boundary:
 *   - `. `, `! `, `? `, `." `, `!" `, `?" `, `.) `, `!) `, `?) ` and the
 *     same punctuation at end-of-string after a finish().
 *   - Newlines after `.`, `!`, `?` (some streams emit `\n` not space).
 *
 * What does NOT count:
 *   - `.` inside a number (`3.14`) — guarded by digit-context check
 *   - Common abbreviations (Dr., Mr., Mrs., Ms., e.g., i.e., etc., vs.,
 *     U.S., No., Inc., Ltd.) — guarded by trailing-token check
 *   - `.` inside a code block — code blocks are entirely skipped (passed
 *     through untouched and emitted as a single sentence, with a
 *     `kind: 'code'` marker so the caller can spokify-skip them)
 */

export interface SentenceChunk {
  text: string
  kind: 'prose' | 'code'
}

const ABBREV = new Set([
  'mr', 'mrs', 'ms', 'dr', 'st', 'no', 'jr', 'sr',
  'inc', 'ltd', 'co', 'corp', 'llc',
  'e.g', 'i.e', 'etc', 'vs', 'cf', 'al',
  'u.s', 'u.k', 'u.n', 'p.s', 'a.m', 'p.m',
])

function endsWithAbbreviation(text: string): boolean {
  let end = text.length
  while (end > 0 && /\s/.test(text[end - 1])) end--
  let start = end
  while (start > 0 && !/\s/.test(text[start - 1])) start--
  const word = text.slice(start, end).replace(/^[^\w.]+|[^\w.]+$/g, '').toLowerCase()
  return ABBREV.has(word) || ABBREV.has(word.replace(/\.$/, ''))
}

// Find the index just past the first valid sentence boundary in `text`,
// or -1 if none. A boundary is `[.!?]` optionally followed by `'"`)]`,
// then whitespace/newline. Skips abbreviations and numeric decimals.
function findSentenceEnd(text: string): number {
  // Walk the string; whenever we hit . ! or ?, validate.
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch !== '.' && ch !== '!' && ch !== '?') continue
    // Optionally consume one closing quote/bracket
    let endIdx = i + 1
    if (endIdx < text.length && /['"\)\]]/.test(text[endIdx])) endIdx++
    // Must be followed by whitespace or end-of-string
    if (endIdx >= text.length) continue
    if (!/[\s\n]/.test(text[endIdx])) continue
    // Numeric decimal? "3.14" — skip if digit on both sides of `.`
    if (
      ch === '.' && i > 0 && i + 1 < text.length
      && /\d/.test(text[i - 1]) && /\d/.test(text[i + 1])
    ) continue
    // Abbreviation? Look at the token immediately preceding.
    const candidate = text.slice(0, endIdx)
    if (endsWithAbbreviation(candidate)) continue
    return endIdx
  }
  return -1
}

export class SentenceStream {
  private buffer = ''
  // When true, we're inside a fenced code block (```), accumulating until
  // the closing fence. The whole block is emitted as one 'code' chunk.
  private inCode = false

  feed(delta: string): SentenceChunk[] {
    if (!delta) return []
    this.buffer += delta
    return this.drain(false)
  }

  finish(): SentenceChunk[] {
    return this.drain(true)
  }

  private drain(isFinal: boolean): SentenceChunk[] {
    const out: SentenceChunk[] = []

    while (this.buffer.length > 0) {
      // Code-block handling: if inside, find closing fence.
      if (this.inCode) {
        const closeIdx = this.buffer.indexOf('```')
        if (closeIdx === -1) {
          if (isFinal) {
            out.push({ text: this.buffer, kind: 'code' })
            this.buffer = ''
          }
          break
        }
        const code = this.buffer.slice(0, closeIdx + 3)
        this.buffer = this.buffer.slice(closeIdx + 3)
        out.push({ text: code, kind: 'code' })
        this.inCode = false
        continue
      }

      const fenceIdx = this.buffer.indexOf('```')
      const boundaryEnd = findSentenceEnd(this.buffer)

      // Fence comes first → emit any prose before, then enter code mode.
      if (fenceIdx !== -1 && (boundaryEnd === -1 || fenceIdx < boundaryEnd)) {
        const before = this.buffer.slice(0, fenceIdx).trim()
        if (before) out.push({ text: before, kind: 'prose' })
        // Keep the ``` in the buffer so the code chunk includes its opener
        this.buffer = this.buffer.slice(fenceIdx)
        this.inCode = true
        // Skip the opening fence we want to keep with the code chunk:
        // pop the leading ``` off and re-buffer so the closing-fence
        // search below picks up the rest. Result: code chunk includes
        // closing ``` but not opening — that's fine for spokify-skip use.
        this.buffer = this.buffer.slice(3)
        continue
      }

      if (boundaryEnd !== -1) {
        const sentence = this.buffer.slice(0, boundaryEnd).trim()
        if (sentence) out.push({ text: sentence, kind: 'prose' })
        this.buffer = this.buffer.slice(boundaryEnd).replace(/^\s+/, '')
        continue
      }

      // No boundary in current buffer.
      if (isFinal) {
        const tail = this.buffer.trim()
        if (tail) out.push({ text: tail, kind: 'prose' })
        this.buffer = ''
      }
      break
    }

    return out
  }
}
