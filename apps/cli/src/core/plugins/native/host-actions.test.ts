// Compatibility gate for the native host-actions plugin.
//
// The V1 entry (`builtin/host-actions.ts`) owned 26 slash commands, four of
// which carried aliases the typed-input resolver depends on, three of which
// were gated on the active adapter, and every one of which either dispatched a
// host action or printed a fixed string. This file pins all of it: the manifest
// identity, the full command table (name, aliases, argsHint, description,
// order), the dispatched payload for every branch, the exact user-visible text,
// the slash-menu visibility predicate as it reaches the registry the TUI reads,
// and the fact that disposing the fiber removes the contributions.
//
// It also absorbs the four host-action cases that lived in `loader.test.ts`
// (alias resolution through `services.commands.resolveInput`) and the
// real-storage `/feedback` cases that lived in the Bun-native
// `builtin/host-actions.test.ts`. Vitest aliases `bun:sqlite` onto `node:sqlite`
// (see vitest.config.ts), so the real trace database runs here.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CommandSpec, HostActionPayload, SettingSpec } from "@codesurf/plugin-api";
import { type Context, createCodesurfRoot, type HostBindings, mountPlugin } from "@codesurf/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase } from "../../../storage/db";
import { SessionStore } from "../../../storage/sessions";
import { getTrace, listTraces, recordTrace, setFeedback } from "../../../storage/traces";
import {
  __resetPluginsForTests,
  bootstrapPlugins,
  clearAllSinks,
  disablePlugin,
  enablePlugin,
  getHostServices,
  listPlugins,
  shutdownPlugins,
} from "../loader";
import { getRegistrySnapshot } from "../registry";
import { setAssistantSink, setUiActionSink } from "../sinks";
import { __resetNativeRuntimeForTests, createNativePluginModule } from "./host";
import { hostActionsPlugin, parseFeedbackScore } from "./host-actions";

const ID = "builtin.commands.host-actions";

/** The V1 command table, verbatim, in V1 registration order. */
const EXPECTED_COMMANDS: Array<{
  name: string;
  description: string;
  argsHint?: string;
  aliases?: string[];
}> = [
  { name: "/clear", description: "Start a fresh session (clear transcript)." },
  { name: "/quit", description: "Exit codesurf.", aliases: ["/exit", "/q"] },
  { name: "/model", description: "Open the model picker.", aliases: ["/models"] },
  { name: "/api-key", description: "Enter or replace the built-in Grok/xAI API key.", aliases: ["/apikey"] },
  { name: "/sandbox", description: "Open the sandbox picker." },
  { name: "/remote-control", description: "Open the remote-control modal." },
  {
    name: "/telegram",
    description: "Open Telegram setup. Use /telegram key to replace the bot token.",
    argsHint: "[key|token]",
  },
  { name: "/agents", description: "Open the subagents modal.", aliases: ["/agent"] },
  { name: "/schedule", description: "Open the schedule modal.", aliases: ["/schedules"] },
  // Renamed to /plugins; the V1 names stay as aliases so muscle memory keeps working.
  {
    name: "/plugins",
    description: "Open the plugins modal.",
    aliases: ["/extensions", "/extension"],
  },
  { name: "/sessions", description: "Open the sessions modal.", aliases: ["/session"] },
  { name: "/theme", description: "Open the theme modal.", aliases: ["/themes"] },
  { name: "/flags", description: "Open the feature flags modal.", aliases: ["/feature-flags", "/featureflags"] },
  { name: "/showcase", description: "Open the showcase." },
  { name: "/help", description: "Show available slash commands." },
  { name: "/update", description: "Install the latest available update." },
  { name: "/terms", description: "Open the terminal-session manager." },
  { name: "/term", description: "Run a shell command inline." },
  { name: "/term-modal", description: "Open the terminal popup with a command." },
  { name: "/btw", description: "Ask a side question without interrupting." },
  {
    name: "/feedback",
    description: "Rate the last turn (up/down or 0–1) to improve future routing.",
    argsHint: "[up|down|0-1]",
  },
  { name: "/thinking", description: "Open Claude-agent settings (thinking)." },
  { name: "/effort", description: "Open Claude-agent settings (effort)." },
  {
    name: "/permission",
    description: "Set permission mode. Use ask, yolo, dont-ask, plan, edits, or auto.",
    argsHint: "[ask|yolo|dont-ask|plan|edits|auto]",
    aliases: ["/permissions"],
  },
  { name: "/claude", description: "Open Claude-agent settings.", aliases: ["/claude-agent"] },
  {
    name: "/ui",
    description: "Toggle UI layout. /ui (toggle), /ui oc, /ui cc, /ui opencode, /ui claude-code.",
    argsHint: "[oc|cc|opencode|claude-code]",
  },
];

interface Booted {
  root: Context;
  appended: string[];
  actions: HostActionPayload[];
  dispose: () => Promise<void>;
  command: (name: string) => CommandSpec;
}

async function boot(overrides: Partial<HostBindings> = {}): Promise<Booted> {
  const appended: string[] = [];
  const actions: HostActionPayload[] = [];
  const root = createCodesurfRoot({
    appendAssistant: (text) => appended.push(text),
    ui: {
      action: (payload) => actions.push(payload),
      terminalSize: () => ({ columns: 80, rows: 24 }),
      screens: { list: () => [] },
    },
    ...overrides,
  });
  const fiber = mountPlugin(root, hostActionsPlugin);
  await fiber;
  return {
    root,
    appended,
    actions,
    dispose: async () => {
      await fiber.dispose();
    },
    command: (name) => {
      const found = root.contributions.listCommands().find((entry) => entry.name === name);
      if (!found) throw new Error(`command ${name} not registered`);
      return found;
    },
  };
}

describe("native host-actions — identity", () => {
  it("keeps the V1 manifest, including the protected flag", () => {
    expect(hostActionsPlugin.manifest.id).toBe(ID);
    expect(hostActionsPlugin.manifest.name).toBe("Host Actions");
    expect(hostActionsPlugin.manifest.version).toBe("1.0.0");
    expect(hostActionsPlugin.manifest.description).toBe(
      "Slash commands that open host-owned modals or trigger simple host effects (/model, /agents, /clear, /quit, /ui, etc.).",
    );
    expect(hostActionsPlugin.manifest.enabledByDefault).toBe(true);
    expect(hostActionsPlugin.manifest.protected).toBe(true);
    expect(hostActionsPlugin.manifest.hidden).toBeUndefined();
    expect(hostActionsPlugin.manifest.group).toBeUndefined();
    expect(hostActionsPlugin.manifest.capabilities).toEqual(["commands"]);
  });

  it("registers every V1 command, in order, with the same name/aliases/argsHint/description", async () => {
    const booted = await boot();
    const registered = booted.root.contributions.listCommands();

    expect(
      registered.map((entry) => ({
        name: entry.name,
        description: entry.description,
        ...(entry.argsHint === undefined ? {} : { argsHint: entry.argsHint }),
        ...(entry.aliases === undefined ? {} : { aliases: entry.aliases }),
      })),
    ).toEqual(EXPECTED_COMMANDS);
    expect(registered).toHaveLength(26);

    await booted.dispose();
  });

  it("gates exactly the Claude-agent commands on the active adapter", async () => {
    let adapter = "anthropic.agent-sdk";
    const booted = await boot({ activeAdapterId: () => adapter });
    const gated = booted.root.contributions.listCommands().filter((entry) => entry.visible !== undefined);

    // `/showcase` is hidden outright (a demo; its starter chip is the way in).
    expect(gated.map((entry) => entry.name)).toEqual(["/showcase", "/thinking", "/effort", "/claude"]);
    expect(gated.find((entry) => entry.name === "/showcase")?.visible?.()).toBe(false);
    expect(gated.filter((entry) => entry.name !== "/showcase").every((entry) => entry.visible?.() === true)).toBe(true);

    adapter = "xai.grok";
    expect(gated.every((entry) => entry.visible?.() === false)).toBe(true);

    await booted.dispose();
  });

  it("removes every contribution when the fiber is disposed", async () => {
    const booted = await boot();
    expect(booted.root.contributions.listCommands()).toHaveLength(26);
    await booted.dispose();
    expect(booted.root.contributions.listCommands()).toEqual([]);
  });
});

describe("native host-actions — dispatched payloads", () => {
  // The V1 table from `loader.test.ts`, replayed against the plugin's own
  // handlers so a payload change fails here first.
  const cases: Array<{ command: string; args: string; expected: HostActionPayload }> = [
    { command: "/clear", args: "", expected: { type: "clear" } },
    { command: "/quit", args: "", expected: { type: "quit" } },
    { command: "/model", args: "", expected: { type: "model" } },
    { command: "/api-key", args: "", expected: { type: "api-key" } },
    { command: "/sandbox", args: "", expected: { type: "sandbox" } },
    { command: "/remote-control", args: "", expected: { type: "remote-control" } },
    { command: "/telegram", args: "", expected: { type: "telegram" } },
    { command: "/telegram", args: "key", expected: { type: "telegram", openTokenModal: true } },
    { command: "/telegram", args: "token", expected: { type: "telegram", openTokenModal: true } },
    { command: "/telegram", args: "bot-token", expected: { type: "telegram", openTokenModal: true } },
    { command: "/telegram", args: "botkey", expected: { type: "telegram", openTokenModal: true } },
    { command: "/agents", args: "", expected: { type: "agents" } },
    { command: "/schedule", args: "", expected: { type: "schedule" } },
    { command: "/plugins", args: "", expected: { type: "extensions" } },
    { command: "/sessions", args: "", expected: { type: "sessions" } },
    { command: "/theme", args: "", expected: { type: "theme" } },
    { command: "/flags", args: "", expected: { type: "flags" } },
    { command: "/showcase", args: "", expected: { type: "showcase" } },
    { command: "/update", args: "", expected: { type: "update" } },
    { command: "/terms", args: "", expected: { type: "terms" } },
    { command: "/term", args: "npm test", expected: { type: "term", command: "npm test" } },
    { command: "/term-modal", args: "", expected: { type: "term-modal", command: undefined } },
    { command: "/term-modal", args: "npm test", expected: { type: "term-modal", command: "npm test" } },
    { command: "/btw", args: "check the daemon", expected: { type: "btw", question: "check the daemon" } },
    { command: "/thinking", args: "", expected: { type: "claude-agent", focusGroup: "thinking" } },
    { command: "/effort", args: "", expected: { type: "claude-agent", focusGroup: "effort" } },
    { command: "/permission", args: "", expected: { type: "claude-agent", focusGroup: "permission" } },
    { command: "/claude", args: "", expected: { type: "claude-agent" } },
    { command: "/ui", args: "", expected: { type: "toggle-ui-mode" } },
    { command: "/ui", args: "oc", expected: { type: "set-ui-mode", mode: "opencode" } },
    { command: "/ui", args: "opencode", expected: { type: "set-ui-mode", mode: "opencode" } },
    { command: "/ui", args: "open-code", expected: { type: "set-ui-mode", mode: "opencode" } },
    { command: "/ui", args: "flat", expected: { type: "set-ui-mode", mode: "opencode" } },
    { command: "/ui", args: "cc", expected: { type: "set-ui-mode", mode: "claude-code" } },
    { command: "/ui", args: "claude-code", expected: { type: "set-ui-mode", mode: "claude-code" } },
    { command: "/ui", args: "claudecode", expected: { type: "set-ui-mode", mode: "claude-code" } },
    { command: "/ui", args: "claude", expected: { type: "set-ui-mode", mode: "claude-code" } },
    { command: "/ui", args: "termcast", expected: { type: "set-ui-mode", mode: "claude-code" } },
    { command: "/ui", args: "bordered", expected: { type: "set-ui-mode", mode: "claude-code" } },
  ];

  it("dispatches the V1 payload for every branch", async () => {
    const booted = await boot();
    for (const { command, args, expected } of cases) {
      booted.actions.length = 0;
      await booted.command(command).handler({ args });
      expect(booted.actions, `payload mismatch for ${command} ${args}`).toEqual([expected]);
    }
    expect(booted.appended).toEqual([]);
    await booted.dispose();
  });
});

describe("native host-actions — printed output", () => {
  it("prints the V1 usage text and dispatches nothing on bad input", async () => {
    const booted = await boot();

    await booted.command("/term").handler({ args: "" });
    await booted.command("/btw").handler({ args: "" });
    await booted.command("/telegram").handler({ args: "nope" });
    await booted.command("/ui").handler({ args: "nope" });
    await booted.command("/permission").handler({ args: "nope" });

    expect(booted.appended).toEqual([
      "Usage: /term <command>\nExample: /term npm test",
      "Usage: /btw <question>\nExample: /btw what does useEffect cleanup do?",
      "Usage: /telegram             · open Telegram setup\n" +
        "       /telegram key         · enter or replace Telegram bot token",
      "Usage: /ui                    · toggle between opencode and claude-code\n" +
        "       /ui oc | opencode      · flat layout (default)\n" +
        "       /ui cc | claude-code   · bordered prompt + termcast chrome",
      "Usage: /permissions ask | yolo | dont-ask | plan | edits | auto",
    ]);
    expect(booted.actions).toEqual([]);

    await booted.dispose();
  });

  it("lists the host's commands, de-duplicated and sorted, for /help", async () => {
    const listed: CommandSpec[] = [
      { name: "/zeta", description: "z", handler: () => {} },
      { name: "/alpha", description: "a", handler: () => {} },
      { name: "/alpha", description: "a again", handler: () => {} },
    ];
    const booted = await boot({ listCommands: () => listed });

    await booted.command("/help").handler({ args: "" });
    expect(booted.appended).toEqual(["Available commands:\n/alpha\n/zeta"]);

    await booted.dispose();
  });

  it("says so when the host has no commands at all", async () => {
    const booted = await boot({ listCommands: () => [] });
    await booted.command("/help").handler({ args: "" });
    expect(booted.appended).toEqual(["No commands are currently available."]);
    await booted.dispose();
  });
});

describe("native host-actions — /permission fan-out", () => {
  const FALLBACK_KEYS = [
    "anthropic.agent-sdk.permissionMode",
    "codesurf.daemon.permissionMode",
    "grok.cli.permissionMode",
    "anthropic.agent-sdk-claude-skills.permissionMode",
  ];

  /** A `*.permissionMode` select as an adapter registers one. */
  function permissionSetting(key: string, values: string[]): SettingSpec {
    return {
      key,
      title: key,
      type: "select",
      default: values[0] ?? "default",
      options: values.map((value) => ({ value, label: value })),
    };
  }

  it("writes every adapter's permission mode and the Codex approval bridge", async () => {
    const booted = await boot();

    await booted.command("/permission").handler({ args: "grant" });
    for (const key of FALLBACK_KEYS) expect(booted.root.settings.get(key)).toBe("dontAsk");
    expect(booted.root.settings.get("openai.codex-app-server.approvalPolicy")).toBe("never");
    expect(booted.appended).toEqual(["permission mode -> dont-ask"]);

    await booted.command("/permission").handler({ args: "yolo" });
    for (const key of FALLBACK_KEYS) expect(booted.root.settings.get(key)).toBe("bypassPermissions");
    expect(booted.root.settings.get("openai.codex-app-server.approvalPolicy")).toBe("never");
    expect(booted.appended[1]).toBe("permission mode -> always-approve");

    await booted.dispose();
  });

  it("maps every alias to the V1 mode and label", async () => {
    const booted = await boot();
    const expectations: Array<[string, string, string, string]> = [
      // arg, stored mode, printed label, codex approval policy
      ["ask", "default", "ask", "on-request"],
      ["prompts", "default", "ask", "on-request"],
      ["bypass-permissions", "bypassPermissions", "always-approve", "never"],
      ["always-allow", "bypassPermissions", "always-approve", "never"],
      ["edits", "acceptEdits", "accept edits", "on-request"],
      ["acceptEdits", "acceptEdits", "accept edits", "on-request"],
      ["read-only", "plan", "plan", "untrusted"],
      ["cli", "dontAsk", "dont-ask", "never"],
      ["auto", "auto", "auto", "on-request"],
    ];

    for (const [arg, mode, label, approval] of expectations) {
      booted.appended.length = 0;
      // A trailing word is ignored: only the first token is read.
      await booted.command("/permission").handler({ args: `${arg} extra` });
      expect(booted.root.settings.get("anthropic.agent-sdk.permissionMode"), arg).toBe(mode);
      expect(booted.root.settings.get("openai.codex-app-server.approvalPolicy"), arg).toBe(approval);
      expect(booted.appended, arg).toEqual([`permission mode -> ${label}`]);
    }

    await booted.dispose();
  });

  // The V1 helper (`extensions/permission-mode.ts`) discovered the write set
  // from the settings registry rather than a hard-coded list, so an adapter
  // that registers its own `*.permissionMode` select is covered too.
  it("writes a registered permissionMode select that is not one of the fallback keys", async () => {
    const booted = await boot({
      listSettings: () => [permissionSetting("acme.adapter.permissionMode", ["default", "plan", "bypassPermissions"])],
    });

    await booted.command("/permission").handler({ args: "plan" });
    expect(booted.root.settings.get("acme.adapter.permissionMode")).toBe("plan");
    // The registry did not cover the historical keys, so those are still written.
    for (const key of FALLBACK_KEYS) expect(booted.root.settings.get(key)).toBe("plan");

    await booted.dispose();
  });

  it("skips a registered select whose options reject the value, and does not fall back over it", async () => {
    const booted = await boot({
      // Only knows two of the six modes; `auto` is not one of them.
      listSettings: () => [permissionSetting("grok.cli.permissionMode", ["default", "plan"])],
    });

    await booted.command("/permission").handler({ args: "auto" });
    expect(booted.root.settings.get("grok.cli.permissionMode")).toBeUndefined();
    // Every other historical key still gets the value.
    expect(booted.root.settings.get("anthropic.agent-sdk.permissionMode")).toBe("auto");
    expect(booted.root.settings.get("codesurf.daemon.permissionMode")).toBe("auto");
    expect(booted.appended).toEqual(["permission mode -> auto"]);

    await booted.dispose();
  });

  it("prefers a registered codex approvalPolicy key over the built-in default", async () => {
    const booted = await boot({
      listSettings: () => [
        {
          key: "openai.codex-renamed.approvalPolicy",
          title: "approval",
          type: "select",
          default: "on-request",
          options: [
            { value: "on-request", label: "on-request" },
            { value: "never", label: "never" },
          ],
        },
      ],
    });

    await booted.command("/permission").handler({ args: "yolo" });
    expect(booted.root.settings.get("openai.codex-renamed.approvalPolicy")).toBe("never");
    expect(booted.root.settings.get("openai.codex-app-server.approvalPolicy")).toBeUndefined();

    await booted.dispose();
  });
});

describe("parseFeedbackScore", () => {
  it("maps words, emoji, and numbers to [0,1] or null", () => {
    expect(parseFeedbackScore("up")).toBe(1);
    expect(parseFeedbackScore("good")).toBe(1);
    expect(parseFeedbackScore("👍")).toBe(1);
    expect(parseFeedbackScore("down")).toBe(0);
    expect(parseFeedbackScore("👎")).toBe(0);
    expect(parseFeedbackScore("0.8")).toBe(0.8);
    expect(parseFeedbackScore("5")).toBe(1); // clamped
    expect(parseFeedbackScore("-3")).toBe(0); // clamped
    expect(parseFeedbackScore("")).toBeNull();
    expect(parseFeedbackScore("meh")).toBeNull();
  });
});

describe("native host-actions — /feedback", () => {
  function tracesBindings(traces: Array<{ traceId: string }>): Partial<HostBindings> {
    return {
      listTraces: vi.fn(() => traces as never),
      setTraceFeedback: vi.fn(),
    };
  }

  it("records feedback on the last trace of the session", async () => {
    const traces = tracesBindings([{ traceId: "trace-1" }]);
    const booted = await boot({ sessionId: () => "session-1", ...traces });

    await booted.command("/feedback").handler({ args: "up" });
    expect(traces.listTraces).toHaveBeenCalledWith({ sessionId: "session-1", limit: 1 });
    expect(traces.setTraceFeedback).toHaveBeenCalledWith("trace-1", 1);
    expect(booted.appended).toEqual(["👍 Recorded feedback 1 for the last turn."]);
    expect(booted.actions).toEqual([]);

    await booted.command("/feedback").handler({ args: "0.8" });
    expect(traces.setTraceFeedback).toHaveBeenLastCalledWith("trace-1", 0.8);
    expect(booted.appended[1]).toBe("👍 Recorded feedback 0.8 for the last turn.");

    await booted.command("/feedback").handler({ args: "down" });
    expect(traces.setTraceFeedback).toHaveBeenLastCalledWith("trace-1", 0);
    expect(booted.appended[2]).toBe("👎 Recorded feedback 0 for the last turn.");

    await booted.dispose();
  });

  it("prints usage on unrecognized args and records nothing", async () => {
    const traces = tracesBindings([{ traceId: "trace-1" }]);
    const booted = await boot({ sessionId: () => "session-1", ...traces });

    await booted.command("/feedback").handler({ args: "meh" });
    expect(traces.setTraceFeedback).not.toHaveBeenCalled();
    expect(booted.appended).toEqual(["Usage: /feedback up | down | <0-1>\nExample: /feedback up   ·   /feedback 0.8"]);

    await booted.dispose();
  });

  it("explains when there is no active session", async () => {
    const booted = await boot({ sessionId: () => null, ...tracesBindings([{ traceId: "trace-1" }]) });

    await booted.command("/feedback").handler({ args: "up" });
    expect(booted.appended).toEqual(["No active session yet — send a message first, then rate it."]);

    await booted.dispose();
  });

  it("explains when the session has no completed turn", async () => {
    const booted = await boot({ sessionId: () => "session-1", ...tracesBindings([]) });

    await booted.command("/feedback").handler({ args: "up" });
    expect(booted.appended).toEqual(["No completed turn to rate yet."]);

    await booted.dispose();
  });

  it("reports no rateable turn, rather than throwing, on a host with no trace bindings", async () => {
    const booted = await boot({ sessionId: () => "session-1" });
    await booted.command("/feedback").handler({ args: "up" });
    expect(booted.appended).toEqual(["No completed turn to rate yet."]);
    await booted.dispose();
  });
});

// Ported from the Bun-native `builtin/host-actions.test.ts`: the same
// assertions against the real trace database, reached through the trace
// bindings `native/host.ts` installs (`src/storage`'s `listTraces` /
// `setFeedback`). Vitest resolves `bun:sqlite` to a `node:sqlite` shim, so this
// is the real SQLite path.
describe("native host-actions — /feedback against real storage", () => {
  const tempRoot = path.join(os.tmpdir(), "codesurf-host-actions-feedback");
  const originalCodesurfHome = process.env.CODESURF_HOME;
  let sessionId = "";
  const traceId = "trace-1";

  async function bootWithRealStorage() {
    return boot({
      sessionId: () => sessionId,
      listTraces: (filter) => listTraces(filter ?? {}),
      setTraceFeedback: (id, score) => setFeedback(id, score),
    });
  }

  beforeEach(() => {
    fs.mkdirSync(tempRoot, { recursive: true });
    process.env.CODESURF_HOME = fs.mkdtempSync(path.join(tempRoot, "home-"));
    const cwd = fs.mkdtempSync(path.join(tempRoot, "cwd-"));
    closeDatabase();
    sessionId = new SessionStore(cwd).createSession("m", "agent", cwd).id;
    recordTrace({ traceId, sessionId, query: "do a thing", model: "m", outcome: "success" });
  });

  afterEach(() => {
    closeDatabase();
    if (originalCodesurfHome === undefined) delete process.env.CODESURF_HOME;
    else process.env.CODESURF_HOME = originalCodesurfHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("records feedback on the last trace of the session", async () => {
    const booted = await bootWithRealStorage();
    await booted.command("/feedback").handler({ args: "up" });
    expect(getTrace(traceId)?.feedback).toBe(1);
    expect(booted.appended).toEqual(["👍 Recorded feedback 1 for the last turn."]);
    await booted.dispose();
  });

  it("accepts a numeric score", async () => {
    const booted = await bootWithRealStorage();
    await booted.command("/feedback").handler({ args: "0.8" });
    expect(getTrace(traceId)?.feedback).toBeCloseTo(0.8, 5);
    await booted.dispose();
  });

  it("prints usage on unrecognized args and records nothing", async () => {
    const booted = await bootWithRealStorage();
    await booted.command("/feedback").handler({ args: "meh" });
    expect(getTrace(traceId)?.feedback).toBeNull();
    expect(booted.appended[0]?.startsWith("Usage:")).toBe(true);
    await booted.dispose();
  });

  it("explains when there is no active session", async () => {
    sessionId = "";
    const booted = await bootWithRealStorage();
    await booted.command("/feedback").handler({ args: "up" });
    expect(booted.appended).toEqual(["No active session yet — send a message first, then rate it."]);
    expect(getTrace(traceId)?.feedback).toBeNull();
    await booted.dispose();
  });
});

describe("native host-actions — through the host loader", () => {
  const originalConfigDir = process.env.CODESURF_CONFIG_DIR;
  let configDir = "";

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-host-actions-"));
    process.env.CODESURF_CONFIG_DIR = configDir;
    __resetPluginsForTests();
    __resetNativeRuntimeForTests();
  });

  afterEach(async () => {
    await shutdownPlugins();
    clearAllSinks();
    __resetPluginsForTests();
    __resetNativeRuntimeForTests();
    if (originalConfigDir === undefined) delete process.env.CODESURF_CONFIG_DIR;
    else process.env.CODESURF_CONFIG_DIR = originalConfigDir;
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  function registryNames(): string[] {
    return getRegistrySnapshot()
      .commands.filter((entry) => entry.pluginId === ID)
      .map((entry) => entry.name);
  }

  it("registers into the registry the TUI reads, listed as protected", async () => {
    await bootstrapPlugins([createNativePluginModule(hostActionsPlugin)]);

    expect(registryNames().sort()).toEqual(EXPECTED_COMMANDS.map((entry) => entry.name).sort());

    const listed = listPlugins().find((entry) => entry.id === ID);
    expect(listed?.title).toBe("Host Actions");
    expect(listed?.source).toBe("builtin");
    expect(listed?.protected).toBe(true);
    expect(listed?.enabled).toBe(true);
    expect(listed?.active).toBe(true);
    expect(listed?.commands).toBe(26);
  });

  it("refuses to disable, because the manifest is protected", async () => {
    await bootstrapPlugins([createNativePluginModule(hostActionsPlugin)]);
    expect(registryNames()).toHaveLength(26);

    // `disablePlugin` is a no-op for a protected manifest, exactly as it was
    // for the V1 entry — the commands stay in the registry.
    await disablePlugin(ID);
    expect(registryNames()).toHaveLength(26);
    expect(listPlugins().find((entry) => entry.id === ID)?.active).toBe(true);

    // Enabling an already-enabled protected plugin is idempotent, not a second
    // mount that would double-register every command.
    await enablePlugin(ID);
    expect(registryNames()).toHaveLength(26);
  });

  it("shutdown disposes the fiber and removes every command", async () => {
    await bootstrapPlugins([createNativePluginModule(hostActionsPlugin)]);
    expect(registryNames()).toHaveLength(26);

    await shutdownPlugins();
    expect(registryNames()).toEqual([]);
    expect(listPlugins().find((entry) => entry.id === ID)?.active).toBe(false);
  });

  // The V1 registry entry carried a `visible` predicate that `use-slash-items`
  // consults (`.filter((c) => !c.visible || c.visible(kernelServices))`), so
  // `/thinking`, `/effort` and `/claude` only appear in the slash menu and the
  // command palette while the Claude Agent SDK adapter is active.
  it("forwards the slash-menu visibility predicate into the registry the TUI reads", async () => {
    await bootstrapPlugins([createNativePluginModule(hostActionsPlugin)]);
    const commands = getRegistrySnapshot().commands.filter((entry) => entry.pluginId === ID);

    const gated = commands.filter((entry) => typeof entry.visible === "function").map((entry) => entry.name);
    expect(gated.sort()).toEqual(["/claude", "/effort", "/showcase", "/thinking"]);
    // `/permission` is deliberately ungated — it applies to every adapter.
    expect(commands.find((entry) => entry.name === "/permission")?.visible).toBeUndefined();
  });

  // Ported from `loader.test.ts`: typed input, resolved through the registry's
  // alias table, must reach the same handler and dispatch the same payload.
  it("resolves every V1 name and alias from typed input to the right payload", async () => {
    const dispatched: HostActionPayload[] = [];
    setUiActionSink((action) => {
      dispatched.push(action as HostActionPayload);
    });

    await bootstrapPlugins([createNativePluginModule(hostActionsPlugin)]);
    const services = getHostServices();

    const cases: Array<{ input: string; expected: HostActionPayload }> = [
      { input: "/clear", expected: { type: "clear" } },
      { input: "/model", expected: { type: "model" } },
      { input: "/models", expected: { type: "model" } },
      { input: "/api-key", expected: { type: "api-key" } },
      { input: "/apikey", expected: { type: "api-key" } },
      { input: "/sandbox", expected: { type: "sandbox" } },
      // /wallet now owned by builtin.tools.payments; not bootstrapped here.
      { input: "/remote-control", expected: { type: "remote-control" } },
      // /mcp + /mcps now owned by builtin.mcp; not bootstrapped here.
      { input: "/agents", expected: { type: "agents" } },
      { input: "/agent", expected: { type: "agents" } },
      { input: "/schedule", expected: { type: "schedule" } },
      { input: "/schedules", expected: { type: "schedule" } },
      { input: "/plugins", expected: { type: "extensions" } },
      // The V1 names must keep resolving; this is the compatibility claim.
      { input: "/extensions", expected: { type: "extensions" } },
      { input: "/extension", expected: { type: "extensions" } },
      { input: "/sessions", expected: { type: "sessions" } },
      { input: "/session", expected: { type: "sessions" } },
      { input: "/theme", expected: { type: "theme" } },
      { input: "/themes", expected: { type: "theme" } },
      { input: "/flags", expected: { type: "flags" } },
      { input: "/feature-flags", expected: { type: "flags" } },
      { input: "/featureflags", expected: { type: "flags" } },
      { input: "/showcase", expected: { type: "showcase" } },
      { input: "/term npm test", expected: { type: "term", command: "npm test" } },
      { input: "/term-modal", expected: { type: "term-modal" } },
      { input: "/term-modal npm test", expected: { type: "term-modal", command: "npm test" } },
      { input: "/btw check the daemon", expected: { type: "btw", question: "check the daemon" } },
      { input: "/update", expected: { type: "update" } },
      { input: "/terms", expected: { type: "terms" } },
      { input: "/thinking", expected: { type: "claude-agent", focusGroup: "thinking" } },
      { input: "/effort", expected: { type: "claude-agent", focusGroup: "effort" } },
      { input: "/permission", expected: { type: "claude-agent", focusGroup: "permission" } },
      { input: "/permissions", expected: { type: "claude-agent", focusGroup: "permission" } },
      { input: "/claude", expected: { type: "claude-agent" } },
      { input: "/claude-agent", expected: { type: "claude-agent" } },
      { input: "/quit", expected: { type: "quit" } },
      { input: "/exit", expected: { type: "quit" } },
      { input: "/q", expected: { type: "quit" } },
      { input: "/telegram", expected: { type: "telegram" } },
      { input: "/ui", expected: { type: "toggle-ui-mode" } },
      { input: "/ui opencode", expected: { type: "set-ui-mode", mode: "opencode" } },
      { input: "/ui claude-code", expected: { type: "set-ui-mode", mode: "claude-code" } },
    ];

    for (const { input, expected } of cases) {
      dispatched.length = 0;
      const resolution = services.commands.resolveInput(input);
      expect(resolution, `expected ${input} to resolve`).not.toBeNull();
      await Promise.resolve(resolution?.command.handler({ args: resolution.args, services }));
      expect(dispatched, `payload mismatch for ${input}`).toEqual([expected]);
    }
  });

  it("/permissions grant sets the shared permission mode settings", async () => {
    const assistantMessages: string[] = [];
    setAssistantSink((content) => {
      assistantMessages.push(content);
    });

    await bootstrapPlugins([createNativePluginModule(hostActionsPlugin)]);
    const services = getHostServices();
    const resolution = services.commands.resolveInput("/permissions grant");

    expect(resolution).not.toBeNull();
    await Promise.resolve(resolution?.command.handler({ args: resolution.args, services }));

    expect(services.settings.get("anthropic.agent-sdk.permissionMode")).toBe("dontAsk");
    expect(services.settings.get("codesurf.daemon.permissionMode")).toBe("dontAsk");
    // Fallback fan-out also covers adapters that register later / aren't
    // bootstrapped in this focused host-actions test.
    expect(services.settings.get("grok.cli.permissionMode")).toBe("dontAsk");
    expect(services.settings.get("anthropic.agent-sdk-claude-skills.permissionMode")).toBe("dontAsk");
    expect(assistantMessages).toEqual(["permission mode -> dont-ask"]);
  });

  it("/permissions yolo writes bypassPermissions across adapters", async () => {
    const assistantMessages: string[] = [];
    setAssistantSink((content) => {
      assistantMessages.push(content);
    });

    await bootstrapPlugins([createNativePluginModule(hostActionsPlugin)]);
    const services = getHostServices();
    const resolution = services.commands.resolveInput("/permissions yolo");

    expect(resolution).not.toBeNull();
    await Promise.resolve(resolution?.command.handler({ args: resolution.args, services }));

    expect(services.settings.get("anthropic.agent-sdk.permissionMode")).toBe("bypassPermissions");
    expect(services.settings.get("codesurf.daemon.permissionMode")).toBe("bypassPermissions");
    expect(services.settings.get("grok.cli.permissionMode")).toBe("bypassPermissions");
    expect(assistantMessages).toEqual(["permission mode -> always-approve"]);
  });

  it("/term and /btw validate required arguments, and /help lists the live registry", async () => {
    const assistantMessages: string[] = [];
    setAssistantSink((content) => {
      assistantMessages.push(content);
    });

    await bootstrapPlugins([createNativePluginModule(hostActionsPlugin)]);
    const services = getHostServices();

    for (const input of ["/term", "/btw", "/help"]) {
      const resolution = services.commands.resolveInput(input);
      expect(resolution, `expected ${input} to resolve`).not.toBeNull();
      await Promise.resolve(resolution?.command.handler({ args: resolution.args, services }));
    }

    expect(assistantMessages).toHaveLength(3);
    expect(assistantMessages[0]).toBe("Usage: /term <command>\nExample: /term npm test");
    expect(assistantMessages[1]).toBe("Usage: /btw <question>\nExample: /btw what does useEffect cleanup do?");
    expect(assistantMessages[2]).toContain("Available commands:");
    expect(assistantMessages[2]).toContain("/help");
  });

  it("ships exactly one host-actions entry in the built-in catalog, protected and native", async () => {
    const { loadBuiltinPlugins } = await import("../builtin/index");
    const modules = await loadBuiltinPlugins();
    const entries = modules.filter((module) => module.manifest.id === ID);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.manifest.kind).toBe("builtin");
    expect(entries[0]?.manifest.protected).toBe(true);
    // Native plugin modules are the only host-actions entry with a `deactivate`
    // (the V1 `PluginModule` had none), so this pins the catalog swap.
    expect(typeof entries[0]?.deactivate).toBe("function");
  });
});
