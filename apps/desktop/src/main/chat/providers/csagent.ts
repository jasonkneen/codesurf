/**
 * CodeSurf Agent (csagent) — the in-process coding-agent runtime, bridged to the
 * normalized agent:stream schema via src/main/chat/pi-runtime.ts.
 */

import { runCodesurfAgent } from '../pi-runtime'
import type { ChatRequest } from '../types'
import { chatRequestScope, getPreparedMessages, markRoomPromptAccepted, sendStream } from '../runtime'
import { isProviderAcceptanceEvent } from '../provider-acceptance.ts'
import {
  providerLaunchIsCurrent,
  type ProviderLaunchGuard,
} from '../provider-launch-guard.ts'

export async function chatCsagent(
  req: ChatRequest,
  launchGuard?: ProviderLaunchGuard,
): Promise<void> {
  const scope = chatRequestScope(req)
  const prepared = getPreparedMessages(req)
  const lastUser = [...prepared].reverse().find(m => m.role === 'user')
  if (!lastUser) {
    sendStream(scope, { type: 'error', error: 'No user message to send.' })
    sendStream(scope, { type: 'done' })
    return
  }
  if (!providerLaunchIsCurrent(launchGuard)) return
  await runCodesurfAgent(
    {
      cardId: req.cardId,
      workspaceId: scope.workspaceId,
      model: req.model,
      workspaceDir: req.workspaceDir,
      sessionId: req.sessionId ?? null,
      thinking: req.thinking,
      prompt: String(lastUser.content ?? ''),
      contextPrompt: req.contextPrompt,
      imageAttachments: req.imageAttachments?.map(a => ({
        path: a.path,
        mediaType: a.mediaType,
        displayPath: a.displayPath,
        byteCount: a.byteCount,
        device: a.device,
        inode: a.inode,
        mtimeMs: a.mtimeMs,
        ctimeMs: a.ctimeMs,
        ownedTemporary: a.ownedTemporary,
      })),
    },
    (event) => {
      if (!providerLaunchIsCurrent(launchGuard)) return
      if (isProviderAcceptanceEvent(event)) markRoomPromptAccepted(scope)
      sendStream(scope, event)
    },
    launchGuard,
  )
}
