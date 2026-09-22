import { isAbsolute, resolve } from "node:path";
import { hostFiles } from "./host-files.js";

export const IMAGE_FILE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|tiff?)$/i;

const LOCAL_PATH_RE = /((?:file:\/\/|~\/|\/)(?:\\[^\n]|[^\s`<>[\](){}])+\.[A-Za-z0-9]{1,12})/gi;

export function shellUnescapePath(value: string): string {
  return value.replace(/\\([^\n])/g, "$1");
}

export function normalizeLocalPathText(value: string, cwd = process.cwd()): string {
  const cleaned = shellUnescapePath(value.trim().replace(/^["']|["']$/g, ""));
  if (cleaned.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(cleaned).pathname);
    } catch {
      return cleaned;
    }
  }
  if (cleaned.startsWith("~/")) return cleaned;
  return isAbsolute(cleaned) ? cleaned : resolve(cwd, cleaned);
}

export function extractExistingLocalFilePaths(text: string, cwd = process.cwd()): string[] {
  const matches = text.match(LOCAL_PATH_RE) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of matches) {
    const path = normalizeLocalPathText(raw, cwd);
    if (seen.has(path) || !hostFiles.exists(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

export function isImageFilePath(path: string): boolean {
  return IMAGE_FILE_EXT_RE.test(path);
}
