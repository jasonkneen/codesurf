import { describe, expect, it } from "vitest";
import type { RegisteredSetting } from "./api";
import {
  applyPermissionMode,
  findPermissionModeSetting,
  isPermissionModeSetting,
  listPermissionModeSettings,
  permissionModeKeyForAdapter,
  readPermissionModeForAdapter,
  readPermissionModeSnapshot,
} from "./permission-mode";

function makeSetting(partial: Partial<RegisteredSetting> & Pick<RegisteredSetting, "key">): RegisteredSetting {
  return {
    pluginId: "test",
    title: partial.key,
    type: "select",
    default: "default",
    options: [
      { value: "default", label: "Default" },
      { value: "bypassPermissions", label: "Bypass" },
      { value: "dontAsk", label: "Don't ask" },
      { value: "plan", label: "Plan" },
      { value: "acceptEdits", label: "Accept edits" },
      { value: "auto", label: "Auto" },
    ],
    ...partial,
  };
}

function makeSettings(initial: RegisteredSetting[] = [], values: Record<string, unknown> = {}) {
  const store = { ...values };
  const list = [...initial];
  return {
    get: <T = unknown>(key: string, fallback?: T) => (key in store ? (store[key] as T) : fallback) as T | undefined,
    set: <T = unknown>(key: string, value: T) => {
      store[key] = value;
    },
    list: () => list,
    store,
    listRef: list,
  };
}

describe("permission-mode helpers", () => {
  it("identifies *.permissionMode select settings only", () => {
    expect(isPermissionModeSetting(makeSetting({ key: "anthropic.agent-sdk.permissionMode" }))).toBe(true);
    expect(isPermissionModeSetting(makeSetting({ key: "codex.approvalPolicy", type: "select" }))).toBe(false);
    expect(isPermissionModeSetting(makeSetting({ key: "anthropic.agent-sdk.permissionMode", type: "string" }))).toBe(
      false,
    );
  });

  it("lists every registered permission-mode setting", () => {
    const settings = makeSettings([
      makeSetting({ key: "anthropic.agent-sdk.permissionMode" }),
      makeSetting({ key: "grok.cli.permissionMode" }),
      makeSetting({ key: "codex.approvalPolicy" }),
      makeSetting({ key: "other.flag", type: "boolean", default: false, options: undefined }),
    ]);
    expect(listPermissionModeSettings(settings).map((s) => s.key)).toEqual([
      "anthropic.agent-sdk.permissionMode",
      "grok.cli.permissionMode",
    ]);
  });

  it("applies a mode to every registered permission-mode setting", () => {
    const settings = makeSettings([
      makeSetting({ key: "anthropic.agent-sdk.permissionMode" }),
      makeSetting({ key: "codesurf.daemon.permissionMode" }),
      makeSetting({ key: "grok.cli.permissionMode" }),
      makeSetting({ key: "anthropic.agent-sdk-claude-skills.permissionMode" }),
    ]);
    const written = applyPermissionMode(settings, "bypassPermissions");
    expect(written).toEqual(
      expect.arrayContaining([
        "anthropic.agent-sdk.permissionMode",
        "anthropic.agent-sdk-claude-skills.permissionMode",
        "codesurf.daemon.permissionMode",
        "grok.cli.permissionMode",
        // Codex bridge always fans out even when its setting isn't registered.
        "openai.codex-app-server.approvalPolicy",
      ]),
    );
    expect(settings.store["grok.cli.permissionMode"]).toBe("bypassPermissions");
    expect(settings.store["anthropic.agent-sdk.permissionMode"]).toBe("bypassPermissions");
    expect(settings.store["openai.codex-app-server.approvalPolicy"]).toBe("never");
  });

  it("skips settings whose options do not include the mode", () => {
    const settings = makeSettings([
      makeSetting({
        key: "narrow.permissionMode",
        options: [{ value: "default", label: "Default" }],
      }),
      makeSetting({ key: "wide.permissionMode" }),
    ]);
    const written = applyPermissionMode(settings, "bypassPermissions");
    expect(written).toContain("wide.permissionMode");
    expect(written).not.toContain("narrow.permissionMode");
  });

  it("falls back to historical keys when the registry is empty", () => {
    const settings = makeSettings([]);
    const written = applyPermissionMode(settings, "dontAsk");
    expect(written).toEqual(
      expect.arrayContaining([
        "anthropic.agent-sdk.permissionMode",
        "codesurf.daemon.permissionMode",
        "grok.cli.permissionMode",
        "anthropic.agent-sdk-claude-skills.permissionMode",
      ]),
    );
    expect(settings.store["codesurf.daemon.permissionMode"]).toBe("dontAsk");
  });

  it("reads the live value for an adapter", () => {
    const settings = makeSettings([makeSetting({ key: "grok.cli.permissionMode", default: "default" })], {
      "grok.cli.permissionMode": "plan",
    });
    expect(permissionModeKeyForAdapter("grok.cli")).toBe("grok.cli.permissionMode");
    expect(findPermissionModeSetting(settings, "grok.cli")?.key).toBe("grok.cli.permissionMode");
    expect(readPermissionModeForAdapter(settings, "grok.cli")).toBe("plan");
    expect(readPermissionModeForAdapter(settings, "xai.api")).toBeNull();
  });

  it("builds a snapshot map of every registered permission mode", () => {
    const settings = makeSettings(
      [makeSetting({ key: "anthropic.agent-sdk.permissionMode" }), makeSetting({ key: "grok.cli.permissionMode" })],
      {
        "anthropic.agent-sdk.permissionMode": "acceptEdits",
        "grok.cli.permissionMode": "auto",
      },
    );
    const snap = readPermissionModeSnapshot(settings);
    expect(snap["anthropic.agent-sdk.permissionMode"]).toBe("acceptEdits");
    expect(snap["grok.cli.permissionMode"]).toBe("auto");
  });

  it("bridges Claude-style modes onto a registered Codex approvalPolicy setting", () => {
    const settings = makeSettings([
      makeSetting({ key: "anthropic.agent-sdk.permissionMode" }),
      makeSetting({
        key: "openai.codex-app-server.approvalPolicy",
        options: [
          { value: "untrusted", label: "Untrusted" },
          { value: "on-request", label: "On request" },
          { value: "never", label: "Never" },
          { value: "on-failure", label: "On failure" },
        ],
      }),
    ]);
    applyPermissionMode(settings, "plan");
    expect(settings.store["openai.codex-app-server.approvalPolicy"]).toBe("untrusted");
    applyPermissionMode(settings, "default");
    expect(settings.store["openai.codex-app-server.approvalPolicy"]).toBe("on-request");
  });
});
