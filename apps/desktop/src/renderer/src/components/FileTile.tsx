import React, { useEffect, useMemo, useState } from 'react'
import type { FontToken } from '../../../shared/types'
import { basename, isImagePath, toFileUrl } from '../utils/dnd'
import { useTheme } from '../ThemeContext'

interface Props {
  tileId: string
  filePath: string
  workspacePath?: string
  secondaryFont: FontToken
}

interface FileStats {
  size: number
  mtimeMs: number
  isFile: boolean
  isDir: boolean
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

function extLabel(filePath: string): string {
  const match = filePath.match(/\.([^.\/]+)$/)
  return match ? match[1].toUpperCase() : 'FILE'
}

export function FileTile({ tileId, filePath, workspacePath, secondaryFont }: Props): JSX.Element {
  const theme = useTheme()
  const [hovered, setHovered] = useState(false)
  const [stats, setStats] = useState<FileStats | null>(null)
  const [missing, setMissing] = useState(false)
  const image = isImagePath(filePath)
  const inWorkspace = !!workspacePath && filePath.startsWith(workspacePath)

  useEffect(() => {
    let cancelled = false
    setMissing(false)
    window.electron.fs.stat(filePath)
      .then(next => {
        if (cancelled) return
        setStats(next)
      })
      .catch(() => {
        if (cancelled) return
        setStats(null)
        setMissing(true)
      })
    return () => { cancelled = true }
  }, [filePath])

  const meta = useMemo(() => {
    const parts = [extLabel(filePath)]
    if (stats?.size !== undefined) parts.push(formatBytes(stats.size))
    parts.push(inWorkspace ? 'In workspace' : 'Reference')
    return parts.join(' · ')
  }, [filePath, stats?.size, inWorkspace])

  const startPathDrag = (e: React.DragEvent<HTMLDivElement>) => {
    e.stopPropagation()
    e.dataTransfer.setData('text/plain', filePath)
    e.dataTransfer.setData('text/uri-list', toFileUrl(filePath))
    e.dataTransfer.setData('application/file-reference-path', filePath)
    e.dataTransfer.setData('application/file-reference-tile-id', tileId)
    e.dataTransfer.effectAllowed = 'copyLink'
  }

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        overflow: 'hidden',
        // Image plate is the deepest theme surface; non-image fallback uses a
        // gradient between two theme surfaces so contrast tracks.
        background: image
          ? theme.surface.app
          : `linear-gradient(180deg, ${theme.surface.panel} 0%, ${theme.surface.app} 100%)`,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {image ? (
        <img
          src={toFileUrl(filePath)}
          alt={basename(filePath)}
          draggable={false}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            display: 'block',
            filter: missing ? 'grayscale(1)' : 'none',
            opacity: missing ? 0.28 : 1,
          }}
          onError={() => setMissing(true)}
        />
      ) : (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: `radial-gradient(circle at 30% 20%, color-mix(in srgb, ${theme.accent.base} 22%, transparent), transparent 40%), linear-gradient(180deg, color-mix(in srgb, ${theme.text.primary} 4%, transparent) 0%, color-mix(in srgb, ${theme.text.primary} 1%, transparent) 100%)`,
          }}
        >
          <div
            style={{
              minWidth: 88,
              minHeight: 88,
              padding: '18px 20px',
              borderRadius: 24,
              border: `1px solid color-mix(in srgb, ${theme.text.primary} 8%, transparent)`,
              background: `color-mix(in srgb, ${theme.surface.app} 66%, transparent)`,
              boxShadow: `0 24px 48px color-mix(in srgb, #000 35%, transparent)`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <span
              style={{
                color: theme.accent.hover,
                fontSize: 26,
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
              }}
            >
              {extLabel(filePath)}
            </span>
          </div>
        </div>
      )}

      <div
        style={{
          position: 'absolute',
          inset: 0,
          // Vignette gradient toward dark — used to ensure label legibility
          // over arbitrary thumbnails. Anchored on #000 (deliberate) so the
          // overlay reads consistently across image content regardless of
          // theme.
          background: missing
            ? `linear-gradient(180deg, color-mix(in srgb, #000 15%, transparent) 0%, color-mix(in srgb, #000 88%, transparent) 100%)`
            : `linear-gradient(180deg, color-mix(in srgb, #000 4%, transparent) 0%, color-mix(in srgb, #000 78%, transparent) 100%)`,
          opacity: hovered ? 1 : 0.78,
          transition: 'opacity 0.14s ease',
          pointerEvents: 'none',
        }}
      />

      <div
        style={{
          position: 'absolute',
          left: 12,
          right: 12,
          bottom: hovered ? 12 : 10,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          transition: 'transform 0.14s ease, opacity 0.14s ease, bottom 0.14s ease',
          transform: hovered ? 'translateY(0)' : 'translateY(4px)',
          opacity: hovered ? 1 : 0.92,
        }}
      >
        <div
          draggable
          onDragStart={startPathDrag}
          style={{
            display: 'inline-flex',
            alignSelf: 'flex-start',
            maxWidth: '100%',
            padding: '6px 10px',
            borderRadius: 999,
            // Pill sits over the dark vignette overlay; keep it as a glass
            // plate anchored on theme.surface.app + #fff alpha for legibility.
            background: `color-mix(in srgb, ${theme.surface.app} 78%, transparent)`,
            border: `1px solid color-mix(in srgb, #fff 10%, transparent)`,
            color: `color-mix(in srgb, #fff 96%, ${theme.surface.app})`,
            cursor: 'grab',
            boxShadow: `0 10px 24px color-mix(in srgb, #000 28%, transparent)`,
            userSelect: 'none',
            WebkitUserSelect: 'none',
            fontFamily: secondaryFont.family,
            fontSize: secondaryFont.size,
            lineHeight: secondaryFont.lineHeight,
            fontWeight: secondaryFont.weight ?? 500,
            letterSpacing: secondaryFont.letterSpacing,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
          title="Drag to another tile or the file explorer"
        >
          {basename(filePath)}
        </div>
        <div
          style={{
            // Sits over the same dark vignette as the pill; anchor on white
            // tint for missing-state and a soft #fff tint for the ok state.
            color: missing
              ? `color-mix(in srgb, ${theme.status.danger} 70%, #fff)`
              : `color-mix(in srgb, #fff 70%, ${theme.text.muted})`,
            fontSize: 11,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            textShadow: `0 1px 10px color-mix(in srgb, #000 45%, transparent)`,
          }}
        >
          {missing ? 'Missing file' : meta}
        </div>
      </div>
    </div>
  )
}
