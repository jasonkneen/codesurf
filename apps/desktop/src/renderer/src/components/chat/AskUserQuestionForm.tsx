import React, { useState, useCallback, useMemo } from 'react'
import { Check, MessageSquare } from 'lucide-react'
import { useTheme } from '../../ThemeContext'
import type { ToolBlock } from '../../../../shared/chat-types'

// --- AskUserQuestion types ---------------------------------------------------

export interface AskUserQuestionOption {
  label: string
  description?: string
  preview?: string
}
export interface AskUserQuestionItem {
  question: string
  header?: string
  multiSelect?: boolean
  options: AskUserQuestionOption[]
}
export interface AskUserQuestionPayload {
  questions: AskUserQuestionItem[]
  metadata?: Record<string, unknown>
}

// Context provides the immutable workspace/card scope so ToolBlockView
// (defined outside ChatTile) can submit answers back to main via IPC without
// prop-drilling through groups.
export const AskUserQuestionContext = React.createContext<{
  workspaceId: string
  cardId: string
} | null>(null)

/**
 * Parses a ToolBlock.input string (streamed JSON, potentially partial) and
 * returns a fully-formed AskUserQuestion payload, or null if not yet parseable.
 */
export function parseAskUserQuestionInput(input: string): AskUserQuestionPayload | null {
  if (!input) return null
  try {
    const parsed = JSON.parse(input) as { questions?: unknown; metadata?: unknown }
    if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) return null
    const questions: AskUserQuestionItem[] = []
    for (const q of parsed.questions) {
      if (!q || typeof q !== 'object') return null
      const qq = q as Partial<AskUserQuestionItem>
      if (typeof qq.question !== 'string' || !Array.isArray(qq.options) || qq.options.length < 2) return null
      const options: AskUserQuestionOption[] = []
      for (const opt of qq.options) {
        if (!opt || typeof opt !== 'object' || typeof (opt as AskUserQuestionOption).label !== 'string') return null
        options.push({
          label: (opt as AskUserQuestionOption).label,
          description: typeof (opt as AskUserQuestionOption).description === 'string' ? (opt as AskUserQuestionOption).description : undefined,
          preview: typeof (opt as AskUserQuestionOption).preview === 'string' ? (opt as AskUserQuestionOption).preview : undefined,
        })
      }
      questions.push({
        question: qq.question,
        header: typeof qq.header === 'string' ? qq.header : undefined,
        multiSelect: qq.multiSelect === true,
        options,
      })
    }
    return { questions, metadata: (parsed.metadata as Record<string, unknown> | undefined) }
  } catch {
    return null
  }
}

// --- Font hook (re-uses the FontCtx from ChatTile via prop) ------------------
// AskUserQuestionForm and AskUserQuestionChip receive fonts via a thin context
// that ChatTile already provides. We accept them as a prop to avoid a circular
// dependency on the ChatTile-internal FontCtx.

interface FontsShape {
  sans: string
  mono: string
  size: number
  monoSize: number
  lineHeight: number
  weight: number
  monoLineHeight: number
  monoWeight: number
  secondary: string
  secondarySize: number
  secondaryLineHeight: number
  secondaryWeight: number
}

export const AskUserQuestionFontsContext = React.createContext<FontsShape>({
  sans: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  secondary: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  mono: '"JetBrains Mono", "Menlo", "Monaco", "SF Mono", "Fira Code", monospace',
  size: 13,
  monoSize: 13,
  lineHeight: 1.5,
  weight: 400,
  monoLineHeight: 1.5,
  monoWeight: 400,
  secondarySize: 11,
  secondaryLineHeight: 1.4,
  secondaryWeight: 400,
})

function useFonts() { return React.useContext(AskUserQuestionFontsContext) }

// --- AskUserQuestionForm -----------------------------------------------------

interface AskUserQuestionFormProps {
  toolId: string
  payload: AskUserQuestionPayload
  onSubmitted: () => void
}

export function AskUserQuestionForm({ toolId, payload, onSubmitted }: AskUserQuestionFormProps): JSX.Element {
  const theme = useTheme()
  const fonts = useFonts()
  const ctx = React.useContext(AskUserQuestionContext)
  // For single-select: Map<questionIndex, selectedLabel | '__other__'>
  // For multi-select:  Map<questionIndex, Set<selectedLabel | '__other__'>>
  const [singleChoice, setSingleChoice] = useState<Record<number, string>>({})
  const [multiChoice, setMultiChoice] = useState<Record<number, Set<string>>>({})
  const [otherText, setOtherText] = useState<Record<number, string>>({})
  const [previewIdx, setPreviewIdx] = useState<Record<number, number | null>>({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggleMulti = useCallback((qIdx: number, label: string) => {
    setMultiChoice(prev => {
      const cur = new Set(prev[qIdx] ?? [])
      if (cur.has(label)) cur.delete(label)
      else cur.add(label)
      return { ...prev, [qIdx]: cur }
    })
  }, [])

  const allAnswered = useMemo(() => {
    return payload.questions.every((q, idx) => {
      if (q.multiSelect) {
        const set = multiChoice[idx]
        if (!set || set.size === 0) return false
        if (set.has('__other__') && !(otherText[idx]?.trim())) return false
        return true
      } else {
        const pick = singleChoice[idx]
        if (!pick) return false
        if (pick === '__other__' && !(otherText[idx]?.trim())) return false
        return true
      }
    })
  }, [payload.questions, singleChoice, multiChoice, otherText])

  const handleSubmit = useCallback(async () => {
    if (!ctx?.workspaceId || !ctx.cardId) { setError('Chat context unavailable'); return }
    if (!allAnswered || submitting) return
    setSubmitting(true)
    setError(null)
    const answers: Record<string, string> = {}
    const annotations: Record<string, { notes?: string; preview?: string }> = {}
    payload.questions.forEach((q, idx) => {
      const otherTxt = otherText[idx]?.trim() ?? ''
      let labelOut: string
      if (q.multiSelect) {
        const set = multiChoice[idx] ?? new Set<string>()
        const parts: string[] = []
        for (const v of set) {
          if (v === '__other__') parts.push(otherTxt)
          else parts.push(v)
        }
        labelOut = parts.join(', ')
      } else {
        const pick = singleChoice[idx] ?? ''
        labelOut = pick === '__other__' ? otherTxt : pick
      }
      answers[q.question] = labelOut
      // If a preview option is focused, include it as annotation.
      const pIdx = previewIdx[idx]
      if (pIdx != null && q.options[pIdx]?.preview) {
        annotations[q.question] = { preview: q.options[pIdx].preview }
      }
    })
    try {
      const res = await window.electron?.chat?.answerUserQuestion?.({
        workspaceId: ctx.workspaceId,
        cardId: ctx.cardId,
        toolId,
        answers,
        annotations: Object.keys(annotations).length > 0 ? annotations : undefined,
      })
      if (res && res.ok === false) {
        setError(res.error ?? 'Failed to submit')
        setSubmitting(false)
        return
      }
      onSubmitted()
    } catch (err) {
      setError((err as Error).message || 'Failed to submit')
      setSubmitting(false)
    }
  }, [ctx?.workspaceId, ctx?.cardId, toolId, payload.questions, singleChoice, multiChoice, otherText, previewIdx, allAnswered, submitting, onSubmitted])

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 12,
      padding: 12,
      borderTop: `1px solid ${theme.chat.assistantBubbleBorder}`,
      fontFamily: fonts.sans, fontSize: 12, color: theme.chat.text,
    }}>
      {payload.questions.map((q, qIdx) => {
        const activePreview = previewIdx[qIdx] != null ? q.options[previewIdx[qIdx] as number]?.preview : null
        return (
          <div key={qIdx} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {q.header && (
                <span style={{
                  fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4,
                  color: theme.chat.muted,
                  background: theme.chat.assistantBubble,
                  border: `1px solid ${theme.chat.assistantBubbleBorder}`,
                  padding: '2px 6px', borderRadius: 4,
                }}>{q.header}</span>
              )}
              {q.multiSelect && (
                <span style={{ fontSize: 9, color: theme.chat.muted }}>(choose any)</span>
              )}
            </div>
            <div style={{ fontWeight: 500, fontSize: 13, lineHeight: 1.35 }}>{q.question}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 2 }}>
              {q.options.map((opt, oIdx) => {
                const checked = q.multiSelect
                  ? (multiChoice[qIdx]?.has(opt.label) ?? false)
                  : singleChoice[qIdx] === opt.label
                return (
                  <label
                    key={oIdx}
                    onMouseEnter={() => { if (opt.preview) setPreviewIdx(p => ({ ...p, [qIdx]: oIdx })) }}
                    style={{
                      display: 'flex', alignItems: 'flex-start', gap: 8,
                      padding: '6px 8px',
                      borderRadius: 6,
                      border: `1px solid ${checked ? theme.accent.base : theme.chat.assistantBubbleBorder}`,
                      background: checked ? theme.chat.assistantBubble : 'transparent',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type={q.multiSelect ? 'checkbox' : 'radio'}
                      name={`ask-${toolId}-${qIdx}`}
                      checked={checked}
                      onChange={() => {
                        if (q.multiSelect) toggleMulti(qIdx, opt.label)
                        else setSingleChoice(prev => ({ ...prev, [qIdx]: opt.label }))
                      }}
                      style={{ marginTop: 2, accentColor: theme.accent.base }}
                    />
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
                      <span style={{ fontWeight: 500, fontSize: 12 }}>{opt.label}</span>
                      {opt.description && (
                        <span style={{ fontSize: 11, color: theme.chat.muted, lineHeight: 1.35 }}>{opt.description}</span>
                      )}
                    </div>
                  </label>
                )
              })}
              {/* Auto-included "Other" freeform option */}
              {(() => {
                const otherChecked = q.multiSelect
                  ? (multiChoice[qIdx]?.has('__other__') ?? false)
                  : singleChoice[qIdx] === '__other__'
                return (
                  <label
                    style={{
                      display: 'flex', alignItems: 'flex-start', gap: 8,
                      padding: '6px 8px',
                      borderRadius: 6,
                      border: `1px solid ${otherChecked ? theme.accent.base : theme.chat.assistantBubbleBorder}`,
                      background: otherChecked ? theme.chat.assistantBubble : 'transparent',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type={q.multiSelect ? 'checkbox' : 'radio'}
                      name={`ask-${toolId}-${qIdx}`}
                      checked={otherChecked}
                      onChange={() => {
                        if (q.multiSelect) toggleMulti(qIdx, '__other__')
                        else setSingleChoice(prev => ({ ...prev, [qIdx]: '__other__' }))
                      }}
                      style={{ marginTop: 2, accentColor: theme.accent.base }}
                    />
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: 1 }}>
                      <span style={{ fontWeight: 500, fontSize: 12 }}>Other…</span>
                      <input
                        type="text"
                        placeholder="Type your own answer"
                        value={otherText[qIdx] ?? ''}
                        onFocus={() => {
                          if (q.multiSelect) {
                            if (!(multiChoice[qIdx]?.has('__other__'))) toggleMulti(qIdx, '__other__')
                          } else {
                            setSingleChoice(prev => ({ ...prev, [qIdx]: '__other__' }))
                          }
                        }}
                        onChange={e => setOtherText(prev => ({ ...prev, [qIdx]: e.target.value }))}
                        style={{
                          background: theme.chat.input,
                          color: theme.chat.text,
                          border: `1px solid ${theme.chat.inputBorder}`,
                          borderRadius: 4,
                          padding: '4px 6px',
                          fontSize: 12,
                          fontFamily: fonts.sans,
                          outline: 'none',
                        }}
                      />
                    </div>
                  </label>
                )
              })()}
            </div>
            {activePreview && (
              <pre style={{
                background: theme.chat.input,
                color: theme.chat.text,
                border: `1px solid ${theme.chat.inputBorder}`,
                borderRadius: 6,
                padding: 8,
                fontSize: 11,
                fontFamily: fonts.mono,
                whiteSpace: 'pre-wrap',
                overflow: 'auto',
                maxHeight: 180,
                margin: 0,
              }}>{activePreview}</pre>
            )}
          </div>
        )
      })}
      {error && (
        <div style={{ fontSize: 11, color: theme.status.danger }}>{error}</div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button
          type="button"
          disabled={!allAnswered || submitting}
          onClick={handleSubmit}
          style={{
            background: allAnswered && !submitting ? theme.accent.base : theme.chat.assistantBubble,
            color: allAnswered && !submitting ? theme.chat.input : theme.chat.muted,
            border: `1px solid ${allAnswered && !submitting ? theme.accent.base : theme.chat.assistantBubbleBorder}`,
            borderRadius: 6,
            padding: '6px 14px',
            fontSize: 12,
            fontFamily: fonts.sans,
            fontWeight: 500,
            cursor: allAnswered && !submitting ? 'pointer' : 'not-allowed',
            opacity: submitting ? 0.7 : 1,
          }}
        >
          {submitting ? 'Sending…' : 'Submit answer'}
        </button>
      </div>
    </div>
  )
}

// --- AskUserQuestionChip -----------------------------------------------------

/**
 * Chip-shell wrapper around AskUserQuestionForm so the rendering matches the
 * look of other tool blocks (bordered card with a header row).
 */
export function AskUserQuestionChip({ block, payload }: { block: ToolBlock; payload: AskUserQuestionPayload }): JSX.Element {
  const theme = useTheme()
  const fonts = useFonts()
  const [submitted, setSubmitted] = useState(false)
  return (
    <div
      data-ask-user-question={block.id}
      style={{
        background: theme.chat.assistantBubble,
        border: `1px solid ${theme.chat.assistantBubbleBorder}`,
        borderRadius: 10,
        overflow: 'hidden',
        alignSelf: 'stretch',
        width: '100%',
      }}
    >
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '8px 12px',
        fontSize: 10.5,
        fontFamily: fonts.sans,
        color: theme.chat.muted,
        textTransform: 'uppercase',
        letterSpacing: 0.6,
      }}>
        <MessageSquare size={11} />
        <span>Question</span>
        {submitted && (
          <span style={{
            marginLeft: 'auto',
            display: 'flex', alignItems: 'center', gap: 4,
            color: theme.status.success,
            textTransform: 'none', letterSpacing: 0,
            fontSize: 11,
          }}>
            <Check size={11} /> Answer sent
          </span>
        )}
      </div>
      {submitted ? (
        <div style={{
          padding: '0 12px 12px',
          fontSize: 12, fontFamily: fonts.sans, color: theme.chat.muted,
        }}>
          Waiting for the agent to continue…
        </div>
      ) : (
        <AskUserQuestionForm
          toolId={block.id}
          payload={payload}
          onSubmitted={() => setSubmitted(true)}
        />
      )}
    </div>
  )
}
