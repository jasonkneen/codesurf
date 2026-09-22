import type {
  ChatImageAttachment,
  ChatMessage,
  ChatRequest,
} from '../../src/main/chat/types.ts'

export interface ElectrobunFileReferenceExpansion {
  changed: boolean
  bodyText: string
  contextText?: string
  references?: Array<{
    capability?: string
    selectionReceipt?: string
    binary?: boolean
    mediaType?: string
    resolvedPath?: string
    displayPath: string
    byteCount: number
    device?: string
    inode?: string
    mtimeMs?: number
    ctimeMs?: number
  }>
}

export interface TrustedElectrobunFileContext {
  expandedMessages?: ChatMessage[]
  fileReferencePrompt?: string
  imageAttachments?: ChatImageAttachment[]
  consumedAttachmentCapabilities?: string[]
}

const SUPPORTED_VISION_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
])

function supportedProviderImageTypes(provider: string): string[] {
  return provider === 'claude' || provider === 'codex'
    ? [...SUPPORTED_VISION_TYPES]
    : []
}

function verifiedIdentityString(value: unknown, label: string, displayPath: string): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized) throw new Error(`Image attachment lacks verified ${label}: ${displayPath}`)
  return normalized
}

function verifiedIdentityTime(value: unknown, label: string, displayPath: string): number {
  const normalized = Number(value)
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error(`Image attachment lacks verified ${label}: ${displayPath}`)
  }
  return normalized
}

export async function expandElectrobunFileReferences(
  request: ChatRequest,
  expand: (payload: {
    message: string
    workspaceId: string
    cardId: string
    supportedImageMediaTypes: string[]
    attachmentSelections?: Array<{ selectionReceipt: string }>
  }) => Promise<ElectrobunFileReferenceExpansion>,
): Promise<TrustedElectrobunFileContext> {
  const messages = request.messages.map(message => ({ ...message }))
  let lastUserIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      lastUserIndex = index
      break
    }
  }
  if (lastUserIndex < 0) return {}

  const message = String(messages[lastUserIndex]?.content ?? '')
  if (message.includes('Attached file paths:')) {
    throw new Error('Raw attachment paths are not accepted; use host-issued attachment selections.')
  }
  const attachmentSelections = [
    ...new Set(
      (request.attachmentSelections ?? [])
        .map(selection => typeof selection?.selectionReceipt === 'string'
          ? selection.selectionReceipt.trim()
          : '')
        .filter(Boolean),
    ),
  ].map(selectionReceipt => ({ selectionReceipt }))
  if (
    attachmentSelections.length === 0
    && !message.includes('@')
    && !message.includes('Attached file capabilities:')
  ) return {}

  const expansion = await expand({
    message,
    workspaceId: String(request.workspaceId ?? ''),
    cardId: request.cardId,
    supportedImageMediaTypes: supportedProviderImageTypes(request.provider),
    ...(attachmentSelections.length > 0 ? { attachmentSelections } : {}),
  })
  if (!expansion.changed) return {}

  messages[lastUserIndex] = { ...messages[lastUserIndex], content: expansion.bodyText }
  const imageAttachments = (expansion.references ?? [])
    .filter(reference => (
      reference.binary === true
      && SUPPORTED_VISION_TYPES.has(String(reference.mediaType ?? '').toLowerCase())
      && String(reference.resolvedPath ?? '').trim().length > 0
    ))
    .map(reference => ({
      path: String(reference.resolvedPath).trim(),
      mediaType: String(reference.mediaType).toLowerCase(),
      displayPath: reference.displayPath,
      byteCount: reference.byteCount,
      device: verifiedIdentityString(reference.device, 'device identity', reference.displayPath),
      inode: verifiedIdentityString(reference.inode, 'inode identity', reference.displayPath),
      mtimeMs: verifiedIdentityTime(reference.mtimeMs, 'modification time', reference.displayPath),
      ctimeMs: verifiedIdentityTime(reference.ctimeMs, 'change time', reference.displayPath),
    }))
  const consumedAttachmentCapabilities = [...new Set(
    (expansion.references ?? [])
      .map(reference => typeof reference.capability === 'string' ? reference.capability.trim() : '')
      .filter(Boolean),
  )]

  return {
    expandedMessages: messages,
    fileReferencePrompt: expansion.contextText,
    ...(imageAttachments.length > 0 ? { imageAttachments } : {}),
    ...(consumedAttachmentCapabilities.length > 0 ? { consumedAttachmentCapabilities } : {}),
  }
}
