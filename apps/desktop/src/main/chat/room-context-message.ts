import type { ChatMessage } from './types.ts'

export function appendUntrustedRoomContextToLatestUser(
  messages: ChatMessage[],
  roomContext: string,
): ChatMessage[] {
  const index = messages.findLastIndex(message => message.role === 'user')
  if (index < 0) return messages
  return messages.map((message, messageIndex) => messageIndex === index
    ? {
        ...message,
        content: [
          message.content,
          '',
          '<codesurf_peer_context trust="untrusted" source="agent-room">',
          roomContext,
          '</codesurf_peer_context>',
        ].join('\n'),
      }
    : message)
}

/** Append an already-framed host composition exactly once to the latest user turn. */
export function appendComposedUserContextToLatestUser(
  messages: ChatMessage[],
  userSuffix: string | undefined,
): ChatMessage[] {
  const suffix = String(userSuffix ?? '').trim()
  if (!suffix) return messages
  const index = messages.findLastIndex(message => message.role === 'user')
  if (index < 0) return messages
  return messages.map((message, messageIndex) => messageIndex === index
    ? {
        ...message,
        content: `${message.content}\n\n${suffix}`,
      }
    : message)
}
