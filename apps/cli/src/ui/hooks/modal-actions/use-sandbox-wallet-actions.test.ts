import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../../../agent/agent";

// Render-free harness (see use-plan-actions.test.ts): useCallback is identity.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useCallback: <T>(fn: T) => fn };
});

const h = vi.hoisted(() => ({
  calls: [] as string[],
  projectError: null as Error | null,
  userError: null as Error | null,
  setMessages: vi.fn(),
}));

vi.mock("../../../utils/settings", () => ({
  loadPaymentSettings: vi.fn(),
  savePaymentSettings: vi.fn(),
  saveRecapsEnabled: vi.fn(),
  saveUserSettings: vi.fn(() => {
    h.calls.push("user");
    if (h.userError) throw h.userError;
  }),
  saveProjectSettings: vi.fn(() => {
    h.calls.push("project");
    if (h.projectError) throw h.projectError;
  }),
}));
vi.mock("../../context/modal-context.js", () => ({ useModalVisibility: () => ({}) }));
vi.mock("../../context/model-context.js", () => ({
  useModel: () => ({ setSandboxModeState: vi.fn(), setSandboxSettingsState: vi.fn() }),
}));
vi.mock("../../context/conversation-state-context.js", () => ({
  useConversationState: () => ({ setSessionRecap: vi.fn(), setMessages: h.setMessages }),
}));
vi.mock("../../context/telegram-context.js", () => ({
  useTelegram: () => ({ telegramAgentsRef: { current: new Map() } }),
}));

import { useSandboxWalletActions } from "./use-sandbox-wallet-actions";

const agent = { setSandboxMode: vi.fn(), setSandboxSettings: vi.fn() } as unknown as Agent;

beforeEach(() => {
  h.calls.length = 0;
  h.projectError = null;
  h.userError = null;
  h.setMessages.mockReset();
});

describe("useSandboxWalletActions settings writes", () => {
  it("saves user settings before project settings", () => {
    const { applySandboxMode, applySandboxSettings } = useSandboxWalletActions({ agent });
    applySandboxMode("shuru");
    applySandboxSettings({});
    expect(h.calls).toEqual(["user", "project", "user", "project"]);
    expect(h.setMessages).not.toHaveBeenCalled();
  });

  it("keeps the user's choice and surfaces the error when the project file is malformed", () => {
    h.projectError = new Error("Unexpected token in .grok/settings.json");
    const { applySandboxMode } = useSandboxWalletActions({ agent });

    expect(() => applySandboxMode("shuru")).not.toThrow();
    expect(h.calls).toEqual(["user", "project"]);
    expect(h.setMessages).toHaveBeenCalledTimes(1);
    const update = h.setMessages.mock.calls[0]![0] as (prev: unknown[]) => Array<{ content: string }>;
    expect(update([])[0]!.content).toContain("Unexpected token");
  });

  it("does not throw when the user settings file is malformed; still writes project and reports", () => {
    h.userError = new Error("bad user settings json");
    const { applySandboxSettings } = useSandboxWalletActions({ agent });

    expect(() => applySandboxSettings({})).not.toThrow();
    expect(h.calls).toEqual(["user", "project"]);
    const update = h.setMessages.mock.calls[0]![0] as (prev: unknown[]) => Array<{ content: string }>;
    expect(update([])[0]!.content).toContain("user settings could not be saved: bad user settings json");
  });
});
