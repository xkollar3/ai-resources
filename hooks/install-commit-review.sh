#!/usr/bin/env bash
# Install the OpenCode commit-review pre-commit hook into the current git repo.
#
# Usage:
#   ~/.config/opencode/hooks/install-commit-review.sh           # copy hook
#   ~/.config/opencode/hooks/install-commit-review.sh --link    # symlink instead
#   ~/.config/opencode/hooks/install-commit-review.sh --uninstall

set -euo pipefail

MODE="copy"
case "${1:-}" in
  --link)      MODE="link" ;;
  --uninstall) MODE="uninstall" ;;
  -h|--help)
    sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  "") ;;
  *) echo "unknown arg: $1" >&2; exit 2 ;;
esac

HOOKS_DIR=$(git rev-parse --git-path hooks 2>/dev/null) || {
  echo "error: not in a git repository" >&2
  exit 1
}
# git rev-parse may return a path relative to CWD; normalize.
case "$HOOKS_DIR" in
  /*) ;;
  *) HOOKS_DIR="$PWD/$HOOKS_DIR" ;;
esac
mkdir -p "$HOOKS_DIR"

HOOK_SRC="$(cd "$(dirname "$0")" && pwd)/pre-commit"
HOOK_DST="$HOOKS_DIR/pre-commit"

if [ "$MODE" = "uninstall" ]; then
  if [ -e "$HOOK_DST" ] && grep -q 'commit-review' "$HOOK_DST" 2>/dev/null; then
    rm -f "$HOOK_DST"
    echo "removed $HOOK_DST"
  else
    echo "no commit-review hook at $HOOK_DST"
  fi
  exit 0
fi

if [ ! -f "$HOOK_SRC" ]; then
  echo "error: hook template missing at $HOOK_SRC" >&2
  exit 1
fi

# Back up any existing non-commit-review hook.
if [ -e "$HOOK_DST" ] && ! grep -q 'commit-review' "$HOOK_DST" 2>/dev/null; then
  BACKUP="$HOOK_DST.bak.$(date +%s)"
  echo "existing pre-commit hook found — backing up to $BACKUP"
  mv "$HOOK_DST" "$BACKUP"
fi

if [ "$MODE" = "link" ]; then
  ln -sf "$HOOK_SRC" "$HOOK_DST"
  echo "symlinked $HOOK_DST -> $HOOK_SRC"
else
  install -m 0755 "$HOOK_SRC" "$HOOK_DST"
  echo "installed $HOOK_DST  (re-run install to update)"
fi

cat <<EOF
done. usage:
  git commit                              # runs review, then commits
  git commit --no-verify                  # skip review (standard)
  SKIP_COMMIT_REVIEW=1 git commit ...     # also skip review
  COMMIT_REVIEW_TIMEOUT=20 git commit ... # tighter timeout
EOF
