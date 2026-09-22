import { asLanguageModelUsage } from "ai/internal";
import { describe, expect, it } from "vitest";
import { totalBilledTokens, usageFromAiSdk, usageFromRecord } from "./provider-usage";

describe("usageFromRecord", () => {
  it("maps snake_case (Anthropic-style) fields", () => {
    expect(
      usageFromRecord({
        input_tokens: 10,
        output_tokens: 4,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 1,
      }),
    ).toEqual({ inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1 });
  });

  it("maps camelCase (Codex-style) fields", () => {
    expect(usageFromRecord({ inputTokens: 7, outputTokens: 3, cachedInputTokens: 5 })).toEqual({
      inputTokens: 7,
      outputTokens: 3,
      cacheReadTokens: 5,
      cacheWriteTokens: undefined,
    });
  });

  it("maps mixed casing, preferring the first recognized alias", () => {
    expect(usageFromRecord({ inputTokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_write_tokens: 4 })).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
    });
  });

  it("returns undefined for an object with no recognized numeric field", () => {
    expect(usageFromRecord({})).toBeUndefined();
    expect(usageFromRecord({ input_tokens: "10", other: true })).toBeUndefined();
  });

  it("returns undefined for non-object values", () => {
    expect(usageFromRecord(undefined)).toBeUndefined();
    expect(usageFromRecord(null)).toBeUndefined();
    expect(usageFromRecord("usage")).toBeUndefined();
    expect(usageFromRecord(42)).toBeUndefined();
  });

  it("codex regression: cache_creation_input_tokens sets cacheWriteTokens", () => {
    expect(usageFromRecord({ input_tokens: 9, output_tokens: 1, cache_creation_input_tokens: 6 })).toEqual({
      inputTokens: 9,
      outputTokens: 1,
      cacheReadTokens: undefined,
      cacheWriteTokens: 6,
    });
  });

  it("returns a snapshot when only a cache field is present", () => {
    expect(usageFromRecord({ cache_read_input_tokens: 8 })).toEqual({
      inputTokens: undefined,
      outputTokens: undefined,
      cacheReadTokens: 8,
      cacheWriteTokens: undefined,
    });
  });
});

describe("usageFromAiSdk", () => {
  // Built by the SDK's own converter from what the Anthropic provider reports
  // for a turn that read 30k cached tokens, wrote 8k, and sent 120 fresh.
  const anthropicTurn = asLanguageModelUsage({
    inputTokens: { total: 38_120, noCache: 120, cacheRead: 30_000, cacheWrite: 8_000 },
    outputTokens: { total: 40, text: 40, reasoning: undefined },
  });

  it("reports the no-cache slice as inputTokens, so billing counts the prefix once", () => {
    const usage = usageFromAiSdk(anthropicTurn);
    expect(usage).toMatchObject({ inputTokens: 120, cacheReadTokens: 30_000, cacheWriteTokens: 8_000 });
    expect(totalBilledTokens(usage ?? {})).toBe(38_160);
  });

  it("derives the no-cache slice when the provider leaves it unset", () => {
    const usage = usageFromAiSdk({
      ...anthropicTurn,
      inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: 30_000, cacheWriteTokens: 8_000 },
    });
    expect(usage?.inputTokens).toBe(120);
  });

  it("leaves an uncached turn's input untouched", () => {
    const usage = usageFromAiSdk(
      asLanguageModelUsage({
        inputTokens: { total: 500, noCache: 500, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 20, text: 20, reasoning: undefined },
      }),
    );
    expect(usage).toMatchObject({ inputTokens: 500, outputTokens: 20, totalTokens: 520 });
    expect(totalBilledTokens(usage ?? {})).toBe(520);
  });
});
