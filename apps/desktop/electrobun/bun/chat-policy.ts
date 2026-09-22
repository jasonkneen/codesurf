import { codexExecPermissionArgs } from '@codesurf/daemon/chat-policy'

/**
 * Electrobun's renderer mode is untrusted input. Only an explicit full-access
 * selection may disable both the Codex sandbox and approvals; missing,
 * "default", and unknown values use the normal workspace-write/on-request
 * posture from the compiled daemon policy.
 */
export function electrobunCodexPermissionArgs(mode: unknown): string[] {
  return codexExecPermissionArgs(mode)
}
