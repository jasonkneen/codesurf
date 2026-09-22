export type WorkspaceSwitchToken = {
  generation: number
}

export type WorkspaceSwitchFreshness = () => boolean

export type WorkspaceOwnerRef = {
  current: string | null
}

/**
 * Loads may overlap, but only the newest requested workspace may commit UI or
 * persisted active-workspace state. Commits run in one lane so an older
 * setActive call cannot finish after and overwrite a newer one.
 */
export class LatestWorkspaceSwitchCoordinator {
  private generation = 0
  private commitTail: Promise<void> = Promise.resolve()

  begin(): WorkspaceSwitchToken {
    this.generation += 1
    return { generation: this.generation }
  }

  isCurrent(token: WorkspaceSwitchToken): boolean {
    return token.generation === this.generation
  }

  async commitLatest(
    token: WorkspaceSwitchToken,
    commit: (isCurrent: WorkspaceSwitchFreshness) => void | Promise<void>,
  ): Promise<boolean> {
    let committed = false
    const operation = this.commitTail
      .catch(() => {})
      .then(async () => {
        if (!this.isCurrent(token)) return
        await commit(() => this.isCurrent(token))
        committed = this.isCurrent(token)
      })
    this.commitTail = operation.catch(() => {})
    await operation
    return committed
  }
}

export function commitWorkspaceCanvasOwnership(
  workspaceId: string | null,
  currentWorkspaceIdRef: WorkspaceOwnerRef,
  transferCanvasOwnership: (workspaceId: string | null) => void,
  applyAuthoritativeState: () => void,
): void {
  // Transfer both persistence identities in the same synchronous commit lane
  // before any incoming refs are applied. Lifecycle IPC cannot interleave this
  // call stack, so its next challenge observes one complete ownership state.
  currentWorkspaceIdRef.current = workspaceId
  transferCanvasOwnership(workspaceId)
  applyAuthoritativeState()
}

export async function transitionToWorkspacePicker(options: {
  coordinator: LatestWorkspaceSwitchCoordinator
  outgoingWorkspaceId: string | null
  flushOutgoing: (workspaceId: string) => Promise<void>
  commitPicker: () => void | Promise<void>
  onFlushError?: (workspaceId: string, error: unknown) => void
}): Promise<boolean> {
  const {
    coordinator,
    outgoingWorkspaceId,
    flushOutgoing,
    commitPicker,
    onFlushError = () => {},
  } = options
  const token = coordinator.begin()
  if (outgoingWorkspaceId) {
    try {
      await flushOutgoing(outgoingWorkspaceId)
    } catch (error) {
      onFlushError(outgoingWorkspaceId, error)
    }
  }
  return coordinator.commitLatest(token, async isCurrent => {
    if (!isCurrent()) return
    await commitPicker()
  })
}
