import { mkdtemp, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { createTelegramAudioInputEngine } from "../audio/stt/engine";
import type { TelegramSettings } from "../utils/settings";
import { resolveTelegramAudioInputSettings } from "../utils/settings";

export interface TelegramAudioSource {
  kind: "voice" | "audio";
  fileId: string;
  fileName?: string;
  mimeType?: string;
}

export interface TelegramFileApi {
  getFile(fileId: string, signal?: AbortSignal): Promise<{ file_path?: string }>;
}

export interface TelegramAudioTranscription {
  promptText: string;
  userContent: string;
}

/** Bot API file downloads are capped at 20 MB by Telegram; refuse anything larger before buffering it. */
export const MAX_TELEGRAM_AUDIO_BYTES = 20 * 1024 * 1024;

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Telegram audio transcription aborted");
}

/** Stop waiting on `promise` as soon as `signal` aborts (the underlying work is not cancelled). */
function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function tooLarge(maxBytes: number): Error {
  return new Error(`Telegram audio exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB download limit.`);
}

/** Buffer the response body, aborting the read as soon as it exceeds `maxBytes`. */
async function readBodyBounded(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge(maxBytes);
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw tooLarge(maxBytes);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge(maxBytes);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export function getTelegramAudioSource(message: {
  voice?: { file_id: string; mime_type?: string };
  audio?: { file_id: string; file_name?: string; mime_type?: string };
}): TelegramAudioSource | null {
  if (message.voice) {
    return {
      kind: "voice",
      fileId: message.voice.file_id,
      mimeType: message.voice.mime_type,
    };
  }

  if (message.audio) {
    return {
      kind: "audio",
      fileId: message.audio.file_id,
      fileName: message.audio.file_name,
      mimeType: message.audio.mime_type,
    };
  }

  return null;
}

export function formatTelegramAudioTranscript(kind: TelegramAudioSource["kind"], transcript: string): string {
  const label = kind === "voice" ? "Voice" : "Audio";
  return `[${label} transcript] ${transcript}`;
}

export async function transcribeTelegramAudioMessage(opts: {
  api: TelegramFileApi;
  token: string;
  source: TelegramAudioSource;
  telegramSettings: TelegramSettings | undefined;
  /** Bridge/turn-owned cancellation for getFile, the download and the transcription wait. */
  signal?: AbortSignal;
  /** Download bound; defaults to Telegram's own 20 MB Bot API file limit. */
  maxBytes?: number;
}): Promise<TelegramAudioTranscription> {
  const audioSettings = resolveTelegramAudioInputSettings(opts.telegramSettings);
  if (!audioSettings.enabled) {
    throw new Error("Telegram audio input is disabled in settings.");
  }
  const { signal } = opts;
  const maxBytes = opts.maxBytes ?? MAX_TELEGRAM_AUDIO_BYTES;
  if (signal?.aborted) throw abortReason(signal);

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "grok-telegram-audio-"));
  try {
    const file = await opts.api.getFile(opts.source.fileId, signal);
    if (!file.file_path) {
      throw new Error("Telegram did not return a downloadable file path for this audio message.");
    }

    const response = await fetch(`https://api.telegram.org/file/bot${opts.token}/${file.file_path}`, { signal });
    if (!response.ok) {
      throw new Error(`Telegram audio download failed: ${response.status} ${response.statusText}`);
    }

    const extension = inferTelegramAudioExtension(opts.source, file.file_path);
    const fileName = buildTelegramAudioFileName(opts.source, extension);
    const audioPath = path.join(tempDir, fileName);
    if (!isPathInside(audioPath, tempDir)) {
      throw new Error("Refusing to write Telegram audio outside the temp directory.");
    }
    const bytes = await readBodyBounded(response, maxBytes);
    await writeFile(audioPath, bytes, { mode: 0o600 });

    const engine = createTelegramAudioInputEngine(opts.telegramSettings);
    // The engine cancels its file read and STT request on `signal`; raceAbort
    // stays as the fallback for an engine that ignores it, so the temp dir is
    // released and the bridge turn can finish either way.
    const result = await raceAbort(
      engine.transcribe({
        audioPath,
        fileName,
        mimeType: opts.source.mimeType,
        signal,
      }),
      signal,
    );

    return {
      promptText: result.text,
      userContent: formatTelegramAudioTranscript(opts.source.kind, result.text),
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export function buildTelegramAudioFileName(source: TelegramAudioSource, extension: string): string {
  const fallback = `input${extension}`;
  if (!source.fileName) {
    return fallback;
  }

  const sanitized = source.fileName.replace(/\0/g, "").split(/[\\/]/u).pop()?.trim();

  if (!sanitized || sanitized === "." || sanitized === "..") {
    return fallback;
  }

  return sanitized;
}

function isPathInside(target: string, parent: string): boolean {
  const resolvedParent = path.resolve(parent);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedParent, resolvedTarget);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function inferTelegramAudioExtension(source: TelegramAudioSource, filePath?: string): string {
  const fromPath = filePath ? path.extname(filePath) : "";
  if (fromPath) return fromPath;

  const fromName = source.fileName ? path.extname(source.fileName) : "";
  if (fromName) return fromName;

  switch ((source.mimeType || "").toLowerCase()) {
    case "audio/ogg":
      return ".ogg";
    case "audio/opus":
      return ".opus";
    case "audio/mpeg":
      return ".mp3";
    case "audio/mp4":
    case "audio/x-m4a":
      return ".m4a";
    case "audio/wav":
    case "audio/x-wav":
      return ".wav";
    default:
      return source.kind === "voice" ? ".ogg" : ".bin";
  }
}
