/** Truncate to at most `max` chars, ellipsis included. `max <= 1` returns "". */
export function truncate(text: string, max: number): string {
  if (max <= 1) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
