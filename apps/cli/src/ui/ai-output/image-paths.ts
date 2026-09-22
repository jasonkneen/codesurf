// Image-path extraction for inline previews in user messages.
//
// Kept free of sharp / bun:ffi so it can be unit-tested under vitest; the
// InlineImage component re-exports these helpers.
//
// A path only counts when it is a whole token: it starts at the beginning of
// a line or after whitespace (or is wrapped in quotes), starts with `/` or
// `file://`, and contains no unescaped spaces unless quoted. Remote http(s)
// URLs are deliberately not matched — InlineImage decodes local files only.

import { isImageFilePath, normalizeLocalPathText } from "../local-file-paths";

const IMAGE_EXT = "(?:png|jpe?g|gif|webp|bmp)";
const PATH_START = String.raw`(?:file:\/\/|\/)`;
const IMAGE_PATH_RE = new RegExp(
  String.raw`(^|\s)(?:"(${PATH_START}[^"\n]*?\.${IMAGE_EXT})"|'(${PATH_START}[^'\n]*?\.${IMAGE_EXT})'|(${PATH_START}(?:\\[^\n]|[^\s"'\x60<>()[\]{}\\])+\.${IMAGE_EXT}))(?=$|[\s.,;:!?])`,
  "gim",
);

export function extractImagePaths(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  IMAGE_PATH_RE.lastIndex = 0;
  for (let m = IMAGE_PATH_RE.exec(text); m; m = IMAGE_PATH_RE.exec(text)) {
    const path = normalizeLocalPathText(m[2] ?? m[3] ?? m[4] ?? "");
    if (!isImageFilePath(path) || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

/** Remove inline image paths from message text so they aren't printed verbatim
 *  alongside the rendered preview (the raw `/var/folders/.../T/...png` temp
 *  path is noise). Only whole-token image paths are removed; surrounding user
 *  text is left intact. Returns "" when the message was only an image path. */
export function stripImagePaths(text: string): string {
  return text
    .replace(IMAGE_PATH_RE, (match: string, prefix: string, dq?: string, sq?: string, bare?: string) => {
      const path = normalizeLocalPathText(dq ?? sq ?? bare ?? "");
      return isImageFilePath(path) ? prefix : match;
    })
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
