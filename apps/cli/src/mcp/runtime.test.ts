import { describe, expect, it } from "vitest";
import { toPromptSummary, toResourceSummary } from "./runtime";

describe("toResourceSummary", () => {
  it("maps a fully populated resource", () => {
    expect(
      toResourceSummary({
        uri: "file:///tmp/x.txt",
        name: "x",
        description: "an example",
        mimeType: "text/plain",
      }),
    ).toEqual({
      uri: "file:///tmp/x.txt",
      name: "x",
      description: "an example",
      mimeType: "text/plain",
    });
  });

  it("returns null when uri or name is missing", () => {
    expect(toResourceSummary({ uri: "file:///x" })).toBeNull();
    expect(toResourceSummary({ name: "x" })).toBeNull();
    expect(toResourceSummary({})).toBeNull();
  });

  it("ignores non-string description and mimeType", () => {
    expect(
      toResourceSummary({
        uri: "u",
        name: "n",
        description: 42 as unknown,
        mimeType: { x: 1 } as unknown,
      }),
    ).toEqual({
      uri: "u",
      name: "n",
      description: undefined,
      mimeType: undefined,
    });
  });
});

describe("toPromptSummary", () => {
  it("maps a prompt with arguments", () => {
    expect(
      toPromptSummary({
        name: "summarize",
        description: "summarize text",
        arguments: [
          { name: "text", description: "input", required: true },
          { name: "max_words", required: false },
        ],
      }),
    ).toEqual({
      name: "summarize",
      description: "summarize text",
      arguments: [
        { name: "text", description: "input", required: true },
        { name: "max_words", description: undefined, required: false },
      ],
    });
  });

  it("returns null when name is missing", () => {
    expect(toPromptSummary({})).toBeNull();
    expect(toPromptSummary({ description: "no name" })).toBeNull();
  });

  it("drops arguments without a string name", () => {
    expect(
      toPromptSummary({
        name: "p",
        arguments: [{ name: "good" }, { description: "bad — no name" }, { name: 42 as unknown }],
      }),
    ).toEqual({
      name: "p",
      description: undefined,
      arguments: [{ name: "good", description: undefined, required: undefined }],
    });
  });

  it("omits arguments when the field is absent", () => {
    expect(toPromptSummary({ name: "no-args" })).toEqual({
      name: "no-args",
      description: undefined,
      arguments: undefined,
    });
  });
});
