import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [react(), tailwind()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      // Direct alias so we don't need a real workspace install of the
      // bridge package — its source lives at a stable repo path.
      '@codesurf/chat-bridge': resolve(__dirname, '../../packages/codesurf-chat-bridge/src/index.ts'),
    },
  },
  server: {
    port: 5174,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    // Single chunk + relative asset paths keep the bundle drop-in for
    // any host that loads it via file:// or a custom WebView protocol
    // (Swift WKWebView for muxy, etc.). Only one HTML entry.
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
  base: './',
})
