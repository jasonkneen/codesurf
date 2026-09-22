/**
 * BlockNoteAffordance
 * -------------------
 *
 * Wraps an individual chat "block" (user message, assistant message, tool
 * call, thinking block) and adds:
 *
 *   - A hover-triggered note icon that floats in the gutter on the side
 *     opposite the block's natural alignment ("smart side" — user bubbles
 *     are right-aligned so the icon appears on the left, and vice versa for
 *     assistant / tool / thinking blocks).
 *   - A composer popover that opens when the icon is clicked, anchored
 *     to the block. Typing in the composer pauses chat auto-scroll via an
 *     `onComposerActiveChange(true)` callback.
 *   - An attached note card, rendered in the margin when the containing
 *     column has room, otherwise inline just below the block.
 *
 * Persistence is handled by the parent: `onUpdateNote(text | null)` is
 * called with the final text (or `null` to delete). The component itself
 * is fully controlled — it reflects `note` and never stores the saved
 * text locally.
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { MessageSquarePlus, MessageSquareText, Trash2, Check, X } from 'lucide-react'
import type { BlockNote } from '../../../../shared/chat-types'
import { useTheme } from '../../ThemeContext'

export type BlockNoteSide = 'left' | 'right'

export interface BlockNoteAffordanceProps {
  note: BlockNote | undefined
  onUpdateNote: (text: string | null) => void
  /** Called with `true` when the composer opens (or its text becomes
   *  non-empty) and `false` when it closes. Drives auto-scroll suppression. */
  onComposerActiveChange?: (active: boolean) => void
  /** Which side the gutter icon/card lives on. Pick the opposite of the
   *  block's natural alignment. Defaults to 'right'. */
  side?: BlockNoteSide
  /** How far from the block edge to offset the note card, in pixels.
   *  Cards will render further into the gutter when there's room; if the
   *  parent doesn't have gutter space, the card falls back inline. */
  gutterOffset?: number
  /** Minimum viewport width below which we render the note card inline
   *  (below the block) instead of in the gutter. */
  inlineBreakpoint?: number
  children: React.ReactNode
}

const COMPOSER_MIN_WIDTH = 220
const NOTE_CARD_WIDTH = 200

export function BlockNoteAffordance({
  note,
  onUpdateNote,
  onComposerActiveChange,
  side = 'right',
  gutterOffset = 16,
  inlineBreakpoint = 540,
  children,
}: BlockNoteAffordanceProps): React.JSX.Element {
  const theme = useTheme()
  const wrapperRef = useRef<HTMLDivElement>(null)
  const iconButtonRef = useRef<HTMLButtonElement>(null)
  const composerSurfaceRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const [isHovering, setIsHovering] = useState(false)
  const [composerOpen, setComposerOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [useInline, setUseInline] = useState(false)
  // Runtime placement chosen on open. 'primary' = the configured side
  // (composer hugs the wrapper edge on the same side as the icon),
  // 'inline' = stacked below the block. Picked at open time so we never
  // pop open too narrow to type in.
  const [composerPlacement, setComposerPlacement] = useState<'primary' | 'inline'>('primary')

  // Grace-period hide: the icon lives in the gutter a little off to the side
  // of the block, so moving the pointer from block → icon means briefly
  // crossing an empty region that's neither the block nor the icon. Without a
  // delay the icon would fade out mid-transit and the user's click would
  // land on nothing. We schedule the hide and cancel it if the pointer
  // re-enters the block OR the icon before the timer elapses.
  const hideTimerRef = useRef<number | null>(null)
  const cancelHide = useCallback(() => {
    if (hideTimerRef.current != null) {
      window.clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
  }, [])
  const scheduleHide = useCallback(() => {
    cancelHide()
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null
      setIsHovering(false)
    }, 700)
  }, [cancelHide])
  useEffect(() => () => cancelHide(), [cancelHide])

  // Track whether the composer should be reported as "active" — used to
  // pause auto-scroll in the parent. Active means open AND the user has
  // typed something (so the parent doesn't drag the viewport out from
  // under them while they're composing a note).
  const lastActiveRef = useRef(false)
  useEffect(() => {
    const active = composerOpen && draft.trim().length > 0
    if (active === lastActiveRef.current) return
    lastActiveRef.current = active
    onComposerActiveChange?.(active)
  }, [composerOpen, draft, onComposerActiveChange])

  // On composer close, always clear the active signal so auto-scroll resumes.
  useEffect(() => {
    if (composerOpen) return
    if (!lastActiveRef.current) return
    lastActiveRef.current = false
    onComposerActiveChange?.(false)
  }, [composerOpen, onComposerActiveChange])

  // Smart side fallback: measure available gutter space; if the wrapper is
  // sitting in a tight parent, render inline below the block instead.
  useLayoutEffect(() => {
    const el = wrapperRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        const width = entry.contentRect.width
        // If the block itself is narrow (e.g. chat column is compressed)
        // fall back to inline placement. The threshold is intentionally
        // loose — feel free to tune.
        setUseInline(width < inlineBreakpoint)
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [inlineBreakpoint])

  const openComposer = useCallback(() => {
    setDraft(note?.text ?? '')
    // Composer anchors INSIDE the wrapper on the same side as the icon, so
    // it can never be clipped by an overflow:hidden ancestor (chat tile /
    // panel). The only placement decision is "on-side" vs "inline below" —
    // inline kicks in when `useInline` says the wrapper itself is too
    // narrow to fit the composer at its min-width.
    setComposerPlacement(useInline ? 'inline' : 'primary')
    setComposerOpen(true)
    // Focus the textarea on next frame so layout has settled.
    requestAnimationFrame(() => {
      composerRef.current?.focus()
      composerRef.current?.setSelectionRange(
        composerRef.current.value.length,
        composerRef.current.value.length,
      )
    })
  }, [note?.text, useInline])

  const closeComposer = useCallback(() => {
    setComposerOpen(false)
    setDraft('')
  }, [])

  useEffect(() => {
    if (!composerOpen) return

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (composerSurfaceRef.current?.contains(target)) return
      if (iconButtonRef.current?.contains(target)) return
      closeComposer()
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeComposer()
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [composerOpen, closeComposer])

  const submitDraft = useCallback(() => {
    const trimmed = draft.trim()
    if (trimmed) {
      onUpdateNote(trimmed)
    } else if (note) {
      // Empty submit clears an existing note — matches the "delete" affordance.
      onUpdateNote(null)
    }
    closeComposer()
  }, [draft, onUpdateNote, note, closeComposer])

  const deleteNote = useCallback(() => {
    onUpdateNote(null)
    closeComposer()
  }, [onUpdateNote, closeComposer])

  const handleKeyDown = (ev: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.metaKey && !ev.ctrlKey) {
      ev.preventDefault()
      submitDraft()
    } else if (ev.key === 'Escape') {
      ev.preventDefault()
      closeComposer()
    } else if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
      ev.preventDefault()
      submitDraft()
    }
  }

  // The icon should be visible if the user is hovering the block OR if the
  // composer is open OR a note already exists (so it remains clickable).
  const iconVisible = isHovering || composerOpen || Boolean(note)

  const iconSideStyle: React.CSSProperties = side === 'left'
    ? { left: -gutterOffset - 14, right: 'auto' }
    : { right: -gutterOffset - 14, left: 'auto' }

  const cardSideStyle: React.CSSProperties = side === 'left'
    ? { left: -gutterOffset - NOTE_CARD_WIDTH, right: 'auto' }
    : { right: -gutterOffset - NOTE_CARD_WIDTH, left: 'auto' }

  // The composer popover anchors to the block and stays INSIDE the wrapper
  // so it can't spill past the chat tile's clipping edge. The configured
  // `side` controls which edge it hugs (matching the icon); when the
  // wrapper is too narrow to fit COMPOSER_MIN_WIDTH we stack inline below.
  const composerSideStyle: React.CSSProperties = composerPlacement === 'inline' || useInline
    ? { left: 0, right: 0, top: 'calc(100% + 6px)', minWidth: 0 }
    : side === 'left'
      ? { left: 0, right: 'auto', top: 0, minWidth: COMPOSER_MIN_WIDTH, maxWidth: '100%' }
      : { right: 0, left: 'auto', top: 0, minWidth: COMPOSER_MIN_WIDTH, maxWidth: '100%' }

  return (
    <div
      ref={wrapperRef}
      onMouseEnter={() => { cancelHide(); setIsHovering(true) }}
      onMouseLeave={scheduleHide}
      style={{
        position: 'relative',
        // We don't clip — children (icon / card / composer) spill into the
        // gutter by design. If a parent clips horizontally the card will
        // fall back to inline via the ResizeObserver check above.
        overflow: 'visible',
        // Flex layout on the wrapper so the child block honours its intended
        // horizontal alignment. The gutter side tells us which edge the
        // *note* lives on, so the *block* anchors to the opposite edge:
        //   side='left'  → note on the left, block on the right (user bubble)
        //   side='right' → note on the right, block on the left (assistant)
        display: 'flex',
        justifyContent: side === 'left' ? 'flex-end' : 'flex-start',
      }}
    >
      {children}

      {/* Hover-triggered note icon */}
      <button
        ref={iconButtonRef}
        type="button"
        aria-label={note ? 'Edit note' : 'Add note'}
        title={note ? 'Edit note' : 'Add note'}
        onMouseEnter={() => { cancelHide(); setIsHovering(true) }}
        onMouseLeave={scheduleHide}
        onClick={(ev) => {
          ev.stopPropagation()
          cancelHide()
          openComposer()
        }}
        style={{
          position: 'absolute',
          top: 2,
          width: 22,
          height: 22,
          borderRadius: 6,
          border: `1px solid ${theme.border.subtle}`,
          background: note ? theme.accent.soft : theme.surface.panel,
          color: note ? theme.accent.base : theme.text.secondary,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          padding: 0,
          opacity: iconVisible ? 1 : 0,
          transform: iconVisible ? 'scale(1)' : 'scale(0.85)',
          transition: 'opacity 0.12s ease, transform 0.12s ease',
          pointerEvents: iconVisible ? 'auto' : 'none',
          zIndex: 2,
          ...iconSideStyle,
        }}
      >
        {note
          ? <MessageSquareText size={13} />
          : <MessageSquarePlus size={13} />
        }
      </button>

      {/* Rendered note card — only shown when a note exists and composer is closed */}
      {note && !composerOpen && (
        useInline
          ? (
            <div style={{
              marginTop: 6,
              padding: '8px 10px',
              borderRadius: 8,
              border: `1px solid ${theme.border.subtle}`,
              background: theme.surface.panel,
              color: theme.text.secondary,
              fontSize: 12,
              lineHeight: 1.4,
              cursor: 'pointer',
              position: 'relative',
            }} onClick={openComposer}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <MessageSquareText size={11} color={theme.accent.base} />
                <span style={{ fontSize: 10, fontWeight: 600, color: theme.accent.base, letterSpacing: 0.3, textTransform: 'uppercase' }}>
                  Note
                </span>
              </div>
              <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{note.text}</div>
            </div>
          )
          : (
            <div style={{
              position: 'absolute',
              top: 2,
              width: NOTE_CARD_WIDTH,
              padding: '8px 10px',
              borderRadius: 8,
              border: `1px solid ${theme.border.subtle}`,
              background: theme.surface.panel,
              color: theme.text.secondary,
              fontSize: 12,
              lineHeight: 1.4,
              cursor: 'pointer',
              zIndex: 1,
              boxShadow: theme.shadow.panel,
              ...cardSideStyle,
            }} onClick={openComposer}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <MessageSquareText size={11} color={theme.accent.base} />
                <span style={{ fontSize: 10, fontWeight: 600, color: theme.accent.base, letterSpacing: 0.3, textTransform: 'uppercase' }}>
                  Note
                </span>
              </div>
              <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{note.text}</div>
            </div>
          )
      )}

      {/* Composer popover */}
      {composerOpen && (
        <div
          ref={composerSurfaceRef}
          onClick={(ev) => ev.stopPropagation()}
          style={{
            position: 'absolute',
            padding: 10,
            borderRadius: 10,
            border: `1px solid ${theme.border.strong}`,
            background: theme.surface.panel,
            boxShadow: theme.shadow.panel,
            zIndex: 5,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            ...composerSideStyle,
          }}
        >
          <textarea
            ref={composerRef}
            value={draft}
            onChange={(ev) => setDraft(ev.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Add notes / context to remember…"
            rows={3}
            style={{
              resize: 'vertical',
              minHeight: 60,
              maxHeight: 240,
              padding: 8,
              borderRadius: 6,
              border: `1px solid ${theme.border.default}`,
              background: theme.surface.panelMuted,
              color: theme.text.primary,
              fontSize: 12,
              lineHeight: 1.4,
              fontFamily: 'inherit',
              outline: 'none',
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' }}>
            <div style={{ fontSize: 10, color: theme.text.disabled }}>
              ⏎ save · ⇧⏎ newline · esc cancel
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              {note && (
                <button
                  type="button"
                  onClick={deleteNote}
                  title="Delete note"
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: 6,
                    border: `1px solid ${theme.border.subtle}`,
                    background: 'transparent',
                    color: theme.status.danger,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Trash2 size={13} />
                </button>
              )}
              <button
                type="button"
                onClick={closeComposer}
                title="Cancel"
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 6,
                  border: `1px solid ${theme.border.subtle}`,
                  background: 'transparent',
                  color: theme.text.secondary,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <X size={13} />
              </button>
              <button
                type="button"
                onClick={submitDraft}
                title="Save note"
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 6,
                  border: `1px solid ${theme.accent.base}`,
                  background: theme.accent.base,
                  color: theme.text.inverse,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Check size={13} />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default BlockNoteAffordance
