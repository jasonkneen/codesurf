const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

const LAUNCH_GRAMMAR = Object.freeze({
  claude: { noId: [], withId: ['--resume'] },
  codex: { noId: ['resume'], withId: ['resume'] },
  opencode: { noId: [], withId: ['--session'] },
  openclaw: { noId: ['tui'], withId: ['tui', '--session'] },
  hermes: { noId: [], withId: ['--resume'] },
  pi: { noId: [], withId: ['--resume'] },
})

export class TerminalLaunchContractError extends Error {
  constructor(message) {
    super(message)
    this.name = 'TerminalLaunchContractError'
  }
}

function validArgument(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

/**
 * Validate the provider CLI handoff before it reaches a PTY. The executable is
 * a bare name from a fixed allowlist and the arguments are limited to the
 * provider's resume grammar; neither side is interpreted by a shell.
 */
export function validateTerminalLaunch(launchBin, launchArgs) {
  const bin = launchBin === undefined || launchBin === null ? undefined : launchBin
  const args = launchArgs === undefined || launchArgs === null ? [] : launchArgs
  if (bin === undefined && args.length === 0) return { launchBin: undefined, launchArgs: [] }
  if (typeof bin !== 'string' || !Object.hasOwn(LAUNCH_GRAMMAR, bin)) {
    throw new TerminalLaunchContractError('launchBin must be a supported provider CLI')
  }
  if (!Array.isArray(args) || args.length > 3 || !args.every(validArgument)) {
    throw new TerminalLaunchContractError('launchArgs must be a bounded array of strings')
  }

  const grammar = LAUNCH_GRAMMAR[bin]
  const matches =
    args.length === grammar.noId.length
      ? args.every((value, index) => value === grammar.noId[index])
      : args.length === grammar.withId.length + 1 &&
        args.slice(0, -1).every((value, index) => value === grammar.withId[index]) &&
        SESSION_ID_PATTERN.test(args.at(-1))
  if (!matches) throw new TerminalLaunchContractError(`launchArgs are invalid for ${bin}`)
  return { launchBin: bin, launchArgs: [...args] }
}
