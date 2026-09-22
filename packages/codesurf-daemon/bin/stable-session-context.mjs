import { createHash } from 'node:crypto'

export const MAX_STABLE_SESSION_CONTEXTS = 256

function normalizedText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizedSessionId(value) {
  return normalizedText(value) || null
}

function contextHash(contextPrompt) {
  return createHash('sha256').update(contextPrompt, 'utf8').digest('hex')
}

function stableContextKey(input) {
  return JSON.stringify([
    normalizedText(input.workspaceId),
    normalizedText(input.cardId),
    normalizedText(input.provider),
  ])
}

/**
 * Process-local install ledger for providers that carry stable host context in
 * a user turn. Selection never commits; a provider must prove acceptance and
 * return a real session id before later turns can omit the same context hash.
 */
export class StableSessionContextCache {
  #entries = new Map()
  #latestSelections = new Map()
  #generation = 0
  #maxEntries

  constructor(maxEntries = MAX_STABLE_SESSION_CONTEXTS) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new Error('Stable session context cache size must be a positive integer')
    }
    this.#maxEntries = maxEntries
  }

  select(input) {
    const cacheKey = stableContextKey(input)
    const provider = normalizedText(input.provider)
    const sessionId = normalizedSessionId(input.sessionId)
    const prompt = normalizedText(input.contextPrompt)
    const hash = contextHash(prompt)
    const current = this.#entries.get(cacheKey)
    const installsContext = !current
      || sessionId === null
      || current.sessionId !== sessionId
      || current.contextHash !== hash
    const generation = ++this.#generation

    if (current && !installsContext) {
      this.#entries.delete(cacheKey)
      this.#entries.set(cacheKey, current)
    }
    this.#latestSelections.delete(cacheKey)
    this.#latestSelections.set(cacheKey, generation)
    this.#evictOldest(this.#latestSelections)

    return Object.freeze({
      cacheKey,
      provider,
      generation,
      sessionId,
      contextHash: hash,
      installsContext,
      contextPrompt: installsContext && prompt ? prompt : undefined,
    })
  }

  complete(selection, completion) {
    if (!completion.accepted) {
      this.invalidate(selection)
      return false
    }
    const sessionId = normalizedSessionId(completion.sessionId)
    if (!sessionId) {
      this.invalidate(selection)
      return false
    }
    if (this.#latestSelections.get(selection.cacheKey) !== selection.generation) return false

    const current = this.#entries.get(selection.cacheKey)
    if (!selection.installsContext) {
      const unchanged = current?.sessionId === sessionId
        && current.contextHash === selection.contextHash
      if (!unchanged) {
        this.invalidate(selection)
        return false
      }
      this.#entries.delete(selection.cacheKey)
      this.#entries.set(selection.cacheKey, current)
      return true
    }

    this.#entries.delete(selection.cacheKey)
    this.#entries.set(selection.cacheKey, {
      provider: selection.provider,
      sessionId,
      contextHash: selection.contextHash,
    })
    this.#evictOldest(this.#entries)
    return true
  }

  completeCli(selection, completion) {
    return this.complete(selection, {
      accepted: completion.exitCode === 0
        && completion.sawProviderAcceptance === true
        && completion.providerError !== true,
      sessionId: completion.sessionId,
    })
  }

  invalidate(selection) {
    if (this.#latestSelections.get(selection.cacheKey) === selection.generation) {
      this.#latestSelections.delete(selection.cacheKey)
    }
  }

  #evictOldest(cache) {
    while (cache.size > this.#maxEntries) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) return
      cache.delete(oldest)
    }
  }
}

export class StableContextAnnouncementCache {
  #entries = new Map()
  #maxEntries

  constructor(maxEntries = MAX_STABLE_SESSION_CONTEXTS) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new Error('Stable context announcement cache size must be a positive integer')
    }
    this.#maxEntries = maxEntries
  }

  consume(input = {}) {
    const content = normalizedText(input.content)
    if (!content) return false
    const key = JSON.stringify([
      normalizedText(input.workspaceId),
      normalizedText(input.cardId),
      normalizedText(input.kind),
    ])
    const hash = contextHash(content)
    const sessionId = normalizedSessionId(input.sessionId)
    const current = this.#entries.get(key)
    if (current && current.hash === hash) {
      if (!current.sessionId || !sessionId || current.sessionId === sessionId) {
        if (sessionId && current.sessionId !== sessionId) {
          this.#entries.delete(key)
          this.#entries.set(key, { hash, sessionId })
        }
        return false
      }
    }
    this.#entries.delete(key)
    this.#entries.set(key, { hash, sessionId })
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value
      if (oldest === undefined) return true
      this.#entries.delete(oldest)
    }
    return true
  }

  clear(workspaceId, cardId) {
    const workspace = normalizedText(workspaceId)
    const card = normalizedText(cardId)
    for (const key of [...this.#entries.keys()]) {
      const parsed = JSON.parse(key)
      if (parsed[0] === workspace && parsed[1] === card) this.#entries.delete(key)
    }
  }
}
