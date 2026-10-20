#!/usr/bin/env bash
# Fresh-context factory loop: one Claude Code run per task, so every task starts with a clean context
# (cheaper and more reliable than one long session; state lives in git, the plan and the PRs).
#   ./factory-loop.sh            run until every task is done, blocked or taken by another loop
#   ./factory-loop.sh 5          run at most 5 tasks
#   ./factory-loop.sh --interactive [N]
#                                each task opens a normal Claude session you can type into, with the task
#                                already started; type /exit when it says it's done and the loop starts the
#                                next task in a fresh session (still claimed, still one task per session)
#
# Several loops can run at once: start this script again in another terminal. Each loop gets its own checkout
# (the first uses this folder, the others a git worktree in <project>-agents/agent-N) and claims each task in
# a shared lock file before building it, so no two loops build the same task (.claude/hooks/factory_claims.py).
# Loops on other machines see each other's task/<id>-... branches on the remote and skip those tasks too.
# Parallel loops pay off when the plan has tasks that don't build on each other; the dev manager merges in order.
#
# Stops when the same task comes up 3 times in a row (stuck), and prints why.
# Commands Claude needs must be allowed in .claude/settings.json: in this mode nobody can answer a prompt.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"   # `sh factory-loop.sh` on macOS is POSIX sh; this needs bash
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
hooks="$PWD/.claude/hooks"
interactive=0
if [ "${1:-}" = "--interactive" ] || [ "${1:-}" = "-i" ]; then interactive=1; shift; fi
limit="${1:-999}"

read -r agent dir < <(python3 "$hooks/factory_claims.py" checkout --pid $$) || exit 1
trap 'python3 "$hooks/factory_claims.py" release --agent "$agent" >/dev/null 2>&1' EXIT
trap 'exit 130' INT TERM
if [ "$dir" != "$PWD" ]; then
  # A new worktree has no untracked local files: bring the local env files over, then install.
  for f in .env.local .env.*.local; do [ -f "$f" ] && [ ! -e "$dir/$f" ] && cp "$f" "$dir/$f"; done
  cd "$dir"
  install=$(python3 -c 'import json;print(json.load(open(".claude/factory.json")).get("commands",{}).get("install",""))')
  marker="$(git rev-parse --git-dir)/factory-installed"
  [ -n "$install" ] && [ ! -e "$marker" ] && { echo "[$agent] $install"; sh -c "$install" && touch "$marker"; }
fi
hooks="$PWD/.claude/hooks"
export FACTORY_AGENT="$agent"
# Own ports, database and queue per loop (agentEnv in factory.json), then the project's per-loop setup.
eval "$(python3 "$hooks/factory_env.py" --agent "$agent")" || exit 1
setup=$(python3 -c 'import json;print(json.load(open(".claude/factory.json")).get("commands",{}).get("agentSetup",""))')
[ -n "$setup" ] && { echo "[$agent] $setup"; sh -c "$setup" || echo "[$agent] (agentSetup failed; tests may fail until it works)"; }
export FACTORY_INTERACTIVE="$interactive"
echo "[$agent] working in $PWD (slot $FACTORY_SLOT)"

last=""; repeats=0
for ((n = 1; n <= limit; n++)); do
  git fetch -q origin && git checkout -q --detach "origin/$(python3 -c 'import json;print(json.load(open(".claude/factory.json")).get("mainBranch","main"))')" 2>/dev/null
  next=$(python3 "$hooks/next_task.py" --claim "$agent" --pid $$) || {
    echo "[$agent] Nothing left for this loop: every task is done, blocked or taken by another loop."; exit 0; }
  id="${next%% *}"
  if [ "$id" = "$last" ]; then repeats=$((repeats + 1)); else repeats=1; last="$id"; fi
  if [ "$repeats" -ge 3 ]; then
    echo "[$agent] Task $id came up 3 times in a row without being ticked or pushed; stopping so a person or the dev manager can look."
    exit 1
  fi
  echo "=== [$agent] $(date '+%H:%M') task $next ==="
  if [ "$interactive" = 1 ]; then
    echo "[$agent] Talk to it as usual. When it says the task is done, type /exit for the next task (Ctrl-C twice stops the loop)."
    claude "/next-task $id" || true
  else
    claude -p "/next-task $id" || echo "[$agent] (the run for $id exited with an error; the next pass picks up from git)"
  fi
  python3 "$hooks/factory_claims.py" release --agent "$agent" --tasks-only >/dev/null  # the pushed branch marks it now
done
