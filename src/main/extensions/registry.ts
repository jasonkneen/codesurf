/**
 * Extension registry — scans, validates, and manages codesurf extensions.
 *
 * Extensions live in:
 *   ~/.codesurf/extensions/       (global)
 *   {workspace}/.codesurf/extensions/  (per-workspace, loaded later)
 *
 * Each extension dir contains an extension.json manifest.
 */

import { promises as fs } from 'fs'
import { isAbsolute, join, relative, resolve, sep } from 'path'
import { CODESURF_HOME } from '../paths'
import { ExtensionContext } from './context'
import { activatePowerExtension, type ExtensionScope } from './loader'
import { bus } from '../event-bus'
import { adapters, assertValidAdaptedManifest, tryAdaptExtension } from './adapters'
import type { ExtensionManifest, ExtensionTileContrib, ExtensionChatSurfaceContrib, ExtensionMCPToolContrib, ExtensionContextMenuContrib, ExtensionCommandContrib, ExtensionFooterContrib, ExtensionPanelContrib, ExtensionSettingsSectionContrib, ExtensionLayoutPresetContrib } from '../../shared/types'
import {
  isPluginCapabilityName,
  isValidExtensionCapabilityRequests,
} from '../../shared/extension-types.ts'
import { resolveExtensionEnabled } from './activation-policy'
import { assertValidExtensionId, isValidExtensionId } from './identity'
import {
  MAX_EXTENSION_TEXT_RESOURCE_BYTES,
  openCanonicalResource,
  readOpenedCanonicalResourceText,
} from './resource-path'
import { log } from '../utils/logger.ts'
import {
  getDeclaredSensitiveMediaDeclaration,
  getDeclaredSensitiveMediaCapabilities,
} from '../../shared/extension-sensitive-media.ts'
import {
  captureExtensionMediaRoot,
  computeExtensionMediaAttestation,
  type ExtensionMediaAttestation,
  type ExtensionMediaResourceAttestation,
  type ExtensionMediaRootBinding,
} from './media-identity.ts'
import {
  extensionMediaResourceKey,
  extensionMediaResourcePathExists,
  readAttestedExtensionResource,
} from './media-resource-attestation.ts'
import { applyMediaExtensionHtmlPolicy } from './media-html-policy.ts'
import {
  createExtensionSecurityState,
  loadExtensionSecurityState,
  persistExtensionSecurityState,
  type ExtensionSecurityState,
} from './security-state.ts'

const extLog = log.scope('Extensions')

/** A v2 contribution tagged with its owning plugin id. */
export type OwnedContribution<T> = T & { extId: string }

/** All v2 contributions aggregated across enabled plugins, grouped by surface kind. */
export interface AggregatedContributions {
  commands: OwnedContribution<ExtensionCommandContrib>[]
  footer: OwnedContribution<ExtensionFooterContrib>[]
  panels: OwnedContribution<ExtensionPanelContrib>[]
  settingsSections: OwnedContribution<ExtensionSettingsSectionContrib>[]
  layoutPresets: OwnedContribution<ExtensionLayoutPresetContrib>[]
}

interface LightweightManifestCandidate {
  manifest: ExtensionManifest
  adapted: boolean
}

export interface LoadedExtension {
  manifest: ExtensionManifest
  mediaIdentity: string | null
  mediaAttestation: ExtensionMediaAttestation | null
  installRootBinding: ExtensionMediaRootBinding
  deactivate?: () => void
}

export interface ExtensionMediaPermission {
  readonly id: string
  readonly identity: string
  readonly name: string
  readonly enabled: boolean
  readonly declaredMedia: ReturnType<typeof getDeclaredSensitiveMediaCapabilities>
  readonly declaredMediaReasons: ReturnType<
    typeof getDeclaredSensitiveMediaDeclaration
  >['reasons']
}

const EXTENSIONS_DIRNAME = 'extensions'
const MAX_EXTENSION_MANIFEST_BYTES = 1024 * 1024

async function readExtensionManifestText(extDir: string): Promise<string> {
  const manifestPath = join(extDir, 'extension.json')
  const before = await fs.lstat(manifestPath)
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`Extension manifest is not a regular file: ${manifestPath}`)
  }
  if (before.size > MAX_EXTENSION_MANIFEST_BYTES) {
    throw new Error(`Extension manifest exceeds ${MAX_EXTENSION_MANIFEST_BYTES} bytes: ${manifestPath}`)
  }
  const opened = await openCanonicalResource(extDir, manifestPath)
  if (!opened.ok) {
    throw new Error(`Unable to safely open extension manifest: ${manifestPath}`)
  }
  const result = await readOpenedCanonicalResourceText(
    opened,
    MAX_EXTENSION_MANIFEST_BYTES,
  )
  if (!result.ok) {
    throw new Error(`Unable to safely read extension manifest: ${manifestPath}`)
  }
  const after = await fs.lstat(manifestPath)
  if (
    !after.isFile()
    || after.isSymbolicLink()
    || after.dev !== before.dev
    || after.ino !== before.ino
    || after.size !== before.size
    || after.mtimeMs !== before.mtimeMs
    || after.ctimeMs !== before.ctimeMs
  ) {
    throw new Error(`Extension manifest changed while being read: ${manifestPath}`)
  }
  return result.text
}

async function assertRegularExtensionRoot(
  extensionRoot: string,
): Promise<ExtensionMediaRootBinding> {
  return captureExtensionMediaRoot(extensionRoot)
}

type ScanRootBinding = {
  readonly root: ExtensionMediaRootBinding
  readonly scopeCanonical: string
  readonly scopeInfo: Awaited<ReturnType<typeof fs.lstat>>
  readonly scopeLexical: string
}
type ScanRootValidator = () => Promise<void>

function isContainedPath(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || Boolean(
    rel
    && rel !== '..'
    && !rel.startsWith(`..${sep}`)
    && !isAbsolute(rel),
  )
}

function sameScanInfo(
  left: Awaited<ReturnType<typeof fs.lstat>>,
  right: Awaited<ReturnType<typeof fs.lstat>>,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.birthtimeMs === right.birthtimeMs
}

function sameRootBinding(
  left: ExtensionMediaRootBinding,
  right: ExtensionMediaRootBinding,
): boolean {
  return left.lexicalRoot === right.lexicalRoot
    && left.canonicalRoot === right.canonicalRoot
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.birthtimeMs === right.birthtimeMs
}

type PriorRootAuthority = {
  readonly root: ExtensionMediaRootBinding
  readonly power: boolean
}

function rootReplacementRequiresRestriction(
  prior: PriorRootAuthority,
  current: ExtensionMediaRootBinding,
  currentIsPower: boolean,
): boolean {
  if (sameRootBinding(prior.root, current)) return false
  return prior.root.lexicalRoot === current.lexicalRoot
    || prior.power
    || currentIsPower
}

function sameMediaResourceAttestation(
  left: ExtensionMediaResourceAttestation,
  right: ExtensionMediaResourceAttestation,
): boolean {
  return left.digest === right.digest
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.birthtimeMs === right.birthtimeMs
}

function sameMediaAttestation(
  left: ExtensionMediaAttestation,
  right: ExtensionMediaAttestation,
): boolean {
  if (
    left.identity !== right.identity
    || left.resources.size !== right.resources.size
  ) return false
  for (const [path, resource] of left.resources) {
    const other = right.resources.get(path)
    if (!other || !sameMediaResourceAttestation(resource, other)) return false
  }
  return true
}

async function captureScanRoot(
  scanRoot: string,
  authorizedScope: string,
): Promise<ScanRootBinding | null> {
  const scopeLexical = resolve(authorizedScope)
  const rootLexical = resolve(scanRoot)
  if (!isContainedPath(scopeLexical, rootLexical)) return null
  try {
    const scopeCanonical = await fs.realpath(scopeLexical)
    const scopeInfo = await fs.lstat(scopeCanonical)
    if (!scopeInfo.isDirectory() || scopeInfo.isSymbolicLink()) return null
    const root = await captureExtensionMediaRoot(rootLexical)
    if (!isContainedPath(scopeCanonical, root.canonicalRoot)) return null
    return { root, scopeCanonical, scopeInfo, scopeLexical }
  } catch {
    return null
  }
}

async function assertScanRootCurrent(binding: ScanRootBinding): Promise<void> {
  const currentScope = await fs.realpath(binding.scopeLexical)
  const currentScopeInfo = await fs.lstat(currentScope)
  const currentRoot = await captureExtensionMediaRoot(binding.root.lexicalRoot)
  if (
    currentScope !== binding.scopeCanonical
    || !sameScanInfo(currentScopeInfo, binding.scopeInfo)
    || !sameRootBinding(currentRoot, binding.root)
    || !isContainedPath(currentScope, currentRoot.canonicalRoot)
  ) {
    throw new Error(`Extension scan root changed or escaped its authorized scope: ${binding.root.lexicalRoot}`)
  }
}

function normalizeTileTypes(manifest: ExtensionManifest): void {
  if (manifest.contributes?.tiles) {
    for (const tile of manifest.contributes.tiles) {
      if (!tile.type.startsWith('ext:')) {
        tile.type = `ext:${tile.type}`
      }
    }
  }
}

function assertValidManifestCapabilities(manifest: ExtensionManifest): void {
  const raw = (manifest as { capabilities?: unknown }).capabilities
  if (raw === undefined) return
  if (!isValidExtensionCapabilityRequests(raw)) {
    throw new Error(`Extension ${manifest.id} has an invalid capability request`)
  }
}

function normalizeManifestUi(manifest: ExtensionManifest): void {
  assertValidManifestCapabilities(manifest)
  manifest.ui = manifest.ui ?? {}
  if (!manifest.ui.mode) {
    manifest.ui.mode = manifest.tier === 'safe' ? 'native' : 'custom'
  }
  // ── v2 axis derivation (back-compat aliases; see docs/plugins/00-architecture.md) ──
  // execution and render are orthogonal; when omitted they derive from tier/ui.mode so
  // every existing (v1) manifest resolves to its exact current behaviour.
  if (!manifest.execution) {
    manifest.execution = manifest.tier === 'power' ? 'node' : 'iframe'
  }
  if (!manifest.render) {
    // v1 'native' was never implemented and actually rendered as an iframe — keep that.
    // Only v2 plugins opt into the real mcp-ui path via ui.mode:'native' or render:'mcp-ui'.
    manifest.render = manifest.manifestVersion === 2 && manifest.ui.mode === 'native'
      ? 'mcp-ui'
      : manifest.ui.mode === 'custom'
        ? 'iframe'
        : 'iframe'
  }
}

export class ExtensionRegistry {
  private extensions = new Map<string, LoadedExtension>()
  private extraMCPTools: Array<ExtensionMCPToolContrib & { extId: string; handler?: (args: Record<string, unknown>) => Promise<string> }> = []
  private activeWorkspacePath: string | null = null
  private disabledIds: Set<string> = new Set()
  private enabledCatalogIds: Set<string> = new Set()
  /** P1 capability grants: extId -> consented capability names. */
  private grants: Record<string, string[]> = {}
  private bundledDirs: string[]
  /** Catalog dirs: scanned for manifests but extensions default to DISABLED
   *  so their power-tier main scripts do not execute. They appear in the
   *  gallery as available-to-install entries. */
  private catalogDirs: string[]
  private transitionQueue: Promise<void> = Promise.resolve()
  private requestedRescanGeneration = 0
  private lifecycleRequestSequence = 0
  private readonly requestedEnabled = new Map<
    string,
    { readonly token: number; readonly enabled: boolean }
  >()
  private rescanPriorRootBindings:
    ReadonlyMap<string, PriorRootAuthority> | null = null
  private readonly onSensitiveMediaRevoked?: (extensionId: string) => Promise<void>
  private readonly activatePower: typeof activatePowerExtension

  constructor(opts?: {
    bundledDirs?: string[]
    catalogDirs?: string[]
    onSensitiveMediaRevoked?: (extensionId: string) => Promise<void>
    activatePower?: typeof activatePowerExtension
  }) {
    this.bundledDirs = (opts?.bundledDirs ?? []).filter(Boolean)
    this.catalogDirs = (opts?.catalogDirs ?? []).filter(Boolean)
    this.onSensitiveMediaRevoked = opts?.onSensitiveMediaRevoked
    this.activatePower = opts?.activatePower ?? activatePowerExtension
  }

  private getSecurityState(): ExtensionSecurityState {
    return createExtensionSecurityState({
      disabledExtensionIds: this.disabledIds,
      enabledCatalogExtensionIds: this.enabledCatalogIds,
      grants: this.grants,
    })
  }

  private replaceSecurityState(state: ExtensionSecurityState): void {
    const disabledIds = new Set(state.disabledExtensionIds)
    const enabledCatalogIds = new Set(state.enabledCatalogExtensionIds)
    const grants = Object.fromEntries(
      Object.entries(state.grants).map(([id, capabilities]) => [
        id,
        [...capabilities],
      ]),
    )
    this.disabledIds = disabledIds
    this.enabledCatalogIds = enabledCatalogIds
    this.grants = grants
  }

  private async persistSecurityState(base: ExtensionSecurityState): Promise<void> {
    await persistExtensionSecurityState(
      CODESURF_HOME,
      base,
      this.getSecurityState(),
    )
  }

  private async persistExactSecurityState(
    target: ExtensionSecurityState,
  ): Promise<void> {
    const current = await loadExtensionSecurityState(CODESURF_HOME)
    if (JSON.stringify(current) === JSON.stringify(target)) return
    await persistExtensionSecurityState(CODESURF_HOME, current, target)
  }

  async scan(): Promise<void> {
    const securityState = await loadExtensionSecurityState(CODESURF_HOME)
    this.replaceSecurityState(securityState)
    for (const bundledDir of this.bundledDirs) {
      await this.scanDir(bundledDir, undefined, bundledDir)
    }
    const globalDir = join(CODESURF_HOME, EXTENSIONS_DIRNAME)
    await this.scanDir(globalDir, undefined, CODESURF_HOME)
    // Catalog dirs load last. Same-id collisions: first loaded wins (bundled,
    // then global), so a stale ~/.codesurf/extensions copy cannot shadow a
    // shipped bundled extension. Workspace scans may still replace an id.
    for (const catalogDir of this.catalogDirs) {
      await this.scanDir(catalogDir, { defaultEnabled: false }, catalogDir)
    }
  }

  async scanWorkspace(workspacePath: string): Promise<void> {
    const wsDir = join(workspacePath, '.codesurf', EXTENSIONS_DIRNAME)
    // A workspace's .codesurf/extensions dir is attacker-controllable (it ships
    // with any cloned repo). Mark the scan untrusted so power-tier extensions
    // there require explicit user enablement instead of auto-activating.
    await this.scanDir(wsDir, { untrustedScope: true }, workspacePath)
  }

  async rescan(workspacePath?: string | null): Promise<void> {
    this.requestedRescanGeneration += 1
    const normalizedWorkspacePath = workspacePath == null ? null : resolve(workspacePath)
    const run = async (): Promise<void> => {
      const previousExtensions = new Map(this.extensions)
      const previousIdentities = new Map(
        [...previousExtensions].map(([id, extension]) => [id, extension.mediaIdentity]),
      )
      const preRevokedIds = new Set<string>()
      for (const [id, extension] of previousExtensions) {
        const path = extension.manifest._path
        if (!path) {
          preRevokedIds.add(id)
          continue
        }
        const currentRoot = await captureExtensionMediaRoot(path).catch(() => null)
        if (!currentRoot || !sameRootBinding(currentRoot, extension.installRootBinding)) {
          preRevokedIds.add(id)
        }
      }
      if (preRevokedIds.size > 0) {
        const securityStateBefore = this.getSecurityState()
        const failures: unknown[] = []
        for (const id of preRevokedIds) {
          const extension = this.extensions.get(id)
          if (extension) {
            extension.manifest._enabled = false
            extension.mediaIdentity = null
            extension.mediaAttestation = null
            if (extension.deactivate) {
              try {
                extension.deactivate()
              } catch (error) {
                failures.push(error)
              }
              extension.deactivate = undefined
            }
          }
          this.extraMCPTools = this.extraMCPTools.filter(tool => tool.extId !== id)
          this.disabledIds.add(id)
          this.enabledCatalogIds.delete(id)
          delete this.grants[id]
        }
        const results = await Promise.allSettled([
          this.persistSecurityState(securityStateBefore),
          ...[...preRevokedIds].map(id => this.revokeSensitiveMedia(id)),
        ])
        for (const result of results) {
          if (result.status === 'rejected') failures.push(result.reason)
        }
        if (failures.length > 0) {
          throw new AggregateError(
            failures,
            'Failed to durably revoke removed extension authority',
          )
        }
      }
      let deactivationFailure: unknown
      try {
        this.deactivateAll()
      } catch (error) {
        deactivationFailure = error
      }
      this.extensions.clear()
      this.extraMCPTools = []
      if (deactivationFailure) throw deactivationFailure
      this.activeWorkspacePath = normalizedWorkspacePath
      this.rescanPriorRootBindings = new Map(
        [...previousExtensions].map(([id, extension]) => [
          id,
          {
            root: extension.installRootBinding,
            power: extension.manifest.tier === 'power',
          },
        ]),
      )
      try {
        await this.scan()
        if (normalizedWorkspacePath) {
          await this.scanWorkspace(normalizedWorkspacePath)
        }
      } finally {
        this.rescanPriorRootBindings = null
      }
      const replacedOrRemovedIds = new Set(preRevokedIds)
      for (const [id, previous] of previousExtensions) {
        const current = this.extensions.get(id)
        if (
          current
          && rootReplacementRequiresRestriction(
            {
              root: previous.installRootBinding,
              power: previous.manifest.tier === 'power',
            },
            current.installRootBinding,
            current.manifest.tier === 'power',
          )
        ) {
          replacedOrRemovedIds.add(id)
        }
      }
      if (replacedOrRemovedIds.size > 0) {
        const securityStateBefore = this.getSecurityState()
        const failures: unknown[] = []
        for (const id of replacedOrRemovedIds) {
          const extension = this.extensions.get(id)
          if (extension) {
            extension.manifest._enabled = false
            extension.mediaIdentity = null
            extension.mediaAttestation = null
            if (extension.deactivate) {
              try {
                extension.deactivate()
              } catch (error) {
                failures.push(error)
              }
              extension.deactivate = undefined
            }
          }
          this.extraMCPTools = this.extraMCPTools.filter(tool => tool.extId !== id)
          this.disabledIds.add(id)
          this.enabledCatalogIds.delete(id)
          delete this.grants[id]
        }
        try {
          await this.persistSecurityState(securityStateBefore)
        } catch (error) {
          failures.push(error)
        }
        if (failures.length > 0) {
          throw new AggregateError(
            failures,
            'Failed to disable replaced extension authority',
          )
        }
      }
      const revokedIds = [
        ...[...previousIdentities].filter(([id, identity]) => {
          return this.extensions.get(id)?.mediaIdentity !== identity
        }).map(([id]) => id),
        ...replacedOrRemovedIds,
        ...[...this.extensions.values()]
          .filter(extension => !extension.manifest._enabled)
          .map(extension => extension.manifest.id),
      ]
      const pendingRevocations = new Set(revokedIds)
      for (const id of preRevokedIds) pendingRevocations.delete(id)
      await Promise.all(
        [...pendingRevocations].map(id => this.revokeSensitiveMedia(id)),
      )
    }

    return this.enqueueTransition(run)
  }

  async scanLightweight(workspacePath?: string | null): Promise<ExtensionManifest[]> {
    const requestedWorkspacePath = workspacePath === undefined
      ? undefined
      : workspacePath === null
        ? null
        : resolve(workspacePath)
    return this.enqueueTransition(async () => {
      const securityState = await loadExtensionSecurityState(CODESURF_HOME)
      this.replaceSecurityState(securityState)
      const disabledIds = new Set(securityState.disabledExtensionIds)
      const manifests = new Map<string, ExtensionManifest>()
      const targetWorkspacePath = requestedWorkspacePath === undefined
        ? this.activeWorkspacePath
        : requestedWorkspacePath

      for (const bundledDir of this.bundledDirs) {
        await this.scanDirLight(bundledDir, manifests, disabledIds, undefined, bundledDir)
      }
      await this.scanDirLight(
        join(CODESURF_HOME, EXTENSIONS_DIRNAME),
        manifests,
        disabledIds,
        undefined,
        CODESURF_HOME,
      )
      // Match full scan ordering: catalog candidates follow bundled/global,
      // then the active workspace is considered last.
      for (const catalogDir of this.catalogDirs) {
        await this.scanDirLight(
          catalogDir,
          manifests,
          disabledIds,
          { defaultEnabled: false },
          catalogDir,
        )
      }
      if (targetWorkspacePath) {
        await this.scanDirLight(
          join(targetWorkspacePath, '.codesurf', EXTENSIONS_DIRNAME),
          manifests,
          disabledIds,
          { untrustedScope: true },
          targetWorkspacePath,
        )
      }

      if (requestedWorkspacePath !== undefined) {
        this.activeWorkspacePath = requestedWorkspacePath
      }
      return [...manifests.values()]
    })
  }

  getActiveWorkspacePath(): string | null {
    return this.activeWorkspacePath
  }

  // See ExtensionHostRegistry (bottom of this file) for the narrow slice of
  // this class that the broker host and extension context actually depend on.

  private enqueueTransition<T>(run: () => Promise<T>): Promise<T> {
    const result = this.transitionQueue.then(run, run)
    this.transitionQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async scanDir(
    dir: string,
    opts?: { defaultEnabled?: boolean; untrustedScope?: boolean },
    authorizedScope = dir,
  ): Promise<void> {
    const scanBinding = await captureScanRoot(dir, authorizedScope)
    if (!scanBinding) return
    let entries: string[]
    try {
      entries = await fs.readdir(scanBinding.root.canonicalRoot)
    } catch {
      return // dir doesn't exist yet — that's fine
    }
    await assertScanRootCurrent(scanBinding)

    for (const name of entries) {
      await assertScanRootCurrent(scanBinding)
      if (name.startsWith('.')) continue
      const extDir = join(scanBinding.root.canonicalRoot, name)
      const extensionBinding = await captureExtensionMediaRoot(extDir).catch(() => null)
      if (
        !extensionBinding
        || !isContainedPath(scanBinding.root.canonicalRoot, extensionBinding.canonicalRoot)
      ) continue
      await assertScanRootCurrent(scanBinding)
      const validateScanRoot = (): Promise<void> => assertScanRootCurrent(scanBinding)

      try {
        const hasNativeManifest = await fs.lstat(join(extDir, 'extension.json'))
          .then(info => info.isFile())
          .catch(() => false)
        if (hasNativeManifest) {
          await this.loadExtension(extDir, opts, extensionBinding, validateScanRoot)
        } else {
          const adapted = await tryAdaptExtension(extDir)
          if (adapted) {
            await this.loadFromManifest(
              adapted,
              opts,
              extensionBinding,
              validateScanRoot,
            )
          }
        }
      } catch (err) {
        console.error(`[Extensions] Failed to load ${extDir}:`, err)
      }
    }
    await assertScanRootCurrent(scanBinding)
  }

  private async scanDirLight(
    dir: string,
    manifests: Map<string, ExtensionManifest>,
    disabledIds: Set<string>,
    opts?: { defaultEnabled?: boolean; untrustedScope?: boolean },
    authorizedScope = dir,
  ): Promise<void> {
    const scanBinding = await captureScanRoot(dir, authorizedScope)
    if (!scanBinding) return
    const stagedManifests = new Map(manifests)
    let entries: string[]
    try {
      entries = await fs.readdir(scanBinding.root.canonicalRoot)
    } catch {
      return
    }
    await assertScanRootCurrent(scanBinding)

    for (const name of entries) {
      await assertScanRootCurrent(scanBinding)
      if (name.startsWith('.')) continue
      const extDir = join(scanBinding.root.canonicalRoot, name)
      const extensionBinding = await captureExtensionMediaRoot(extDir).catch(() => null)
      if (
        !extensionBinding
        || !isContainedPath(scanBinding.root.canonicalRoot, extensionBinding.canonicalRoot)
      ) continue
      await assertScanRootCurrent(scanBinding)
      const validateScanRoot = (): Promise<void> => assertScanRootCurrent(scanBinding)

      const candidate = await this.readManifestLight(
        extDir,
        disabledIds,
        opts,
        extensionBinding,
        validateScanRoot,
      )
      if (!candidate) continue
      const { manifest, adapted } = candidate

      if (stagedManifests.has(manifest.id)) {
        // Match the full loader exactly:
        // - catalog candidates never replace installed/bundled/workspace ids;
        // - adapted candidates keep the first loaded id;
        // - bundled ids win over a later same-id global install;
        // - later native workspace manifests replace earlier native entries.
        if (adapted || this.shouldKeepExistingExtension(opts)) continue
        stagedManifests.delete(manifest.id)
      }
      stagedManifests.set(manifest.id, manifest)
    }
    await assertScanRootCurrent(scanBinding)
    manifests.clear()
    for (const [id, manifest] of stagedManifests) {
      manifests.set(id, manifest)
    }
  }

  private async readManifestLight(
    extDir: string,
    disabledIds: Set<string>,
    opts?: { defaultEnabled?: boolean; untrustedScope?: boolean },
    expectedRoot?: ExtensionMediaRootBinding,
    validateScanRoot?: ScanRootValidator,
  ): Promise<LightweightManifestCandidate | null> {
    await validateScanRoot?.()
    const currentRoot = await assertRegularExtensionRoot(extDir).catch(() => null)
    if (!currentRoot || (expectedRoot && !sameRootBinding(currentRoot, expectedRoot))) {
      return null
    }
    const nativeManifestPath = join(extDir, 'extension.json')
    const hasNativeManifest = await fs.lstat(nativeManifestPath)
      .then(info => info.isFile())
      .catch(() => false)

    if (hasNativeManifest) {
      try {
        const raw = await readExtensionManifestText(extDir)
        const manifest: ExtensionManifest = JSON.parse(raw)
        if (
          !isValidExtensionId(manifest.id)
          || typeof manifest.name !== 'string'
          || !manifest.name
          || typeof manifest.version !== 'string'
          || !manifest.version
        ) {
          return null
        }
        if (!manifest.tier) manifest.tier = 'safe'
        normalizeManifestUi(manifest)
        manifest._path = resolve(extDir)
        // Catalog entries default to disabled unless the user has explicitly
        // flipped them (persisted disabledIds treats presence==disabled; absence
        // normally means enabled — for catalog we invert that default).
        manifest._enabled = resolveExtensionEnabled({
          untrustedScope: opts?.untrustedScope,
          defaultEnabledOption: opts?.defaultEnabled,
          tier: manifest.tier,
          disabled: disabledIds.has(manifest.id),
          enabledCatalogIds: this.enabledCatalogIds,
          extensionId: manifest.id,
          manifestEnabled: manifest._enabled,
        })
        normalizeTileTypes(manifest)
        await validateScanRoot?.()
        const finalRoot = await assertRegularExtensionRoot(extDir).catch(() => null)
        if (!finalRoot || !sameRootBinding(finalRoot, currentRoot)) return null
        return { manifest, adapted: false }
      } catch {
        return null
      }
    }

    try {
      let adapted: ExtensionManifest | null = null
      for (const adapter of adapters) {
        if (await adapter.canLoad(extDir)) {
          adapted = await adapter.toManifest(extDir)
          break
        }
      }
      if (!adapted) return null
      assertValidAdaptedManifest(adapted, extDir)
      normalizeManifestUi(adapted)
      adapted._path = resolve(extDir)
      adapted._enabled = resolveExtensionEnabled({
        untrustedScope: opts?.untrustedScope,
        defaultEnabledOption: opts?.defaultEnabled,
        tier: adapted.tier,
        disabled: disabledIds.has(adapted.id),
        enabledCatalogIds: this.enabledCatalogIds,
        extensionId: adapted.id,
        manifestEnabled: adapted._enabled,
      })
      normalizeTileTypes(adapted)
      await validateScanRoot?.()
      const finalRoot = await assertRegularExtensionRoot(extDir).catch(() => null)
      if (!finalRoot || !sameRootBinding(finalRoot, currentRoot)) return null
      return { manifest: adapted, adapted: true }
    } catch {
      return null
    }
  }

  private async loadExtension(
    extDir: string,
    opts?: { defaultEnabled?: boolean; untrustedScope?: boolean },
    expectedRoot?: ExtensionMediaRootBinding,
    validateScanRoot?: ScanRootValidator,
  ): Promise<void> {
    await validateScanRoot?.()
    const rootBinding = await assertRegularExtensionRoot(extDir)
    if (expectedRoot && !sameRootBinding(rootBinding, expectedRoot)) {
      throw new Error(`Extension root changed before manifest load: ${extDir}`)
    }
    const raw = await readExtensionManifestText(extDir)
    const manifest: ExtensionManifest = JSON.parse(raw)

    // Validate required fields
    if (
      typeof manifest.name !== 'string'
      || !manifest.name
      || typeof manifest.version !== 'string'
      || !manifest.version
    ) {
      throw new Error(`Invalid manifest in ${extDir}: missing id, name, or version`)
    }
    assertValidExtensionId(manifest.id, `manifest directory ${extDir}`)
    if (!manifest.tier) manifest.tier = 'safe'
    normalizeManifestUi(manifest)

    // Attach runtime metadata. Catalog entries default to disabled unless the
    // user has explicitly enabled them via the gallery (tracked in the
    // enabledCatalogIds set, which is persisted).
    manifest._path = resolve(extDir)
    // Power-tier extensions found in an untrusted scope (a workspace's
    // .codesurf/extensions dir) run Node in the main process, so they must be
    // explicitly enabled by the user before activation — never auto-run on
    // workspace open. They reuse the same persisted enabled set as catalog
    // entries.
    manifest._enabled = resolveExtensionEnabled({
      untrustedScope: opts?.untrustedScope,
      defaultEnabledOption: opts?.defaultEnabled,
      tier: manifest.tier,
      disabled: this.disabledIds.has(manifest.id),
      enabledCatalogIds: this.enabledCatalogIds,
      extensionId: manifest.id,
      manifestEnabled: manifest._enabled,
    })
    const priorRootBinding = this.rescanPriorRootBindings?.get(manifest.id)
    if (
      priorRootBinding
      && rootReplacementRequiresRestriction(
        priorRootBinding,
        rootBinding,
        manifest.tier === 'power',
      )
    ) {
      // Do not execute a same-id replacement before rescan has durably revoked
      // the previous installation's authority.
      manifest._enabled = false
    }

    // Namespace tile types with ext: prefix
    normalizeTileTypes(manifest)

    const existing = this.extensions.get(manifest.id)
    // Decide precedence before recursive identity work:
    // - catalog and global never replace an already-loaded id (bundled wins)
    // - workspace (untrustedScope) may still replace bundled/global
    if (existing && this.shouldKeepExistingExtension(opts)) {
      return
    }

    const declaredMedia = getDeclaredSensitiveMediaCapabilities(manifest.capabilities)
    const mediaAttestation = manifest._enabled && declaredMedia.length > 0
      ? await computeExtensionMediaAttestation(extDir, manifest, rootBinding)
      : null
    const mediaIdentity = mediaAttestation?.identity ?? null
    await validateScanRoot?.()
    const finalRootBinding = await assertRegularExtensionRoot(extDir)
    if (!sameRootBinding(finalRootBinding, rootBinding)) {
      throw new Error(`Extension root changed before activation: ${extDir}`)
    }

    // Skip if already loaded (workspace overrides global)
    if (existing) {
      // Workspace extensions override global — deactivate old one
      if (existing.deactivate) existing.deactivate()
      this.extensions.delete(manifest.id)
    }

    const loaded: LoadedExtension = {
      manifest,
      mediaIdentity,
      mediaAttestation,
      installRootBinding: rootBinding,
    }

    // Load power tier extensions
    if (manifest.tier === 'power' && manifest.main && manifest._enabled) {
      await validateScanRoot?.()
      const activationRoot = await assertRegularExtensionRoot(extDir)
      if (!sameRootBinding(activationRoot, rootBinding)) {
        throw new Error(`Extension root changed before activation: ${extDir}`)
      }
      // Derive the scope for the audit log and defense-in-depth gate in loader.ts.
      const scope: ExtensionScope = opts?.untrustedScope
        ? 'workspace'
        : opts?.defaultEnabled === false
          ? 'catalog'
          : this.bundledDirs.some(d => resolve(extDir).startsWith(resolve(d)))
            ? 'bundled'
            : 'global'
      const ctx = new ExtensionContext(manifest, bus, this)
      const deactivate = await this.activatePower(manifest, ctx, scope, this)
      loaded.deactivate = deactivate ?? undefined
      // NOTE: MCP tools are registered directly into this.extraMCPTools during
      // activate() via ExtensionContext.mcp.registerTool -> registry.registerMCPTool.
      // Do NOT push ctx.getRegisteredTools() here as well — that would cause each
      // tool to appear twice in getMCPTools() output (double-registration bug).
    }

    try {
      await validateScanRoot?.()
      const commitRoot = await assertRegularExtensionRoot(extDir)
      if (!sameRootBinding(commitRoot, rootBinding)) {
        throw new Error(`Extension root changed before registry commit: ${extDir}`)
      }
    } catch (error) {
      loaded.deactivate?.()
      this.extraMCPTools = this.extraMCPTools.filter(tool => tool.extId !== manifest.id)
      throw error
    }
    this.extensions.set(manifest.id, loaded)
    extLog.info(`Loaded: ${manifest.name} v${manifest.version} (${manifest.tier})`)
  }

  /** Load an already-parsed manifest (used by adapters) */
  async loadFromManifest(
    manifest: ExtensionManifest,
    opts?: { defaultEnabled?: boolean; untrustedScope?: boolean },
    expectedRoot?: ExtensionMediaRootBinding,
    validateScanRoot?: ScanRootValidator,
  ): Promise<void> {
    assertValidAdaptedManifest(manifest, manifest._path ?? '(unknown)')
    if (this.extensions.has(manifest.id)) return
    if (!manifest._path) {
      throw new Error(`Adapted extension ${manifest.id} is missing its install path`)
    }
    await validateScanRoot?.()
    const rootBinding = await assertRegularExtensionRoot(manifest._path)
    if (expectedRoot && !sameRootBinding(rootBinding, expectedRoot)) {
      throw new Error(`Adapted extension root changed before manifest load: ${manifest._path}`)
    }

    normalizeManifestUi(manifest)

    // Apply persisted disabled state (+ catalog / untrusted-power default-off)
    manifest._enabled = resolveExtensionEnabled({
      untrustedScope: opts?.untrustedScope,
      defaultEnabledOption: opts?.defaultEnabled,
      tier: manifest.tier,
      disabled: this.disabledIds.has(manifest.id),
      enabledCatalogIds: this.enabledCatalogIds,
      extensionId: manifest.id,
      manifestEnabled: manifest._enabled,
    })
    const priorRootBinding = this.rescanPriorRootBindings?.get(manifest.id)
    if (
      priorRootBinding
      && rootReplacementRequiresRestriction(
        priorRootBinding,
        rootBinding,
        manifest.tier === 'power',
      )
    ) {
      manifest._enabled = false
    }

    // Namespace tiles
    normalizeTileTypes(manifest)

    const declaredMedia = getDeclaredSensitiveMediaCapabilities(manifest.capabilities)
    const mediaAttestation = manifest._enabled && declaredMedia.length > 0
      ? await computeExtensionMediaAttestation(manifest._path, manifest, rootBinding)
      : null
    const mediaIdentity = mediaAttestation?.identity ?? null
    const loaded: LoadedExtension = {
      manifest,
      mediaIdentity,
      mediaAttestation,
      installRootBinding: rootBinding,
    }

    if (manifest.tier === 'power' && manifest.main && manifest._enabled && manifest._path) {
      await validateScanRoot?.()
      const activationRoot = await assertRegularExtensionRoot(manifest._path)
      if (!sameRootBinding(activationRoot, rootBinding)) {
        throw new Error(`Adapted extension root changed before activation: ${manifest._path}`)
      }
      const scope: ExtensionScope = opts?.untrustedScope
        ? 'workspace'
        : opts?.defaultEnabled === false
          ? 'catalog'
          : 'global'
      const ctx = new ExtensionContext(manifest, bus, this)
      const deactivate = await this.activatePower(manifest, ctx, scope, this)
      loaded.deactivate = deactivate ?? undefined
      // NOTE: tools are registered directly via registerMCPTool during activate();
      // do not push ctx.getRegisteredTools() here to avoid double-registration.
    }

    try {
      await validateScanRoot?.()
      const commitRoot = await assertRegularExtensionRoot(manifest._path)
      if (!sameRootBinding(commitRoot, rootBinding)) {
        throw new Error(`Adapted extension root changed before registry commit: ${manifest._path}`)
      }
    } catch (error) {
      loaded.deactivate?.()
      this.extraMCPTools = this.extraMCPTools.filter(tool => tool.extId !== manifest.id)
      throw error
    }
    this.extensions.set(manifest.id, loaded)
    extLog.info(`Loaded (adapted): ${manifest.name} v${manifest.version}`)
  }

  // ── Queries ──────────────────────────────────────────────────────────────

  getAll(): ExtensionManifest[] {
    return [...this.extensions.values()].map(e => e.manifest)
  }

  get(id: string): LoadedExtension | undefined {
    if (!isValidExtensionId(id)) return undefined
    return this.extensions.get(id)
  }

  isExtensionMediaAttestationCurrent(
    id: string,
    expected: ExtensionMediaAttestation,
  ): boolean {
    const extension = this.get(id)
    return Boolean(
      extension
      && extension.manifest._enabled === true
      && extension.mediaAttestation === expected
      && extension.mediaIdentity === expected.identity,
    )
  }

  async invalidateExtensionMediaAttestation(
    id: string,
    expected: ExtensionMediaAttestation,
  ): Promise<boolean> {
    const extension = this.get(id)
    if (
      !extension
      || extension.mediaAttestation !== expected
      || extension.mediaIdentity !== expected.identity
    ) return false
    // Authorization disappears synchronously before revocation performs any
    // disk or Electron work. The object-identity compare is a CAS: a late
    // request from an older scan cannot revoke a newer installation.
    extension.mediaAttestation = null
    extension.mediaIdentity = null
    await this.revokeSensitiveMedia(id)
    return true
  }

  getExtensionMediaPermission(id: string): ExtensionMediaPermission | undefined {
    const extension = this.get(id)
    if (!extension) return undefined
    const { manifest, mediaIdentity } = extension
    const mediaDeclaration = getDeclaredSensitiveMediaDeclaration(manifest.capabilities)
    const declaredMedia = mediaDeclaration.capabilities
    if (!mediaIdentity || declaredMedia.length === 0) return undefined
    return {
      id: manifest.id,
      identity: mediaIdentity,
      name: manifest.name,
      enabled: manifest._enabled === true,
      declaredMedia,
      declaredMediaReasons: mediaDeclaration.reasons,
    }
  }

  /**
   * P1 capability gate for the iframe bridge (least privilege). A plugin that
   * declares NO capabilities is ungated (full SDK surface — no regression). A
   * plugin that declares capabilities only receives the namespaces matching its
   * GRANTED set recorded at enable time. Missing entries retain the legacy
   * declared-set fallback, while explicit empty, unknown, and no-longer-declared
   * grants cannot provide authority.
   */
  getCapabilityGate(id: string): { enforced: boolean; granted: string[] } {
    const manifest = this.extensions.get(id)?.manifest
    const declared = manifest?.capabilities
    if (!Array.isArray(declared) || declared.length === 0) {
      return { enforced: false, granted: [] }
    }
    const declaredAllowed = new Set(
      declared
        .map(capability => capability.name)
        .filter(isPluginCapabilityName),
    )
    const storedGrants = Object.hasOwn(this.grants, id)
      ? this.grants[id] ?? []
      : [...declaredAllowed]
    const granted = storedGrants.filter(capability => {
      return isPluginCapabilityName(capability) && declaredAllowed.has(capability)
    })
    return { enforced: true, granted }
  }

  getTileTypes(): ExtensionTileContrib[] {
    const tiles: ExtensionTileContrib[] = []
    for (const ext of this.extensions.values()) {
      if (!ext.manifest._enabled) continue
      if (ext.manifest.contributes?.tiles) {
        for (const tile of ext.manifest.contributes.tiles) {
          tiles.push({
            ...tile,
            extId: ext.manifest.id,
            uiMode: ext.manifest.ui?.mode,
            render: ext.manifest.render,
            sensitiveMedia: getDeclaredSensitiveMediaCapabilities(ext.manifest.capabilities),
          })
        }
      }
    }
    return tiles
  }

  getChatSurfaces(): ExtensionChatSurfaceContrib[] {
    const surfaces: ExtensionChatSurfaceContrib[] = []
    for (const ext of this.extensions.values()) {
      if (!ext.manifest._enabled) continue
      if (ext.manifest.contributes?.chatSurfaces) {
        for (const surface of ext.manifest.contributes.chatSurfaces) {
          surfaces.push({ ...surface, extId: ext.manifest.id, uiMode: ext.manifest.ui?.mode })
        }
      }
    }
    return surfaces
  }

  getExtensionActions(): Map<string, Array<{ name: string; description: string }>> {
    const result = new Map<string, Array<{ name: string; description: string }>>()
    for (const ext of this.extensions.values()) {
      if (!ext.manifest._enabled) continue
      const contributes = ext.manifest.contributes as any
      const actions = contributes?.actions
      if (Array.isArray(actions) && actions.length > 0) {
        result.set(ext.manifest.id, actions.map((a: { name?: unknown; description?: unknown }) => ({ name: String(a.name ?? ''), description: String(a.description ?? '') })))
      }
    }
    return result
  }

  getMCPTools(): Array<ExtensionMCPToolContrib & { extId: string; handler?: (args: Record<string, unknown>) => Promise<string> }> {
    const tools: typeof this.extraMCPTools = []
    // Declarative tools from manifests
    for (const ext of this.extensions.values()) {
      if (!ext.manifest._enabled) continue
      if (ext.manifest.contributes?.mcpTools) {
        for (const tool of ext.manifest.contributes.mcpTools) {
          tools.push({ ...tool, extId: ext.manifest.id })
        }
      }
    }
    // Programmatic tools from power tier activate()
    tools.push(...this.extraMCPTools)
    return tools
  }

  getContextMenuItems(): ExtensionContextMenuContrib[] {
    const items: ExtensionContextMenuContrib[] = []
    for (const ext of this.extensions.values()) {
      if (!ext.manifest._enabled) continue
      if (ext.manifest.contributes?.contextMenu) {
        for (const item of ext.manifest.contributes.contextMenu) {
          items.push({ ...item, extId: ext.manifest.id })
        }
      }
    }
    return items
  }

  // ── v2 contribution aggregation (additive; surfaces opt into these) ─────────
  // Each getter collects a single contribution kind from every enabled plugin and
  // tags it with the owning plugin id. `getContributions()` returns them grouped so
  // the renderer can fetch everything in one IPC round-trip and fan out to <Slot>s.

  private collect<T>(pick: (m: ExtensionManifest) => T[] | undefined): OwnedContribution<T>[] {
    const out: OwnedContribution<T>[] = []
    for (const ext of this.extensions.values()) {
      if (!ext.manifest._enabled) continue
      for (const item of pick(ext.manifest) ?? []) {
        out.push({ ...item, extId: ext.manifest.id })
      }
    }
    return out
  }

  getCommands(): OwnedContribution<ExtensionCommandContrib>[] {
    return this.collect(m => m.contributes?.commands)
  }

  getFooterItems(): OwnedContribution<ExtensionFooterContrib>[] {
    return this.collect(m => m.contributes?.footer)
  }

  getPanels(): OwnedContribution<ExtensionPanelContrib>[] {
    return this.collect(m => m.contributes?.panels)
  }

  getSettingsSections(): OwnedContribution<ExtensionSettingsSectionContrib>[] {
    return this.collect(m => m.contributes?.settingsSections)
  }

  getLayoutPresets(): OwnedContribution<ExtensionLayoutPresetContrib>[] {
    return this.collect(m => m.contributes?.layoutPresets)
  }

  getContributions(): AggregatedContributions {
    return {
      commands: this.getCommands(),
      footer: this.getFooterItems(),
      panels: this.getPanels(),
      settingsSections: this.getSettingsSections(),
      layoutPresets: this.getLayoutPresets(),
    }
  }

  /** Read a contribution's entry file as HTML for the render:'mcp-ui' (or iframe)
   *  html feed. If the entry is an MCP-UI createUIResource JSON, extract its html
   *  text. Path-guarded to the extension root. */
  async getSurfaceHtml(extId: string, kind: string, surfaceId: string): Promise<string | null> {
    const ext = this.get(extId)
    if (!ext?.manifest._path || !ext.manifest._enabled) return null
    const c = ext.manifest.contributes
    let entry: string | undefined
    if (kind === 'footer') entry = c?.footer?.find(f => f.id === surfaceId)?.entry
    else if (kind === 'panel') entry = c?.panels?.find(p => p.id === surfaceId)?.entry
    else if (kind === 'tile') entry = c?.tiles?.find(t => t.type === surfaceId)?.entry
    else if (kind === 'chat') entry = c?.chatSurfaces?.find(s => s.id === surfaceId)?.entry
    if (!entry) return null
    const root = ext.manifest._path
    const abs = resolve(root, ...entry.split(/[\\/]/).filter(Boolean))
    const requiresMediaAttestation = getDeclaredSensitiveMediaCapabilities(
      ext.manifest.capabilities,
    ).length > 0
    const mediaAttestation = ext.mediaAttestation
    if (requiresMediaAttestation && !mediaAttestation) return null
    const mediaResourceKey = mediaAttestation
      ? extensionMediaResourceKey(ext.installRootBinding, abs)
      : undefined
    const expectedResource = mediaResourceKey
      ? mediaAttestation?.resources.get(mediaResourceKey)
      : undefined
    const resolvedResource = await openCanonicalResource(root, abs)
    if (!resolvedResource.ok) {
      const unattestedPathExists = mediaAttestation
        && !expectedResource
        && mediaResourceKey
        && await extensionMediaResourcePathExists(
          ext.installRootBinding,
          abs,
        ).catch(() => true)
      if (mediaAttestation && (expectedResource || unattestedPathExists)) {
        await this.invalidateExtensionMediaAttestation(extId, mediaAttestation)
      }
      return null
    }
    if (mediaAttestation && (!mediaResourceKey || !expectedResource)) {
      await resolvedResource.handle.close().catch(() => undefined)
      await this.invalidateExtensionMediaAttestation(extId, mediaAttestation)
      return null
    }
    if (
      mediaAttestation
      && expectedResource
      && expectedResource.size > MAX_EXTENSION_TEXT_RESOURCE_BYTES
    ) {
      await resolvedResource.handle.close().catch(() => undefined)
      return null
    }
    try {
      const raw = mediaAttestation && mediaResourceKey && expectedResource
        ? await readAttestedExtensionResource(
            resolvedResource,
            ext.installRootBinding,
            mediaResourceKey,
            expectedResource,
          ).then(async result => {
            if (
              !result.ok
              || !this.isExtensionMediaAttestationCurrent(extId, mediaAttestation)
            ) {
              if (!result.ok && result.reason === 'changed') {
                await this.invalidateExtensionMediaAttestation(extId, mediaAttestation)
              }
              return null
            }
            return result.bytes.toString('utf8')
          })
        : await readOpenedCanonicalResourceText(resolvedResource).then(result => {
            return result.ok ? result.text : null
          })
      if (raw === null) return null
      let html = raw
      if (raw.trimStart().startsWith('{')) {
        try {
          const obj = JSON.parse(raw) as { resource?: { contents?: Array<{ text?: string }> }; contents?: Array<{ text?: string }> }
          const text = obj?.resource?.contents?.[0]?.text ?? obj?.contents?.[0]?.text
          if (typeof text === 'string') html = text
        } catch { /* not mcp-ui resource json; serve raw */ }
      }
      return requiresMediaAttestation
        ? applyMediaExtensionHtmlPolicy(html, { injectMeta: true }).html
        : html
    } catch {
      return null
    }
  }

  getTileEntry(extId: string, tileType: string, tileId?: string): string | null {
    const ext = this.extensions.get(extId)
    if (!ext?.manifest._path || !ext.manifest._enabled) return null
    const tile = ext.manifest.contributes?.tiles?.find(t => t.type === tileType)
    if (!tile) return null

    const entrySegments = tile.entry
      .split(/[\\/]/)
      .filter(Boolean)
      .map(segment => encodeURIComponent(segment))
    const query = tileId ? `?tileId=${encodeURIComponent(tileId)}&_t=${Date.now()}` : ''

    return `codesurf-ext://${encodeURIComponent(extId)}/${entrySegments.join('/')}${query}`
  }

  getChatSurfaceEntry(extId: string, surfaceId: string, instanceId?: string): string | null {
    const ext = this.extensions.get(extId)
    if (!ext?.manifest._path || !ext.manifest._enabled) return null
    const surface = ext.manifest.contributes?.chatSurfaces?.find(s => s.id === surfaceId)
    if (!surface) return null

    const entrySegments = surface.entry
      .split(/[\\/]/)
      .filter(Boolean)
      .map(segment => encodeURIComponent(segment))
    const params: string[] = []
    if (instanceId) params.push(`surfaceId=${encodeURIComponent(instanceId)}`)
    params.push(`surfaceKind=chat`)
    params.push(`_t=${Date.now()}`)
    const query = `?${params.join('&')}`

    return `codesurf-ext://${encodeURIComponent(extId)}/${entrySegments.join('/')}${query}`
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Same-id collision policy used by both the full loader and the lightweight
   * scan. First loaded id wins (bundled, then global); catalog never replaces;
   * workspace scans may replace an earlier id.
   */
  private shouldKeepExistingExtension(
    opts?: { defaultEnabled?: boolean; untrustedScope?: boolean },
  ): boolean {
    if (opts?.untrustedScope) return false
    return true
  }

  /** Is this extension's path under one of the registered catalog dirs? */
  private isCatalogExtension(manifest: ExtensionManifest): boolean {
    if (!manifest._path) return false
    const p = resolve(manifest._path)
    return this.catalogDirs.some(dir => {
      const root = resolve(dir)
      return p === root || p.startsWith(root + '/') || p.startsWith(root + '\\')
    })
  }

  enable(id: string): Promise<boolean> {
    const request = {
      token: ++this.lifecycleRequestSequence,
      enabled: true,
    } as const
    this.requestedEnabled.set(id, request)
    const rescanGeneration = this.requestedRescanGeneration
    const result = this.enqueueTransition(() => {
      return this.enableWithinTransition(id, rescanGeneration, request)
    })
    return result.finally(() => {
      if (this.requestedEnabled.get(id) === request) {
        this.requestedEnabled.delete(id)
      }
    })
  }

  private async enableWithinTransition(
    id: string,
    rescanGeneration: number,
    request: { readonly token: number; readonly enabled: true },
  ): Promise<boolean> {
    const ext = this.extensions.get(id)
    if (!ext) return false
    const requestIsCurrent = (): boolean => {
      return this.extensions.get(id) === ext
        && this.requestedEnabled.get(id) === request
        && this.requestedRescanGeneration === rescanGeneration
    }
    if (!requestIsCurrent()) return true
    const wasEnabled = ext.manifest._enabled === true
    const previousMediaIdentity = ext.mediaIdentity
    const previousMediaAttestation = ext.mediaAttestation
    const previousDeactivate = ext.deactivate
    const registeredToolsBefore = new Set(this.extraMCPTools)
    let pendingMediaAttestation = ext.mediaAttestation
    if (!wasEnabled) {
      if (!ext.manifest._path) {
        throw new Error(`Extension ${id} is missing its install path`)
      }
      const currentRoot = await assertRegularExtensionRoot(ext.manifest._path)
      if (!sameRootBinding(currentRoot, ext.installRootBinding)) {
        throw new Error(`Extension root changed after scan; rescan before enabling: ${ext.manifest._path}`)
      }
      // A disabled extension must always start from a fresh sensitive-media
      // consent state, even if an earlier disk revoke was interrupted.
      await this.revokeSensitiveMedia(id)
      const declaredMedia = getDeclaredSensitiveMediaCapabilities(ext.manifest.capabilities)
      pendingMediaAttestation = declaredMedia.length > 0 && ext.manifest._path
        ? await computeExtensionMediaAttestation(
            ext.manifest._path,
            ext.manifest,
            ext.installRootBinding,
          )
        : null
    }
    if (!requestIsCurrent()) return true
    const securityStateBefore = this.getSecurityState()
    const caps = ext.manifest.capabilities
    const requestedCapabilities = Array.isArray(caps)
      ? caps.map(capability => capability.name)
      : []
    if (
      requestedCapabilities.some(capability => !isPluginCapabilityName(capability))
      || new Set(requestedCapabilities).size !== requestedCapabilities.length
    ) {
      throw new Error(`Extension ${id} requests an unsupported or duplicate capability`)
    }
    this.disabledIds.delete(id)
    // If this was installed from a catalog dir, persist that the user has
    // explicitly enabled it so future rescans do not revert the default-off.
    const isCatalog = this.isCatalogExtension(ext.manifest)
    // Persist explicit enablement for catalog entries AND any power-tier
    // extension. Workspace power extensions default to off (untrusted scope);
    // recording the opt-in here keeps them enabled across rescans.
    const persistEnabled = isCatalog || ext.manifest.tier === 'power'
    if (persistEnabled) {
      this.enabledCatalogIds.add(id)
    }
    // P1 consent: enabling a plugin that declares capabilities grants exactly
    // those, recorded authoritatively + persisted. The "Wants: <cap>" row in the
    // gallery is the consent surface; clicking Add/enable is the consent.
    if (requestedCapabilities.length > 0) {
      this.grants[id] = requestedCapabilities
    } else {
      delete this.grants[id]
    }
    const restorePreviousState = async (): Promise<void> => {
      const failures: unknown[] = []
      if (ext.deactivate && ext.deactivate !== previousDeactivate) {
        try {
          ext.deactivate()
        } catch (error) {
          failures.push(error)
        }
      }
      ext.deactivate = previousDeactivate
      this.extraMCPTools = this.extraMCPTools.filter(tool => {
        return tool.extId !== id || registeredToolsBefore.has(tool)
      })
      ext.manifest._enabled = wasEnabled
      ext.mediaIdentity = previousMediaIdentity
      ext.mediaAttestation = previousMediaAttestation
      this.replaceSecurityState(securityStateBefore)
      const persistenceResults = await Promise.allSettled([
        this.persistExactSecurityState(securityStateBefore),
        !wasEnabled ? this.revokeSensitiveMedia(id) : Promise.resolve(),
      ])
      for (const result of persistenceResults) {
        if (result.status === 'rejected') failures.push(result.reason)
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `Failed to durably roll back extension ${id}`,
        )
      }
    }
    const rollback = async (error: unknown): Promise<never> => {
      try {
        await restorePreviousState()
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Extension ${id} failed and its rollback was not durable`,
        )
      }
      throw error
    }
    // Await disk writes so a subsequent ext:refresh rescan reads the latest
    // sets from disk (scan() reloads both sets from files).
    try {
      await this.persistSecurityState(securityStateBefore)
      const path = ext.manifest._path
      if (!path) throw new Error(`Extension ${id} is missing its install path`)
      const afterPersistenceRoot = await assertRegularExtensionRoot(path)
      if (!sameRootBinding(afterPersistenceRoot, ext.installRootBinding)) {
        throw new Error(`Extension root changed while enabling; rescan required: ${path}`)
      }
      if (pendingMediaAttestation) {
        const verified = await computeExtensionMediaAttestation(
          path,
          ext.manifest,
          ext.installRootBinding,
        )
        if (!sameMediaAttestation(verified, pendingMediaAttestation)) {
          throw new Error(`Extension content changed while enabling; rescan required: ${path}`)
        }
        pendingMediaAttestation = verified
      }
    } catch (error) {
      return rollback(error)
    }
    if (!requestIsCurrent()) {
      await restorePreviousState()
      return true
    }
    // Power-tier extensions may not have been activated on first scan (catalog
    // or workspace default-off). Load the main script now that the user has
    // explicitly enabled it — this is the explicit user opt-in for untrusted scope.
    const m = ext.manifest
    if (m.tier === 'power' && m.main && !ext.deactivate && m._path) {
      // Determine scope for audit log.  isCatalogExtension is already computed
      // above; workspace extensions are not under any catalogDir but were loaded
      // with untrustedScope so their path is not under bundledDirs or the global dir.
      const scope: ExtensionScope = isCatalog
        ? 'catalog'
        : this.bundledDirs.some(d => m._path && resolve(m._path).startsWith(resolve(d)))
          ? 'bundled'
          : m._path && resolve(m._path).startsWith(resolve(join(CODESURF_HOME, EXTENSIONS_DIRNAME)))
            ? 'global'
            : 'workspace'
      console.warn(
        `[Security] User explicitly enabled power extension "${m.name}" (${m.id}) ` +
        `from scope "${scope}" — runs with full main-process privileges.`,
      )
      let activationSuperseded = false
      try {
        const ctx = new ExtensionContext(m, bus, this)
        const activationRoot = await assertRegularExtensionRoot(m._path)
        if (!sameRootBinding(activationRoot, ext.installRootBinding)) {
          throw new Error(`Extension root changed before activation; rescan required: ${m._path}`)
        }
        if (pendingMediaAttestation) {
          const activationAttestation = await computeExtensionMediaAttestation(
            m._path,
            m,
            ext.installRootBinding,
          )
          if (!sameMediaAttestation(activationAttestation, pendingMediaAttestation)) {
            throw new Error(`Extension content changed before activation; rescan required: ${m._path}`)
          }
          pendingMediaAttestation = activationAttestation
        }
        ext.manifest._enabled = true
        ext.mediaAttestation = pendingMediaAttestation
        ext.mediaIdentity = pendingMediaAttestation?.identity ?? null
        const deactivate = await this.activatePower(m, ctx, scope, this)
        if (!deactivate) {
          throw new Error(`Power extension activation failed: ${m.id}`)
        }
        ext.deactivate = deactivate
        activationSuperseded = (
          !requestIsCurrent()
          || ext.manifest._enabled !== true
        )
        // NOTE: tools are registered directly via registerMCPTool during activate();
        // do not push ctx.getRegisteredTools() here to avoid double-registration.
      } catch (err) {
        return rollback(err)
      }
      if (activationSuperseded) {
        await restorePreviousState()
        return true
      }
    } else {
      if (!requestIsCurrent()) {
        await restorePreviousState()
        return true
      }
      ext.manifest._enabled = true
      ext.mediaAttestation = pendingMediaAttestation
      ext.mediaIdentity = pendingMediaAttestation?.identity ?? null
    }
    return true
  }

  disable(id: string): Promise<boolean> {
    const request = {
      token: ++this.lifecycleRequestSequence,
      enabled: false,
    } as const
    this.requestedEnabled.set(id, request)
    const result = this.enqueueTransition(() => {
      return this.disableWithinTransition(id, request)
    })
    return result.finally(() => {
      if (this.requestedEnabled.get(id) === request) {
        this.requestedEnabled.delete(id)
      }
    })
  }

  private async disableWithinTransition(
    id: string,
    request: { readonly token: number; readonly enabled: false },
  ): Promise<boolean> {
    if (this.requestedEnabled.get(id) !== request) return true
    const ext = this.extensions.get(id)
    if (!ext) return false
    const securityStateBefore = this.getSecurityState()
    ext.manifest._enabled = false
    ext.mediaIdentity = null
    ext.mediaAttestation = null
    const failures: unknown[] = []
    if (ext.deactivate) {
      try {
        ext.deactivate()
      } catch (error) {
        failures.push(error)
      }
      ext.deactivate = undefined
    }
    // Drop any MCP tools before persistence so a disable request cannot leave
    // a callable capability while durable state is being updated.
    this.extraMCPTools = this.extraMCPTools.filter(t => t.extId !== id)
    this.disabledIds.add(id)
    this.enabledCatalogIds.delete(id)
    delete this.grants[id]
    const persistenceResults = await Promise.allSettled([
      this.persistSecurityState(securityStateBefore),
      this.revokeSensitiveMedia(id),
    ])
    for (const result of persistenceResults) {
      if (result.status === 'rejected') failures.push(result.reason)
    }
    return failures.length === 0
  }

  private async revokeSensitiveMedia(id: string): Promise<void> {
    await this.onSensitiveMediaRevoked?.(id)
  }

  deactivateAll(): void {
    const failures: unknown[] = []
    for (const ext of this.extensions.values()) {
      const deactivate = ext.deactivate
      ext.deactivate = undefined
      if (!deactivate) continue
      try {
        deactivate()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        'One or more extensions failed to deactivate',
      )
    }
  }

  /** Register a programmatic MCP tool (called from ExtensionContext) */
  registerMCPTool(extId: string, tool: ExtensionMCPToolContrib & { handler?: (args: Record<string, unknown>) => Promise<string> }): void {
    this.extraMCPTools.push({ ...tool, extId })
  }
}

/**
 * The exact slice of ExtensionRegistry that ExtensionBrokerHost and
 * ExtensionContext depend on.
 *
 * They take this narrow interface rather than the whole class so the broker
 * test harness can supply a real, type-checked fake instead of casting one
 * through `as never`. That cast previously silenced the compiler and let
 * `getActiveWorkspacePath` drift out of the fake, which failed at runtime and
 * took down all 13 broker host tests — including the IPC namespace-escape
 * security assertion, which then failed for an unrelated reason.
 *
 * Adding a registry call in the host or context is now a compile error until
 * the fake implements it too.
 */
export interface ExtensionHostRegistry {
  getCapabilityGate(id: string): { enforced: boolean; granted: string[] }
  registerMCPTool(
    extId: string,
    tool: ExtensionMCPToolContrib & { handler?: (args: Record<string, unknown>) => Promise<string> },
  ): void
  getActiveWorkspacePath(): string | null
}
