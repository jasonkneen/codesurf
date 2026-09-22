// Reasoning — collapsible thinking block with duration tracking + auto-close
// behaviour that matches @ai-sdk/elements' web version. Ported from termcast's
// ai-elements/reasoning.
//
// Composed via sub-components (Reasoning / ReasoningTrigger / ReasoningContent)
// that share state through a React context, so callers can lay out the
// trigger row and content independently.
//
// vs the existing ThinkingBlock (in ai-output/): this one tracks streaming
// duration ("Thought for 3s"), supports controllable open/defaultOpen, and
// auto-closes on stream end. ThinkingBlock is the simpler single-box form.

import { createContext, memo, type ReactNode, useCallback, useContext, useLayoutEffect, useRef, useState } from "react";
import type { Theme } from "../theme";

interface ReasoningCtxShape {
  t: Theme;
  isStreaming: boolean;
  isOpen: boolean;
  setIsOpen: (v: boolean) => void;
  duration: number | undefined;
}

const ReasoningCtx = createContext<ReasoningCtxShape | null>(null);

function useReasoningCtx(): ReasoningCtxShape {
  const ctx = useContext(ReasoningCtx);
  if (!ctx) {
    throw new Error("Reasoning sub-components must be rendered inside <Reasoning>.");
  }
  return ctx;
}

const AUTO_CLOSE_DELAY_MS = 1_000;
const MS_IN_S = 1_000;

export const Reasoning = memo(function Reasoning({
  t,
  isStreaming = false,
  open,
  defaultOpen = true,
  onOpenChange,
  duration: durationProp,
  children,
}: {
  t: Theme;
  isStreaming?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  duration?: number;
  children?: ReactNode;
}) {
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  const isOpen = open ?? localOpen;
  // Stable `setIsOpen` keyed on `onOpenChange` so the auto-close effect's
  // dep array can include it without re-running every render, and so the
  // context value below doesn't churn consumers on every parent render.
  const setIsOpen = useCallback(
    (v: boolean): void => {
      setLocalOpen(v);
      onOpenChange?.(v);
    },
    [onOpenChange],
  );

  const startTimeRef = useRef<number | null>(null);
  const [duration, setDuration] = useState<number | undefined>(durationProp);
  const [hasAutoClosed, setHasAutoClosed] = useState(false);

  useLayoutEffect(() => {
    if (isStreaming) {
      if (startTimeRef.current === null) {
        startTimeRef.current = Date.now();
      }
    } else if (startTimeRef.current !== null) {
      setDuration(Math.ceil((Date.now() - startTimeRef.current) / MS_IN_S));
      startTimeRef.current = null;
    }
  }, [isStreaming]);

  useLayoutEffect(() => {
    if (!isStreaming && isOpen && !hasAutoClosed && defaultOpen) {
      const timer = setTimeout(() => {
        setIsOpen(false);
        setHasAutoClosed(true);
      }, AUTO_CLOSE_DELAY_MS);
      return () => clearTimeout(timer);
    }
  }, [isStreaming, isOpen, hasAutoClosed, defaultOpen, setIsOpen]);

  return (
    <ReasoningCtx.Provider value={{ t, isStreaming, isOpen, setIsOpen, duration }}>
      <box flexDirection="column" marginBottom={1}>
        {children}
      </box>
    </ReasoningCtx.Provider>
  );
});

function defaultGetThinkingMessage(isStreaming: boolean, duration?: number): string {
  if (isStreaming || duration === 0) return "Thinking...";
  if (duration === undefined) return "Thought for a moment";
  return `Thought for ${duration}s`;
}

export const ReasoningTrigger = memo(function ReasoningTrigger({
  children,
  getThinkingMessage = defaultGetThinkingMessage,
}: {
  children?: ReactNode;
  getThinkingMessage?: (isStreaming: boolean, duration?: number) => ReactNode;
}) {
  const { t, isStreaming, isOpen, setIsOpen, duration } = useReasoningCtx();
  const [hovered, setHovered] = useState(false);
  const rawMessage = getThinkingMessage(isStreaming, duration);
  const displayText = typeof rawMessage === "string" ? rawMessage : "Thinking...";
  return (
    <box
      flexDirection="row"
      height={1}
      onMouseMove={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseDown={() => setIsOpen(!isOpen)}
    >
      {children ?? (
        // Match InlineTool chip style: `→ <label>` in textMuted, no accent
        // tint. Bold while streaming so the active "Thinking..." stands out
        // against finished tool lines without changing color. Chevron at the
        // end remains the click affordance for collapse/expand.
        <>
          <text fg={t.textMuted} wrapMode="none">
            {"→ "}
            {isStreaming ? <b>{displayText}</b> : displayText}
          </text>
          <box flexGrow={1} />
          <text fg={hovered ? t.accent : t.textMuted} wrapMode="none">
            {isOpen ? " ▲" : " ▼"}
          </text>
        </>
      )}
    </box>
  );
});

export const ReasoningContent = memo(function ReasoningContent({ children }: { children?: string }) {
  const { t, isOpen } = useReasoningCtx();
  if (!isOpen) return null;
  // Render reasoning as plain dimmed text (textMuted) rather than full
  // Markdown. Matches the "→ Thought for Xs" trigger color so the whole
  // chip reads as a single grey block. Reasoning content is rarely
  // markdown-formatted in practice — losing bold/code rendering is
  // acceptable here for visual consistency with other tool chips.
  const text = children ?? "";
  return (
    <box flexDirection="column" paddingLeft={2} paddingTop={1}>
      <text fg={t.textMuted} wrapMode="word">
        {text}
      </text>
    </box>
  );
});
