import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("StreamingResponse", () => {
  it("uses the markdown renderer's incremental streaming mode without a full fence scan", () => {
    const source = readFileSync(fileURLToPath(new URL("./streaming-response.tsx", import.meta.url)), "utf8");

    expect(source).toContain("<Markdown content={content} t={t} streaming />");
    expect(source).not.toContain("normalizeStreamingMarkdown");
    expect(source).not.toContain("content.match(/```/g)");
  });
});
