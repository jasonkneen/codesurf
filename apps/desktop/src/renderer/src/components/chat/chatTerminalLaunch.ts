/**
 * Resolve the provider CLI used by the Chat/Terminal view.
 *
 * The terminal view is a second front-end for the same provider conversation,
 * not a generic shell. Keep the provider-specific resume grammar in one pure
 * function so the renderer can pass an explicit, stable launch contract to
 * TerminalTile and tests can verify it without starting a PTY.
 */

export interface ChatTerminalLaunch {
  launchBin: string | undefined
  launchArgs: string[]
  /** False when this provider has no local CLI that can resume its session. */
  supported: boolean
}

function normalizedSessionId(sessionId: string | null | undefined): string | null {
  const value = typeof sessionId === 'string' ? sessionId.trim() : ''
  return value || null
}

/**
 * Build the provider CLI invocation for a chat tile's terminal front-end.
 *
 * A provider session id is intentionally passed only to that provider's own
 * CLI. Unknown/extension/cloud providers return an unsupported contract rather
 * than accidentally launching a shell that looks like a resumed conversation.
 */
export function resolveChatTerminalLaunch(
  provider: string,
  sessionId: string | null | undefined,
): ChatTerminalLaunch {
  const id = normalizedSessionId(sessionId)
  switch (provider.trim().toLowerCase()) {
    case 'claude':
      return { launchBin: 'claude', launchArgs: id ? ['--resume', id] : [], supported: true }
    case 'codex':
      // `codex resume` without an id opens the CLI's own session picker. With
      // an id it resumes the exact thread emitted by the chat provider.
      return { launchBin: 'codex', launchArgs: id ? ['resume', id] : ['resume'], supported: true }
    case 'opencode':
      return { launchBin: 'opencode', launchArgs: id ? ['--session', id] : [], supported: true }
    case 'openclaw':
      return { launchBin: 'openclaw', launchArgs: id ? ['tui', '--session', id] : ['tui'], supported: true }
    case 'hermes':
      return { launchBin: 'hermes', launchArgs: id ? ['--resume', id] : [], supported: true }
    case 'csagent':
      return { launchBin: 'pi', launchArgs: id ? ['--resume', id] : [], supported: true }
    default:
      return { launchBin: undefined, launchArgs: [], supported: false }
  }
}
