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

// Same rationale, for `~/.codesurf` itself (src/storage/db.ts's
// getDatabasePath, via @codesurf/daemon's defaultCodesurfHome). Without this,
// any test that reaches the sqlite-backed storage layer (traces, sessions,
// issues, transcripts) without explicitly setting CODESURF_HOME silently
// writes rows into the developer's real ~/.codesurf/terminal.db. Individual
// suites that need finer control still set/restore their own CODESURF_HOME
// per test; this is only the default for suites that don't.
process.env.CODESURF_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "codesurf-test-home-"));
