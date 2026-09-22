// Crash-safe file replacement for small config files.
//
// A plain `writeFileSync` truncates the target before writing, so a crash or a
// concurrent reader mid-write sees a torn or empty file. Writing a sibling
// temp file, flushing it, and renaming it over the target means readers only
// ever see the old contents or the new ones: `rename` within one directory is
// atomic on POSIX filesystems, which is also what keeps two CodeSurf
// processes from interleaving bytes in the same file.

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Atomically replace `file` with `contents`.
 *
 * The temp file is created with `mode` (default owner-only 0600), so the data
 * is never readable by other users, not even between the write and a chmod.
 */
export function writeFileAtomic(file: string, contents: string, mode = 0o600): void {
  const dir = path.dirname(file);
  const tempPath = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const fd = fs.openSync(tempPath, "wx", mode);
  try {
    try {
      fs.writeFileSync(fd, contents, "utf-8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // The umask can only narrow the creation mode; chmod pins it exactly.
    try {
      fs.chmodSync(tempPath, mode);
    } catch {
      // Non-POSIX filesystems may not support chmod; best effort.
    }
    fs.renameSync(tempPath, file);
  } catch (err) {
    fs.rmSync(tempPath, { force: true });
    throw err;
  }
}
