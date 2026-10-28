#!/usr/bin/env bash
# Fresh-context factory loop: one Claude Code run per task, so every task starts with a clean context
# (cheaper and more reliable than one long session; state lives in git, the plan and the PRs).
#
# One runner for every role (#102): FACTORY_ROLE is coding-agent (the default, and what `factory loop` means),
# dev-manager or product-owner, and FACTORY_NAME picks a name from the role's list. Use the commands:
#   factory coding-agent [name] loop [-i] [--once] [--dry-run] [N]      (also: factory loop)
#   factory dev-manager  [name] loop [-i] [--once] [--dry-run]           the orchestrator, no model (#97)
#   factory product-owner [name] loop [-i] [--once] [--dry-run]
# What is shared is written once below (tidy the folder, reload when main changes this script, isolated MCP,
# register and ping, the 3-failures stop rule, interactive mode with Remote Control, waits between passes). What
# differs is factory_roles.ts's definition: the skill a pass runs, the settings profile, the model, how it decides it
# has work, and the waits. Only the coding agent claims a task; the others register as live agents.
#   --once      one pass, then exit          --dry-run   print what a pass would do; start and write nothing
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
# a shared lock file before building it, so no two loops build the same task (.claude/hooks/factory_claims.ts).
# Loops on other machines see each other's task/<id>-... branches on the remote and skip those tasks too.
# Parallel loops pay off when the plan has tasks that don't build on each other; the dev manager merges in order.
#
# Between tasks it brings its folder to main. When main has a newer factory-loop.sh (after a factory update), it
# restarts itself with that version, as the same agent in the same folder; no need to stop and start it.
#
# After a reboot, `factory resume` (#88) starts it with FACTORY_RESUME=1 in a folder that holds unfinished work: the
# folder is not moved to main or cleaned for the first task, and FACTORY_RESUME_NOTE (a file) goes into that task's
# first prompt, so the agent knows it is resuming and where its work and the backup are.
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
# Run a factory script (<path>.ts) with Bun. --no-env-file: Bun must not load the project's .env into the factory.
fh() {
  local s="$1"; shift
  command -v bun >/dev/null 2>&1 || { printf '{"code": "bun_missing", "message": "%s needs Bun, and bun is not on the PATH.", "fix": "Install Bun (curl -fsSL https://bun.sh/install | bash), open a new terminal, then run the command again."}\n' "${s##*/}.ts" >&2; return 127; }
  bun --no-env-file --config=/dev/null "$s.ts" "$@"
}
# One value of .claude/factory.json (`setting mainBranch main`, `setting commands.install ""`): the default when the key
# is missing; fails when the file is missing or not JSON.
setting() {
  bun --no-env-file --config=/dev/null -e 'const [k, d] = process.argv.slice(1); let v = JSON.parse(require("node:fs").readFileSync(".claude/factory.json", "utf8"));
for (const p of k.split(".")) v = v !== null && typeof v === "object" && !Array.isArray(v) && p in v ? v[p] : undefined;
console.log(v === undefined ? d : typeof v === "string" ? v : JSON.stringify(v));' "$@"
}
interactive=0; once=0; dry_run=0; limit=999
while [ $# -gt 0 ]; do
  case "$1" in
    --interactive|-i) interactive=1 ;;
    --once) once=1 ;;
    --dry-run) dry_run=1 ;;
    *[!0-9]*|"") echo "factory-loop: unknown option '$1' (use -i, --once, --dry-run or a number of passes)" >&2; exit 1 ;;
    *) limit="$1" ;;
  esac
  shift
done
[ "$once" = 1 ] && limit=1
role="${FACTORY_ROLE:-coding-agent}"; req_name="${FACTORY_NAME:-}"
case "$role" in coding-agent|dev-manager|product-owner) ;; *)
  echo "factory-loop: '$role' isn't a role (coding-agent, dev-manager, product-owner)." >&2; exit 1;; esac

# --dry-run: say what one pass would do and stop. Nothing is claimed, registered, started or written.
if [ "$dry_run" = 1 ]; then
  who="$req_name"
  [ -n "$who" ] || who="$(fh "$hooks/factory_roles" names "$role" 2>/dev/null | head -1)"
  [ -n "$who" ] || who="$role"
  echo "[$who] $role (dry run): nothing is claimed, registered, started or written."
  case "$role" in
    coding-agent)
      if next=$(fh "$hooks/next_task"); then
        echo "[$who] next task: $next"; echo "[$who] would run: claude -p \"/next-task ${next%% *}\" ($(fh "$hooks/factory_roles" permission-flags | paste -sd' ' - | sed 's/^$/no permission flag: your own Claude Code settings decide/'))"
      else echo "[$who] no task is ready: it would wait and look again."; fi ;;
    dev-manager)
      fh "$hooks/factory_orchestrator" cycle --name "$who" --dry-run ;;
    *)
      fh "$hooks/factory_roles" digest "$role" | sed "s/^/[$who] /"
      if found=$(fh "$hooks/factory_roles" work "$role" --name "$who"); then
        echo "$found" | sed "s/^/[$who] work: /"
        echo "[$who] would run: claude -p \"$(fh "$hooks/factory_roles" prompt "$role" "$who" | head -1)\" ($(fh "$hooks/factory_roles" permission-flags | paste -sd' ' - | sed 's/^$/no permission flag: your own Claude Code settings decide/'))"
      else
        echo "[$who] $found"
        [ "$role" != product-owner ] || [ "$interactive" != 1 ] || echo "[$who] with -i and nothing queued it would start a discovery session: claude \"/product-pass discover\""
      fi ;;
  esac
  exit 0
fi

resume_first="${FACTORY_RESUME:-0}"; unset FACTORY_RESUME  # for this first task only, also after a reload
if [ -n "${FACTORY_RELOAD_DIR:-}" ]; then
  # Restarted by reload_if_changed: same pid, so the same agent and folder (its checkout claim still holds).
  agent="$FACTORY_RELOAD_AGENT"; dir="$FACTORY_RELOAD_DIR"; unset FACTORY_RELOAD_AGENT FACTORY_RELOAD_DIR
else
  # The coding agent's call is today's; another role names itself and its role, and may ask for a name.
  if [ "$role" = coding-agent ]; then
    read -r agent dir < <(fh "$hooks/factory_claims" checkout --pid $$ ${req_name:+--name "$req_name"}) || exit 1
  else
    read -r agent dir < <(fh "$hooks/factory_claims" checkout --pid $$ --role "$role" ${req_name:+--name "$req_name"}) || exit 1
  fi
fi
# On exit: drop the local claims, and say on GitHub that this agent is down (issues mode; a no-op otherwise).
trap 'fh "$hooks/factory_claims" release --agent "$agent" >/dev/null 2>&1; fh "$hooks/factory_agents" down --agent "$agent" >/dev/null 2>&1' EXIT
trap 'exit 130' INT TERM
main=$(setting mainBranch main)
if [ "$dir" != "$PWD" ]; then
  # A new worktree has no untracked local files: bring the local env files over, then install.
  for f in .env.local .env.*.local; do [ -f "$f" ] && [ ! -e "$dir/$f" ] && cp "$f" "$dir/$f"; done
  cd "$dir"
  fh "$hooks/factory_remote" 2>/dev/null | sed "s/^/[$agent] /"  # the repository may have moved on GitHub
  # A reused worktree may be far behind: bring it to main before using its hooks and config.
  if [ "$resume_first" = 1 ]; then
    git fetch -q origin || true  # resuming after a restart: stay on the agent's branch with its changes
  else
    git fetch -q origin && git checkout -q --detach "origin/$main" || {
      echo "[$agent] Could not check out origin/$main in $dir (uncommitted changes there?). Clean it up, or remove it: git worktree remove $dir"
      exit 1; }
  fi
  [ -f .gitmodules ] && git submodule update --init -q  # skills from my-skills, for example
  # A worktree cut from a branch without the factory has no settings or hooks (#189): say so once, don't poll on errors.
  if [ ! -f .claude/factory.json ] || [ ! -f "$PWD/.claude/hooks/next_task.ts" ]; then
    printf '{"code":"no-factory","message":"%s has no .claude/factory.json or hooks, so there is no factory to run here.","fix":"Merge the install pull request into %s, or start the loop from a branch that has the factory."}\n' "$PWD" "$main" >&2
    exit 1
  fi
  install=""
  # A manager or a product owner reads and reviews; it builds nothing, so it needs no dependencies installed.
  [ "$role" = coding-agent ] && install=$(setting commands.install "")
  # Every start, not once: main may have new dependencies since this worktree was last used.
  [ -n "$install" ] && { echo "[$agent] $install"; sh -c "$install" || echo "[$agent] (install failed; tests may fail)"; }
fi
hooks="$PWD/.claude/hooks"
export FACTORY_AGENT="$agent"
# Own ports, database and queue per loop (agentEnv in factory.json), then the project's per-loop setup.
setup=""
if [ "$role" = coding-agent ]; then  # a manager or a product owner has no ports or database of its own
  eval "$(fh "$hooks/factory_env" --agent "$agent")" || exit 1
  setup=$(setting commands.agentSetup "")
fi
[ -n "$setup" ] && { echo "[$agent] $setup"; sh -c "$setup" || echo "[$agent] (agentSetup failed; tests may fail until it works)"; }
model_role=builder
if [ "$role" != coding-agent ]; then eval "$(fh "$hooks/factory_roles" vars "$role")"; model_role="$role_model_role"; fi
# Python's int(): a whole number, a number (truncated), a boolean or a string of digits; anything else gives 1.
wait_minutes=$(bun --no-env-file --config=/dev/null -e 'let v = JSON.parse(require("node:fs").readFileSync(".claude/factory.json", "utf8")).waitMinutes ?? 1;
if (typeof v === "boolean") v = Number(v); else if (typeof v === "string" && /^\s*[+-]?\d+\s*$/.test(v)) v = Number(v);
if (typeof v !== "number" || !Number.isFinite(v)) process.exit(1); console.log(Math.trunc(v));' 2>/dev/null || echo 1)
export FACTORY_INTERACTIVE="$interactive"
export FACTORY_LOOP=1
export FACTORY_ROLE="$role"
# Its issue: Agent: <name> · idle. Exit 3: another machine runs this name right now (#45); stop instead of doubling it.
if [ "$role" = coding-agent ]; then
  fh "$hooks/factory_agents" register --agent "$agent" >/dev/null 2>"${TMPDIR:-/tmp}/factory-register.$$"; rc=$?
else
  fh "$hooks/factory_agents" register --agent "$agent" --role "$role" >/dev/null 2>"${TMPDIR:-/tmp}/factory-register.$$"; rc=$?
fi
if [ "$rc" = 3 ]; then
  echo "[$agent] $(cat "${TMPDIR:-/tmp}/factory-register.$$")" >&2; rm -f "${TMPDIR:-/tmp}/factory-register.$$"
  # Not the EXIT trap: it would mark the other machine's agent issue down.
  trap - EXIT; fh "$hooks/factory_claims" release --agent "$agent" >/dev/null 2>&1; exit 1
fi
rm -f "${TMPDIR:-/tmp}/factory-register.$$"
if [ "$role" = coding-agent ]; then echo "[$agent] working in $PWD ${FACTORY_SLOT:+(slot $FACTORY_SLOT)}"
else echo "[$agent] $role working in $PWD"; fi

# Between tasks: back to a clean main. In an agent worktree, untracked leftovers go too (ignored files such as
# node_modules stay, so no reinstall). Local task branches whose task is ticked on main are deleted.
tidy() {
  # The repository moved or was renamed on GitHub: point the remote at its new name before anything uses it.
  fh "$hooks/factory_remote" 2>/dev/null | sed "s/^/[$agent] /"
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
  fh "$hooks/factory_claims" tidy-branches >/dev/null 2>&1 || true
}
home="$(cd "$(git rev-parse --git-common-dir)/.." && pwd)"
# Only the project's MCP servers: never the user's own claude.ai connectors or the servers in their settings, which
# would put tool definitions nobody here needs into every turn (#55). The config is the .mcp.json main has on origin
# (factory_mcp.ts), never this worktree's copy, since Claude starts those servers without asking. Set before each
# run, since main may change it. --mcp-config takes several values, so another flag must follow it.
isolate() {
  local cfg
  cfg="$(fh "$hooks/factory_mcp")" || cfg='{"mcpServers":{}}'
  [ -n "$cfg" ] || cfg='{"mcpServers":{}}'
  if [ "$role" = coding-agent ]; then
    # The agents' rules (deny list, PR gate, hooks) as main has them on origin, never this worktree's copy (#258).
    # Claude Code adds them on top of the project's own .claude/settings.json, if it has one. No rules, no session.
    local agent_settings
    agent_settings="$(fh "$hooks/factory_agent_settings")" || { echo "[$agent] the agent's settings could not be read; no session was started (the error above says what to do)."; exit 1; }
    claude_flags=(--mcp-config "$cfg" --strict-mcp-config --settings "$agent_settings")
  else
    # A manager or a product owner runs on its role's settings profile (factory_roles.ts): the project's own
    # settings.json denies `gh api`, which these roles need, so the profile replaces it for their sessions.
    claude_flags=(--mcp-config "$cfg" --strict-mcp-config)
    local line
    while IFS= read -r line; do [ -n "$line" ] && claude_flags+=("$line"); done < <(fh "$hooks/factory_roles" claude-flags "$role")
  fi
  # The shared Turborepo cache (#59), asked for before every task, so a cache that came up later is picked up and one
  # that went away is dropped. Prints nothing while turbo.api is empty; no token or no answer: local cache only, and
  # it says why. Never stops the loop.
  # Unattended runs (-p) get --permission-mode from the `permissionMode` setting (#179); interactive ones are not given one.
  headless_flags=()
  while IFS= read -r line; do [ -n "$line" ] && headless_flags+=("$line"); done < <(fh "$hooks/factory_roles" permission-flags)
  eval "$(fh "$hooks/factory_turbo" env)" || true
  # The `models` setting (factory_models.ts): --model and --effort for the role's session, and --agents for the
  # subagents whose model the project sets. No setting, no flags. A bad setting stops the loop with the reason.
  if [ -f "$hooks/factory_models.ts" ]; then
    local m
    m="$(fh "$hooks/factory_models" flags "$model_role" 2>&1)" || { echo "[$agent] $m"; exit 1; }
    while IFS= read -r line; do [ -n "$line" ] && claude_flags+=("$line"); done <<< "$m"
  fi
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

# Waits `$1` minutes, still registered as idle: a manager or a product owner that sleeps is not dead (the dev manager's
# sweep would otherwise mark it down). Ctrl-C stops it.
role_sleep() {
  local left
  left=$(bun --no-env-file --config=/dev/null -e 'console.log(Math.trunc(Number(process.argv[1]) * 60))' "$1")
  while [ "$left" -gt 0 ]; do
    fh "$hooks/factory_agents" ping --agent "$agent" --status idle >/dev/null 2>&1 || true
    local chunk=$((left < 300 ? left : 300))
    sleep "$chunk"; left=$((left - chunk))
  done
}

# One pass of a manager or a product owner. Returns 0 (it had work and did it), 3 (nothing to do) or 1 (it failed).
# When factory_roles.ts finds work, one fresh `claude -p` runs the role's skill (`claude` without -p under -i).
role_pass() {
  local found rc prompt discover=0
  if [ "$role_kind" = orchestrator ]; then
    # No model here: the orchestrator reads GitHub, posts to the owner queue and starts one-item sub-managers.
    fh "$hooks/factory_orchestrator" cycle --name "$agent" $([ "$interactive" = 1 ] && echo --interactive); rc=$?
    stty sane 2>/dev/null
    [ "$rc" = 0 ] || [ "$rc" = 3 ] || return 1
    return "$rc"
  fi
  found="$(fh "$hooks/factory_roles" work "$role" --name "$agent")"; rc=$?
  # A product owner started with -i and nothing queued is the start of a project: a discovery session (vision, design,
  # plan; #103) instead of "nothing to do". It runs once; the loop does not restart it when you /exit.
  if [ "$rc" = 3 ] && [ "$interactive" = 1 ] && [ "$role" = product-owner ]; then
    found="nothing queued: a discovery session"; rc=0; discover=1
  fi
  [ "$rc" = 3 ] && return 3
  [ "$rc" = 0 ] || { echo "[$agent] $found"; return 1; }
  item="$(printf '%s\n' "$found" | head -1)"
  if [ "$item" = "$last_item" ]; then repeats=$((repeats + 1)); else repeats=1; last_item="$item"; fi
  if [ "$repeats" -ge 3 ]; then
    echo "[$agent] '$item' came up 3 times in a row; stopping so a person can look."; exit 1
  fi
  echo "=== [$agent] $(date '+%H:%M') $role: $item ==="
  isolate
  prompt="$(fh "$hooks/factory_roles" prompt "$role" "$agent" $([ "$discover" = 1 ] && echo discover))"
  fh "$hooks/factory_agents" ping --agent "$agent" --status "$item" >/dev/null 2>&1 || true
  if [ "$interactive" = 1 ]; then
    if [ "${FACTORY_REMOTE_CONTROL:-1}" = 1 ]; then claude "${claude_flags[@]}" --remote-control="$agent" "$prompt"; else claude "${claude_flags[@]}" "$prompt"; fi
    rc=$?; stty sane 2>/dev/null
  else
    trust_gate || exit 1
    claude "${claude_flags[@]}" ${headless_flags[@]+"${headless_flags[@]}"} -p "$prompt"; rc=$?
  fi
  [ "$discover" = 0 ] || exit "$rc"
  [ "$rc" = 0 ] || return 1
  return 0
}

# An unattended run in a folder Claude Code does not trust ignores the whole allow list and stalls at its first command
# (#193), so say so before any tokens are spent. A folder it cannot judge (no ~/.claude.json) goes ahead.
trust_gate() {
  [ -f "$hooks/factory_trust.ts" ] || return 0
  local err
  err="$(fh "$hooks/factory_trust" check "$PWD")" || { echo "[$agent] $err"; return 1; }
}

# Issues mode (#192): when a run ends, the issues this agent claimed that have no pushed branch or pull request go back to
# ready on GitHub, and the loop prints which it released and which it kept. A failed or cancelled run leaves no claim.
give_back() {
  case "$1" in issue-*) ;; *) return 0 ;; esac
  local said
  if said=$(fh "$hooks/factory_issues" give-back --agent "$agent" 2>&1); then echo "$said" | sed "s/^/[$agent] /"
  else echo "[$agent] Could not give the claim back. Free it by hand: factory issues release ${1#issue-}"; fi
}

last=""; repeats=0; last_item=""; fails=0
for ((n = 1; n <= limit; n++)); do
  if [ "$resume_first" = 1 ]; then
    echo "[$agent] resuming after a restart: leaving $PWD as it is (branch $(git branch --show-current 2>/dev/null))."
    resume_first=0
  else
    tidy
  fi
  reload_if_changed $((limit - n + 1))
  if [ "$role" != coding-agent ]; then
    role_pass; rc=$?
    if [ "$rc" = 1 ]; then
      fails=$((fails + 1))
      echo "[$agent] (the pass exited with an error; the next one picks up from GitHub)"
      if [ "$fails" -ge 3 ]; then echo "[$agent] 3 passes failed in a row; stopping so a person can look."; exit 1; fi
    else fails=0; fi
    [ "$n" -lt "$limit" ] || break
    if [ "$rc" = 3 ]; then
      [ "$role_idle" != 0 ] || { echo "[$agent] Nothing to do; exiting (idleMinutes is 0)."; exit 0; }
      role_sleep "$role_idle"
    else role_sleep "$role_busy"; fi
    continue
  fi
  # Nothing to do: wait for work instead of exiting (`waitMinutes` in factory.json; 0 = exit as before). While it waits
  # the agent stays registered as idle, so the dev manager doesn't take it for dead. Ctrl-C stops it.
  waited=0
  until next=$(fh "$hooks/next_task" --claim "$agent" --pid $$); do
    task_rc=$?
    # --once is one pass: look once, say so and stop (a crash exits with its own code), never wait and poll.
    if [ "$once" = 1 ]; then
      if [ "$task_rc" = 1 ]; then echo "[$agent] Nothing ready (every task is done, blocked or taken); --once stops here."; exit 0; fi
      echo "[$agent] The task lookup failed (exit $task_rc); --once stops here." >&2; exit "$task_rc"
    fi
    [ "$wait_minutes" -gt 0 ] 2>/dev/null || {
      echo "[$agent] Nothing left for this loop: every task is done, blocked or taken by another loop."; exit 0; }
    [ "$waited" = 0 ] && echo "[$agent] $(date '+%H:%M') nothing ready (every task is done, blocked or taken). Checking again every $wait_minutes min; Ctrl-C stops."
    waited=1
    fh "$hooks/factory_agents" ping --agent "$agent" --status idle >/dev/null 2>&1 || true
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
  case "$id" in issue-*) echo "[$agent] claimed issue #${id#issue-} (this run claims this one only)" ;; esac
  isolate
  # The restart note (factory_resume.ts) goes into the first prompt only.
  prompt="/next-task $id"
  # The task's token budget and what it counts (#183), when it has one. Advice only: a failed lookup adds nothing.
  budget=""
  [ -f "$hooks/factory_budget.ts" ] && budget="$(fh "$hooks/factory_budget" prompt "$id" 2>/dev/null)" || budget=""
  [ -n "$budget" ] && prompt="$prompt"$'\n\n'"$budget"
  if [ -n "${FACTORY_RESUME_NOTE:-}" ] && [ -f "$FACTORY_RESUME_NOTE" ]; then
    prompt="$prompt"$'\n\n'"$(cat "$FACTORY_RESUME_NOTE")"
    rm -f "$FACTORY_RESUME_NOTE"; unset FACTORY_RESUME_NOTE
  fi
  if [ "$interactive" = 1 ]; then
    echo "[$agent] Talk to it as usual. When the task is done, the session closes by itself."
    fh "$hooks/factory_claims" take-done --agent "$agent" >/dev/null  # no stale mark from an earlier run
    # Remote Control (on by default; FACTORY_REMOTE_CONTROL=0 turns it off, or `factory settings --local set remoteControl
    # off` on this machine): the session also appears at claude.ai/code and in the Claude app, so you can watch it and
    # type into it (/exit included) from your phone.
    rc="${FACTORY_REMOTE_CONTROL:-}"; [ -n "$rc" ] || rc="$(fh "$hooks/factory_machine" remote 2>/dev/null || echo 1)"
    if [ "$rc" = 1 ]; then
      claude "${claude_flags[@]}" --remote-control="$agent $id" "$prompt" || true
    else
      claude "${claude_flags[@]}" "$prompt" || true
    fi
    stty sane 2>/dev/null
    fh "$hooks/factory_claims" release --agent "$agent" --tasks-only >/dev/null
    give_back "$id"
    finished="$(fh "$hooks/factory_claims" take-done --agent "$agent")"
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
    trust_gate || { fh "$hooks/factory_claims" release --agent "$agent" --tasks-only >/dev/null; give_back "$id"; exit 1; }
    claude "${claude_flags[@]}" ${headless_flags[@]+"${headless_flags[@]}"} -p "$prompt" || echo "[$agent] (the run for $id exited with an error; the next pass picks up from git)"
  fi
  fh "$hooks/factory_claims" release --agent "$agent" --tasks-only >/dev/null  # the pushed branch marks it now
  give_back "$id"
done
