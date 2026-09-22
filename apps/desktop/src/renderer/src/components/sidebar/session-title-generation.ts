export type SessionTitleGenerationState = Record<string, true>

export interface SessionTitleGenerationIndicator {
  menuLabel: string
  rowMeta: string
  rowTitleSuffix: string
}

export function getSessionTitleGenerationKey(workspaceId: string, sessionEntryId: string): string {
  return `${workspaceId}::${sessionEntryId}`
}

export function updateSessionTitleGenerationState(
  state: SessionTitleGenerationState,
  key: string,
  generating: boolean,
): SessionTitleGenerationState {
  if (!key) return state
  if (generating) {
    if (state[key] === true) return state
    return { ...state, [key]: true }
  }

  if (state[key] !== true) return state
  const next = { ...state }
  delete next[key]
  return next
}

export function getSessionTitleGenerationIndicator(
  generating: boolean,
  currentMeta = '',
): SessionTitleGenerationIndicator {
  const meta = currentMeta.trim()
  if (!generating) {
    return {
      menuLabel: 'Generate Title',
      rowMeta: meta,
      rowTitleSuffix: '',
    }
  }

  return {
    menuLabel: 'Generating Title…',
    rowMeta: meta ? `Generating title… • ${meta}` : 'Generating title…',
    rowTitleSuffix: '\nGenerating title…',
  }
}
