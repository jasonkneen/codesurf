// Scoped vitest config so the extension's tests don't inherit the host repo's
// vite/postcss/tailwind chain (which would pull in deps we don't have or want).
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    root: '.',
    include: ['evals/unit/**/*.test.mjs'],
    css: false,
  },
  // Disable PostCSS discovery — vitest would otherwise walk up and load the
  // host's postcss.config.js, which references plugins we don't depend on.
  css: { postcss: { plugins: [] } },
})
