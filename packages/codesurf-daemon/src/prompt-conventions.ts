/**
 * CodeSurf prompt conventions, injected into every chat provider (Claude,
 * Codex, OpenCode, OpenClaw, Hermes).
 *
 * Kept in the daemon package so every host and provider shares one canonical
 * set of pure strings and helpers without importing Electron main-process code.
 */

export function joinPromptSections(...sections: Array<string | undefined | null>): string | undefined {
  const normalized = sections
    .map(section => String(section ?? '').trim())
    .filter(Boolean)
  return normalized.length > 0 ? normalized.join('\n\n') : undefined
}

// CodeSurf-wide completion-reporting convention. Injected into EVERY provider
// (Claude, Codex, OpenCode, OpenClaw, Hermes) so substantial agent runs produce
// a consistent handoff without turning tiny edits into noisy reports.
//
// Keep this short. It costs tokens on every turn (Claude/Codex) and on every
// first user message (OpenCode/OpenClaw/Hermes). If you want to tune the tone
// or required sections, edit the string below — the plumbing stays the same.
export const CODESURF_OUTPUT_CONVENTION = [
  '## CodeSurf Task-Completion Convention',
  '',
  'Default to a short natural-language completion. For simple work, one sentence plus verification is enough.',
  '',
  'For substantial multi-file, risky, migration, or debugging work, use this exact fenced handoff:',
  '',
  '```',
  'CHANGES MADE:',
  '  <path>: <one-line what + why>',
  '  <path>: <one-line what + why>',
  '',
  'DIDN\'T TOUCH:',
  '  <path or area>: <one-line why you left it alone>',
  '',
  'CONCERNS:',
  '  - <risk, assumption, or follow-up>',
  '```',
  '',
  'Do NOT use the structured card for trivial changes. Skip it for Q&A. Keep one line per entry. Omit DIDN\'T TOUCH unless useful. CONCERNS must name judgments or skipped verification; otherwise write "CONCERNS: none".',
].join('\n')

export function buildCodeSurfOutputConvention(): string {
  return CODESURF_OUTPUT_CONVENTION
}

// CodeSurf-wide "Insight" convention. Injected into provider prompts so every
// model can produce the renderer-recognized star-framed callout when it has a
// genuinely useful, non-obvious observation.
export const CODESURF_INSIGHT_CONVENTION = [
  '## CodeSurf Insight Convention',
  '',
  'Use an Insight block when you notice a non-obvious constraint, risk, hidden dependency, or design implication that the user should understand before trusting the answer.',
  'Do not emit an Insight block for routine summaries, obvious statements, or tiny mechanical edits.',
  '',
  'When you emit one, use this exact wrapper:',
  '`★ Insight ─────────────────────────────────────`',
  '- [point 1]',
  '- [point 2]',
  '`─────────────────────────────────────────────────`',
  '',
  'Keep it to 1–2 bullets. It must explain non-obvious reasoning, not summarize the work.',
].join('\n')

export function buildCodeSurfInsightConvention(): string {
  return CODESURF_INSIGHT_CONVENTION
}

export const CODESURF_ACTIVITY_CONVENTION = [
  '## CodeSurf Activity Convention',
  '',
  'Keep your native agent instructions, tools, and strengths. This convention only standardizes what CodeSurf can show to the user.',
  '',
  'For non-trivial multi-step work, keep a visible task plan current using your native todo/plan tool when one is available.',
  'If the native environment does not expose a todo/plan tool, use concise natural-language progress updates instead of inventing unavailable tools.',
  '',
  'Use neutral tool/action language. Avoid provider-specific status phrasing when a plain action name is enough.',
  'Prefer short completion wording unless the task needs a structured handoff.',
].join('\n')

export function buildCodeSurfActivityConvention(): string {
  return CODESURF_ACTIVITY_CONVENTION
}
