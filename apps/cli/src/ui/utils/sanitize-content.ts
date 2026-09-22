// Sanitization helpers for assistant content — strips leading "assistant:"
// prefixes, trailing JSON tool-wrapper noise, and extracts follow-up
// suggestion metadata. Extracted from use-turn-engine.ts.

import { parseFollowupSuggestionContent, stripFollowupSuggestionMarkers } from "../../utils/followup-suggestions";

/**
 * The only raw content we keep uncommitted while streaming. It is large
 * enough for the bounded follow-up payload (four 72-character suggestions)
 * and the legacy tool-wrapper header, but keeps per-delta sanitization
 * independent of the full answer length.
 */
export const ASSISTANT_STREAM_PENDING_TAIL_CHARS = 512;

const ASSISTANT_PREFIX_RE = /^[\s\n]*assistant:\s*/i;
const TOOL_WRAPPER_START_RE = /\{"success"\s*:\s*(?:true|false)\s*,\s*"output"\s*:\s*"/m;
const ASSISTANT_PREFIX = "assistant:";

function couldStillBeAssistantPrefix(value: string): boolean {
  const withoutLeadingWhitespace = value.replace(/^[\s\n]*/, "").toLowerCase();
  return ASSISTANT_PREFIX.startsWith(withoutLeadingWhitespace);
}

/**
 * Incremental assistant preview with an append-only rendered prefix plus a
 * bounded raw tail. The full content still lives in the turn accumulator for
 * final sanitization and follow-up extraction; this object only prevents that
 * full-buffer work from running on every streamed delta.
 */
export interface AssistantStreamPreview {
  append(delta: string): string;
  reset(): void;
}

export function createAssistantStreamPreview(
  pendingTailChars = ASSISTANT_STREAM_PENDING_TAIL_CHARS,
): AssistantStreamPreview {
  let renderedPrefix = "";
  let pendingRaw = "";
  let prefixResolved = false;
  let droppingToolWrapper = false;

  const render = (): string => renderedPrefix + pendingRaw;

  return {
    append(delta: string): string {
      if (!delta || droppingToolWrapper) return render();

      pendingRaw += delta;

      // A legacy provider can prefix the first assistant delta with
      // `assistant:`. Hold only the tiny ambiguous prefix until it resolves;
      // normal text starts rendering as soon as it diverges.
      if (!prefixResolved) {
        const prefixMatch = pendingRaw.match(ASSISTANT_PREFIX_RE);
        if (prefixMatch) {
          pendingRaw = pendingRaw.slice(prefixMatch[0].length);
          prefixResolved = true;
        } else if (!couldStillBeAssistantPrefix(pendingRaw)) {
          prefixResolved = true;
        }
      }

      // The historical { success, output } wrapper is terminal noise. Its
      // start is short, so it always remains in the pending tail until we can
      // detect and suppress the rest of that wrapper.
      const wrapperMatch = pendingRaw.match(TOOL_WRAPPER_START_RE);
      if (wrapperMatch?.index !== undefined) {
        renderedPrefix += stripFollowupSuggestionMarkers(pendingRaw.slice(0, wrapperMatch.index));
        pendingRaw = "";
        droppingToolWrapper = true;
        return renderedPrefix;
      }

      // Closed markers are cheap to remove from the bounded tail. Their JSON
      // is intentionally not parsed here: finalization parses the full raw
      // accumulator once and stores the actual suggestions on the entry.
      pendingRaw = stripFollowupSuggestionMarkers(pendingRaw);

      if (pendingRaw.length > pendingTailChars) {
        const commitLength = pendingRaw.length - pendingTailChars;
        renderedPrefix += pendingRaw.slice(0, commitLength);
        pendingRaw = pendingRaw.slice(commitLength);
      }

      return render();
    },
    reset(): void {
      renderedPrefix = "";
      pendingRaw = "";
      prefixResolved = false;
      droppingToolWrapper = false;
    },
  };
}

export function sanitizeAssistantContent(raw: string): {
  content: string;
  followupSuggestions: string[];
} {
  let s = raw.replace(/^[\s\n]*assistant:\s*/gi, "");
  s = s.replace(/\{"success"\s*:\s*(true|false)\s*,\s*"output"\s*:\s*"[\s\S]*$/m, "");
  const parsed = parseFollowupSuggestionContent(s);
  return {
    content: parsed.content.trim(),
    followupSuggestions: parsed.suggestions,
  };
}

export function sanitizeContent(raw: string): string {
  return sanitizeAssistantContent(raw).content;
}
