// Kernel-owned Telegram bridge tool.
//
// Phase 2 step 3: takes `telegram_send_file` out of `createTools()` in
// `src/grok/tools.ts` and into a kernel extension that owns the full ai-sdk
// `tool({...})` def. Replaces the metadata-only `telegramToolsExtension` that
// previously lived in `./groups.ts` (now removed in this same step).
//
// Host coupling:
//
//   - The bridge in `src/telegram/bridge.ts` binds `services.telegram.sendFile`
//     per turn via `setTelegramSink(sink)` at run start and clears it with
//     `setTelegramSink(null)` in the `finally`. When unbound (no bot running,
//     or no chat-driven turn in flight) the kernel returns a friendly
//     `{ success: false, error: "Telegram bridge is not active..." }` —
//     same shape as the lsp-disabled fallback.
//
//   - cwd-relative path resolution uses `path.resolve(filePath)` which handles
//     absolute paths, relative paths, and `.` / `..` segments correctly. The
//     previous `bash.getCwd()` closure is replaced because the kernel can't see the
//     `bash.getCwd()` closure is replaced because the kernel can't see the
//     bash instance, but `services.workspace.cwd()` already wires through to
//     the same provider that `app.tsx` binds with `bash.getCwd()` (or falls
//     back to `process.cwd()` when unbound — see `loader.ts`).
//
// Group: keeps the `"telegram"` group string the metadata-only extension used
// so user toggles via `services.tools.setEnabled(...)` and `/extensions`
// filters continue to work unchanged.

import path from "node:path";
import type { CodesurfPlugin, PluginContext, PluginManifest } from "@codesurf/plugin-api";
import { tool } from "ai";
import { z } from "zod";

const manifest: PluginManifest = {
  id: "builtin.tools.telegram",
  name: "Telegram Bridge",
  version: "1.0.0",
  description: "Send files and media to the connected Telegram chat. Only active while the Telegram bridge is running.",
  enabledByDefault: true,
  capabilities: ["tools"],
};

export const telegramToolsPlugin: CodesurfPlugin = {
  name: "codesurf-telegram-tools",
  manifest,
  inject: ["contributions", "tools", "workspace", "telegram"],
  apply(ctx: PluginContext) {
    ctx.effect(() =>
      ctx.contributions.registerTool({
        name: "telegram_send_file",
        description: "Send a local file to the Telegram chat.",
        group: "telegram",
        tool: tool({
          description:
            "Send a local file to the current Telegram chat as an attachment. Use this to deliver generated images, videos, documents, or any other file to the user in Telegram. The file is uploaded directly — the user receives it as a Telegram media message or document.",
          inputSchema: z.object({
            path: z.string().describe("Absolute or cwd-relative path to the local file to send"),
          }),
          execute: ctx.tools.wrapExecute<{ path: string }>(
            "telegram_send_file",
            async ({ path: filePath }, execCtx) => {
              // Honor abort before reaching out, and thread the signal through to
              // the grammy send (which accepts AbortSignal on its API methods).
              if (execCtx.abortSignal?.aborted) {
                return { success: false, output: "Aborted before send_file dispatched." };
              }
              const cwd = ctx.workspace.cwd();
              const resolved = path.resolve(cwd, filePath);
              return ctx.telegram.sendFile(resolved, execCtx.abortSignal);
            },
          ),
        }),
      }),
    );
  },
};
