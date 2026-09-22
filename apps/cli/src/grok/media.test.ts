import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateImageTool, generateVideoTool, MAX_SOURCE_IMAGE_BYTES } from "./media";

const { generateImageMock, generateVideoMock } = vi.hoisted(() => ({
  generateImageMock: vi.fn(),
  generateVideoMock: vi.fn(),
}));

vi.mock("ai", () => ({
  generateImage: generateImageMock,
  experimental_generateVideo: generateVideoMock,
}));

describe("media tools", () => {
  let tempDir: string;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-media-"));
    generateImageMock.mockReset();
    generateVideoMock.mockReset();
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("generates edited images from a local source path and saves them under .grok/generated-media", async () => {
    const sourcePath = path.join(tempDir, "input.png");
    fs.writeFileSync(sourcePath, Buffer.from([1, 2, 3, 4]));
    generateImageMock.mockResolvedValue({
      images: [{ uint8Array: new Uint8Array([9, 8, 7]), mediaType: "image/png" }],
      warnings: [],
      providerMetadata: { xai: { images: [{ url: "https://example.com/generated.png" }] } },
      responses: [{ modelId: "grok-imagine-image" }],
    });

    const provider = {
      image: vi.fn((modelId: string) => ({ modelId })),
    };

    const result = await generateImageTool(
      provider as never,
      {
        prompt: "Turn this into a watercolor portrait",
        source: "input.png",
        resolution: "2k",
      },
      tempDir,
    );

    expect(result.success).toBe(true);
    expect(generateImageMock).toHaveBeenCalledTimes(1);
    expect(generateImageMock.mock.calls[0]?.[0]).toMatchObject({
      prompt: {
        text: "Turn this into a watercolor portrait",
      },
      providerOptions: {
        xai: {
          resolution: "2k",
        },
      },
    });
    expect(provider.image).toHaveBeenCalledWith("grok-imagine-image");

    const media = result.media ?? [];
    expect(media).toHaveLength(1);
    expect(media[0]?.sourcePath).toBe(sourcePath);
    expect(media[0]?.url).toBe("https://example.com/generated.png");
    expect(media[0]?.path).toContain(path.join(".grok", "generated-media"));
    expect(fs.existsSync(media[0]?.path ?? "")).toBe(true);
  });

  it("generates videos from a remote source image and respects output path and polling options", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(Buffer.from([5, 4, 3, 2]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      }),
    ) as unknown as typeof fetch;

    generateVideoMock.mockResolvedValue({
      videos: [{ uint8Array: new Uint8Array([1, 3, 5, 7]), mediaType: "video/mp4" }],
      warnings: [],
      providerMetadata: { xai: { videoUrl: "https://example.com/generated.mp4" } },
      responses: [{ modelId: "grok-imagine-video" }],
    });

    const provider = {
      video: vi.fn((modelId: string) => ({ modelId })),
    };

    const result = await generateVideoTool(
      provider as never,
      {
        prompt: "Animate a slow camera push with blinking eyes",
        source: "https://example.com/start-frame.jpg",
        duration: 6,
        resolution: "720p",
        poll_interval_ms: 2000,
        poll_timeout_ms: 900000,
        output_path: "clips/teaser",
      },
      tempDir,
    );

    expect(result.success).toBe(true);
    expect(generateVideoMock).toHaveBeenCalledTimes(1);
    expect(generateVideoMock.mock.calls[0]?.[0]).toMatchObject({
      prompt: {
        text: "Animate a slow camera push with blinking eyes",
      },
      duration: 6,
      providerOptions: {
        xai: {
          resolution: "720p",
          pollIntervalMs: 2000,
          pollTimeoutMs: 900000,
        },
      },
    });
    expect(provider.video).toHaveBeenCalledWith("grok-imagine-video");
    const prompt = generateVideoMock.mock.calls[0]?.[0]?.prompt as { image?: string };
    expect(prompt.image?.startsWith("data:image/jpeg;base64,")).toBe(true);

    const media = result.media ?? [];
    expect(media).toHaveLength(1);
    expect(media[0]?.sourceUrl).toBe("https://example.com/start-frame.jpg");
    expect(media[0]?.url).toBe("https://example.com/generated.mp4");
    expect(media[0]?.path).toBe(path.resolve(tempDir, "clips/teaser.mp4"));
    expect(fs.existsSync(media[0]?.path ?? "")).toBe(true);
  });

  it("does not commit output files when the request was aborted before the write", async () => {
    const controller = new AbortController();
    generateImageMock.mockImplementation(async () => {
      // The user cancels while the provider call is in flight; the SDK still resolves.
      controller.abort();
      return {
        images: [{ uint8Array: new Uint8Array([9, 8, 7]), mediaType: "image/png" }],
        warnings: [],
        providerMetadata: {},
        responses: [],
      };
    });
    const provider = { image: vi.fn((modelId: string) => ({ modelId })) };

    const result = await generateImageTool(
      provider as never,
      { prompt: "A lighthouse at dusk", output_path: "out/lighthouse.png" },
      tempDir,
      controller.signal,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cancelled/i);
    expect(result.media).toBeUndefined();
    expect(fs.existsSync(path.join(tempDir, "out"))).toBe(false);
    expect(fs.existsSync(path.join(tempDir, ".grok"))).toBe(false);
  });

  it("does not commit video output when the request was aborted before the write", async () => {
    const controller = new AbortController();
    generateVideoMock.mockImplementation(async () => {
      controller.abort();
      return {
        videos: [{ uint8Array: new Uint8Array([1, 3, 5, 7]), mediaType: "video/mp4" }],
        warnings: [],
        providerMetadata: {},
        responses: [],
      };
    });
    const provider = { video: vi.fn((modelId: string) => ({ modelId })) };

    const result = await generateVideoTool(provider as never, { prompt: "Waves" }, tempDir, controller.signal);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cancelled/i);
    expect(fs.existsSync(path.join(tempDir, ".grok"))).toBe(false);
  });

  it("rejects a remote source whose declared size exceeds the download bound before reading it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(Buffer.from([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/png", "content-length": String(MAX_SOURCE_IMAGE_BYTES + 1) },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const provider = { video: vi.fn((modelId: string) => ({ modelId })) };

    const result = await generateVideoTool(
      provider as never,
      { prompt: "Animate", source: "https://example.com/huge.png" },
      tempDir,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/too large/i);
    expect(generateVideoMock).not.toHaveBeenCalled();
  });

  it("stops downloading a remote source once its body exceeds the bound", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    const chunksToExceed = Math.ceil((MAX_SOURCE_IMAGE_BYTES + 1) / chunk.byteLength);
    // The source can supply far more than the bound; the reader must stop once it is crossed.
    const chunkCount = chunksToExceed * 3;
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= chunkCount) {
          controller.close();
          return;
        }
        pulled += 1;
        controller.enqueue(chunk);
      },
    });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(body, { status: 200, headers: { "content-type": "image/png" } }),
      ) as unknown as typeof fetch;
    const provider = { image: vi.fn((modelId: string) => ({ modelId })) };

    const result = await generateImageTool(
      provider as never,
      { prompt: "Edit", source: "https://example.com/stream.png" },
      tempDir,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/too large/i);
    // A couple of chunks of read-ahead is fine; consuming the whole source is not.
    expect(pulled).toBeLessThanOrEqual(chunksToExceed + 2);
    expect(generateImageMock).not.toHaveBeenCalled();
  });
});
