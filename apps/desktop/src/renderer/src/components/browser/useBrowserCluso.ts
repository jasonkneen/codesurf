import { useCallback, useEffect, useRef, useState } from 'react'
import clusoEmbedJs from '../../assets/cluso/cluso-embed.js?raw'
import clusoEmbedCss from '../../assets/cluso/cluso-embed.css?raw'
import {
  createClusoInjectScript,
  createClusoSetActiveScript,
} from './webviewManager'

interface UseBrowserClusoOptions {
  executeInWebview: (script: string) => Promise<unknown>
  isWebviewAvailable: () => boolean
}

export interface BrowserClusoLifecycle {
  isReady: boolean
  isActive: boolean
  reset: () => void
  markReady: (active?: boolean) => void
  markActive: (active: boolean) => void
  inject: () => void
  toggle: (isEmbeddedPreview: boolean) => void
}

export function useBrowserCluso({
  executeInWebview,
  isWebviewAvailable,
}: UseBrowserClusoOptions): BrowserClusoLifecycle {
  const [isReady, setIsReady] = useState(false)
  const [isActive, setIsActive] = useState(false)
  const toggleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const assetsRef = useRef<{ js: string | null; css: string | null }>({
    js: clusoEmbedJs || null,
    css: clusoEmbedCss || null,
  })

  const reset = useCallback(() => {
    setIsReady(false)
    setIsActive(false)
  }, [])
  const markReady = useCallback((active?: boolean) => {
    setIsReady(true)
    if (typeof active === 'boolean') setIsActive(active)
  }, [])
  const markActive = useCallback((active: boolean) => {
    setIsActive(active)
  }, [])
  const inject = useCallback(() => {
    const { js, css } = assetsRef.current
    if (!js || !css) {
      console.warn('[Cluso] Assets not loaded yet — skipping injection')
      return
    }

    reset()
    executeInWebview(createClusoInjectScript(js, css))
      .then(result => {
        if (typeof result === 'string' && result.includes('ERROR')) {
          console.error('[Cluso] Injection error:', result)
        }
      })
      .catch(error => console.error('[Cluso] Injection failed:', error))
  }, [executeInWebview, reset])

  useEffect(() => {
    assetsRef.current = {
      js: clusoEmbedJs || null,
      css: clusoEmbedCss || null,
    }
    if (!assetsRef.current.js || !assetsRef.current.css) {
      console.warn('[Cluso] Bundled embed assets are missing — inspector will not work')
      return
    }
    if (isWebviewAvailable()) inject()
  }, [inject, isWebviewAvailable])

  useEffect(() => () => {
    if (toggleTimerRef.current !== null) {
      clearTimeout(toggleTimerRef.current)
      toggleTimerRef.current = null
    }
  }, [])

  const toggle = useCallback((isEmbeddedPreview: boolean) => {
    if (isEmbeddedPreview) return

    const maxAttempts = 30
    const retryDelayMs = 100
    const nextActive = !isActive
    const toggleScript = createClusoSetActiveScript(nextActive)
    const tryToggle = (attempt: number) => {
      if (!isWebviewAvailable()) return

      executeInWebview(toggleScript).then(result => {
        const status = typeof result === 'string' ? result : String(result ?? '')
        if (
          (status === '__CLUSO_NOT_READY__' || status === '__CLUSO_PENDING__')
          && attempt < maxAttempts
          && isWebviewAvailable()
        ) {
          toggleTimerRef.current = setTimeout(
            () => tryToggle(attempt + 1),
            retryDelayMs,
          )
          return
        }
        if (status === '__CLUSO_TOGGLED__') {
          setIsActive(nextActive)
          return
        }
        if (status.startsWith('__CLUSO_TOGGLE_ERROR__')) {
          console.error('[BrowserTile] Failed to toggle Cluso:', status)
        }
      }).catch(error => {
        console.error('[BrowserTile] Failed to toggle Cluso:', error)
      })
    }

    if (!isReady) inject()
    tryToggle(0)
  }, [
    executeInWebview,
    inject,
    isActive,
    isReady,
    isWebviewAvailable,
  ])

  return {
    isReady,
    isActive,
    reset,
    markReady,
    markActive,
    inject,
    toggle,
  }
}
