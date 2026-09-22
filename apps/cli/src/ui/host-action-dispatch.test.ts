// Unit tests for dispatchHostAction — pure function, no React rendering needed.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostActionCapabilities } from "./host-action-dispatch";
import { dispatchHostAction } from "./host-action-dispatch";
import { createEmptyMcpEditorDraft } from "./mcp-modal-types";
import { SANDBOX_SCREEN_ID } from "./screens/sandbox-screen";
import { WALLET_SCREEN_ID } from "./screens/wallet-screen";

function makeCaps(): HostActionCapabilities {
  return {
    openModelPicker: vi.fn(),
    openApiKeyModal: vi.fn(),
    openSandboxPicker: vi.fn(),
    openWalletPicker: vi.fn(),
    openConnectModal: vi.fn(),
    openTelegramSetup: vi.fn(),
    openMcpModal: vi.fn(),
    openMcpEditor: vi.fn(),
    openAgentsModal: vi.fn(),
    openScheduleModal: vi.fn(),
    openExtensionsModal: vi.fn(),
    openSessionsModal: vi.fn(),
    openThemeModal: vi.fn(),
    openFlagsModal: vi.fn(),
    openShowcase: vi.fn(),
    runUpdate: vi.fn(),
    openTerminalManager: vi.fn(),
    spawnInlineTerminal: vi.fn(),
    spawnTerminalSession: vi.fn().mockReturnValue("session-123"),
    openClaudeAgentModal: vi.fn(),
    startBtw: vi.fn(),
    resetToNewSession: vi.fn(),
    requestQuitConfirm: vi.fn(),
    setUiMode: vi.fn(),
    toggleUiMode: vi.fn(),
    openScreen: vi.fn(),
    closeWalletPicker: vi.fn(),
    closeSandboxPicker: vi.fn(),
    closeScreen: vi.fn(),
  };
}

describe("dispatchHostAction", () => {
  let caps: HostActionCapabilities;

  beforeEach(() => {
    caps = makeCaps();
  });

  it("api-key → openApiKeyModal", () => {
    dispatchHostAction({ type: "api-key" }, caps);
    expect(caps.openApiKeyModal).toHaveBeenCalledOnce();
  });

  it("telegram → openTelegramSetup", () => {
    dispatchHostAction({ type: "telegram" }, caps);
    expect(caps.openTelegramSetup).toHaveBeenCalledWith(undefined);
    expect(caps.openConnectModal).not.toHaveBeenCalled();
  });

  it("telegram openTokenModal → openTelegramSetup(true)", () => {
    dispatchHostAction({ type: "telegram", openTokenModal: true }, caps);
    expect(caps.openTelegramSetup).toHaveBeenCalledWith(true);
  });

  it("mcp without openEditor → openMcpModal", () => {
    dispatchHostAction({ type: "mcp" }, caps);
    expect(caps.openMcpModal).toHaveBeenCalledOnce();
    expect(caps.openMcpEditor).not.toHaveBeenCalled();
  });

  it("mcp with openEditor and editingId → openMcpEditor with args", () => {
    const draft = { ...createEmptyMcpEditorDraft(), transport: "sse" as const, label: "my-server" };
    dispatchHostAction({ type: "mcp", openEditor: draft, editingId: "server-42" }, caps);
    expect(caps.openMcpEditor).toHaveBeenCalledWith(draft, "server-42");
    expect(caps.openMcpModal).not.toHaveBeenCalled();
  });

  it("term-modal with command → spawnTerminalSession then openTerminalManager with sessionId", () => {
    dispatchHostAction({ type: "term-modal", command: "bun run dev" }, caps);
    expect(caps.spawnTerminalSession).toHaveBeenCalledWith("bun run dev");
    expect(caps.openTerminalManager).toHaveBeenCalledWith("session-123");
  });

  it("term-modal without command → openTerminalManager with no args", () => {
    dispatchHostAction({ type: "term-modal" }, caps);
    expect(caps.spawnTerminalSession).not.toHaveBeenCalled();
    expect(caps.openTerminalManager).toHaveBeenCalledWith();
  });

  it("open-screen with WALLET_SCREEN_ID → openWalletPicker", () => {
    dispatchHostAction({ type: "open-screen", id: WALLET_SCREEN_ID }, caps);
    expect(caps.openWalletPicker).toHaveBeenCalledOnce();
    expect(caps.openScreen).not.toHaveBeenCalled();
  });

  it("open-screen with arbitrary id → openScreen", () => {
    dispatchHostAction({ type: "open-screen", id: "my-custom-screen", props: { x: 1 } }, caps);
    expect(caps.openScreen).toHaveBeenCalledWith("my-custom-screen", { x: 1 });
    expect(caps.openWalletPicker).not.toHaveBeenCalled();
  });

  it("quit → requestQuitConfirm", () => {
    dispatchHostAction({ type: "quit" }, caps);
    expect(caps.requestQuitConfirm).toHaveBeenCalledOnce();
  });

  it("btw → startBtw with question", () => {
    dispatchHostAction({ type: "btw", question: "What is 2+2?" }, caps);
    expect(caps.startBtw).toHaveBeenCalledWith("What is 2+2?");
  });

  it("close-screen with SANDBOX_SCREEN_ID → closeSandboxPicker + closeScreen", () => {
    dispatchHostAction({ type: "close-screen", id: SANDBOX_SCREEN_ID }, caps);
    expect(caps.closeSandboxPicker).toHaveBeenCalledOnce();
    expect(caps.closeScreen).toHaveBeenCalledWith(SANDBOX_SCREEN_ID);
  });
});
