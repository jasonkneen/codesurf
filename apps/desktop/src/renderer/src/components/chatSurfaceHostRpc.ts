export type ChatSurfacePayload = {
  kind: 'image' | 'text'
  data: string
  mime?: string
  ext?: string
}

export type ChatSurfaceLike = {
  extId: string
  surfaceId: string
  label: string
  instanceId: string
}

export type ExtensionsApiLike = {
  invoke?: (extId: string, method: string, ...args: unknown[]) => Promise<unknown>
  getSettings?: (extId: string) => Promise<Record<string, unknown>>
  setSettings?: (extId: string, settings: Record<string, unknown>) => Promise<boolean>
}

export type ChatSurfaceOpenRequest = {
  extId: string
  surfaceId: string
  preferredTileId?: string
  sourceTileId?: string
  initialContext?: Record<string, unknown>
}

export type BasicChatSurfaceRpcArgs = {
  method: string
  params: any
  surface: ChatSurfaceLike
  connectedPeerIds: string[]
  workspaceId: string | null
  workspacePath: string | null
  themeColors: Record<string, unknown>
  extensionsApi: ExtensionsApiLike
  openChatSurface?: (request: ChatSurfaceOpenRequest) => Promise<unknown> | unknown
}

export type BasicChatSurfaceRpcResult =
  | { handled: false }
  | { handled: true; result: unknown; payload?: ChatSurfacePayload | null }

export function normalizeChatSurfacePayload(payload: unknown): ChatSurfacePayload | null {
  if (!payload || typeof payload !== 'object') return null
  const value = payload as Record<string, unknown>
  return {
    kind: value.kind === 'text' ? 'text' : 'image',
    data: typeof value.data === 'string' ? value.data : String(value.data ?? ''),
    mime: typeof value.mime === 'string' ? value.mime : undefined,
    ext: typeof value.ext === 'string' ? value.ext : undefined,
  }
}

export function buildChatSurfaceMeta(
  surface: ChatSurfaceLike,
  connectedPeerIds: string[],
  workspaceId: string | null,
  workspacePath: string | null,
): {
  tileId: string
  extId: string
  surfaceId: string
  kind: 'chat-surface'
  connectedPeers: string[]
  workspaceId: string
  workspacePath: string
} {
  return {
    tileId: surface.instanceId,
    extId: surface.extId,
    surfaceId: surface.surfaceId,
    kind: 'chat-surface',
    connectedPeers: connectedPeerIds,
    workspaceId: workspaceId ?? '',
    workspacePath: workspacePath ?? '',
  }
}

export async function handleBasicChatSurfaceRpc(args: BasicChatSurfaceRpcArgs): Promise<BasicChatSurfaceRpcResult> {
  const { method, params, surface, connectedPeerIds, workspaceId, workspacePath, themeColors, extensionsApi, openChatSurface } = args

  if (method === 'surface.setPayload') {
    return {
      handled: true,
      result: true,
      payload: normalizeChatSurfacePayload(params?.payload ?? null),
    }
  }

  if (method === 'tile.getMeta') {
    return {
      handled: true,
      result: buildChatSurfaceMeta(surface, connectedPeerIds, workspaceId, workspacePath),
    }
  }

  if (method === 'theme.getColors') {
    return {
      handled: true,
      result: themeColors,
    }
  }

  if (method === 'workspace.getPath') {
    return {
      handled: true,
      result: workspacePath ?? '',
    }
  }

  if (method === 'settings.get') {
    const settings = await extensionsApi.getSettings?.(surface.extId)
    const key = typeof params?.key === 'string' ? params.key : ''
    return {
      handled: true,
      result: key ? settings?.[key] : settings,
    }
  }

  if (method === 'settings.set') {
    await extensionsApi.setSettings?.(surface.extId, (params && typeof params === 'object') ? params as Record<string, unknown> : {})
    return {
      handled: true,
      result: true,
    }
  }

  if (method === 'ext.invoke') {
    const invokedMethod = String(params?.method ?? '')
    if (!invokedMethod) {
      throw new Error('Missing extension method')
    }
    const invokeArgs = Array.isArray(params?.args) ? params.args : []
    return {
      handled: true,
      result: await extensionsApi.invoke?.(surface.extId, invokedMethod, ...invokeArgs),
    }
  }

  if (method === 'chat.openSurface') {
    const request = params?.request ?? params ?? {}
    const extId = typeof request.extId === 'string' ? request.extId.trim() : ''
    const surfaceId = typeof (request.surfaceId ?? request.id) === 'string' ? String(request.surfaceId ?? request.id).trim() : ''
    const preferredTileId = typeof request.preferredTileId === 'string' ? request.preferredTileId.trim() : ''
    const sourceTileId = typeof request.sourceTileId === 'string' ? request.sourceTileId.trim() : surface.instanceId
    const initialContext = request.initialContext && typeof request.initialContext === 'object' && !Array.isArray(request.initialContext)
      ? request.initialContext as Record<string, unknown>
      : undefined
    if (!extId || !surfaceId) {
      throw new Error('Missing chat surface target')
    }
    if (!openChatSurface) {
      return { handled: false }
    }
    await openChatSurface({
      extId,
      surfaceId,
      ...(preferredTileId ? { preferredTileId } : {}),
      ...(sourceTileId ? { sourceTileId } : {}),
      ...(initialContext ? { initialContext } : {}),
    })
    return { handled: true, result: true }
  }

  return { handled: false }
}
