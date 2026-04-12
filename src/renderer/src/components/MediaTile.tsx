import React, { useLayoutEffect, useRef } from 'react'

// Persistent DOM nodes keyed by tile ID. These <video>/<audio>/<img> elements
// live outside React's reconciliation so their playback state (currentTime,
// paused, volume, muted) survives the component unmount/remount that happens
// when a tile moves between the canvas and the panel/tabbed layout.
const mediaNodes = new Map<string, HTMLElement>()

function isVideoFile(path: string): boolean {
  return /\.(mp4|mov|m4v|webm|ogv|avi|mkv)$/i.test(path)
}

function isAudioFile(path: string): boolean {
  return /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(path)
}

function toMediaUrl(filePath: string): string {
  // contex-file:// is the custom privileged scheme registered in main/file-protocol.ts.
  // It's required because the dev renderer origin is http://localhost:... which
  // means direct file:// <video>/<audio>/<img> loads are blocked by Chromium's
  // cross-origin policy. The scheme forwards Range requests so video seeking
  // works correctly.
  return `contex-file://${encodeURI(filePath).replace(/#/g, '%23')}`
}

function createMediaNode(filePath: string): HTMLElement {
  const src = toMediaUrl(filePath)

  if (isVideoFile(filePath)) {
    const v = document.createElement('video')
    v.src = src
    v.controls = true
    v.preload = 'metadata'
    v.playsInline = true
    v.style.cssText = [
      'width:100%',
      'height:100%',
      'object-fit:contain',
      'background:#000',
      'display:block',
    ].join(';')
    return v
  }

  if (isAudioFile(filePath)) {
    // Wrap the audio element in a centring container so controls sit in the middle.
    const wrap = document.createElement('div')
    wrap.style.cssText = [
      'width:100%',
      'height:100%',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'background:#0b0b0b',
      'padding:16px',
      'box-sizing:border-box',
    ].join(';')
    const a = document.createElement('audio')
    a.src = src
    a.controls = true
    a.preload = 'metadata'
    a.style.cssText = 'width:100%;max-width:640px'
    wrap.appendChild(a)
    return wrap
  }

  // Fallback — treat as image. This path isn't expected to be hit (images go
  // through ImageTile), but guards us against mis-routing.
  const img = document.createElement('img')
  img.src = src
  img.draggable = false
  img.style.cssText = [
    'width:100%',
    'height:100%',
    'object-fit:contain',
    'background:#000',
    'display:block',
  ].join(';')
  return img
}

export function disposeMediaTile(tileId: string): void {
  const node = mediaNodes.get(tileId)
  if (!node) return
  // Pause anything that plays so it stops consuming codec/resources immediately.
  const media = node instanceof HTMLMediaElement
    ? node
    : node.querySelector('video, audio') as HTMLMediaElement | null
  if (media) {
    try {
      media.pause()
      media.removeAttribute('src')
      media.load()
    } catch { /* ignore */ }
  }
  node.remove()
  mediaNodes.delete(tileId)
}

interface Props {
  tileId: string
  filePath: string
}

export function MediaTile({ tileId, filePath }: Props): React.JSX.Element {
  const slotRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!filePath) return
    let node = mediaNodes.get(tileId)
    if (!node) {
      node = createMediaNode(filePath)
      mediaNodes.set(tileId, node)
    }
    if (slotRef.current && node.parentElement !== slotRef.current) {
      slotRef.current.appendChild(node)
    }
    // No cleanup: we intentionally leave the node in the Map so the next mount
    // (canvas → panel or vice versa) can re-adopt it. disposeMediaTile() is
    // called from closeTile when the tile is destroyed for real.
  }, [tileId, filePath])

  return (
    <div
      ref={slotRef}
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        background: '#000',
        overflow: 'hidden',
      }}
    />
  )
}
