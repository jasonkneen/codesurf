import { useState, useRef, useEffect, useCallback } from 'react'
import { useVoiceActivityDetector, float32ToWav } from './useVoiceActivityDetector'
import { bargeIn } from './useAutoSpeak'

interface VoiceSettings {
  sttProvider?: string
  sttLang?: string
  sttLocalBaseUrl?: string
  ttsProvider?: string
  ttsVoice?: string
  spokifyModel?: string
  autoSpeak?: string
  bargeIn?: boolean
}

interface UseChatDictationOptions {
  voiceSettings: VoiceSettings
}

interface UseChatDictationResult {
  isDictating: boolean
  dictationText: string
  dictationError: string | null
  toggleDictation: () => void
  clearDictationError: () => void
  /** Register a handler to receive transcribed text from each utterance. */
  onTranscription: (handler: (text: string) => void) => void
}

export function useChatDictation({ voiceSettings }: UseChatDictationOptions): UseChatDictationResult {
  const [isDictating, setIsDictating] = useState(false)
  const [dictationText, setDictationText] = useState('')
  const [dictationError, setDictationError] = useState<string | null>(null)
  const transcribeJobRef = useRef(0)
  const voiceSettingsRef = useRef(voiceSettings)
  voiceSettingsRef.current = voiceSettings
  const onTranscriptionRef = useRef<((text: string) => void) | null>(null)

  const vad = useVoiceActivityDetector({
    onSpeechStart: () => {
      // Voice-initiated barge-in: speaking interrupts the AI talking.
      bargeIn()
    },
    onSpeechEnd: async (audio) => {
      const v = voiceSettingsRef.current
      const jobId = ++transcribeJobRef.current
      try {
        const wav = float32ToWav(audio, 16000)
        const result = await (window as any).electron.transcribe.run({
          audio: wav,
          mimeType: 'audio/wav',
          provider: v.sttProvider ?? 'deepgram',
          lang: v.sttLang ?? 'en',
          localBaseUrl: v.sttLocalBaseUrl,
        })
        if (jobId !== transcribeJobRef.current) return  // stale; user moved on
        if (result.ok && result.text) {
          onTranscriptionRef.current?.(result.text)
          setDictationError(null)
        } else if (result.error) {
          // eslint-disable-next-line no-console
          console.warn('[dictation] transcribe error:', result.error)
          setDictationError(result.error)
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[dictation] transcribe pipeline failed:', err)
        setDictationError(err instanceof Error ? err.message : String(err))
      }
    },
  })

  // Reflect the VAD lifecycle into isDictating / dictationText state so the
  // indicator UI doesn't need to know which engine is driving it.
  useEffect(() => {
    setIsDictating(vad.isListening)
    if (!vad.isListening) setDictationText('')
    else if (vad.isSpeaking) setDictationText('Listening — speaking…')
    else setDictationText('Listening — say something')
  }, [vad.isListening, vad.isSpeaking])

  useEffect(() => {
    if (vad.error) setDictationError(vad.error)
  }, [vad.error])

  // Click mic / hold space toggles VAD listening mode (not single-shot
  // recording). Holding space briefly is functionally equivalent to a
  // click — both flip listening on or off.
  const toggleDictation = useCallback(() => {
    if (vad.isListening) {
      void vad.stop()
    } else {
      setDictationError(null)
      bargeIn()  // any active TTS audio is silenced when we start listening
      void vad.start()
    }
  }, [vad])

  const clearDictationError = useCallback(() => {
    vad.clearError()
    setDictationError(null)
  }, [vad])

  const onTranscription = useCallback((handler: (text: string) => void) => {
    onTranscriptionRef.current = handler
  }, [])

  return { isDictating, dictationText, dictationError, toggleDictation, clearDictationError, onTranscription }
}
