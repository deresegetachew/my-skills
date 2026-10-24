#!/usr/bin/env bash
# factory ci: the project's CI, on GitHub's runners or on a self-hosted runner on this machine (README.md, "CI").
#
#   factory ci status              where CI runs (local or github), the latest runs, and the local runner
#   factory ci use local|github    sends CI jobs to the self-hosted runners, or back to GitHub's
#   factory ci install             installs the runner as a LaunchAgent (macOS) or a systemd --user service (Linux)
#   factory ci uninstall           removes it: the service, its containers and its idle registrations
#   factory ci start | stop        runs it once by hand, in the background, until stop or a restart
#   factory ci logs [-f]           the runner's log
#
# Every name comes from the project (ci_names.py): the runner is `<repo>-ci`, its jobs ask for the label
# `<repo>-local`, unless "ci" in .claude/factory.json says otherwise. Several machines can run runners with the
# same label; GitHub gives each job to one of them.
set -euo pipefail

# macOS runs the runner with launchd, Linux with systemd --user (#62). FACTORY_CI_PLATFORM=mac|linux overrides.
platform="${FACTORY_CI_PLATFORM:-}"
if [ -z "$platform" ]; then
  if [ "$(uname -s)" = Darwin ] || command -v launchctl >/dev/null 2>&1; then platform=mac; else platform=linux; fi
fi
export FACTORY_CI_PLATFORM="$platform"
if [ "$platform" = linux ]; then machine="this machine"; manager=systemd; else machine="this Mac"; manager=launchd; fi

kit="$(cd "$(dirname "$0")" && pwd)"
root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$root"
eval "$(python3 "$kit/ci_names.py")"
domain="gui/$(id -u)"
exe="$CI_INSTALLED/$CI_NAME"
# Which machine a runner is on, in its name (<name>-<host>-<epoch>), so `stop` removes only this machine's.
host="$( (scutil --get LocalHostName 2>/dev/null || hostname -s 2>/dev/null || echo mac) | tr '[:upper:]' '[:lower:]' |
  tr -c 'a-z0-9-\n' '-' | head -c 24)"
host="${host:-$platform}"
compose=(docker compose --file "$kit/compose.yaml" --project-name "$CI_NAME")

die() { echo "factory ci: $*" >&2; exit 1; }

need() {
  for tool in "$@"; do
    command -v "$tool" >/dev/null || die "$tool isn't installed or isn't on your PATH."
  done
}

# Installed and managed: a loaded LaunchAgent (macOS), or an enabled user unit (Linux, always this project's unit).
agent_loaded() {
  if [ "$platform" = linux ]; then systemctl --user is-enabled --quiet "$CI_UNIT" 2>/dev/null; return; fi
  launchctl print "$domain/$1" >/dev/null 2>&1
}

# The loop started by `factory ci start` is `/bin/bash <installed>/<name>`. Anything else with that pid
# (a reused pid) is left alone.
is_loop() {
  [ -n "${1:-}" ] || return 1
  [ "$(ps -p "$1" -o command= 2>/dev/null | sed 's/[[:space:]]*$//')" = "/bin/bash $exe" ]
}

hand_pid() {
  local pid
  pid="$(cat "$CI_STATE/pid" 2>/dev/null || true)"
  is_loop "$pid" && echo "$pid"
}

can_register() {
  gh api -X POST "repos/$CI_REPO/actions/runners/registration-token" --jq .token >/dev/null 2>&1
}

wait_unloaded() {
  [ "$platform" = linux ] && return 0
  for _ in $(seq 1 30); do
    agent_loaded "$1" || return 0
    sleep 1
  done
}

# The runner's files go to a private copy; launchd (and `start`) run that copy, never this checkout, which
# may later hold an unreviewed branch.
copy_files() {
  mkdir -p "$CI_STATE" "$CI_INSTALLED"
  chmod 700 "$CI_STATE" "$CI_INSTALLED"
  install -m 700 "$kit/loop.sh" "$exe"
  install -m 600 "$kit/compose.yaml" "$CI_INSTALLED/compose.yaml"
  install -m 600 "$kit/entrypoint.sh" "$CI_INSTALLED/entrypoint.sh"
}

on_main_note() {
  local commit
  commit="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  if ! git fetch --quiet origin main 2>/dev/null || ! git merge-base --is-ancestor HEAD origin/main 2>/dev/null; then
    echo "Note: commit $commit isn't on origin/main. Run this from a checkout on main to install the reviewed runner."
  fi
  echo "$commit" >"$CI_STATE/commit"
}

# Rootless Docker on Linux: the daemon is the user's, at $XDG_RUNTIME_DIR/docker.sock. systemd starts the
# service without the login shell's DOCKER_HOST, so the unit gets it: the shell's value, else the current docker
# context's, else the rootless socket when there is one. Empty: Docker's default socket.
docker_host() {
  local h="${DOCKER_HOST:-}"
  [ -n "$h" ] || h="$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null || true)"
  case "$h" in unix:///var/run/docker.sock) h="" ;; esac
  if [ -z "$h" ] && [ -n "${XDG_RUNTIME_DIR:-}" ] && [ -e "$XDG_RUNTIME_DIR/docker.sock" ]; then
    h="unix://$XDG_RUNTIME_DIR/docker.sock"
  fi
  echo "$h"
}

# A value for systemd's Environment="KEY=value": quotes and backslashes escaped, % doubled.
sd() { local v="${1//\\/\\\\}"; v="${v//\"/\\\"}"; printf '%s' "${v//%/%%}"; }

# A path systemd takes as it is (WorkingDirectory=, append:): only % (a specifier) needs doubling.
sd_path() { printf '%s' "${1//%/%%}"; }
# In ExecStart= systemd also expands $VAR, so $ is doubled too.
sd_exec() { local v; v="$(sd "$1")"; printf '%s' "${v//\$/\$\$}"; }

# `systemctl --user` needs this user's systemd instance and its session bus. Logged in with `sudo -iu ci` or
# `su - ci`, or over SSH before linger is on, there is none: stop before changing anything, and say how to get one.
need_user_manager() {
  systemctl --user show-environment >/dev/null 2>&1 && return 0
  local u; u="$(id -un)"
  die "systemd's user manager for $u isn't reachable (\`systemctl --user\` can't connect to its bus), so this shell can't
manage the runner's service. Nothing was changed. Either log in as $u directly
(ssh $u@<host>, or \`machinectl shell $u@\`), or run \`sudo loginctl enable-linger $u\` and then
\`export XDG_RUNTIME_DIR=/run/user/$(id -u)\` in this shell, and try again."
}

write_unit() {
  local path="" dir tool dh
  for tool in gh docker; do
    dir="$(dirname "$(command -v "$tool")")"
    case "$dir" in /*) path="$path$dir:" ;; esac
  done
  path="$path/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin"
  dh="$(docker_host)"
  mkdir -p "$(dirname "$CI_UNIT_FILE")" "$CI_STATE"
  {
    echo "[Unit]"
    echo "Description=$CI_NAME: self-hosted GitHub Actions runner for $CI_REPO (software factory)"
    echo
    echo "[Service]"
    echo "ExecStart=/bin/bash \"$(sd_exec "$exe")\""
    echo "WorkingDirectory=$(sd_path "$CI_INSTALLED")"
    for kv in "PATH=$path" "CI_NAME=$CI_NAME" "CI_LABEL=$CI_LABEL" "CI_HOST=$host" "CI_STATE=$CI_STATE" \
              "RUNNER_REPO=$CI_REPO" ${dh:+"DOCKER_HOST=$dh"}; do
      echo "Environment=\"$(sd "$kv")\""
    done
    echo "Restart=always"
    echo "RestartSec=30"
    echo "StandardOutput=append:$(sd_path "$CI_STATE/runner.log")"
    echo "StandardError=append:$(sd_path "$CI_STATE/runner.log")"
    echo
    echo "[Install]"
    echo "WantedBy=default.target"
  } >"$CI_UNIT_FILE.tmp"
  mv "$CI_UNIT_FILE.tmp" "$CI_UNIT_FILE"
}

# Without linger, systemd stops a user's services when the user logs out (and doesn't start them at boot).
linger_note() {
  local on
  on="$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || true)"
  if [ "$on" != yes ]; then
    echo "Note: linger is off for $(id -un), so the runner stops when you log out and doesn't start at boot."
    echo "  Turn it on once: sudo loginctl enable-linger $(id -un)"
  fi
}

install_linux() {
  need gh docker systemctl
  need_user_manager
  can_register || die "gh can't create a runner registration token for $CI_REPO. Log in with \`gh auth login\` as an admin of the repository, then run this again."
  if [ -n "$(hand_pid || true)" ]; then
    echo "Stopping the runner started with \`factory ci start\` first..."
  fi
  stop_hand_loop
  copy_files
  on_main_note
  if docker info >/dev/null 2>&1; then
    echo "Pulling the runner images..."
    RUNNER_REPO="$CI_REPO" RUNNER_NAME=none RUNNER_LABEL="$CI_LABEL" \
      docker compose --file "$CI_INSTALLED/compose.yaml" --project-name "$CI_NAME" pull --quiet
  fi
  write_unit
  # enable, then restart: starts it the first time, and replaces a loop that's already running after an update.
  systemctl --user daemon-reload
  systemctl --user enable "$CI_UNIT" >/dev/null 2>&1
  systemctl --user restart "$CI_UNIT"
  echo "Installed $CI_NAME (commit $(cat "$CI_STATE/commit")): systemd runs it as the user service $CI_UNIT."
  echo "Repository $CI_REPO, label $CI_LABEL. Log: $CI_STATE/runner.log"
  linger_note
  echo "Jobs go to it after \`factory ci use local\`. Check it with \`factory ci status\`."
}

# Removes registrations GitHub still lists: this Mac's idle ones (after a stop, GitHub shows them online for
# a minute or so, so not-busy is the test), and any of this project's that are offline and idle (left by a
# Mac that went away). Another Mac's online runners are left alone.
remove_registrations() {
  local ids
  ids="$(gh api "repos/$CI_REPO/actions/runners?per_page=100" --jq ".runners[] | select((.busy | not) and
    ((.name | startswith(\"$CI_NAME-$host-\")) or ((.name | startswith(\"$CI_NAME-\")) and .status == \"offline\")))
    | .id" 2>/dev/null)" || return 0
  for id in $ids; do
    gh api -X DELETE "repos/$CI_REPO/actions/runners/$id" >/dev/null && echo "Removed runner registration $id."
  done
}

down() {
  if docker info >/dev/null 2>&1; then
    RUNNER_REPO="$CI_REPO" RUNNER_NAME=none RUNNER_LABEL="$CI_LABEL" \
      "${compose[@]}" down --volumes --remove-orphans --timeout 10 >/dev/null 2>&1 || true
  fi
}

stop_hand_loop() {
  local pid
  pid="$(hand_pid || true)"
  if [ -n "$pid" ]; then
    kill "$pid"
    for _ in $(seq 1 30); do
      ps -p "$pid" >/dev/null 2>&1 || break
      sleep 1
    done
  fi
  rm -f "$CI_STATE/pid"
}

xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }

write_plist() {
  # launchd starts with a short PATH. Only absolute directories: a relative one would resolve against the
  # working directory.
  local path="" dir tool
  for tool in gh docker; do
    dir="$(dirname "$(command -v "$tool")")"
    case "$dir" in /*) path="$path$dir:" ;; esac
  done
  path="$path/opt/homebrew/bin:/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  mkdir -p "$(dirname "$CI_PLIST")"
  cat >"$CI_PLIST.tmp" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml "$CI_AGENT")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$exe")</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$(xml "$CI_INSTALLED")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(xml "$path")</string>
    <key>CI_NAME</key>
    <string>$(xml "$CI_NAME")</string>
    <key>CI_LABEL</key>
    <string>$(xml "$CI_LABEL")</string>
    <key>CI_HOST</key>
    <string>$(xml "$host")</string>
    <key>CI_STATE</key>
    <string>$(xml "$CI_STATE")</string>
    <key>RUNNER_REPO</key>
    <string>$(xml "$CI_REPO")</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>$(xml "$CI_STATE/runner.log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml "$CI_STATE/runner.log")</string>
</dict>
</plist>
EOF
  plutil -lint "$CI_PLIST.tmp" >/dev/null || { rm -f "$CI_PLIST.tmp"; die "the LaunchAgent file didn't pass plutil -lint."; }
  mv "$CI_PLIST.tmp" "$CI_PLIST"
}

# CI_RUNS_ON: prints the value; exit 0 set, 1 not set, 2 can't tell.
runs_on() {
  local out err
  err="$(mktemp)"
  if out="$(gh api "repos/$CI_REPO/actions/variables/CI_RUNS_ON" --jq .value 2>"$err")"; then
    rm -f "$err"; echo "$out"; return 0
  fi
  if grep -q '404' "$err"; then rm -f "$err"; return 1; fi
  rm -f "$err"; return 2
}

cmd_install() {
  if [ "$platform" = linux ]; then install_linux; return; fi
  need gh docker launchctl plutil
  can_register || die "gh can't create a runner registration token for $CI_REPO. Log in with \`gh auth login\` as an admin of the repository, then run this again."
  # An older install under another name would compete for the same jobs: unload it and remove its file.
  for old in $CI_REPLACES; do
    if agent_loaded "$old" || [ -f "$HOME/Library/LaunchAgents/$old.plist" ]; then
      echo "Removing the older LaunchAgent $old..."
      launchctl bootout "$domain/$old" 2>/dev/null || true
      wait_unloaded "$old"
      rm -f "$HOME/Library/LaunchAgents/$old.plist"
    fi
  done
  if [ -n "$(hand_pid || true)" ]; then
    echo "Stopping the runner started with \`factory ci start\` first..."
  fi
  stop_hand_loop
  copy_files
  on_main_note
  if docker info >/dev/null 2>&1; then
    echo "Pulling the runner images..."
    RUNNER_REPO="$CI_REPO" RUNNER_NAME=none RUNNER_LABEL="$CI_LABEL" \
      docker compose --file "$CI_INSTALLED/compose.yaml" --project-name "$CI_NAME" pull --quiet
  fi
  write_plist
  # Unload the old one first (its loop removes its containers), then load the new one. bootout returns
  # before launchd has let go, and bootstrap fails (error 5) until it has.
  launchctl bootout "$domain/$CI_AGENT" 2>/dev/null || true
  wait_unloaded "$CI_AGENT"
  launchctl bootstrap "$domain" "$CI_PLIST"
  echo "Installed $CI_NAME (commit $(cat "$CI_STATE/commit")): launchd runs it whenever you're logged in."
  echo "Repository $CI_REPO, label $CI_LABEL. Log: $CI_STATE/runner.log"
  echo "Jobs go to it after \`factory ci use local\`. Check it with \`factory ci status\`."
}

cmd_uninstall() {
  if [ "$platform" = linux ]; then
    need systemctl
    need_user_manager
    systemctl --user disable --now "$CI_UNIT" >/dev/null 2>&1 || true
    rm -f "$CI_UNIT_FILE"
    systemctl --user daemon-reload 2>/dev/null || true
    rm -rf "$CI_INSTALLED"
    echo "User service $CI_UNIT removed."
    cmd_stop
    return
  fi
  need launchctl
  launchctl bootout "$domain/$CI_AGENT" 2>/dev/null || true
  wait_unloaded "$CI_AGENT"
  rm -f "$CI_PLIST"
  rm -rf "$CI_INSTALLED"
  echo "LaunchAgent $CI_AGENT removed."
  cmd_stop
}

cmd_start() {
  need gh docker
  if agent_loaded "$CI_AGENT"; then
    echo "$CI_NAME is installed and $manager keeps it running (factory ci status). Nothing to start."
    return 0
  fi
  if pid="$(hand_pid)"; then
    echo "$CI_NAME is already running (pid $pid). Stop it with \`factory ci stop\`."
    return 0
  fi
  docker info >/dev/null 2>&1 || die "Docker isn't running. Start Docker$([ "$platform" = mac ] && echo " Desktop"), then run this again."
  local token="${RUNNER_TOKEN:-}"
  unset RUNNER_TOKEN
  if [ -z "$token" ]; then
    if can_register; then
      echo "Using your gh login to create a registration token for each job."
    else
      # -s: the token isn't echoed to the terminal.
      read -r -s -p "Registration token (repo Settings > Actions > Runners > New self-hosted runner): " token
      echo
      [ -n "$token" ] || die "no token given."
    fi
  fi
  copy_files
  on_main_note
  echo "Pulling the runner images..."
  RUNNER_REPO="$CI_REPO" RUNNER_NAME=none RUNNER_LABEL="$CI_LABEL" \
    docker compose --file "$CI_INSTALLED/compose.yaml" --project-name "$CI_NAME" pull --quiet
  # The token reaches the loop on its stdin: not in its arguments (`ps` shows them) or its environment
  # (macOS `ps -E` shows that for the process's whole life).
  printf '%s\n' "$token" | CI_NAME="$CI_NAME" CI_LABEL="$CI_LABEL" CI_HOST="$host" CI_STATE="$CI_STATE" \
    RUNNER_REPO="$CI_REPO" nohup /bin/bash "$exe" >>"$CI_STATE/runner.log" 2>&1 &
  echo $! >"$CI_STATE/pid"
  token=""
  echo "$CI_NAME started (pid $(cat "$CI_STATE/pid")), label $CI_LABEL, repository $CI_REPO."
  echo "Log: $CI_STATE/runner.log. Jobs go to it after \`factory ci use local\`."
}

cmd_stop() {
  if [ "$platform" = linux ]; then need systemctl; need_user_manager; fi
  if agent_loaded "$CI_AGENT"; then
    die "$CI_NAME is installed, so $manager would start it again. Remove it with \`factory ci uninstall\`."
  fi
  stop_hand_loop
  down
  remove_registrations
  echo "$CI_NAME stopped."
}

cmd_logs() {
  local file="$CI_STATE/runner.log"
  [ -f "$file" ] || { echo "No log yet ($file)."; return 0; }
  if [ "${1:-}" = "-f" ]; then exec tail -n 50 -f "$file"; fi
  tail -n 50 "$file"
}

cmd_use() {
  need gh
  case "${1:-}" in
    local)
      gh variable set CI_RUNS_ON --repo "$CI_REPO" --body "[\"self-hosted\",\"$CI_LABEL\"]" >/dev/null ||
        die "gh can't set the repository variable CI_RUNS_ON (it needs admin on $CI_REPO)."
      echo "CI now runs on self-hosted runners with the label $CI_LABEL. Pull requests from forks stay on GitHub."
      if ! agent_loaded "$CI_AGENT" && [ -z "$(hand_pid || true)" ]; then
        echo "No runner is running on $machine: jobs wait until one is (\`factory ci install\`)."
      fi
      ;;
    github)
      local rc=0
      runs_on >/dev/null || rc=$?
      if [ "$rc" -eq 1 ]; then
        echo "CI already runs on GitHub's runners (CI_RUNS_ON isn't set)."
        return 0
      fi
      gh variable delete CI_RUNS_ON --repo "$CI_REPO" >/dev/null ||
        die "gh can't delete the repository variable CI_RUNS_ON (it needs admin on $CI_REPO)."
      echo "CI now runs on GitHub's runners. A local runner, if installed, stays idle until \`factory ci use local\`."
      ;;
    *) die "say where: \`factory ci use local\` or \`factory ci use github\`." ;;
  esac
}

cmd_status() {
  need gh
  if [ "$platform" = linux ]; then need systemctl; need_user_manager; fi
  local value rc=0 local_mode=""
  value="$(runs_on)" || rc=$?
  case "$rc" in
    0) echo "Mode: local (CI_RUNS_ON is $value)"; local_mode=1
       case "$value" in *"\"$CI_LABEL\""*) ;; *) echo "  Note: that doesn't ask for this project's label $CI_LABEL." ;; esac ;;
    1) echo "Mode: github (CI_RUNS_ON isn't set, so CI runs on GitHub's runners)" ;;
    *) echo "Mode: unknown (gh can't read the repository variable CI_RUNS_ON; it needs admin on $CI_REPO)" ;;
  esac
  local installed=""
  agent_loaded "$CI_AGENT" && installed=1
  if [ -n "$local_mode" ] || [ -n "$installed" ] || [ -n "$(hand_pid || true)" ]; then
    local pid
    if [ -n "$installed" ] && [ "$platform" = linux ]; then
      pid="$(systemctl --user show "$CI_UNIT" -p MainPID --value 2>/dev/null || true)"
      if [ -n "$pid" ] && [ "$pid" != 0 ]; then
        echo "Runner $CI_NAME: running (systemd user service $CI_UNIT, pid $pid). It starts again by itself after a restart."
      else
        echo "Runner $CI_NAME: installed, but its loop isn't running right now; systemd starts it again within 30 s."
      fi
    elif [ -n "$installed" ]; then
      pid="$(launchctl print "$domain/$CI_AGENT" 2>/dev/null | awk '$1 == "pid" && $2 == "=" { print $3; exit }')"
      if [ -n "$pid" ]; then
        echo "Runner $CI_NAME: running (LaunchAgent $CI_AGENT, pid $pid). It starts again by itself after a restart."
      else
        echo "Runner $CI_NAME: installed, but its loop isn't running right now; launchd starts it again within 30 s."
      fi
    elif [ "$platform" = mac ] && [ -f "$CI_PLIST" ]; then
      echo "Runner $CI_NAME: installed but not loaded. Run \`factory ci install\` again."
    elif pid="$(hand_pid)"; then
      echo "Runner $CI_NAME: running (started by hand, pid $pid). It stops at a restart; \`factory ci install\` keeps it running."
    else
      echo "Runner $CI_NAME: not running on $machine. \`factory ci install\` starts it (another machine may run one)."
    fi
    if docker info >/dev/null 2>&1; then
      echo "Docker: running"
    else
      echo "Docker: not running. Jobs for $machine wait in GitHub's queue until it is."
    fi
  fi
  python3 "$kit/ci_status.py" --repo "$CI_REPO" --label "$CI_LABEL" ${local_mode:+--local}
  if [ -n "$local_mode$installed" ] && [ -f "$CI_STATE/runner.log" ]; then
    echo
    echo "Last log lines ($CI_STATE/runner.log):"
    tail -n 8 "$CI_STATE/runner.log"
  fi
}

case "${1:-status}" in
  status) cmd_status ;;
  use) shift; cmd_use "$@" ;;
  install) cmd_install ;;
  uninstall) cmd_uninstall ;;
  start) cmd_start ;;
  stop) cmd_stop ;;
  logs) shift; cmd_logs "$@" ;;
  names) for v in CI_REPO CI_NAME CI_LABEL CI_AGENT CI_PLIST CI_INSTALLED CI_STATE CI_REPLACES CI_UNIT CI_UNIT_FILE; do
      echo "$v=${!v}"
    done
    echo "CI_HOST=$host" ;;
  *) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
