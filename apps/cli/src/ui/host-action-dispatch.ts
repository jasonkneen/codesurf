// Host-action dispatcher (moved verbatim out of app.tsx).
//
// `dispatchHostAction` is a pure function that routes a HostAction to the
// appropriate capability. All React state mutations are injected via the
// `HostActionCapabilities` interface so this module is unit-testable without
// rendering the full app.
//
// app.tsx's `handleUiAction` becomes a thin useCallback that builds caps and
// calls dispatchHostAction — the dep array stays identical to today's.

import type { HostAction } from "../core/plugins";
import type { UiMode } from "../utils/settings";
import type { McpEditorDraft } from "./mcp-modal-types";
import { SANDBOX_SCREEN_ID } from "./screens/sandbox-screen";
import { WALLET_SCREEN_ID } from "./screens/wallet-screen";

export interface HostActionCapabilities {
  openModelPicker(): void;
  openApiKeyModal(): void;
  openSandboxPicker(): void;
  openWalletPicker(): void;
  openConnectModal(): void;
  openTelegramSetup(openTokenModal?: boolean): void;
  openMcpModal(): void;
  openMcpEditor(draft: McpEditorDraft, editingId: string | null): void;
  openAgentsModal(): void;
  openScheduleModal(): void;
  openExtensionsModal(): void;
  openSessionsModal(): void;
  openThemeModal(): void;
  openFlagsModal(): void;
  openShowcase(): void;
  runUpdate(): void;
  openTerminalManager(sessionId?: string): void;
  spawnInlineTerminal(command: string): void;
  spawnTerminalSession(command: string): string;
  openClaudeAgentModal(focusGroup?: string): void;
  /** Encapsulates the btw async closure incl. btwAbortRef race-guard logic. */
  startBtw(question: string): void;
  resetToNewSession(): void;
  requestQuitConfirm(): void;
  setUiMode(mode: UiMode): void;
  toggleUiMode(): void;
  openScreen(id: string, props: unknown): void;
  closeWalletPicker(): void;
  closeSandboxPicker(): void;
  closeScreen(id: string): void;
}

export function dispatchHostAction(action: HostAction, caps: HostActionCapabilities): void {
  switch (action.type) {
    case "model":
      caps.openModelPicker();
      break;
    case "api-key":
      caps.openApiKeyModal();
      break;
    case "sandbox":
      caps.openSandboxPicker();
      break;
    case "wallet":
      caps.openWalletPicker();
      break;
    case "remote-control":
      caps.openConnectModal();
      break;
    case "telegram":
      caps.openTelegramSetup(action.openTokenModal);
      break;
    case "mcp":
      if (action.openEditor) {
        caps.openMcpEditor(action.openEditor, action.editingId ?? null);
      } else {
        caps.openMcpModal();
      }
      break;
    case "agents":
      caps.openAgentsModal();
      break;
    case "schedule":
      caps.openScheduleModal();
      break;
    case "extensions":
      caps.openExtensionsModal();
      break;
    case "sessions":
      caps.openSessionsModal();
      break;
    case "theme":
      caps.openThemeModal();
      break;
    case "flags":
      caps.openFlagsModal();
      break;
    case "showcase":
      caps.openShowcase();
      break;
    case "update":
      caps.runUpdate();
      break;
    case "terms":
      caps.openTerminalManager();
      break;
    case "term":
      caps.spawnInlineTerminal(action.command);
      break;
    case "term-modal":
      if (action.command) {
        const sessionId = caps.spawnTerminalSession(action.command);
        caps.openTerminalManager(sessionId);
        break;
      }
      caps.openTerminalManager();
      break;
    case "claude-agent":
      caps.openClaudeAgentModal(action.focusGroup);
      break;
    case "btw":
      // Block-scoped so `sideQuestionAbort` cannot leak into sibling cases
      // (avoids no-case-declarations and a same-name redeclaration trap).
      // The btwAbortRef race-guard logic lives inside the injected startBtw
      // capability implemented in app.tsx — keeps this dispatcher pure.
      caps.startBtw(action.question);
      break;
    case "clear":
      caps.resetToNewSession();
      break;
    case "quit":
      caps.requestQuitConfirm();
      break;
    case "set-ui-mode":
      caps.setUiMode(action.mode);
      break;
    case "toggle-ui-mode":
      caps.toggleUiMode();
      break;
    case "open-screen":
      // Mirror the Phase 0 wallet path so closed-union extensions and
      // legacy host helpers don't fight over open/close. For ids whose
      // open/close + keyboard handling still live in the host (wallet,
      // sandbox), drive the legacy mirror state; for any other id stash
      // the props in `dynamicScreens` and let the screen-slot mount it.
      if (action.id === WALLET_SCREEN_ID) {
        caps.openWalletPicker();
      } else if (action.id === SANDBOX_SCREEN_ID) {
        caps.openSandboxPicker();
      } else {
        caps.openScreen(action.id, action.props);
      }
      break;
    case "close-screen":
      // Drive the legacy mirror for ids whose keyboard handling lives in
      // the host (wallet, sandbox) so input handlers stop intercepting;
      // for any other id just drop its dynamic-screens entry. Both
      // branches are safe to run for a missing id (the setter no-ops).
      if (action.id === WALLET_SCREEN_ID) {
        caps.closeWalletPicker();
      } else if (action.id === SANDBOX_SCREEN_ID) {
        caps.closeSandboxPicker();
      }
      caps.closeScreen(action.id);
      break;
    default: {
      // Exhaustiveness check — TypeScript will error if a HostAction
      // variant is added without a corresponding case.
      const _exhaustive: never = action;
      void _exhaustive;
    }
  }
}
