import { readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { CODESURF_HOME } from '../paths.ts'
import { resolveExtensionEnabled } from './activation-policy.ts'
import { isValidExtensionId } from './identity.ts'
import type { ExtensionCapabilityRequest, ExtensionManifest } from '../../shared/types.ts'
import { loadExtensionSecurityState } from './security-state.ts'
import { isValidExtensionCapabilityRequests } from '../../shared/extension-types.ts'

const EXTENSIONS_DIRNAME = 'extensions'

function resolveContexHome(contexHome?: string): string {
  return contexHome ?? CODESURF_HOME
}

export type ExtensionListEntry = {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  tier: ExtensionManifest['tier']
  ui?: ExtensionManifest['ui']
  enabled: boolean
  contributes?: ExtensionManifest['contributes']
  capabilities?: ExtensionCapabilityRequest[]
  dirPath: string | null
}

async function readManifestLight(
  extDir: string,
  disabledIds: Set<string>,
  enabledCatalogIds: Set<string>,
  opts?: { defaultEnabled?: boolean, untrustedScope?: boolean },
): Promise<ExtensionManifest | null> {
  try {
    const raw = await readFile(join(extDir, 'extension.json'), 'utf8')
    const manifest = JSON.parse(raw) as ExtensionManifest
    if (
      !isValidExtensionId(manifest.id)
      || typeof manifest.name !== 'string'
      || !manifest.name
      || typeof manifest.version !== 'string'
      || !manifest.version
    ) return null
    const capabilities = (manifest as { capabilities?: unknown }).capabilities
    if (
      capabilities !== undefined
      && !isValidExtensionCapabilityRequests(capabilities)
    ) return null
    if (!manifest.tier) manifest.tier = 'safe'
    manifest._path = resolve(extDir)
    manifest._enabled = resolveExtensionEnabled({
      untrustedScope: opts?.untrustedScope,
      defaultEnabledOption: opts?.defaultEnabled,
      tier: manifest.tier,
      disabled: disabledIds.has(manifest.id),
      enabledCatalogIds,
      extensionId: manifest.id,
      manifestEnabled: manifest._enabled,
    })
    if (manifest.contributes?.tiles) {
      for (const tile of manifest.contributes.tiles) {
        if (!tile.type.startsWith('ext:')) {
          tile.type = `ext:${tile.type}`
        }
      }
    }
    return manifest
  } catch {
    return null
  }
}

async function scanDirLight(
  dir: string,
  manifests: Map<string, ExtensionManifest>,
  disabledIds: Set<string>,
  enabledCatalogIds: Set<string>,
  opts?: { defaultEnabled?: boolean, untrustedScope?: boolean },
): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return
  }

  for (const name of entries) {
    if (name.startsWith('.')) continue
    const extDir = join(dir, name)
    const info = await stat(extDir).catch(() => null)
    if (!info?.isDirectory()) continue

    const manifest = await readManifestLight(extDir, disabledIds, enabledCatalogIds, opts)
    if (!manifest) continue
    if (manifests.has(manifest.id)) continue
    manifests.set(manifest.id, manifest)
  }
}

export async function scanExtensionManifests(
  workspacePath?: string | null,
  options?: { contexHome?: string },
): Promise<ExtensionManifest[]> {
  const contexHome = resolveContexHome(options?.contexHome)
  const securityState = await loadExtensionSecurityState(contexHome)
  const disabledIds = new Set(securityState.disabledExtensionIds)
  const enabledCatalogIds = new Set(securityState.enabledCatalogExtensionIds)
  const manifests = new Map<string, ExtensionManifest>()

  await scanDirLight(join(contexHome, EXTENSIONS_DIRNAME), manifests, disabledIds, enabledCatalogIds)
  if (workspacePath) {
    await scanDirLight(
      join(workspacePath, '.codesurf', EXTENSIONS_DIRNAME),
      manifests,
      disabledIds,
      enabledCatalogIds,
      { untrustedScope: true },
    )
  }

  return [...manifests.values()]
}

export function toExtensionListEntry(manifest: ExtensionManifest): ExtensionListEntry {
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    author: manifest.author,
    tier: manifest.tier,
    ui: manifest.ui,
    enabled: manifest._enabled !== false,
    contributes: manifest.contributes,
    capabilities: manifest.capabilities ?? [],
    dirPath: manifest._path ?? null,
  }
}

export async function listExtensionsForBridge(workspacePath?: string | null): Promise<ExtensionListEntry[]> {
  const manifests = await scanExtensionManifests(workspacePath)
  return manifests.map(toExtensionListEntry)
}

export type ExtensionSidebarResponse = {
  entries: Array<{
    id: string
    name: string
    icon: string | null
    enabled: boolean
  }>
  tiles: Array<{
    extId: string
    type: string
    label: string
    icon?: string
    entry?: string
    defaultSize: { w: number, h: number }
    minSize: { w: number, h: number }
    uiMode?: 'native' | 'custom'
  }>
}

export function formatExtensionSidebarResponse(manifests: ExtensionManifest[]): ExtensionSidebarResponse {
  return {
    entries: manifests.map(manifest => ({
      id: manifest.id,
      name: manifest.name,
      icon: manifest.contributes?.tiles?.[0]?.icon ?? manifest.contributes?.chatSurfaces?.[0]?.icon ?? null,
      enabled: manifest._enabled !== false,
    })),
    tiles: manifests
      .filter(manifest => manifest._enabled !== false)
      .flatMap(manifest => (manifest.contributes?.tiles ?? []).map(tile => ({
        extId: manifest.id,
        type: tile.type,
        label: tile.label,
        icon: tile.icon,
        entry: tile.entry,
        defaultSize: tile.defaultSize ?? { w: 400, h: 300 },
        minSize: tile.minSize ?? { w: 200, h: 150 },
        uiMode: manifest.ui?.mode,
      }))),
  }
}
