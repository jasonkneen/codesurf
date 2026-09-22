import { describe, expect, it } from "vitest";
import { chunkCode, detectLanguage } from "./chunker.js";
import type { CodeChunk } from "./types.js";

/**
 * Every non-blank line of `content` must fall inside some chunk's line range
 * and appear in that chunk's text. Guards against any region (preamble, tail,
 * decorators between declarations) silently vanishing from the index.
 */
function expectFullCoverage(content: string, chunks: CodeChunk[]): void {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!.trim();
    if (!text) continue;
    const lineNo = i + 1;
    const owner = chunks.find(
      (chunk) => chunk.metadata.startLine <= lineNo && lineNo <= chunk.metadata.endLine && chunk.content.includes(text),
    );
    expect(owner, `line ${lineNo} (${text}) is not covered by any chunk`).toBeDefined();
  }
}

// Verbatim pre-fix structural algorithm (HEAD 3383e20 chunker.ts), narrowed to
// TypeScript. The O(n) line cursor is checked against the exact output of the
// O(n^2) `indexToLine` scan it replaced.
const REFERENCE_BOUNDARY =
  /^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+[\w$]+/gm;
const REFERENCE_FUNCTION = /(?:function|class|interface|type|enum)\s+([\w$]+)/;
const REFERENCE_OVERLAP_LINES = 4;

function referenceIndexToLine(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
}

function referenceChunkByLines(
  content: string,
  language: string,
  maxChars: number,
  baseLine = 1,
  functionName?: string,
): CodeChunk[] {
  const lines = content.split("\n");
  const chunks: CodeChunk[] = [];
  let start = 0;
  while (start < lines.length) {
    let end = start;
    let size = 0;
    while (end < lines.length && (size === 0 || size + lines[end]!.length + 1 <= maxChars)) {
      size += lines[end]!.length + 1;
      end++;
    }
    const body = lines.slice(start, end).join("\n").trim();
    if (body) {
      chunks.push({
        content: body,
        metadata: { startLine: baseLine + start, endLine: baseLine + Math.max(start, end - 1), language, functionName },
      });
    }
    if (end >= lines.length) break;
    start = Math.max(end - REFERENCE_OVERLAP_LINES, start + 1);
  }
  return chunks;
}

function referenceChunkCode(content: string, maxChars = 1_000): CodeChunk[] {
  const language = "typescript";
  const matches: Array<{ index: number }> = [];
  const re = new RegExp(REFERENCE_BOUNDARY.source, REFERENCE_BOUNDARY.flags);
  while (true) {
    const match = re.exec(content);
    if (match === null) break;
    matches.push({ index: match.index });
  }
  const chunks: CodeChunk[] = [];
  for (let i = 0; i < matches.length; i++) {
    const startIndex = matches[i]!.index;
    const endIndex = i + 1 < matches.length ? matches[i + 1]!.index : content.length;
    const body = content.slice(startIndex, endIndex).trim();
    if (!body) continue;
    const startLine = referenceIndexToLine(content, startIndex);
    const endLine = referenceIndexToLine(content, Math.max(startIndex, endIndex - 1));
    const match = REFERENCE_FUNCTION.exec(body);
    const functionName = match?.[1];
    if (body.length <= maxChars) {
      chunks.push({ content: body, metadata: { startLine, endLine, language, functionName } });
    } else {
      chunks.push(...referenceChunkByLines(body, language, maxChars, startLine, functionName));
    }
  }
  return chunks;
}

describe("code-index chunker", () => {
  it("detects common source languages from file extension", () => {
    expect(detectLanguage("src/app.tsx")).toBe("typescript");
    expect(detectLanguage("lib/main.py")).toBe("python");
    expect(detectLanguage("README.md")).toBe("markdown");
  });

  it("keeps structural TypeScript chunks with line metadata", () => {
    const chunks = chunkCode(
      [
        "export function first() {",
        "  return 1;",
        "}",
        "",
        "class Second {",
        "  run() {",
        "    return 2;",
        "  }",
        "}",
      ].join("\n"),
      "src/example.ts",
    );

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]?.metadata).toMatchObject({
      startLine: 1,
      language: "typescript",
      functionName: "first",
    });
    expect(chunks[1]?.metadata).toMatchObject({
      startLine: 5,
      language: "typescript",
      functionName: "Second",
    });
  });

  it("falls back to line chunks for unstructured files", () => {
    const chunks = chunkCode(["# Title", "", "Some prose.", "More prose."].join("\n"), "README.md", 20);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.metadata).toMatchObject({ startLine: 1, language: "markdown" });
  });

  describe("preamble retention (I1)", () => {
    it("keeps an import-only prefix as its own chunk with exact line coordinates", () => {
      const content = [
        'import { a } from "./a.js";',
        'import type { B } from "./b.js";',
        "",
        "export function first(): B {",
        "  return a;",
        "}",
      ].join("\n");
      const chunks = chunkCode(content, "src/example.ts");

      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toEqual({
        content: 'import { a } from "./a.js";\nimport type { B } from "./b.js";',
        metadata: { startLine: 1, endLine: 2, language: "typescript" },
      });
      expect(chunks[1]?.metadata).toMatchObject({ startLine: 4, endLine: 6, functionName: "first" });
      expectFullCoverage(content, chunks);
    });

    it("keeps a configuration-only prefix (no declarations) ahead of the first function", () => {
      const content = [
        '"use strict";',
        'require("dotenv").config();',
        "module.exports.timeout = 5_000;",
        "",
        "function main() {",
        "  return module.exports.timeout;",
        "}",
      ].join("\n");
      const chunks = chunkCode(content, "bin/run.js");

      expect(chunks[0]?.content).toBe('"use strict";\nrequire("dotenv").config();\nmodule.exports.timeout = 5_000;');
      expect(chunks[0]?.metadata).toMatchObject({ startLine: 1, endLine: 3, language: "javascript" });
      expect(chunks[0]?.metadata.functionName).toBeUndefined();
      expect(chunks[1]?.metadata).toMatchObject({ startLine: 5, functionName: "main" });
      expectFullCoverage(content, chunks);
    });

    it("covers shebang, comments, docstring and decorators before and between declarations", () => {
      const content = [
        "#!/usr/bin/env python3",
        "# -*- coding: utf-8 -*-",
        '"""Module docstring."""',
        "import os",
        "",
        "@dataclass",
        "class Config:",
        "    path: str = os.getcwd()",
        "",
        "",
        '@app.route("/")',
        "def index():",
        "    return Config()",
      ].join("\n");
      const chunks = chunkCode(content, "app.py");

      expect(chunks.map((chunk) => [chunk.metadata.startLine, chunk.metadata.endLine])).toEqual([
        [1, 6],
        [7, 11],
        [12, 13],
      ]);
      expect(chunks[0]?.content.startsWith("#!/usr/bin/env python3")).toBe(true);
      expect(chunks[0]?.content.endsWith("@dataclass")).toBe(true);
      expect(chunks[1]?.metadata.functionName).toBe("Config");
      expect(chunks[2]?.metadata.functionName).toBe("index");
      expectFullCoverage(content, chunks);
    });

    it("starts the preamble at its first non-blank line", () => {
      const content = ["", "", "// header comment", "", "export const x = 1;"].join("\n");
      const chunks = chunkCode(content, "x.ts");

      expect(chunks[0]).toEqual({
        content: "// header comment",
        metadata: { startLine: 3, endLine: 3, language: "typescript" },
      });
      expect(chunks[1]?.metadata).toMatchObject({ startLine: 5, endLine: 5 });
      expectFullCoverage(content, chunks);
    });

    it("splits an oversize preamble into line chunks that keep their line numbers", () => {
      const imports = Array.from({ length: 30 }, (_, i) => `import { thing${i} } from "./module-${i}.js";`);
      const content = [...imports, "", "export function use() {", "  return thing0;", "}"].join("\n");
      const chunks = chunkCode(content, "many.ts", 200);

      const preamble = chunks.filter((chunk) => chunk.metadata.endLine <= 30);
      expect(preamble.length).toBeGreaterThan(1);
      expect(preamble[0]?.metadata.startLine).toBe(1);
      for (const chunk of preamble) {
        const firstLine = chunk.content.split("\n")[0]!;
        expect(imports[chunk.metadata.startLine - 1]).toBe(firstLine);
      }
      expect(chunks.at(-1)?.metadata).toMatchObject({ startLine: 32, endLine: 34, functionName: "use" });
      expectFullCoverage(content, chunks);
    });

    it("reports no preamble chunk when the file starts with a declaration", () => {
      const chunks = chunkCode("export function only() {}\n", "only.ts");
      expect(chunks).toHaveLength(1);
      expect(chunks[0]?.metadata).toMatchObject({ startLine: 1, functionName: "only" });
    });
  });

  describe("line cursor equivalence (I5)", () => {
    it("matches the pre-fix output on the review fixture of 1,000 one-line declarations", () => {
      const content = Array.from({ length: 1_000 }, (_, i) => `export const value${i} = ${i};`).join("\n");
      const chunks = chunkCode(content, "fixture.ts");

      expect(chunks).toHaveLength(1_000);
      expect(chunks[999]).toEqual({
        content: "export const value999 = 999;",
        metadata: { startLine: 1_000, endLine: 1_000, language: "typescript", functionName: undefined },
      });
      expect(chunks).toEqual(referenceChunkCode(content));
    });

    it("matches the pre-fix output on mixed declarations, blank runs and an oversize body", () => {
      const big = ["export function big() {", ...Array.from({ length: 40 }, (_, i) => `  step(${i});`), "}"];
      const content = [
        "export interface Shape {",
        "  kind: string;",
        "}",
        "",
        "",
        'export type Kind = Shape["kind"];',
        "const fallback = 1;",
        "",
        ...big,
        "",
        "class Second {",
        "  run() {",
        "    return fallback;",
        "  }",
        "}",
        "",
        "export async function last() {}",
        "",
      ].join("\n");
      const maxChars = 120;
      const chunks = chunkCode(content, "mixed.ts", maxChars);

      expect(chunks.length).toBeGreaterThan(6);
      expect(chunks).toEqual(referenceChunkCode(content, maxChars));
      expectFullCoverage(content, chunks);
    });

    it("still reports correct lines for CRLF content", () => {
      const content = "export const a = 1;\r\nexport const b = 2;\r\n";
      expect(chunkCode(content, "crlf.ts").map((chunk) => chunk.metadata.startLine)).toEqual([1, 2]);
    });
  });
});
