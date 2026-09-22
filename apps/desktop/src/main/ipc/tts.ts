/**
 * TTS provider router.
 *
 * Renderer calls window.electron.tts.synthesize({text, provider, voice})
 * → main routes to one of:
 *   • cartesia    — fastest (~75ms TTFB), Sonic-2 model, paid
 *   • deepgram    — Aura, conversation-tuned, paid
 *   • elevenlabs  — best quality, slowest of the three, paid
 *   • voicelab    — local proxy at http://localhost:8002 (Kokoro/Dia/Spark/etc)
 *   • say         — macOS system voice fallback (free, robotic)
 *
 * Returns audio bytes as a Uint8Array via IPC. Renderer wraps in a Blob and
 * plays via <audio> or queues into MediaSource for streaming playback.
 *
 * For sentence-by-sentence streaming, the renderer calls synthesize per
 * sentence and queues the resulting audio chunks sequentially.
 */
import { ipcMain } from 'electron'
import { spawn } from 'child_process'
import { getSecret } from '../secrets'

export type TtsProvider = 'cartesia' | 'deepgram' | 'elevenlabs' | 'voicelab' | 'say'

interface TtsArgs {
  text: string
  provider?: TtsProvider
  // Provider-specific voice id. If absent, the router uses provider's default.
  voice?: string
  // Cartesia-only: model id (default 'sonic-2').
  model?: string
  // Voice Lab base URL override (default http://127.0.0.1:8002).
  voiceLabBaseUrl?: string
  // ElevenLabs model override (default 'eleven_turbo_v2_5' for low latency).
  elevenModel?: string
  // Deepgram Aura voice override (default 'aura-2-thalia-en').
  deepgramModel?: string
}

interface TtsResult {
  ok: boolean
  audio?: Uint8Array
  mimeType?: string
  error?: string
}

const DEFAULTS = {
  cartesiaModel: 'sonic-2',
  cartesiaVoice: 'a0e99841-438c-4a64-b679-ae501e7d6091',  // "Barbershop Man" — replace with your preferred default
  deepgramModel: 'aura-2-thalia-en',
  elevenModel: 'eleven_turbo_v2_5',
  elevenVoice: '21m00Tcm4TlvDq8ikWAM',  // Rachel
  voiceLabBaseUrl: 'http://127.0.0.1:8002',
}

// ─── Cartesia (default for first launch — fastest) ───────────────────────
async function ttsCartesia(text: string, voice: string | undefined, model: string | undefined): Promise<TtsResult> {
  const apiKey = getSecret('cartesia') ?? process.env.CARTESIA_API_KEY
  if (!apiKey) return { ok: false, error: 'No Cartesia API key set.' }

  const body = {
    model_id: model || DEFAULTS.cartesiaModel,
    transcript: text,
    voice: { mode: 'id', id: voice || DEFAULTS.cartesiaVoice },
    output_format: { container: 'mp3', encoding: 'mp3', sample_rate: 44100 },
    language: 'en',
  }

  const resp = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers: {
      'X-API-Key': apiKey,
      'Cartesia-Version': '2024-11-13',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    return { ok: false, error: `Cartesia ${resp.status}: ${errText.slice(0, 300)}` }
  }
  const buf = new Uint8Array(await resp.arrayBuffer())
  return { ok: true, audio: buf, mimeType: 'audio/mpeg' }
}

// ─── Deepgram Aura ───────────────────────────────────────────────────────
async function ttsDeepgram(text: string, voice: string | undefined): Promise<TtsResult> {
  const apiKey = getSecret('deepgram') ?? process.env.DEEPGRAM_API_KEY
  if (!apiKey) return { ok: false, error: 'No Deepgram API key set.' }

  const model = voice || DEFAULTS.deepgramModel
  const url = `https://api.deepgram.com/v1/speak?model=${encodeURIComponent(model)}&encoding=mp3`

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Token ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text }),
  })

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    return { ok: false, error: `Deepgram TTS ${resp.status}: ${errText.slice(0, 300)}` }
  }
  const buf = new Uint8Array(await resp.arrayBuffer())
  return { ok: true, audio: buf, mimeType: 'audio/mpeg' }
}

// ─── ElevenLabs ──────────────────────────────────────────────────────────
async function ttsElevenLabs(text: string, voice: string | undefined, modelOverride: string | undefined): Promise<TtsResult> {
  const apiKey = getSecret('elevenlabs') ?? process.env.ELEVENLABS_API_KEY
  if (!apiKey) return { ok: false, error: 'No ElevenLabs API key set.' }

  const voiceId = voice || DEFAULTS.elevenVoice
  const modelId = modelOverride || DEFAULTS.elevenModel
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: modelId,
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  })

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    return { ok: false, error: `ElevenLabs ${resp.status}: ${errText.slice(0, 300)}` }
  }
  const buf = new Uint8Array(await resp.arrayBuffer())
  return { ok: true, audio: buf, mimeType: 'audio/mpeg' }
}

// ─── Voice Lab (local proxy) ─────────────────────────────────────────────
async function ttsVoiceLab(text: string, voice: string | undefined, model: string | undefined, baseUrl: string | undefined): Promise<TtsResult> {
  const base = (baseUrl || DEFAULTS.voiceLabBaseUrl).replace(/\/+$/, '')
  // Voice Lab speaks two endpoints we can use:
  //   /v1/audio/speech    — OpenAI-compat, simplest (returns full audio)
  //   /generate           — voice-lab native, accepts model_id + voice
  // We use /v1/audio/speech for simplicity. Voice selection is the
  // OpenAI-compat 'voice' field; model is implicit on the server.
  const body = {
    model: model || 'kokoro',   // voice-lab understands these as MODELS_BY_ID keys
    input: text,
    voice: voice || 'default',
    response_format: 'mp3',
  }
  const resp = await fetch(`${base}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    return { ok: false, error: `Voice Lab ${resp.status}: ${errText.slice(0, 300)}` }
  }
  const buf = new Uint8Array(await resp.arrayBuffer())
  return { ok: true, audio: buf, mimeType: 'audio/mpeg' }
}

// ─── macOS `say` fallback ────────────────────────────────────────────────
async function ttsSay(text: string, voice: string | undefined): Promise<TtsResult> {
  if (process.platform !== 'darwin') return { ok: false, error: 'say is macOS-only' }
  // Reject voice names that start with '-' to prevent flag injection
  if (voice && voice.startsWith('-')) return { ok: false, error: 'Invalid voice name' }
  return new Promise<TtsResult>((resolve) => {
    const args = ['-o', '/dev/stdout', '--data-format=LEF32@22050']
    if (voice) args.push('-v', voice)
    // Pass text after '--' so it cannot be mistaken for a flag
    args.push('--', text)
    const child = spawn('say', args)
    const chunks: Buffer[] = []
    child.stdout.on('data', (c: Buffer) => chunks.push(c))
    let stderr = ''
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
    child.on('error', (err) => resolve({ ok: false, error: `say: ${err.message}` }))
    child.on('close', (code) => {
      if (code !== 0) {
        resolve({ ok: false, error: `say exited ${code}: ${stderr.slice(0, 300)}` })
        return
      }
      resolve({ ok: true, audio: new Uint8Array(Buffer.concat(chunks)), mimeType: 'audio/wav' })
    })
  })
}

export function registerTtsIpc(): void {
  ipcMain.handle('tts:synthesize', async (_event, args: TtsArgs): Promise<TtsResult> => {
    const text = String(args?.text ?? '').trim()
    if (!text) return { ok: false, error: 'empty text' }
    const provider: TtsProvider = (args?.provider as TtsProvider) || 'cartesia'

    try {
      switch (provider) {
        case 'cartesia':   return await ttsCartesia(text, args.voice, args.model)
        case 'deepgram':   return await ttsDeepgram(text, args.deepgramModel || args.voice)
        case 'elevenlabs': return await ttsElevenLabs(text, args.voice, args.elevenModel)
        case 'voicelab':   return await ttsVoiceLab(text, args.voice, args.model, args.voiceLabBaseUrl)
        case 'say':        return await ttsSay(text, args.voice)
        default:           return { ok: false, error: `Unknown TTS provider: ${provider}` }
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
