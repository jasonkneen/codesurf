/**
 * CodeSurf Tile State Manager
 *
 * Manages persistent state for Claude Code sessions running inside CodeSurf tiles.
 * This ensures that session context and peer state are continuously written to disk
 * and can be recovered when a new Claude Code process starts.
 *
 * State is stored in `.contex/tile-<CARD_ID>/` directories in JSON format.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMode } from "../types/index";

export interface TileState {
  /** CodeSurf tile ID (cardId) */
  cardId: string;
  /** Claude model being used */
  model: string;
  /** Agent mode (default, plan, etc.) */
  mode: AgentMode;
  /** Current working directory when session started */
  cwdAtStart: string;
  /** Current working directory (updated as you navigate) */
  cwdLast: string;
  /** Task being worked on (description or objective) */
  task: string | null;
  /** Peer status: idle, working, done */
  peerStatus: "idle" | "working" | "done";
  /** List of files currently being edited/viewed */
  files: string[];
  /** Conversation ID in the daemon */
  daemonSessionId: string | null;
  /** When the session was created */
  createdAt: string;
  /** Last time state was written */
  updatedAt: string;
}

export class TileStateStore {
  /** Resolution of .contex directory (typically ~/.contex) */
  private readonly contexHome: string;

  constructor(contexHome: string = path.join(process.env.HOME || "~", ".contex")) {
    this.contexHome = contexHome;
  }

  /**
   * Resolve the tile directory for a given cardId
   */
  private getTileDir(cardId: string): string {
    return path.join(this.contexHome, `tile-${cardId}`);
  }

  /**
   * Resolve the state file path for a tile
   */
  private getStateFile(cardId: string): string {
    return path.join(this.getTileDir(cardId), "state.json");
  }

  /**
   * Load tile state from disk, returning null if tile doesn't exist
   */
  loadState(cardId: string): TileState | null {
    const statePath = this.getStateFile(cardId);
    if (!fs.existsSync(statePath)) {
      return null;
    }

    try {
      const raw = fs.readFileSync(statePath, "utf8");
      return JSON.parse(raw) as TileState;
    } catch (err) {
      console.error(`[tile-state] Failed to load state for tile ${cardId}:`, err);
      return null;
    }
  }

  /**
   * Save tile state to disk. Creates the tile directory if it doesn't exist.
   */
  saveState(cardId: string, state: TileState): void {
    const tileDir = this.getTileDir(cardId);
    const statePath = this.getStateFile(cardId);

    try {
      // Ensure the tile directory exists
      if (!fs.existsSync(tileDir)) {
        fs.mkdirSync(tileDir, { recursive: true });
      }

      // Update timestamp before writing
      state.updatedAt = new Date().toISOString();

      // Write state file (atomic write with temp file)
      const tempPath = `${statePath}.tmp`;
      fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      fs.renameSync(tempPath, statePath);
    } catch (err) {
      console.error(`[tile-state] Failed to save state for tile ${cardId}:`, err);
    }
  }

  /**
   * Update specific fields of tile state (merge with existing)
   */
  updateState(cardId: string, updates: Partial<TileState>): TileState {
    const existing = this.loadState(cardId);
    const now = new Date().toISOString();
    const state: TileState = existing
      ? { ...existing }
      : {
          cardId,
          model: updates.model || "claude-opus-4-6",
          mode: updates.mode ?? "agent",
          cwdAtStart: updates.cwdAtStart || process.cwd(),
          cwdLast: updates.cwdLast || process.cwd(),
          task: updates.task || null,
          peerStatus: updates.peerStatus || "idle",
          files: updates.files || [],
          daemonSessionId: updates.daemonSessionId || null,
          createdAt: now,
          updatedAt: now,
        };

    // Merge only supplied keys. An `undefined` value means "not supplied":
    // copying it would erase the persisted value and JSON serialization would
    // then drop the field entirely.
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) (state as unknown as Record<string, unknown>)[key] = value;
    }
    this.saveState(cardId, state);

    return state;
  }

  /**
   * Update peer status (called when peer_set_state is executed)
   */
  setPeerStatus(cardId: string, status: TileState["peerStatus"], task?: string | null, files?: string[]): void {
    // Omitted task/files leave the stored values untouched; pass `null` / `[]`
    // (or "") explicitly to clear them.
    const updates: Partial<TileState> = { peerStatus: status };
    if (task !== undefined) updates.task = task;
    if (files !== undefined) updates.files = files;
    this.updateState(cardId, updates);
  }

  /**
   * Set the daemon session ID (recovered from daemon)
   */
  setDaemonSessionId(cardId: string, sessionId: string): void {
    this.updateState(cardId, { daemonSessionId: sessionId });
  }

  /**
   * Find the most recently updated tile in the contex directory
   */
  findLatestTile(): { cardId: string; state: TileState } | null {
    if (!fs.existsSync(this.contexHome)) {
      return null;
    }

    const entries = fs.readdirSync(this.contexHome);
    const tiles: Array<{ cardId: string; state: TileState; time: number }> = [];

    for (const entry of entries) {
      if (!entry.startsWith("tile-")) continue;
      const cardId = entry.slice("tile-".length);
      const state = this.loadState(cardId);
      if (state) {
        const time = new Date(state.updatedAt).getTime();
        tiles.push({ cardId, state, time });
      }
    }

    if (tiles.length === 0) return null;
    tiles.sort((a, b) => b.time - a.time);
    const latest = tiles[0];
    return { cardId: latest.cardId, state: latest.state };
  }

  /**
   * List all tiles with their states
   */
  listTiles(limit = 10): Array<{ cardId: string; state: TileState }> {
    if (!fs.existsSync(this.contexHome)) {
      return [];
    }

    const entries = fs.readdirSync(this.contexHome);
    const tiles: Array<{ cardId: string; state: TileState; time: number }> = [];

    for (const entry of entries) {
      if (!entry.startsWith("tile-")) continue;
      const cardId = entry.slice("tile-".length);
      const state = this.loadState(cardId);
      if (state) {
        const time = new Date(state.updatedAt).getTime();
        tiles.push({ cardId, state, time });
      }
    }

    tiles.sort((a, b) => b.time - a.time);
    return tiles.slice(0, limit).map(({ cardId, state }) => ({ cardId, state }));
  }

  /**
   * Recover CARD_ID from the most recent tile
   */
  getLastCardId(): string | null {
    const latest = this.findLatestTile();
    return latest?.cardId ?? null;
  }

  /**
   * Update last working directory for a tile
   */
  updateCwd(cardId: string, cwd: string): void {
    this.updateState(cardId, { cwdLast: cwd });
  }

  /**
   * Delete a tile (and its state)
   */
  deleteTile(cardId: string): void {
    const tileDir = this.getTileDir(cardId);
    try {
      if (fs.existsSync(tileDir)) {
        fs.rmSync(tileDir, { recursive: true, force: true });
      }
    } catch (err) {
      console.error(`[tile-state] Failed to delete tile ${cardId}:`, err);
    }
  }
}

/**
 * Global singleton instance
 */
let globalStore: TileStateStore | null = null;

export function getTileStateStore(): TileStateStore {
  if (!globalStore) {
    globalStore = new TileStateStore();
  }
  return globalStore;
}
