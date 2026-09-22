import { join } from 'node:path'
import { CODESURF_HOME } from '../paths.ts'
import { isValidExtensionId } from '../extensions/identity.ts'
import {
  readSecurityStateFile,
  writeSecurityStateAtomic,
} from './durableSecurityState.ts'
import {
  isExtensionMediaIdentity,
  isSensitiveMediaCapability,
  type SensitiveMediaCapability,
} from '../../shared/extension-sensitive-media.ts'

export type ExtensionMediaConsentDecision = 'allow' | 'deny'

interface PersistedExtensionConsent {
  readonly extensionId: string
  readonly extensionIdentity: string
  readonly grants: Partial<
    Record<SensitiveMediaCapability, ExtensionMediaConsentDecision>
  >
}

interface PersistedConsent {
  readonly version: 2
  readonly decisions: PersistedExtensionConsent[]
}

export interface ExtensionMediaConsentPrompt {
  readonly extensionId: string
  readonly extensionIdentity: string
  readonly extensionName: string
  readonly kind: SensitiveMediaCapability
  readonly owner?: unknown
  readonly reason?: string
}

export interface ExtensionMediaConsentStoreOptions {
  readonly filePath?: string
}

const DEFAULT_CONSENT_PATH = join(CODESURF_HOME, 'extension-sensitive-media-consent.json')
const MAX_CONSENT_BYTES = 1024 * 1024

function emptyConsent(): PersistedConsent {
  return { version: 2, decisions: [] }
}

function parseConsent(raw: string): { consent: PersistedConsent; rewrite: boolean } {
  try {
    const parsed = JSON.parse(raw) as {
      version?: unknown
      decisions?: unknown
    }
    if (parsed.version !== 2 || !Array.isArray(parsed.decisions)) {
      return { consent: emptyConsent(), rewrite: true }
    }

    const decisions: PersistedExtensionConsent[] = []
    const seen = new Set<string>()
    const rejected = new Set<string>()
    let rewrite = false
    for (const value of parsed.decisions) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        rewrite = true
        continue
      }
      const record = value as {
        extensionId?: unknown
        extensionIdentity?: unknown
        grants?: unknown
      }
      if (
        typeof record.extensionId !== 'string'
        || !isValidExtensionId(record.extensionId)
        || !isExtensionMediaIdentity(record.extensionIdentity)
        || !record.grants
        || typeof record.grants !== 'object'
        || Array.isArray(record.grants)
      ) {
        rewrite = true
        continue
      }
      const grants: Partial<
        Record<SensitiveMediaCapability, ExtensionMediaConsentDecision>
      > = {}
      for (const [kind, decision] of Object.entries(record.grants)) {
        if (
          isSensitiveMediaCapability(kind)
          && (decision === 'allow' || decision === 'deny')
        ) {
          grants[kind] = decision
        } else {
          rewrite = true
        }
      }
      const key = `${record.extensionId}\u0000${record.extensionIdentity}`
      if (seen.has(key)) {
        const existingIndex = decisions.findIndex(decision => {
          return decision.extensionId === record.extensionId
            && decision.extensionIdentity === record.extensionIdentity
        })
        if (existingIndex >= 0) decisions.splice(existingIndex, 1)
        rejected.add(key)
        rewrite = true
      } else if (Object.keys(grants).length > 0 && !rejected.has(key)) {
        seen.add(key)
        decisions.push({
          extensionId: record.extensionId,
          extensionIdentity: record.extensionIdentity,
          grants,
        })
      } else {
        rewrite = true
      }
    }
    return { consent: { version: 2, decisions }, rewrite }
  } catch {
    return { consent: emptyConsent(), rewrite: true }
  }
}

export class ExtensionMediaConsentStore {
  private readonly filePath: string
  private readonly loadPromise: Promise<void>
  private persisted = emptyConsent()
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(options?: ExtensionMediaConsentStoreOptions) {
    this.filePath = options?.filePath ?? DEFAULT_CONSENT_PATH
    this.loadPromise = this.load()
  }

  get ready(): Promise<void> {
    return this.loadPromise
  }

  getDecision(
    extensionId: string,
    extensionIdentity: string,
    kind: SensitiveMediaCapability,
  ): ExtensionMediaConsentDecision | undefined {
    if (
      !isValidExtensionId(extensionId)
      || !isExtensionMediaIdentity(extensionIdentity)
      || !isSensitiveMediaCapability(kind)
    ) {
      return undefined
    }
    return this.persisted.decisions.find(decision => {
      return decision.extensionId === extensionId
        && decision.extensionIdentity === extensionIdentity
    })?.grants[kind]
  }

  async setDecision(
    extensionId: string,
    extensionIdentity: string,
    kind: SensitiveMediaCapability,
    decision: ExtensionMediaConsentDecision,
  ): Promise<void> {
    if (!isValidExtensionId(extensionId)) {
      throw new Error(`Invalid extension id: ${extensionId}`)
    }
    if (!isExtensionMediaIdentity(extensionIdentity)) {
      throw new Error('Invalid extension media identity')
    }
    if (!isSensitiveMediaCapability(kind)) {
      throw new Error('Invalid sensitive media capability')
    }
    if (decision !== 'allow' && decision !== 'deny') {
      throw new Error('Invalid extension media consent decision')
    }
    await this.ready
    await this.update((current) => {
      const decisions = current.decisions.map(entry => ({
        ...entry,
        grants: { ...entry.grants },
      }))
      const existing = decisions.find(entry => {
        return entry.extensionId === extensionId
          && entry.extensionIdentity === extensionIdentity
      })
      if (existing) {
        existing.grants[kind] = decision
      } else {
        decisions.push({
          extensionId,
          extensionIdentity,
          grants: { [kind]: decision },
        })
      }
      return { version: 2, decisions }
    })
  }

  async revokeExtension(extensionId: string): Promise<void> {
    if (!isValidExtensionId(extensionId)) return
    await this.ready
    await this.update((current) => {
      const decisions = current.decisions.filter(decision => {
        return decision.extensionId !== extensionId
      })
      return decisions.length === current.decisions.length
        ? current
        : { version: 2, decisions }
    })
  }

  private async load(): Promise<void> {
    const raw = await readSecurityStateFile(this.filePath, MAX_CONSENT_BYTES)
    if (raw === null) return
    const parsed = parseConsent(raw)
    await this.writeSnapshot(JSON.stringify(parsed.consent, null, 2))
    this.persisted = parsed.consent
  }

  private async update(
    updater: (current: PersistedConsent) => PersistedConsent,
  ): Promise<void> {
    const run = async (): Promise<void> => {
      const next = updater(this.persisted)
      if (next === this.persisted) return
      await this.writeSnapshot(JSON.stringify(next, null, 2))
      this.persisted = next
    }
    const result = this.writeQueue.then(run, run)
    this.writeQueue = result.catch(() => undefined)
    await result
  }

  private async writeSnapshot(snapshot: string): Promise<void> {
    await writeSecurityStateAtomic(this.filePath, snapshot)
  }
}

export class ExtensionMediaConsentManager {
  private readonly pendingByKey = new Map<string, Promise<boolean>>()
  private readonly revocationsByExtension = new Map<string, Promise<void>>()
  private readonly extensionGenerations = new Map<string, number>()
  private promptQueue: Promise<void> = Promise.resolve()
  private readonly store: ExtensionMediaConsentStore
  private readonly prompt: (
    request: ExtensionMediaConsentPrompt,
  ) => Promise<boolean>

  constructor(
    store: ExtensionMediaConsentStore,
    prompt: (request: ExtensionMediaConsentPrompt) => Promise<boolean>,
  ) {
    this.store = store
    this.prompt = prompt
  }

  get ready(): Promise<void> {
    return this.store.ready
  }

  hasConsent(
    extensionId: string,
    extensionIdentity: string,
    kind: SensitiveMediaCapability,
  ): boolean {
    if (this.revocationsByExtension.has(extensionId)) return false
    return this.store.getDecision(extensionId, extensionIdentity, kind) === 'allow'
  }

  async requestConsent(request: ExtensionMediaConsentPrompt): Promise<boolean> {
    if (
      !isValidExtensionId(request.extensionId)
      || !isExtensionMediaIdentity(request.extensionIdentity)
      || !isSensitiveMediaCapability(request.kind)
    ) return false
    if (this.revocationsByExtension.has(request.extensionId)) return false
    await this.ready
    if (this.revocationsByExtension.has(request.extensionId)) return false
    const stored = this.store.getDecision(
      request.extensionId,
      request.extensionIdentity,
      request.kind,
    )
    if (stored) return stored === 'allow'

    const key = `${request.extensionId}:${request.extensionIdentity}:${request.kind}`
    const pending = this.pendingByKey.get(key)
    if (pending) return pending
    const generation = this.extensionGenerations.get(request.extensionId) ?? 0

    const promptResult = this.promptQueue.then(async () => {
      if ((this.extensionGenerations.get(request.extensionId) ?? 0) !== generation) {
        return false
      }
      const current = this.store.getDecision(
        request.extensionId,
        request.extensionIdentity,
        request.kind,
      )
      if (current) return current === 'allow'
      let allowed = false
      try {
        allowed = await this.prompt(request)
      } catch {
        allowed = false
      }
      if ((this.extensionGenerations.get(request.extensionId) ?? 0) !== generation) {
        return false
      }
      await this.store.setDecision(
        request.extensionId,
        request.extensionIdentity,
        request.kind,
        allowed ? 'allow' : 'deny',
      )
      if ((this.extensionGenerations.get(request.extensionId) ?? 0) !== generation) {
        await this.store.revokeExtension(request.extensionId)
        return false
      }
      return allowed
    })
    this.promptQueue = promptResult.then(
      () => undefined,
      () => undefined,
    )
    this.pendingByKey.set(key, promptResult)
    const cleanUp = (): void => {
      if (this.pendingByKey.get(key) === promptResult) {
        this.pendingByKey.delete(key)
      }
    }
    void promptResult.then(cleanUp, cleanUp)
    return promptResult
  }

  revokeExtension(extensionId: string): Promise<void> {
    if (!isValidExtensionId(extensionId)) return Promise.resolve()
    const pending = this.revocationsByExtension.get(extensionId)
    if (pending) return pending
    this.extensionGenerations.set(
      extensionId,
      (this.extensionGenerations.get(extensionId) ?? 0) + 1,
    )
    const revocation = this.store.revokeExtension(extensionId)
    this.revocationsByExtension.set(extensionId, revocation)
    const cleanUp = (): void => {
      if (this.revocationsByExtension.get(extensionId) === revocation) {
        this.revocationsByExtension.delete(extensionId)
      }
    }
    void revocation.then(cleanUp, cleanUp)
    return revocation
  }
}
