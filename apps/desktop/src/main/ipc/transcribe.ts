/**
 * STT provider router.
 *
 * Renderer captures audio with MediaRecorder, then calls
 * window.electron.transcribe.run({audio, mimeType, provider, lang}) →
 * main routes to one of:
 *   • openai      — Whisper-1 (REST file upload)
 *   • deepgram    — Nova-2 (REST raw bytes)
 *   • assemblyai  — Universal-2 (upload + poll)
 *   • local       — OpenAI-compat at user-configured URL
 *
 * Returns the final transcript string. No streaming yet — sentence-level
 * fidelity from a 5-30 second clip is fine for tap-to-talk dictation.
 */
import { ipcMain } from 'electron'
import { getSecret } from '../secrets'

export type SttProvider = 'openai' | 'deepgram' | 'assemblyai' | 'local'

interface TranscribeArgs {
  audio: ArrayBuffer | Uint8Array
  mimeType: string         // e.g. 'audio/webm;codecs=opus'
  provider?: SttProvider
  lang?: string            // BCP-47, e.g. 'en'
  localBaseUrl?: string    // for 'local' provider
  openaiModel?: string     // default 'whisper-1', could be 'gpt-4o-transcribe'
  deepgramModel?: string   // default 'nova-2'
}

interface TranscribeResult {
  ok: boolean
  text?: string
  error?: string
}

const DEFAULTS = {
  openaiModel: 'whisper-1',
  deepgramModel: 'nova-2',
  localBaseUrl: 'http://127.0.0.1:8011',
  lang: 'en',
}

function toBuffer(audio: ArrayBuffer | Uint8Array): Buffer {
  if (audio instanceof Uint8Array) return Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength)
  return Buffer.from(audio)
}

function mimeToFilename(mime: string): string {
  if (mime.includes('webm')) return 'audio.webm'
  if (mime.includes('ogg')) return 'audio.ogg'
  if (mime.includes('mp4') || mime.includes('m4a')) return 'audio.m4a'
  if (mime.includes('wav')) return 'audio.wav'
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'audio.mp3'
  return 'audio.webm'
}

// ─── OpenAI Whisper (REST) ───────────────────────────────────────────────
async function sttOpenAI(audio: Buffer, mimeType: string, lang: string, model: string): Promise<TranscribeResult> {
  const apiKey = getSecret('openai') ?? process.env.OPENAI_API_KEY
  if (!apiKey) return { ok: false, error: 'No OpenAI API key set.' }

  const form = new FormData()
  const blob = new Blob([new Uint8Array(audio)], { type: mimeType })
  form.append('file', blob, mimeToFilename(mimeType))
  form.append('model', model)
  if (lang) form.append('language', lang)
  form.append('response_format', 'json')

  const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: form,
  })

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    return { ok: false, error: `OpenAI Whisper ${resp.status}: ${errText.slice(0, 300)}` }
  }
  const data = await resp.json() as { text?: string }
  return { ok: true, text: (data.text ?? '').trim() }
}

// ─── Deepgram Nova-2 (REST raw bytes) ────────────────────────────────────
async function sttDeepgram(audio: Buffer, mimeType: string, lang: string, model: string): Promise<TranscribeResult> {
  const apiKey = getSecret('deepgram') ?? process.env.DEEPGRAM_API_KEY
  if (!apiKey) return { ok: false, error: 'No Deepgram API key set.' }

  const params = new URLSearchParams({
    model,
    smart_format: 'true',
    punctuate: 'true',
    language: lang || 'en',
  })
  const resp = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: 'POST',
    headers: {
      'Authorization': `Token ${apiKey}`,
      'Content-Type': mimeType,
    },
    body: new Uint8Array(audio),
  })

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    return { ok: false, error: `Deepgram ${resp.status}: ${errText.slice(0, 300)}` }
  }
  const data = await resp.json() as {
    results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> }
  }
  const transcript = data.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? ''
  return { ok: true, text: transcript.trim() }
}

// ─── AssemblyAI Universal-2 (upload + poll) ──────────────────────────────
async function sttAssemblyAI(audio: Buffer, _mimeType: string, lang: string): Promise<TranscribeResult> {
  const apiKey = getSecret('assemblyai') ?? process.env.ASSEMBLYAI_API_KEY
  if (!apiKey) return { ok: false, error: 'No AssemblyAI API key set.' }

  // 1. Upload raw audio
  const uploadResp = await fetch('https://api.assemblyai.com/v2/upload', {
    method: 'POST',
    headers: {
      'Authorization': apiKey,
      'Content-Type': 'application/octet-stream',
    },
    body: new Uint8Array(audio),
  })
  if (!uploadResp.ok) {
    const errText = await uploadResp.text().catch(() => '')
    return { ok: false, error: `AssemblyAI upload ${uploadResp.status}: ${errText.slice(0, 300)}` }
  }
  const { upload_url } = await uploadResp.json() as { upload_url: string }

  // 2. Submit transcription
  const submitResp = await fetch('https://api.assemblyai.com/v2/transcript', {
    method: 'POST',
    headers: {
      'Authorization': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      audio_url: upload_url,
      language_code: lang || 'en',
      // AssemblyAI deprecated `speech_model` (singular). New API uses
      // `speech_models` (plural array, priority order). Recommended pair
      // gives universal-3-pro for supported languages with universal-2
      // fallback for everything else.
      speech_models: ['universal-3-pro', 'universal-2'],
    }),
  })
  if (!submitResp.ok) {
    const errText = await submitResp.text().catch(() => '')
    return { ok: false, error: `AssemblyAI submit ${submitResp.status}: ${errText.slice(0, 300)}` }
  }
  const { id } = await submitResp.json() as { id: string }

  // 3. Poll for completion (typical: 1-3 seconds for short clips)
  const pollUrl = `https://api.assemblyai.com/v2/transcript/${id}`
  const start = Date.now()
  const TIMEOUT_MS = 60_000
  const POLL_INTERVAL_MS = 500
  while (Date.now() - start < TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
    const pollResp = await fetch(pollUrl, { headers: { 'Authorization': apiKey } })
    if (!pollResp.ok) continue
    const data = await pollResp.json() as { status?: string; text?: string; error?: string }
    if (data.status === 'completed') return { ok: true, text: (data.text ?? '').trim() }
    if (data.status === 'error') return { ok: false, error: `AssemblyAI: ${data.error || 'unknown'}` }
  }
  return { ok: false, error: 'AssemblyAI poll timeout (>60s)' }
}

// ─── Local OpenAI-compatible (whisper.cpp / local-voice-ai / future voice-lab) ──
async function sttLocal(audio: Buffer, mimeType: string, lang: string, baseUrl: string | undefined): Promise<TranscribeResult> {
  const base = (baseUrl || DEFAULTS.localBaseUrl).replace(/\/+$/, '')
  const form = new FormData()
  const blob = new Blob([new Uint8Array(audio)], { type: mimeType })
  form.append('file', blob, mimeToFilename(mimeType))
  form.append('model', 'whisper-1')
  if (lang) form.append('language', lang)
  form.append('response_format', 'json')

  const resp = await fetch(`${base}/v1/audio/transcriptions`, {
    method: 'POST',
    body: form,
  })
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    return { ok: false, error: `Local STT ${resp.status}: ${errText.slice(0, 300)}` }
  }
  const data = await resp.json() as { text?: string }
  return { ok: true, text: (data.text ?? '').trim() }
}

export function registerTranscribeIpc(): void {
  ipcMain.handle('transcribe:run', async (_event, args: TranscribeArgs): Promise<TranscribeResult> => {
    if (!args?.audio) return { ok: false, error: 'no audio' }
    const buf = toBuffer(args.audio)
    if (buf.length === 0) return { ok: false, error: 'empty audio' }
    const mime = args.mimeType || 'audio/webm'
    const lang = args.lang || DEFAULTS.lang
    const provider: SttProvider = (args.provider as SttProvider) || 'openai'

    try {
      switch (provider) {
        case 'openai':     return await sttOpenAI(buf, mime, lang, args.openaiModel || DEFAULTS.openaiModel)
        case 'deepgram':   return await sttDeepgram(buf, mime, lang, args.deepgramModel || DEFAULTS.deepgramModel)
        case 'assemblyai': return await sttAssemblyAI(buf, mime, lang)
        case 'local':      return await sttLocal(buf, mime, lang, args.localBaseUrl)
        default:           return { ok: false, error: `Unknown STT provider: ${provider}` }
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
