/**
 * CARD_ID Management
 *
 * Manages persistence of the CodeSurf tile ID (CARD_ID) so Claude Code sessions
 * can recover and resume previous sessions.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * File where we store the last CARD_ID used
 */
function getLastCardIdFile(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "~";
  return path.join(home, ".contex", ".last-card-id");
}

/**
 * Save the CARD_ID for recovery in next session
 */
export function saveLastCardId(cardId: string): void {
  try {
    const file = getLastCardIdFile();
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(file, cardId.trim(), "utf8");
  } catch {
    // Silently fail — this is non-critical
  }
}

/**
 * Recover the last CARD_ID from previous session
 */
export function loadLastCardId(): string | null {
  try {
    const file = getLastCardIdFile();
    if (!fs.existsSync(file)) {
      return null;
    }
    const cardId = fs.readFileSync(file, "utf8").trim();
    return cardId && cardId.length > 0 ? cardId : null;
  } catch {
    return null;
  }
}

/**
 * Clear the saved CARD_ID (when user explicitly closes a session)
 */
export function clearLastCardId(): void {
  try {
    const file = getLastCardIdFile();
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  } catch {
    // Silently fail
  }
}

/**
 * Get CARD_ID from environment variable, saved file, or generate new
 */
export function resolveCardId(override?: string): string | null {
  // 1. Use override if provided
  if (override && override.trim().length > 0) {
    const cardId = override.trim();
    saveLastCardId(cardId);
    return cardId;
  }

  // 2. Check environment variable
  const fromEnv = process.env.CARD_ID?.trim();
  if (fromEnv && fromEnv.length > 0) {
    saveLastCardId(fromEnv);
    return fromEnv;
  }

  // 3. Try to recover from last session
  const fromFile = loadLastCardId();
  if (fromFile) {
    return fromFile;
  }

  // 4. No recovery — return null (let caller synthesize)
  return null;
}

/**
 * Check if a CARD_ID has a saved state
 */
export function hasSavedState(cardId: string): boolean {
  try {
    const home = process.env.HOME || process.env.USERPROFILE || "~";
    const stateFile = path.join(home, ".contex", `tile-${cardId}`, "state.json");
    return fs.existsSync(stateFile);
  } catch {
    return false;
  }
}
