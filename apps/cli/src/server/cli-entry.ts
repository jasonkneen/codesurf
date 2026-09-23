// How to re-run this CLI as a child process (for `codesurf server start`).
//
//   bun dist/index.js ...        -> [bun, /abs/dist/index.js]
//   bun run src/index.ts ...     -> [bun, /abs/src/index.ts]      (dev)
//   node dist/index.js ...       -> [node, /abs/dist/index.js]
//   compiled binary (bun --compile): argv[1] is a virtual /$bunfs path that
//   is not a real file, and execPath is the binary itself -> [binary]

import fs from "node:fs";
import path from "node:path";

export interface CliEntry {
  command: string;
  args: string[];
}

export function resolveCliEntry(
  argv: readonly string[] = process.argv,
  execPath: string = process.execPath,
  isFile: (p: string) => boolean = defaultIsFile,
): CliEntry {
  const script = argv[1];
  if (script) {
    const absolute = path.resolve(script);
    if (isFile(absolute)) return { command: execPath, args: [absolute] };
  }
  return { command: execPath, args: [] };
}

function defaultIsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
