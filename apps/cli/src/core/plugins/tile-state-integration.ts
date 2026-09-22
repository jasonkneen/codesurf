/**
 * CodeSurf Tile State Integration
 *
 * Hooks the CodeSurf desktop provider to automatically persist tile state:
 * - Saves peer state after each turn
 * - Loads previous state on session start
 * - Updates tile metadata (task, files, model, mode)
 *
 * CANDIDATE DEAD CODE (do NOT delete the live callers above without checking):
 *   TileSessionContext  — live: codesurf-desktop-provider.ts:33,542
 *   getTileSessionContext — live: codesurf-desktop-provider.ts:33,542
 *   wrapSendTurnWithPersistence — no live call sites found; candidate for removal
 *   loadPreviousTileSession — no live call sites found; candidate for removal
 *   promptToResumePreviousSession — no live call sites found; candidate for removal
 *   exportCardIdForNextSession — no live call sites found; candidate for removal
 */

import { getTileStateStore, type TileState } from "../../storage/index";
import type { ProviderStreamController, ProviderTurnInput } from "./api";

/**
 * Tracks tile state for a session
 */
export class TileSessionContext {
  readonly cardId: string;
  readonly tileStore = getTileStateStore();
  tileState: TileState;
  turnCount = 0;

  constructor(cardId: string, initialState?: TileState) {
    this.cardId = cardId;
    this.tileState = initialState || this.tileStore.loadState(cardId) || this.createDefaultState();
  }

  private createDefaultState(): TileState {
    return {
      cardId: this.cardId,
      model: "claude-opus-4-6",
      mode: "agent",
      cwdAtStart: process.cwd(),
      cwdLast: process.cwd(),
      task: null,
      peerStatus: "idle",
      files: [],
      daemonSessionId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Update model after turn (call after turn completes)
   */
  updateModel(model: string): void {
    this.tileState.model = model;
    this.persist();
  }

  /**
   * Update mode after turn
   */
  updateMode(mode: string): void {
    if (mode === "agent" || mode === "plan" || mode === "ask") {
      this.tileState.mode = mode;
      this.persist();
    }
  }

  /**
   * Update current task/objective
   */
  updateTask(task: string | null): void {
    this.tileState.task = task;
    this.persist();
  }

  /**
   * Update list of files being worked on
   */
  updateFiles(files: string[]): void {
    this.tileState.files = files;
    this.persist();
  }

  /**
   * Update peer status
   */
  updatePeerStatus(status: TileState["peerStatus"], task?: string, files?: string[]): void {
    this.tileState.peerStatus = status;
    if (task !== undefined) this.tileState.task = task;
    if (files !== undefined) this.tileState.files = files;
    this.persist();
  }

  /**
   * Update daemon session ID (persistent conversation continuity)
   */
  setDaemonSessionId(sessionId: string): void {
    this.tileState.daemonSessionId = sessionId;
    this.persist();
  }

  /**
   * Update current working directory
   */
  updateCwd(cwd: string): void {
    this.tileState.cwdLast = cwd;
    this.persist();
  }

  /**
   * Persist current state to disk
   */
  persist(): void {
    this.tileStore.saveState(this.cardId, this.tileState);
  }

  /**
   * Record turn completion
   */
  recordTurn(input: ProviderTurnInput): void {
    this.turnCount++;
    // Update task if prompt is available
    if (input.prompt && this.turnCount <= 1) {
      // Only set task from first turn
      this.updateTask(input.prompt.slice(0, 200));
    }
    // Update model from input
    if (input.modelId) {
      this.updateModel(input.modelId);
    }
  }
}

/**
 * Get or create a tile session context for a cardId
 */
export function getTileSessionContext(cardId: string): TileSessionContext {
  // In a real implementation, this would be stored in a map keyed by cardId
  // For now, we create it on demand
  return new TileSessionContext(cardId);
}

/**
 * Wrap the original sendTurn to add state persistence
 *
 * Usage:
 *   const wrappedSendTurn = wrapSendTurnWithPersistence(
 *     session.sendTurn,
 *     cardId
 *   );
 */
export function wrapSendTurnWithPersistence(
  originalSendTurn: (input: ProviderTurnInput, controller: ProviderStreamController) => Promise<{ usage?: unknown }>,
  cardId: string,
): (input: ProviderTurnInput, controller: ProviderStreamController) => Promise<{ usage?: unknown }> {
  const context = getTileSessionContext(cardId);

  return async (input: ProviderTurnInput, controller: ProviderStreamController) => {
    // Record the turn
    context.recordTurn(input);

    // Wrap the controller to intercept events and persist state.
    //
    // Note: there is no "session" event in ProviderStreamEvent. The owning
    // provider (codesurf-desktop-provider) wires `setDaemonSessionId`
    // directly when it learns its sessionId from the daemon, so this
    // wrapper just forwards events untouched.
    const wrappedController: ProviderStreamController = {
      emit: (event) => {
        controller.emit(event);
      },
    };

    try {
      // Execute the original turn
      const result = await originalSendTurn(input, wrappedController);

      // Persist state after successful turn
      context.updatePeerStatus("idle");

      return result;
    } catch (err) {
      // Record error state but still persist
      console.error("[tile-state] Turn failed:", err);
      throw err;
    }
  };
}

/**
 * Load previous tile session if available
 *
 * Usage:
 *   const previousSession = loadPreviousTileSession();
 *   if (previousSession) {
 *     console.log("Resuming session in tile:", previousSession.cardId);
 *   }
 */
export function loadPreviousTileSession(): { cardId: string; state: TileState } | null {
  const tileStore = getTileStateStore();
  return tileStore.findLatestTile();
}

/**
 * Prompt to resume a previous session if available
 *
 * Returns the cardId if user wants to resume, null otherwise
 */
export async function promptToResumePreviousSession(): Promise<string | null> {
  const tileStore = getTileStateStore();
  const latest = tileStore.findLatestTile();

  if (!latest) {
    return null;
  }

  // In a CLI context, we'd show an interactive prompt here
  // For now, we just log and return null (user can manually specify)
  const ago = Date.now() - new Date(latest.state.updatedAt).getTime();
  const seconds = Math.floor(ago / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  let timeStr = `${seconds}s ago`;
  if (hours > 0) {
    timeStr = `${hours}h ago`;
  } else if (minutes > 0) {
    timeStr = `${minutes}m ago`;
  }

  console.error(`\n[tile-state] Found previous session: tile-${latest.cardId} (updated ${timeStr})`);
  console.error(`[tile-state] Task: ${latest.state.task || "(none)"}`);
  console.error(`[tile-state] To resume this session, set CARD_ID="${latest.cardId}"\n`);

  return null;
}

/**
 * Export the CARD_ID for recovery in next session
 *
 * This would be called before the process exits
 */
export function exportCardIdForNextSession(cardId: string): void {
  try {
    // Note: In a real implementation, this would write to a file or env var
    // that the next session can read. For now, the tile state itself serves
    // as the persistent storage.
    const tileStore = getTileStateStore();
    const state = tileStore.loadState(cardId);
    if (state) {
      console.error(`[tile-state] Session state saved to tile-${cardId}`);
    }
  } catch (err) {
    console.error("[tile-state] Failed to export CARD_ID:", err);
  }
}
