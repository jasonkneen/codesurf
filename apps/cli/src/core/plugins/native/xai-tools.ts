// Native Cordis plugin: the xAI-coupled tools.
//
// Owns the four tools that go through xAI provider primitives that don't fit
// the generic LanguageModel mold (responses-API-with-tools, image/video
// models):
//
//   - search_web         (xAI Responses API + provider.tools.webSearch)
//   - search_x           (xAI Responses API + provider.tools.xSearch)
//   - generate_image     (xAI Imagine via provider.image)
//   - generate_video     (xAI Imagine Video via provider.video)
//
// They also bypass the kernel session abstraction because the session's
// `getModel(modelId)` returns a chat or responses LanguageModel — neither
// shape supports the .image/.video/.tools surfaces these tools need.
//
// XaiProvider is constructed lazily inside each tool's execute() via
// createProvider(getApiKey()). This avoids a shared singleton that would go
// stale on apiKey rotation. createProvider is a pure factory call (no IO), so
// the per-execute cost is negligible.
//
// Mode gate: all four tools register with `modes: ["agent"]`. The kernel's
// mode filter strips them in plan/ask modes at the active-ToolSet build step.
//
// UI groups: search tools register with `group: "search"`, media tools with
// `group: "media"` — preserves the `/extensions` grouping the metadata-only
// `searchToolsExtension` and `mediaToolsExtension` in `groups.ts` exposed.
//
// Converted from the V1 `activate(api)` shape to an ordinary Cordis module
// (`name`, `inject`, `apply`). The two host services it needs — `tools`, for
// `wrapExecute` (without it user hooks stop firing for these four tools), and
// `workspace`, for the agent's cwd — come from `@codesurf/plugin-api`. The xAI
// client, the media helpers and the api-key reader are the same pure domain
// modules the V1 builtin imported directly. Registration is owned by
// `ctx.effect`, so unmounting the fiber removes all four tools.

import type { CodesurfPlugin, PluginContext, PluginManifest, ToolOutcome } from "@codesurf/plugin-api";
import { generateText, tool } from "ai";
import { z } from "zod";
import { createProvider, type XaiProvider } from "../../../grok/client";
import {
  type GenerateImageToolInput,
  type GenerateVideoToolInput,
  generateImageTool,
  generateVideoTool,
  IMAGE_ASPECT_RATIOS,
  IMAGE_RESOLUTIONS,
  VIDEO_ASPECT_RATIOS,
  VIDEO_RESOLUTIONS,
} from "../../../grok/media";
import { getApiKey } from "../../../utils/settings";

const RESPONSES_SEARCH_MODEL = "grok-4-1-fast-non-reasoning";

const manifest: PluginManifest = {
  id: "builtin.tools-xai",
  name: "xAI Tools",
  version: "1.0.0",
  description:
    "xAI-coupled tools: web/X search via Responses API, image/video via Imagine. Constructs XaiProvider lazily per execute() — no shared singleton.",
  enabledByDefault: true,
  capabilities: ["tools"],
};

function getProviderOrError(): { ok: true; provider: XaiProvider } | { ok: false; reason: string } {
  const apiKey = getApiKey();
  if (!apiKey) {
    return {
      ok: false,
      reason: "Missing Grok API key (CODESURF_API_KEY). Paste a key via /models or set the env var.",
    };
  }
  return { ok: true, provider: createProvider(apiKey) };
}

async function runResponsesSearch(
  query: string,
  toolName: "web_search" | "x_search",
  abortSignal?: AbortSignal,
): Promise<{ success: boolean; output: string }> {
  const got = getProviderOrError();
  if (!got.ok) return { success: false, output: got.reason };
  const provider = got.provider;
  try {
    const { text } = await generateText({
      model: provider.responses(RESPONSES_SEARCH_MODEL),
      maxOutputTokens: 4096,
      prompt: query,
      abortSignal,
      tools: {
        ...(toolName === "web_search" ? { web_search: provider.tools.webSearch() } : {}),
        ...(toolName === "x_search" ? { x_search: provider.tools.xSearch() } : {}),
      },
    });
    return { success: true, output: text || "No search results found." };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const label = toolName === "web_search" ? "Web search" : "X search";
    return { success: false, output: `${label} failed: ${msg}` };
  }
}

/**
 * Widen the media helpers' `ToolResult` to the plugin API's `ToolOutcome`.
 *
 * The two are the same shape — `ToolOutcome` is `ToolResult` plus an index
 * signature for the extra keys a tool may attach — but TypeScript infers an
 * implicit index signature only for type literals, never for an interface, so
 * the widening has to be spelled out. Erased at runtime; the object the media
 * helper returns (`media`, `diff`, … included) is passed through untouched.
 */
function asOutcome(result: { success: boolean; output?: string; error?: string }): ToolOutcome {
  return result as ToolOutcome;
}

const SEARCH_WEB_DESCRIPTION =
  "Search the web for current information, documentation, APIs, tutorials, news, or any real-time data. Returns summarized results with sources.";
const SEARCH_X_DESCRIPTION =
  "Search X (Twitter) for real-time posts, discussions, opinions, and trends. Returns relevant posts with authors and engagement data.";

export const xaiToolsPlugin: CodesurfPlugin = {
  name: "codesurf-xai-tools",
  manifest,
  inject: ["contributions", "tools", "workspace"],
  apply(ctx: PluginContext) {
    ctx.effect(() =>
      ctx.contributions.registerTool({
        name: "search_web",
        label: "Web search",
        description: SEARCH_WEB_DESCRIPTION,
        group: "search",
        modes: ["agent"],
        tool: tool({
          description: SEARCH_WEB_DESCRIPTION,
          inputSchema: z.object({ query: z.string().describe("The search query") }),
          execute: ctx.tools.wrapExecute<{ query: string }>("search_web", async ({ query }, execCtx) =>
            runResponsesSearch(query, "web_search", execCtx.abortSignal),
          ),
        }),
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerTool({
        name: "search_x",
        label: "X search",
        description: SEARCH_X_DESCRIPTION,
        group: "search",
        modes: ["agent"],
        tool: tool({
          description: SEARCH_X_DESCRIPTION,
          inputSchema: z.object({ query: z.string().describe("The search query") }),
          execute: ctx.tools.wrapExecute<{ query: string }>("search_x", async ({ query }, execCtx) =>
            runResponsesSearch(query, "x_search", execCtx.abortSignal),
          ),
        }),
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerTool({
        name: "generate_image",
        label: "Generate image",
        description: "Generate or edit images via Grok Imagine. Saves files locally.",
        group: "media",
        modes: ["agent"],
        tool: tool({
          description:
            "Generate a new image or edit an existing image using Grok Imagine. Use when the user asks to create, redesign, restyle, or modify an image. Optionally pass a local file path or public URL in source to edit an existing image. Saves the generated image files locally and returns their paths.",
          inputSchema: z.object({
            prompt: z.string().describe("Prompt describing the image to generate or the edit to apply"),
            source: z
              .string()
              .optional()
              .describe("Optional local image path or public image URL to use as the source for editing"),
            aspect_ratio: z
              .enum(IMAGE_ASPECT_RATIOS)
              .optional()
              .describe("Optional output aspect ratio. Use when the user requests a specific format."),
            resolution: z.enum(IMAGE_RESOLUTIONS).optional().describe("Optional output resolution: 1k or 2k"),
            n: z.number().int().min(1).max(10).optional().describe("Number of images to generate (default: 1)"),
            output_path: z
              .string()
              .optional()
              .describe(
                "Optional file path for the generated image. For multiple images, numbered suffixes are added.",
              ),
          }),
          execute: ctx.tools.wrapExecute<GenerateImageToolInput>("generate_image", async (input, execCtx) => {
            const got = getProviderOrError();
            if (!got.ok) return { success: false, output: got.reason };
            const cwd = ctx.workspace.cwd();
            return asOutcome(await generateImageTool(got.provider, input, cwd, execCtx.abortSignal));
          }),
        }),
      }),
    );

    ctx.effect(() =>
      ctx.contributions.registerTool({
        name: "generate_video",
        label: "Generate video",
        description: "Generate or animate videos via Grok Imagine Video. Saves files locally.",
        group: "media",
        modes: ["agent"],
        tool: tool({
          description:
            "Generate a new short video or animate an existing image using Grok Imagine Video. Use when the user asks for a clip, animation, cinematic shot, or motion from a still image. Optionally pass a local image path or public image URL in source for image-to-video generation. Saves the generated video files locally and returns their paths.",
          inputSchema: z.object({
            prompt: z.string().describe("Prompt describing the video or motion to generate"),
            source: z
              .string()
              .optional()
              .describe("Optional local image path or public image URL to use as the starting frame"),
            duration: z.number().int().min(1).max(15).optional().describe("Video duration in seconds (1-15)"),
            aspect_ratio: z
              .enum(VIDEO_ASPECT_RATIOS)
              .optional()
              .describe("Optional output aspect ratio for text-to-video or to override image-to-video framing"),
            resolution: z.enum(VIDEO_RESOLUTIONS).optional().describe("Optional output resolution: 480p or 720p"),
            output_path: z
              .string()
              .optional()
              .describe(
                "Optional file path for the generated video. For multiple videos, numbered suffixes are added.",
              ),
            poll_interval_ms: z
              .number()
              .int()
              .min(100)
              .optional()
              .describe("Optional polling interval in milliseconds while waiting for video generation"),
            poll_timeout_ms: z
              .number()
              .int()
              .min(1000)
              .optional()
              .describe("Optional timeout in milliseconds while waiting for video generation"),
          }),
          execute: ctx.tools.wrapExecute<GenerateVideoToolInput>("generate_video", async (input, execCtx) => {
            const got = getProviderOrError();
            if (!got.ok) return { success: false, output: got.reason };
            const cwd = ctx.workspace.cwd();
            return asOutcome(await generateVideoTool(got.provider, input, cwd, execCtx.abortSignal));
          }),
        }),
      }),
    );
  },
};
