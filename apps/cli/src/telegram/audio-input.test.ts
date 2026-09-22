import { existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildTelegramAudioFileName,
  formatTelegramAudioTranscript,
  getTelegramAudioSource,
  transcribeTelegramAudioMessage,
} from "./audio-input";

// Record every temp dir the module creates so tests can prove `finally`
// removed it even when the operation was abandoned mid-flight.
const tempDirs = vi.hoisted(() => ({ created: [] as string[] }));
vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return {
    ...actual,
    mkdtemp: async (prefix: string) => {
      const dir = await actual.mkdtemp(prefix);
      tempDirs.created.push(dir);
      return dir;
    },
  };
});

const stt = vi.hoisted(() => ({
  createEngine:
    vi.fn<() => { transcribe: (input: { audioPath: string; signal?: AbortSignal }) => Promise<{ text: string }> }>(),
}));
vi.mock("../audio/stt/engine", () => ({
  createTelegramAudioInputEngine: () => stt.createEngine(),
}));

/** A fetch stand-in that behaves like the real one on abort: rejects once `init.signal` fires. */
function hangingFetch() {
  return vi.fn(
    (_url: string, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }),
  );
}

function okAudioResponse(bytes: number, headers?: Record<string, string>): Response {
  return new Response(new Uint8Array(bytes), { status: 200, headers });
}

const voice = { kind: "voice" as const, fileId: "voice-file", mimeType: "audio/ogg" };
const api = { getFile: vi.fn(async (_fileId: string, _signal?: AbortSignal) => ({ file_path: "voice/file_1.oga" })) };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  stt.createEngine.mockReset();
  tempDirs.created.length = 0;
});

describe("transcribeTelegramAudioMessage cancellation and bounds (NET-5)", () => {
  it("a hanging download is abandoned on abort and the temp dir is removed", async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    const run = transcribeTelegramAudioMessage({
      api,
      token: "t",
      source: voice,
      telegramSettings: undefined,
      signal: controller.signal,
    });
    // Let getFile resolve and the fetch start.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(api.getFile).toHaveBeenLastCalledWith("voice-file", controller.signal);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);

    controller.abort(new Error("bridge stopped"));
    await expect(run).rejects.toThrow("bridge stopped");
    expect(tempDirs.created).toHaveLength(1);
    expect(existsSync(tempDirs.created[0]!)).toBe(false);
    expect(stt.createEngine).not.toHaveBeenCalled();
  });

  it("a hanging transcription is abandoned on abort and the temp dir is removed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okAudioResponse(16)),
    );
    // The engine hangs, and records the signal it was handed so the test can
    // prove cancellation reaches the STT request itself rather than only
    // racing the wait (which would leave the upload running in background).
    const transcribe = vi.fn(
      (_input: { audioPath: string; signal?: AbortSignal }) => new Promise<{ text: string }>(() => {}),
    );
    stt.createEngine.mockReturnValue({ transcribe });
    const controller = new AbortController();

    const run = transcribeTelegramAudioMessage({
      api,
      token: "t",
      source: voice,
      telegramSettings: undefined,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(stt.createEngine).toHaveBeenCalledTimes(1));
    expect(transcribe).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
    expect(transcribe.mock.calls[0]?.[0]?.signal?.aborted).toBe(false);

    controller.abort(new Error("turn reset"));
    await expect(run).rejects.toThrow("turn reset");
    // The engine's own signal fired, so its file read and HTTP request abort.
    expect(transcribe.mock.calls[0]?.[0]?.signal?.aborted).toBe(true);
    expect(existsSync(tempDirs.created[0]!)).toBe(false);
  });

  it("refuses a body larger than the download bound before transcribing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okAudioResponse(64)),
    );

    await expect(
      transcribeTelegramAudioMessage({ api, token: "t", source: voice, telegramSettings: undefined, maxBytes: 32 }),
    ).rejects.toThrow(/download limit/);
    expect(stt.createEngine).not.toHaveBeenCalled();
    expect(existsSync(tempDirs.created[0]!)).toBe(false);
  });

  it("refuses a declared content-length above the bound without reading the body", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("body must not be read");
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 200, headers: { "content-length": "999" } })),
    );

    await expect(
      transcribeTelegramAudioMessage({ api, token: "t", source: voice, telegramSettings: undefined, maxBytes: 32 }),
    ).rejects.toThrow(/download limit/);
    expect(stt.createEngine).not.toHaveBeenCalled();
  });

  it("does not call Telegram at all when the signal is already aborted", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const getFile = vi.fn();
    const controller = new AbortController();
    controller.abort(new Error("already stopped"));

    await expect(
      transcribeTelegramAudioMessage({
        api: { getFile },
        token: "t",
        source: voice,
        telegramSettings: undefined,
        signal: controller.signal,
      }),
    ).rejects.toThrow("already stopped");
    expect(getFile).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("transcribes a bounded download end to end", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okAudioResponse(16)),
    );
    stt.createEngine.mockReturnValue({ transcribe: async () => ({ text: "hi there" }) });

    await expect(
      transcribeTelegramAudioMessage({ api, token: "t", source: voice, telegramSettings: undefined, maxBytes: 32 }),
    ).resolves.toEqual({ promptText: "hi there", userContent: "[Voice transcript] hi there" });
    expect(existsSync(tempDirs.created[0]!)).toBe(false);
  });
});

describe("telegram audio input helpers", () => {
  it("extracts a voice source from a telegram message payload", () => {
    expect(
      getTelegramAudioSource({
        voice: {
          file_id: "voice-file",
          mime_type: "audio/ogg",
        },
      }),
    ).toEqual({
      kind: "voice",
      fileId: "voice-file",
      mimeType: "audio/ogg",
    });
  });

  it("extracts an audio attachment source from a telegram message payload", () => {
    expect(
      getTelegramAudioSource({
        audio: {
          file_id: "audio-file",
          file_name: "song.mp3",
          mime_type: "audio/mpeg",
        },
      }),
    ).toEqual({
      kind: "audio",
      fileId: "audio-file",
      fileName: "song.mp3",
      mimeType: "audio/mpeg",
    });
  });

  it("formats user-visible transcript prefixes for voice and audio messages", () => {
    expect(formatTelegramAudioTranscript("voice", "hello there")).toBe("[Voice transcript] hello there");
    expect(formatTelegramAudioTranscript("audio", "demo")).toBe("[Audio transcript] demo");
  });
});

describe("buildTelegramAudioFileName", () => {
  const voice = { kind: "voice" as const, fileId: "f" };
  const audio = (fileName?: string) => ({ kind: "audio" as const, fileId: "f", fileName });

  it("falls back to input<ext> when no filename is provided", () => {
    expect(buildTelegramAudioFileName(voice, ".ogg")).toBe("input.ogg");
  });

  it("preserves safe filenames", () => {
    expect(buildTelegramAudioFileName(audio("song.mp3"), ".mp3")).toBe("song.mp3");
  });

  it("strips POSIX path traversal attempts", () => {
    expect(buildTelegramAudioFileName(audio("../../etc/passwd"), ".bin")).toBe("passwd");
    expect(buildTelegramAudioFileName(audio("/etc/passwd"), ".bin")).toBe("passwd");
  });

  it("strips Windows-style path traversal attempts", () => {
    expect(buildTelegramAudioFileName(audio("..\\..\\Windows\\evil.mp3"), ".mp3")).toBe("evil.mp3");
    expect(buildTelegramAudioFileName(audio("C:\\evil\\song.mp3"), ".mp3")).toBe("song.mp3");
  });

  it("falls back to input<ext> for dot-only or empty sanitized names", () => {
    expect(buildTelegramAudioFileName(audio("../"), ".mp3")).toBe("input.mp3");
    expect(buildTelegramAudioFileName(audio(".."), ".mp3")).toBe("input.mp3");
    expect(buildTelegramAudioFileName(audio("."), ".mp3")).toBe("input.mp3");
    expect(buildTelegramAudioFileName(audio("   "), ".mp3")).toBe("input.mp3");
  });

  it("drops null bytes from the sanitized name", () => {
    expect(buildTelegramAudioFileName(audio("song\0.mp3"), ".mp3")).toBe("song.mp3");
  });
});
