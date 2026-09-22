// Per-adapter credential persistence.
//
// File: ~/.codesurf/credentials.json (chmod 0600 where possible)
// (legacy: ~/.grok/credentials.json — still read transparently via
// getCodesurfConfigDir for back-compat during the rebrand).
// Layout:
//   {
//     "<adapterId>": { "type": "api-key", "value": "sk-..." }
//   | { "<adapterId>": { "type": "oauth", "token": "...", "expiresAt": "..." }
//   }
//
// Env vars ALWAYS take precedence over file contents. This keeps CI and
// ephemeral shell workflows first-class.

import * as fs from "fs";
import * as path from "path";
import { getCodesurfConfigDir } from "../../utils/config-dir";
import { writeFileAtomic } from "./atomic-write";

export type CredentialRecord =
  | { type: "api-key"; value: string }
  | {
      type: "oauth";
      token: string;
      refreshToken?: string;
      expiresAt?: string;
      scope?: string;
    };

type CredentialsFile = Record<string, CredentialRecord>;

function resolveCredentialsPath(): { dir: string; file: string } {
  const dir = getCodesurfConfigDir();
  return { dir, file: path.join(dir, "credentials.json") };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function chmodOwnerOnly(file: string): void {
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Non-POSIX filesystems may not support chmod; best effort.
  }
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function findExistingCorruptBackup(file: string, contents: Buffer): string | null {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.corrupt-`;

  try {
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.startsWith(prefix)) continue;
      const backupPath = path.join(dir, entry);
      try {
        if (fs.readFileSync(backupPath).equals(contents)) return backupPath;
      } catch {
        // Ignore unreadable sidecars and keep looking.
      }
    }
  } catch {
    // Directory scans are best effort; strict write paths still try to copy.
  }

  return null;
}

function corruptBackupPath(file: string, timestamp: string, attempt: number): string {
  const base = `${file}.corrupt-${timestamp}`;
  return attempt === 0 ? base : `${base}-${attempt}`;
}

function preserveCorruptCredentialsFile(file: string, contents?: Buffer): string {
  const existingBackup = contents ? findExistingCorruptBackup(file, contents) : null;
  if (existingBackup) return existingBackup;

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  let attempt = 0;

  while (true) {
    const backupPath = corruptBackupPath(file, timestamp, attempt);
    try {
      fs.copyFileSync(file, backupPath, fs.constants.COPYFILE_EXCL);
      chmodOwnerOnly(backupPath);
      return backupPath;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      attempt += 1;
    }
  }
}

function failUnreadableCredentialsFile(file: string, reason: string, contents?: Buffer): never {
  let backupMessage = "";
  try {
    const backupPath = preserveCorruptCredentialsFile(file, contents);
    backupMessage = ` Preserved a copy at ${backupPath}.`;
  } catch (error) {
    backupMessage = ` Failed to create a corrupt-file backup: ${errorMessage(error)}.`;
  }

  const message = `[credentials] Failed to read credentials file ${file}: ${reason}.${backupMessage} Refusing to continue so stored credentials are not overwritten.`;
  console.error(message);
  throw new Error(message);
}

function readFile(mode: "lenient" | "strict"): CredentialsFile {
  const { file } = resolveCredentialsPath();
  if (!fs.existsSync(file)) return {};

  let raw: Buffer;
  try {
    raw = fs.readFileSync(file);
  } catch (error) {
    if (mode === "strict") {
      failUnreadableCredentialsFile(file, `could not read file: ${errorMessage(error)}`);
    }
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf-8"));
  } catch (error) {
    if (mode === "strict") {
      failUnreadableCredentialsFile(file, `invalid JSON: ${errorMessage(error)}`, raw);
    }
    return {};
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    if (mode === "strict") {
      failUnreadableCredentialsFile(file, "expected a JSON object", raw);
    }
    return {};
  }

  return parsed as CredentialsFile;
}

function writeFile(data: CredentialsFile): void {
  const { dir, file } = resolveCredentialsPath();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Owner-only from creation, and never a torn file on crash.
  writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`, 0o600);
}

export function loadCredential(adapterId: string): CredentialRecord | null {
  const all = readFile("lenient");
  return all[adapterId] ?? null;
}

export function saveCredential(adapterId: string, record: CredentialRecord): void {
  const all = readFile("strict");
  all[adapterId] = record;
  writeFile(all);
}

export function clearCredential(adapterId: string): void {
  const all = readFile("strict");
  delete all[adapterId];
  writeFile(all);
}

/**
 * Resolve an API key for an adapter with env-var precedence:
 *   1. `envVar` (if defined) — highest priority, zero config.
 *   2. credentials.json entry for `adapterId` if type === "api-key".
 *   3. null.
 */
export function resolveApiKey(adapterId: string, envVar?: string): string | null {
  if (envVar) {
    const env = process.env[envVar];
    if (env && env.trim().length > 0) return env.trim();
  }
  const record = loadCredential(adapterId);
  if (record?.type === "api-key" && record.value.trim().length > 0) {
    return record.value.trim();
  }
  return null;
}
