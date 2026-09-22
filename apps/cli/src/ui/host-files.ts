// Host file access — the P4 services boundary.
//
// Terminal build: this file (node:fs, file:// hrefs, OS viewer).
// Web build: vite aliases this specifier to src/ui-web/host-files.ts
// (HTTP /files on the node, window.open). Call sites stay unchanged.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { HostFiles } from "./host-files-types.js";

export type { HostFiles } from "./host-files-types.js";

export const hostFiles: HostFiles = {
  hrefForPath(path, line) {
    const href = pathToFileURL(path).href;
    return line ? `${href}#L${line}` : href;
  },
  exists: existsSync,
  open(path) {
    try {
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
      const child = spawn(opener, [path], { detached: true, stdio: "ignore" });
      child.unref();
      return true;
    } catch {
      return false;
    }
  },
};
