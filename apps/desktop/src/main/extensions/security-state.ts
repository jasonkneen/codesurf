import { join, resolve } from 'node:path'
import {
  isPluginCapabilityName,
  PLUGIN_CAPABILITY_NAMES,
  type PluginCapabilityName,
} from '../../shared/extension-types.ts'
import {
  readSecurityStateFile,
  removeSecurityStateDurable,
  writeSecurityJsonAtomic,
} from '../security/durableSecurityState.ts'
import { isValidExtensionId } from './identity.ts'

export const EXTENSION_SECURITY_STATE_VERSION = 1
export const EXTENSION_SECURITY_STATE_FILENAME = 'extension-security-state.json'
export const EXTENSION_SECURITY_JOURNAL_FILENAME =
  'extension-security-state.pending.json'

const MAX_SECURITY_STATE_BYTES = 4 * 1024 * 1024
const MAX_EXTENSION_STATE_ENTRIES = 1024
const MAX_TOTAL_CAPABILITY_GRANTS = 4096

const LEGACY_DISABLED_FILENAME = 'disabled-extensions.json'
const LEGACY_ENABLED_FILENAME = 'enabled-catalog-extensions.json'
const LEGACY_GRANTS_FILENAME = 'plugin-capability-grants.json'

export interface ExtensionSecurityState {
  readonly version: typeof EXTENSION_SECURITY_STATE_VERSION
  readonly disabledExtensionIds: readonly string[]
  readonly enabledCatalogExtensionIds: readonly string[]
  readonly grants: Readonly<Record<string, readonly PluginCapabilityName[]>>
}

interface ExtensionSecurityJournal {
  readonly version: typeof EXTENSION_SECURITY_STATE_VERSION
  readonly phase: 'pending' | 'committed'
  readonly base: ExtensionSecurityState
  readonly target: ExtensionSecurityState
  readonly recovery: ExtensionSecurityState
}

const stateQueues = new Map<string, Promise<void>>()

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index])
}

function assertPlainObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`)
  }
}

function parseIdArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_EXTENSION_STATE_ENTRIES) {
    throw new Error(`Invalid ${label}`)
  }
  const seen = new Set<string>()
  for (const id of value) {
    if (!isValidExtensionId(id) || seen.has(id)) {
      throw new Error(`Invalid ${label}`)
    }
    seen.add(id)
  }
  return [...seen].sort()
}

function parseGrants(
  value: unknown,
): Record<string, PluginCapabilityName[]> {
  assertPlainObject(value, 'extension capability grants')
  const entries = Object.entries(value)
  if (entries.length > MAX_EXTENSION_STATE_ENTRIES) {
    throw new Error('Extension capability grant state is too large')
  }
  let totalGrants = 0
  const grants: Record<string, PluginCapabilityName[]> = {}
  for (const [id, rawCapabilities] of entries) {
    if (
      !isValidExtensionId(id)
      || !Array.isArray(rawCapabilities)
      || rawCapabilities.length > PLUGIN_CAPABILITY_NAMES.length
    ) {
      throw new Error('Invalid extension capability grant state')
    }
    const seen = new Set<PluginCapabilityName>()
    for (const capability of rawCapabilities) {
      if (
        typeof capability !== 'string'
        || !isPluginCapabilityName(capability)
        || seen.has(capability as PluginCapabilityName)
      ) {
        throw new Error('Invalid extension capability grant state')
      }
      seen.add(capability as PluginCapabilityName)
      totalGrants += 1
      if (totalGrants > MAX_TOTAL_CAPABILITY_GRANTS) {
        throw new Error('Extension capability grant state is too large')
      }
    }
    grants[id] = PLUGIN_CAPABILITY_NAMES.filter(capability => seen.has(capability))
  }
  return Object.fromEntries(
    Object.entries(grants).sort(([left], [right]) => left.localeCompare(right)),
  )
}

export function parseExtensionSecurityState(value: unknown): ExtensionSecurityState {
  assertPlainObject(value, 'extension security state')
  if (
    !hasExactKeys(value, [
      'version',
      'disabledExtensionIds',
      'enabledCatalogExtensionIds',
      'grants',
    ])
    || value.version !== EXTENSION_SECURITY_STATE_VERSION
  ) {
    throw new Error('Unsupported or malformed extension security state')
  }
  const disabledExtensionIds = parseIdArray(
    value.disabledExtensionIds,
    'disabled extension state',
  )
  const enabledCatalogExtensionIds = parseIdArray(
    value.enabledCatalogExtensionIds,
    'enabled catalog extension state',
  )
  const disabled = new Set(disabledExtensionIds)
  if (enabledCatalogExtensionIds.some(id => disabled.has(id))) {
    throw new Error('Extension security state enables a disabled extension')
  }
  return {
    version: EXTENSION_SECURITY_STATE_VERSION,
    disabledExtensionIds,
    enabledCatalogExtensionIds,
    grants: parseGrants(value.grants),
  }
}

function parseJournal(value: unknown): ExtensionSecurityJournal {
  assertPlainObject(value, 'extension security journal')
  if (
    !hasExactKeys(value, ['version', 'phase', 'base', 'target', 'recovery'])
    || value.version !== EXTENSION_SECURITY_STATE_VERSION
    || (value.phase !== 'pending' && value.phase !== 'committed')
  ) {
    throw new Error('Unsupported or malformed extension security journal')
  }
  const base = parseExtensionSecurityState(value.base)
  const target = parseExtensionSecurityState(value.target)
  const recovery = parseExtensionSecurityState(value.recovery)
  const expectedRecovery = conservativeIntersection(base, target)
  if (!sameSecurityState(recovery, expectedRecovery)) {
    throw new Error('Extension security journal has an invalid recovery state')
  }
  return {
    version: EXTENSION_SECURITY_STATE_VERSION,
    phase: value.phase,
    base,
    target,
    recovery,
  }
}

function conservativeIntersection(
  left: ExtensionSecurityState,
  right: ExtensionSecurityState,
): ExtensionSecurityState {
  const disabled = new Set([
    ...left.disabledExtensionIds,
    ...right.disabledExtensionIds,
  ])
  const rightEnabled = new Set(right.enabledCatalogExtensionIds)
  const enabled = left.enabledCatalogExtensionIds.filter(id => rightEnabled.has(id))
  const grants: Record<string, PluginCapabilityName[]> = {}
  const ids = new Set([...Object.keys(left.grants), ...Object.keys(right.grants)])
  for (const id of ids) {
    const leftHasGrant = Object.hasOwn(left.grants, id)
    const rightHasGrant = Object.hasOwn(right.grants, id)
    if (!leftHasGrant) {
      grants[id] = [...(right.grants[id] ?? [])]
      continue
    }
    if (!rightHasGrant) {
      grants[id] = [...(left.grants[id] ?? [])]
      continue
    }
    const rightCapabilities = new Set(right.grants[id])
    grants[id] = (left.grants[id] ?? []).filter(capability => {
      return rightCapabilities.has(capability)
    })
  }
  return parseExtensionSecurityState({
    version: EXTENSION_SECURITY_STATE_VERSION,
    disabledExtensionIds: [...disabled],
    enabledCatalogExtensionIds: enabled,
    grants,
  })
}

function sameSecurityState(
  left: ExtensionSecurityState,
  right: ExtensionSecurityState,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function readJsonFile(filePath: string): Promise<unknown | null> {
  const raw = await readSecurityStateFile(filePath, MAX_SECURITY_STATE_BYTES)
  return raw === null ? null : JSON.parse(raw)
}

function parseLegacyGrants(value: unknown): Record<string, PluginCapabilityName[]> {
  assertPlainObject(value, 'legacy extension capability grants')
  const entries = Object.entries(value)
  if (entries.length > MAX_EXTENSION_STATE_ENTRIES) {
    throw new Error('Legacy extension capability grant state is too large')
  }
  let totalValues = 0
  const grants: Record<string, PluginCapabilityName[]> = {}
  for (const [id, rawCapabilities] of entries) {
    if (
      !isValidExtensionId(id)
      || !Array.isArray(rawCapabilities)
      || rawCapabilities.length > PLUGIN_CAPABILITY_NAMES.length * 2
      || rawCapabilities.some(capability => typeof capability !== 'string')
    ) {
      throw new Error('Invalid legacy extension capability grant state')
    }
    totalValues += rawCapabilities.length
    if (totalValues > MAX_TOTAL_CAPABILITY_GRANTS) {
      throw new Error('Legacy extension capability grant state is too large')
    }
    const recognized = new Set(
      rawCapabilities.filter(isPluginCapabilityName),
    )
    grants[id] = PLUGIN_CAPABILITY_NAMES.filter(capability => {
      return recognized.has(capability)
    })
  }
  return grants
}

async function loadLegacyState(
  homePath: string,
): Promise<{ state: ExtensionSecurityState; found: boolean }> {
  const [disabled, enabled, grants] = await Promise.all([
    readJsonFile(join(homePath, LEGACY_DISABLED_FILENAME)),
    readJsonFile(join(homePath, LEGACY_ENABLED_FILENAME)),
    readJsonFile(join(homePath, LEGACY_GRANTS_FILENAME)),
  ])
  const found = disabled !== null || enabled !== null || grants !== null
  const disabledExtensionIds = disabled === null
    ? []
    : parseIdArray(disabled, 'legacy disabled extension state')
  const disabledSet = new Set(disabledExtensionIds)
  const enabledCatalogExtensionIds = (enabled === null
    ? []
    : parseIdArray(enabled, 'legacy enabled catalog extension state'))
    .filter(id => !disabledSet.has(id))
  return {
    found,
    state: parseExtensionSecurityState({
      version: EXTENSION_SECURITY_STATE_VERSION,
      disabledExtensionIds,
      enabledCatalogExtensionIds,
      grants: grants === null ? {} : parseLegacyGrants(grants),
    }),
  }
}

function statePath(homePath: string): string {
  return join(resolve(homePath), EXTENSION_SECURITY_STATE_FILENAME)
}

function journalPath(homePath: string): string {
  return join(resolve(homePath), EXTENSION_SECURITY_JOURNAL_FILENAME)
}

async function recoverJournal(
  homePath: string,
  journal: ExtensionSecurityJournal,
): Promise<ExtensionSecurityState> {
  const recovered = journal.phase === 'committed'
    ? journal.target
    : journal.recovery
  await writeSecurityJsonAtomic(statePath(homePath), recovered)
  await removeSecurityStateDurable(journalPath(homePath))
  return recovered
}

async function loadUnlocked(homePath: string): Promise<ExtensionSecurityState> {
  const pending = await readJsonFile(journalPath(homePath))
  if (pending !== null) {
    return recoverJournal(homePath, parseJournal(pending))
  }

  const current = await readJsonFile(statePath(homePath))
  if (current !== null) return parseExtensionSecurityState(current)

  const legacy = await loadLegacyState(homePath)
  if (!legacy.found) {
    await persistUnlocked(homePath, legacy.state, legacy.state)
    return legacy.state
  }
  await persistUnlocked(homePath, legacy.state, legacy.state)
  return legacy.state
}

async function persistUnlocked(
  homePath: string,
  baseValue: ExtensionSecurityState,
  targetValue: ExtensionSecurityState,
): Promise<void> {
  const base = parseExtensionSecurityState(baseValue)
  const target = parseExtensionSecurityState(targetValue)
  const pending = await readJsonFile(journalPath(homePath))
  if (pending !== null) {
    const recovered = await recoverJournal(homePath, parseJournal(pending))
    if (!sameSecurityState(recovered, base)) {
      throw new Error('Extension security state changed during recovery')
    }
  } else {
    const current = await readJsonFile(statePath(homePath))
    if (current !== null && !sameSecurityState(parseExtensionSecurityState(current), base)) {
      throw new Error('Extension security state changed before update')
    }
  }
  if (sameSecurityState(base, target)) {
    const current = await readJsonFile(statePath(homePath))
    if (current !== null && sameSecurityState(parseExtensionSecurityState(current), target)) {
      return
    }
  }
  const journal: ExtensionSecurityJournal = {
    version: EXTENSION_SECURITY_STATE_VERSION,
    phase: 'pending',
    base,
    target,
    recovery: conservativeIntersection(base, target),
  }
  await writeSecurityJsonAtomic(journalPath(homePath), journal)
  await writeSecurityJsonAtomic(statePath(homePath), target)
  await writeSecurityJsonAtomic(journalPath(homePath), {
    ...journal,
    phase: 'committed',
  } satisfies ExtensionSecurityJournal)
  await removeSecurityStateDurable(journalPath(homePath))
}

async function withStateQueue<T>(
  homePath: string,
  run: () => Promise<T>,
): Promise<T> {
  const key = resolve(homePath)
  const previous = stateQueues.get(key) ?? Promise.resolve()
  const result = previous.then(run, run)
  const tail = result.then(
    () => undefined,
    () => undefined,
  )
  stateQueues.set(key, tail)
  void tail.finally(() => {
    if (stateQueues.get(key) === tail) stateQueues.delete(key)
  })
  return result
}

export async function loadExtensionSecurityState(
  homePath: string,
): Promise<ExtensionSecurityState> {
  return withStateQueue(homePath, () => loadUnlocked(resolve(homePath)))
}

export async function persistExtensionSecurityState(
  homePath: string,
  base: ExtensionSecurityState,
  target: ExtensionSecurityState,
): Promise<void> {
  return withStateQueue(homePath, () => {
    return persistUnlocked(resolve(homePath), base, target)
  })
}

export function createExtensionSecurityState(input: {
  disabledExtensionIds: Iterable<string>
  enabledCatalogExtensionIds: Iterable<string>
  grants: Readonly<Record<string, readonly string[]>>
}): ExtensionSecurityState {
  return parseExtensionSecurityState({
    version: EXTENSION_SECURITY_STATE_VERSION,
    disabledExtensionIds: [...input.disabledExtensionIds],
    enabledCatalogExtensionIds: [...input.enabledCatalogExtensionIds],
    grants: input.grants,
  })
}
