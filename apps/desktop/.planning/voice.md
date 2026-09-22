# Voice Plan — STT (in) + TTS (out)

Two halves of the same architecture:

- **STT (in):** replace failing `webkitSpeechRecognition` with a pluggable
  provider pipeline. Renderer captures audio with `MediaRecorder`; main
  process routes to a configured backend; transcript flows back over IPC.
- **TTS (out):** synthesize agent responses to audio so the user can listen.
  Renderer streams text to main as the agent emits it; main routes to a
  configured TTS backend (Voice Lab is the natural fit — that's exactly what
  it's for); audio stream flows back to renderer as a Blob URL or chunked
  Audio() playback.

Both directions share the same provider-router pattern in main process. API
keys and local-server URLs live in one settings panel. Renderer is engine-
agnostic.

---

## TTS provider matrix

| Provider | Where | Speed | Cost | Quality | Notes |
|---|---|---|---|---|---|
| **Voice Lab** (local proxy) | `http://localhost:8002` | Depends on backend | $0 (local) | Depends on backend | Routes internally to Kokoro / Soprano / Dia / Spark / Kani / VoxClaw / Fish Speech / Gemini. One URL, many voices. |
| **OpenAI TTS** | api.openai.com | ~1s first byte | $15/M chars | Excellent | 6 stock voices, no streaming on standard tier |
| **ElevenLabs** | api.elevenlabs.io | ~500ms first byte (streaming) | ~$22/M chars | Best in class | Streaming, voice cloning |
| **Deepgram Aura** | api.deepgram.com | <300ms first byte | $0.015/1k chars | Good, very fast | Streaming, optimized for low-latency conversation |
| **Google Gemini TTS** | api.gemini.google.com | ~800ms first byte | varies | Good | Already accessible via Voice Lab — second access path |
| **macOS `say`** | local CLI | <100ms | $0 | Robotic | Free fallback; "Samantha" et al. |

**Voice Lab is the leverage point.** Just like local-voice-ai is the leverage
point for STT (one URL, many engines), voice-lab is the leverage point for
TTS. Adding voice-lab support also brings: Kokoro (fast Apple Silicon), Dia
(emotional), Fish Speech S2 Pro (premium quality, Mandarin/EN), Gemini, and
VoxClaw — all behind one HTTP URL.

---

## TTS architecture

### Renderer side (ChatTile)
1. New `playMessage(messageId)` action — triggered by:
   - Per-message "speak" button (always available)
   - Auto-speak toggle (speaks every assistant message as it completes)
   - Continuous mode (speaks each sentence as it streams in)
2. Streaming approach:
   - For finished messages: `await ipc.tts.synthesize({text, provider, voice})`
     returns an audio Blob; create object URL; play via `<audio>`.
   - For live-streaming agent output: `ipc.tts.openStream(...)` returns an
     async iterable of audio chunks; play with MediaSource Extensions.
     Use voice-lab's `/generate/smart-stream` to get sentence-chunked audio.

### Main side (new `src/main/ipc/tts.ts`)
- `ipcMain.handle('tts:synthesize', async (_, args) => providerRouter(args))`
- Provider router dispatches to:
  - `synthVoiceLab(text, voice)` → POST `${voiceLabBase}/v1/audio/speech` (OpenAI-compat)
  - `synthVoiceLabStream(text, voice)` → POST `${voiceLabBase}/generate/smart-stream`
  - `synthOpenAI(text, voice)` → POST `https://api.openai.com/v1/audio/speech`
  - `synthElevenLabs(text, voice)` → POST `https://api.elevenlabs.io/v1/text-to-speech/{voiceId}/stream`
  - `synthDeepgramAura(text, voice)` → POST `https://api.deepgram.com/v1/speak`
  - `synthSay(text)` → spawn `say` with the system voice; capture stdout WAV
- Returns either: full audio Buffer, or a stream chunked over IPC.

### Settings additions
```ts
voice?: {
  // STT (input)
  sttProvider: 'deepgram' | 'assemblyai' | 'openai' | 'local' | 'system'
  sttLocalBaseUrl?: string
  sttLang?: string

  // TTS (output) — NEW
  ttsProvider: 'voicelab' | 'openai' | 'elevenlabs' | 'deepgram' | 'system'
  ttsVoiceLabBaseUrl?: string  // default 'http://127.0.0.1:8002'
  ttsModelId?: string          // voice-lab model id (e.g. 'kokoro', 'dia')
  ttsVoice?: string            // provider-specific voice id
  ttsAutoSpeak?: 'off' | 'last-message' | 'every-message'
  ttsStreaming?: boolean       // sentence-chunked playback while agent streams
  ttsBargeIn?: boolean         // stop TTS when user starts typing/talking
}
```

---

## TTS implementation phases

### Phase A — Voice Lab integration (MVP, ~45 min)
- New `src/main/ipc/tts.ts` with `synthVoiceLab` only
- Renderer: per-message "speak" button on assistant messages
- Plays full message via `<audio>` after generation completes
- This proves the pipeline; everything else is provider plumbing

### Phase B — Streaming via smart-stream (~1 hour)
- Switch to `/generate/smart-stream` for agent-completed messages
- For live agent output: chunk-by-sentence as the model streams
- Use MediaSource Extensions or sequential `<audio>` elements
- This is where the perceived-latency win lives

### Phase C — Cloud TTS providers (~30 min each)
- OpenAI, ElevenLabs, Deepgram Aura — all REST POST patterns
- Same router shape as STT cloud providers

### Phase D — `say` fallback + auto-speak modes (~30 min)
- macOS `say` as zero-cost zero-config fallback
- Settings dropdown: off / last-message / every-message
- Barge-in: stop playback when user types or starts dictating

### Phase E — Per-message "save audio" / "regenerate" controls
- Cache generated audio keyed by `(messageId, provider, voice)`
- Tiny disk cost, big UX win — re-listening to a message doesn't re-bill

---

## TTS decisions (locked-in)

### Q-TTS-1 → **B with narration** (auto-speak last-message-only, spokified)
- Auto-speak only the **most recent** assistant message.
- **Critically: never read text verbatim.** Code blocks, punctuation,
  markdown structure must be rewritten into natural spoken language.
- Examples:
  - "1. Foo  2. Bar  3. Baz" → "There are three options: foo, bar, and baz."
  - "Here's an example: ```ts function x() {}```" → "Here's a small code example for that. (Code shown above.)"
  - "I would **strongly recommend** ElevenLabs..." → "I'd recommend ElevenLabs."
  - Links / inline-code / em-dashes → smoothed into prose.
- Implementation: a "spokify" pre-processor (small LLM call, ~500 in/300 out
  tokens) runs after the agent message completes. Spokified text is what
  feeds the TTS engine. Cache result per messageId so re-listening doesn't
  re-call.

### Q-TTS-2 → **Cloud TTS providers: Deepgram (Aura), ElevenLabs, Cartesia**
| Provider | Latency | Cost | Notes |
|---|---|---|---|
| **Cartesia Sonic** | ~75ms TTFB | ~$50/M chars (Pro tier) | Fastest in market. Streaming via WS. |
| **Deepgram Aura** | ~300ms TTFB | $0.015/1k chars (~$15/M) | Streaming, conversation-tuned. |
| **ElevenLabs** | ~500ms TTFB | ~$22/M chars (Creator) | Best quality. Streaming + voice cloning. |

All three: REST + WebSocket streaming, OpenAI-style multipart input,
audio/mpeg or opus output. Same router shape.

Voice Lab stays in scope as a **local fallback** (Kokoro on Apple Silicon)
but isn't the primary TTS path. It remains the natural local choice for
users who want zero-cost zero-network voice.

### Q-TTS-3 → **see Q1** — assistant-only, spokified
Tool calls, system messages, error messages — never spoken. Only the
spokified version of assistant prose.

### Q-TTS-4 → **Voice-only barge-in**
- TTS playing → user hits voice button OR holds Space → TTS playback
  immediately stops, mic recording starts.
- TTS playing → user types in textarea → TTS continues uninterrupted.
- TTS playing → user clicks STOP button → kills agent stream entirely;
  TTS stops naturally because no more text arrives.
- This is "voice steering": speaking interrupts the AI; typing doesn't.

### Q-TTS-5 → **Subtle visual indicator**
- Small waveform/dot animation on the bubble currently being spoken.
- Bubble border or background shift to a softer accent tint while playing.
- No big "PLAYING" badge — just enough that the user knows which message
  the audio belongs to.

---

## Spokify component

New piece in main process: `src/main/ipc/spokify.ts`.

```ts
async function spokify(text: string, model = SPOKIFY_DEFAULT_MODEL): Promise<string> {
  // Send to a fast/cheap LLM with a tight system prompt:
  //   "Rewrite this assistant message as a natural spoken response.
  //    Strip code blocks (replace with brief mention). Drop markdown.
  //    Convert numbered lists to natural prose. Keep meaning, drop structure.
  //    Output only the rewritten text."
  // Returns the spokified text.
}
```

Model choices for spokify (separate from the chat model):
- `gpt-4o-mini` — $0.15/M in, $0.60/M out. Standard.
- `claude-haiku-4` — $0.25/M in, $1.25/M out. Better at narration tone.
- `gemini-2.0-flash` — cheapest, fast, good enough.
- Local — if user has llama.cpp or Ollama running, use that for free.

Default: **gpt-4o-mini** (cheapest, fastest, available to most users).
Settings exposes a dropdown.

Cost at scale: a busy chat day might be 100 messages × ~$0.0002 each = ~$0.02/day. Negligible.

---

## Barge-in implementation

The barge-in trigger lives at the entry point of mic activation, not at the
keystroke layer. Pattern:

```ts
function startMicAndBarge() {
  if (ttsPlayer.isPlaying) {
    ttsPlayer.stop()  // Cancel current playback. Agent stream is unaffected.
  }
  toggleDictation()  // existing path
}
```

Both the mic button onClick and the spacebar push-to-talk handler call
`startMicAndBarge` instead of `toggleDictation` directly. The STOP button
is unchanged — it still kills the agent stream and the (now-redundant) TTS
naturally drains.

---

## Why webkitSpeechRecognition fails today

Vanilla Electron's `webkitSpeechRecognition` is a stub that depends on
Chromium's proprietary STT service — which is not licensed/included in
Electron. `recognition.start()` succeeds, then immediately fires `onerror`
(`service-not-allowed` or `network`), then `onend`. Symptom: indicator
banner flashes on, then off. Already confirmed via our diagnostics.

The existing media-permission handler (`main/index.ts:213-242`) is fine —
it's wired for `getUserMedia` and works. We just need to actually use it
for capture, then transcribe ourselves.

---

## Provider matrix

| Provider | Transport | Latency | Cost | Privacy | Setup |
|---|---|---|---|---|---|
| **Deepgram** | WS (live) or REST | ~250ms first word | $0.0043/min (Nova-2) | Cloud | API key |
| **AssemblyAI** | WS (live) or REST | ~400ms first word | $0.00065/sec ≈ $0.039/min | Cloud | API key |
| **OpenAI Whisper** | REST (file upload) | 1–3s end-to-end | $0.006/min | Cloud | API key |
| **Local (OpenAI-compat)** | REST (file upload) | depends on hardware | $0 | On-device | Run a local server speaking `/v1/audio/transcriptions` |
| **System / Codex Voice** | (none — separate app) | n/a | $0 | depends | Just run codex-voice; user uses Ctrl-M outside our app |

**OpenAI-compat is the leverage point.** Whisper.cpp, mlx-whisper, and
local-voice-ai all already expose this contract or can. By coding to it,
the user can swap backends without touching collaborator-clone.

---

## Architecture

### Renderer side (ChatTile)
1. Replace `toggleDictation`'s recognizer with `MediaRecorder`:
   ```ts
   const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
   const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
   recorder.ondataavailable = e => chunks.push(e.data)
   recorder.onstop = async () => {
     const blob = new Blob(chunks, { type: 'audio/webm' })
     const arrayBuf = await blob.arrayBuffer()
     const transcript = await window.electron.transcribe.run({
       audio: arrayBuf,
       mimeType: 'audio/webm',
       provider: settings.sttProvider,
       lang: settings.sttLang ?? 'en',
     })
     setInput(prev => prev + (prev && !prev.endsWith(' ') ? ' ' : '') + transcript)
   }
   recorder.start()
   ```
2. Show interim "Recording…" indicator (already exists). Drop the interim
   transcript display unless we go with WS streaming providers.
3. The mic button + spacebar handlers stay exactly as-is — the recognizer
   under the hood is the only thing changing.

### Main side (new `src/main/ipc/transcribe.ts`)
- `ipcMain.handle('transcribe:run', async (_, args) => providerRouter(args))`
- `providerRouter` dispatches to one of:
  - `transcribeDeepgram(audio, mime, lang)` — POST to `https://api.deepgram.com/v1/listen`
  - `transcribeAssemblyAI(audio, mime, lang)` — upload + poll, or v3 streaming
  - `transcribeOpenAI(audio, mime, lang)` — POST to `https://api.openai.com/v1/audio/transcriptions`
  - `transcribeLocal(audio, mime, lang)` — POST to `${localBaseUrl}/v1/audio/transcriptions`
- API keys stored in `~/.codesurf/secrets.json` (or whatever the existing
  secret-store is — check `permissions.ts` neighborhood).
- Local base URL configurable in settings; default `http://127.0.0.1:8011`
  (which is what voice-lab uses — easy if we add STT to it).

### Settings
Add to `AppSettings`:
```ts
voice?: {
  sttProvider: 'deepgram' | 'assemblyai' | 'openai' | 'local' | 'system'
  localBaseUrl?: string         // default 'http://127.0.0.1:8011'
  lang?: string                 // BCP-47, default 'en-US'
}
```
Settings UI — existing voice section (since `voiceEnabled: true` shows up
already in the global Claude settings, there may already be a place for it)
or add a small new panel.

---

## Implementation phases

### Phase A — MediaRecorder + OpenAI Whisper (MVP, ~1 hour)
- Wire MediaRecorder in renderer.
- New IPC handler `transcribe:run` in main.
- Implement `transcribeOpenAI` first (simplest contract, well-documented).
- Test end-to-end. If it works, we know the pipeline is sound.

### Phase B — Add Deepgram + AssemblyAI (~30 min each)
- Both are REST-uploadable like OpenAI; wrappers are similar shape.
- Defer streaming (WS) variants until users complain about latency.

### Phase C — Local provider (~15 min)
- Implement `transcribeLocal` pointing at OpenAI-compat URL.
- Document that the user can run any of: voice-lab+STT, local-voice-ai,
  whisper.cpp server, mlx-whisper server.
- Optionally bundle a one-shot `npm run voice:local` script that starts
  whisper.cpp with sane defaults for Apple Silicon.

### Phase D — Streaming (optional, ~2 hours)
- Deepgram and AssemblyAI both support WebSocket streaming.
- Yields per-word interim transcripts during the user's hold-to-talk.
- Real win for long dictations; small win for short ones.

### Phase E — Codex Voice / System dictation passthrough (~10 min)
- 'system' provider becomes a no-op + helpful tooltip:
  "Hold Ctrl-M anywhere on Mac (codex-voice running) or System Settings →
  Keyboard → Dictation."
- No integration needed. The textarea already accepts text from any
  source, including system dictation pasting.

---

## Open questions

### Q1 — Which provider to ship as the first-launch default?
- (A) **OpenAI Whisper** — most recognizable, requires user to add an OpenAI key.
- (B) **Local** — assumes the user has set up a local STT server. Zero cost,
  fastest privacy, but onboarding pain.
- (C) **System / no provider** — disable the mic button by default, point
  user to codex-voice or settings to choose.

My take: **A** for first-launch (most users have an OpenAI key), but the
settings flow surfaces all four immediately so the user can switch. The
mic button stays visible but shows an unconfigured state until a provider
is chosen.

### Q2 — Where do we store API keys?
- Encrypted via Electron's `safeStorage`?
- Plain JSON in `~/.codesurf/secrets.json` (current pattern for some
  things — needs verification)?
- Per-workspace (so different projects can use different STT)?

Worth one round-trip with you before locking. The main app likely already
has a secret-handling primitive — I'll find it before designing this.

### Q3 — Voice-lab STT add-on: in scope or out?
You asked me to check voice-lab. It's TTS-only today. We could:
- (A) Leave voice-lab alone; treat `local` provider as "user runs whatever they want."
- (B) Add an STT endpoint to voice-lab (`/v1/audio/transcriptions` proxy
  that fronts whisper.cpp / mlx-whisper / Nemotron). Coherent with how it
  fronts multiple TTS engines. ~half-day in voice-lab, separate from this.
- (C) Skip voice-lab entirely, recommend `local-voice-ai` (which you already
  have) for the local provider.

My take: **A short-term, B medium-term**. Don't block this work on
voice-lab changes; ship the provider abstraction now. Add STT to voice-lab
later as a parallel task in that repo.

---

## Risk register

- `MediaRecorder` codec compat: `audio/webm;codecs=opus` is universally
  supported by Whisper-family services. Deepgram/AssemblyAI accept it.
  Local providers may need re-encoding to `wav` — we'd add a server-side
  ffmpeg step in `transcribeLocal` if needed.
- API key leakage: must read keys in main process only. Renderer never
  sees them. Already standard pattern in this codebase (e.g. agent paths).
- Permission UX: `getUserMedia` will trigger the macOS mic permission dialog
  the first time. The existing `requestMacMediaAccess('microphone')` call
  in `main/index.ts:225` handles that path — already proven working.
- Latency on REST-upload providers: OpenAI is ~1-3s for short clips.
  Acceptable for "tap to dictate," painful for "live transcription." This
  is why streaming providers (Phase D) exist.

---

## Decision points before I write code

1. **Phase A scope:** start with OpenAI Whisper alone, or do all 3 cloud providers in one push?
2. **API-key storage:** safeStorage / plain JSON / per-workspace — your call.
3. **First-launch default:** A / B / C from Q1 above.
4. **Voice-lab STT add-on:** in or out of this milestone?
