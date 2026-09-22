import { describe, expect, it } from "vitest";
import type { McpPromptResult, McpPromptSummary } from "../../../mcp/runtime";
import { buildPromptArguments, parseMcpPromptInput, renderPromptDispatch } from "./mcp-prompt-commands";

describe("parseMcpPromptInput", () => {
  it("parses /<server>__<name> with no rest", () => {
    expect(parseMcpPromptInput("/fixture__greet")).toEqual({
      serverId: "fixture",
      promptName: "greet",
      rest: "",
    });
  });

  it("parses /<server>__<name> with positional rest", () => {
    expect(parseMcpPromptInput("/fixture__greet alice")).toEqual({
      serverId: "fixture",
      promptName: "greet",
      rest: "alice",
    });
  });

  it("preserves multi-word rest verbatim", () => {
    expect(parseMcpPromptInput("/fixture__greet  hello world  ")).toEqual({
      serverId: "fixture",
      promptName: "greet",
      rest: "hello world",
    });
  });

  it("supports server ids and prompt names with dashes", () => {
    expect(parseMcpPromptInput("/test-server__do-it now")).toEqual({
      serverId: "test-server",
      promptName: "do-it",
      rest: "now",
    });
  });

  it("rejects non-slash input", () => {
    expect(parseMcpPromptInput("fixture__greet")).toBeNull();
    expect(parseMcpPromptInput("")).toBeNull();
  });

  it("rejects shapes without the __ separator", () => {
    expect(parseMcpPromptInput("/foo")).toBeNull();
    expect(parseMcpPromptInput("/foo bar")).toBeNull();
  });

  it("rejects shapes with empty halves around __", () => {
    expect(parseMcpPromptInput("/__greet")).toBeNull();
    expect(parseMcpPromptInput("/fixture__")).toBeNull();
    expect(parseMcpPromptInput("/__")).toBeNull();
  });
});

describe("buildPromptArguments", () => {
  const oneArgPrompt: McpPromptSummary["arguments"] = [{ name: "name", required: true }];

  it("returns undefined when rest is empty", () => {
    expect(buildPromptArguments("", oneArgPrompt)).toBeUndefined();
  });

  it("returns undefined when no args declared and rest is non-empty", () => {
    expect(buildPromptArguments("anything", undefined)).toBeUndefined();
  });

  it("uses a JSON object verbatim", () => {
    expect(buildPromptArguments('{"name":"alice","topic":"cats"}', oneArgPrompt)).toEqual({
      name: "alice",
      topic: "cats",
    });
  });

  it("falls through to positional when JSON is not an object", () => {
    expect(buildPromptArguments('"alice"', oneArgPrompt)).toEqual({ name: '"alice"' });
    expect(buildPromptArguments("[1,2,3]", oneArgPrompt)).toEqual({ name: "[1,2,3]" });
  });

  it("attaches rest to the first declared arg by name", () => {
    expect(buildPromptArguments("alice", oneArgPrompt)).toEqual({ name: "alice" });
  });

  it("preserves multi-word rest as a single value on the first arg", () => {
    expect(buildPromptArguments("hello world", oneArgPrompt)).toEqual({ name: "hello world" });
  });
});

describe("renderPromptDispatch", () => {
  it("returns the text directly for a single user message", () => {
    const result: McpPromptResult = {
      messages: [{ role: "user", text: "Hello, alice!" }],
    };
    expect(renderPromptDispatch(result)).toBe("Hello, alice!");
  });

  it("role-prefixes when there are multiple messages", () => {
    const result: McpPromptResult = {
      messages: [
        { role: "user", text: "first" },
        { role: "assistant", text: "second" },
      ],
    };
    expect(renderPromptDispatch(result)).toBe("[user]\nfirst\n\n[assistant]\nsecond");
  });

  it("returns empty string when there are no messages", () => {
    expect(renderPromptDispatch({ messages: [] })).toBe("");
  });

  it("role-prefixes a single assistant message", () => {
    const result: McpPromptResult = {
      messages: [{ role: "assistant", text: "only assistant" }],
    };
    expect(renderPromptDispatch(result)).toBe("[assistant]\nonly assistant");
  });
});
