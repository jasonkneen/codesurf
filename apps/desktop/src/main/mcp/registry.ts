import { CANVAS_TOOLS, handleCanvasTool } from './tools/canvas'
import { KANBAN_TOOLS, handleKanbanTool } from './tools/kanban'
import { BUS_TOOLS, handleBusTool } from './tools/bus'
import { CONTEXT_TOOLS, handleContextTool } from './tools/context'
import { GENERATION_TOOLS, handleGenerationTool } from './tools/generation'
import { handlePeerBridgeTool } from './tools/peer-bridge'
import type { McpToolContext, McpToolSchema } from './types'

type ToolHandler = (
  name: string,
  args: Record<string, unknown>,
  ctx: McpToolContext,
) => Promise<string | null>

const STATIC_TOOL_GROUPS: McpToolSchema[][] = [
  CANVAS_TOOLS,
  KANBAN_TOOLS,
  BUS_TOOLS,
  CONTEXT_TOOLS,
  GENERATION_TOOLS,
]

const TOOL_HANDLERS: ToolHandler[] = [
  handlePeerBridgeTool,
  handleCanvasTool,
  handleKanbanTool,
  handleBusTool,
  handleContextTool,
  handleGenerationTool,
]

export function getAllStaticTools(): McpToolSchema[] {
  const seen = new Set<string>()
  return STATIC_TOOL_GROUPS.flat().filter(tool => {
    if (seen.has(tool.name)) return false
    seen.add(tool.name)
    return true
  })
}

export async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  ctx: McpToolContext,
): Promise<string | null> {
  for (const handler of TOOL_HANDLERS) {
    const result = await handler(name, args, ctx)
    if (result !== null) return result
  }
  return null
}