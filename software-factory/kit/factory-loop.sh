#!/usr/bin/env bash
# Fresh-context factory loop: one Claude Code run per task, so every task starts with a clean context
# (cheaper and more reliable than one long session; state lives in git, the plan and the PRs).
#   ./factory-loop.sh            run tasks; when none is ready, wait and check again every `waitMinutes` (default 1;
#                                0 in factory.json makes it exit instead). Ctrl-C stops it
#   ./factory-loop.sh 5          run at most 5 tasks
#   ./factory-loop.sh --interactive [N]
#                                each task opens a normal Claude session you can type into, with the task
#                                already started. When the task is done the session closes by itself and the
#                                next one starts after a 10 s countdown (q stops). If the session closes before
#                                the task is done (/exit, a crash, a usage limit), it also carries on after 10 s
#   (or: ./factory loop [-i] [N])
#
# Several loops can run at once: start this script again in another terminal. Each loop gets its own checkout
# (the first uses this folder, the others a git worktree in <project>-agents/<name>) and claims each task in
# a shared lock file before building it, so no two loops build the same task (.claude/hooks/factory_claims.py).
# Loops on other machines see each other's task/<id>-... branches on the remote and skip those tasks too.
# Parallel loops pay off when the plan has tasks that don't build on each other; the dev manager merges in order.
#
# Between tasks it brings its folder to main. When main has a newer factory-loop.sh (after a factory update), it
# restarts itself with that version, as the same agent in the same folder; no need to stop and start it.
#
# Stops when the same task comes up 3 times in a row (stuck), and prints why.
# Commands Claude needs must be allowed in .claude/settings.json: in this mode nobody can answer a prompt.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"   # `sh factory-loop.sh` on macOS is POSIX sh; this needs bash
set -uo pipefail
# This script as it was when the loop started. Between tasks the loop brings its folder to main; when main has
# a newer factory-loop.sh (a factory update), the loop restarts itself with it (reload_if_changed below).
self_sum=$(cksum < "$0")
cd "$(git rev-parse --show-toplevel)"
hooks="$PWD/.claude/hooks"
interactive=0
if [ "${1:-}" = "--interactive" ] || [ "${1:-}" = "-i" ]; then interactive=1; shift; fi
limit="${1:-999}"

if [ -n "${FACTORY_RELOAD_DIR:-}" ]; then
  # Restarted by reload_if_changed: same pid, so the same agent and folder (its checkout claim still holds).
  agent="$FACTORY_RELOAD_AGENT"; dir="$FACTORY_RELOAD_DIR"; unset FACTORY_RELOAD_AGENT FACTORY_RELOAD_DIR
else
  read -r agent dir < <(python3 "$hooks/factory_claims.py" checkout --pid $$) || exit 1
fi
# On exit: drop the local claims, and say on GitHub that this agent is down (issues mode; a no-op otherwise).
trap 'python3 "$hooks/factory_claims.py" release --agent "$agent" >/dev/null 2>&1; python3 "$hooks/factory_agents.py" down --agent "$agent" >/dev/null 2>&1' EXIT
trap 'exit 130' INT TERM
main=$(python3 -c 'import json;print(json.load(open(".claude/factory.json")).get("mainBranch","main"))')
if [ "$dir" != "$PWD" ]; then
  # A new worktree has no untracked local files: bring the local env files over, then install.
  for f in .env.local .env.*.local; do [ -f "$f" ] && [ ! -e "$dir/$f" ] && cp "$f" "$dir/$f"; done
  cd "$dir"
  python3 "$hooks/factory_remote.py" 2>/dev/null | sed "s/^/[$agent] /"  # the repository may have moved on GitHub
  # A reused worktree may be far behind: bring it to main before using its hooks and config.
  git fetch -q origin && git checkout -q --detach "origin/$main" || {
    echo "[$agent] Could not check out origin/$main in $dir (uncommitted changes there?). Clean it up, or remove it: git worktree remove $dir"
    exit 1; }
  [ -f .gitmodules ] && git submodule update --init -q  # skills from my-skills, for example
  install=$(python3 -c 'import json;print(json.load(open(".claude/factory.json")).get("commands",{}).get("install",""))')
  # Every start, not once: main may have new dependencies since this worktree was last used.
  [ -n "$install" ] && { echo "[$agent] $install"; sh -c "$install" || echo "[$agent] (install failed; tests may fail)"; }
fi
hooks="$PWD/.claude/hooks"
export FACTORY_AGENT="$agent"
# Own ports, database and queue per loop (agentEnv in factory.json), then the project's per-loop setup.
eval "$(python3 "$hooks/factory_env.py" --agent "$agent")" || exit 1
setup=$(python3 -c 'import json;print(json.load(open(".claude/factory.json")).get("commands",{}).get("agentSetup",""))')
[ -n "$setup" ] && { echo "[$agent] $setup"; sh -c "$setup" || echo "[$agent] (agentSetup failed; tests may fail until it works)"; }
wait_minutes=$(python3 -c 'import json;print(int(json.load(open(".claude/factory.json")).get("waitMinutes",1)))' 2>/dev/null || echo 1)
export FACTORY_INTERACTIVE="$interactive"
export FACTORY_LOOP=1
python3 "$hooks/factory_agents.py" register --agent "$agent" >/dev/null 2>&1 || true  # its issue: Agent: <name> · idle
echo "[$agent] working in $PWD (slot ${FACTORY_SLOT:-1})"

# Between tasks: back to a clean main. In an agent worktree, untracked leftovers go too (ignored files such as
# node_modules stay, so no reinstall). Local task branches whose task is ticked on main are deleted.
tidy() {
  # The repository moved or was renamed on GitHub: point the remote at its new name before anything uses it.
  python3 "$hooks/factory_remote.py" 2>/dev/null | sed "s/^/[$agent] /"
  # Clean leftovers only after a clean switch to main, and never in the project folder: when the checkout fails
  # (uncommitted changes), the files may be unfinished work, so they stay and the loop says so.
  # Tracked edits can survive a checkout, so check first: with any, leave the folder alone this time.
  if [ -n "$(git status --porcelain --untracked-files=no 2>/dev/null || echo unknown)" ]; then
    echo "[$agent] $PWD has uncommitted changes; leaving it as it is (commit or stash them)."
  elif git fetch -q origin && git checkout -q --detach "origin/$main" 2>/dev/null; then
    [ "$PWD" != "$home" ] && [ "$(git rev-parse --show-toplevel)" != "$home" ] && git clean -fdq 2>/dev/null
  else
    echo "[$agent] Could not switch $PWD to origin/$main (uncommitted changes?); leaving the files as they are."
  fi
  [ -f .gitmodules ] && git submodule update --init -q  # main may have moved the submodule (the factory kit)
  python3 "$hooks/factory_claims.py" tidy-branches >/dev/null 2>&1 || true
}
home="$(cd "$(git rev-parse --git-common-dir)/.." && pwd)"
# Only the project's MCP servers (its .mcp.json, else none): never the user's own claude.ai connectors or the servers
# in their settings, which would put tool definitions nobody here needs into every turn (#55). Set before each run,
# since main may bring a .mcp.json. --mcp-config takes several values, so another flag must follow it.
isolate() {
  local cfg='{"mcpServers":{}}'
  [ -f "$PWD/.mcp.json" ] && cfg="$PWD/.mcp.json"
  claude_flags=(--mcp-config "$cfg" --strict-mcp-config --settings '{"disableClaudeAiConnectors": true}')
}
# After tidy: if main brought a different factory-loop.sh, carry on with that one. exec keeps the pid, so the
# agent keeps its name, folder and claims, and the EXIT trap doesn't run (it's still alive). $1 = tasks left.
reload_if_changed() {
  [ -f factory-loop.sh ] || return 0
  [ "$(cksum < factory-loop.sh)" = "$self_sum" ] && return 0
  echo "[$agent] $(date '+%H:%M') the factory loop changed on main: restarting with the new version."
  export FACTORY_RELOAD_AGENT="$agent" FACTORY_RELOAD_DIR="$PWD"
  if [ "$interactive" = 1 ]; then exec bash ./factory-loop.sh -i "$1"; else exec bash ./factory-loop.sh "$1"; fi
}

last=""; repeats=0
for ((n = 1; n <= limit; n++)); do
  tidy
  reload_if_changed $((limit - n + 1))
  # Nothing to do: wait for work instead of exiting (`waitMinutes` in factory.json; 0 = exit as before). While it waits
  # the agent stays registered as idle, so the dev manager doesn't take it for dead. Ctrl-C stops it.
  waited=0
  until next=$(python3 "$hooks/next_task.py" --claim "$agent" --pid $$); do
    [ "$wait_minutes" -gt 0 ] 2>/dev/null || {
      echo "[$agent] Nothing left for this loop: every task is done, blocked or taken by another loop."; exit 0; }
    [ "$waited" = 0 ] && echo "[$agent] $(date '+%H:%M') nothing ready (every task is done, blocked or taken). Checking again every $wait_minutes min; Ctrl-C stops."
    waited=1
    python3 "$hooks/factory_agents.py" ping --agent "$agent" --status idle >/dev/null 2>&1 || true
    sleep $((wait_minutes * 60))
    tidy
    reload_if_changed $((limit - n + 1))
  done
  id="${next%% *}"
  if [ "$id" = "$last" ]; then repeats=$((repeats + 1)); else repeats=1; last="$id"; fi
  if [ "$repeats" -ge 3 ]; then
    echo "[$agent] Task $id came up 3 times in a row without being ticked or pushed; stopping so a person or the dev manager can look."
    exit 1
  fi
  echo "=== [$agent] $(date '+%H:%M') task $next ==="
  isolate
  if [ "$interactive" = 1 ]; then
    echo "[$agent] Talk to it as usual. When the task is done, the session closes by itself."
    python3 "$hooks/factory_claims.py" take-done --agent "$agent" >/dev/null  # no stale mark from an earlier run
    # Remote Control (on by default; FACTORY_REMOTE_CONTROL=0 turns it off): the session also appears at
    # claude.ai/code and in the Claude app, so you can watch it and type into it (/exit included) from your phone.
    if [ "${FACTORY_REMOTE_CONTROL:-1}" = 1 ]; then
      claude "${claude_flags[@]}" --remote-control="$agent $id" "/next-task $id" || true
    else
      claude "${claude_flags[@]}" "/next-task $id" || true
    fi
    stty sane 2>/dev/null
    python3 "$hooks/factory_claims.py" release --agent "$agent" --tasks-only >/dev/null
    finished="$(python3 "$hooks/factory_claims.py" take-done --agent "$agent")"
    if [ -n "$finished" ]; then
      # The agent finished and the Stop hook closed the session: go on unless you say stop.
      printf '[%s] Task %s done. Next task in 10 s; type q and Enter to stop: ' "$agent" "$finished"
      if read -r -t 10 answer </dev/tty; then :; else answer=""; echo; fi
    else
      # The session closed before the task was done (/exit, a crash, a usage limit). Carry on unless you say stop,
      # so a loop never waits all night for a key. The same task usually comes back; 3 times in a row stops the loop.
      printf '[%s] Task %s session ended before it was done. Carrying on in 10 s; type q and Enter to stop: ' "$agent" "$id"
      if read -r -t 10 answer </dev/tty; then :; else answer=""; echo; fi
    fi
    case "$answer" in q|Q|quit|stop|n|N) echo "[$agent] Stopped."; exit 0;; esac
    continue
  else
    claude "${claude_flags[@]}" -p "/next-task $id" || echo "[$agent] (the run for $id exited with an error; the next pass picks up from git)"
  fi
  python3 "$hooks/factory_claims.py" release --agent "$agent" --tasks-only >/dev/null  # the pushed branch marks it now
done
