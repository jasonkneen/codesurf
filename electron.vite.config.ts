import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { existsSync, readFileSync } from 'fs'

const clusoWidgetPath = resolve(__dirname, '../agentation-real/src/cluso/index.ts')
const clusoAlias = existsSync(clusoWidgetPath)
  ? { 'cluso-widget': clusoWidgetPath }
  : {}

const packageJson = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string }

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
          plugins: [externalizeDepsPlugin()],
          build: {
            outDir: 'dist-electron/main',
            minify: false,
            rollupOptions: {
              input: resolve(__dirname, 'src/main/index.ts'),
              external: ['node-pty'],
              treeshake: false
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
              treeshake: false
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
              extend: resolve(__dirname, 'src/renderer/src/vendor/extend.ts'),
              ...clusoAlias
            }
          },
          define: {
            __VERSION__: JSON.stringify(packageJson.version)
          },
          plugins: [react()],
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
              'react-jsx-parser',
            ],
            exclude: ['@xterm/xterm', '@xterm/addon-fit', '@monaco-editor/react', 'monaco-editor'],
          }
        }
      }
    : {})
})
