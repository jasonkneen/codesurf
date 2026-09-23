import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Vitest runs under Node; these Bun-native modules cannot load there.
      // bun:sqlite → adapter over node:sqlite (real storage behavior).
      // @opentui/* → inert stubs (bun:ffi + Bun file-loader imports have no
      // Node equivalent; TUI-rendering tests are Bun-native via `bun test`).
      // See test/shims/ for the per-shim contracts.
      // Workspace packages resolve to their TypeScript sources so the Node
      // test run does not depend on `tsc -b` having been run first.
      "@codesurf/plugin-api": path.resolve(__dirname, "../../packages/plugin-api/src/index.ts"),
      "@codesurf/runtime": path.resolve(__dirname, "../../packages/runtime/src/index.ts"),
      "bun:sqlite": path.resolve(__dirname, "test/shims/bun-sqlite.ts"),
      "@opentui/core": path.resolve(__dirname, "test/shims/opentui-core.ts"),
      "@opentui/react/jsx-runtime": path.resolve(__dirname, "test/shims/opentui-jsx-runtime.ts"),
      "@opentui/react/jsx-dev-runtime": path.resolve(__dirname, "test/shims/opentui-jsx-runtime.ts"),
      "@opentui/react": path.resolve(__dirname, "test/shims/opentui-react.ts"),
    },
  },
  test: {
    // Keep every test off the developer's real ~/.codesurf (see the file).
    setupFiles: ["./test/setup/isolate-config-dir.ts"],
    // Several suites intentionally reset and rewire module-level host state.
    // Running their heavy imports concurrently makes otherwise-fast tests hit
    // the default 5s timeout on constrained machines. File isolation is still
    // enabled; execute files serially for deterministic test behavior.
    fileParallelism: false,
    // 5s is too tight for this suite. Several tests boot the full 54-plugin
    // catalog, and under vitest that means Vite transforming ~54 TS modules —
    // ~270ms under Bun, but seconds on a loaded machine. Those tests were
    // failing intermittently on timeout alone, which reads as a real defect and
    // costs more to re-diagnose each time than the wait costs to allow.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    exclude: [
      "dist/**",
      // Build output and hoisted copies: without these, the SAME test file runs
      // up to four times (src, packages/*/dist, and node_modules symlink
      // copies), and a stale compiled copy fails while its source passes.
      "**/dist/**",
      "**/node_modules/**",
      "node_modules/**",
      ".worktrees/**",
      "tmp/**",
      ".claude/**",
      ".cursor/**",
      // node:test suites owned by the daemon package (`npm run test:unit`).
      // Root vitest's default include matches `*.test.mjs` and reports
      // "No test suite found" for each of them.
      "packages/codesurf-daemon/test/**",
      // Bun-native tests (import from bun:test, rely on Bun-only runtime
      // behavior like mock.module). Run with: bun run test:bun
      "src/agent/adaptive-routing.test.ts",
      "src/core/plugins/sinks.bun.test.ts",
      "src/agent/learning/skill-optimizer.test.ts",
      "src/agent/trace-collection.test.ts",
      "src/ui/components/claude-code-pending-messages.test.ts",
      "src/ui/components/claude-code-title-bar.test.ts",
      "src/ui/components/prompt-bar.test.ts",
    ],
  },
});
