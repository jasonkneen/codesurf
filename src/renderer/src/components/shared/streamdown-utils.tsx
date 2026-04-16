/**
 * Shared Streamdown rendering utilities used by ChatTile and KanbanCard.
 * Eliminates duplication of code-block patching, shimmer animations,
 * link-click handling, and plugin config.
 */
import React, { useEffect, useRef } from 'react'
import { Streamdown } from 'streamdown'
import { code } from '@streamdown/code'
import 'streamdown/styles.css'
import { useTheme } from '../../ThemeContext'
import { useAppFonts } from '../../FontContext'
import { dispatchOpenLink, findAnchorFromEventTarget } from '../../utils/links'

// --- Streamdown plugins (singleton) ------------------------------------------------
export const streamdownPlugins = { code }

// --- Shimmer / animation keyframes (injected once globally) -----------------------
const SHIMMER_STYLE_ID = 'shared-streamdown-shimmer'

export function ensureShimmerStyles(): void {
  if (document.getElementById(SHIMMER_STYLE_ID)) return
  const style = document.createElement('style')
  style.id = SHIMMER_STYLE_ID
  style.textContent = `
    @keyframes chat-shimmer {
      0% { background-position: -200% 0; }
      100% { background-position: 200% 0; }
    }
    @keyframes chat-shimmer-text {
      0% { background-position: var(--shimmer-start, -100px) 0; }
      100% { background-position: var(--shimmer-end, 200px) 0; }
    }
    @keyframes chat-dot-bounce {
      0%, 80%, 100% { transform: translateY(0); }
      40% { transform: translateY(-4px); }
    }
    @keyframes chat-spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    @keyframes chat-pulse {
      0%, 100% { opacity: 0.4; }
      50% { opacity: 1; }
    }
  `
  document.head.appendChild(style)
}

// --- ShimmerText component ---------------------------------------------------------
export function ShimmerText({ children, style, baseColor = '#888' }: {
  children: React.ReactNode
  style?: React.CSSProperties
  baseColor?: string
}): JSX.Element {
  return (
    <span style={{
      display: 'block',
      minWidth: 0,
      flexShrink: 1,
      color: 'transparent',
      backgroundImage: `linear-gradient(90deg, ${baseColor} 0%, ${baseColor} 35%, #fff 50%, ${baseColor} 65%, ${baseColor} 100%)`,
      backgroundSize: '200% 100%',
      backgroundClip: 'text',
      WebkitBackgroundClip: 'text',
      WebkitTextFillColor: 'transparent',
      animation: 'chat-shimmer 1.8s linear infinite',
      ...style,
    }}>
      {children}
    </span>
  )
}

// --- WorkingDots component ---------------------------------------------------------
export function WorkingDots({ color, size = 5 }: { color?: string; size?: number }): JSX.Element {
  const theme = useTheme()
  return (
    <span style={{ display: 'inline-flex', gap: 3, padding: '2px 0' }}>
      {[0, 1, 2].map(i => (
        <span
          key={i}
          style={{
            width: size,
            height: size,
            borderRadius: '50%',
            background: color ?? theme.accent.base,
            animation: `chat-dot-bounce 1.2s ease-in-out ${i * 0.15}s infinite`,
          }}
        />
      ))}
    </span>
  )
}

// --- usePatchCodeBlocks hook -------------------------------------------------------
// Patches Streamdown-rendered code blocks and tables with theme-aware styles.
export function usePatchCodeBlocks(
  ref: React.RefObject<HTMLDivElement | null>,
  theme: ReturnType<typeof useTheme>,
  fonts: ReturnType<typeof useAppFonts>,
): void {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const shellBackground = theme.mode === 'light' ? theme.surface.panel : theme.surface.panelMuted
    const bodyBackground = theme.mode === 'light' ? theme.surface.panelMuted : '#0f131d'
    const headerBackground = theme.mode === 'light' ? theme.surface.panel : '#171c28'
    const headerColor = theme.text.muted
    const tableShellBackground = theme.mode === 'light' ? theme.surface.panelMuted : theme.surface.panel
    const tableInnerBackground = theme.mode === 'light' ? theme.chat.background : '#11161f'
    const tableHeaderBackground = theme.mode === 'light' ? theme.surface.panelElevated : '#1a2230'
    const fontSize = Math.max(12, fonts.size - 1)

    // Code blocks
    const blocks = el.querySelectorAll<HTMLElement>('[data-streamdown="code-block"]')
    blocks.forEach(block => {
      block.style.cssText = `padding:0!important;gap:0!important;margin:6px 0!important;border-radius:6px!important;overflow:hidden!important;border:1px solid ${theme.border.default}!important;max-width:100%!important;background:${shellBackground}!important;color:${theme.text.primary}!important`
      const header = block.querySelector<HTMLElement>('[data-streamdown="code-block-header"]')
      if (header) {
        header.style.cssText = `height:22px!important;font-size:10px!important;padding:0 8px!important;background:${headerBackground}!important;color:${headerColor}!important;border-bottom:1px solid ${theme.border.subtle}!important`
      }
      const actionsWrapper = block.querySelector<HTMLElement>('[data-streamdown="code-block-actions"]')?.parentElement
      if (actionsWrapper) actionsWrapper.style.cssText = 'margin-top:-22px!important;height:22px!important;pointer-events:none;position:sticky;top:0;z-index:10;display:flex;align-items:center;justify-content:flex-end'
      const actions = block.querySelector<HTMLElement>('[data-streamdown="code-block-actions"]')
      if (actions) {
        actions.style.cssText = 'padding:1px 4px!important;pointer-events:auto'
        actions.querySelectorAll<HTMLElement>('button').forEach(btn => {
          btn.style.cssText = 'width:18px!important;height:18px!important;padding:1px!important'
        })
        actions.querySelectorAll<SVGElement>('svg').forEach(svg => {
          svg.setAttribute('width', '11')
          svg.setAttribute('height', '11')
        })
      }
      const body = block.querySelector<HTMLElement>('[data-streamdown="code-block-body"]')
      if (body) {
        body.style.cssText = `padding:8px 10px!important;font-size:${fontSize}px!important;border:none!important;border-radius:0!important;background:${bodyBackground}!important;color:${theme.text.primary}!important`
      }
      block.querySelectorAll<HTMLElement>('pre').forEach(pre => {
        pre.style.cssText += `;font-size:${fontSize}px!important;line-height:1.5!important;margin:0!important;border-radius:0!important;white-space:pre!important;background:${bodyBackground}!important;color:${theme.text.primary}!important`
      })
      block.querySelectorAll<HTMLElement>('pre > code').forEach(codeEl => {
        codeEl.style.cssText += `;font-size:${fontSize}px!important;line-height:1.5!important;color:${theme.text.primary}!important;background:transparent!important`
        codeEl.querySelectorAll<HTMLElement>(':scope > span').forEach(line => {
          line.style.display = 'block'
        })
      })
      block.querySelectorAll<HTMLElement>('button').forEach(button => {
        button.style.color = headerColor
      })
    })

    // Tables
    const tables = el.querySelectorAll<HTMLElement>('[data-streamdown="table-wrapper"]')
    tables.forEach(wrapper => {
      wrapper.style.cssText = `margin:8px 0!important;padding:8px!important;gap:0!important;border-radius:8px!important;overflow:hidden!important;border:1px solid ${theme.border.default}!important;background:${tableShellBackground}!important;color:${theme.text.primary}!important`

      const scroller = wrapper.querySelector<HTMLElement>('[data-streamdown="table"]')?.parentElement
      if (scroller) {
        scroller.style.cssText = `border:1px solid ${theme.border.subtle}!important;border-radius:6px!important;overflow:auto!important;background:${tableInnerBackground}!important`
      }

      const table = wrapper.querySelector<HTMLElement>('[data-streamdown="table"]')
      if (table) {
        table.style.cssText = `width:100%!important;border-collapse:collapse!important;background:${tableInnerBackground}!important;color:${theme.text.primary}!important`
      }

      const thead = wrapper.querySelector<HTMLElement>('[data-streamdown="table-header"]')
      if (thead) {
        thead.style.cssText = `background:${tableHeaderBackground}!important;color:${theme.text.primary}!important`
      }

      wrapper.querySelectorAll<HTMLElement>('[data-streamdown="table-row"]').forEach(row => {
        row.style.borderColor = theme.border.subtle
      })
      wrapper.querySelectorAll<HTMLElement>('[data-streamdown="table-header-cell"]').forEach(cell => {
        cell.style.cssText = `background:${tableHeaderBackground}!important;color:${theme.text.primary}!important;border:1px solid ${theme.border.subtle}!important;padding:8px 10px!important`
      })
      wrapper.querySelectorAll<HTMLElement>('[data-streamdown="table-cell"]').forEach(cell => {
        cell.style.cssText = `background:${tableInnerBackground}!important;color:${theme.text.primary}!important;border:1px solid ${theme.border.subtle}!important;padding:8px 10px!important`
      })
    })
  }, [fonts.size, ref, theme.border.default, theme.border.subtle, theme.chat.background, theme.mode, theme.surface.panel, theme.surface.panelElevated, theme.surface.panelMuted, theme.text.muted, theme.text.primary])
}

// --- useLinkClickHandler hook ------------------------------------------------------
// Intercepts anchor clicks inside a ref container and routes them through dispatchOpenLink.
export function useLinkClickHandler(ref: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = ref.current
    if (!root) return

    const handleClick = (event: MouseEvent) => {
      const anchor = findAnchorFromEventTarget(event)
      if (!anchor) return

      const href = anchor.getAttribute('href') ?? ''
      if (!dispatchOpenLink(href)) return

      event.preventDefault()
      event.stopPropagation()
    }

    root.addEventListener('click', handleClick, true)
    return () => root.removeEventListener('click', handleClick, true)
  }, [ref])
}

// --- ChatMarkdown component -------------------------------------------------------
// Renders markdown content with Streamdown, applying theme patches for code blocks and tables.
export const ChatMarkdown = React.memo(({ text, isStreaming, className }: {
  text: string
  isStreaming?: boolean
  className?: string
}) => {
  const ref = useRef<HTMLDivElement>(null)
  const theme = useTheme()
  const fonts = useAppFonts()
  usePatchCodeBlocks(ref, theme, fonts)
  useLinkClickHandler(ref)

  return (
    <div
      ref={ref}
      style={{
        minWidth: 0,
        maxWidth: '100%',
        width: '100%',
        overflow: 'hidden',
        ['--chat-link-color' as string]: theme.accent.base,
        ['--chat-link-hover-color' as string]: theme.accent.hover,
      }}
    >
      <Streamdown
        className={`chat-md ${className ?? ''}`}
        plugins={streamdownPlugins}
        mode={isStreaming ? 'streaming' : 'static'}
        shikiTheme={
          theme.mode === 'light'
            ? ['github-light', 'github-light']
            : ['github-dark', 'github-dark']
        }
        controls={{ code: { copy: true, download: false }, table: false, mermaid: false }}
        lineNumbers={false}
      >
        {text}
      </Streamdown>
    </div>
  )
})
