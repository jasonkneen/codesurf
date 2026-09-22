import type { JSX } from 'react'
import { PersonaAvatar } from '../PersonaAvatar'
import type { ReplyAvatarPersona } from '../../lib/replyAvatar'

const SIZE = 22

export function ReplyAvatar({
  persona,
  streaming,
}: {
  persona: ReplyAvatarPersona
  streaming: boolean
}): JSX.Element {
  return (
    <div
      style={{
        width: SIZE,
        height: SIZE,
        flexShrink: 0,
        overflow: 'visible',
        marginTop: 2,
      }}
      title={persona.name}
    >
      <PersonaAvatar
        persona={persona}
        size={SIZE}
        animate={streaming ? 'always' : 'hover'}
      />
    </div>
  )
}
