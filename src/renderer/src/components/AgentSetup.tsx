/**
 * AgentSetup — startup dialog for confirming/configuring agent binary paths.
 * Shows on first run or when paths haven't been confirmed yet.
 */

import React, { useState, useEffect, useCallback } from 'react'

interface AgentPathEntry {
  path: string | null
  version: string | null
  detectedAt: string
  confirmed: boolean
}

interface AgentPathsConfig {
  claude: AgentPathEntry
  codex: AgentPathEntry
  opencode: AgentPathEntry
  shellPath: string | null
  updatedAt: string
}

// ── SVG logos ────────────────────────────────────────────────────────────────

function ClaudeLogo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="#c4a882" fillRule="evenodd">
      <path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" />
    </svg>
  )
}

function CodexLogo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="#10a37f" fillRule="evenodd">
      <path d="M21.55 10.004a5.416 5.416 0 00-.478-4.501c-1.217-2.09-3.662-3.166-6.05-2.66A5.59 5.59 0 0010.831 1C8.39.995 6.224 2.546 5.473 4.838A5.553 5.553 0 001.76 7.496a5.487 5.487 0 00.691 6.5 5.416 5.416 0 00.477 4.502c1.217 2.09 3.662 3.165 6.05 2.66A5.586 5.586 0 0013.168 23c2.443.006 4.61-1.546 5.361-3.84a5.553 5.553 0 003.715-2.66 5.488 5.488 0 00-.693-6.497v.001zm-8.381 11.558a4.199 4.199 0 01-2.675-.954c.034-.018.093-.05.132-.074l4.44-2.53a.71.71 0 00.364-.623v-6.176l1.877 1.069c.02.01.033.029.036.05v5.115c-.003 2.274-1.87 4.118-4.174 4.123zM4.192 17.78a4.059 4.059 0 01-.498-2.763c.032.02.09.055.131.078l4.44 2.53c.225.13.504.13.73 0l5.42-3.088v2.138a.068.068 0 01-.027.057L9.9 19.288c-1.999 1.136-4.552.46-5.707-1.51h-.001zM3.023 8.216A4.15 4.15 0 015.198 6.41l-.002.151v5.06a.711.711 0 00.364.624l5.42 3.087-1.876 1.07a.067.067 0 01-.063.005l-4.489-2.559c-1.995-1.14-2.679-3.658-1.53-5.63h.001zm15.417 3.54l-5.42-3.088L14.896 7.6a.067.067 0 01.063-.006l4.489 2.557c1.998 1.14 2.683 3.662 1.529 5.633a4.163 4.163 0 01-2.174 1.807V12.38a.71.71 0 00-.363-.623zm1.867-2.773a6.04 6.04 0 00-.132-.078l-4.44-2.53a.731.731 0 00-.729 0l-5.42 3.088V7.325a.068.068 0 01.027-.057L14.1 4.713c2-1.137 4.555-.46 5.707 1.513.487.833.664 1.809.499 2.757h.001zm-11.741 3.81l-1.877-1.068a.065.065 0 01-.036-.051V6.559c.001-2.277 1.873-4.122 4.181-4.12.976 0 1.92.338 2.671.954-.034.018-.092.05-.131.073l-4.44 2.53a.71.71 0 00-.365.623l-.003 6.173v.002zm1.02-2.168L12 9.25l2.414 1.375v2.75L12 14.75l-2.415-1.375v-2.75z" />
    </svg>
  )
}

function OpenCodeLogo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#58a6ff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  )
}

const AGENTS = [
  { id: 'claude' as const, label: 'Claude Code', logo: <ClaudeLogo />, installHint: 'npm install -g @anthropic-ai/claude-code' },
  { id: 'codex' as const, label: 'Codex', logo: <CodexLogo />, installHint: 'npm install -g @openai/codex' },
  { id: 'opencode' as const, label: 'OpenCode', logo: <OpenCodeLogo />, installHint: 'go install github.com/opencodeco/opencode@latest' },
]

interface AgentSetupProps {
  onComplete: () => void
}

export function AgentSetup({ onComplete }: AgentSetupProps) {
  const [config, setConfig] = useState<AgentPathsConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [detecting, setDetecting] = useState(false)
  const [editingAgent, setEditingAgent] = useState<string | null>(null)
  const [editPath, setEditPath] = useState('')
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const paths = await (window as any).electron.agentPaths.get()
      setConfig(paths)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const handleRedetect = async () => {
    setDetecting(true)
    setError(null)
    try {
      const paths = await (window as any).electron.agentPaths.detect()
      setConfig(paths)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setDetecting(false)
    }
  }

  const handleSetPath = async (agentId: string, path: string) => {
    setError(null)
    try {
      const result = await (window as any).electron.agentPaths.set(agentId, path || null)
      if (result?.error) {
        setError(result.error)
      } else {
        setConfig(result)
        setEditingAgent(null)
      }
    } catch (e: any) {
      setError(e.message)
    }
  }

  const handleConfirmAll = async () => {
    try {
      await (window as any).electron.agentPaths.confirmAll()
      onComplete()
    } catch (e: any) {
      setError(e.message)
    }
  }

  if (loading) return null

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      zIndex: 99999,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'rgba(0,0,0,0.6)',
      backdropFilter: 'blur(8px)',
      WebkitAppRegion: 'no-drag',
    } as React.CSSProperties}>
      <div style={{
        background: '#1e1e1e',
        border: '1px solid #333',
        borderRadius: 12,
        padding: '24px 28px',
        width: 480,
        maxHeight: '80vh',
        overflow: 'auto',
        boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
      }}>
        {/* Header */}
        <div style={{ marginBottom: 18 }}>
          <div style={{
            fontSize: 11,
            fontWeight: 600,
            color: '#555',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            marginBottom: 6,
          }}>
            Setup
          </div>
          <div style={{
            fontSize: 13,
            color: '#888',
            lineHeight: 1.4,
          }}>
            Detected coding agents on your system. Confirm the paths or set them manually.
          </div>
        </div>

        {/* Error */}
        {error && (
          <div style={{
            background: 'rgba(255,80,80,0.08)',
            border: '1px solid rgba(255,80,80,0.2)',
            borderRadius: 6,
            padding: '6px 10px',
            marginBottom: 12,
            fontSize: 11,
            color: '#ff8080',
          }}>
            {error}
          </div>
        )}

        {/* Agent rows */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {AGENTS.map(agent => {
            const entry = config?.[agent.id]
            const isEditing = editingAgent === agent.id
            const found = !!entry?.path

            return (
              <div key={agent.id} style={{
                background: '#161616',
                border: '1px solid #1f1f1f',
                borderRadius: 8,
                padding: '10px 12px',
              }}>
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                }}>
                  <div style={{
                    width: 28,
                    height: 28,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}>
                    {agent.logo}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                    }}>
                      <span style={{
                        fontSize: 13,
                        fontWeight: 500,
                        color: '#e0e0e0',
                      }}>
                        {agent.label}
                      </span>
                      {found ? (
                        <span style={{
                          fontSize: 10,
                          color: '#4ade80',
                          background: 'rgba(74,222,128,0.08)',
                          padding: '1px 5px',
                          borderRadius: 3,
                        }}>
                          {entry.version || 'found'}
                        </span>
                      ) : (
                        <span style={{
                          fontSize: 10,
                          color: '#666',
                          background: 'rgba(136,136,136,0.08)',
                          padding: '1px 5px',
                          borderRadius: 3,
                        }}>
                          not found
                        </span>
                      )}
                    </div>
                    {found && !isEditing && (
                      <div style={{
                        fontSize: 10,
                        color: '#555',
                        marginTop: 2,
                        fontFamily: 'monospace',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}>
                        {entry.path}
                      </div>
                    )}
                    {!found && !isEditing && (
                      <div style={{ fontSize: 10, color: '#444', marginTop: 2 }}>
                        <code style={{ fontSize: 10 }}>{agent.installHint}</code>
                      </div>
                    )}
                  </div>
                  {!isEditing && (
                    <button
                      onClick={() => {
                        setEditingAgent(agent.id)
                        setEditPath(entry?.path || '')
                        setError(null)
                      }}
                      style={{
                        background: 'transparent',
                        border: '1px solid #333',
                        borderRadius: 6,
                        color: '#888',
                        fontSize: 11,
                        padding: '3px 8px',
                        cursor: 'pointer',
                        flexShrink: 0,
                      }}
                    >
                      {found ? 'Change' : 'Set path'}
                    </button>
                  )}
                </div>

                {/* Edit mode */}
                {isEditing && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <input
                        type="text"
                        value={editPath}
                        onChange={e => setEditPath(e.target.value)}
                        placeholder="/usr/local/bin/..."
                        autoFocus
                        onKeyDown={e => {
                          if (e.key === 'Enter') handleSetPath(agent.id, editPath)
                          if (e.key === 'Escape') setEditingAgent(null)
                        }}
                        style={{
                          flex: 1,
                          background: '#1a1a1a',
                          border: '1px solid #333',
                          borderRadius: 6,
                          color: '#e0e0e0',
                          fontSize: 11,
                          fontFamily: 'monospace',
                          padding: '5px 8px',
                          outline: 'none',
                        }}
                      />
                      <button
                        onClick={() => handleSetPath(agent.id, editPath)}
                        style={{
                          background: '#222',
                          border: '1px solid #333',
                          borderRadius: 6,
                          color: '#ccc',
                          fontSize: 11,
                          padding: '4px 10px',
                          cursor: 'pointer',
                        }}
                      >
                        Save
                      </button>
                      <button
                        onClick={() => setEditingAgent(null)}
                        style={{
                          background: 'transparent',
                          border: '1px solid #333',
                          borderRadius: 6,
                          color: '#888',
                          fontSize: 11,
                          padding: '4px 8px',
                          cursor: 'pointer',
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                    {found && (
                      <button
                        onClick={() => handleSetPath(agent.id, '')}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: '#555',
                          fontSize: 10,
                          padding: '3px 0',
                          cursor: 'pointer',
                          marginTop: 4,
                        }}
                      >
                        Clear path
                      </button>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* Footer */}
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginTop: 16,
        }}>
          <button
            onClick={handleRedetect}
            disabled={detecting}
            style={{
              background: 'transparent',
              border: '1px solid #333',
              borderRadius: 6,
              color: '#888',
              fontSize: 11,
              padding: '5px 12px',
              cursor: detecting ? 'wait' : 'pointer',
              opacity: detecting ? 0.5 : 1,
            }}
          >
            {detecting ? 'Scanning...' : 'Re-detect'}
          </button>
          <button
            onClick={handleConfirmAll}
            style={{
              background: '#222',
              border: '1px solid #333',
              borderRadius: 6,
              color: '#e0e0e0',
              fontSize: 12,
              fontWeight: 500,
              padding: '6px 18px',
              cursor: 'pointer',
            }}
          >
            Looks good
          </button>
        </div>
      </div>
    </div>
  )
}
