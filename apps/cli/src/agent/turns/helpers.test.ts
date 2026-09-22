import { APICallError } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { appendRawDetail, humanizeApiError } from "./helpers";

function apiError(statusCode: number, message: string, responseBody = ""): APICallError {
  return new APICallError({
    message,
    url: "https://api.example.com/v1/messages",
    requestBodyValues: {},
    statusCode,
    responseBody,
  });
}

describe("appendRawDetail", () => {
  it("adds the provider's words when they say something new", () => {
    expect(appendRawDetail("The request was invalid.", "unknown model: sonnet-5")).toBe(
      "The request was invalid. (unknown model: sonnet-5)",
    );
  });

  it("does not repeat a detail the status line already contains", () => {
    expect(appendRawDetail("Rate limit exceeded. Please wait a moment.", "rate limit exceeded")).toBe(
      "Rate limit exceeded. Please wait a moment.",
    );
  });

  it("returns the status alone when there is no detail", () => {
    expect(appendRawDetail("The request timed out.", "   ")).toBe("The request timed out.");
  });
});

describe("humanizeApiError", () => {
  it("keeps the raw provider message alongside a generic 400", () => {
    expect(humanizeApiError(apiError(400, "unknown model: claude-sonnet-5"))).toBe(
      "The request was invalid. This may be caused by an unsupported parameter or model. (unknown model: claude-sonnet-5)",
    );
  });

  it("prefers a structured message from the response body", () => {
    const body = JSON.stringify({ error: { message: "model not found: gpt-9" } });
    expect(humanizeApiError(apiError(404, "Not Found", body))).toBe("model not found: gpt-9");
  });

  it("strips the AI SDK error prefix from a plain error", () => {
    expect(humanizeApiError(new Error("AI_APICallError: socket hang up"))).toBe("socket hang up");
  });
});
