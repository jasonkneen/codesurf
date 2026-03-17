import React, { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

interface Props {
  tileId: string
  workspaceDir: string
  width: number
  height: number
}

export function TerminalTile({ tileId, workspaceDir, width, height }: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)
  const mountedRef = useRef(false)

  const doFit = () => {
    if (!fitRef.current || !termRef.current) return
    try {
      fitRef.current.fit()
      const dims = fitRef.current.proposeDimensions()
      if (dims?.cols && dims?.rows) {
        window.electron?.terminal?.resize(tileId, dims.cols, dims.rows)
      }
    } catch { /* ignore */ }
  }

  useEffect(() => {
    if (!containerRef.current || mountedRef.current) return
    mountedRef.current = true

    const term = new Terminal({
      theme: {
        background: '#1a1a1a',
        foreground: '#d4d4d4',
        cursor: '#aeafad',
        cursorAccent: '#1a1a1a',
        selectionBackground: 'rgba(74,158,255,0.3)',
        black: '#1e1e1e', red: '#f44747', green: '#6a9955',
        yellow: '#d7ba7d', blue: '#569cd6', magenta: '#c586c0',
        cyan: '#4ec9b0', white: '#d4d4d4',
        brightBlack: '#808080', brightRed: '#f44747', brightGreen: '#6a9955',
        brightYellow: '#d7ba7d', brightBlue: '#569cd6', brightMagenta: '#c586c0',
        brightCyan: '#4ec9b0', brightWhite: '#ffffff'
      },
      fontFamily: '"JetBrains Mono", "Menlo", "Monaco", "SF Mono", monospace',
      fontSize: 13,
      lineHeight: 1,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(containerRef.current)

    termRef.current = term
    fitRef.current = fitAddon

    // ResizeObserver so fit runs whenever the container actually changes size
    const ro = new ResizeObserver(() => doFit())
    ro.observe(containerRef.current)

    // Initial fit after paint
    requestAnimationFrame(() => requestAnimationFrame(() => doFit()))

    window.electron.terminal.create(tileId, workspaceDir).then(() => {
      const cleanup = window.electron.terminal.onData(tileId, (data: string) => {
        term.write(data)
      })
      cleanupRef.current = cleanup

      term.onData((data: string) => {
        window.electron.terminal.write(tileId, data)
      })

      // Fit once more after pty is ready
      doFit()
    }).catch(err => {
      term.write(`\r\n\x1b[31mFailed to start terminal: ${err?.message ?? err}\x1b[0m\r\n`)
    })

    return () => {
      mountedRef.current = false
      ro.disconnect()
      cleanupRef.current?.()
      window.electron.terminal.destroy(tileId)
      term.dispose()
    }
  }, [tileId, workspaceDir])

  // Also refit when tile width/height props change (drag resize)
  useEffect(() => {
    doFit()
  }, [width, height])

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', background: '#1a1a1a', padding: '4px 6px', boxSizing: 'border-box' }}
    />
  )
}
