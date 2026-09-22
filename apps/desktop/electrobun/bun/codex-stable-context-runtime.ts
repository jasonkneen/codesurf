import type { ChatRequest } from '../../src/main/chat/types.ts'
import type { ChatStreamScope } from '../../src/main/chat/room-stream-scope.ts'
import {
  StableSessionContextCache,
  type StableContextCliCompletion,
  type StableContextSelection,
} from '../../src/main/chat/stable-session-context.ts'
import {
  buildElectrobunCodexSpawnArgs,
  composeElectrobunProviderContext,
} from './trust-policy.ts'

export interface PreparedElectrobunCodexTurn {
  args: string[]
  selection: StableContextSelection
}

/**
 * Process-local proof that Codex accepted a specific stable context in a
 * specific thread. A bare resume id is never enough to suppress the prefix.
 */
export class ElectrobunCodexStableContextRuntime {
  private readonly cache: StableSessionContextCache

  constructor(cache = new StableSessionContextCache()) {
    this.cache = cache
  }

  prepare(
    request: ChatRequest,
    prompt: string,
    workspaceDir: string,
    scope: ChatStreamScope,
    resumeThreadId?: string | null,
  ): PreparedElectrobunCodexTurn {
    const stableContext = composeElectrobunProviderContext(request, prompt).systemPrompt
    const selection = this.cache.select({
      scope,
      provider: 'codex',
      sessionId: resumeThreadId,
      contextPrompt: stableContext,
    })
    try {
      return {
        args: buildElectrobunCodexSpawnArgs(
          request,
          prompt,
          workspaceDir,
          resumeThreadId,
          { includeStableContext: selection.installsContext },
        ),
        selection,
      }
    } catch (error) {
      this.cache.invalidate(selection)
      throw error
    }
  }

  complete(
    prepared: PreparedElectrobunCodexTurn,
    completion: StableContextCliCompletion,
  ): boolean {
    return this.cache.completeCli(prepared.selection, completion)
  }

  invalidate(prepared: PreparedElectrobunCodexTurn): void {
    this.cache.invalidate(prepared.selection)
  }

  clear(scope: ChatStreamScope): void {
    this.cache.clear(scope, 'codex')
  }
}
