// Resolves Codesurf's per-user config directory.
//
// Migration notes (CLI rebrand from grok-cli → codesurf):
//   - Env: CODESURF_CONFIG_DIR.
//   - New default: ~/.codesurf. Legacy: ~/.grok.
// We honor the new names first, then fall back to the legacy names so that
// existing installs keep working without manual migration.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Returns the config dir to use for reads and writes.
 *
 * Resolution order:
 *   1. `CODESURF_CONFIG_DIR` env var (test/override hook).
 *   2. `CODESURF_CONFIG_DIR` env var.
 *   3. `~/.codesurf` if it exists on disk.
 *   4. `~/.grok` if it exists on disk (legacy install).
 *   5. `~/.codesurf` as the new default for fresh installs.
 */
export function getCodesurfConfigDir(): string {
  const envOverride = process.env.CODESURF_CONFIG_DIR;
  if (envOverride && envOverride.trim().length > 0) return envOverride;

  const home = os.homedir();
  const next = path.join(home, ".codesurf");
  const legacy = path.join(home, ".grok");
  if (fs.existsSync(next)) return next;
  if (fs.existsSync(legacy)) return legacy;
  return next;
}
