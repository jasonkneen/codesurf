/**
 * Shared Streamdown rendering utilities used by ChatTile and KanbanCard.
 * Eliminates duplication of code-block patching, shimmer animations,
 * link-click handling, and plugin config.
 */
import React, { useEffect, useRef } from 'react'
import { Streamdown } from 'streamdown'
import 'streamdown/styles.css'
import { useTheme } from '../../ThemeContext'
import { useAppFonts } from '../../FontContext'
import { useThemeTokens } from '../../theme-tokens'
import { dispatchOpenLink, findAnchorFromEventTarget, normalizeLocalPathCandidate } from '../../utils/links'

// --- Streamdown plugins -----------------------------------------------------------
// Keep the heavy @streamdown/code/Shiki path out of the initial ChatTile chunk.
// Most chat turns are prose/tool chips; loading the syntax highlighter eagerly
// pulled ~1.3MB into streamdown-utils plus hundreds of language chunks. We only
// import it once a fenced code block actually appears, then cache it globally.
export const streamdownPlugins: Record<string, never> = {}

const EMPTY_STREAMDOWN_PLUGINS = Object.freeze({})
const FENCED_CODE_RE = /(^|\n)\s*(```|~~~)/
let cachedCodePlugin: unknown | null = null
let codePluginPromise: Promise<unknown> | null = null

function loadCodePlugin(): Promise<unknown> {
  if (!codePluginPromise) {
    codePluginPromise = import('@streamdown/code').then(mod => {
      cachedCodePlugin = mod.code
      return cachedCodePlugin
    })
  }
  return codePluginPromise
}

function useStreamdownPlugins(text: string): Record<string, unknown> {
  const needsCodePlugin = FENCED_CODE_RE.test(text)
  const [codePlugin, setCodePlugin] = React.useState<unknown | null>(() => needsCodePlugin ? cachedCodePlugin : null)

  useEffect(() => {
    let cancelled = false
    if (!needsCodePlugin) {
      if (codePlugin) setCodePlugin(null)
      return () => { cancelled = true }
    }
    if (cachedCodePlugin) {
      setCodePlugin(cachedCodePlugin)
      return () => { cancelled = true }
    }
    void loadCodePlugin().then(plugin => {
      if (!cancelled) setCodePlugin(plugin)
    })
    return () => { cancelled = true }
  }, [needsCodePlugin, codePlugin])

  return React.useMemo(() => {
    return needsCodePlugin && codePlugin ? { code: codePlugin } : EMPTY_STREAMDOWN_PLUGINS
  }, [needsCodePlugin, codePlugin])
}

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

// --- Streamdown code-block layout fix (injected once globally) --------------------
// Streamdown only adds a block-level line class when lineNumbers is enabled. When
// lineNumbers is off, each code line is rendered as an inline <span>, which makes
// multiple source lines collapse onto a single visual row and overflow horizontally.
// We force line-spans to display:block and ensure the body scrolls horizontally so
// long lines don't clip. This is applied via CSS so it survives async Shiki
// highlighting (useEffect-based DOM patches can race with it).
// Bump this version suffix whenever the injected CSS below changes so that
// Vite HMR re-injects a fresh <style> tag instead of short-circuiting on the
// stale one left behind from a previous build.
const CODE_LAYOUT_STYLE_VERSION = 'v11'
const CODE_LAYOUT_STYLE_ID = `shared-streamdown-code-layout-${CODE_LAYOUT_STYLE_VERSION}`

export function ensureCodeBlockLayoutStyles(): void {
  if (document.getElementById(CODE_LAYOUT_STYLE_ID)) return
  // Tear down any older versions so their outdated rules stop applying.
  document.querySelectorAll('style[id^="shared-streamdown-code-layout"]').forEach(node => {
    if (node.id !== CODE_LAYOUT_STYLE_ID) node.remove()
  })
  const style = document.createElement('style')
  style.id = CODE_LAYOUT_STYLE_ID
  // Font size is CSS-based so it survives Shiki's async DOM replacement (which
  // happens after usePatchCodeBlocks' useEffect runs and wipes inline styles).
  style.textContent = `
    /* Outer code-block: kill streamdown's intrinsic-size placeholder that
       leaves a huge empty gap before async Shiki layout finishes. We use a
       plain block (NOT flex) because flex column layout was reserving empty
       space above the code body — likely a streamdown-default min-height on
       one of the children that participated in flex sizing. Block layout
       sidesteps the issue entirely. */
    [data-streamdown="code-block"] {
      display: block !important;
      content-visibility: visible !important;
      contain-intrinsic-size: auto !important;
      contain: none !important;
      min-height: 0 !important;
      height: auto !important;
      margin: 6px 0 !important;
      border-radius: 10px !important;
      /* CSS-var backed backgrounds so theme tokens win even after Shiki's
         async DOM replacement inlines its own (dark) bg. ChatMarkdown root
         sets --chat-code-{shell,body,header}-bg on the container. */
      background: var(--chat-code-shell-bg, transparent) !important;
      /* Subtle themed border — in light mode this gives the slab a crisp
         edge against white prose. In dark mode the var resolves to
         transparent so the block still reads as a flat panel. */
      border: 1px solid var(--chat-code-border, transparent) !important;
      overflow: hidden !important;
    }
    /* Inner body: flatten streamdown's default rounded border, tighten padding,
       and force a small monospace font so we don't get huge Shiki defaults. */
    [data-streamdown="code-block-body"] {
      display: block !important;
      overflow-x: auto !important;
      border: none !important;
      border-radius: 0 !important;
      min-width: 0;
      min-height: 0 !important;
      height: auto !important;
      padding: 6px 10px !important;
      font-size: 11px !important;
      line-height: 1.45 !important;
      background: var(--chat-code-body-bg, transparent) !important;
      color: var(--chat-code-fg, inherit) !important;
    }
    [data-streamdown="code-block-body"] pre {
      white-space: pre !important;
      overflow-x: visible !important;
      margin: 0 !important;
      min-width: 0;
      padding: 0 !important;
      font-size: inherit !important;
      line-height: inherit !important;
      /* Shiki inlines its own background on <pre> — force-transparent so the
         body-level var wins and we don't get a dark shiki bg in light mode. */
      background: transparent !important;
    }
    [data-streamdown="code-block-body"] pre > code {
      display: block;
      white-space: pre !important;
      font-size: inherit !important;
      line-height: inherit !important;
      background: transparent !important;
    }
    /* Force each line-span onto its own row. Streamdown only adds a block
       className when lineNumbers is enabled; without that, bare spans render
       inline and collapse lines onto a single row. */
    [data-streamdown="code-block-body"] pre > code > span {
      display: block;
      font-size: inherit !important;
      line-height: inherit !important;
    }
    /* Compact header — Shiki's default is oversized. */
    [data-streamdown="code-block-header"] {
      height: 22px !important;
      min-height: 22px !important;
      max-height: 22px !important;
      font-size: 10px !important;
      padding: 0 8px !important;
      line-height: 22px !important;
      display: flex !important;
      align-items: center !important;
      box-sizing: border-box !important;
      background: var(--chat-code-header-bg, transparent) !important;
      color: var(--chat-code-header-color, inherit) !important;
      /* Thin divider under the language-label strip so the header reads as a
         distinct row in light mode. Transparent in dark themes. */
      border-bottom: 1px solid var(--chat-code-border, transparent) !important;
      font-weight: 500 !important;
      letter-spacing: 0.3px !important;
      text-transform: lowercase !important;
    }
    /* Pin the copy/actions cluster to the top-right corner of the block so
       it shares the header row regardless of where streamdown places it in
       the sibling tree. The previous negative-margin overlay trick broke
       whenever the actions wrapper wasn't a direct sibling of the header,
       leaving a tall empty band above the code. */
    [data-streamdown="code-block"] {
      position: relative !important;
    }
    [data-streamdown="code-block-actions"] {
      position: absolute !important;
      top: 0 !important;
      right: 0 !important;
      height: 22px !important;
      display: flex !important;
      align-items: center !important;
      padding: 0 4px !important;
      margin: 0 !important;
      z-index: 5 !important;
      background: transparent !important;
    }
    [data-streamdown="code-block-actions"] button {
      width: 18px !important;
      height: 18px !important;
      padding: 1px !important;
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      /* Strip streamdown/shadcn's default bordered-pill look — on light
         backgrounds the 1px dark outline reads as a heavy chip. We only
         want the glyph, with a subtle hover fill. */
      background: transparent !important;
      border: none !important;
      box-shadow: none !important;
      outline: none !important;
      border-radius: 4px !important;
      cursor: pointer !important;
      opacity: 0.7;
      transition: opacity 0.12s, background-color 0.12s;
    }
    [data-streamdown="code-block-actions"] button:hover {
      opacity: 1;
      background: var(--chat-code-header-bg, color-mix(in srgb, var(--cs-th-text-primary) 6%, transparent)) !important;
    }
    [data-streamdown="code-block-actions"] button:focus-visible {
      outline: 1px solid var(--chat-code-border, var(--cs-th-border-default)) !important;
      outline-offset: 1px !important;
    }
    /* Kill any wrapper a future streamdown version might put around the
       actions cluster so it can't add extra vertical height of its own. */
    [data-streamdown="code-block"] > div:has(> [data-streamdown="code-block-actions"]) {
      position: static !important;
      height: 0 !important;
      min-height: 0 !important;
      margin: 0 !important;
      padding: 0 !important;
    }

    /* Tables — nuke streamdown's default bg-sidebar / bg-background /
       border-border so tables render transparently and conform to whatever
       theme the host app uses. JS path in usePatchCodeBlocks still applies
       theme-aware border-color + cell typography. */
    [data-streamdown="table-wrapper"] {
      background: transparent !important;
      border: none !important;
      border-radius: 0 !important;
      padding: 0 !important;
      margin: 8px 0 !important;
      gap: 0 !important;
    }
    [data-streamdown="table-wrapper"] > div:has(> [data-streamdown="table"]) {
      background: transparent !important;
      border: none !important;
      border-radius: 0 !important;
      overflow-x: auto !important;
    }
    [data-streamdown="table"] {
      background: transparent !important;
      border: none !important;
      width: 100% !important;
      border-collapse: collapse !important;
      font-variant-numeric: tabular-nums !important;
    }
    [data-streamdown="table-header"] {
      background: transparent !important;
    }
    /* Override streamdown's baked-in \`divide-y divide-border\` Tailwind
       classes: zero the top-border divide, add a themed bottom-border on
       every row instead. --chat-table-border is set on ChatMarkdown root. */
    [data-streamdown="table-row"] {
      border-top: 0 !important;
      border-bottom: 1px solid var(--chat-table-border, transparent) !important;
    }
    [data-streamdown="table-header-cell"] {
      background: transparent !important;
      border: none !important;
      padding: 7px 12px !important;
      text-align: left !important;
      font-weight: 600 !important;
      font-size: 10.5px !important;
      letter-spacing: 0.5px !important;
      text-transform: uppercase !important;
      vertical-align: middle !important;
    }
    [data-streamdown="table-body"] {
      background: transparent !important;
    }
    [data-streamdown="table-cell"] {
      background: transparent !important;
      border: none !important;
      padding: 8px 12px !important;
      vertical-align: middle !important;
    }

    /* Inline code pills — consistent with the block palette so inline
       <code> and fenced blocks read as a single design system. Previously
       inline pills used a different (lighter) grey than the block, which
       looked disjointed in light mode. */
    .chat-md :not(pre) > code {
      background: var(--chat-code-inline-bg, color-mix(in srgb, var(--cs-th-text-primary) 12%, transparent)) !important;
      color: var(--chat-code-inline-color, inherit) !important;
      border: 1px solid var(--chat-code-inline-border, transparent) !important;
      padding: 1px 5px !important;
      border-radius: 6px !important;
      font-size: 0.92em !important;
      font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace !important;
      overflow-wrap: anywhere !important;
      word-break: break-word !important;
      white-space: normal !important;
      -webkit-box-decoration-break: clone !important;
      box-decoration-break: clone !important;
    }
    .chat-md.chat-md--path-mod :not(pre) > code[data-codesurf-local-path] {
      cursor: pointer !important;
    }
    .chat-md.chat-md--path-mod :not(pre) > code[data-codesurf-local-path]:hover {
      background: var(--chat-path-hover-bg, color-mix(in srgb, var(--cs-th-accent-base) 14%, transparent)) !important;
      border-color: var(--chat-path-hover-border, color-mix(in srgb, var(--cs-th-accent-base) 45%, transparent)) !important;
      color: var(--chat-path-hover-color, inherit) !important;
      box-shadow: 0 0 0 1px var(--chat-path-hover-border, color-mix(in srgb, var(--cs-th-accent-base) 45%, transparent)) !important;
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
  const tokens = useThemeTokens()
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const { shellBackground, bodyBackground, headerBackground, headerColor, borderColor } = tokens.code
    // In dark themes `borderColor` is 'transparent' so we fall back to the
    // existing themed border for visible definition. In light mode the
    // dedicated code border (#d7dde4) wins — gives the slab a clean edge
    // against white prose without picking up the accent-tinted app border.
    const blockBorder = borderColor === 'transparent' ? theme.border.default : borderColor
    const headerBorder = borderColor === 'transparent' ? theme.border.subtle : borderColor
    // Keep JS path matching the CSS rules in ensureCodeBlockLayoutStyles so
    // both paths converge on the same compact rendering.
    const fontSize = 11

    // Code blocks
    const blocks = el.querySelectorAll<HTMLElement>('[data-streamdown="code-block"]')
    blocks.forEach(block => {
      // `position:relative` is critical — the actions cluster is pinned
      // absolutely against this box, so we establish the containing block
      // here and keep `overflow:hidden` to clip to the rounded corners.
      block.style.cssText = `display:block!important;position:relative!important;padding:0!important;gap:0!important;margin:6px 0!important;border-radius:6px!important;overflow:hidden!important;border:1px solid ${blockBorder}!important;max-width:100%!important;min-height:0!important;height:auto!important;contain:none!important;background:${shellBackground}!important;color:${theme.text.primary}!important`
      const header = block.querySelector<HTMLElement>('[data-streamdown="code-block-header"]')
      if (header) {
        // Reserve space on the right so the language label doesn't collide
        // with the absolutely-positioned actions cluster (~56px covers a
        // typical copy + expand button pair).
        header.style.cssText = `height:22px!important;min-height:22px!important;max-height:22px!important;font-size:10px!important;padding:0 60px 0 8px!important;background:${headerBackground}!important;color:${headerColor}!important;border-bottom:1px solid ${headerBorder}!important;display:flex!important;align-items:center!important;box-sizing:border-box!important;font-weight:500!important;letter-spacing:0.3px!important`
      }
      // Flatten any wrapper streamdown puts around the actions cluster so
      // it can't inject its own vertical height above the code body.
      const actionsWrapper = block.querySelector<HTMLElement>('[data-streamdown="code-block-actions"]')?.parentElement
      if (actionsWrapper && actionsWrapper !== block) {
        actionsWrapper.style.cssText = 'position:static!important;height:0!important;min-height:0!important;margin:0!important;padding:0!important;border:0!important;background:transparent!important'
      }
      const actions = block.querySelector<HTMLElement>('[data-streamdown="code-block-actions"]')
      if (actions) {
        // Pin to the top-right of the block so the copy button always
        // shares the header row with the language label.
        actions.style.cssText = 'position:absolute!important;top:0!important;right:0!important;height:22px!important;display:flex!important;align-items:center!important;padding:0 4px!important;margin:0!important;z-index:5;background:transparent!important;pointer-events:auto'
        actions.querySelectorAll<HTMLElement>('button').forEach(btn => {
          btn.style.cssText = 'width:18px!important;height:18px!important;padding:1px!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;background:transparent!important;border:none!important;box-shadow:none!important;outline:none!important;border-radius:4px!important;cursor:pointer!important;opacity:0.7'
        })
        actions.querySelectorAll<SVGElement>('svg').forEach(svg => {
          svg.setAttribute('width', '11')
          svg.setAttribute('height', '11')
        })
      }
      const body = block.querySelector<HTMLElement>('[data-streamdown="code-block-body"]')
      if (body) {
        body.style.cssText = `display:block!important;padding:6px 10px!important;font-size:${fontSize}px!important;line-height:1.45!important;border:none!important;border-radius:0!important;min-height:0!important;height:auto!important;background:${bodyBackground}!important;color:${theme.text.primary}!important`
      }
      block.querySelectorAll<HTMLElement>('pre').forEach(pre => {
        pre.style.cssText += `;font-size:${fontSize}px!important;line-height:1.45!important;margin:0!important;padding:0!important;border-radius:0!important;white-space:pre!important;background:${bodyBackground}!important;color:${theme.text.primary}!important`
      })
      block.querySelectorAll<HTMLElement>('pre > code').forEach(codeEl => {
        codeEl.style.cssText += `;font-size:${fontSize}px!important;line-height:1.45!important;color:${theme.text.primary}!important;background:transparent!important`
        codeEl.querySelectorAll<HTMLElement>(':scope > span').forEach(line => {
          line.style.display = 'block'
        })
      })
      block.querySelectorAll<HTMLElement>('button').forEach(button => {
        button.style.color = headerColor
      })
    })

    // Tables — tidy styling: no per-cell grid, row underlines only.
    // Header: uppercase + muted + thead underline. Cells: tabular-nums, full
    // width, rounded outer container only. Matches the "data table" look the
    // rest of the app uses (PlanCard, DiffView gutters).
    const tables = el.querySelectorAll<HTMLElement>('[data-streamdown="table-wrapper"]')
    tables.forEach(wrapper => {
      wrapper.style.cssText = `margin:8px 0!important;padding:0!important;gap:0!important;border-radius:8px!important;overflow:hidden!important;border:none!important;background:transparent!important;color:${theme.text.primary}!important`

      const scroller = wrapper.querySelector<HTMLElement>('[data-streamdown="table"]')?.parentElement
      if (scroller) {
        scroller.style.cssText = `border:none!important;border-radius:0!important;overflow:auto!important;background:transparent!important`
      }

      const table = wrapper.querySelector<HTMLElement>('[data-streamdown="table"]')
      if (table) {
        table.style.cssText = `width:100%!important;border-collapse:collapse!important;background:transparent!important;color:${theme.text.primary}!important;font-variant-numeric:tabular-nums!important`
      }

      const thead = wrapper.querySelector<HTMLElement>('[data-streamdown="table-header"]')
      if (thead) {
        thead.style.cssText = `background:transparent!important;color:${theme.text.muted}!important;border-bottom:1px solid ${theme.border.subtle}!important`
      }

      const rows = wrapper.querySelectorAll<HTMLElement>('[data-streamdown="table-row"]')
      rows.forEach(row => {
        // Row underlines give structure without the heavy outer card.
        // Every row gets a bottom border so the table reads as bounded.
        row.style.cssText = `border:none!important;border-bottom:1px solid ${theme.border.subtle}!important`
      })
      wrapper.querySelectorAll<HTMLElement>('[data-streamdown="table-header-cell"]').forEach(cell => {
        cell.style.cssText = `background:transparent!important;color:${theme.text.muted}!important;border:none!important;padding:7px 12px!important;text-align:left!important;font-weight:600!important;font-size:10.5px!important;letter-spacing:0.5px!important;text-transform:uppercase!important;vertical-align:middle!important`
      })
      wrapper.querySelectorAll<HTMLElement>('[data-streamdown="table-cell"]').forEach(cell => {
        cell.style.cssText = `background:transparent!important;color:${theme.text.primary}!important;border:none!important;padding:8px 12px!important;vertical-align:middle!important`
      })
    })
  }, [fonts.size, ref, theme.border.default, theme.border.subtle, theme.text.primary, tokens])
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

export function useModifierPathOpenHandler(ref: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = ref.current
    if (!root) return

    const syncAnnotatedPaths = () => {
      const inlineCode = root.querySelectorAll<HTMLElement>('code')
      inlineCode.forEach(node => {
        if (node.closest('pre')) return
        const normalizedPath = normalizeLocalPathCandidate(node.textContent ?? '')
        if (normalizedPath) {
          node.dataset.codesurfLocalPath = normalizedPath
          node.setAttribute('title', 'Cmd/Ctrl+click to open')
        } else {
          delete node.dataset.codesurfLocalPath
          if (node.getAttribute('title') === 'Cmd/Ctrl+click to open') {
            node.removeAttribute('title')
          }
        }
      })
    }

    const syncModifierState = (event?: KeyboardEvent | MouseEvent) => {
      const modifierActive = Boolean(event ? (event.metaKey || event.ctrlKey) : false)
      root.classList.toggle('chat-md--path-mod', modifierActive)
    }

    syncAnnotatedPaths()

    const observer = new MutationObserver(() => {
      syncAnnotatedPaths()
    })
    observer.observe(root, { childList: true, subtree: true, characterData: true })

    const handleKeyDown = (event: KeyboardEvent) => syncModifierState(event)
    const handleKeyUp = (event: KeyboardEvent) => syncModifierState(event)
    const handleMouseMove = (event: MouseEvent) => syncModifierState(event)
    const clearModifierState = () => root.classList.remove('chat-md--path-mod')
    const handleClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>('code[data-codesurf-local-path]') : null
      if (!target) return
      if (!(event.metaKey || event.ctrlKey)) return
      const localPath = target.dataset.codesurfLocalPath
      if (!localPath) return
      if (!dispatchOpenLink(localPath)) return
      event.preventDefault()
      event.stopPropagation()
    }

    window.addEventListener('keydown', handleKeyDown, true)
    window.addEventListener('keyup', handleKeyUp, true)
    window.addEventListener('mousemove', handleMouseMove, true)
    window.addEventListener('blur', clearModifierState)
    root.addEventListener('mouseleave', clearModifierState)
    root.addEventListener('click', handleClick, true)

    return () => {
      observer.disconnect()
      window.removeEventListener('keydown', handleKeyDown, true)
      window.removeEventListener('keyup', handleKeyUp, true)
      window.removeEventListener('mousemove', handleMouseMove, true)
      window.removeEventListener('blur', clearModifierState)
      root.removeEventListener('mouseleave', clearModifierState)
      root.removeEventListener('click', handleClick, true)
    }
  }, [ref])
}

// --- ChatMarkdown component -------------------------------------------------------
// Renders markdown content with Streamdown, applying theme patches for code blocks and tables.
// Only http(s) and mailto links are allowed through from AI-controlled content.
// Everything else (javascript:, file://, data:, …) is silently stripped.
function isSafeHref(href: string | undefined): boolean {
  if (!href) return false
  // Relative URLs (no scheme) are fine — they resolve to the same origin
  if (href.startsWith('/') || href.startsWith('#') || href.startsWith('.')) return true
  try {
    const url = new URL(href)
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:'
  } catch {
    // Not a parseable absolute URL — treat as relative/safe
    return true
  }
}

const ThemedMarkdownLink = React.memo(function ThemedMarkdownLink({
  children,
  node: _node,
  onMouseEnter,
  onMouseLeave,
  style,
  href,
  ...props
}: React.ComponentPropsWithoutRef<'a'> & { node?: unknown }): JSX.Element {
  const theme = useTheme()

  const handleMouseEnter: React.MouseEventHandler<HTMLAnchorElement> = event => {
    event.currentTarget.style.color = theme.accent.hover
    onMouseEnter?.(event)
  }

  const handleMouseLeave: React.MouseEventHandler<HTMLAnchorElement> = event => {
    event.currentTarget.style.color = theme.accent.base
    onMouseLeave?.(event)
  }

  // Strip any href that isn't http/https/mailto/relative — second-layer defence
  // after the urlTransform on the Streamdown component.
  const safeHref = isSafeHref(href) ? href : undefined

  return (
    <a
      {...props}
      href={safeHref}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      style={{
        ...style,
        color: theme.accent.base,
        opacity: 1,
        textDecoration: 'underline',
        textUnderlineOffset: '2px',
      }}
    >
      {children}
    </a>
  )
})

// First-layer URL sanitisation: strip any link whose scheme isn't http/https/mailto
// or a relative reference. Applied at the markdown parse stage before rendering.
function safeUrlTransform(url: string): string | null | undefined {
  if (!url) return undefined
  if (url.startsWith('/') || url.startsWith('#') || url.startsWith('.')) return url
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:') return url
    return undefined
  } catch {
    // Non-parseable → treat as relative, pass through
    return url
  }
}

function ChatStreamdown({ text, isStreaming, className }: {
  text: string
  isStreaming?: boolean
  className?: string
}): JSX.Element {
  const tokens = useThemeTokens()
  const plugins = useStreamdownPlugins(text)
  return (
    <Streamdown
      className={`chat-md ${className ?? ''}`}
      components={{
        a: ThemedMarkdownLink,
        // Streamdown emits `MarkdownParagraph` nodes that can nest (e.g. when
        // the upstream markdown contains HTML-block elements inline), producing
        // <p> inside <p> — invalid HTML and a React hydration error. Rendering
        // paragraphs as <div> removes the nesting constraint while preserving
        // block-level layout. Margin mimics default browser <p> spacing.
        p: ({ className, ...rest }: any) => <div className={`chat-md-p ${className ?? ''}`} {...rest} />,
      }}
      plugins={plugins as any}
      mode={isStreaming ? 'streaming' : 'static'}
      shikiTheme={tokens.shikiTheme as ['github-light', 'github-light'] | ['github-dark', 'github-dark']}
      controls={{ code: { copy: true, download: false }, table: false, mermaid: false }}
      lineNumbers={false}
      urlTransform={safeUrlTransform}
    >
      {text}
    </Streamdown>
  )
}

export const ChatMarkdown = React.memo(({ text, isStreaming, className }: {
  text: string
  isStreaming?: boolean
  className?: string
}) => {
  const ref = useRef<HTMLDivElement>(null)
  const theme = useTheme()
  const fonts = useAppFonts()
  const tokens = useThemeTokens()
  useEffect(() => {
    ensureShimmerStyles()
    ensureCodeBlockLayoutStyles()
  }, [])
  usePatchCodeBlocks(ref, theme, fonts)
  useLinkClickHandler(ref)
  useModifierPathOpenHandler(ref)

  return (
    <div
      ref={ref}
      className="chat-md"
      style={{
        minWidth: 0,
        maxWidth: '100%',
        width: '100%',
        overflow: 'hidden',
        ['--chat-link-color' as string]: theme.accent.base,
        ['--chat-link-hover-color' as string]: theme.accent.hover,
        ['--chat-table-border' as string]: theme.border.subtle,
        // Expose code-block tokens as CSS vars so the static stylesheet can
        // enforce backgrounds with !important — this beats Shiki's async
        // inline bg that was making commands render dark in light mode.
        ['--chat-code-shell-bg' as string]: tokens.code.shellBackground,
        ['--chat-code-body-bg' as string]: tokens.code.bodyBackground,
        ['--chat-code-header-bg' as string]: tokens.code.headerBackground,
        ['--chat-code-header-color' as string]: tokens.code.headerColor,
        ['--chat-code-fg' as string]: theme.text.primary,
        ['--chat-code-border' as string]: tokens.code.borderColor,
        ['--chat-code-inline-bg' as string]: tokens.code.inlineBackground,
        ['--chat-code-inline-color' as string]: tokens.code.inlineColor,
        ['--chat-code-inline-border' as string]: tokens.code.inlineBorderColor,
        ['--chat-path-hover-bg' as string]: `${theme.accent.base}18`,
        ['--chat-path-hover-border' as string]: `${theme.accent.base}66`,
        ['--chat-path-hover-color' as string]: theme.text.primary,
      }}
    >
      <ChatStreamdown text={text} isStreaming={isStreaming} className={className} />
    </div>
  )
})
