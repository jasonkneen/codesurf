import type { ExtensionRegistry } from '../extensions/registry'
import type { McpPrincipal } from './auth'

export type { McpPrincipal }

export interface McpToolSchema {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface McpToolContext {
  sendToRenderer: (event: string, data: unknown) => void
  getExtensionRegistry: () => ExtensionRegistry | null
  pushSSE: (
    workspaceId: string,
    cardId: string,
    event: string,
    data: unknown,
  ) => void
  /** Who authenticated this call — used by tile-targeted tools to enforce scope. */
  principal: McpPrincipal
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
