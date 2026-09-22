export async function requestHostMicrophoneAccess(): Promise<void> {
  const request = window.electron?.system?.requestMediaAccess
  if (typeof request !== 'function') return
  const result = await request({ kind: 'microphone' })
  if (result && result.granted === false) {
    throw new DOMException('Permission denied', 'NotAllowedError')
  }
}

/** Map getUserMedia / VAD failures to a short composer-facing sentence. */
export function describeMicrophoneError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : ''
  const message = err instanceof Error ? err.message : String(err)
  const combined = `${name} ${message}`.toLowerCase()
  if (
    name === 'NotAllowedError'
    || name === 'SecurityError'
    || combined.includes('permission denied')
    || combined.includes('not allowed')
  ) {
    return 'Microphone blocked. Click the mic to retry, or allow it in System Settings.'
  }
  if (name === 'NotFoundError' || combined.includes('not found') || combined.includes('no device')) {
    return 'No microphone found'
  }
  if (name === 'NotReadableError' || combined.includes('could not start') || combined.includes('in use')) {
    return 'Microphone is already in use'
  }
  if (name === 'AbortError') return 'Microphone request was cancelled'
  const trimmed = message.trim()
  return trimmed || 'Microphone failed'
}
