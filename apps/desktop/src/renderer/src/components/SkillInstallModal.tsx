/**
 * SkillInstallModal — confirmation dialog shown when the user drops a .skill
 * archive onto the canvas or double-clicks one in Finder. Uses the main-process
 * `skills:inspect` / `skills:install` IPC endpoints exposed in preload.
 *
 * Theming: default CSS is light. `body.dark` overrides supply dark-mode values
 * (per the project theming rule: never use `prefers-color-scheme`; use solid
 * hex, not rgba opacity, so blur backdrops stay readable).
 */

import { useEffect, useRef, useState } from 'react'

interface SkillManifest {
  name: string
  description: string
  topFolder: string
  entryCount: number
  hasSkillMd: boolean
  preview: string
  zipPath: string
  sizeBytes: number
}

const STYLE_ID = 'skill-install-modal-styles-v1'

function ensureStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  // Stylesheet uses the `--cs-th-*` CSS variables published by ThemeContext
  // on <html>, so a single rule set tracks both light and dark modes plus
  // the contrast slider. No more body.dark overrides — palette flows in
  // from the active theme.
  style.textContent = `
.skill-install-overlay {
  position: fixed; inset: 0; z-index: 100000;
  display: flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, #000 50%, transparent);
  backdrop-filter: blur(8px);
  -webkit-app-region: no-drag;
}
.skill-install-panel {
  width: 560px; max-height: 82vh;
  display: flex; flex-direction: column; gap: 14px;
  padding: 22px 26px;
  border-radius: 12px;
  font-family: var(--chat-font-sans, -apple-system, system-ui, sans-serif);
  background: var(--cs-th-panel);
  color: var(--cs-th-text-primary);
  border: 1px solid var(--cs-th-border-subtle);
  box-shadow: 0 20px 60px color-mix(in srgb, #000 35%, transparent);
}
.skill-install-eyebrow {
  font-size: 11px; font-weight: 600;
  letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--cs-th-text-muted); margin-bottom: 4px;
}
.skill-install-title {
  font-size: 16px; font-weight: 600;
  color: var(--cs-th-text-primary);
}
.skill-install-desc {
  font-size: 12px; color: var(--cs-th-text-muted);
  margin-top: 4px; line-height: 1.4;
}
.skill-install-close {
  background: transparent; border: none;
  color: var(--cs-th-text-muted); cursor: pointer;
  font-size: 20px; line-height: 1; padding: 2px;
}
.skill-install-close:hover { color: var(--cs-th-text-primary); }
.skill-install-close:disabled { cursor: not-allowed; opacity: 0.5; }

.skill-install-info {
  font-size: 12px;
  background: var(--cs-th-panel-muted);
  color: var(--cs-th-text-primary);
  border: 1px solid var(--cs-th-border-subtle);
  border-radius: 8px;
  padding: 10px 12px;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 14px;
}
.skill-install-info .k { color: var(--cs-th-text-muted); }
.skill-install-info .v { color: var(--cs-th-text-primary); }
.skill-install-info .mono {
  font-family: var(--chat-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px; word-break: break-all;
}
.skill-install-info .good { color: var(--cs-th-status-success); }
.skill-install-info .warn { color: var(--cs-th-status-warning); }

.skill-install-label {
  font-size: 11px; color: var(--cs-th-text-muted);
  text-transform: uppercase; letter-spacing: 0.06em;
  margin-bottom: 4px;
}
.skill-install-hint {
  font-size: 10px; color: var(--cs-th-text-muted); margin-top: 4px;
}
.skill-install-input {
  width: 100%;
  background: var(--cs-th-input);
  color: var(--cs-th-text-primary);
  border: 1px solid var(--cs-th-border-default);
  border-radius: 6px;
  padding: 7px 10px;
  font-size: 12px;
  font-family: var(--chat-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  outline: none;
}
.skill-install-input:focus {
  border-color: var(--cs-th-accent-base);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--cs-th-accent-base) 22%, transparent);
}
.skill-install-input:disabled { background: var(--cs-th-panel-muted); color: var(--cs-th-text-muted); }

.skill-install-details { font-size: 12px; color: var(--cs-th-text-muted); }
.skill-install-details summary { cursor: pointer; color: var(--cs-th-text-primary); }
.skill-install-preview {
  margin-top: 6px;
  background: var(--cs-th-panel-muted);
  color: var(--cs-th-text-primary);
  border: 1px solid var(--cs-th-border-subtle);
  border-radius: 6px;
  padding: 10px;
  max-height: 220px;
  overflow: auto;
  font-size: 11px;
  white-space: pre-wrap;
  font-family: var(--chat-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}

.skill-install-checkbox {
  display: flex; align-items: center; gap: 6px;
  font-size: 12px; color: var(--cs-th-text-muted);
  cursor: pointer; user-select: none;
}
.skill-install-checkbox[aria-disabled="true"] { cursor: not-allowed; opacity: 0.6; }

.skill-install-actions {
  display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px;
}
.skill-install-btn {
  padding: 7px 14px; border-radius: 6px;
  font-size: 12px; cursor: pointer;
  border: 1px solid transparent;
  font-family: inherit;
}
.skill-install-btn:disabled { cursor: not-allowed; opacity: 0.55; }
.skill-install-btn.secondary {
  background: var(--cs-th-panel-elevated); border-color: var(--cs-th-border-default); color: var(--cs-th-text-primary);
}
.skill-install-btn.secondary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--cs-th-text-primary) 8%, var(--cs-th-panel-elevated));
}
.skill-install-btn.primary {
  background: var(--cs-th-accent-base); border-color: var(--cs-th-accent-base); color: var(--cs-th-text-inverse);
  font-weight: 600;
}
.skill-install-btn.primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--cs-th-accent-base) 88%, var(--cs-th-text-inverse));
}

.skill-install-loading {
  font-size: 12px; color: var(--cs-th-text-muted); padding: 8px 0;
}
.skill-install-error {
  background: color-mix(in srgb, var(--cs-th-status-danger) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--cs-th-status-danger) 30%, transparent);
  color: var(--cs-th-status-danger);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 12px;
  white-space: pre-wrap;
}
.skill-install-success {
  background: color-mix(in srgb, var(--cs-th-status-success) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--cs-th-status-success) 30%, transparent);
  color: var(--cs-th-status-success);
  border-radius: 6px;
  padding: 10px 12px;
  font-size: 12px;
}
.skill-install-success .title { font-weight: 600; margin-bottom: 4px; }
.skill-install-success .path {
  margin-top: 4px;
  font-family: var(--chat-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
  color: color-mix(in srgb, var(--cs-th-status-success) 75%, var(--cs-th-text-primary));
  word-break: break-all;
}
`
  document.head.appendChild(style)
}

export function SkillInstallModal({
  zipPath,
  onClose,
}: {
  zipPath: string
  onClose: () => void
}): JSX.Element {
  const [manifest, setManifest] = useState<SkillManifest | null>(null)
  const [targetDir, setTargetDir] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<null | { installedPath: string; entries: number }>(null)
  const [overwrite, setOverwrite] = useState(false)
  const cancelledRef = useRef(false)

  useEffect(() => { ensureStyles() }, [])

  useEffect(() => {
    cancelledRef.current = false
    setLoading(true)
    setError(null)

    const api = (window as any).electron?.skills
    if (!api) {
      setError('Skills IPC is unavailable. Restart the app and try again.')
      setLoading(false)
      return
    }

    Promise.all([
      api.inspect(zipPath) as Promise<SkillManifest>,
      api.getDefaultTargetDir() as Promise<string>,
    ])
      .then(([m, dir]) => {
        if (cancelledRef.current) return
        setManifest(m)
        setTargetDir(dir)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelledRef.current) return
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      })

    return () => {
      cancelledRef.current = true
    }
  }, [zipPath])

  const install = async (): Promise<void> => {
    const api = (window as any).electron?.skills
    if (!api) return
    setInstalling(true)
    setError(null)
    try {
      const res = await api.install({ zipPath, targetDir, overwrite }) as {
        installedPath: string
        entries: string[]
        targetDir: string
      }
      setDone({ installedPath: res.installedPath, entries: res.entries.length })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      if (/already installed/i.test(msg)) setOverwrite(true)
    } finally {
      setInstalling(false)
    }
  }

  const baseName = zipPath.split('/').pop() ?? zipPath

  return (
    <div
      className="skill-install-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget && !installing) onClose()
      }}
    >
      <div className="skill-install-panel">
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <div className="skill-install-eyebrow">Install Skill</div>
            <div className="skill-install-title">{manifest?.name || baseName}</div>
            {manifest?.description && (
              <div className="skill-install-desc">{manifest.description}</div>
            )}
          </div>
          <button
            type="button"
            onClick={() => { if (!installing) onClose() }}
            disabled={installing}
            className="skill-install-close"
            aria-label="Close"
          >×</button>
        </div>

        {loading && (
          <div className="skill-install-loading">Inspecting skill archive…</div>
        )}

        {error && !done && (
          <div className="skill-install-error">{error}</div>
        )}

        {done && (
          <div className="skill-install-success">
            <div className="title">Installed.</div>
            <div>{done.entries} files extracted to</div>
            <div className="path">{done.installedPath}</div>
          </div>
        )}

        {manifest && !done && (
          <>
            <div className="skill-install-info">
              <div className="k">Archive</div>
              <div className="v mono">{baseName}</div>
              <div className="k">Folder</div>
              <div className="v mono">{manifest.topFolder}</div>
              <div className="k">Files</div>
              <div className="v">{manifest.entryCount}</div>
              <div className="k">Size</div>
              <div className="v">{formatSize(manifest.sizeBytes)}</div>
              <div className="k">SKILL.md</div>
              <div className={manifest.hasSkillMd ? 'good' : 'warn'}>
                {manifest.hasSkillMd ? 'present' : 'missing (folder will still install)'}
              </div>
            </div>

            <div>
              <div className="skill-install-label">Install to</div>
              <input
                type="text"
                value={targetDir}
                onChange={e => setTargetDir(e.target.value)}
                disabled={installing}
                spellCheck={false}
                className="skill-install-input"
              />
              <div className="skill-install-hint">
                Defaults to the Claude skills directory so both CodeSurf and Claude pick it up.
              </div>
            </div>

            {manifest.preview && (
              <details className="skill-install-details">
                <summary>Preview SKILL.md</summary>
                <pre className="skill-install-preview">{manifest.preview}</pre>
              </details>
            )}

            <label
              className="skill-install-checkbox"
              aria-disabled={installing}
            >
              <input
                type="checkbox"
                checked={overwrite}
                onChange={e => setOverwrite(e.target.checked)}
                disabled={installing}
              />
              Overwrite if a skill with this name already exists
            </label>
          </>
        )}

        <div className="skill-install-actions">
          <button
            type="button"
            onClick={onClose}
            disabled={installing}
            className="skill-install-btn secondary"
          >
            {done ? 'Close' : 'Cancel'}
          </button>
          {!done && (
            <button
              type="button"
              onClick={install}
              disabled={loading || installing || !manifest}
              className="skill-install-btn primary"
            >
              {installing ? 'Installing…' : 'Install skill'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}
