#!/usr/bin/env bash
# codesurf — wrapper that (a) rebuilds dist if sources changed, (b) runs the
# codesurf CLI in dist mode (no hot-reload), (c) preserves the caller's CWD
# so the CLI sees the user's actual project directory.
#
# Installed as /usr/local/bin/codesurf via `ln -s` to this file.

set -euo pipefail

REPO_DIR="/Users/jkneen/Documents/GitHub/grok-cli"
DIST="$REPO_DIR/dist/index.js"

# Make sure bun is findable even in minimal-PATH contexts (launchers, cron, etc.)
export PATH="$HOME/.bun/bin:$PATH"

needs_build() {
  [[ ! -f "$DIST" ]] && return 0
  local newer
  newer="$(find "$REPO_DIR/src" "$REPO_DIR/package.json" "$REPO_DIR/tsconfig.json" \
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
