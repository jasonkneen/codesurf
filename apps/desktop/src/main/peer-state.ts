/**
 * @deprecated Import from `./agent-room` instead.
 * Compatibility re-export of the agent-room runtime (replaces the old peer-state store).
 */
export {
  setTerminalNotifier,
  updateLinks,
  setState,
  getState,
  getLinkedPeerStates,
  addTodo,
  completeTodo,
  sendMessage,
  readMessages,
  getUnreadMessages,
  removeTile,
  syncMembership,
  getRoomForTile,
  getRoom,
  post,
  consume,
  digest,
  setMemberState,
  prepareTurnContext,
  publishTurnSummary,
  leaveRoom,
} from './agent-room/index.ts'

export type {
  PeerTodo,
  PeerMessage,
  PeerAgentState,
  RoomEvent,
  RoomEventKind,
  RoomMember,
  RoomSnapshot,
  ConsumeResult,
} from './agent-room/index.ts'
