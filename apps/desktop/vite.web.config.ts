/**
 * Standalone Vite config for browser + Native shell (not Electron).
 *
 * Electron continues to use electron.vite.config.ts → dist-electron/.
 * Web builds dist/; Native stages those assets under its app-relative
 * desktop/frontend directory before manifest validation and packaging.
 *
 * PWA: vite-plugin-pwa enables Chrome/Edge install + Safari Add to Dock.
 */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { resolve } from 'path'
import { existsSync, readFileSync } from 'fs'
import tailwindcss from '@tailwindcss/vite'

const clusoWidgetPath = resolve(__dirname, '../agentation-real/src/cluso/index.ts')
const clusoAlias = existsSync(clusoWidgetPath)
  ? { 'cluso-widget': clusoWidgetPath }
  : {}

const packageJson = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as {
  version: string
  description?: string
}
const hostBase = process.env.VITE_CODESURF_HOST || 'http://127.0.0.1:4177'
const runtimeConfigProxyTarget = process.env.CODESURF_RUNTIME_CONFIG_PROXY_TARGET?.trim()

/**
 * Development-only credentials are delivered with the HTML response rather
 * than compiled into the production JavaScript bundle. Native obtains the
 * same fields through its origin-scoped bridge; deployed web hosts should
 * provide an equivalent authenticated runtime-config response.
 */
function runtimeCredentialsPlugin({ enabled }: { enabled: boolean }) {
  const runtimeConfig = {
    __CODESURF_HOST_TOKEN__: process.env.CODESURF_WEB_HOST_TOKEN || undefined,
    __CODESURF_TERMINAL_ENDPOINT__: process.env.CODESURF_TERMINAL_ENDPOINT || undefined,
    __CODESURF_TERMINAL_TOKEN__: process.env.CODESURF_TERMINAL_TOKEN || undefined,
  }
  const hasCredentials = Object.values(runtimeConfig).some(Boolean)

  return {
    name: 'codesurf-runtime-credentials',
    transformIndexHtml(html: string) {
      if (!enabled || !hasCredentials) return html
      // Escape `<` so a token can never terminate this inline script.
      const json = JSON.stringify(runtimeConfig).replace(/</g, '\\u003c')
      return html.replace('</head>', `<script>Object.assign(window, ${json})</script></head>`)
    },
  }
}

export default defineConfig(({ command }) => ({
  root: resolve(__dirname, 'src/renderer'),
  cacheDir: resolve(__dirname, '.vite/web-cache'),
  publicDir: resolve(__dirname, 'src/renderer/public'),
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer/src'),
      '@codesurf/chat-bridge': resolve(__dirname, 'packages/codesurf-chat-bridge/src/index.ts'),
      extend: resolve(__dirname, 'src/renderer/src/vendor/extend.ts'),
      ...clusoAlias,
    },
  },
  define: {
    __VERSION__: JSON.stringify(packageJson.version),
    'import.meta.env.VITE_CODESURF_HOST': JSON.stringify(hostBase),
    'import.meta.env.VITE_CODESURF_TARGET': JSON.stringify('web'),
  },
  plugins: [
    react(),
    tailwindcss(),
    runtimeCredentialsPlugin({
      // Never inject credentials into `vite build`, even if a deployment
      // environment accidentally exports a development token.
      enabled: command === 'serve' && process.env.CODESURF_RUNTIME_CONFIG_INJECT === '1',
    }),
    VitePWA({
      // Prompt (not autoUpdate) so desktop installs don't silently reload mid-session.
      registerType: 'prompt',
      injectRegister: null, // we register from platform/pwa.ts
      includeAssets: [
        'favicon.ico',
        'favicon.svg',
        'apple-touch-icon.png',
        'icons/icon-192.png',
        'icons/icon-512.png',
        'icons/icon-192.svg',
        'icons/icon-512.svg',
      ],
      manifest: {
        id: '/',
        name: 'CodeSurf',
        short_name: 'CodeSurf',
        description: packageJson.description || 'Infinite canvas workspace for AI agents',
        theme_color: '#0c0c0c',
        background_color: '#0c0c0c',
        display: 'standalone',
        display_override: ['window-controls-overlay', 'standalone', 'minimal-ui'],
        orientation: 'any',
        start_url: '/',
        scope: '/',
        lang: 'en',
        categories: ['developer', 'productivity', 'utilities'],
        // Prefer local host APIs when installed as desktop app
        prefer_related_applications: false,
        icons: [
          {
            src: '/icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
          {
            src: '/icons/icon-192.svg',
            sizes: '192x192',
            type: 'image/svg+xml',
            purpose: 'any',
          },
          {
            src: '/icons/icon-512.svg',
            sizes: '512x512',
            type: 'image/svg+xml',
            purpose: 'any',
          },
        ],
        shortcuts: [
          {
            name: 'Open CodeSurf',
            short_name: 'Open',
            url: '/',
            description: 'Open the CodeSurf canvas',
            icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
          },
        ],
      },
      workbox: {
        // Large Monaco/vendor chunks — don't fail install on size
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        globPatterns: [
          'index.html',
          'assets/**/*.{js,css,woff2,svg,png,ico}',
          'icons/**/*',
          'favicon.*',
          'apple-touch-icon.png',
        ],
        // Never cache host/daemon APIs or live workspaces
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/host\//, /^\/d\//, /^\/api\//],
        runtimeCaching: [
          {
            // Daemon + web-host: always network
            urlPattern: ({ url }) =>
              url.pathname.startsWith('/host/')
              || url.pathname.startsWith('/d/')
              || url.port === '4177'
              || /127\.0\.0\.1:4177|localhost:4177/.test(url.host),
            handler: 'NetworkOnly',
          },
          {
            urlPattern: /\/assets\/.*\.(?:js|css)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'codesurf-assets',
              expiration: { maxEntries: 120, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-css',
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-webfonts',
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: {
        // Enable SW in web:dev so Chrome installability can be tested locally
        enabled: process.env.CODESURF_PWA_DEV === '1',
        type: 'module',
        navigateFallback: 'index.html',
      },
    }),
  ],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // Native WebView + browser both hit the host API on 4177
    proxy: {
      '/host': { target: hostBase, changeOrigin: true },
      '/d': { target: hostBase, changeOrigin: true },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
    proxy: {
      '/host': { target: hostBase, changeOrigin: true },
      '/d': { target: hostBase, changeOrigin: true },
      ...(runtimeConfigProxyTarget
        ? { '/codesurf-runtime-config.js': { target: runtimeConfigProxyTarget, changeOrigin: true } }
        : {}),
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    modulePreload: false,
    reportCompressedSize: false,
  },
  optimizeDeps: {
    include: ['react', 'react-dom', 'react-dom/client'],
  },
}))
