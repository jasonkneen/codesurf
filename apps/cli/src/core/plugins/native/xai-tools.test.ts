// Parity acceptance for the converted xAI tools plugin.
//
// The V1 builtin was four `api.registerTool` calls whose bodies were wrapped in
// `api.services.hooks.wrapExecute`. The compatibility surface is therefore the
// registered specs (name, label, description, group, modes — all of which the
// model and `/extensions` see) plus the exact text each body produces. Both are
// asserted here against the real runtime, mounted on a root with fake
// `HostBindings`; the xAI client, the media helpers and the api-key reader are
// mocked so no network or filesystem is touched.
//
// `xai-tools.boot.test.ts` covers the same plugin through the real host loader.

import { type Context, createCodesurfRoot, type HostBindings, mountPlugin } from "@codesurf/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createProviderMock, generateTextMock, generateImageToolMock, generateVideoToolMock, getApiKeyMock } =
  vi.hoisted(() => ({
    createProviderMock: vi.fn(),
    generateTextMock: vi.fn(),
    generateImageToolMock: vi.fn(),
    generateVideoToolMock: vi.fn(),
    getApiKeyMock: vi.fn(),
  }));

// `tool()` stays real — it is what turns the spec into the object the agent
// executes — while `generateText` is mocked so the search bodies are testable.
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: generateTextMock };
});
vi.mock("../../../grok/client", () => ({ createProvider: createProviderMock }));
vi.mock("../../../grok/media", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../grok/media")>();
  return { ...actual, generateImageTool: generateImageToolMock, generateVideoTool: generateVideoToolMock };
});
vi.mock("../../../utils/settings", () => ({ getApiKey: getApiKeyMock }));

import { xaiToolsPlugin } from "./xai-tools";

const TOOL_NAMES = ["search_web", "search_x", "generate_image", "generate_video"] as const;

const SEARCH_WEB_DESCRIPTION =
  "Search the web for current information, documentation, APIs, tutorials, news, or any real-time data. Returns summarized results with sources.";
const SEARCH_X_DESCRIPTION =
  "Search X (Twitter) for real-time posts, discussions, opinions, and trends. Returns relevant posts with authors and engagement data.";
const MISSING_KEY = "Missing Grok API key (CODESURF_API_KEY). Paste a key via /models or set the env var.";

interface ToolBody {
  description?: string;
  execute: (input: unknown, ctx?: { abortSignal?: AbortSignal }) => Promise<{ success: boolean; output?: string }>;
}

/** A stand-in XaiProvider exposing only the three surfaces the plugin touches. */
function fakeProvider() {
  return {
    responses: vi.fn((modelId: string) => ({ marker: "responses", modelId })),
    image: vi.fn(),
    video: vi.fn(),
    tools: {
      webSearch: vi.fn(() => ({ marker: "web_search" })),
      xSearch: vi.fn(() => ({ marker: "x_search" })),
    },
  };
}

function bootRoot(overrides: Partial<HostBindings> = {}): {
  root: Context;
  registered: string[];
  unregistered: string[];
  wrapped: string[];
} {
  const registered: string[] = [];
  const unregistered: string[] = [];
  const wrapped: string[] = [];
  const root = createCodesurfRoot({
    cwd: () => "/agent/cwd",
    registerTool: (spec) => {
      registered.push(spec.name);
      return () => unregistered.push(spec.name);
    },
    tools: {
      setEnabled: () => {},
      runPre: async () => ({ blocked: false, blockingErrors: [], preventContinuation: false, additionalContexts: [] }),
      runPost: async () => ({ blocked: false, blockingErrors: [], preventContinuation: false, additionalContexts: [] }),
      runFailure: async () => ({
        blocked: false,
        blockingErrors: [],
        preventContinuation: false,
        additionalContexts: [],
      }),
      isEnabled: () => true,
      safeExecute: async (opts) => opts.fn(),
      // Records that the plugin still routes every body through the host's
      // hook wrapper; the returned function is the body itself so the assertions
      // below exercise real plugin code.
      wrapExecute: ((name: string, fn: (input: unknown, ctx: { abortSignal?: AbortSignal }) => unknown) => {
        wrapped.push(name);
        return (input: unknown, execCtx?: { abortSignal?: AbortSignal }) => fn(input, execCtx ?? {});
      }) as never,
    },
    ...overrides,
  });
  return { root, registered, unregistered, wrapped };
}

function bodyOf(root: Context, name: string): ToolBody {
  const spec = root.contributions.listTools().find((entry) => entry.name === name);
  if (!spec) throw new Error(`${name} was not registered`);
  return spec.tool as ToolBody;
}

describe("native xAI tools plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getApiKeyMock.mockReturnValue("test-key");
    createProviderMock.mockImplementation(() => fakeProvider());
  });

  it("keeps the V1 manifest identity", () => {
    expect(xaiToolsPlugin.manifest.id).toBe("builtin.tools-xai");
    expect(xaiToolsPlugin.manifest.name).toBe("xAI Tools");
    expect(xaiToolsPlugin.manifest.version).toBe("1.0.0");
    expect(xaiToolsPlugin.manifest.description).toBe(
      "xAI-coupled tools: web/X search via Responses API, image/video via Imagine. Constructs XaiProvider lazily per execute() — no shared singleton.",
    );
    expect(xaiToolsPlugin.manifest.enabledByDefault).toBe(true);
    expect(xaiToolsPlugin.manifest.protected).toBeUndefined();
    expect(xaiToolsPlugin.manifest.hidden).toBeUndefined();
    expect(xaiToolsPlugin.manifest.group).toBeUndefined();
    expect(xaiToolsPlugin.manifest.capabilities).toEqual(["tools"]);
  });

  it("registers the four tools with the V1 labels, groups and mode gate", async () => {
    const { root, registered } = bootRoot();
    const fiber = mountPlugin(root, xaiToolsPlugin);
    await fiber;

    const specs = root.contributions.listTools();
    expect(specs.map((spec) => spec.name)).toEqual([...TOOL_NAMES]);
    // The host registry sees the same four, in the same order.
    expect(registered).toEqual([...TOOL_NAMES]);

    expect(specs.map((spec) => spec.label)).toEqual(["Web search", "X search", "Generate image", "Generate video"]);
    expect(specs.map((spec) => spec.group)).toEqual(["search", "search", "media", "media"]);
    for (const spec of specs) expect(spec.modes).toEqual(["agent"]);

    expect(specs[0]?.description).toBe(SEARCH_WEB_DESCRIPTION);
    expect(specs[1]?.description).toBe(SEARCH_X_DESCRIPTION);
    expect(specs[2]?.description).toBe("Generate or edit images via Grok Imagine. Saves files locally.");
    expect(specs[3]?.description).toBe("Generate or animate videos via Grok Imagine Video. Saves files locally.");

    // The model-facing descriptions on the executable tool objects — the search
    // pair deliberately repeats its registry description, the media pair does not.
    expect(bodyOf(root, "search_web").description).toBe(SEARCH_WEB_DESCRIPTION);
    expect(bodyOf(root, "search_x").description).toBe(SEARCH_X_DESCRIPTION);
    expect(bodyOf(root, "generate_image").description).toBe(
      "Generate a new image or edit an existing image using Grok Imagine. Use when the user asks to create, redesign, restyle, or modify an image. Optionally pass a local file path or public URL in source to edit an existing image. Saves the generated image files locally and returns their paths.",
    );
    expect(bodyOf(root, "generate_video").description).toBe(
      "Generate a new short video or animate an existing image using Grok Imagine Video. Use when the user asks for a clip, animation, cinematic shot, or motion from a still image. Optionally pass a local image path or public image URL in source for image-to-video generation. Saves the generated video files locally and returns their paths.",
    );

    await fiber.dispose();
  });

  it("routes every tool body through the host's hook wrapper", async () => {
    const { root, wrapped } = bootRoot();
    const fiber = mountPlugin(root, xaiToolsPlugin);
    await fiber;

    expect(wrapped).toEqual([...TOOL_NAMES]);
    await fiber.dispose();
  });

  it("disposing the fiber removes all four tools from the root and the host", async () => {
    const { root, unregistered } = bootRoot();
    const fiber = mountPlugin(root, xaiToolsPlugin);
    await fiber;
    expect(root.contributions.listTools()).toHaveLength(4);

    await fiber.dispose();
    expect(root.contributions.listTools()).toEqual([]);
    expect(unregistered.sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("returns the V1 credential error from every tool when no API key is configured", async () => {
    getApiKeyMock.mockReturnValue(undefined);
    const { root } = bootRoot();
    const fiber = mountPlugin(root, xaiToolsPlugin);
    await fiber;

    for (const name of TOOL_NAMES) {
      const result = await bodyOf(root, name).execute({ query: "anything", prompt: "anything" });
      expect(result).toEqual({ success: false, output: MISSING_KEY });
    }
    expect(createProviderMock).not.toHaveBeenCalled();
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(generateImageToolMock).not.toHaveBeenCalled();
    expect(generateVideoToolMock).not.toHaveBeenCalled();

    await fiber.dispose();
  });

  it("builds the provider per execute() rather than once at registration", async () => {
    const { root } = bootRoot();
    const fiber = mountPlugin(root, xaiToolsPlugin);
    await fiber;
    expect(createProviderMock).not.toHaveBeenCalled();

    generateTextMock.mockResolvedValue({ text: "hits" });
    await bodyOf(root, "search_web").execute({ query: "a" });
    await bodyOf(root, "search_web").execute({ query: "b" });
    expect(createProviderMock).toHaveBeenCalledTimes(2);
    expect(createProviderMock).toHaveBeenCalledWith("test-key");

    await fiber.dispose();
  });

  it("runs search_web against the Responses API with the web_search tool only", async () => {
    generateTextMock.mockResolvedValue({ text: "web results" });
    const { root } = bootRoot();
    const fiber = mountPlugin(root, xaiToolsPlugin);
    await fiber;

    const signal = new AbortController().signal;
    const result = await bodyOf(root, "search_web").execute({ query: "typescript 6" }, { abortSignal: signal });
    expect(result).toEqual({ success: true, output: "web results" });

    const call = generateTextMock.mock.calls[0]?.[0];
    expect(call.model).toEqual({ marker: "responses", modelId: "grok-4-1-fast-non-reasoning" });
    expect(call.maxOutputTokens).toBe(4096);
    expect(call.prompt).toBe("typescript 6");
    expect(call.abortSignal).toBe(signal);
    expect(Object.keys(call.tools)).toEqual(["web_search"]);

    await fiber.dispose();
  });

  it("runs search_x against the Responses API with the x_search tool only", async () => {
    generateTextMock.mockResolvedValue({ text: "x results" });
    const { root } = bootRoot();
    const fiber = mountPlugin(root, xaiToolsPlugin);
    await fiber;

    const result = await bodyOf(root, "search_x").execute({ query: "grok" });
    expect(result).toEqual({ success: true, output: "x results" });
    expect(Object.keys(generateTextMock.mock.calls[0]?.[0].tools)).toEqual(["x_search"]);

    await fiber.dispose();
  });

  it("falls back to the V1 empty-result text and labels search failures per tool", async () => {
    const { root } = bootRoot();
    const fiber = mountPlugin(root, xaiToolsPlugin);
    await fiber;

    generateTextMock.mockResolvedValue({ text: "" });
    expect(await bodyOf(root, "search_web").execute({ query: "q" })).toEqual({
      success: true,
      output: "No search results found.",
    });

    generateTextMock.mockRejectedValue(new Error("boom"));
    expect(await bodyOf(root, "search_web").execute({ query: "q" })).toEqual({
      success: false,
      output: "Web search failed: boom",
    });
    expect(await bodyOf(root, "search_x").execute({ query: "q" })).toEqual({
      success: false,
      output: "X search failed: boom",
    });

    generateTextMock.mockRejectedValue("not-an-error");
    expect(await bodyOf(root, "search_x").execute({ query: "q" })).toEqual({
      success: false,
      output: "X search failed: not-an-error",
    });

    await fiber.dispose();
  });

  it("hands the media helpers the agent's cwd, the input and the abort signal", async () => {
    generateImageToolMock.mockResolvedValue({ success: true, output: "image.png", media: [] });
    generateVideoToolMock.mockResolvedValue({ success: true, output: "clip.mp4", media: [] });
    const { root } = bootRoot();
    const fiber = mountPlugin(root, xaiToolsPlugin);
    await fiber;

    const signal = new AbortController().signal;
    const imageInput = { prompt: "a cat", n: 2 };
    const imageResult = await bodyOf(root, "generate_image").execute(imageInput, { abortSignal: signal });
    expect(imageResult).toEqual({ success: true, output: "image.png", media: [] });
    expect(generateImageToolMock).toHaveBeenCalledWith(expect.anything(), imageInput, "/agent/cwd", signal);

    const videoInput = { prompt: "a cat, moving", duration: 5 };
    const videoResult = await bodyOf(root, "generate_video").execute(videoInput, { abortSignal: signal });
    expect(videoResult).toEqual({ success: true, output: "clip.mp4", media: [] });
    expect(generateVideoToolMock).toHaveBeenCalledWith(expect.anything(), videoInput, "/agent/cwd", signal);

    await fiber.dispose();
  });

  it("reads cwd from the workspace service on every call, not once at mount", async () => {
    generateImageToolMock.mockResolvedValue({ success: true, output: "ok" });
    let cwd = "/first";
    const { root } = bootRoot({ cwd: () => cwd });
    const fiber = mountPlugin(root, xaiToolsPlugin);
    await fiber;

    await bodyOf(root, "generate_image").execute({ prompt: "p" });
    cwd = "/second";
    await bodyOf(root, "generate_image").execute({ prompt: "p" });

    expect(generateImageToolMock.mock.calls.map((call) => call[2])).toEqual(["/first", "/second"]);
    await fiber.dispose();
  });
});
