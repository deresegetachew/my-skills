#!/usr/bin/env bash
# Block until a pull request is merged or closed, instead of sleeping on a guess.
#   wait_for_merge.sh <pr-number> [max-minutes, default 30]
# Exit 0 = merged, 1 = closed without merging, 2 = still open after max-minutes (move on to other work).
# Polls every 60 s with a tiny gh call, so waiting costs no model tokens.
set -euo pipefail
pr="${1:?usage: wait_for_merge.sh <pr-number> [max-minutes]}"
max="${2:-30}"
for ((i = 0; i < max; i++)); do
  state=$(gh pr view "$pr" --json state -q .state 2>/dev/null || echo UNKNOWN)
  case "$state" in
    MERGED) echo "PR #$pr merged"; git pull -q --ff-only 2>/dev/null || true; exit 0 ;;
    CLOSED) echo "PR #$pr closed without merging"; exit 1 ;;
  esac
  sleep 60
done
echo "PR #$pr still open after $max minutes"
exit 2
