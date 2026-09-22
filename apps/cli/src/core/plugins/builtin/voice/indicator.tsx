// Voice status indicator — small chip rendered in the prompt footer via
// `api.registerStatusIndicator`. Subscribes to the voice state store with
// useSyncExternalStore so it re-renders only on voice phase transitions
// (not on every app render).

import { memo, useEffect, useState, useSyncExternalStore } from "react";
import { useIcon } from "../../icons";
import { getVoiceState, subscribeVoiceState, type VoiceState } from "./state";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const VoiceStatusIndicator = memo(function VoiceStatusIndicator() {
  const state = useSyncExternalStore(subscribeVoiceState, getVoiceState, getVoiceState);
  const voiceIcon = useIcon("voice");
  const voicePrefix = voiceIcon ? `${voiceIcon} ` : "";

  if (state.phase === "idle") {
    if (!state.enabled) return null;
    return (
      <text fg="#7280a0" wrapMode="none">
        {`${voicePrefix}voice`}
      </text>
    );
  }
  if (state.phase === "error" && !state.errorMessage) return null;

  return <Chip state={state} voicePrefix={voicePrefix} />;
});

function Chip({ state, voicePrefix }: { state: VoiceState; voicePrefix: string }) {
  switch (state.phase) {
    case "warming":
      return (
        <text fg="#e5c07b" wrapMode="none">
          {`◌ ${voicePrefix}voice ${state.warmupCount}/5`}
        </text>
      );
    case "recording":
      return <RecordingChip startedAt={state.recordingStartedAt} voicePrefix={voicePrefix} />;
    case "processing":
      return <ProcessingChip voicePrefix={voicePrefix} />;
    case "error":
      return (
        <text fg="#ff6b6b" wrapMode="none">
          {`! ${voicePrefix}voice: ${formatVoiceError(state.errorMessage)}`}
        </text>
      );
    default:
      return null;
  }
}

function formatVoiceError(message: string | null): string {
  if (message === "Grok STT returned an empty transcript.") {
    return "no voice";
  }
  return message ?? "error";
}

function RecordingChip({ startedAt, voicePrefix }: { startedAt: number | null; voicePrefix: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  const elapsedMs = startedAt !== null ? now - startedAt : 0;
  const seconds = Math.floor(elapsedMs / 1000);
  const mm = Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0");
  const ss = (seconds % 60).toString().padStart(2, "0");
  return (
    <text fg="#ff6b6b" wrapMode="none">
      {`● ${voicePrefix}rec ${mm}:${ss}`}
    </text>
  );
}

function ProcessingChip({ voicePrefix }: { voicePrefix: string }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => (n + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(id);
  }, []);
  return (
    <text fg="#5c9cf5" wrapMode="none">
      {`${SPINNER_FRAMES[tick]} ${voicePrefix}transcribing`}
    </text>
  );
}
