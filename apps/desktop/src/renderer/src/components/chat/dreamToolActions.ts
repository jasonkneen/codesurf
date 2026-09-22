import type { ToolBlock } from '../../../../shared/chat-types'

export const DREAM_TOOL_NAME = 'Dream completed'
export const DREAM_TOOL_ID_PREFIX = 'codesurf-dream-'

export function isDreamToolBlock(block: ToolBlock): boolean {
  if (block.name !== DREAM_TOOL_NAME) return false
  return String(block.id ?? '').startsWith(DREAM_TOOL_ID_PREFIX)
}
