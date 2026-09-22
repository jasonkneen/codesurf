// Shared first-home-segment denylist for sensitive credential/config
// directories. Consumed by both the `codesurf-file://` media protocol
// (`file-protocol-auth.ts`) and the full read/write/delete fs IPC surface
// (`ipc/fs.ts`) so the two boundaries guarding the home directory can't
// silently drift apart. Add new sensitive entries here only — both
// boundaries inherit automatically.
export const SENSITIVE_HOME_DIRS = new Set([
  '.ssh',
  '.gnupg',
  '.aws',
  '.config',
  '.kube',
  '.docker',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  '.gem',
  '.cargo',
  '.password-store',
  '.mozilla',
  '.thunderbird',
  '.local',
  '.cache',
])
