// Pure resolver for the permission mode a chat turn launches with.
//
// A-PR1 #2a — stale send mode: dispatchMessageContent used to prefer
// `latestStateRef.current.mode` (the PERSISTED state) over the live React `mode`.
// That ref is repopulated in a useEffect that runs AFTER the render which changed
// the mode, so a "change mode → immediately send" sequence read the OLD mode and
// launched with it. The live `mode` value is always current, so prefer it; fall
// back to the persisted state mode, then to the provider default. Each candidate
// is validated against the active provider's mode options so a provider switch
// can't carry over an incompatible mode.
//
// Queued turns carry no per-turn mode (see QueuedChatTurn), so preferring the
// live mode is safe for queued dispatch too — there is nothing to override.
export function resolveActiveChatMode(
  liveMode: string | undefined,
  stateMode: string | undefined,
  validModeIds: readonly string[],
  fallback: string,
): string {
  for (const candidate of [liveMode, stateMode]) {
    if (candidate != null && validModeIds.includes(candidate)) return candidate
  }
  return fallback
}
