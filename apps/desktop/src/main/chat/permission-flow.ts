/**
 * Shared inline tool permission flow for chat providers.
 *
 * Handles: stored grant check → UI prompt → persistence → decision.
 * Each provider maps the returned decision to its SDK-specific reply format.
 */

import { persistGrant, resolveStoredPermission, storeSessionGrant, type ToolPermissionRequest } from '../permissions'
import type { ToolPermissionDecision } from '../ipc/chat'
import { sendStream, type ChatStreamScope } from './runtime'

export interface InlinePermissionResult {
  decision: ToolPermissionDecision
  fromStored: boolean
  toolUseID: string
}

export interface InlinePermissionError {
  error: string
  toolUseID: string | null
}

/**
 * Resolve a tool permission request through the full inline UI flow.
 *
 * 1. Check stored grants (allow/deny short-circuit)
 * 2. Send tool_permission_request to renderer
 * 3. Await user decision
 * 4. Send tool_permission_resolved to renderer
 * 5. Persist grant based on decision scope
 *
 * Returns the decision + metadata, or an error if the prompt was cancelled.
 */
export async function resolveInlineToolPermission(
  scope: ChatStreamScope,
  permissionRequest: ToolPermissionRequest,
  toolUseIDHint: string | null | undefined,
): Promise<InlinePermissionResult | InlinePermissionError> {
  const toolUseID = typeof toolUseIDHint === 'string' && toolUseIDHint.trim()
    ? toolUseIDHint
    : `${permissionRequest.provider}-permission-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  const storedDecision = resolveStoredPermission(permissionRequest)

  if (storedDecision === 'allow') {
    sendStream(scope, {
      type: 'tool_permission_resolved',
      toolId: toolUseID,
      toolName: permissionRequest.toolName,
      decision: 'once',
    })
    return { decision: 'once', fromStored: true, toolUseID }
  }

  if (storedDecision === 'deny') {
    sendStream(scope, {
      type: 'tool_permission_resolved',
      toolId: toolUseID,
      toolName: permissionRequest.toolName,
      decision: 'never',
    })
    return { decision: 'never', fromStored: true, toolUseID }
  }

  // Prompt the user via renderer
  sendStream(scope, {
    type: 'tool_permission_request',
    toolId: toolUseID,
    provider: permissionRequest.provider,
    toolName: permissionRequest.toolName,
    title: permissionRequest.title,
    description: permissionRequest.description,
    blockedPath: permissionRequest.blockedPath,
    workspaceDir: permissionRequest.workspaceDir,
  })

  let decision: ToolPermissionDecision
  try {
    const { awaitToolPermissionAnswer } = await import('../ipc/chat')
    decision = await awaitToolPermissionAnswer(scope, toolUseID, permissionRequest)
  } catch {
    return { error: 'Tool permission request was cancelled.', toolUseID: toolUseIDHint ?? null }
  }

  sendStream(scope, {
    type: 'tool_permission_resolved',
    toolId: toolUseID,
    toolName: permissionRequest.toolName,
    decision,
  })

  // Persist based on scope
  if (decision === 'never') {
    try { persistGrant(permissionRequest, 'never') } catch { /* persist best-effort */ }
  } else if (decision === 'session') {
    try { storeSessionGrant(permissionRequest) } catch { /* persist best-effort */ }
  } else if (decision === 'today' || decision === 'forever') {
    try { persistGrant(permissionRequest, decision) } catch { /* persist best-effort */ }
  }

  return { decision, fromStored: false, toolUseID }
}
