import { promises as fs } from 'fs'

/** Deletes a file if it exists, silently ignoring ENOENT. */
export async function deleteFileIfExists(path: string): Promise<void> {
  try {
    await fs.unlink(path)
  } catch {
    // file didn't exist — fine
  }
}
