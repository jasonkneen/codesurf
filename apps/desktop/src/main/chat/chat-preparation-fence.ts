export interface ChatPreparationLease {
  readonly scopeKey: string
  readonly generation: number
  readonly foregroundToken: number | null
}

/**
 * Fences asynchronous main-process request preparation. Foreground sends
 * replace every older preparation for the same tile; background sends may
 * prepare concurrently until a foreground replacement or lifecycle stop.
 */
export class ChatPreparationFence {
  private readonly generations = new Map<string, number>()
  private readonly foregroundTokens = new Map<string, number>()
  private nextForegroundToken = 0

  begin(scopeKey: string, mode: 'foreground' | 'background'): ChatPreparationLease {
    if (mode === 'foreground') {
      const generation = (this.generations.get(scopeKey) ?? 0) + 1
      const foregroundToken = ++this.nextForegroundToken
      this.generations.set(scopeKey, generation)
      this.foregroundTokens.set(scopeKey, foregroundToken)
      return { scopeKey, generation, foregroundToken }
    }

    return {
      scopeKey,
      generation: this.generations.get(scopeKey) ?? 0,
      foregroundToken: null,
    }
  }

  isCurrent(lease: ChatPreparationLease): boolean {
    if ((this.generations.get(lease.scopeKey) ?? 0) !== lease.generation) return false
    return lease.foregroundToken === null
      || this.foregroundTokens.get(lease.scopeKey) === lease.foregroundToken
  }

  invalidate(scopeKey: string): void {
    this.generations.set(scopeKey, (this.generations.get(scopeKey) ?? 0) + 1)
    this.foregroundTokens.delete(scopeKey)
  }
}
