// Voice extension — push-to-talk speech-to-text for the prompt input.
//
// Architecture:
//   1. `state.ts`        — subscribable voice state store (idle/warming/recording/processing).
//   2. `recording.ts`    — SoX subprocess wrapper, records to a temp WAV file.
//   3. `ptt-handler.ts`  — keyboard hold-detection state machine (pure logic, testable).
//   4. `indicator.tsx`   — footer chip subscribing to the state store.
//   5. This file         — manifest + activation: wires interceptor + indicator + command.
//
// Flow:
//   user holds space → ptt-handler counts rapid auto-repeats → after 5
//   → activate. Strip leaked spaces from input. Spawn `rec` to a temp
//   WAV. Continued spaces keep the release timer alive. Gap > 250ms →
//   release. Stop SoX, finalise WAV, transcribe via existing
//   `GrokSttEngine` (xAI /stt). Insert transcript at original cursor.
//
// Settings (registered via `api.registerSetting`):
//   - voice.enabled         (bool)   — default false (opt-in)
//   - voice.keystroke       (string) — e.g. `"space"`, `"ctrl+v"`. default `"space"`.
//   - voice.language        (string) — STT language code, default `"en"`.
//
// Slash command:
//   /voice                  — toggle the enabled flag, status toast.
//
// Why opt-in: SoX is an external dep. Until the user turns it on, we don't
// touch their input event chain at all.

import type { CodesurfPlugin, PluginContext, PluginManifest } from "@codesurf/plugin-api";
import { createElement } from "react";
import { GrokSttEngine } from "../../../audio/stt/grok-stt";
import { getApiKey, getBaseURL } from "../../../utils/settings";
import { VoiceStatusIndicator } from "../builtin/voice/indicator";
import { createPttHandler, type HoldKeystroke } from "../builtin/voice/ptt-handler";
import { isRecAvailable, startRecording } from "../builtin/voice/recording";
import { getVoiceState, resetVoiceState, setVoiceState } from "../builtin/voice/state";

// ── Settings keys ─────────────────────────────────────────────────────────────

const SETTING_ENABLED = "voice.enabled";
const SETTING_KEYSTROKE = "voice.keystroke";
const SETTING_LANGUAGE = "voice.language";

const DEFAULT_KEYSTROKE = "space";
const DEFAULT_LANGUAGE = "en";

// ── Manifest ──────────────────────────────────────────────────────────────────

const manifest: PluginManifest = {
  id: "builtin.voice",
  name: "Voice (push-to-talk)",
  version: "0.1.0",
  description:
    "Hold a key (default: space) to dictate. Transcribed via xAI STT. Opt-in via /voice or the voice.enabled setting.",
  enabledByDefault: true,
  capabilities: ["commands", "settings", "status-indicators"],
  // Advisory metadata only: recording starts the local `rec` subprocess.
};

// ── Keystroke parsing ─────────────────────────────────────────────────────────

/**
 * Parse a keystroke string like `"space"`, `"ctrl+v"`, `"meta+space"` into a
 * `HoldKeystroke` shape. Single chars are also accepted (e.g. `"v"`).
 *
 * Format: `[modifier+]*key` where modifiers are any of `ctrl`, `meta`,
 * `alt`, `shift`, `cmd` (alias for meta). Case-insensitive on modifiers and
 * key names. Returns `null` on parse failure.
 */
export function parseKeystroke(input: string): HoldKeystroke | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  const parts = trimmed
    .split("+")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const key = parts.pop() ?? "";
  if (!key) return null;
  const ks: HoldKeystroke = { key };
  for (const mod of parts) {
    if (mod === "ctrl" || mod === "control") ks.ctrl = true;
    else if (mod === "meta" || mod === "cmd" || mod === "super") ks.meta = true;
    else if (mod === "alt" || mod === "option")
      ks.meta = true; // terminals fold alt→meta
    else if (mod === "shift") ks.shift = true;
    else return null;
  }
  return ks;
}

// ── Activation ────────────────────────────────────────────────────────────────

export const voicePlugin: CodesurfPlugin = {
  name: "codesurf-voice",
  manifest,
  inject: ["contributions", "screens", "settings", "chat", "ui", "lifecycle", "hostEvents", "input", "toast"],
  apply(ctx: PluginContext) {
    // Register settings (so they appear in `/extensions` config UI).
    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: SETTING_ENABLED,
        title: "Enable voice push-to-talk",
        description: "Hold a key (default: space) to dictate text into the prompt.",
        type: "boolean",
        default: false,
      }),
    );
    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: SETTING_KEYSTROKE,
        title: "Voice activation key",
        description: "Key to hold for push-to-talk. Examples: 'space', 'ctrl+v', 'meta+space'.",
        type: "string",
        default: DEFAULT_KEYSTROKE,
      }),
    );
    ctx.effect(() =>
      ctx.contributions.registerSetting({
        key: SETTING_LANGUAGE,
        title: "Voice language code",
        description: "BCP-47 language code passed to the STT engine. e.g. 'en', 'es'.",
        type: "string",
        default: DEFAULT_LANGUAGE,
      }),
    );

    // Mirror voice.enabled into the indicator state so the chip can show
    // "🎙 voice" while idle (persistent visual confirmation that PTT is on).
    setVoiceState((s) => ({
      ...s,
      enabled: ctx.settings.get<boolean>(SETTING_ENABLED, false) ?? false,
    }));
    // One effect owns the subscription and releases it on disposal.
    ctx.effect(() =>
      ctx.settings.subscribe(SETTING_ENABLED, (value) => {
        const enabled = value === true;
        setVoiceState((s) => ({ ...s, enabled }));
      }),
    );

    // Register the status indicator. Capture the disposer so the indicator
    // doesn't survive extension deactivation / hot reload.
    const disposeIndicator = ctx.effect(() =>
      ctx.screens.registerStatusIndicator({
        id: "voice.status",
        render: () => createElement(VoiceStatusIndicator),
      }),
    );
    ctx.effect(() => disposeIndicator);

    // /voice — toggle the enabled flag.
    ctx.effect(() =>
      ctx.contributions.registerCommand({
        name: "/voice",
        description: "Toggle voice push-to-talk on/off.",
        handler: () => {
          const cur = ctx.settings.get<boolean>(SETTING_ENABLED, false) ?? false;
          const next = !cur;
          ctx.settings.set(SETTING_ENABLED, next);
          if (next) {
            if (!isRecAvailable()) {
              ctx.toast.show({
                style: "failure",
                title: "Voice missing SoX",
                message: "Install with `brew install sox` (or equivalent for your platform).",
              });
              return;
            }
            ctx.toast.show({
              style: "info",
              title: `Voice enabled. Hold ${ctx.settings.get<string>(SETTING_KEYSTROKE, DEFAULT_KEYSTROKE)} to dictate.`,
            });
          } else {
            // Force-stop any in-flight recording when disabling.
            if (currentRecordingHandle) {
              void currentRecordingHandle.cancel();
              currentRecordingHandle = null;
            }
            resetVoiceState();
            ctx.toast.show({ style: "info", title: "Voice disabled." });
          }
        },
      }),
    );

    // Capture-time refs so the interceptor closure stays current as
    // settings change. Re-resolved each keypress so users can rebind /
    // toggle without restart.
    let currentRecordingHandle: Awaited<ReturnType<typeof startRecording>> | null = null;
    let savedAnchor: { value: string; cursor: number } | null = null;
    let pttHandler: ReturnType<typeof createPttHandler> | null = null;
    let lastKeystrokeStr: string | null = null;

    function rebuildHandler(keystrokeStr: string): void {
      const ks = parseKeystroke(keystrokeStr);
      if (!ks) {
        pttHandler = null;
        return;
      }
      pttHandler = createPttHandler({
        keystroke: ks,
        callbacks: {
          onWarmupBegin: () => {
            setVoiceState((s) => ({ ...s, phase: "warming", warmupCount: 0 }));
          },
          onWarmupTick: (count) => {
            setVoiceState((s) => ({ ...s, warmupCount: count }));
          },
          onWarmupAbandoned: () => {
            setVoiceState((s) => (s.phase === "warming" ? { ...s, phase: "idle", warmupCount: 0 } : s));
          },
          onActivate: (flowThroughChars) => {
            // 1. Capture anchor (current input value + cursor) BEFORE stripping.
            const value = ctx.input.getValue();
            const cursor = ctx.input.getCursor();
            const anchorCursor = Math.max(0, cursor - flowThroughChars);
            const anchorValue = value.slice(0, anchorCursor) + value.slice(cursor);
            savedAnchor = { value: anchorValue, cursor: anchorCursor };

            // 2. Strip the warmup chars that leaked through (if any).
            if (flowThroughChars > 0) {
              ctx.input.setValueWithCursor(anchorValue, anchorCursor);
            }

            // 3. Transition state and start SoX.
            setVoiceState((s) => ({
              ...s,
              phase: "recording",
              warmupCount: 0,
              recordingStartedAt: Date.now(),
              errorMessage: null,
            }));

            void startRecording()
              .then((handle) => {
                // If the user already released by the time SoX spawned,
                // the recording is moot — onRelease has already fired and
                // cleared currentRecordingHandle. Cancel the new handle.
                if (getVoiceState().phase !== "recording") {
                  void handle.cancel();
                  return;
                }
                currentRecordingHandle = handle;
              })
              .catch((err) => {
                const message =
                  err && typeof err === "object" && "message" in err
                    ? String((err as { message: unknown }).message)
                    : String(err);
                setVoiceState((s) => ({
                  ...s,
                  phase: "error",
                  errorMessage: message,
                }));
                ctx.toast.show({ style: "failure", title: message });
                // Reset to idle after 4s so the chip clears.
                setTimeout(() => {
                  setVoiceState((s) => (s.phase === "error" ? { ...s, phase: "idle", errorMessage: null } : s));
                }, 4_000);
              });
          },
          onRelease: () => {
            const handle = currentRecordingHandle;
            currentRecordingHandle = null;
            const anchor = savedAnchor;
            savedAnchor = null;

            if (!handle) {
              // Recording never actually started (SoX hadn't spawned yet,
              // or spawn failed). Reset.
              setVoiceState((s) => ({ ...s, phase: "idle", recordingStartedAt: null }));
              return;
            }

            setVoiceState((s) => ({ ...s, phase: "processing", recordingStartedAt: null }));

            void (async () => {
              try {
                await handle.stop();
              } catch (err) {
                const message =
                  err && typeof err === "object" && "message" in err
                    ? String((err as { message: unknown }).message)
                    : String(err);
                setVoiceState((s) => ({ ...s, phase: "error", errorMessage: message }));
                ctx.toast.show({ style: "failure", title: message });
                setTimeout(() => {
                  setVoiceState((s) => (s.phase === "error" ? { ...s, phase: "idle", errorMessage: null } : s));
                }, 4_000);
                return;
              }

              // Transcribe.
              const apiKey = getApiKey();
              if (!apiKey) {
                const message = "Voice STT requires CODESURF_API_KEY. Set it in env or ~/.codesurf/user-settings.json.";
                setVoiceState((s) => ({ ...s, phase: "error", errorMessage: message }));
                ctx.toast.show({ style: "failure", title: message });
                setTimeout(() => {
                  setVoiceState((s) => (s.phase === "error" ? { ...s, phase: "idle", errorMessage: null } : s));
                }, 4_000);
                return;
              }

              const language = ctx.settings.get<string>(SETTING_LANGUAGE, DEFAULT_LANGUAGE);
              const engine = new GrokSttEngine({
                apiKey,
                baseURL: getBaseURL(),
                language: language ?? DEFAULT_LANGUAGE,
              });

              try {
                const result = await engine.transcribe({ audioPath: handle.filePath });
                const transcript = result.text.trim();
                if (transcript && anchor) {
                  // Re-read live cursor in case the user typed during processing.
                  const liveValue = ctx.input.getValue();
                  // If the input has been edited away from the anchor, we
                  // still insert at the live cursor — better than dropping
                  // the transcript on the floor.
                  if (liveValue === anchor.value) {
                    const inserted =
                      anchor.value.slice(0, anchor.cursor) + transcript + anchor.value.slice(anchor.cursor);
                    ctx.input.setValueWithCursor(inserted, anchor.cursor + transcript.length);
                  } else {
                    ctx.input.insertText(transcript);
                  }
                }
                setVoiceState((s) => ({ ...s, phase: "idle" }));
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                setVoiceState((s) => ({ ...s, phase: "error", errorMessage: message }));
                ctx.toast.show({ style: "failure", title: `STT failed: ${message}` });
                setTimeout(() => {
                  setVoiceState((s) => (s.phase === "error" ? { ...s, phase: "idle", errorMessage: null } : s));
                }, 4_000);
              } finally {
                // Best-effort delete of the temp WAV.
                try {
                  const { unlink } = await import("node:fs/promises");
                  await unlink(handle.filePath);
                } catch {
                  // Ignore — the file may already be gone.
                }
              }
            })();
          },
        },
      });
      lastKeystrokeStr = keystrokeStr;
    }

    // Initial build.
    rebuildHandler(ctx.settings.get<string>(SETTING_KEYSTROKE, DEFAULT_KEYSTROKE) ?? DEFAULT_KEYSTROKE);

    // Re-build the handler on keystroke changes (so users can rebind live).
    ctx.effect(() =>
      ctx.settings.subscribe(SETTING_KEYSTROKE, (value) => {
        const next = typeof value === "string" && value.trim() ? value : DEFAULT_KEYSTROKE;
        if (next !== lastKeystrokeStr) rebuildHandler(next);
      }),
    );

    // The interceptor — runs on every keypress before the textarea sees it.
    // Returns true to swallow the key.
    // Owned by an effect: an interceptor that outlived the plugin would keep
    // swallowing keystrokes after it was disabled.
    ctx.effect(() =>
      ctx.input.intercept((key) => {
        const enabled = ctx.settings.get<boolean>(SETTING_ENABLED, false) ?? false;
        if (!enabled) return false;
        // Only intercept while the prompt input is focused — don't fight modals.
        if (!ctx.input.isFocused()) return false;
        if (!pttHandler) return false;
        return pttHandler.handleKey(key);
      }),
    );

    // Cancel any in-flight recording when the user interrupts the turn
    // (Esc / stop button) or the session ends — otherwise a held
    // push-to-talk that gets interrupted would keep SoX running until
    // release. NOTE: `Stop` fires on every successful turn settle (it is not
    // a user halt), which would kill a recording held across a turn boundary
    // — use UserInterrupt for the abort case.
    const cancelInFlight = () => {
      if (currentRecordingHandle) {
        void currentRecordingHandle.cancel();
        currentRecordingHandle = null;
      }
      if (getVoiceState().phase !== "idle") resetVoiceState();
    };
    const disposeStopSub = ctx.hostEvents.subscribe("UserInterrupt", cancelInFlight);
    const disposeSessionEndSub = ctx.hostEvents.subscribe("SessionEnd", cancelInFlight);
    ctx.effect(() => disposeStopSub);
    ctx.effect(() => disposeSessionEndSub);

    // Reset state on dispose so a re-activate starts clean. The cancel
    // promise is returned so the loader awaits it: deactivation resolves
    // only after SoX has exited and the temp WAV is gone.
    // Awaited on disposal: a held push-to-talk that is interrupted must not
    // leave SoX running, and the temp WAV must be gone before we resolve.
    ctx.effect(() => async () => {
      const handle = currentRecordingHandle;
      currentRecordingHandle = null;
      resetVoiceState();
      if (handle) await handle.cancel();
    });
  },
};
