/**
 * Generation fence for async local-proxy startup and response callbacks.
 * Tokens are process-unique, maps are cleared on terminal/stop, and an older
 * turn can never become current again after replacement.
 */
export class LocalProxyTurnFence {
  private readonly active = new Map<string, number>()
  private nextToken = 0

  begin(scopeKey: string): number {
    const token = ++this.nextToken
    this.active.set(scopeKey, token)
    return token
  }

  isCurrent(scopeKey: string, token: number): boolean {
    return this.active.get(scopeKey) === token
  }

  finish(scopeKey: string, token: number): boolean {
    if (!this.isCurrent(scopeKey, token)) return false
    this.active.delete(scopeKey)
    return true
  }

  invalidate(scopeKey: string): void {
    this.active.delete(scopeKey)
  }
}
