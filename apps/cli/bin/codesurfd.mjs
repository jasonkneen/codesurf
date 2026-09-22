#!/usr/bin/env node
// Launcher shim, identical to the desktop app's. The canonical daemon lives in
// packages/codesurf-daemon (@codesurf/daemon); this file only resolves it and
// forwards. Keep it route-free: anything added here exists only when the CLI
// spawns the shared daemon, and disappears when the desktop app does.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const manifestPath = require.resolve("@codesurf/daemon/package.json");
const daemonBin = join(dirname(manifestPath), "bin", "codesurfd.mjs");
await import(pathToFileURL(daemonBin).href);
