import * as fs from "fs";
import * as path from "path";
import type { VerifyEnvironmentManifest, VerifyRecipe } from "../types/index";
import {
  mergeSandboxSettings,
  normalizeSandboxSettings,
  pickProjectSafeSandboxSettings,
  type SandboxSettings,
} from "../utils/settings";
import { normalizeVerifyRecipe } from "./recipes";

export interface LoadedVerifyEnvironment {
  path: string;
  recipe: VerifyRecipe;
  sandboxSettings: SandboxSettings;
}

const VERIFY_ENVIRONMENT_FILES = [".grok/environment.json", "environment.json"];
const GENERATED_VERIFY_ENVIRONMENT = ".grok/environment.json";

function readJson(filePath: string): VerifyEnvironmentManifest | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as VerifyEnvironmentManifest;
  } catch {
    return null;
  }
}

function asStringArray(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    .map((entry) => entry.trim());
}

/**
 * Sandbox fields a (repo-controlled) manifest may set. Everything here only
 * shapes the guest the recipe's own commands already run in: resources,
 * layout, base checkpoint, guest shell init, inbound port forwards. Which
 * host env vars are forwarded as secrets, network policy and host-side
 * execution come from the caller's user settings only.
 */
function pickManifestSandboxSettings(raw: unknown): SandboxSettings {
  const normalized = normalizeSandboxSettings(raw);
  const picked = pickProjectSafeSandboxSettings(normalized);
  if (normalized.from !== undefined) picked.from = normalized.from;
  if (normalized.verifyBaseFrom !== undefined) picked.verifyBaseFrom = normalized.verifyBaseFrom;
  if (normalized.shellInit !== undefined) picked.shellInit = normalized.shellInit;
  if (normalized.ports !== undefined) picked.ports = normalized.ports;
  return picked;
}

function normalizeManifestRecipe(raw: VerifyEnvironmentManifest): VerifyRecipe | null {
  const base = raw.recipe && typeof raw.recipe === "object" ? raw.recipe : raw;
  return normalizeVerifyRecipe({
    ecosystem: base.ecosystem ?? raw.ecosystem ?? "custom",
    appKind: base.appKind ?? raw.appKind ?? "unknown",
    appLabel: base.appLabel ?? raw.appLabel ?? "Custom verify environment",
    shellInitCommands: base.shellInitCommands ?? base.shellInit ?? raw.shellInitCommands ?? raw.shellInit ?? [],
    bootstrapCommands: base.bootstrapCommands ?? base.bootstrap ?? raw.bootstrapCommands ?? raw.bootstrap ?? [],
    installCommands: base.installCommands ?? base.install ?? raw.installCommands ?? raw.install ?? [],
    buildCommands: base.buildCommands ?? base.build ?? raw.buildCommands ?? raw.build ?? [],
    testCommands: base.testCommands ?? base.test ?? raw.testCommands ?? raw.test ?? [],
    startCommand: base.startCommand ?? base.start ?? raw.startCommand ?? raw.start,
    startPort: base.startPort ?? raw.startPort,
    smokeKind: base.smokeKind ?? raw.smokeKind ?? "none",
    smokeTarget: base.smokeTarget ?? raw.smokeTarget,
    evidence: asStringArray(base.evidence ?? raw.evidence),
    notes: asStringArray(base.notes ?? raw.notes),
  });
}

export function loadVerifyEnvironment(cwd: string, baseSettings: SandboxSettings = {}): LoadedVerifyEnvironment | null {
  for (const candidate of VERIFY_ENVIRONMENT_FILES) {
    const filePath = path.join(cwd, candidate);
    if (!fs.existsSync(filePath)) continue;
    const manifest = readJson(filePath);
    if (!manifest) continue;
    const recipe = normalizeManifestRecipe(manifest);
    if (!recipe) continue;
    const sandboxSettings = mergeSandboxSettings(baseSettings, pickManifestSandboxSettings(manifest.sandbox));
    return {
      path: filePath,
      recipe,
      sandboxSettings,
    };
  }
  return null;
}

/** Only the fields `loadVerifyEnvironment` honours from a manifest are written to it. */
function pickPersistentSandboxSettings(settings: SandboxSettings): SandboxSettings {
  return pickManifestSandboxSettings(settings);
}

export function saveVerifyEnvironment(
  cwd: string,
  recipe: VerifyRecipe,
  sandboxSettings: SandboxSettings = {},
): string {
  const filePath = path.join(cwd, GENERATED_VERIFY_ENVIRONMENT);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload: VerifyEnvironmentManifest = {
    recipe: {
      ecosystem: recipe.ecosystem,
      appKind: recipe.appKind,
      appLabel: recipe.appLabel,
      shellInitCommands: recipe.shellInitCommands,
      bootstrapCommands: recipe.bootstrapCommands,
      installCommands: recipe.installCommands,
      buildCommands: recipe.buildCommands,
      testCommands: recipe.testCommands,
      startCommand: recipe.startCommand,
      startPort: recipe.startPort,
      smokeKind: recipe.smokeKind,
      smokeTarget: recipe.smokeTarget,
      evidence: recipe.evidence,
      notes: recipe.notes,
    },
    sandbox: pickPersistentSandboxSettings(sandboxSettings),
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return filePath;
}
