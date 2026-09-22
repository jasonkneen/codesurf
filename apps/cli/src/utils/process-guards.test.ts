import { describe, expect, it, vi } from "vitest";
import { CRASH_LOG_SIZE_LIMIT, handleUnhandledRejection, shouldRotateCrashLog } from "./process-guards";

describe("shouldRotateCrashLog", () => {
  it("does not rotate when the file is under the limit", () => {
    expect(shouldRotateCrashLog(CRASH_LOG_SIZE_LIMIT - 1)).toBe(false);
  });

  it("does not rotate when the file is exactly at the limit", () => {
    expect(shouldRotateCrashLog(CRASH_LOG_SIZE_LIMIT)).toBe(false);
  });

  it("rotates once the file exceeds the limit", () => {
    expect(shouldRotateCrashLog(CRASH_LOG_SIZE_LIMIT + 1)).toBe(true);
  });

  it("respects a custom limit", () => {
    expect(shouldRotateCrashLog(100, 50)).toBe(true);
    expect(shouldRotateCrashLog(50, 50)).toBe(false);
  });
});

describe("handleUnhandledRejection", () => {
  it("does not log or exit when the interactive UI is active", () => {
    const exit = vi.fn();
    const log = vi.fn();

    handleUnhandledRejection("boom", { interactive: true, exit, log });

    expect(log).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("logs and exits with code 1 when not interactive", () => {
    const exit = vi.fn();
    const log = vi.fn();

    handleUnhandledRejection("boom", { interactive: false, exit, log });

    expect(log).toHaveBeenCalledWith("Unhandled rejection:", "boom");
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("installWarningGuard", () => {
  // Node prints warnings from a listener it installs itself, straight to
  // stderr — behind OpenTUI, which owns the frame. The bytes land on rows the
  // renderer thinks it already drew, so the display tears. Adding a listener
  // does not suppress that default; only replacing it does.
  it("replaces Node's default warning listener rather than joining it", async () => {
    const { installWarningGuard } = await import("./process-guards");
    const defaults = process.listeners("warning").filter((listener) => listener.name === "onWarning");
    expect(defaults.length).toBeGreaterThan(0);
    const others = process.listeners("warning").filter((listener) => listener.name !== "onWarning");

    installWarningGuard();
    installWarningGuard();

    const after = process.listeners("warning");
    expect(after.some((listener) => listener.name === "onWarning")).toBe(false);
    // Exactly one guard, however many times it is installed.
    expect(after.length).toBe(others.length + 1);
    process.removeAllListeners("warning");
  });

  it("leaves warning listeners it does not own in place (L6)", async () => {
    const { installWarningGuard } = await import("./process-guards");
    const thirdParty = vi.fn();
    process.on("warning", thirdParty);
    try {
      installWarningGuard();
      expect(process.listeners("warning")).toContain(thirdParty);
    } finally {
      process.removeAllListeners("warning");
    }
  });

  it("keeps warnings off the screen while the TUI owns it, and prints otherwise", async () => {
    const { installWarningGuard, setInteractiveUiActive } = await import("./process-guards");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    installWarningGuard();

    try {
      setInteractiveUiActive(true);
      process.emitWarning("would tear the frame", { code: "TEST_TUI_ACTIVE" });
      await new Promise((resolve) => setImmediate(resolve));
      expect(errorSpy).not.toHaveBeenCalled();

      setInteractiveUiActive(false);
      process.emitWarning("safe to print", { code: "TEST_NO_TUI" });
      await new Promise((resolve) => setImmediate(resolve));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("safe to print"));
    } finally {
      setInteractiveUiActive(false);
      errorSpy.mockRestore();
      process.removeAllListeners("warning");
    }
  });
});
