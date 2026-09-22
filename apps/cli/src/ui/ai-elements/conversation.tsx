// Conversation — auto-scroll-to-bottom scrollbox wrapper plus an empty-state
// slot and a "scroll to bottom" button. Ported from termcast's
// ai-elements/conversation.

import type { ScrollBoxRenderable } from "@opentui/core";
import {
  createContext,
  type MutableRefObject,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { Theme } from "../theme";

interface ConversationCtxShape {
  t: Theme;
  scrollboxRef: MutableRefObject<ScrollBoxRenderable | null>;
  scrollToBottom: () => void;
}

const ConversationCtx = createContext<ConversationCtxShape | null>(null);

export function useConversation(): ConversationCtxShape {
  const ctx = useContext(ConversationCtx);
  if (!ctx) {
    throw new Error("Conversation sub-components must be rendered inside <Conversation>.");
  }
  return ctx;
}

export function Conversation({ t, children }: { t: Theme; children?: ReactNode }) {
  const scrollboxRef = useRef<ScrollBoxRenderable | null>(null);
  const scrollToBottom = (): void => {
    const sb = scrollboxRef.current as unknown as { scrollTo?: (y: number) => void } | null;
    sb?.scrollTo?.(Number.MAX_SAFE_INTEGER);
  };

  // Auto-scroll on every render. User-initiated scroll doesn't re-render, so
  // scrolling up to read history is still possible — the next incoming token
  // snaps back to the bottom.
  useLayoutEffect(() => {
    scrollToBottom();
  });

  return (
    <ConversationCtx.Provider value={{ t, scrollboxRef, scrollToBottom }}>
      <scrollbox ref={scrollboxRef} flexGrow={1} flexShrink={1} alignSelf="stretch">
        {children}
      </scrollbox>
    </ConversationCtx.Provider>
  );
}

export function ConversationContent({ children }: { children?: ReactNode }) {
  return (
    <box flexDirection="column" alignSelf="stretch">
      {children}
    </box>
  );
}

export function ConversationEmptyState({
  title = "No messages yet",
  description = "Start a conversation to see messages here",
  children,
}: {
  title?: string;
  description?: string;
  children?: ReactNode;
}) {
  const { t } = useConversation();
  return (
    <box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1} padding={4} gap={1}>
      {children ?? (
        <>
          <text fg={t.textMuted} wrapMode="none">
            <b>{title}</b>
          </text>
          {description && <text fg={t.textMuted}>{description}</text>}
        </>
      )}
    </box>
  );
}

export function ConversationScrollButton({ onClick }: { onClick?: () => void }) {
  const { t, scrollToBottom } = useConversation();
  const [hovered, setHovered] = useState(false);
  const handleClick = (): void => {
    onClick?.();
    scrollToBottom();
  };
  return (
    <box
      flexDirection="row"
      justifyContent="center"
      height={1}
      onMouseMove={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseDown={handleClick}
    >
      <text fg={hovered ? t.accent : t.textMuted} wrapMode="none">
        {"↓ scroll to bottom"}
      </text>
    </box>
  );
}
