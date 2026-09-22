/**
 * useVoiceActivityDetector — Silero VAD wrapper for hands-free dictation.
 *
 * Backend: @ricky0123/vad-web (Silero VAD as ONNX in WebAssembly).
 *   start() opens mic + VAD. onSpeechStart fires when speech begins;
 *   onSpeechEnd fires with the captured Float32 PCM when the user pauses.
 *   stop() releases the mic and tears down VAD.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { describeMicrophoneError, requestHostMicrophoneAccess } from '../lib/microphoneError'

interface UseVadOptions {
  onSpeechStart?: () => void
  onSpeechEnd?: (audio: Float32Array) => void
  onMisfire?: () => void
  positiveSpeechThreshold?: number
  negativeSpeechThreshold?: number
  redemptionFrames?: number
  baseAssetPath?: string
}

interface UseVadResult {
  isListening: boolean
  isSpeaking: boolean
  error: string | null
  start: () => Promise<void>
  stop: () => Promise<void>
  clearError: () => void
}

type MicVAD = { start: () => void | Promise<void>; pause: () => void | Promise<void>; destroy: () => void | Promise<void> }

const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    channelCount: 1,
    echoCancellation: true,
    autoGainControl: true,
    noiseSuppression: true,
  },
}

function stopTracks(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach(track => {
    try { track.stop() } catch { /* already stopped */ }
  })
}

function getDefaultVadAssetPath(): string {
  if (typeof window === 'undefined') return './vad/'
  if (window.location.protocol === 'file:') return new URL('./vad/', window.location.href).href
  return new URL('/vad/', window.location.origin).href
}

export function useVoiceActivityDetector(opts: UseVadOptions = {}): UseVadResult {
  const [isListening, setIsListening] = useState(false)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const vadRef = useRef<MicVAD | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const startingRef = useRef(false)
  const optsRef = useRef(opts)
  optsRef.current = opts

  const start = useCallback(async () => {
    if (vadRef.current || startingRef.current) return
    startingRef.current = true
    setError(null)
    // Open the mic (and AudioContext) in the same turn as the click/space
    // gesture. MicVAD.new() first loads ONNX/WASM, which expires Chromium's
    // transient user activation and otherwise fails with "Permission denied".
    let stream: MediaStream | null = null
    let audioContext: AudioContext | null = null
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Microphone is not available in this window')
      }
      await requestHostMicrophoneAccess()
      audioContext = new AudioContext()
      audioContextRef.current = audioContext
      stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS)
      if (audioContext.state === 'suspended') await audioContext.resume()
      const ownedStream = stream
      const mod = await import('@ricky0123/vad-web')
      const MicVAD = (mod as { MicVAD: { new: (cfg: Record<string, unknown>) => Promise<MicVAD> } }).MicVAD
      // Bundled assets live in renderer/public/vad/ so production builds
      // don't depend on CDN reachability. Use an app-root URL in dev because
      // onnxruntime resolves relative wasmPaths from its optimized dependency
      // module, not from the page.
      const baseAssetPath = optsRef.current.baseAssetPath ?? getDefaultVadAssetPath()
      const vad = await MicVAD.new({
        positiveSpeechThreshold: optsRef.current.positiveSpeechThreshold ?? 0.5,
        negativeSpeechThreshold: optsRef.current.negativeSpeechThreshold ?? 0.35,
        redemptionFrames: optsRef.current.redemptionFrames ?? 24,
        baseAssetPath,
        onnxWASMBasePath: baseAssetPath,
        model: 'v5',
        audioContext,
        startOnLoad: true,
        getStream: async () => ownedStream,
        pauseStream: async (active: MediaStream) => { stopTracks(active) },
        resumeStream: async () => navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS),
        onSpeechStart: () => { setIsSpeaking(true); optsRef.current.onSpeechStart?.() },
        onSpeechEnd: (audio: Float32Array) => { setIsSpeaking(false); optsRef.current.onSpeechEnd?.(audio) },
        onVADMisfire: () => { setIsSpeaking(false); optsRef.current.onMisfire?.() },
      })
      stream = null
      audioContext = null
      vadRef.current = vad
      setIsListening(true)
      setError(null)
    } catch (err) {
      stopTracks(stream)
      if (audioContext) {
        try { await audioContext.close() } catch { /* ignore */ }
        if (audioContextRef.current === audioContext) audioContextRef.current = null
      }
      setError(describeMicrophoneError(err))
      setIsListening(false)
    } finally {
      startingRef.current = false
    }
  }, [])

  const stop = useCallback(async () => {
    const v = vadRef.current
    vadRef.current = null
    if (v) {
      try { await v.pause() } catch { /* ignore */ }
      try { await v.destroy() } catch { /* ignore */ }
    }
    const ctx = audioContextRef.current
    audioContextRef.current = null
    if (ctx) {
      try { await ctx.close() } catch { /* ignore */ }
    }
    setIsListening(false)
    setIsSpeaking(false)
  }, [])

  useEffect(() => () => { void stop() }, [stop])

  const clearError = useCallback(() => setError(null), [])

  return { isListening, isSpeaking, error, start, stop, clearError }
}

/** Encode Float32 mono 16kHz PCM as a WAV ArrayBuffer for STT upload. */
export function float32ToWav(samples: Float32Array, sampleRate = 16000): ArrayBuffer {
  const dataSize = samples.length * 2
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  const writeString = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
  }
  writeString(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeString(36, 'data')
  view.setUint32(40, dataSize, true)
  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    let s = Math.max(-1, Math.min(1, samples[i]))
    s = s < 0 ? s * 0x8000 : s * 0x7fff
    view.setInt16(offset, s, true)
    offset += 2
  }
  return buffer
}
