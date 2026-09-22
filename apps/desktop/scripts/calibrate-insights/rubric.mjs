// Scoring rubric for the Insight calibration harness.
//
// All scorers return { pass: boolean, note: string }. Structural criteria are
// deterministic (pass = exact match). Qualitative criteria are coarse heuristics
// — they catch obvious failures but are not meant to be precise.
//
// Keep each scorer small and single-purpose. Adding a new criterion means
// adding one function and adding it to `runRubric`.

const STAR_HEADER = '★ Insight'
const BORDER_MIN_LENGTH = 40 // the ─────── dashed-line framing

// --- Structural (deterministic) ----------------------------------------------

export function hasStarHeader(output) {
  return {
    pass: output.includes(STAR_HEADER),
    note: `literal "${STAR_HEADER}" header present?`,
  }
}

export function hasBorderFraming(output) {
  const lines = output.split('\n')
  const dashLines = lines.filter(l => {
    const trimmed = l.replace(/[`\s]/g, '')
    return trimmed.length >= BORDER_MIN_LENGTH && /^─+$/.test(trimmed.replace(/─/g, '─'))
  })
  return {
    pass: dashLines.length >= 1, // one trailing border line at minimum
    note: `found ${dashLines.length} dashed border line(s); need ≥1`,
  }
}

export function bulletCountInRange(output) {
  // Count `- ` at line start, inside the insight block only.
  const insightBlock = extractInsightBlock(output)
  if (!insightBlock) return { pass: false, note: 'no insight block found' }
  const bullets = insightBlock.split('\n').filter(l => /^\s*-\s+/.test(l))
  const pass = bullets.length >= 2 && bullets.length <= 3
  return { pass, note: `${bullets.length} bullet(s); need 2–3` }
}

export function isReasonablyShort(output) {
  const insightBlock = extractInsightBlock(output) ?? output
  const words = insightBlock.split(/\s+/).filter(Boolean)
  const pass = words.length <= 200
  return { pass, note: `${words.length} words; need ≤200` }
}

// --- Qualitative (heuristic) -------------------------------------------------

export function avoidsAntiPatterns(output) {
  const low = output.toLowerCase()
  // Coarse phrase matches. False positives are possible (a legitimate Insight
  // could mention the word "clean" in context) — tune as you see failures.
  const antiPatterns = [
    { phrase: 'this is a clean', label: 'praise ("this is a clean solution")' },
    { phrase: 'best practice', label: 'generic advice ("best practice")' },
    { phrase: 'always prefer', label: 'generic rule ("always prefer X")' },
    { phrase: 'i changed', label: 'restatement ("I changed...")' },
    { phrase: 'i updated', label: 'restatement ("I updated...")' },
    { phrase: 'might cause', label: 'vague speculation ("might cause...")' },
  ]
  const hits = antiPatterns.filter(p => low.includes(p.phrase))
  return {
    pass: hits.length === 0,
    note: hits.length === 0 ? 'no anti-patterns matched' : `matched: ${hits.map(h => h.label).join(', ')}`,
  }
}

export function hasCausalConnector(output) {
  // A good Insight exposes the "why". Coarse proxy: look for connectors.
  const connectors = ['because', 'since', 'which is why', 'so that', 'means that', '— that']
  const low = output.toLowerCase()
  const hits = connectors.filter(c => low.includes(c))
  return {
    pass: hits.length >= 1,
    note: hits.length >= 1 ? `causal connector(s): ${hits.join(', ')}` : 'no causal connector found',
  }
}

export function referencesConcreteSymbol(output, fixture) {
  // Extract inline-code tokens from the fixture (e.g. `borderRadius`,
  // `'14px 14px 4px 14px'`) and check at least one appears in the output.
  const fixtureSymbols = [...fixture.matchAll(/`([^`\n]+)`/g)].map(m => m[1])
  if (fixtureSymbols.length === 0) {
    return { pass: true, note: 'fixture has no inline-code symbols to reference (skipped)' }
  }
  const hits = fixtureSymbols.filter(sym => output.includes(sym))
  return {
    pass: hits.length >= 1,
    note: hits.length >= 1 ? `referenced: ${hits[0]}${hits.length > 1 ? ` (+${hits.length - 1} more)` : ''}` : 'no concrete symbol from fixture referenced',
  }
}

// --- Orchestration -----------------------------------------------------------

export function extractInsightBlock(output) {
  const start = output.indexOf(STAR_HEADER)
  if (start < 0) return null
  // Find the next dashed border after the start
  const after = output.slice(start)
  const lines = after.split('\n')
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    const trimmed = lines[i].replace(/[`\s]/g, '')
    if (trimmed.length >= BORDER_MIN_LENGTH && /^─+$/.test(trimmed.replace(/─/g, '─'))) {
      end = i
      break
    }
  }
  if (end < 0) return after
  return lines.slice(0, end + 1).join('\n')
}

export function runRubric({ output, fixture }) {
  const structural = [
    ['has_star_header', hasStarHeader(output)],
    ['has_border_framing', hasBorderFraming(output)],
    ['bullet_count_in_range', bulletCountInRange(output)],
    ['is_reasonably_short', isReasonablyShort(output)],
  ]
  const qualitative = [
    ['avoids_anti_patterns', avoidsAntiPatterns(output)],
    ['has_causal_connector', hasCausalConnector(output)],
    ['references_concrete_symbol', referencesConcreteSymbol(output, fixture)],
  ]
  const all = [...structural, ...qualitative]
  const passCount = all.filter(([, r]) => r.pass).length
  return {
    structural: Object.fromEntries(structural),
    qualitative: Object.fromEntries(qualitative),
    score: `${passCount}/${all.length}`,
    verdict: passCount === all.length ? 'PASS' : passCount >= all.length - 1 ? 'NEAR_PASS' : 'FAIL',
  }
}
