import { describe, expect, it } from "vitest";
import { isTelegramConflictError } from "./bridge";

describe("isTelegramConflictError", () => {
  it("returns true for a GrammyError-like object with error_code 409", () => {
    expect(isTelegramConflictError({ error_code: 409, description: "Conflict" })).toBe(true);
  });

  it("returns true for an Error whose message contains the 409 conflict text", () => {
    expect(isTelegramConflictError(new Error("409: Conflict: terminated by other getUpdates request"))).toBe(true);
  });

  it("returns true for an Error whose message contains 'terminated by other getUpdates'", () => {
    expect(
      isTelegramConflictError(
        new Error("terminated by other getUpdates request; make sure that only one bot instance is running"),
      ),
    ).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isTelegramConflictError(new Error("Network timeout"))).toBe(false);
    expect(isTelegramConflictError({ error_code: 400, description: "Bad Request" })).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isTelegramConflictError("some random string")).toBe(false);
    expect(isTelegramConflictError(undefined)).toBe(false);
    expect(isTelegramConflictError(null)).toBe(false);
    expect(isTelegramConflictError(42)).toBe(false);
  });
});
