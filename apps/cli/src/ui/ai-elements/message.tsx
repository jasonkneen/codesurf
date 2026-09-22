// Message — role-labeled message bubble with a full slot system (content,
// actions, toolbar, branches, attachments). Ported from termcast's
// ai-elements/message. API mirrors @ai-sdk/elements' web version so
// Vercel examples copy over unchanged.

import React, { createContext, memo, type ReactNode, useContext, useState } from "react";
import type { Theme } from "../theme";
import { StreamingResponse } from "./streaming-response";

export type MessageRole = "user" | "assistant" | "system" | "tool";

interface RoleStyle {
  color: string;
  label: string;
  prefix: string;
}

function roleStyle(t: Theme, from: MessageRole): RoleStyle {
  const color: Record<MessageRole, string> = {
    user: t.accent,
    assistant: t.diffAddedFg,
    system: t.textMuted,
    tool: t.accent,
  };
  const label: Record<MessageRole, string> = {
    user: "You",
    assistant: "Assistant",
    system: "System",
    tool: "Tool",
  };
  const prefix: Record<MessageRole, string> = {
    user: "▸ ",
    assistant: "◆ ",
    system: "  ",
    tool: "$ ",
  };
  return { color: color[from], label: label[from], prefix: prefix[from] };
}

interface MessageCtxShape {
  t: Theme;
  from: MessageRole;
}
const MessageCtx = createContext<MessageCtxShape | null>(null);

function useMessageCtx(): MessageCtxShape {
  const ctx = useContext(MessageCtx);
  if (!ctx) {
    throw new Error("Message sub-components must be rendered inside <Message>.");
  }
  return ctx;
}

export function Message({
  t,
  from,
  timestamp,
  headerActions,
  children,
}: {
  t: Theme;
  from: MessageRole;
  /** Right-aligned timestamp in the header row (e.g. "18:59"). */
  timestamp?: string;
  /** Extra slot rendered in the header before the timestamp — used for
   *  per-message actions like `copy`, `regenerate`, `rate`. */
  headerActions?: ReactNode;
  children?: ReactNode;
}) {
  const { color, label, prefix } = roleStyle(t, from);
  // `_hovered` is wired via setHovered for future affordances (e.g. inline
  // action reveal on hover); the value isn't read yet but the mouse-state
  // tracking is kept so adding the affordance is a one-line edit.
  const [_hovered, setHovered] = useState(false);
  // termcast-style: user messages get a subtle panel background permanently
  // (not just on hover) so they read as bubbles; assistant/system/tool stay
  // on the default background.
  const userBg = from === "user" ? t.backgroundPanel : undefined;
  return (
    <MessageCtx.Provider value={{ t, from }}>
      <box
        flexDirection="column"
        alignSelf="stretch"
        marginBottom={1}
        paddingLeft={1}
        paddingRight={1}
        paddingTop={from === "user" ? 1 : 0}
        paddingBottom={from === "user" ? 1 : 0}
        backgroundColor={userBg}
        onMouseMove={() => setHovered(true)}
        onMouseOut={() => setHovered(false)}
      >
        <box flexDirection="row" height={1} alignSelf="stretch">
          <text fg={color} wrapMode="none">
            <b>
              {prefix}
              {label}
            </b>
          </text>
          <box flexGrow={1} />
          {headerActions}
          {timestamp && (
            <text fg={t.textMuted} wrapMode="none">
              {headerActions ? `  ${timestamp}` : timestamp}
            </text>
          )}
        </box>
        {children}
      </box>
    </MessageCtx.Provider>
  );
}

export function MessageContent({ children }: { children?: ReactNode }) {
  return (
    <box flexDirection="column" paddingLeft={2} alignSelf="stretch">
      {children}
    </box>
  );
}

export const MessageResponse = memo(function MessageResponse({
  children,
  streaming = false,
}: {
  children?: string;
  streaming?: boolean;
}) {
  const { t } = useMessageCtx();
  return <StreamingResponse t={t} content={children ?? ""} streaming={streaming} />;
});

export function MessageActions({ children }: { children?: ReactNode }) {
  return (
    <box flexDirection="row" gap={1} paddingLeft={2} paddingTop={1} height={1}>
      {children}
    </box>
  );
}

export function MessageAction({ label, tooltip, onClick }: { label?: string; tooltip?: string; onClick?: () => void }) {
  const { t } = useMessageCtx();
  const [hovered, setHovered] = useState(false);
  const display = label ?? tooltip ?? "·";
  return (
    <text
      fg={hovered ? t.accent : t.textMuted}
      wrapMode="none"
      onMouseMove={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseDown={onClick}
    >
      {`[${display}]`}
    </text>
  );
}

export function MessageToolbar({ children }: { children?: ReactNode }) {
  return (
    <box flexDirection="row" paddingLeft={2} paddingTop={1} height={1} justifyContent="space-between">
      {children}
    </box>
  );
}

// ── Branching ────────────────────────────────────────────────────────────────

interface MessageBranchCtxShape {
  t: Theme;
  current: number;
  total: number;
  prev: () => void;
  next: () => void;
}

const MessageBranchCtx = createContext<MessageBranchCtxShape | null>(null);

function useBranchCtx(): MessageBranchCtxShape {
  const ctx = useContext(MessageBranchCtx);
  if (!ctx) {
    throw new Error("Branch sub-components must be rendered inside <MessageBranch>.");
  }
  return ctx;
}

export function MessageBranch({
  t,
  defaultBranch = 0,
  onBranchChange,
  children,
}: {
  t: Theme;
  defaultBranch?: number;
  onBranchChange?: (index: number) => void;
  children?: ReactNode;
}) {
  const [current, setCurrent] = useState(defaultBranch);
  const childArray = React.Children.toArray(children);
  const total = childArray.length;
  const go = (n: number): void => {
    setCurrent(n);
    onBranchChange?.(n);
  };
  const prev = (): void => go(current > 0 ? current - 1 : total - 1);
  const next = (): void => go(current < total - 1 ? current + 1 : 0);
  return (
    <MessageBranchCtx.Provider value={{ t, current, total, prev, next }}>
      <box flexDirection="column">{children}</box>
    </MessageBranchCtx.Provider>
  );
}

export function MessageBranchContent({ children }: { children?: ReactNode }) {
  const { current } = useBranchCtx();
  const childArray = React.Children.toArray(children);
  return <>{childArray[current] ?? null}</>;
}

export function MessageBranchSelector({ children }: { children?: ReactNode }) {
  const { total } = useBranchCtx();
  if (total <= 1) return null;
  return (
    <box flexDirection="row" gap={0} height={1} paddingLeft={2}>
      {children}
    </box>
  );
}

export function MessageBranchPrevious({ onClick }: { onClick?: () => void }) {
  const { t, prev, total } = useBranchCtx();
  if (total <= 1) return null;
  return (
    <text fg={t.accent} wrapMode="none" onMouseDown={onClick ?? prev}>
      {"‹"}
    </text>
  );
}

export function MessageBranchNext({ onClick }: { onClick?: () => void }) {
  const { t, next, total } = useBranchCtx();
  if (total <= 1) return null;
  return (
    <text fg={t.accent} wrapMode="none" onMouseDown={onClick ?? next}>
      {"›"}
    </text>
  );
}

export function MessageBranchPage() {
  const { t, current, total } = useBranchCtx();
  return (
    <text fg={t.textMuted} wrapMode="none">
      {` ${current + 1}/${total} `}
    </text>
  );
}

// ── Attachments ──────────────────────────────────────────────────────────────

export interface FileUIPart {
  type?: string;
  url?: string;
  mediaType?: string;
  filename?: string;
}

export function MessageAttachment({ data, onRemove }: { data: FileUIPart; onRemove?: () => void }) {
  const { t } = useMessageCtx();
  const name = data.filename ?? (data.mediaType?.startsWith("image/") ? "image" : "file");
  const isImage = data.mediaType?.startsWith("image/");
  const icon = isImage ? "[img] " : "[file] ";
  const [hovered, setHovered] = useState(false);
  return (
    <box
      flexDirection="row"
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={t.backgroundPanel}
      onMouseMove={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
    >
      <text fg={t.textMuted} wrapMode="none">
        {icon}
        {name}
      </text>
      {onRemove && hovered && (
        <text fg={t.diffRemovedFg} wrapMode="none" onMouseDown={onRemove}>
          {" ×"}
        </text>
      )}
    </box>
  );
}

export function MessageAttachments({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return (
    <box flexDirection="row" flexWrap="wrap" gap={1} paddingLeft={2} paddingTop={1}>
      {children}
    </box>
  );
}
