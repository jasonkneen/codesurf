import type { McpToolContext, McpToolSchema } from '../types'
import { resolvePeerWorkspaceScope } from '../peer-scope.ts'

const workspaceProperty = {
  workspace_id: {
    type: 'string',
    description: 'Workspace ID (required for global-token callers)',
  },
}

export const CANVAS_TOOLS: McpToolSchema[] = [
  {
    name: 'canvas_create_tile',
    description: 'Create a new block on the infinite canvas. Core types: terminal, code, note, image, kanban, browser. Extension blocks use the ext:<id> prefix, e.g. "ext:agent-kanban-board", "ext:api-proxy-config". Call list_extensions first to see installed extension block types.',
    inputSchema: {
      type: 'object',
      properties: {
        ...workspaceProperty,
        type:      { type: 'string', description: 'Block type. Core: terminal|code|note|image|kanban|browser. Extensions: ext:<block-type> (use list_extensions to discover).' },
        title:     { type: 'string' },
        file_path: { type: 'string', description: 'Absolute path to open in the block (for code/note/image) or URL for browser' },
        x:         { type: 'number', description: 'World-space X position (optional)' },
        y:         { type: 'number', description: 'World-space Y position (optional)' }
      },
      required: ['type']
    }
  },
  {
    name: 'canvas_open_file',
    description: 'Open a file from the workspace as a block on the canvas.',
    inputSchema: {
      type: 'object',
      properties: {
        ...workspaceProperty,
        path: { type: 'string', description: 'Workspace-relative or absolute path' }
      },
      required: ['path']
    }
  },
  {
    name: 'canvas_pan_to',
    description: 'Pan the canvas viewport to a specific world-space position.',
    inputSchema: {
      type: 'object',
      properties: {
        ...workspaceProperty,
        x: { type: 'number' },
        y: { type: 'number' }
      },
      required: ['x', 'y']
    }
  },
  {
    name: 'canvas_list_tiles',
    description: 'List all blocks currently on the canvas.',
    inputSchema: { type: 'object', properties: { ...workspaceProperty } }
  },
  {
    name: 'list_extensions',
    description: 'List all installed extensions with their block types and available actions. Call this before canvas_create_tile with an ext: type, or before ext_invoke_action, to discover what is available.',
    inputSchema: { type: 'object', properties: {} }
  },
]

const CANVAS_TOOL_NAMES = new Set(CANVAS_TOOLS.map(tool => tool.name))

// No tile-scope guard here: these tools address the canvas as a whole
// (create a new block, pan the viewport, list blocks/extensions) rather than
// mutating an existing tile_id/card_id the caller must own.
export async function handleCanvasTool(
  name: string,
  args: Record<string, unknown>,
  ctx: McpToolContext,
): Promise<string | null> {
  if (!CANVAS_TOOL_NAMES.has(name)) return null

  if (name === 'list_extensions') {
    const registry = ctx.getExtensionRegistry()
    if (!registry) return JSON.stringify([])
    const exts = registry.getAll().map(m => ({
      id: m.id,
      name: m.name,
      description: m.description,
      enabled: m._enabled !== false,
      tileTypes: (m.contributes?.tiles ?? []).map(t => ({
        type: `ext:${t.type}`,
        label: t.label,
      })),
      actions: (m.contributes?.actions ?? []).map(a => ({
        name: a.name,
        description: a.description,
      })),
      contextProduces: m.contributes?.context?.produces ?? [],
      contextConsumes: m.contributes?.context?.consumes ?? [],
    }))
    return JSON.stringify(exts, null, 2)
  }

  const scope = resolvePeerWorkspaceScope(ctx.principal, args.workspace_id)
  if (!scope.ok) return scope.error
  const scopedData = (data: Record<string, unknown>): Record<string, unknown> => ({
    ...data,
    workspaceId: scope.workspaceId,
  })

  if (name === 'canvas_create_tile') {
    ctx.sendToRenderer('canvas_create_tile', scopedData({
      type:     args.type,
      title:    args.title,
      filePath: args.file_path,
      x:        args.x,
      y:        args.y
    }))
    return `Block created: ${args.type}${args.title ? ` "${args.title}"` : ''}`
  }

  if (name === 'canvas_open_file') {
    ctx.sendToRenderer('canvas_open_file', scopedData({ path: args.path }))
    return `Opening file: ${args.path}`
  }

  if (name === 'canvas_pan_to') {
    ctx.sendToRenderer('canvas_pan_to', scopedData({ x: args.x, y: args.y }))
    return `Canvas panned to (${args.x}, ${args.y})`
  }

  if (name === 'canvas_list_tiles') {
    ctx.sendToRenderer('canvas_list_tiles', scopedData({}))
    return 'Block list requested — canvas will emit canvas_tiles_response event'
  }

  return null
}
