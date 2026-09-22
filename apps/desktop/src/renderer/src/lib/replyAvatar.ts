import type { ChatMessage } from '../../../shared/chat-types'
import type { Persona } from '../../../shared/types'
import { isBuiltinProvider, PROVIDER_LABELS } from '../config/providers.ts'

export type ReplyAvatarPersona = Pick<Persona, 'id' | 'name' | 'color'>

const GREY = '#8f96a0'

/**
 * Pick the blobatar identity for an assistant reply.
 * Persona wins when the turn recorded one; otherwise a stable provider face.
 */
export function resolveReplyAvatarPersona(
  message: Pick<ChatMessage, 'agentId' | 'provider'>,
  personas: ReadonlyArray<ReplyAvatarPersona>,
  fallbackProvider?: string | null,
): ReplyAvatarPersona {
  const agentId = typeof message.agentId === 'string' ? message.agentId.trim() : ''
  if (agentId) {
    const found = personas.find(persona => persona.id === agentId)
    if (found) return { id: found.id, name: found.name, color: found.color }
    return { id: agentId, name: agentId, color: GREY }
  }

  const provider = (message.provider || fallbackProvider || 'assistant').trim() || 'assistant'
  return {
    id: `provider:${provider}`,
    name: isBuiltinProvider(provider) ? PROVIDER_LABELS[provider] : provider,
    color: GREY,
  }
}
