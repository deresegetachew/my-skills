#!/usr/bin/env bash
# Fresh-context factory loop: one Claude Code run per task, so every task starts with a clean context
# (cheaper and more reliable than one long session; state lives in git, the plan and the PRs).
#   ./factory-loop.sh            run until every task is done or blocked
#   ./factory-loop.sh 5          run at most 5 tasks
# Stops when the same task comes up 3 times in a row (stuck), and prints why.
# Commands Claude needs must be allowed in .claude/settings.json: in this mode nobody can answer a prompt.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
limit="${1:-999}"
last=""; repeats=0
for ((n = 1; n <= limit; n++)); do
  next=$(python3 .claude/hooks/next_task.py) || { echo "Nothing left: every task is done or blocked."; exit 0; }
  id="${next%% *}"
  if [ "$id" = "$last" ]; then repeats=$((repeats + 1)); else repeats=1; last="$id"; fi
  if [ "$repeats" -ge 3 ]; then
    echo "Task $id came up 3 times in a row without being ticked; stopping so a person or the dev manager can look."
    exit 1
  fi
  echo "=== $(date '+%H:%M') task $next ==="
  claude -p "/next-task $id" || echo "(the run for $id exited with an error; the next pass picks up from git)"
done
