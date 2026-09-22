import type { ChatRequest } from '../../src/main/chat/types.ts'

export interface ElectrobunChatTurn {
  workspaceId: string
  cardId: string
  turnId: string
}

export type ElectrobunRoomAcknowledger = (
  workspaceId: string,
  cardId: string,
  sequence: number,
) => unknown

type RoomAcknowledgementRequest = Pick<
  ChatRequest,
  'workspaceId' | 'cardId' | 'roomAckSequence'
>

export function electrobunChatScopeKey(
  scope: Pick<ElectrobunChatTurn, 'workspaceId' | 'cardId'>,
): string {
  return JSON.stringify([scope.workspaceId, scope.cardId])
}

/** Settles a room cursor only from events belonging to the current accepted turn. */
export class ElectrobunRoomTurnLifecycle {
  private readonly acknowledge: ElectrobunRoomAcknowledger
  private readonly pending = new Map<string, {
    turnId: string
    sequence: number
  }>()

  constructor(acknowledge: ElectrobunRoomAcknowledger) {
    this.acknowledge = acknowledge
  }

  register(turn: ElectrobunChatTurn, request: RoomAcknowledgementRequest): void {
    const sequence = request.roomAckSequence
    if (!Number.isSafeInteger(sequence) || Number(sequence) < 0) return
    this.pending.set(electrobunChatScopeKey(turn), {
      turnId: turn.turnId,
      sequence: Number(sequence),
    })
  }

  settle(turn: ElectrobunChatTurn, outcome: 'delivered' | 'failed' | 'stopped'): void {
    const key = electrobunChatScopeKey(turn)
    const pending = this.pending.get(key)
    if (!pending || pending.turnId !== turn.turnId) return
    this.pending.delete(key)
    if (outcome === 'delivered') {
      this.acknowledge(turn.workspaceId, turn.cardId, pending.sequence)
    }
  }
}
