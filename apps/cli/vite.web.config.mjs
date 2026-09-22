import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const dir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: "web",
  resolve: {
    alias: [
      {
        find: /^@opentui\/react\/jsx-runtime$/,
        replacement: path.resolve(dir, "src/ui-web/opentui-dom/jsx-runtime.ts"),
      },
      { find: /^@opentui\/core$/, replacement: path.resolve(dir, "src/ui-web/opentui-dom/core-shim.ts") },
      { find: /^@opentui\/react$/, replacement: path.resolve(dir, "src/ui-web/opentui-dom/index.ts") },
      { find: /^node:os$/, replacement: path.resolve(dir, "src/ui-web/opentui-dom/node-stubs.ts") },
      { find: /^node:path$/, replacement: path.resolve(dir, "src/ui-web/opentui-dom/node-stubs.ts") },
      { find: /^node:url$/, replacement: path.resolve(dir, "src/ui-web/opentui-dom/node-stubs.ts") },
      { find: /^node:fs$/, replacement: path.resolve(dir, "src/ui-web/opentui-dom/node-stubs.ts") },
      { find: /^node:child_process$/, replacement: path.resolve(dir, "src/ui-web/opentui-dom/node-stubs.ts") },
      { find: /^node:crypto$/, replacement: path.resolve(dir, "src/ui-web/opentui-dom/node-stubs.ts") },
      {
        find: /src\/ui\/host-files(?:\.(?:js|ts))?$/,
        replacement: path.resolve(dir, "src/ui-web/host-files.ts"),
      },
      {
        find: /src\/ui\/ai-output\/inline-image(?:\.(?:js|ts|tsx))?$/,
        replacement: path.resolve(dir, "src/ui-web/inline-image.tsx"),
      },
    ],
  },
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "@opentui/react",
  },
  build: {
    outDir: "../dist-web",
  },
});
