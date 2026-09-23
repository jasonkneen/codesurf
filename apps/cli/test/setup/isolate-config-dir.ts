// Every test run gets its own CodeSurf config directory.
//
// Without this, any test that boots the plugin loader without setting
// CODESURF_CONFIG_DIR writes the developer's real ~/.codesurf/plugins.json:
// bootstrap persists "the enabled set" from a test catalog, which wiped the
// real opt-in list (51 plugins -> 1) on every `vitest run`, so providers and
// UI plugins that are off by default stopped loading on the next launch.
//
// Runs before any test module is imported, so module-level path constants
// (e.g. USER_DIR in utils/settings.ts) resolve here too. A test that sets its
// own directory still wins; one that restores "the original" value restores
// this one, never the real home directory.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.CODESURF_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-test-config-"));
