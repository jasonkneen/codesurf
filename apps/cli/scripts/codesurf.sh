#!/usr/bin/env bash
# codesurf — wrapper that (a) rebuilds dist if sources changed, (b) runs the
# codesurf CLI in dist mode (no hot-reload), (c) preserves the caller's CWD
# so the CLI sees the user's actual project directory.
#
# Installed as /usr/local/bin/codesurf via `ln -s` to this file.

set -euo pipefail

# The CLI's own directory (apps/cli), found through the /usr/local/bin symlink
# rather than hard-coded, so the command follows whichever checkout it points at.
SOURCE="${BASH_SOURCE[0]}"
while [[ -L "$SOURCE" ]]; do
  LINK_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$LINK_DIR/$SOURCE"
done
REPO_DIR="$(cd -P "$(dirname "$SOURCE")/.." && pwd)"
PACKAGES_DIR="$(cd -P "$REPO_DIR/../../packages" 2>/dev/null && pwd || true)"
DIST="$REPO_DIR/dist/index.js"

# Make sure bun is findable even in minimal-PATH contexts (launchers, cron, etc.)
export PATH="$HOME/.bun/bin:$PATH"

needs_build() {
  [[ ! -f "$DIST" ]] && return 0
  local newer
  newer="$(find "$REPO_DIR/src" "$REPO_DIR/package.json" "$REPO_DIR/tsconfig.json" ${PACKAGES_DIR:+"$PACKAGES_DIR/plugin-api/src" "$PACKAGES_DIR/runtime/src"} \
    -newer "$DIST" -print -quit 2>/dev/null || true)"
  [[ -n "$newer" ]]
}

if needs_build; then
  echo "[codesurf] sources newer than dist/ — building..." >&2
  (cd "$REPO_DIR" && bun run build)
fi

# exec replaces this shell with bun so signals/exit codes propagate cleanly.
# CWD is preserved (the subshell above exited before we got here).
exec bun run "$DIST" "$@"
