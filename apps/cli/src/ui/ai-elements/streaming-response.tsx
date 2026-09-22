// StreamingResponse — markdown renderer for live assistant text.
// OpenTUI's streaming mode keeps only the trailing markdown block unstable,
// so it handles partial code fences/tables without a full response scan on
// every delta.

import { memo } from "react";
import { Markdown } from "../markdown";
import type { Theme } from "../theme";

export interface StreamingResponseProps {
  t: Theme;
  content: string;
  streaming?: boolean;
}

function StreamingResponseComponent({ t, content, streaming = false }: StreamingResponseProps) {
  if (!streaming) {
    return <Markdown content={content} t={t} />;
  }
  return <Markdown content={content} t={t} streaming />;
}

/**
 * Memoized StreamingResponse to prevent re-renders on every parent render.
 * Custom comparison ensures we only re-render when content, streaming, or theme actually changes.
 * This prevents unnecessary markdown re-parsing during streaming updates.
 */
export const StreamingResponse = memo(StreamingResponseComponent, (prevProps, nextProps) => {
  // Return true if props are equal (skip re-render)
  return (
    prevProps.content === nextProps.content &&
    prevProps.streaming === nextProps.streaming &&
    prevProps.t === nextProps.t
  );
});
