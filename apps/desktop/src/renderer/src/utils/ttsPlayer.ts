/**
 * TTS audio queue player.
 *
 * Sentence-by-sentence playback machinery. Each sentence's audio Blob is
 * enqueued; the player walks the queue in order, plays one clip at a time,
 * and emits state events so the UI can highlight which message/sentence is
 * currently speaking.
 *
 * Barge-in: `stop()` halts the current clip and clears the pending queue.
 * Voice-initiated barge-in (mic activity) calls this; user typing does not.
 *
 * Per-message tracking: each enqueued clip carries a `messageId` so the UI
 * can render a "currently playing" indicator on the right bubble. The
 * player exposes `currentMessageId` via subscription.
 */

export interface TtsClip {
  messageId: string
  /** Sentence index inside the message, 0-based. Lets the UI highlight a
   *  specific sentence within a long message if it wants to. */
  sentenceIndex: number
  audio: Uint8Array
  mimeType: string
}

export interface TtsPlayerState {
  isPlaying: boolean
  currentMessageId: string | null
  queueLength: number
}

type Listener = (state: TtsPlayerState) => void

export class TtsPlayer {
  private queue: TtsClip[] = []
  private currentAudio: HTMLAudioElement | null = null
  private currentBlobUrl: string | null = null
  private currentMessageId: string | null = null
  private listeners = new Set<Listener>()

  enqueue(clip: TtsClip): void {
    this.queue.push(clip)
    this.notify()
    if (!this.currentAudio) void this.playNext()
  }

  /** Stop current clip and clear pending queue. Used by barge-in and
   *  by manual stop on a per-message speak button. */
  stop(): void {
    if (this.currentAudio) {
      try { this.currentAudio.pause() } catch { /* ignore */ }
      this.currentAudio.src = ''
      this.currentAudio = null
    }
    if (this.currentBlobUrl) {
      try { URL.revokeObjectURL(this.currentBlobUrl) } catch { /* ignore */ }
      this.currentBlobUrl = null
    }
    this.queue = []
    this.currentMessageId = null
    this.notify()
  }

  /** Stop all playback for a specific message id (without affecting other
   *  messages still in queue). Useful when the user re-clicks a message's
   *  speak button to cancel just that one. */
  stopMessage(messageId: string): void {
    if (this.currentMessageId === messageId) {
      // Stop current clip
      if (this.currentAudio) {
        try { this.currentAudio.pause() } catch { /* ignore */ }
        this.currentAudio.src = ''
        this.currentAudio = null
      }
      if (this.currentBlobUrl) {
        try { URL.revokeObjectURL(this.currentBlobUrl) } catch { /* ignore */ }
        this.currentBlobUrl = null
      }
      this.currentMessageId = null
    }
    // Drop pending clips for this message id
    this.queue = this.queue.filter(c => c.messageId !== messageId)
    this.notify()
    // If the current message stopped but other messages remain, kick playback
    if (!this.currentAudio && this.queue.length > 0) void this.playNext()
  }

  get state(): TtsPlayerState {
    return {
      isPlaying: this.currentAudio !== null,
      currentMessageId: this.currentMessageId,
      queueLength: this.queue.length,
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.state)
    return () => { this.listeners.delete(listener) }
  }

  private notify(): void {
    const s = this.state
    for (const l of this.listeners) {
      try { l(s) } catch { /* ignore */ }
    }
  }

  private async playNext(): Promise<void> {
    const next = this.queue.shift()
    if (!next) {
      this.currentMessageId = null
      this.notify()
      return
    }
    this.currentMessageId = next.messageId
    // The DOM Blob ctor's stricter types want a fresh ArrayBuffer view —
    // wrap the Uint8Array's backing buffer slice to satisfy BlobPart.
    const arrayBuf = next.audio.buffer.slice(next.audio.byteOffset, next.audio.byteOffset + next.audio.byteLength) as ArrayBuffer
    const blob = new Blob([arrayBuf], { type: next.mimeType })
    const url = URL.createObjectURL(blob)
    this.currentBlobUrl = url
    const audio = new Audio(url)
    this.currentAudio = audio
    this.notify()

    audio.onended = () => {
      audio.src = ''
      try { URL.revokeObjectURL(url) } catch { /* ignore */ }
      if (this.currentBlobUrl === url) this.currentBlobUrl = null
      this.currentAudio = null
      void this.playNext()
    }
    audio.onerror = () => {
      // eslint-disable-next-line no-console
      console.warn('[ttsPlayer] audio error, skipping clip')
      audio.src = ''
      try { URL.revokeObjectURL(url) } catch { /* ignore */ }
      if (this.currentBlobUrl === url) this.currentBlobUrl = null
      this.currentAudio = null
      void this.playNext()
    }

    try {
      await audio.play()
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[ttsPlayer] play() rejected:', err)
      audio.onerror?.(new Event('error'))
    }
  }
}

// Singleton — there's only one audio output on the main thread anyway,
// and we want barge-in and per-message tracking to be globally coherent.
export const ttsPlayer = new TtsPlayer()
