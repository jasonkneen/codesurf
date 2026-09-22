// Pure Hermes turn-prompt builder, extracted from chatHermes so it can be
// unit-tested directly (chatHermes itself spawns a subprocess).
//
// Hermes has no system-prompt flag, so the complete host-composed context rides
// inside each user turn. Legacy fragment fields stay type-compatible but are
// ignored to make double injection impossible.
export interface HermesTurnPromptOpts {
  userContent: string
  contextPrompt?: string
  /** Legacy fields are intentionally ignored; the host composer owns context. */
  agentPersona?: string
  peerPrompt?: string
  isFirstTurn?: boolean
  /** CodeSurf output convention, injected on the first turn only. Caller-supplied
   *  (from prompt-conventions) so this module stays dependency-free. */
  outputConvention?: string
}

export function buildHermesTurnPrompt(opts: HermesTurnPromptOpts): string {
  const { userContent } = opts
  const preamble = opts.contextPrompt?.trim() || undefined
  return preamble ? `${preamble}\n\n---\n\n${userContent}` : userContent
}
