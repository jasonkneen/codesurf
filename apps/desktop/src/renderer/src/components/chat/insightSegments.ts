// ─── Insight block detection ──────────────────────────────────────────────
// The model emits "★ Insight" callouts framed by box-drawing horizontal rules
// (U+2500). Both marker lines are typically wrapped in backticks (so they
// don't disrupt markdown flow), but the backticks can drop during streaming —
// be permissive. We detect the open/close pair and lift the body out so the
// chat renderer can show it as a single styled block instead of three disjoint
// inline-code runs interleaved with markdown.
//
// Extracted out of the ~6.8k-LOC `ChatTile.tsx` so this pure parser is
// unit-testable (see `test/insight-segments.test.ts`); `InsightBlock` (the
// React component that renders these segments) stays in ChatTile.

export type ChatBodySegment =
  | { kind: 'md'; text: string }
  | { kind: 'insight'; text: string; closed: boolean }

// `★ Insight ─────…` — leading backtick optional, trailing backtick optional.
const INSIGHT_OPEN_RE = /^[ \t]*`?★ Insight[ \t]*─{5,}[ \t]*`?[ \t]*$/m
// `─────…` — must be box-drawing rules, optionally backticked. A regular
// markdown `---` HR doesn't match (intentional — we don't want to swallow them).
const INSIGHT_CLOSE_RE = /^[ \t]*`?─{5,}`?[ \t]*$/m

export function splitInsightSegments(text: string): ChatBodySegment[] {
  const segments: ChatBodySegment[] = []
  let cursor = 0
  while (cursor < text.length) {
    const slice = text.slice(cursor)
    const openMatch = slice.match(INSIGHT_OPEN_RE)
    if (!openMatch || openMatch.index === undefined) {
      const remaining = text.slice(cursor)
      if (remaining.trim()) segments.push({ kind: 'md', text: remaining })
      break
    }
    const openStart = cursor + openMatch.index
    const openEnd = openStart + openMatch[0].length
    if (openStart > cursor) {
      const before = text.slice(cursor, openStart)
      if (before.trim()) segments.push({ kind: 'md', text: before })
    }
    const afterOpen = text.slice(openEnd)
    const closeMatch = afterOpen.match(INSIGHT_CLOSE_RE)
    if (!closeMatch || closeMatch.index === undefined) {
      // Unclosed — still streaming. Render the partial body as an open insight.
      segments.push({ kind: 'insight', text: afterOpen.replace(/^\n+/, ''), closed: false })
      cursor = text.length
      break
    }
    const bodyEnd = openEnd + closeMatch.index
    const closeEnd = openEnd + closeMatch.index + closeMatch[0].length
    segments.push({
      kind: 'insight',
      text: text.slice(openEnd, bodyEnd).replace(/^\n+/, '').replace(/\n+$/, ''),
      closed: true,
    })
    cursor = closeEnd
    // Eat one trailing newline so the next markdown chunk doesn't start blank.
    if (text[cursor] === '\n') cursor += 1
  }
  return segments
}
