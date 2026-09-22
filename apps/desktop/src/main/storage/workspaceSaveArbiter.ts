/**
 * Per-workspace FIFO for whole-canvas writes. BrowserWindows may issue saves
 * concurrently, but a single canvas artifact must observe one deterministic
 * arrival order. A rejected write is isolated so the next save can recover.
 */
export class WorkspaceSaveArbiter {
  private readonly tails = new Map<string, Promise<void>>()

  get activeLaneCount(): number {
    return this.tails.size
  }

  run<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(workspaceId) ?? Promise.resolve()
    const result = previous
      .catch(() => {})
      .then(operation)
    const tail = result.then(
      () => {},
      () => {},
    )
    this.tails.set(workspaceId, tail)
    void tail.then(() => {
      if (this.tails.get(workspaceId) === tail) {
        this.tails.delete(workspaceId)
      }
    })
    return result
  }
}
