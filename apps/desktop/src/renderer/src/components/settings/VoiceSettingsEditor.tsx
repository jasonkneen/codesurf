/**
 * Voice settings panel.
 *
 * Three groups:
 *   1. Speech-to-text (STT)        — provider + lang + (local URL)
 *   2. Text-to-speech (TTS)        — provider + voice id + (voicelab URL)
 *   3. Auto-speak + spokify        — when to auto-speak, which model rewrites
 *   4. API keys                    — encrypted via safeStorage, never read back
 *
 * Settings persist via the parent's onChange (settings.voice). API keys
 * persist independently via window.electron.secrets — they are not part of
 * AppSettings (because they're encrypted) but the UI shows whether each
 * provider's key is set.
 */
import React, { useEffect, useState } from 'react'
import { useTheme } from '../../ThemeContext'
import type { AppSettings, VoiceSettings } from '../../../../shared/types'

interface Props {
  settings: AppSettings
  onChange: (next: AppSettings) => void
}

const STT_PROVIDERS = [
  { id: 'openai',     label: 'OpenAI Whisper',  needsKey: 'openai',     desc: 'whisper-1, REST upload, ~$0.006/min' },
  { id: 'deepgram',   label: 'Deepgram Nova-2', needsKey: 'deepgram',   desc: 'Fast, conversation-tuned, ~$0.0043/min' },
  { id: 'assemblyai', label: 'AssemblyAI',      needsKey: 'assemblyai', desc: 'Universal-2, upload-and-poll, ~$0.039/min' },
  { id: 'local',      label: 'Local (OpenAI-compat)', needsKey: null,   desc: 'Whisper.cpp / local-voice-ai / future voice-lab STT' },
] as const

const TTS_PROVIDERS = [
  { id: 'cartesia',   label: 'Cartesia Sonic-2',  needsKey: 'cartesia',   desc: 'Fastest (~75ms), great quality' },
  { id: 'deepgram',   label: 'Deepgram Aura',     needsKey: 'deepgram',   desc: 'Conversation-tuned, ~300ms latency' },
  { id: 'elevenlabs', label: 'ElevenLabs',        needsKey: 'elevenlabs', desc: 'Best quality, voice cloning' },
  { id: 'voicelab',   label: 'Voice Lab (local)', needsKey: null,         desc: 'Local proxy: Kokoro / Dia / Spark / etc.' },
  { id: 'say',        label: 'macOS say',         needsKey: null,         desc: 'System voice — robotic, free, always works' },
] as const

const SPOKIFY_MODELS = [
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (recommended)', needsKey: 'anthropic' },
  { id: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5 (richer narration)', needsKey: 'anthropic' },
  { id: 'claude-haiku-4-5',           label: 'Claude Haiku 4.5 (alias)',         needsKey: 'anthropic' },
] as const

const SECRET_FIELDS = [
  { name: 'anthropic',  label: 'Anthropic',  desc: 'Used by spokify (Haiku 4.5 narration rewrite).' },
  { name: 'openai',     label: 'OpenAI',     desc: 'Used by Whisper STT.' },
  { name: 'deepgram',   label: 'Deepgram',   desc: 'Shared key — used by both STT (Nova-2) and TTS (Aura).' },
  { name: 'assemblyai', label: 'AssemblyAI', desc: 'Used by AssemblyAI STT.' },
  { name: 'elevenlabs', label: 'ElevenLabs', desc: 'Used by ElevenLabs TTS.' },
  { name: 'cartesia',   label: 'Cartesia',   desc: 'Used by Cartesia Sonic TTS (the default).' },
] as const

function defaultVoice(): VoiceSettings {
  return {
    sttProvider: 'openai',
    sttLang: 'en',
    ttsProvider: 'cartesia',
    spokifyModel: 'claude-haiku-4-5-20251001',
    autoSpeak: 'off',
    bargeIn: true,
  }
}

export function VoiceSettingsEditor({ settings, onChange }: Props): React.JSX.Element {
  const theme = useTheme()
  const v: VoiceSettings = settings.voice ?? defaultVoice()

  const [keyState, setKeyState] = useState<Record<string, boolean>>({})
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({})
  const [keyVisible, setKeyVisible] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)

  // Hydrate on mount: ask main which keys are set.
  useEffect(() => {
    const sec = (window as { electron?: { secrets?: { has?: (n: string) => Promise<{ has: boolean }> } } }).electron?.secrets
    if (!sec?.has) return
    void Promise.all(SECRET_FIELDS.map(async (f) => {
      const r = await sec.has!(f.name)
      return [f.name, r.has] as const
    })).then(entries => {
      const next: Record<string, boolean> = {}
      for (const [name, has] of entries) next[name] = has
      setKeyState(next)
    })
  }, [])

  function patch(partial: Partial<VoiceSettings>): void {
    onChange({ ...settings, voice: { ...v, ...partial } })
  }

  async function saveSecret(name: string): Promise<void> {
    const sec = window.electron.secrets
    if (!sec) return
    const value = keyInputs[name] ?? ''
    setBusy(name)
    try {
      const r = await sec.set(name, value)
      if (r.ok) {
        setKeyInputs(prev => ({ ...prev, [name]: '' }))
        setKeyState(prev => ({ ...prev, [name]: value.length > 0 }))
        setStatusMsg(value ? `Saved ${name} key` : `Cleared ${name} key`)
        setTimeout(() => setStatusMsg(null), 2200)
      } else {
        setStatusMsg(`Save failed: ${r.error || 'unknown'}`)
      }
    } finally {
      setBusy(null)
    }
  }

  async function deleteSecret(name: string): Promise<void> {
    const sec = window.electron.secrets
    if (!sec) return
    setBusy(name)
    try {
      await sec.delete(name)
      setKeyState(prev => ({ ...prev, [name]: false }))
      setStatusMsg(`Cleared ${name} key`)
      setTimeout(() => setStatusMsg(null), 2200)
    } finally {
      setBusy(null)
    }
  }

  const labelStyle: React.CSSProperties = {
    fontSize: 11, fontWeight: 600, color: theme.text.secondary, textTransform: 'uppercase', letterSpacing: 0.5,
  }
  const sectionStyle: React.CSSProperties = {
    border: `1px solid ${theme.border.subtle}`,
    borderRadius: 10,
    padding: 16,
    background: theme.surface.panel,
    display: 'flex', flexDirection: 'column', gap: 12,
  }
  const selectStyle: React.CSSProperties = {
    background: theme.surface.input ?? theme.surface.panel,
    color: theme.text.primary,
    border: `1px solid ${theme.border.default}`,
    borderRadius: 6, padding: '6px 10px', fontSize: 13, outline: 'none',
  }
  const inputStyle: React.CSSProperties = {
    ...selectStyle, flex: 1,
  }
  const btn: React.CSSProperties = {
    background: theme.accent.base, color: '#fff', border: 'none', borderRadius: 6,
    padding: '6px 12px', fontSize: 12, cursor: 'pointer',
  }
  const btnGhost: React.CSSProperties = {
    background: 'transparent', color: theme.text.secondary, border: `1px solid ${theme.border.default}`,
    borderRadius: 6, padding: '6px 10px', fontSize: 12, cursor: 'pointer',
  }
  const desc: React.CSSProperties = { fontSize: 11, color: theme.text.muted }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 760 }}>
      {statusMsg && (
        <div style={{
          padding: '8px 12px', borderRadius: 6, background: theme.accent.soft ?? theme.surface.panelMuted,
          color: theme.accent.base, fontSize: 12,
        }}>{statusMsg}</div>
      )}

      {/* ── 1. Speech-to-text ────────────────────────────────────────── */}
      <div style={sectionStyle}>
        <div style={labelStyle}>Speech-to-text (dictation)</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, color: theme.text.primary }}>Provider</span>
            <select
              value={v.sttProvider}
              onChange={e => patch({ sttProvider: e.target.value as VoiceSettings['sttProvider'] })}
              style={selectStyle}
            >
              {STT_PROVIDERS.map(p => (
                <option key={p.id} value={p.id}>
                  {p.label}{p.needsKey && !keyState[p.needsKey] ? '  (needs API key)' : ''}
                </option>
              ))}
            </select>
            <span style={desc}>{STT_PROVIDERS.find(p => p.id === v.sttProvider)?.desc}</span>
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, color: theme.text.primary }}>Language</span>
            <input
              type="text"
              value={v.sttLang}
              onChange={e => patch({ sttLang: e.target.value })}
              placeholder="en, en-GB, fr, es..."
              style={inputStyle}
            />
            <span style={desc}>BCP-47 tag — accepted by all four providers.</span>
          </label>

          {v.sttProvider === 'local' && (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, color: theme.text.primary }}>Local server URL</span>
              <input
                type="text"
                value={v.sttLocalBaseUrl ?? ''}
                onChange={e => patch({ sttLocalBaseUrl: e.target.value })}
                placeholder="http://127.0.0.1:8011"
                style={inputStyle}
              />
              <span style={desc}>Any OpenAI-compatible endpoint exposing /v1/audio/transcriptions.</span>
            </label>
          )}
        </div>
      </div>

      {/* ── 2. Text-to-speech ──────────────────────────────────────────── */}
      <div style={sectionStyle}>
        <div style={labelStyle}>Text-to-speech (voice replies)</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, color: theme.text.primary }}>Provider</span>
            <select
              value={v.ttsProvider}
              onChange={e => patch({ ttsProvider: e.target.value as VoiceSettings['ttsProvider'] })}
              style={selectStyle}
            >
              {TTS_PROVIDERS.map(p => (
                <option key={p.id} value={p.id}>
                  {p.label}{p.needsKey && !keyState[p.needsKey] ? '  (needs API key)' : ''}
                </option>
              ))}
            </select>
            <span style={desc}>{TTS_PROVIDERS.find(p => p.id === v.ttsProvider)?.desc}</span>
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, color: theme.text.primary }}>
              Voice ID
              <span style={{ ...desc, marginLeft: 8 }}>
                (provider-specific — see provider docs for available voices)
              </span>
            </span>
            <input
              type="text"
              value={v.ttsVoice ?? ''}
              onChange={e => patch({ ttsVoice: e.target.value })}
              placeholder={
                v.ttsProvider === 'cartesia' ? 'a0e99841-438c-4a64-b679-ae501e7d6091' :
                v.ttsProvider === 'deepgram' ? 'aura-2-thalia-en' :
                v.ttsProvider === 'elevenlabs' ? '21m00Tcm4TlvDq8ikWAM' :
                v.ttsProvider === 'voicelab' ? 'kokoro-default' :
                v.ttsProvider === 'say' ? 'Samantha' : ''
              }
              style={inputStyle}
            />
          </label>

          {v.ttsProvider === 'voicelab' && (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, color: theme.text.primary }}>Voice Lab base URL</span>
              <input
                type="text"
                value={v.ttsVoiceLabBaseUrl ?? ''}
                onChange={e => patch({ ttsVoiceLabBaseUrl: e.target.value })}
                placeholder="http://127.0.0.1:8002"
                style={inputStyle}
              />
            </label>
          )}
        </div>
      </div>

      {/* ── 3. Auto-speak + spokify ────────────────────────────────────── */}
      <div style={sectionStyle}>
        <div style={labelStyle}>Auto-speak (assistant replies)</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, color: theme.text.primary }}>When to auto-speak</span>
            <select
              value={v.autoSpeak}
              onChange={e => patch({ autoSpeak: e.target.value as VoiceSettings['autoSpeak'] })}
              style={selectStyle}
            >
              <option value="off">Off — only speak on click</option>
              <option value="last-message">Last message — speak the latest assistant reply automatically</option>
            </select>
            <span style={desc}>Code blocks are never read aloud. Punctuation and markdown are rewritten as natural prose by spokify.</span>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: theme.text.primary }}>
            <input
              type="checkbox"
              checked={v.bargeIn}
              onChange={e => patch({ bargeIn: e.target.checked })}
            />
            <span>Voice barge-in — clicking the mic stops current playback (typing does not)</span>
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, color: theme.text.primary }}>Spokify model</span>
            <select
              value={v.spokifyModel}
              onChange={e => patch({ spokifyModel: e.target.value })}
              style={selectStyle}
            >
              {SPOKIFY_MODELS.map(m => (
                <option key={m.id} value={m.id}>
                  {m.label}{m.needsKey && !keyState[m.needsKey] ? '  (needs Anthropic key)' : ''}
                </option>
              ))}
            </select>
            <span style={desc}>The LLM that rewrites written messages into natural spoken narration before TTS.</span>
          </label>
        </div>
      </div>

      {/* ── 4. API keys ────────────────────────────────────────────────── */}
      <div style={sectionStyle}>
        <div style={labelStyle}>API keys (encrypted)</div>
        <div style={{ ...desc, marginTop: -6 }}>
          Stored encrypted via OS keychain. Keys are never sent to the renderer once saved — the
          status badge is the only way to ask "is this set?"
        </div>
        {SECRET_FIELDS.map(field => {
          const set = !!keyState[field.name]
          const visible = !!keyVisible[field.name]
          return (
            <div key={field.name} style={{
              display: 'flex', flexDirection: 'column', gap: 6,
              padding: 12, borderRadius: 8, border: `1px solid ${theme.border.subtle}`,
              background: theme.surface.panelMuted,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: theme.text.primary }}>{field.label}</span>
                <span style={{
                  fontSize: 10, padding: '2px 6px', borderRadius: 999,
                  color: set ? theme.status.success : theme.text.muted,
                  background: 'transparent',
                  border: `1px solid ${set ? theme.status.success : theme.border.subtle}`,
                  textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600,
                }}>
                  {set ? 'set' : 'not set'}
                </span>
              </div>
              <span style={desc}>{field.desc}</span>
              <div style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
                <input
                  type={visible ? 'text' : 'password'}
                  value={keyInputs[field.name] ?? ''}
                  onChange={e => setKeyInputs(prev => ({ ...prev, [field.name]: e.target.value }))}
                  placeholder={set ? 'Replace existing key…' : 'Paste API key here'}
                  style={inputStyle}
                  spellCheck={false}
                  autoComplete="off"
                />
                <button
                  type="button"
                  onClick={() => setKeyVisible(prev => ({ ...prev, [field.name]: !visible }))}
                  style={btnGhost}
                  title={visible ? 'Hide' : 'Show'}
                >
                  {visible ? 'hide' : 'show'}
                </button>
                <button
                  type="button"
                  onClick={() => void saveSecret(field.name)}
                  disabled={busy === field.name || !keyInputs[field.name]?.trim()}
                  style={{ ...btn, opacity: busy === field.name || !keyInputs[field.name]?.trim() ? 0.5 : 1 }}
                >
                  Save
                </button>
                {set && (
                  <button
                    type="button"
                    onClick={() => void deleteSecret(field.name)}
                    disabled={busy === field.name}
                    style={btnGhost}
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
