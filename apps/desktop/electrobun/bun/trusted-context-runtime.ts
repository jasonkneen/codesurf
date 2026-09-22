import type { ChatRequest } from '../../src/main/chat/types.ts'
import {
  post as roomPost,
  prepareTurnContext,
  updateLinks,
} from '../../src/main/agent-room/index.ts'
import { expandElectrobunFileReferences } from './file-reference-context.ts'
import type { TrustedElectrobunChatContext } from './trust-policy.ts'

type MemoryResponse = {
  prompt?: unknown
  contextBuckets?: ChatRequest['contextBuckets']
}

type SkillsResponse = {
  selection?: { prompt?: unknown, summary?: unknown }
}

export interface ElectrobunTrustedContextRuntime {
  request: <T>(path: string, options?: { body?: unknown }) => Promise<T>
  status: () => Promise<{ running?: boolean }>
}

function lastUserText(request: ChatRequest): string {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index]
    if (message?.role === 'user' && typeof message.content === 'string') {
      return message.content.trim()
    }
  }
  return ''
}

function synchronizeRoom(request: ChatRequest): Pick<
  TrustedElectrobunChatContext,
  'roomContext' | 'roomAckSequence'
> {
  const workspaceId = String(request.workspaceId ?? '').trim()
  if (!workspaceId) return {}
  const peers = Array.isArray(request.peers)
    ? request.peers.filter(peer => peer && typeof peer.peerId === 'string' && typeof peer.peerType === 'string')
    : []
  const tileTypes = Object.create(null) as Record<string, string>
  tileTypes[request.cardId] = 'chat'
  for (const peer of peers) tileTypes[peer.peerId] = peer.peerType || 'unknown'
  updateLinks(workspaceId, request.cardId, peers.map(peer => peer.peerId), tileTypes)
  const room = prepareTurnContext(workspaceId, request.cardId, 'chat', {
    supplementalUntrustedContext: request.untrustedPeerContext,
  })
  const userText = lastUserText(request)
  if (room.roomId && userText) {
    roomPost(workspaceId, {
      fromTileId: request.cardId,
      fromTileType: 'chat',
      kind: 'message',
      text: userText.slice(0, 4000),
      meta: { source: 'chat_user_turn' },
    })
  }
  return {
    roomContext: room.systemExtra.trim() || undefined,
    roomAckSequence: room.acknowledgeThrough ?? undefined,
  }
}

export async function loadElectrobunTrustedChatContext(
  request: ChatRequest,
  runtime: ElectrobunTrustedContextRuntime,
  options: {
    isTurnCurrent?: () => boolean
    onConsumedAttachmentCapabilities?: (capabilities: string[]) => void
  } = {},
): Promise<TrustedElectrobunChatContext> {
  const workspaceId = String(request.workspaceId ?? '').trim()
  const workspaceDir = String(request.workspaceDir ?? '').trim()
  if (!workspaceId || !workspaceDir) {
    throw new Error('The authoritative workspace context is unavailable.')
  }

  const memoryPath = `/memory/load?workspaceId=${encodeURIComponent(workspaceId)}&executionTarget=local`
  const skillParams = new URLSearchParams({ workspaceId, workspaceDir, cardId: request.cardId })
  const memoryPromise = runtime.request<MemoryResponse>(memoryPath).catch(error => {
    if (
      workspaceId === 'electrobun-local'
      && error instanceof Error
      && /Workspace not found:/i.test(error.message)
    ) return {}
    throw error
  })
  const skillsPromise = runtime.request<SkillsResponse>(`/skills/list?${skillParams.toString()}`).catch(error => {
    console.warn(
      '[Electrobun] Trusted skills index unavailable; continuing without skill context:',
      error instanceof Error ? error.message : String(error),
    )
    return null
  })
  const [memory, skills, daemonStatus] = await Promise.all([
    memoryPromise,
    skillsPromise,
    runtime.status().catch(() => null),
  ])
  const providerNativeBackground = request.provider === 'claude' || request.provider === 'codex'
  const detachedDaemonAvailable = daemonStatus?.running === true
  const baseContext: TrustedElectrobunChatContext = {
    memoryPrompt: typeof memory?.prompt === 'string' ? memory.prompt : undefined,
    contextBuckets: memory?.contextBuckets,
    skillsPrompt: typeof skills?.selection?.prompt === 'string' ? skills.selection.prompt : undefined,
    skillsSummary: typeof skills?.selection?.summary === 'string' ? skills.selection.summary : null,
    asyncExecution: {
      requestedRunMode: request.runMode === 'background' ? 'background' : 'foreground',
      backend: 'runtime',
      hostType: 'runtime',
      hostLabel: 'Electrobun Runtime',
      providerNativeBackground,
      detachedDaemonAvailable,
      detachedDaemonPreferred: detachedDaemonAvailable && !providerNativeBackground,
    },
  }
  if (options.isTurnCurrent && !options.isTurnCurrent()) return baseContext
  // Capability expansion is destructive: successful expansion redeems the
  // one-shot tokens. Resolve every fatal prerequisite first so a failed memory
  // load never consumes an attachment the user can no longer resend.
  const fileReferences = await expandElectrobunFileReferences(
    request,
    payload => runtime.request('/file-references/expand', { body: payload }),
  )
  options.onConsumedAttachmentCapabilities?.(
    fileReferences.consumedAttachmentCapabilities ?? [],
  )

  return {
    ...baseContext,
    ...fileReferences,
    ...(!options.isTurnCurrent || options.isTurnCurrent() ? synchronizeRoom(request) : {}),
  }
}
