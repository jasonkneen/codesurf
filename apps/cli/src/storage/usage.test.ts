import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getModelInfo } from "../grok/models";
import { closeDatabase } from "./db";
import { SessionStore } from "./sessions";
import { listSessionUsage, recordUsageEvent } from "./usage";

// Regression: `inputTokens` is now the cache-MISS slice on every path, so a
// cost built from it alone priced a cached turn's prefix at zero — a 38k-token
// prompt with 120 fresh tokens was costed as 120.

describe("usage cost estimate", () => {
  const tempRoot = path.join(process.cwd(), ".tmp-usage-tests");
  const originalCodesurfHome = process.env.CODESURF_HOME;
  let sessionId = "";

  beforeEach(() => {
    fs.mkdirSync(tempRoot, { recursive: true });
    const tempHome = fs.mkdtempSync(path.join(tempRoot, "home-"));
    const tempCwd = fs.mkdtempSync(path.join(tempRoot, "cwd-"));
    process.env.CODESURF_HOME = tempHome;
    closeDatabase();
    sessionId = new SessionStore(tempCwd).createSession("grok-4.6", "agent", tempCwd).id;
  });

  afterEach(() => {
    closeDatabase();
    if (originalCodesurfHome === undefined) delete process.env.CODESURF_HOME;
    else process.env.CODESURF_HOME = originalCodesurfHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("charges the cached prefix, not just the cache-miss slice", () => {
    const info = getModelInfo("grok-4.6");
    if (!info) throw new Error("grok-4.6 pricing missing");

    recordUsageEvent(sessionId, "message", "grok-4.6", {
      inputTokens: 120,
      outputTokens: 40,
      cacheReadTokens: 30_000,
      cacheWriteTokens: 8_000,
      totalTokens: 38_160,
    });

    const [event] = listSessionUsage(sessionId);
    expect(event?.costMicros).toBe(Math.round(38_120 * info.inputPrice + 40 * info.outputPrice));
  });

  it("prices an uncached turn from input and output alone", () => {
    const info = getModelInfo("grok-4.6");
    if (!info) throw new Error("grok-4.6 pricing missing");

    recordUsageEvent(sessionId, "message", "grok-4.6", { inputTokens: 500, outputTokens: 20, totalTokens: 520 });

    const [event] = listSessionUsage(sessionId);
    expect(event?.costMicros).toBe(Math.round(500 * info.inputPrice + 20 * info.outputPrice));
  });
});
