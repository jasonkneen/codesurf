import { describe, expect, it } from "vitest";
import type { ServerCandidate } from "./scope";
import {
  decideStartup,
  formatChoosePrompt,
  formatServerPrompt,
  isYes,
  parseChoice,
  type StartupInputs,
} from "./startup";

const cwd = "/work/app";
const known: ServerCandidate = { url: "ws://127.0.0.1:3948", name: "default", scope: "user", known: true };
const unknown: ServerCandidate = { url: "ws://127.0.0.1:3948", scope: "user", known: false };
const otherProject: ServerCandidate = {
  url: "ws://127.0.0.1:3950",
  name: "other",
  scope: "project",
  project: "/work/other",
  known: true,
};

const base: StartupInputs = { interactive: true, serverless: false, autoStart: true, candidates: [], cwd };

describe("decideStartup", () => {
  it.each<[string, Partial<StartupInputs>, ReturnType<typeof decideStartup>]>([
    ["no server + autoStart on -> start", {}, { action: "start" }],
    ["no server + autoStart off -> serverless", { autoStart: false }, { action: "serverless" }],
    ["known server running -> attach", { candidates: [known] }, { action: "attach", server: known }],
    ["unknown server running -> prompt", { candidates: [unknown] }, { action: "prompt", server: unknown }],
    [
      "unknown server + autoStart off -> still prompt",
      { candidates: [unknown], autoStart: false },
      { action: "prompt", server: unknown },
    ],
    ["only another project's server -> start the default", { candidates: [otherProject] }, { action: "start" }],
    [
      "only another project's server + autoStart off -> serverless",
      { candidates: [otherProject], autoStart: false },
      { action: "serverless" },
    ],
    ["--serverless -> serverless", { serverless: true, candidates: [known] }, { action: "serverless" }],
    ["--serverless with no server -> serverless", { serverless: true }, { action: "serverless" }],
    ["non-TTY -> serverless", { interactive: false }, { action: "serverless" }],
    [
      "non-TTY with a known server -> serverless",
      { interactive: false, candidates: [known] },
      { action: "serverless" },
    ],
    ["--connect wins", { connect: "ws://h:1", candidates: [unknown] }, { action: "connect", url: "ws://h:1" }],
    [
      "--connect non-interactive -> connect",
      { connect: "ws://h:1", interactive: false },
      { action: "connect", url: "ws://h:1" },
    ],
  ])("%s", (_label, overrides, expected) => {
    expect(decideStartup({ ...base, ...overrides })).toEqual(expected);
  });

  it("several unknown servers -> choose", () => {
    const second = { ...unknown, url: "ws://127.0.0.1:3949" };
    expect(decideStartup({ ...base, candidates: [unknown, second] })).toMatchObject({ action: "choose" });
  });
});

describe("startup prompt", () => {
  it("names the url, server and scope", () => {
    expect(formatServerPrompt(known)).toContain("A CodeSurf server is running at ws://127.0.0.1:3948 (default), user.");
    expect(formatServerPrompt(unknown)).toContain("running at ws://127.0.0.1:3948, user.");
    expect(formatServerPrompt({ ...otherProject, project: cwd })).toContain("project: /work/app");
  });

  it("lists choices with a serverless default", () => {
    const text = formatChoosePrompt([known, { ...unknown, url: "ws://127.0.0.1:3949" }]);
    expect(text).toContain("[1] ws://127.0.0.1:3948 (default), user");
    expect(text).toContain("[2] ws://127.0.0.1:3949, user — new");
    expect(text).toContain("[0] serverless (run locally)");
  });

  it("parses choices", () => {
    expect(parseChoice("1", 2)).toBe(0);
    expect(parseChoice(" 2\n", 2)).toBe(1);
    expect(parseChoice("", 2)).toBeNull();
    expect(parseChoice("0", 2)).toBeNull();
    expect(parseChoice("3", 2)).toBeNull();
  });

  it("only an explicit yes connects", () => {
    expect(isYes("y")).toBe(true);
    expect(isYes(" Yes\n")).toBe(true);
    expect(isYes("")).toBe(false);
    expect(isYes("n")).toBe(false);
    expect(isYes("yep")).toBe(false);
  });
});

function isKnown(settings: typeof import("../utils/settings"), url: string): boolean {
  return Boolean(settings.loadUserSettings().server?.known?.[url]);
}

describe("server settings", () => {
  it("remembers known servers without dropping autoStart", async () => {
    const settings = await import("../utils/settings");
    settings.saveUserSettings({ server: { autoStart: false } });
    expect(settings.isServerAutoStartEnabled()).toBe(false);
    expect(isKnown(settings, "ws://127.0.0.1:3950")).toBe(false);

    settings.rememberKnownServer("ws://127.0.0.1:3950", "second");
    settings.rememberKnownServer("ws://127.0.0.1:3948");
    expect(isKnown(settings, "ws://127.0.0.1:3950")).toBe(true);
    expect(isKnown(settings, "ws://127.0.0.1:3948")).toBe(true);
    expect(settings.isServerAutoStartEnabled()).toBe(false);
    expect(settings.loadUserSettings().server?.known?.["ws://127.0.0.1:3950"]?.name).toBe("second");

    settings.saveUserSettings({ server: { autoStart: true } });
    expect(settings.isServerAutoStartEnabled()).toBe(true);
    expect(isKnown(settings, "ws://127.0.0.1:3950")).toBe(true);
  });
});
