/**
 * useAutoSpeak — orchestrates spokify+TTS for the most recent assistant message.
 *
 * Behavior:
 *   • When `enabled` and the latest assistant message changes (id changes
 *     OR the agent stream completes for it), spokify the message and
 *     pipeline-feed the result through the TTS provider one sentence at a time.
 *   • Per sentence: spokify(sentence) → tts(spokenText) → enqueue clip.
 *   • Sentences play in order via the singleton TtsPlayer.
 *   • Re-running for the same messageId no-ops (handled by caching here).
 *
 * Used by ChatTile in "auto-speak last-message-only" mode.
 *
 * Companion utility `speakMessage(...)` exposes the same pipeline as a
 * one-shot for the per-message Speak button, with optional `force=true`
 * to re-speak even if cached.
 */
import { useEffect, useRef } from 'react'
import { SentenceStream } from '../utils/sentenceStream'
import { ttsPlayer } from '../utils/ttsPlayer'

export interface SpeakOptions {
  messageId: string
  text: string
  ttsProvider?: 'cartesia' | 'deepgram' | 'elevenlabs' | 'voicelab' | 'say'
  ttsVoice?: string
  spokifyModel?: string
  force?: boolean
}

const speakInFlight = new Set<string>()
const spokeAlready = new Set<string>()

export async function speakMessage(opts: SpeakOptions): Promise<void> {
  const { messageId, text, ttsProvider = 'cartesia', ttsVoice, spokifyModel, force = false } = opts
  if (!text?.trim()) return
  if (speakInFlight.has(messageId)) return
  if (!force && spokeAlready.has(messageId)) return

  speakInFlight.add(messageId)
  try {
    const chunker = new SentenceStream()
    chunker.feed(text)
    const sentences = [...chunker.feed(''), ...chunker.finish()]

    // Parallel pipeline: kick off spokify+TTS for every sentence at once,
    // but enqueue audio in original sentence order. First-byte latency is
    // bounded by the slowest pipeline of the FIRST sentence, not the sum
    // of all. Subsequent sentences arrive while the player is still
    // playing earlier ones — perceived as continuous speech.
    const pipelinePromises: Promise<{ index: number; audio: Uint8Array; mimeType: string } | null>[] = sentences.map(
      async (chunk, index) => {
        const spokifyResp = await window.electron.spokify.run({ text: chunk.text, model: spokifyModel })
        if (!spokifyResp.ok || !spokifyResp.text) return null
        const spoken = spokifyResp.text.trim()
        if (!spoken) return null
        const ttsResp = await window.electron.tts.synthesize({
          text: spoken,
          provider: ttsProvider,
          voice: ttsVoice,
        })
        if (!ttsResp.ok || !ttsResp.audio || !ttsResp.mimeType) {
          // eslint-disable-next-line no-console
          console.warn('[autoSpeak] tts failed for sentence:', ttsResp.error, '— skipping')
          return null
        }
        return { index, audio: ttsResp.audio, mimeType: ttsResp.mimeType }
      },
    )

    // Walk results in order; await each before enqueueing so playback is
    // strictly sequential even if later sentences finished synthesizing first.
    for (let i = 0; i < pipelinePromises.length; i++) {
      const result = await pipelinePromises[i]
      if (!result) continue
      ttsPlayer.enqueue({
        messageId,
        sentenceIndex: result.index,
        audio: result.audio,
        mimeType: result.mimeType,
      })
    }
    spokeAlready.add(messageId)
  } finally {
    speakInFlight.delete(messageId)
  }
}

interface UseAutoSpeakArgs {
  enabled: boolean
  messageId: string | null
  text: string | null
  ttsProvider?: SpeakOptions['ttsProvider']
  ttsVoice?: string
  spokifyModel?: string
  /** When true, the agent is still streaming this message. We wait. */
  isStreaming: boolean
}

export function useAutoSpeak(args: UseAutoSpeakArgs): void {
  const { enabled, messageId, text, ttsProvider, ttsVoice, spokifyModel, isStreaming } = args
  const lastSpokenIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (!enabled) return
    if (!messageId || !text) return
    if (isStreaming) return                              // wait for completion
    if (lastSpokenIdRef.current === messageId) return    // already kicked off
    lastSpokenIdRef.current = messageId
    void speakMessage({ messageId, text, ttsProvider, ttsVoice, spokifyModel })
  }, [enabled, messageId, text, isStreaming, ttsProvider, ttsVoice, spokifyModel])
}

/** Called by mic-activation paths to enforce voice-only barge-in. */
export function bargeIn(): void {
  ttsPlayer.stop()
}
