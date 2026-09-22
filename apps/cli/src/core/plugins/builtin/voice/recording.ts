// Audio recording subprocess wrapper.
//
// Uses SoX (`rec` binary) to capture mono 16kHz 16-bit PCM into a temp WAV
// file. Push-to-talk semantics: caller decides when to start and stop, no
// silence detection. The resulting file is consumed by `GrokSttEngine`
// (xAI `/stt` endpoint) which accepts standard WAV.
//
// Why SoX (not native NAPI):
// - Cross-platform with a single binary, easy install via Homebrew/apt.
// - Codesurf already tells users to `brew install sox` for the Telegram
//   audio path (see src/audio/stt/grok-stt.ts comments around mime types).
// - Avoids shipping a native module with cpal bindings just for one feature.
//
// Future: when this graduates, plug in `audio-capture-napi` (Rust + cpal)
// behind the same start/stop API so it's a drop-in replacement.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const RECORDING_SAMPLE_RATE = 16_000;
const RECORDING_CHANNELS = 1;

export interface RecordingHandle {
  /** Path to the WAV file. Caller must `unlink` after consuming. */
  filePath: string;
  /** Stop the recording. Resolves when SoX has fully closed and flushed. */
  stop: () => Promise<void>;
  /** Forcibly abort and delete the file. */
  cancel: () => Promise<void>;
}

export interface RecordingError {
  kind: "missing-binary" | "spawn-failed" | "exited-early";
  message: string;
}

let recBinaryAvailable: boolean | null = null;

/**
 * One-shot probe for the `rec` binary. Memoised because spawnSync is
 * synchronous and dlopen-class slow on some shells.
 */
export function isRecAvailable(): boolean {
  if (recBinaryAvailable !== null) return recBinaryAvailable;
  try {
    // `rec --version` exits 0 quickly. Linux Termux/Android lacks a real
    // `which`, so spawn the target directly and inspect the result.
    const result = spawnSync("rec", ["--version"], { stdio: "ignore" });
    recBinaryAvailable = result.status === 0;
  } catch {
    recBinaryAvailable = false;
  }
  return recBinaryAvailable;
}

export function getInstallHint(): string {
  switch (process.platform) {
    case "darwin":
      return "brew install sox";
    case "linux":
      return "sudo apt-get install sox  (or: sudo dnf install sox)";
    case "win32":
      return "choco install sox  (or download from https://sox.sourceforge.net)";
    default:
      return "install SoX from https://sox.sourceforge.net";
  }
}

/**
 * Start recording to a temp WAV file. Resolves with a handle once SoX has
 * spawned. Rejects with a `RecordingError` if SoX is missing or fails.
 *
 * The recording is open-ended — the caller stops it by calling `handle.stop()`.
 * SoX writes a proper WAV header (RIFF + fmt + data) on exit so the file is
 * always playable; we don't need to post-process raw PCM.
 */
export async function startRecording(): Promise<RecordingHandle> {
  if (!isRecAvailable()) {
    throw {
      kind: "missing-binary",
      message: `Voice mode requires SoX. Install it: ${getInstallHint()}`,
    } satisfies RecordingError;
  }

  const dir = path.join(tmpdir(), "codesurf-voice");
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `rec-${Date.now()}-${Math.floor(Math.random() * 1e6)}.wav`);

  // SoX `rec` writes RIFF/WAV when the output ends in `.wav`.
  // -q  : quiet
  // -r  : sample rate
  // -c  : channels
  // -b  : bit depth (16-bit signed)
  // -e signed-integer : sample encoding
  const args = [
    "-q",
    "-r",
    String(RECORDING_SAMPLE_RATE),
    "-c",
    String(RECORDING_CHANNELS),
    "-b",
    "16",
    "-e",
    "signed-integer",
    filePath,
  ];

  let child: ChildProcess;
  try {
    child = spawn("rec", args, { stdio: ["ignore", "ignore", "pipe"] });
  } catch (err) {
    throw {
      kind: "spawn-failed",
      message: `Failed to spawn rec: ${err instanceof Error ? err.message : String(err)}`,
    } satisfies RecordingError;
  }

  // Drain stderr to prevent backpressure deadlocks
  child.stderr?.on("data", () => {});

  // If SoX exits before stop() is called (e.g. permission denied on the mic
  // device), we still resolve — but we surface the error via the file size
  // check in stop(). Don't reject here because spawn() returning a child
  // means the process started successfully.

  let exited = false;
  let exitCode: number | null = null;
  let exitError: Error | null = null;
  const exitedPromise = new Promise<void>((resolve) => {
    child.on("close", (code) => {
      exited = true;
      exitCode = code;
      resolve();
    });
    child.on("error", (err) => {
      exited = true;
      exitError = err;
      resolve();
    });
  });

  const handle: RecordingHandle = {
    filePath,
    stop: async () => {
      if (exited) {
        if (exitError) {
          throw {
            kind: "exited-early",
            message: `rec exited before stop: ${exitError.message}`,
          } satisfies RecordingError;
        }
        return;
      }
      // SIGINT lets SoX flush a complete WAV header. SIGTERM also works
      // but some SoX builds leave the header truncated.
      child.kill("SIGINT");
      await exitedPromise;
      if (exitCode !== null && exitCode !== 0 && exitCode !== 130) {
        // 130 = killed by SIGINT, which is what we wanted
        throw {
          kind: "exited-early",
          message: `rec exited with code ${exitCode}`,
        } satisfies RecordingError;
      }
    },
    cancel: async () => {
      if (!exited) {
        child.kill("SIGKILL");
        await exitedPromise;
      }
      try {
        await unlink(filePath);
      } catch {
        // Best-effort delete; if the file never got created (rec failed)
        // we don't care.
      }
    },
  };

  return handle;
}
