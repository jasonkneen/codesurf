import React from 'react'
import { CornerDownLeft } from 'lucide-react'
import { useTheme } from '../ThemeContext'

interface Props {
  tileId: string
  workspaceId: string
  filePath: string
  onReplaceFilePath?: (tileId: string, filePath: string) => void
  /** When true, the inspector controls (palette swatches, metadata, edit
   *  input) are rendered OUTSIDE the block (left/right/below) so they don't
   *  obscure the image. Wired from canvas selection state. */
  isSelected?: boolean
  /** Tile border radius in screen px (chrome's actual rounded-corner value).
   *  We round the inner image-clipping wrapper to match, since the chrome's
   *  outer panel must use overflow: visible when allowOverflow is on —
   *  otherwise the inspector controls would be clipped. */
  borderRadius?: number
  /** Current canvas zoom. Inspector controls counter-scale by 1/zoom so
   *  swatches, text, and the edit input stay at constant SCREEN size and
   *  constant SCREEN distance from the block regardless of zoom. */
  zoom?: number
}

interface ImageVariant {
  filePath: string
  prompt?: string
  provider?: string
  model?: string
  at: number
}

function fileUrl(filePath: string): string {
  return `codesurf-file://${encodeURI(filePath).replace(/#/g, '%23')}`
}

function fileName(filePath: string): string {
  return filePath.replace(/\\/g, '/').split('/').pop() || filePath
}

function readContextValue<T>(entry: unknown, fallback: T): T {
  if (!entry || typeof entry !== 'object') return fallback
  const value = 'value' in entry ? (entry as { value?: unknown }).value : entry
  return value as T
}

function uniqueVariants(variants: ImageVariant[]): ImageVariant[] {
  const seen = new Set<string>()
  return variants.filter(variant => {
    if (!variant.filePath || seen.has(variant.filePath)) return false
    seen.add(variant.filePath)
    return true
  })
}

function extractPalette(img: HTMLImageElement): string[] {
  const canvas = document.createElement('canvas')
  const size = 36
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx || !img.naturalWidth || !img.naturalHeight) return []

  try {
    ctx.drawImage(img, 0, 0, size, size)
    const data = ctx.getImageData(0, 0, size, size).data
    const counts = new Map<string, number>()
    for (let i = 0; i < data.length; i += 16) {
      const alpha = data[i + 3]
      if (alpha < 180) continue
      const r = Math.round(data[i] / 32) * 32
      const g = Math.round(data[i + 1] / 32) * 32
      const b = Math.round(data[i + 2] / 32) * 32
      const key = `${Math.min(255, r)},${Math.min(255, g)},${Math.min(255, b)}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 9)
      .map(([key]) => {
        const [r, g, b] = key.split(',').map(Number)
        return `#${[r, g, b].map(value => value.toString(16).padStart(2, '0')).join('')}`
      })
  } catch {
    return []
  }
}

export function ImageTile({ tileId, workspaceId, filePath, onReplaceFilePath, isSelected = false, borderRadius = 16, zoom = 1 }: Props): JSX.Element {
  // Pre-existing committed bug (commit 7955578 "Use theme tokens for UI colors
  // and shadows" added 12+ `theme.*` token references but no `useTheme()` call,
  // leaving `theme` undefined → ReferenceError on every render of this core
  // tile). Resolve it via the same context hook every sibling tile uses.
  const theme = useTheme()
  const imageRef = React.useRef<HTMLImageElement | null>(null)
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const variantsRef = React.useRef<ImageVariant[]>([])
  const [editStatus, setEditStatus] = React.useState<{ status: 'running' | 'error' | 'done'; message: string } | null>(null)
  // Inspector controls now follow canvas selection. Selected = controls visible.
  const inspectorOpen = isSelected
  const [instruction, setInstruction] = React.useState('')
  const [palette, setPalette] = React.useState<string[]>([])
  const [dimensions, setDimensions] = React.useState<{ w: number; h: number } | null>(null)
  const [fileSize, setFileSize] = React.useState<number | null>(null)
  const [variants, setVariants] = React.useState<ImageVariant[]>([])
  const [activeIndex, setActiveIndex] = React.useState(0)

  const activeVariant = variants[activeIndex]
  const activePath = activeVariant?.filePath ?? filePath

  const persistVariants = React.useCallback((nextVariants: ImageVariant[], nextIndex: number) => {
    if (!workspaceId || !tileId || !window.electron?.tileContext) return
    void Promise.all([
      window.electron.tileContext.set(workspaceId, tileId, 'ctx:image:variants', nextVariants),
      window.electron.tileContext.set(workspaceId, tileId, 'ctx:image:variant:index', nextIndex),
    ]).catch(() => {})
  }, [workspaceId, tileId])

  const setVariantState = React.useCallback((nextVariants: ImageVariant[], nextIndex: number) => {
    const clean = uniqueVariants(nextVariants)
    const clampedIndex = Math.max(0, Math.min(nextIndex, clean.length - 1))
    variantsRef.current = clean
    setVariants(clean)
    setActiveIndex(clampedIndex)
    persistVariants(clean, clampedIndex)
  }, [persistVariants])

  const appendVariant = React.useCallback((variant: ImageVariant) => {
    const previous = variantsRef.current.length
      ? variantsRef.current
      : [{ filePath, at: Date.now() }]
    const withoutDuplicate = previous.filter(entry => entry.filePath !== variant.filePath)
    const next = [...withoutDuplicate, variant]
    setVariantState(next, next.length - 1)
  }, [filePath, setVariantState])

  const navigateVariant = React.useCallback((direction: number) => {
    const list = variantsRef.current
    if (list.length < 2) return
    const nextIndex = (activeIndex + direction + list.length) % list.length
    setVariantState(list, nextIndex)
    const nextPath = list[nextIndex]?.filePath
    if (nextPath && nextPath !== filePath) onReplaceFilePath?.(tileId, nextPath)
  }, [activeIndex, filePath, onReplaceFilePath, setVariantState, tileId])

  React.useEffect(() => {
    if (!workspaceId || !tileId || !filePath || !window.electron?.tileContext) return
    void Promise.all([
      window.electron.tileContext.set(workspaceId, tileId, 'ctx:image:path', filePath),
      window.electron.tileContext.set(workspaceId, tileId, 'ctx:file:path', filePath),
      window.electron.tileContext.set(workspaceId, tileId, 'ctx:image:ready', true),
    ]).catch(() => {})
  }, [workspaceId, tileId, filePath])

  React.useEffect(() => {
    if (!workspaceId || !tileId || !window.electron?.tileContext) {
      setVariantState([{ filePath, at: Date.now() }], 0)
      return
    }

    let cancelled = false
    void Promise.all([
      window.electron.tileContext.get(workspaceId, tileId, 'ctx:image:variants'),
      window.electron.tileContext.get(workspaceId, tileId, 'ctx:image:variant:index'),
    ]).then(([storedVariants, storedIndex]) => {
      if (cancelled) return
      const loadedVariants = readContextValue<ImageVariant[]>(storedVariants, [])
      const loadedIndex = readContextValue<number>(storedIndex, 0)
      const base = Array.isArray(loadedVariants) && loadedVariants.length
        ? loadedVariants
        : [{ filePath, at: Date.now() }]
      const withCurrent = base.some(variant => variant.filePath === filePath)
        ? base
        : [...base, { filePath, at: Date.now() }]
      const index = withCurrent.findIndex(variant => variant.filePath === filePath)
      setVariantState(withCurrent, index >= 0 ? index : loadedIndex)
    }).catch(() => {
      if (!cancelled) setVariantState([{ filePath, at: Date.now() }], 0)
    })

    return () => { cancelled = true }
  }, [workspaceId, tileId])

  React.useEffect(() => {
    if (!filePath) return
    const list = variantsRef.current
    if (!list.length) {
      setVariantState([{ filePath, at: Date.now() }], 0)
      return
    }
    const existingIndex = list.findIndex(variant => variant.filePath === filePath)
    if (existingIndex >= 0 && existingIndex !== activeIndex) {
      setVariantState(list, existingIndex)
    } else if (existingIndex < 0) {
      setVariantState([...list, { filePath, at: Date.now() }], list.length)
    }
  }, [filePath])

  React.useEffect(() => {
    if (!workspaceId || !tileId || !window.electron?.bus) return
    const subscriberId = `image:${workspaceId}:${tileId}:mcp`
    const unsubscribe = window.electron.bus.subscribe(`tile:${workspaceId}:${tileId}`, subscriberId, (evt: any) => {
      const payload = evt?.payload && typeof evt.payload === 'object' ? evt.payload as Record<string, unknown> : {}
      if (payload.tileId !== tileId && payload.cardId !== tileId) return
      const command = typeof payload.command === 'string' ? payload.command : ''

      if (command === 'image_annotate' && typeof payload.content === 'string') {
        void window.electron.tileContext?.set(workspaceId, tileId, 'ctx:image:annotation:last', {
          note: payload.content,
          at: Date.now(),
        }).catch(() => {})
        return
      }

      if (command === 'image_edit_request' || command === 'image_generate_variation') {
        const prompt = typeof payload.prompt === 'string' ? payload.prompt : ''
        setEditStatus({ status: 'running', message: 'Editing image...' })
        void window.electron.tileContext?.set(workspaceId, tileId, 'ctx:image:edit:request', {
          kind: command === 'image_edit_request' ? 'edit' : 'variation',
          prompt,
          provider: typeof payload.provider === 'string' ? payload.provider : '',
          model: typeof payload.model === 'string' ? payload.model : '',
          maskPath: typeof payload.maskPath === 'string' ? payload.maskPath : '',
          outputPath: typeof payload.outputPath === 'string' ? payload.outputPath : '',
          sourcePath: filePath,
          status: typeof payload.status === 'string' ? payload.status : 'requested',
          at: Date.now(),
        }).catch(() => {})
        return
      }

      if (command === 'image_edit_error') {
        const message = typeof payload.message === 'string' && payload.message.trim()
          ? payload.message.trim()
          : 'Image edit failed'
        setEditStatus({ status: 'error', message })
        void window.electron.tileContext?.set(workspaceId, tileId, 'ctx:image:edit:last', {
          sourcePath: filePath,
          status: 'error',
          error: message,
          prompt: typeof payload.prompt === 'string' ? payload.prompt : '',
          provider: typeof payload.provider === 'string' ? payload.provider : '',
          model: typeof payload.model === 'string' ? payload.model : '',
          at: Date.now(),
        }).catch(() => {})
        return
      }

      if (command === 'image_replace_source' && typeof payload.filePath === 'string' && payload.filePath.trim()) {
        const nextPath = payload.filePath.trim()
        const prompt = typeof payload.note === 'string' ? payload.note : ''
        setEditStatus({ status: 'done', message: 'Image updated' })
        window.setTimeout(() => setEditStatus(current => current?.status === 'done' ? null : current), 1800)
        appendVariant({
          filePath: nextPath,
          prompt,
          provider: typeof payload.provider === 'string' ? payload.provider : '',
          model: typeof payload.model === 'string' ? payload.model : '',
          at: Date.now(),
        })
        onReplaceFilePath?.(tileId, nextPath)
        void Promise.all([
          window.electron.tileContext?.set(workspaceId, tileId, 'ctx:image:path', nextPath),
          window.electron.tileContext?.set(workspaceId, tileId, 'ctx:file:path', nextPath),
          window.electron.tileContext?.set(workspaceId, tileId, 'ctx:image:edit:last', {
            sourcePath: filePath,
            outputPath: nextPath,
            note: prompt,
            provider: typeof payload.provider === 'string' ? payload.provider : '',
            model: typeof payload.model === 'string' ? payload.model : '',
            status: 'done',
            at: Date.now(),
          }),
        ]).catch(() => {})
      }
    })
    return () => {
      unsubscribe?.()
      window.electron.bus?.unsubscribeAll?.(subscriberId)
    }
  }, [workspaceId, tileId, filePath, onReplaceFilePath, appendVariant])

  React.useEffect(() => {
    if (!inspectorOpen) return
    // Don't auto-focus the edit input on selection — keyboard ArrowLeft/Right
    // for variant nav must remain available on the tile root.
  }, [inspectorOpen])

  React.useEffect(() => {
    setFileSize(null)
    if (!activePath || !window.electron?.fs?.stat) return
    void window.electron.fs.stat(activePath).then(stat => {
      setFileSize(stat?.size ?? null)
    }).catch(() => setFileSize(null))
  }, [activePath])

  const submitInstruction = React.useCallback(() => {
    const prompt = instruction.trim()
    if (!prompt || !window.electron?.image?.edit) return
    setInstruction('')
    setEditStatus({ status: 'running', message: 'Editing image...' })
    void window.electron.image.edit({ workspaceId, tileId, prompt }).then(result => {
      if (!result.ok) setEditStatus({ status: 'error', message: result.error ?? 'Image edit failed' })
    }).catch(err => {
      setEditStatus({ status: 'error', message: err instanceof Error ? err.message : String(err) })
    })
  }, [instruction, workspaceId, tileId])

  const formatBytes = (bytes: number | null): string => {
    if (bytes === null) return 'unknown'
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }

  return (
    <div
      tabIndex={0}
      onKeyDown={event => {
        if (event.key === 'ArrowLeft') navigateVariant(-1)
        if (event.key === 'ArrowRight') navigateVariant(1)
      }}
      onWheel={event => {
        // Cmd/Ctrl + wheel is the canvas zoom gesture — let it bubble through
        // to the canvas listener instead of swallowing it for variant nav.
        if (event.metaKey || event.ctrlKey) return
        if (!inspectorOpen || variants.length < 2) return
        event.stopPropagation()
        navigateVariant(event.deltaY > 0 ? 1 : -1)
      }}
      style={{
        // Outer wrapper allows children (inspector controls) to render OUTSIDE
        // the block. The image itself is clipped by the inner wrapper below.
        // Chrome must pass `allowOverflow` for these controls to be visible.
        width: '100%',
        height: '100%',
        position: 'relative',
        outline: 'none',
        overflow: 'visible',
      }}
    >
      {/* Image clipping wrapper — this is the visual block. Mirrors the
          chrome's border radius so the image keeps its rounded corners even
          though the chrome's main panel runs overflow: visible while
          selected. */}
      <div style={{
        position: 'absolute',
        inset: 0,
        // Letterbox plate behind images — use the deepest theme surface so
        // contrast tracks while the image keeps a neutral viewing backdrop.
        background: theme.surface.app,
        overflow: 'hidden',
        borderRadius,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        <img
          ref={imageRef}
          src={fileUrl(activePath)}
          alt=""
          draggable={false}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            display: 'block',
          }}
          onLoad={event => {
            const img = event.currentTarget
            setDimensions({ w: img.naturalWidth, h: img.naturalHeight })
            setPalette(extractPalette(img))
          }}
          onError={e => { (e.target as HTMLImageElement).style.opacity = '0.3' }}
        />
      </div>

      {inspectorOpen ? (
        <>
          {/* Three invisible click-absorbers covering the extended-chrome
              zones (left/right/below the block). Without these, clicks in the
              GAPS between controls fall through to the per-tile link sensors
              (zIndex 99991), and even with sensors marked as tile-chrome the
              clicks never reach the form. zIndex must beat the sensors. */}
          <div
            onMouseDown={e => e.stopPropagation()}
            onClick={e => e.stopPropagation()}
            style={{
              position: 'absolute', top: 0, bottom: 0,
              right: '100%', width: 280 / zoom,
              pointerEvents: 'auto', zIndex: 99993,
            }}
          />
          <div
            onMouseDown={e => e.stopPropagation()}
            onClick={e => e.stopPropagation()}
            style={{
              position: 'absolute', top: 0, bottom: 0,
              left: '100%', width: 240 / zoom,
              pointerEvents: 'auto', zIndex: 99993,
            }}
          />
          <div
            onMouseDown={e => e.stopPropagation()}
            onClick={e => e.stopPropagation()}
            style={{
              position: 'absolute', top: '100%',
              left: -280 / zoom, right: -240 / zoom,
              height: 84 / zoom,
              pointerEvents: 'auto', zIndex: 99993,
            }}
          />
          {/* Color palette — OUTSIDE the LEFT edge of the block. Counter-
              scaled by 1/zoom so swatch size + gap stay constant on screen.
              zIndex must beat the per-tile link sensors at 99991. */}
          <div
            onMouseDown={e => e.stopPropagation()}
            onClick={e => e.stopPropagation()}
            style={{
              position: 'absolute',
              right: '100%',
              marginRight: 10 / zoom,
              top: '50%',
              transformOrigin: 'right center',
              transform: `translateY(-50%) scale(${1 / zoom})`,
              display: 'flex',
              flexDirection: 'column',
              gap: 5,
              cursor: 'default',
              zIndex: 99994,
            }}>
            {(palette.length ? palette : ['#1f2933', '#334155', '#64748b']).map(color => (
              <div key={color} title={color} style={{
                width: 14,
                height: 14,
                borderRadius: 3,
                background: color,
                // Border/shadow for palette swatches sit next to arbitrary
                // colours sampled from images — use neutral white/black alpha
                // so they read on every hue.
                border: `1px solid color-mix(in srgb, #fff 26%, transparent)`,
                boxShadow: `0 1px 4px color-mix(in srgb, #000 45%, transparent)`,
              }} />
            ))}
          </div>

          {/* Metadata — OUTSIDE the RIGHT edge of the block. zIndex must
              beat the link sensors at 99991. */}
          <div
            onMouseDown={e => e.stopPropagation()}
            onClick={e => e.stopPropagation()}
            style={{
              position: 'absolute',
              left: '100%',
              marginLeft: 10 / zoom,
              top: '50%',
              transformOrigin: 'left center',
              transform: `translateY(-50%) scale(${1 / zoom})`,
              width: 200,
              // Metadata text overlays the canvas next to images; keep neutral
              // white-on-glass since the backdrop is unpredictable.
              color: `color-mix(in srgb, #fff 78%, transparent)`,
              fontSize: 10,
              lineHeight: 1.55,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              cursor: 'default',
              textAlign: 'left',
              wordBreak: 'break-word',
              userSelect: 'text',
              zIndex: 99994,
            }}>
            <div style={{ opacity: 0.95, fontWeight: 500 }}>{fileName(activePath)}</div>
            <div style={{ opacity: 0.7 }}>{dimensions ? `${dimensions.w} x ${dimensions.h}` : 'dimensions unknown'}</div>
            <div style={{ opacity: 0.7 }}>{formatBytes(fileSize)}</div>
            <div style={{ opacity: 0.7 }}>{variants.length} variant{variants.length === 1 ? '' : 's'}</div>
            <div style={{ opacity: 0.7 }}>{variants.length ? `${activeIndex + 1} / ${variants.length}` : '1 / 1'}</div>
            {activeVariant?.prompt ? <div style={{ opacity: 0.6, marginTop: 4, fontStyle: 'italic' }}>{activeVariant.prompt}</div> : null}
          </div>

          {/* Variant dots — just below the block, above the input. Counter-
              scaled like the palette/meta. */}
          {variants.length > 1 ? (
            <div
              onMouseDown={e => e.stopPropagation()}
              style={{
                position: 'absolute',
                top: '100%',
                marginTop: 8 / zoom,
                left: '50%',
                transformOrigin: 'center top',
                transform: `translateX(-50%) scale(${1 / zoom})`,
                display: 'flex',
                gap: 5,
                zIndex: 99994,
              }}>
              {variants.map((variant, index) => (
                <button
                  key={variant.filePath}
                  type="button"
                  onClick={event => {
                    event.stopPropagation()
                    setVariantState(variants, index)
                    onReplaceFilePath?.(tileId, variant.filePath)
                  }}
                  title={`${index + 1}: ${fileName(variant.filePath)}`}
                  style={{
                    width: 8,
                    height: 8,
                    padding: 0,
                    borderRadius: 999,
                    border: `1px solid color-mix(in srgb, #fff 45%, transparent)`,
                    background: index === activeIndex
                      ? `color-mix(in srgb, ${theme.accent.base} 65%, #fff)`
                      : `color-mix(in srgb, #fff 24%, transparent)`,
                    cursor: 'pointer',
                  }}
                />
              ))}
            </div>
          ) : null}

          {/* Edit input — BELOW the block. Counter-scaled and pill-shaped.
              zIndex must beat the link sensors at 99991 so the input element
              actually receives the click and gains focus. */}
          <form
            onSubmit={event => {
              event.preventDefault()
              submitInstruction()
            }}
            onMouseDown={e => e.stopPropagation()}
            style={{
              position: 'absolute',
              top: '100%',
              marginTop: (variants.length > 1 ? 28 : 8) / zoom,
              left: '50%',
              transformOrigin: 'center top',
              transform: `translateX(-50%) scale(${1 / zoom})`,
              width: 430,
              height: 36,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              // Edit-pill: glass over arbitrary image content, anchored on
              // theme surface so it tracks contrast while still reading
              // legibly against any image.
              background: `color-mix(in srgb, ${theme.surface.app} 78%, transparent)`,
              border: `1px solid color-mix(in srgb, ${theme.text.primary} 14%, transparent)`,
              boxShadow: `0 8px 28px color-mix(in srgb, #000 38%, transparent)`,
              padding: '4px 5px 4px 14px',
              borderRadius: 999,
              backdropFilter: 'blur(14px)',
              zIndex: 99994,
            }}
          >
            <input
              ref={inputRef}
              value={instruction}
              onChange={event => setInstruction(event.target.value)}
              placeholder="Edit this image..."
              spellCheck={false}
              style={{
                flex: 1,
                minWidth: 0,
                background: 'transparent',
                border: 0,
                outline: 'none',
                color: theme.text.primary,
                fontSize: 12,
              }}
            />
            <button
              type="submit"
              title="Apply edit"
              style={{
                width: 28,
                height: 28,
                border: `1px solid color-mix(in srgb, ${theme.accent.base} 38%, transparent)`,
                background: `color-mix(in srgb, ${theme.accent.base} 14%, transparent)`,
                color: theme.accent.base,
                borderRadius: '50%',
                padding: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              <CornerDownLeft size={14} strokeWidth={2} />
            </button>
          </form>
        </>
      ) : null}

      {editStatus ? (
        <div
          style={{
            position: 'absolute',
            left: 10,
            top: 10,
            maxWidth: 'calc(100% - 20px)',
            minHeight: 24,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 7,
            padding: '4px 8px',
            borderRadius: 6,
            border: `1px solid ${editStatus.status === 'error' ? `color-mix(in srgb, ${theme.status.danger} 50%, transparent)` : `color-mix(in srgb, ${theme.accent.base} 30%, transparent)`}`,
            background: editStatus.status === 'error'
              ? `color-mix(in srgb, ${theme.status.danger} 26%, ${theme.surface.app})`
              : `color-mix(in srgb, ${theme.surface.app} 78%, transparent)`,
            color: editStatus.status === 'error' ? theme.status.danger : theme.accent.base,
            fontSize: 11,
            lineHeight: 1.25,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            boxShadow: `0 6px 20px color-mix(in srgb, #000 28%, transparent)`,
            backdropFilter: 'blur(12px)',
          }}
          title={editStatus.message}
        >
          {editStatus.message}
        </div>
      ) : null}
    </div>
  )
}
