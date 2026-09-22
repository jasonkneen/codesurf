// Web InlineImage — an <img> against the node's /files endpoint.
//
// The terminal module (src/ui/ai-output/inline-image.tsx) imports bun:ffi and
// sharp for Kitty graphics. Vite aliases that specifier here so the live front
// can render screenshots without those natives. Clip/suppress/row-estimate
// exports exist so message-list and modal-guard keep compiling.

import type { CSSProperties } from "react";
import type { Theme } from "../ui/theme.js";
import { hostFiles } from "./host-files.js";

export interface InlineImageProps {
  src: string;
  maxWidthCells?: number;
  maxHeightCells?: number;
  t: Theme;
}

export function setInlineImageClipBounds(_top: number, _bottom: number): void {}
export function setInlineImageSuppressed(_suppressed: boolean): void {}
export function estimateInlineImageRows(_src: string, fallback = 8): number {
  return fallback;
}

export function InlineImage({ src, maxWidthCells = 60, maxHeightCells = 16 }: InlineImageProps) {
  const href = hostFiles.hrefForPath(src);
  const style: CSSProperties = {
    maxWidth: `calc(${maxWidthCells} * 1ch)`,
    maxHeight: `calc(${maxHeightCells} * var(--row))`,
    objectFit: "contain",
    display: "block",
  };
  return (
    <box marginBottom={1}>
      <img src={href} alt="" style={style} />
    </box>
  );
}
