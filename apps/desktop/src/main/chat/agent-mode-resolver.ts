import {
  AGENT_MODE_RESOLUTION_DENIED_ERROR as POLICY_DENIED_ERROR,
  resolveAuthoritativePersona,
} from '@codesurf/daemon/chat-policy'
import type { Persona } from '../../shared/types'

export type AgentModeResolution =
  | { ok: true, agentMode: Persona | null }
  | { ok: false, error: string }

export const AGENT_MODE_RESOLUTION_DENIED_ERROR = POLICY_DENIED_ERROR

/**
 * Resolve a selected persona only from a main-process workspace lookup and the
 * bounded, strict policy parser published by @codesurf/daemon. Renderer-supplied
 * workspace paths and persona objects never enter this decision.
 */
export async function resolveAuthoritativeAgentMode(options: {
  agentId: string | null | undefined
  resolveWorkspaceRoot: () => Promise<string | null> | string | null
}): Promise<AgentModeResolution> {
  let workspaceRoot: string | null = null
  try {
    workspaceRoot = await options.resolveWorkspaceRoot()
  } catch {
    workspaceRoot = null
  }
  return await resolveAuthoritativePersona({
    agentId: options.agentId,
    workspaceRoot,
  }) as AgentModeResolution
}
