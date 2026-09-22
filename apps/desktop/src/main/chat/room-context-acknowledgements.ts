import {
  chatStreamScopeKey,
  type ChatStreamScope,
} from './room-stream-scope.ts'

export interface PendingRoomContextAcknowledgement {
  readonly workspaceId: string
  readonly cardId: string
  readonly sequence: number
}

export type RoomContextAcknowledgementOutcome =
  | 'delivered'
  | 'failed'
  | 'stopped'

/**
 * Tracks peer-context reservations until a provider accepts the turn.
 *
 * A provider event settles a reservation as delivered. Errors and synthetic
 * lifecycle stops only discard it, so unread peer traffic remains available
 * to the next turn.
 */
export class RoomContextAcknowledgements {
  private readonly pending = new Map<string, PendingRoomContextAcknowledgement>()

  register(scope: ChatStreamScope, sequence: number): void {
    if (
      !scope.workspaceId
      || !scope.cardId
      || !Number.isSafeInteger(sequence)
      || sequence < 0
    ) return

    this.pending.set(chatStreamScopeKey(scope), {
      workspaceId: scope.workspaceId,
      cardId: scope.cardId,
      sequence,
    })
  }

  settle(
    scope: ChatStreamScope,
    outcome: RoomContextAcknowledgementOutcome,
  ): PendingRoomContextAcknowledgement | undefined {
    const key = chatStreamScopeKey(scope)
    const acknowledgement = this.pending.get(key)
    this.pending.delete(key)
    return outcome === 'delivered' ? acknowledgement : undefined
  }
}
