import {
  CODEX_DENY_ALL_ERROR,
  codexDenyAllUnsupported,
  codexShouldForceReadOnly,
  resolveAgentToolAllowList,
} from './agent-mode-tools.mjs'

export const CODEX_SDK_UNAVAILABLE_CODE = 'CODEX_SDK_UNAVAILABLE'

// The official SDK currently wraps `codex exec --experimental-json` and exposes
// sandbox/approval options, but it does not expose the CLI path's
// `--ignore-user-config`. Keep the SDK opt-in; the CLI remains the default when
// config isolation is required.
export const CODEX_SDK_CONFIG_ISOLATION_GAP =
  '@openai/codex-sdk does not expose a --ignore-user-config equivalent; use the default Codex CLI provider for isolated config runs.'

const CODEX_SDK_MODE_POLICY = {
  default: { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' },
  auto: { sandboxMode: 'workspace-write', approvalPolicy: 'on-failure' },
  'read-only': { sandboxMode: 'read-only', approvalPolicy: 'on-request' },
  'full-access': { sandboxMode: 'danger-full-access', approvalPolicy: 'never' },
}

export function shouldUseCodexSdkProvider(request) {
  if (request?.provider !== 'codex') return false
  if (request?.useCodexSdk === true) return true
  return request?.codexExecutionProvider === 'sdk'
}

export function normalizeCodexSdkMode(mode) {
  return Object.prototype.hasOwnProperty.call(CODEX_SDK_MODE_POLICY, mode)
    ? mode
    : 'default'
}

export function codexSdkModePolicy(mode, allowList) {
  if (codexDenyAllUnsupported(allowList)) {
    throw new Error(CODEX_DENY_ALL_ERROR)
  }
  const policy = CODEX_SDK_MODE_POLICY[normalizeCodexSdkMode(mode)]
  return {
    sandboxMode: codexShouldForceReadOnly(allowList) ? 'read-only' : policy.sandboxMode,
    approvalPolicy: policy.approvalPolicy,
  }
}

export function buildCodexSdkThreadOptions(request, workspaceDir) {
  const modePolicy = codexSdkModePolicy(
    request?.mode,
    resolveAgentToolAllowList(request?.agentMode),
  )
  return {
    model: request?.model,
    sandboxMode: modePolicy.sandboxMode,
    approvalPolicy: modePolicy.approvalPolicy,
    skipGitRepoCheck: true,
    ...(workspaceDir ? { workingDirectory: workspaceDir } : {}),
  }
}

export function startCodexSdkThread(codex, request, threadOptions) {
  const sessionId = typeof request?.sessionId === 'string' && request.sessionId.trim()
    ? request.sessionId.trim()
    : null
  return {
    thread: sessionId
      ? codex.resumeThread(sessionId, threadOptions)
      : codex.startThread(threadOptions),
    resumed: Boolean(sessionId),
    sessionId,
  }
}

function codexSdkUnavailable(message, cause) {
  const err = new Error(message)
  err.code = CODEX_SDK_UNAVAILABLE_CODE
  if (cause) err.cause = cause
  return err
}

export async function createCodexSdkClient({ codexSdkFactory = null, env = undefined, config = undefined } = {}) {
  if (codexSdkFactory) {
    if (typeof codexSdkFactory === 'function') {
      return await codexSdkFactory({ env, config })
    }
    return codexSdkFactory
  }

  let mod
  try {
    mod = await import('@openai/codex-sdk')
  } catch (error) {
    throw codexSdkUnavailable('Codex SDK provider was requested, but @openai/codex-sdk could not be loaded.', error)
  }

  if (typeof mod?.Codex !== 'function') {
    throw codexSdkUnavailable('Codex SDK provider was requested, but @openai/codex-sdk did not export Codex.')
  }

  return new mod.Codex({ env, config })
}
