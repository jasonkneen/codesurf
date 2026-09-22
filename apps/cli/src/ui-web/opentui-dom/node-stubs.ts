// node-stubs.ts — web-only stand-ins for the node builtins a few ui leaves
// import (markdown-links, local-file-paths, image-viewer). The terminal build
// never sees these; the vite web build aliases node:os/path/url/fs/child_process
// here. They are honest no-ops: there is no local filesystem in the browser,
// so existsSync is false, spawn does nothing, homedir is empty.
//
// inline-image.tsx still cannot load in the web graph — it imports bun:ffi and
// sharp. That is P4 remainder, not this file.

export function homedir(): string {
  return "";
}

export function join(...segments: string[]): string {
  return segments.filter(Boolean).join("/");
}

export function isAbsolute(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
}

export function resolve(...segments: string[]): string {
  const parts: string[] = [];
  for (const segment of segments) {
    for (const piece of segment.split("/")) {
      if (!piece || piece === ".") continue;
      if (piece === "..") parts.pop();
      else parts.push(piece);
    }
  }
  return `/${parts.join("/")}`;
}

export function pathToFileURL(p: string): { href: string } {
  return { href: p };
}

export function fileURLToPath(_url: string | URL): string {
  return String(_url);
}

/** Browser has no local files. Callers skip missing paths. */
export function existsSync(_path: string): boolean {
  return false;
}

export function mkdirSync(_path: string, _opts?: unknown): void {}

export function spawn(
  _command: string,
  _args?: readonly string[],
  _opts?: { detached?: boolean; stdio?: string },
): { unref(): void } {
  return { unref() {} };
}

export function createHash(_algorithm: string): { update(data: string): { digest(encoding: string): string } } {
  return {
    update: () => ({
      digest: () => "",
    }),
  };
}

export default {
  homedir,
  join,
  isAbsolute,
  resolve,
  pathToFileURL,
  fileURLToPath,
  existsSync,
  mkdirSync,
  spawn,
  createHash,
};
