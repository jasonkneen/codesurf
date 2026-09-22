import {
  composeChatContext,
  type ComposedChatContext,
} from './context-composer.ts'
import { buildPeerContextPrompt, type BoundedPeerContext } from './peer-context-policy.ts'
import { buildAsyncExecutionPrompt } from './prompt-builders.ts'
import {
  buildCodeSurfActivityConvention,
  buildCodeSurfInsightConvention,
  buildCodeSurfOutputConvention,
} from './prompt-conventions.ts'
import type { ChatRequest } from './types.ts'

export interface HostChatContextResult {
  context: ComposedChatContext
  peers: BoundedPeerContext[]
}

/** Build model-visible context only from fields populated by the canonical host. */
export function composeHostChatContext(
  request: Pick<
    ChatRequest,
    | 'agentMode'
    | 'memoryPrompt'
    | 'skillsPrompt'
    | 'asyncExecution'
    | 'peers'
    | 'roomContext'
    | 'fileReferencePrompt'
    | 'recentEditContext'
    | 'blockNotesContext'
  >,
): HostChatContextResult {
  const peerContext = buildPeerContextPrompt(request.peers)
  return {
    peers: peerContext.peers,
    context: composeChatContext({
      persona: request.agentMode?.systemPrompt,
      memory: request.memoryPrompt,
      skills: request.skillsPrompt,
      outputConvention: buildCodeSurfOutputConvention(),
      insightConvention: buildCodeSurfInsightConvention(),
      activityConvention: buildCodeSurfActivityConvention(),
      async: buildAsyncExecutionPrompt(request.asyncExecution),
      // Persisted canvas topology is renderer-replaceable functional state,
      // not a system-prompt trust root. It is injected through room/user data.
      peer: undefined,
      room: request.roomContext,
      fileReferences: request.fileReferencePrompt,
      recentEdit: request.recentEditContext,
      blockNotes: request.blockNotesContext,
    }),
  }
}
