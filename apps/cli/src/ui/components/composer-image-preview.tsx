import type { MouseEvent, TextareaRenderable } from "@opentui/core";
import { type RefObject, useCallback, useMemo, useState } from "react";
import { InlineImage } from "../ai-output/inline-image";
import type { Theme } from "../theme";

export type ComposerPasteBlock = {
  id: number;
  content: string;
  lines: number;
  isImage?: boolean;
};

const IMAGE_TOKEN_RE = /\[Image #(\d+)\]/g;

function findImageBlockAtOffset(text: string, offset: number, blocks: ComposerPasteBlock[]): ComposerPasteBlock | null {
  let match: RegExpExecArray | null = IMAGE_TOKEN_RE.exec(text);
  IMAGE_TOKEN_RE.lastIndex = 0;
  while (match) {
    const start = match.index;
    const end = start + match[0].length;
    if (offset >= start && offset < end) {
      const id = Number(match[1]);
      return blocks.find((b) => b.isImage && b.id === id) ?? null;
    }
    match = IMAGE_TOKEN_RE.exec(text);
  }
  return null;
}

function approximateOffsetFromMouse(localX: number, localY: number, text: string, width: number): number {
  if (!text) return 0;
  const lines = text.split("\n");
  const lineIdx = Math.max(0, Math.min(localY, lines.length - 1));
  let offset = 0;
  for (let i = 0; i < lineIdx; i++) offset += (lines[i]?.length ?? 0) + 1;
  const lineText = lines[lineIdx] ?? "";
  const charsPerLine = Math.max(1, width);
  const wrappedCol = lineIdx > 0 ? localX : localX;
  const col = Math.min(lineText.length, Math.max(0, wrappedCol % charsPerLine));
  return offset + col;
}

export function useComposerImageHover({
  pasteBlocks,
  inputRef,
  textareaWidth = 80,
}: {
  pasteBlocks: ComposerPasteBlock[];
  inputRef: RefObject<TextareaRenderable | null>;
  textareaWidth?: number;
}) {
  const imageBlocks = useMemo(() => pasteBlocks.filter((b) => b.isImage), [pasteBlocks]);
  const [hoveredId, setHoveredId] = useState<number | null>(null);

  const hoveredBlock = useMemo(() => imageBlocks.find((b) => b.id === hoveredId) ?? null, [imageBlocks, hoveredId]);

  const handleTextareaMouseMove = useCallback(
    (event: MouseEvent) => {
      const target = event.target as { x?: number; y?: number; width?: number } | null;
      if (!target || target.x === undefined || target.y === undefined) {
        setHoveredId(null);
        return;
      }
      const text = inputRef.current?.plainText ?? "";
      const localX = event.x - target.x;
      const localY = event.y - target.y;
      const width = target.width ?? textareaWidth;
      const offset = approximateOffsetFromMouse(localX, localY, text, width);
      const block = findImageBlockAtOffset(text, offset, imageBlocks);
      setHoveredId(block?.id ?? null);
    },
    [imageBlocks, inputRef, textareaWidth],
  );

  const clearHover = useCallback(() => setHoveredId(null), []);

  return {
    imageBlocks,
    hoveredId,
    hoveredBlock,
    setHoveredId,
    handleTextareaMouseMove,
    clearHover,
  };
}

export function ComposerImagePreview({
  t,
  hoveredBlock,
  imageBlocks,
}: {
  t: Theme;
  hoveredBlock: ComposerPasteBlock | null;
  imageBlocks: ComposerPasteBlock[];
}) {
  if (imageBlocks.length === 0) return null;

  return hoveredBlock ? (
    <box flexShrink={0} flexDirection="column" marginBottom={1}>
      <InlineImage t={t} src={hoveredBlock.content} maxWidthCells={48} maxHeightCells={12} />
    </box>
  ) : null;
}
