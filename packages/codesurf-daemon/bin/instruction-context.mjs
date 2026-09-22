import { buildMemoryPrompt, loadMemoryContext } from './memory-loader.mjs'

/**
 * Compatibility adapter for consumers of the legacy instruction-context
 * entrypoint. Memory loading, privacy classification, traversal, quotas, and
 * error handling all belong to the canonical memory loader.
 */
export async function loadInstructionContext({
  homeDir,
  workspaceDir,
  executionTarget = 'local',
} = {}) {
  const context = await loadMemoryContext({
    homeDir,
    workspaceDir,
    executionTarget,
  })

  return {
    sections: context.includedSections,
    budget: context.budget,
    ...(context.notices ? { notices: context.notices } : {}),
  }
}

/**
 * Preserve the legacy export while sharing the canonical bounded formatter.
 */
export function buildInstructionPrompt(context) {
  return buildMemoryPrompt(context)
}
