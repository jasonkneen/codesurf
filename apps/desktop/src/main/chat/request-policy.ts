import {
  ChatPolicyError,
  assertProviderPersonaEnforceable,
  bindChatRequestToWorkspace,
  stripUntrustedPrivilegedChatContext,
} from '@codesurf/daemon/chat-policy'
import type { Persona } from '../../shared/types'
import type { ChatRequest } from './types'

export async function canonicalizeElectronChatRequest(
  request: ChatRequest,
  resolveWorkspaceRoot: (workspaceId: string) => Promise<string | null> | string | null,
): Promise<ChatRequest> {
  const workspaceId = typeof request.workspaceId === 'string' ? request.workspaceId.trim() : ''
  if (!workspaceId) {
    throw new ChatPolicyError('CHAT_WORKSPACE_REQUIRED', 'workspaceId is required for chat')
  }
  let workspaceRoot: string | null = null
  try {
    workspaceRoot = await resolveWorkspaceRoot(workspaceId)
  } catch {
    workspaceRoot = null
  }
  if (!workspaceRoot) {
    throw new ChatPolicyError('CHAT_WORKSPACE_UNKNOWN', `Workspace not found: ${workspaceId}`)
  }
  const stripped = stripUntrustedPrivilegedChatContext(
    request as unknown as Record<string, unknown>,
  )
  return await bindChatRequestToWorkspace(
    stripped,
    { id: workspaceId, path: workspaceRoot },
  ) as unknown as ChatRequest
}

export function applyAuthoritativePersonaPolicy(
  request: ChatRequest,
  agentMode: Persona | null,
): ChatRequest {
  assertProviderPersonaEnforceable(request.provider, agentMode)
  return {
    ...request,
    agentMode,
  }
}
