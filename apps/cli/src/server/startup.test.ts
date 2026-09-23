import { describe, expect, it } from "vitest";
import { decideStartup, formatServerPrompt, isYes, type RunningServer, type StartupInputs } from "./startup";

const known: RunningServer = { url: "ws://127.0.0.1:3948", name: "default", known: true };
const unknown: RunningServer = { url: "ws://127.0.0.1:3948", known: false };

const base: StartupInputs = { interactive: true, serverless: false, autoStart: true, running: null };

describe("decideStartup", () => {
  it.each<[string, Partial<StartupInputs>, ReturnType<typeof decideStartup>]>([
    ["no server + autoStart on -> start", {}, { action: "start" }],
    ["no server + autoStart off -> serverless", { autoStart: false }, { action: "serverless" }],
    ["known server running -> attach", { running: known }, { action: "attach", server: known }],
    ["unknown server running -> prompt", { running: unknown }, { action: "prompt", server: unknown }],
    [
      "unknown server + autoStart off -> still prompt",
      { running: unknown, autoStart: false },
      { action: "prompt", server: unknown },
    ],
    ["--serverless -> serverless", { serverless: true, running: known }, { action: "serverless" }],
    ["--serverless with no server -> serverless", { serverless: true }, { action: "serverless" }],
    ["non-TTY -> serverless", { interactive: false }, { action: "serverless" }],
    ["non-TTY with a known server -> serverless", { interactive: false, running: known }, { action: "serverless" }],
    ["--connect wins", { connect: "ws://h:1", running: unknown }, { action: "connect", url: "ws://h:1" }],
    [
      "--connect non-interactive -> connect",
      { connect: "ws://h:1", interactive: false },
      { action: "connect", url: "ws://h:1" },
    ],
  ])("%s", (_label, overrides, expected) => {
    expect(decideStartup({ ...base, ...overrides })).toEqual(expected);
  });
});

describe("startup prompt", () => {
  it("names the url and server", () => {
    expect(formatServerPrompt(known)).toContain("A CodeSurf server is running at ws://127.0.0.1:3948 (default).");
    expect(formatServerPrompt(unknown)).toContain("running at ws://127.0.0.1:3948.");
  });

  it("only an explicit yes connects", () => {
    expect(isYes("y")).toBe(true);
    expect(isYes(" Yes\n")).toBe(true);
    expect(isYes("")).toBe(false);
    expect(isYes("n")).toBe(false);
    expect(isYes("yep")).toBe(false);
  });
});

describe("server settings", () => {
  it("remembers known servers without dropping autoStart", async () => {
    const settings = await import("../utils/settings");
    settings.saveUserSettings({ server: { autoStart: false } });
    expect(settings.isServerAutoStartEnabled()).toBe(false);
    expect(settings.isKnownServer("ws://127.0.0.1:3950")).toBe(false);

    settings.rememberKnownServer("ws://127.0.0.1:3950", "second");
    settings.rememberKnownServer("ws://127.0.0.1:3948");
    expect(settings.isKnownServer("ws://127.0.0.1:3950")).toBe(true);
    expect(settings.isKnownServer("ws://127.0.0.1:3948")).toBe(true);
    expect(settings.isServerAutoStartEnabled()).toBe(false);
    expect(settings.loadUserSettings().server?.known?.["ws://127.0.0.1:3950"]?.name).toBe("second");

    settings.saveUserSettings({ server: { autoStart: true } });
    expect(settings.isServerAutoStartEnabled()).toBe(true);
    expect(settings.isKnownServer("ws://127.0.0.1:3950")).toBe(true);
  });
});
