import type { ProviderUsageSnapshot } from "../api";

/** Map a loosely-shaped usage record (Anthropic/Codex style, snake_case or
 *  camelCase) to a ProviderUsageSnapshot. Field aliases cover every provider
 *  in this directory EXCEPT opencode (nested tokens.cache shape) and the
 *  OpenAI SSE consumer (prompt_tokens vocabulary) — those keep local mappers.
 *  Returns undefined when no recognized field is present. */
export function usageFromRecord(value: unknown): ProviderUsageSnapshot | undefined {
  const u = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  if (!u) return undefined;
  const num = (...keys: string[]): number | undefined => {
    for (const k of keys) if (typeof u[k] === "number") return u[k] as number;
    return undefined;
  };
  const snapshot: ProviderUsageSnapshot = {
    inputTokens: num("inputTokens", "input_tokens"),
    outputTokens: num("outputTokens", "output_tokens"),
    cacheReadTokens: num("cacheReadTokens", "cachedInputTokens", "cache_read_tokens", "cache_read_input_tokens"),
    cacheWriteTokens: num(
      "cacheWriteTokens",
      "cachedCreationInputTokens",
      "cache_write_tokens",
      "cache_creation_input_tokens",
    ),
  };
  return snapshot.inputTokens === undefined &&
    snapshot.outputTokens === undefined &&
    snapshot.cacheReadTokens === undefined &&
    snapshot.cacheWriteTokens === undefined
    ? undefined
    : snapshot;
}

/**
 * Every token the turn was billed for.
 *
 * Relies on `inputTokens` being the cache-MISS slice, disjoint from
 * `cacheReadTokens` — which is how Anthropic reports it (`input_tokens`
 * already excludes `cache_read_input_tokens`) and how every adapter here that
 * populates a cache field derives it. The OpenAI SSE consumer folds cached
 * tokens into `prompt_tokens` but never sets a cache field, so its total stays
 * correct. Teaching that consumer to report `cached_tokens` therefore means
 * subtracting them from `inputTokens` at the same time, or this double-counts.
 */
export function totalBilledTokens(usage: {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): number {
  return (
    (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  );
}

/**
 * Normalize an AI SDK (v6) `LanguageModelUsage` to the miss-remainder shape
 * `totalBilledTokens` expects.
 *
 * The SDK's `inputTokens` is the WHOLE prompt — cache reads and writes
 * included — with the split under `inputTokenDetails`. Passing it through
 * as-is makes `totalBilledTokens` add the cached prefix a second time, so
 * `inputTokens` here is the no-cache slice. Falls back to subtracting the
 * cache fields when a provider leaves `noCacheTokens` unset.
 */
export function usageFromAiSdk(value: unknown):
  | {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    }
  | undefined {
  const u = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  if (!u) return undefined;
  const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
  const details =
    u.inputTokenDetails && typeof u.inputTokenDetails === "object"
      ? (u.inputTokenDetails as Record<string, unknown>)
      : {};
  const total = num(u.inputTokens);
  const cacheReadTokens = num(details.cacheReadTokens) ?? num(u.cachedInputTokens);
  const cacheWriteTokens = num(details.cacheWriteTokens);
  const inputTokens =
    num(details.noCacheTokens) ??
    (total === undefined ? undefined : Math.max(0, total - (cacheReadTokens ?? 0) - (cacheWriteTokens ?? 0)));
  return {
    inputTokens,
    outputTokens: num(u.outputTokens),
    totalTokens: num(u.totalTokens),
    cacheReadTokens,
    cacheWriteTokens,
  };
}
