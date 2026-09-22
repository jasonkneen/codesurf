export type DaemonJobActivityKind = 'foreground' | 'background'

export interface ActiveDaemonJob<Host> {
  readonly scopeKey: string
  readonly jobId: string
  readonly host: Host
  readonly kind: DaemonJobActivityKind
  readonly abortController: AbortController
  readonly done: Promise<void>
}

/** Job-id-indexed ownership for every daemon activity attached to a card. */
export class DaemonJobRegistry<Host> {
  private readonly scopes = new Map<string, Map<string, ActiveDaemonJob<Host>>>()
  private readonly settle = new WeakMap<ActiveDaemonJob<Host>, () => void>()

  register(
    scopeKey: string,
    jobId: string,
    host: Host,
    kind: DaemonJobActivityKind,
  ): ActiveDaemonJob<Host> {
    let resolveDone!: () => void
    const done = new Promise<void>(resolve => { resolveDone = resolve })
    const activity: ActiveDaemonJob<Host> = {
      scopeKey,
      jobId,
      host,
      kind,
      abortController: new AbortController(),
      done,
    }
    let jobs = this.scopes.get(scopeKey)
    if (!jobs) {
      jobs = new Map()
      this.scopes.set(scopeKey, jobs)
    }
    const replaced = jobs.get(jobId)
    if (replaced) {
      replaced.abortController.abort()
      this.complete(replaced)
      jobs = this.scopes.get(scopeKey) ?? new Map()
      this.scopes.set(scopeKey, jobs)
    }
    jobs.set(jobId, activity)
    this.settle.set(activity, resolveDone)
    return activity
  }

  isActive(activity: ActiveDaemonJob<Host>): boolean {
    return this.scopes.get(activity.scopeKey)?.get(activity.jobId) === activity
  }

  complete(activity: ActiveDaemonJob<Host>): boolean {
    const jobs = this.scopes.get(activity.scopeKey)
    const owned = jobs?.get(activity.jobId) === activity
    if (owned) {
      jobs.delete(activity.jobId)
      if (jobs.size === 0) this.scopes.delete(activity.scopeKey)
    }
    this.settle.get(activity)?.()
    this.settle.delete(activity)
    return owned
  }

  takeAll(scopeKey: string): ActiveDaemonJob<Host>[] {
    const jobs = this.scopes.get(scopeKey)
    if (!jobs) return []
    const activities = [...jobs.values()]
    this.scopes.delete(scopeKey)
    for (const activity of activities) activity.abortController.abort()
    return activities
  }

  async cancelAll(
    scopeKey: string,
    cancel: (activity: ActiveDaemonJob<Host>) => Promise<void>,
  ): Promise<ActiveDaemonJob<Host>[]> {
    const activities = this.takeAll(scopeKey)
    await Promise.all(activities.map(cancel))
    await Promise.all(activities.map(activity => activity.done))
    return activities
  }

  latest(scopeKey: string, kind?: DaemonJobActivityKind): ActiveDaemonJob<Host> | null {
    const jobs = this.scopes.get(scopeKey)
    if (!jobs) return null
    const activities = [...jobs.values()]
    for (let index = activities.length - 1; index >= 0; index -= 1) {
      if (!kind || activities[index]?.kind === kind) return activities[index] ?? null
    }
    return null
  }

  list(scopeKey: string): ActiveDaemonJob<Host>[] {
    return [...(this.scopes.get(scopeKey)?.values() ?? [])]
  }
}
