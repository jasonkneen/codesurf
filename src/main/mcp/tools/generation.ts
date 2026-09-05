import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import type { AppSettings, TileState } from '../../../shared/types'
import { withDefaultSettings } from '../../../shared/types'
import { CODESURF_HOME } from '../../paths'
import {
  canvasStatePath,
  ensureWorkspaceStorageMigrated,
  loadWorkspaceTileState,
  updateWorkspaceTileState,
} from '../../storage/workspaceArtifacts'
import {
  extractGeminiInlineImage,
  makeImageOutputPath,
  mimeTypeForImagePath,
  selectImageProvider,
} from '../../image-generation'
import { validateCanonicalFsPathDetails } from '../../ipc/fs'
import { resolveGenerationKeys } from '../../generation-secrets'
import { bus } from '../../event-bus'
import { buildPeerCommandPayload } from '../../../shared/nodeTools'
import { asString, type McpToolContext, type McpToolSchema } from '../types'
import { peerTileChannel } from '../peer-scope'
import { validateTileContextWrite } from './context'

export function publishPeerCommand(
  workspaceId: string,
  tileId: string,
  command: string,
  payload: Record<string, unknown>,
  ctx: McpToolContext,
): string {
  bus.publish({
    channel: peerTileChannel(workspaceId, tileId),
    type: 'data',
    source: 'mcp:codesurf',
    payload: buildPeerCommandPayload(tileId, command, {
      ...payload,
      workspaceId,
    }),
  })
  void ctx
  return `Dispatched ${command} to ${tileId}`
}

const SETTINGS_PATH = join(CODESURF_HOME, 'settings.json')
const LEGACY_CONFIG_PATH = join(CODESURF_HOME, 'config.json')

type UserConfigWorkspaceRef = {
  id: string
  path: string
}

type ResolvedImageTileSource = {
  workspaceId: string
  filePath: string
}

type TileContextBackedState = {
  _context?: Record<string, { key: string; value: unknown; updatedAt: number; source: string }>
  [key: string]: unknown
}

async function readAppSettingsForMcp(): Promise<ReturnType<typeof withDefaultSettings>> {
  for (const path of [SETTINGS_PATH, LEGACY_CONFIG_PATH]) {
    try {
      const raw = await fs.readFile(path, 'utf8')
      const parsed = JSON.parse(raw) as Partial<AppSettings> | { settings?: Partial<AppSettings> }
      const settings = parsed && typeof parsed === 'object' && 'settings' in parsed
        ? parsed.settings
        : parsed
      return resolveGenerationKeys(withDefaultSettings(settings as Partial<AppSettings> | null | undefined))
    } catch {
      // try next source
    }
  }
  return withDefaultSettings({})
}

async function readWorkspaceRefsFromUserConfig(): Promise<UserConfigWorkspaceRef[]> {
  try {
    const userConfigPath = join(CODESURF_HOME, 'config.json')
    const raw = await fs.readFile(userConfigPath, 'utf8')
    const parsed = JSON.parse(raw) as {
      projects?: Array<{ id?: string; path?: string }>
      workspaces?: Array<{ id?: string; path?: string; projectIds?: string[]; primaryProjectId?: string | null }>
    }

    if (Array.isArray(parsed.projects) && Array.isArray(parsed.workspaces)) {
      const projectsById = new Map(
        parsed.projects
          .filter(project => typeof project?.id === 'string' && typeof project?.path === 'string' && project.path.trim())
          .map(project => [String(project.id), String(project.path).trim()] as const),
      )

      return parsed.workspaces.flatMap(workspace => {
        const workspaceId = typeof workspace?.id === 'string' ? workspace.id : ''
        if (!workspaceId) return []

        const directPath = typeof workspace?.path === 'string' ? workspace.path.trim() : ''
        if (directPath) return [{ id: workspaceId, path: directPath }]

        const primaryProjectId = typeof workspace?.primaryProjectId === 'string' ? workspace.primaryProjectId : null
        const projectIds = Array.isArray(workspace?.projectIds) ? workspace.projectIds : []
        const projectPath = (primaryProjectId && projectsById.get(primaryProjectId))
          || projectIds.map(projectId => projectsById.get(String(projectId))).find(Boolean)
          || ''
        return projectPath ? [{ id: workspaceId, path: projectPath }] : []
      })
    }

    if (Array.isArray(parsed.workspaces)) {
      return parsed.workspaces.flatMap(workspace => {
        const workspaceId = typeof workspace?.id === 'string' ? workspace.id : ''
        const workspacePath = typeof workspace?.path === 'string' ? workspace.path.trim() : ''
        return workspaceId && workspacePath ? [{ id: workspaceId, path: workspacePath }] : []
      })
    }
  } catch {
    // ignore missing or invalid config
  }

  return []
}

async function readCanvasStateTiles(workspaceId: string): Promise<TileState[]> {
  const storageIds = await ensureWorkspaceStorageMigrated(workspaceId)
  for (const storageId of storageIds) {
    try {
      const raw = await fs.readFile(canvasStatePath(storageId), 'utf8')
      const parsed = JSON.parse(raw) as { tiles?: TileState[] }
      if (Array.isArray(parsed.tiles)) return parsed.tiles
    } catch {
      // try next alias
    }
  }
  return []
}

/** Image inputs the edit tool will accept. */
const EDITABLE_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])

/**
 * Authorize a resolved image-tile source path before it is read and uploaded.
 *
 * `ctx:image:path` is MCP-writable through `tile_context_set`, which only checks
 * size and serializability — so without this the tool would read any local file
 * an agent names (`~/.ssh/id_rsa`) and base64 it to Gemini, then write the
 * result back next to the source. Note tools already gate on
 * `validateCanonicalFsPathDetails`; this brings image editing to the same
 * boundary, and additionally requires a real image extension so a workspace file
 * of another type cannot be exfiltrated either.
 *
 * Returns null (rather than throwing) so an unauthorized path is treated as
 * "no source", matching how the caller already handles an unresolvable tile.
 */
async function authorizeImageTileSource(
  candidatePath: string,
  workspaceRoot: string,
): Promise<string | null> {
  const ext = candidatePath.slice(candidatePath.lastIndexOf('.')).toLowerCase()
  if (!EDITABLE_IMAGE_EXTENSIONS.has(ext)) return null
  try {
    const validated = await validateCanonicalFsPathDetails(candidatePath, 'read', {
      restrictToWorkspaceRoots: true,
      allowedRoots: [workspaceRoot],
    })
    return validated.operationPath
  } catch {
    return null
  }
}

async function findImageTileSourcePath(
  workspaceId: string,
  tileId: string,
): Promise<ResolvedImageTileSource | null> {
  const workspaces = await readWorkspaceRefsFromUserConfig()
  for (const ws of workspaces) {
    if (ws.id !== workspaceId) continue
    try {
      const tiles = await readCanvasStateTiles(ws.id)
      const tile = tiles.find(entry => entry?.id === tileId && entry?.type === 'image')
      const filePath = typeof tile?.filePath === 'string' ? tile.filePath.trim() : ''
      if (filePath) {
        const authorized = await authorizeImageTileSource(filePath, ws.path)
        if (authorized) return { workspaceId: ws.id, filePath: authorized }
      }
    } catch {
      // ignore
    }

    try {
      const state = await loadWorkspaceTileState<{ _context?: Record<string, { value?: unknown }> }>(ws.id, tileId, {})
      const contextPath = state._context?.['ctx:image:path']?.value ?? state._context?.['ctx:file:path']?.value
      const filePath = typeof contextPath === 'string' ? contextPath.trim() : ''
      if (filePath) {
        const authorized = await authorizeImageTileSource(filePath, ws.path)
        if (authorized) return { workspaceId: ws.id, filePath: authorized }
      }
    } catch {
      // ignore
    }
  }
  return null
}

async function setTileContextFromMcp(workspaceId: string, tileId: string, key: string, value: unknown): Promise<void> {
  await updateWorkspaceTileState(workspaceId, tileId, existing => {
    const state = existing && typeof existing === 'object' && !Array.isArray(existing)
      ? existing as TileContextBackedState
      : {}
    const validated = validateTileContextWrite(
      state._context ?? {},
      key,
      value,
      'mcp:codesurf',
    )
    if (!validated.ok) throw new Error(validated.error)
    return { ...state, _context: validated.next }
  })
}

async function runGeminiImageEdit(options: {
  apiKey: string
  model: string
  prompt: string
  sourcePath: string
  outputPath?: string
}): Promise<{ outputPath: string; mimeType: string }> {
  const sourceBytes = await fs.readFile(options.sourcePath)
  const sourceMimeType = mimeTypeForImagePath(options.sourcePath)
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(options.model)}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': options.apiKey,
    },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: options.prompt },
          {
            inline_data: {
              mime_type: sourceMimeType,
              data: sourceBytes.toString('base64'),
            },
          },
        ],
      }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
      },
    }),
  })

  const text = await response.text()
  let payload: unknown = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = null
  }

  if (!response.ok) {
    const message = payload && typeof payload === 'object'
      ? ((payload as { error?: { message?: string } }).error?.message ?? text)
      : text
    throw new Error(`Gemini image edit failed (${response.status}): ${message || response.statusText}`)
  }

  const generated = extractGeminiInlineImage(payload)
  if (!generated) {
    throw new Error('Gemini completed the request but did not return an image')
  }

  const outputPath = makeImageOutputPath(options.sourcePath, options.outputPath, generated.mimeType)
  await fs.mkdir(dirname(outputPath), { recursive: true })
  await fs.writeFile(outputPath, Buffer.from(generated.data, 'base64'))
  return { outputPath, mimeType: generated.mimeType }
}

export async function executeImageEditTool(
  workspaceId: string,
  tileId: string,
  name: string,
  args: Record<string, unknown>,
  ctx: McpToolContext,
): Promise<string> {
  const prompt = asString(args.prompt) ?? (name === 'image_generate_variation' ? 'Create a natural variation of this image.' : '')
  if (!prompt) return 'Missing prompt'

  const requestPayload = {
    prompt,
    provider: asString(args.provider) ?? '',
    model: asString(args.model) ?? '',
    maskPath: asString(args.mask_path) ?? '',
    outputPath: asString(args.output_path) ?? '',
    status: 'running',
  }
  publishPeerCommand(workspaceId, tileId, name, requestPayload, ctx)

  const source = await findImageTileSourcePath(workspaceId, tileId)
  if (!source) {
    const message = `Image block ${tileId} has no source file path, so it cannot be edited`
    publishPeerCommand(workspaceId, tileId, 'image_edit_error', { message, prompt }, ctx)
    return message
  }

  await setTileContextFromMcp(source.workspaceId, tileId, 'ctx:image:edit:request', {
    kind: name === 'image_edit_request' ? 'edit' : 'variation',
    prompt,
    provider: requestPayload.provider,
    model: requestPayload.model,
    maskPath: requestPayload.maskPath,
    outputPath: requestPayload.outputPath,
    sourcePath: source.filePath,
    status: 'running',
    at: Date.now(),
  }).catch(() => {})

  const settings = await readAppSettingsForMcp()
  const selection = selectImageProvider(settings, asString(args.provider))
  if (typeof selection === 'string') {
    await setTileContextFromMcp(source.workspaceId, tileId, 'ctx:image:edit:last', {
      sourcePath: source.filePath,
      status: 'error',
      error: selection,
      prompt,
      at: Date.now(),
    }).catch(() => {})
    publishPeerCommand(workspaceId, tileId, 'image_edit_error', { message: selection, prompt, sourcePath: source.filePath }, ctx)
    return selection
  }

  const model = asString(args.model) ?? selection.model
  if (selection.provider.id !== 'gemini') {
    const message = `Image generation provider "${selection.provider.label}" is configured but not implemented yet. Use Gemini / Nano Banana for image edits for now.`
    await setTileContextFromMcp(source.workspaceId, tileId, 'ctx:image:edit:last', {
      sourcePath: source.filePath,
      status: 'error',
      error: message,
      prompt,
      provider: selection.provider.id,
      model,
      at: Date.now(),
    }).catch(() => {})
    publishPeerCommand(workspaceId, tileId, 'image_edit_error', { message, prompt, sourcePath: source.filePath }, ctx)
    return message
  }

  const apiKey = selection.provider.apiKey?.trim()
  if (!apiKey) {
    const message = 'Gemini / Nano Banana needs an API key in Settings > Providers before it can edit images.'
    await setTileContextFromMcp(source.workspaceId, tileId, 'ctx:image:edit:last', {
      sourcePath: source.filePath,
      status: 'error',
      error: message,
      prompt,
      provider: selection.provider.id,
      model,
      at: Date.now(),
    }).catch(() => {})
    publishPeerCommand(workspaceId, tileId, 'image_edit_error', { message, prompt, sourcePath: source.filePath }, ctx)
    return message
  }

  try {
    const result = await runGeminiImageEdit({
      apiKey,
      model,
      prompt,
      sourcePath: source.filePath,
      outputPath: asString(args.output_path),
    })
    publishPeerCommand(workspaceId, tileId, 'image_replace_source', {
      filePath: result.outputPath,
      note: prompt,
      provider: selection.provider.id,
      model,
    }, ctx)
    await Promise.all([
      setTileContextFromMcp(source.workspaceId, tileId, 'ctx:image:path', result.outputPath),
      setTileContextFromMcp(source.workspaceId, tileId, 'ctx:file:path', result.outputPath),
      setTileContextFromMcp(source.workspaceId, tileId, 'ctx:image:edit:last', {
        sourcePath: source.filePath,
        outputPath: result.outputPath,
        note: prompt,
        provider: selection.provider.id,
        model,
        status: 'done',
        at: Date.now(),
      }),
    ]).catch(() => {})
    return `Image updated via ${selection.provider.label} (${model}): ${result.outputPath}`
  } catch (err) {
    const message = err instanceof Error && err.message ? err.message : 'Image edit failed'
    await setTileContextFromMcp(source.workspaceId, tileId, 'ctx:image:edit:last', {
      sourcePath: source.filePath,
      status: 'error',
      error: message,
      prompt,
      provider: selection.provider.id,
      model,
      at: Date.now(),
    }).catch(() => {})
    publishPeerCommand(workspaceId, tileId, 'image_edit_error', {
      message,
      prompt,
      provider: selection.provider.id,
      model,
      sourcePath: source.filePath,
    }, ctx)
    return message
  }
}

export const GENERATION_TOOLS: McpToolSchema[] = [
  {
    name: 'generation_list_providers',
    description: 'List configured image and video generation providers. API keys are redacted; use this to choose provider and model ids for image/video tooling requests.',
    inputSchema: { type: 'object', properties: {} }
  },
]

const GENERATION_TOOL_NAMES = new Set(GENERATION_TOOLS.map(tool => tool.name))

export async function handleGenerationTool(
  name: string,
  _args: Record<string, unknown>,
  _ctx: McpToolContext,
): Promise<string | null> {
  if (!GENERATION_TOOL_NAMES.has(name)) return null

  if (name === 'generation_list_providers') {
    const settings = await readAppSettingsForMcp()
    const providers = Object.values(settings.generationProviders ?? {}).map(provider => ({
      id: provider.id,
      label: provider.label,
      enabled: provider.enabled,
      capabilities: provider.capabilities,
      hasApiKey: Boolean(provider.apiKey?.trim()),
      baseUrl: provider.baseUrl ?? '',
      textModel: provider.textModel ?? '',
      imageModel: provider.imageModel ?? '',
      videoModel: provider.videoModel ?? '',
      videoAspectRatio: provider.videoAspectRatio ?? '',
      videoResolution: provider.videoResolution ?? '',
    }))
    return JSON.stringify(providers, null, 2)
  }

  return null
}
