import type { Theme } from "../theme";

export type PendingPasteBlock = {
  id: number;
  content: string;
  lines: number;
  isImage?: boolean;
};

export type PendingFileBlock = {
  path: string;
};

export type PendingQueuedMessage = {
  id: string;
  displayText: string;
};

/** `#1`, `#2`, … — 1-based queue index shown in the pending strip. */
export function formatPendingMessageIndex(index: number): string {
  return `#${index + 1}`;
}

/**
 * Build human-readable preview text for queued composer messages.
 * Image tokens become `[Image #N]: <path>`; pasted blocks keep their chip label.
 */
export function buildQueuedPreviewText(
  raw: string,
  pasteBlocks: PendingPasteBlock[],
  fileBlocks: PendingFileBlock[] = [],
): string {
  let preview = raw;
  for (const block of pasteBlocks) {
    const token = block.isImage ? `[Image #${block.id}]` : `[Pasted #${block.id} ${block.lines}+ lines]`;
    const replacement = block.isImage ? `[Image #${block.id}]` : `[Pasted #${block.id} ${block.lines}+ lines]`;
    preview = preview.replace(token, replacement);
  }
  for (const block of fileBlocks) {
    const name = block.path.split("/").pop() || block.path;
    preview = preview.replace(`[File: ${name}]`, `@${block.path}`);
  }
  return preview.trim();
}

export function ClaudeCodePendingMessages({
  t,
  queuedMessages,
  focusId,
}: {
  t: Theme;
  queuedMessages: PendingQueuedMessage[];
  focusId: string | null;
}) {
  if (queuedMessages.length === 0) return null;

  return (
    <box flexShrink={0} flexDirection="column" paddingLeft={2} paddingRight={2} marginTop={1}>
      {queuedMessages.map((msg, index) => {
        const isFocused = msg.id === focusId;
        return (
          <text key={msg.id} wrapMode="word">
            <span style={{ fg: t.textDim }}>{"• "}</span>
            <span style={{ fg: isFocused ? t.primary : t.textMuted }}>{formatPendingMessageIndex(index)}</span>
            <span style={{ fg: t.textDim }}> </span>
            <span style={{ fg: isFocused ? t.primary : t.textMuted }}>{msg.displayText}</span>
          </text>
        );
      })}
    </box>
  );
}
