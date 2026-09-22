import type { ChatEntry } from "../types/index";

const FOLLOWUP_MARKER_RE = /<!--\s*codesurf-followups\s*:\s*([\s\S]*?)\s*-->/gi;
const MAX_FOLLOWUPS = 4;
const MAX_FOLLOWUP_CHARS = 72;

export interface ParsedFollowupContent {
  content: string;
  suggestions: string[];
}

/**
 * Remove complete follow-up metadata comments without interpreting their JSON.
 *
 * The live TUI uses this on a small pending stream tail. Full parsing (and
 * suggestion extraction) remains a final-turn operation in
 * `parseFollowupSuggestionContent`, so a token stream never scans the whole
 * assistant accumulator just to hide metadata that has already closed.
 */
export function stripFollowupSuggestionMarkers(raw: string): string {
  FOLLOWUP_MARKER_RE.lastIndex = 0;
  return raw.replace(FOLLOWUP_MARKER_RE, "");
}

function normalizeSuggestion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length < 3 || trimmed.length > MAX_FOLLOWUP_CHARS) return null;
  return trimmed;
}

function uniqueSuggestions(values: readonly unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeSuggestion(value);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= MAX_FOLLOWUPS) break;
  }
  return out;
}

export function parseFollowupSuggestionContent(raw: string): ParsedFollowupContent {
  let suggestions: string[] = [];
  FOLLOWUP_MARKER_RE.lastIndex = 0;
  const content = raw.replace(FOLLOWUP_MARKER_RE, (_match, candidate: string) => {
    try {
      const json = candidate.trim();
      if (!json.startsWith("[")) return "";
      const parsed = JSON.parse(json);
      if (Array.isArray(parsed)) suggestions = uniqueSuggestions(parsed);
    } catch {
      // Ignore malformed markers; they should never leak into visible text.
    }
    return "";
  });
  return { content: content.trim(), suggestions };
}

function pushSuggestion(out: string[], seen: Set<string>, value: string): void {
  const normalized = normalizeSuggestion(value);
  if (!normalized) return;
  const key = normalized.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  out.push(normalized);
}

export function deriveFollowupSuggestions(
  entry: Pick<ChatEntry, "content" | "followupSuggestions"> | undefined,
): string[] {
  if (!entry) return [];
  const explicit = uniqueSuggestions(entry.followupSuggestions ?? []);
  if (explicit.length > 0) return explicit;

  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of entry.content.split(/\r?\n/)) {
    if (out.length >= MAX_FOLLOWUPS) break;
    const line = raw.trim();
    if (!line) continue;

    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      pushSuggestion(out, seen, `Tell me about ${heading[1].replace(/[*_`]/g, "")}`);
      continue;
    }

    if (
      line.length <= 40 &&
      !line.endsWith(".") &&
      !line.endsWith("?") &&
      /^[A-Z]/.test(line) &&
      /^[A-Za-z0-9 &/-]+$/.test(line)
    ) {
      pushSuggestion(out, seen, `Tell me about ${line.replace(/[*_`]/g, "")}`);
      continue;
    }

    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      const stripped = bullet[1].replace(/^(Write|Implement|Run|Review|Show me|Explain)\s+/i, "").trim();
      pushSuggestion(out, seen, stripped || bullet[1]);
    }
  }
  return out;
}
