import type { AggregatedSessionEntry } from '../../../shared/session-types'
import type { AppSettings } from '../../../shared/types'
import { resolveProviderModeId } from '../config/providers'
import { buildSessionEntryHint, isRuntimeSessionEntryId } from './sessionEntryHelpers'

export const INITIAL_EXTERNAL_SESSION_TAIL_LOAD = 20

export type LoadedSessionState = {
  messages?: unknown[]
  provider?: string
  model?: string
  mcpEnabled?: boolean
  mode?: string
  sessionId?: string | null
  jobId?: string | null
  jobSequence?: number
  executionTarget?: string
  cloudHostId?: string | null
  isStreaming?: boolean
  hasEarlierMessages?: boolean
}

export function shouldUsePagedLinkedHistory(session: AggregatedSessionEntry): boolean {
  return !isRuntimeSessionEntryId(session.id)
    && session.source !== 'codesurf'
    && Boolean(session.sessionId)
}

export function buildNextChatTileRuntimeState(
  session: AggregatedSessionEntry,
  state: LoadedSessionState,
  settings: AppSettings,
) {
  const sessionHint = buildSessionEntryHint(session)
  const usePagedLinkedHistory = shouldUsePagedLinkedHistory(session)
  const provider = typeof state.provider === 'string' ? state.provider : (session.provider || 'claude')

  return {
    messages: Array.isArray(state.messages) ? state.messages : [],
    input: '',
    attachments: [],
    provider,
    model: typeof state.model === 'string' ? state.model : (session.model || ''),
    mcpEnabled: typeof state.mcpEnabled === 'boolean' ? state.mcpEnabled : true,
    mode: resolveProviderModeId(
      provider,
      typeof state.mode === 'string' ? state.mode : settings.chatProviderModes?.[provider],
    ),
    thinking: 'adaptive' as const,
    agentMode: false,
    autoAgentMode: false,
    linkedSessionEntryId: isRuntimeSessionEntryId(session.id) ? null : session.id,
    linkedSessionHint: isRuntimeSessionEntryId(session.id) ? null : sessionHint,
    hasEarlierMessages: usePagedLinkedHistory
      ? (state.hasEarlierMessages === true || session.messageCount > (Array.isArray(state.messages) ? state.messages.length : 0))
      : false,
    preserveSessionSummary: !isRuntimeSessionEntryId(session.id),
    sessionId: typeof state.sessionId === 'string' || state.sessionId === null ? state.sessionId : session.sessionId,
    jobId: typeof state.jobId === 'string' || state.jobId === null ? state.jobId : null,
    jobSequence: typeof state.jobSequence === 'number' ? state.jobSequence : 0,
    executionTarget: state.executionTarget === 'cloud' ? 'cloud' as const : 'local' as const,
    cloudHostId: typeof state.cloudHostId === 'string' || state.cloudHostId === null ? state.cloudHostId : null,
    isStreaming: typeof state.isStreaming === 'boolean' ? state.isStreaming : false,
  }
}