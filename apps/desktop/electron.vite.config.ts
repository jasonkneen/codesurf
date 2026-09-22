import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { existsSync, readFileSync } from 'fs'

const clusoWidgetPath = resolve(__dirname, '../agentation-real/src/cluso/index.ts')
const clusoAlias = existsSync(clusoWidgetPath)
  ? { 'cluso-widget': clusoWidgetPath }
  : {}

const packageJson = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string }

// `virtual:pwa-register` is provided by vite-plugin-pwa, which only runs in the
// web build (vite.web.config.ts). The electron renderer never registers a
// service worker (registerCodesurfPwa returns early for the electron platform),
// but Vite's import-analysis still resolves the literal import at build time.
// Stub it to a no-op so the electron renderer build succeeds.
function stubPwaRegister() {
  const virtualId = 'virtual:pwa-register'
  const resolvedId = '\0virtual:pwa-register'
  return {
    name: 'codesurf-stub-pwa-register',
    resolveId(source: string) {
      return source === virtualId ? resolvedId : null
    },
    load(id: string) {
      return id === resolvedId ? 'export function registerSW() { return async () => {} }' : null
    },
  }
}

const targets = process.env.EV_BUILD_TARGET
  ? process.env.EV_BUILD_TARGET.split(',').map((t) => t.trim()).filter(Boolean)
  : ['main', 'preload', 'renderer']

const shouldBuildMain = targets.includes('main') || targets.includes('all')
const shouldBuildPreload = targets.includes('preload') || targets.includes('all')
const shouldBuildRenderer = targets.includes('renderer') || targets.includes('all')

export default defineConfig({
  cacheDir: '.vite/build-cache',
  ...(shouldBuildMain
    ? {
        main: {
          plugins: [externalizeDepsPlugin({ exclude: ['@codesurf/daemon'] })],
          build: {
            outDir: 'dist-electron/main',
            minify: false,
            rollupOptions: {
              input: {
              index: resolve(__dirname, 'src/main/index.ts'),
              'broker-child': resolve(__dirname, 'src/main/extensions/broker/child-entry.ts'),
            },
              external: ['node-pty'],
            }
          }
        }
      }
    : {}),
  ...(shouldBuildPreload
    ? {
        preload: {
          plugins: [externalizeDepsPlugin()],
          build: {
            outDir: 'dist-electron/preload',
            minify: false,
            rollupOptions: {
              input: resolve(__dirname, 'src/preload/index.ts'),
            }
          }
        }
      }
    : {}),
  ...(shouldBuildRenderer
    ? {
        renderer: {
          root: resolve(__dirname, 'src/renderer'),
          resolve: {
            alias: {
              '@': resolve(__dirname, 'src/renderer/src'),
              '@codesurf/chat-bridge': resolve(__dirname, 'packages/codesurf-chat-bridge/src/index.ts'),
              extend: resolve(__dirname, 'src/renderer/src/vendor/extend.ts'),
              ...clusoAlias
            }
          },
          define: {
            __VERSION__: JSON.stringify(packageJson.version)
          },
          plugins: [stubPwaRegister(), react()],
          build: {
            outDir: 'dist-electron/renderer',
            modulePreload: false,
            reportCompressedSize: false
          },
          optimizeDeps: {
            include: [
              'react',
              'react-dom',
              'react-dom/client',
              'react/jsx-runtime',
              'elkjs/lib/elk.bundled.js',
              'streamdown',
              '@streamdown/code',
              'style-to-js',
              'style-to-object',
              'hast-util-to-jsx-runtime',
              'debug',
              'micromark',
              'unified',
              'extend',
              '@ricky0123/vad-web',
              'onnxruntime-web',
            ],
            exclude: ['@xterm/xterm', '@xterm/addon-fit', '@monaco-editor/react', 'monaco-editor'],
          }
        }
      }
    : {})
})
