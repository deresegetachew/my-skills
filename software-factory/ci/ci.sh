#!/usr/bin/env bash
# factory ci: the project's CI, on GitHub's runners or on a self-hosted runner on this machine (README.md, "CI").
#
#   factory ci status              where CI runs (local or github), the latest runs, and the local runner
#   factory ci use local|github    sends CI jobs to the self-hosted runners, or back to GitHub's
#   factory ci install             installs the runners: ci.runners heavy ones and the light lane, each a LaunchAgent
#                                  (macOS) or a systemd --user service (Linux); run it again to update or rescale
#   factory ci uninstall [i]       removes them (or instance i: 2, 3 ... or light), their containers and idle registrations
#   factory ci start | stop        runs one by hand, in the background, until stop or a restart
#   factory ci logs [i] [-f]       a runner's log (instance 1 unless you name one)
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

# Instances (#67, #90): heavy runners 1 .. ci.runners, each with its own compose project (its dind, volumes and
# workspace), registration names and log, and unless ci.light is false the light lane: one small runner without
# Docker, label <repo>-light, for the Factory guard. Instance 1 keeps the single runner's names, so an existing
# install carries on; instance N adds "-N" and the light lane "-light" to them.
wanted_ids() { seq 1 "$CI_RUNNERS"; [ "$CI_LIGHT" = 1 ] && echo light; return 0; }
valid_id() { case "$1" in light|[1-9]|1[0-6]) return 0 ;; esac; return 1; }
use_instance() {
  local sfx=""
  [ "$1" = 1 ] || sfx="-$1"
  I_ID="$1"
  I_NAME="$CI_NAME$sfx"
  I_AGENT="$CI_AGENT$sfx"
  I_PLIST="$(dirname "$CI_PLIST")/$I_AGENT.plist"
  I_UNIT="$CI_NAME$sfx.service"
  I_UNIT_FILE="$(dirname "$CI_UNIT_FILE")/$I_UNIT"
  I_PROJECT="$CI_NAME$sfx"
  # A dot before the instance, which a host name here never has (it is made of a-z, 0-9 and -): instance 2 on
  # `foo` is <name>-foo.2-..., never the same as instance 1 on a machine called `foo-2` (<name>-foo-2-...).
  I_PREFIX="$CI_NAME-$host${sfx/#-/.}"
  I_LOG="$CI_STATE/runner$sfx.log"
  if [ "$1" = light ]; then I_COMPOSE=compose-light.yaml; I_LABEL="$CI_LIGHT_LABEL"; I_CACHES=0; I_IMAGE=""
  else I_COMPOSE=compose.yaml; I_LABEL="$CI_LABEL"; I_CACHES="$CI_CACHES"; I_IMAGE="${RUNNER_IMAGE_BUILT:-}"; fi
}

# The versions runner.Dockerfile bakes in, from this checkout: Node from .nvmrc, pnpm from package.json's
# packageManager, Playwright from node_modules or the lockfile. Prints three lines (each may be empty).
tool_versions() {
  python3 - <<'PY'
import json, os, re
node = ""
if os.path.exists(".nvmrc"):
    v = open(".nvmrc").read().strip()
    node = v if re.fullmatch(r"v?\d+(\.\d+){0,2}", v) else ""
pnpm = ""
try:
    m = re.fullmatch(r"pnpm@(\d+\.\d+\.\d+)(\+.*)?", json.load(open("package.json")).get("packageManager", ""))
    pnpm = m.group(1) if m else ""
except (OSError, ValueError):
    pass
pw = ""
try:
    pw = json.load(open("node_modules/@playwright/test/package.json"))["version"]
except (OSError, ValueError, KeyError):
    try:
        m = re.search(r"@playwright/test@(\d+\.\d+\.\d+)", open("pnpm-lock.yaml").read())
        pw = m.group(1) if m else ""
    except OSError:
        pass
print(node); print(pnpm); print(pw)
PY
}

# The image is built from the checkout at install time. When main has moved Node, pnpm or Playwright since, say so.
image_note() {
  [ "$CI_IMAGE" = build ] || return 0
  local built node pnpm pw want
  built="$(docker image inspect --format 'node={{index .Config.Labels "factory.node"}} pnpm={{index .Config.Labels "factory.pnpm"}} playwright={{index .Config.Labels "factory.playwright"}}' "$CI_NAME-runner:latest" 2>/dev/null)" || return 0
  [ -n "$built" ] || return 0
  { read -r node; read -r pnpm; read -r pw; } < <(tool_versions)
  want="node=$node pnpm=$pnpm playwright=$pw"
  if [ "$built" != "$want" ]; then
    echo "Runner image: built for $built, and this checkout wants $want. Run \`factory ci install\` to rebuild it."
  fi
}

# Builds the heavy runners' image (ci.image "build"). On failure it says so and they use GitHub's plain image.
build_image() {
  RUNNER_IMAGE_BUILT=""
  [ "$CI_IMAGE" = build ] || return 0
  docker info >/dev/null 2>&1 || { echo "Docker isn't running, so the runner image isn't built; the runners use GitHub's."; return 0; }
  local node pnpm pw tag="$CI_NAME-runner:latest"
  { read -r node; read -r pnpm; read -r pw; } < <(tool_versions)
  echo "Building the runner image $tag (Node ${node:-none}, pnpm ${pnpm:-none}, Playwright ${pw:-none})..."
  if docker build --quiet --tag "$tag" --file "$CI_INSTALLED/runner.Dockerfile" \
      --build-arg "NODE_VERSION=$node" --build-arg "PNPM_VERSION=$pnpm" --build-arg "PLAYWRIGHT_VERSION=$pw" \
      "$CI_INSTALLED" >/dev/null; then
    RUNNER_IMAGE_BUILT="$tag"
  else
    echo "Warning: the runner image didn't build; the runners use GitHub's plain image (jobs download their tools)."
  fi
}
# The instances installed on this machine, from their LaunchAgent or unit files.
installed_ids() {
  local dir base ext f b id
  if [ "$platform" = linux ]; then dir="$(dirname "$CI_UNIT_FILE")"; base="$CI_NAME"; ext=.service
  else dir="$(dirname "$CI_PLIST")"; base="$CI_AGENT"; ext=.plist; fi
  [ -d "$dir" ] || return 0
  for f in "$dir"/*"$ext"; do
    [ -e "$f" ] || continue
    b="$(basename "$f")"
    if [ "$b" = "$base$ext" ]; then echo 1; continue; fi
    case "$b" in "$base-"*"$ext") id="${b#"$base-"}"; id="${id%"$ext"}"; valid_id "$id" && [ "$id" != 1 ] && echo "$id" ;; esac
  done
  return 0
}
instance_loaded() {
  use_instance "$1"
  if [ "$platform" = linux ]; then systemctl --user is-enabled --quiet "$I_UNIT" 2>/dev/null; return; fi
  launchctl print "$domain/$I_AGENT" >/dev/null 2>&1
}
any_loaded() {
  local id
  for id in $(installed_ids); do instance_loaded "$id" && return 0; done
  return 1
}

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
  install -m 600 "$kit/compose-light.yaml" "$CI_INSTALLED/compose-light.yaml"
  install -m 600 "$kit/compose-caches.yaml" "$CI_INSTALLED/compose-caches.yaml"
  install -m 600 "$kit/runner.Dockerfile" "$CI_INSTALLED/runner.Dockerfile"
  install -m 600 "$kit/install-tools.sh" "$CI_INSTALLED/install-tools.sh"
  # 0644, not 0600: the runner container's user (uid 1001) is not whoever installed, and bash must read this file
  # there (a 0600 copy gave "Permission denied", exit 126). It holds no secret: the registration token only ever
  # comes in the environment. The folder around it is 0700, so no other user on the machine can reach it.
  install -m 644 "$kit/entrypoint.sh" "$CI_INSTALLED/entrypoint.sh"
  # The same for every other file a compose file mounts into a container (`- ./file:/path:ro`): copied, and readable
  # by the container's user, so a mount added to a compose file later cannot be left out or left at 0600 (#111's class).
  local mounted
  for mounted in $(sed -n 's#^[[:space:]]*-[[:space:]]*\./\([^:[:space:]]*\):.*#\1#p' "$kit"/compose*.yaml | sort -u); do
    [ -f "$kit/$mounted" ] || die "a compose file mounts $mounted, which is not in $kit."
    install -m 644 "$kit/$mounted" "$CI_INSTALLED/$mounted"
  done
  return 0
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
  mkdir -p "$(dirname "$I_UNIT_FILE")" "$CI_STATE"
  {
    echo "[Unit]"
    echo "Description=$I_NAME: self-hosted GitHub Actions runner for $CI_REPO, label $I_LABEL (software factory)"
    echo
    echo "[Service]"
    echo "ExecStart=/bin/bash \"$(sd_exec "$exe")\""
    echo "WorkingDirectory=$(sd_path "$CI_INSTALLED")"
    for kv in "PATH=$path" "CI_NAME=$CI_NAME" "CI_LABEL=$I_LABEL" "CI_HOST=$host" "CI_STATE=$CI_STATE" \
              "RUNNER_REPO=$CI_REPO" "CI_PROJECT=$I_PROJECT" "CI_RUNNER_PREFIX=$I_PREFIX" "CI_COMPOSE=$I_COMPOSE" \
              "CI_LOG=$I_LOG" "CI_CACHES=$I_CACHES" ${I_IMAGE:+"RUNNER_IMAGE=$I_IMAGE"} ${dh:+"DOCKER_HOST=$dh"}; do
      echo "Environment=\"$(sd "$kv")\""
    done
    echo "Restart=always"
    echo "RestartSec=30"
    echo "StandardOutput=append:$(sd_path "$I_LOG")"
    echo "StandardError=append:$(sd_path "$I_LOG")"
    echo
    echo "[Install]"
    echo "WantedBy=default.target"
  } >"$I_UNIT_FILE.tmp"
  mv "$I_UNIT_FILE.tmp" "$I_UNIT_FILE"
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


# Removes registrations GitHub still lists: this Mac's idle ones (after a stop, GitHub shows them online for
# a minute or so, so not-busy is the test), and any of this project's that are offline and idle (left by a
# Mac that went away). Another Mac's online runners are left alone.
remove_registrations() {
  local ids
  ids="$(gh api "repos/$CI_REPO/actions/runners?per_page=100" --jq ".runners[] | select((.busy | not) and
    ((.name | startswith(\"$CI_NAME-$host-\")) or (.name | startswith(\"$CI_NAME-$host.\")) or
     ((.name | startswith(\"$CI_NAME-\")) and .status == \"offline\")))
    | .id" 2>/dev/null)" || return 0
  for id in $ids; do
    gh api -X DELETE "repos/$CI_REPO/actions/runners/$id" >/dev/null && echo "Removed runner registration $id."
  done
}

down() {
  docker info >/dev/null 2>&1 || return 0
  local id
  for id in $( { wanted_ids; installed_ids; } | sort -u); do
    use_instance "$id"
    RUNNER_REPO="$CI_REPO" RUNNER_NAME=none RUNNER_LABEL="$I_LABEL" \
      docker compose --file "$kit/$I_COMPOSE" --project-name "$I_PROJECT" down --volumes --remove-orphans \
      --timeout 10 >/dev/null 2>&1 || true
  done
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
  mkdir -p "$(dirname "$I_PLIST")"
  cat >"$I_PLIST.tmp" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml "$I_AGENT")</string>
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
    <string>$(xml "$I_LABEL")</string>
    <key>CI_HOST</key>
    <string>$(xml "$host")</string>
    <key>CI_STATE</key>
    <string>$(xml "$CI_STATE")</string>
    <key>RUNNER_REPO</key>
    <string>$(xml "$CI_REPO")</string>
    <key>CI_PROJECT</key>
    <string>$(xml "$I_PROJECT")</string>
    <key>CI_RUNNER_PREFIX</key>
    <string>$(xml "$I_PREFIX")</string>
    <key>CI_COMPOSE</key>
    <string>$(xml "$I_COMPOSE")</string>
    <key>CI_LOG</key>
    <string>$(xml "$I_LOG")</string>
    <key>CI_CACHES</key>
    <string>$(xml "$I_CACHES")</string>
    <key>RUNNER_IMAGE</key>
    <string>$(xml "$I_IMAGE")</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>$(xml "$I_LOG")</string>
  <key>StandardErrorPath</key>
  <string>$(xml "$I_LOG")</string>
</dict>
</plist>
EOF
  plutil -lint "$I_PLIST.tmp" >/dev/null || { rm -f "$I_PLIST.tmp"; die "the LaunchAgent file didn't pass plutil -lint."; }
  mv "$I_PLIST.tmp" "$I_PLIST"
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

# This machine's memory left for jobs, in MB (FACTORY_CI_FREE_MB overrides it); empty when it can't tell.
free_mb() {
  if [ -n "${FACTORY_CI_FREE_MB:-}" ]; then echo "$FACTORY_CI_FREE_MB"; return; fi
  if [ -r /proc/meminfo ]; then awk '/^MemAvailable:/ { print int($2 / 1024); exit }' /proc/meminfo; return; fi
  vm_stat 2>/dev/null | awk '/page size of/ { size = $8 } /^Pages (free|inactive|speculative)/ { gsub(/\./, "", $NF); n += $NF }
    END { if (size) print int(n * size / 1048576) }'
}

# A rough budget per runner (README.md, "How many runners"): a heavy job with its dind and service containers,
# and the light runner's 1 GB limit.
HEAVY_MB=4096
LIGHT_MB=1024
budget_mb() { if [ "$1" = light ]; then echo "$LIGHT_MB"; else echo "$HEAVY_MB"; fi; }
memory_note() {
  local need free where id total
  need=$((CI_RUNNERS * HEAVY_MB + (CI_LIGHT == 1 ? LIGHT_MB : 0)))
  if [ "$platform" = mac ] && [ -z "${FACTORY_CI_FREE_MB:-}" ]; then
    # On a Mac the jobs run in Docker Desktop's VM, so its memory is the limit, not the Mac's.
    total="$(docker info --format '{{.MemTotal}}' 2>/dev/null || true)"
    case "$total" in ''|*[!0-9]*) return 0 ;; esac
    free=$((total / 1048576))
    where="Docker Desktop's VM has about $free MB"
  else
    free="$(free_mb || true)"
    case "$free" in ''|*[!0-9]*) return 0 ;; esac
    # Instances already running hold their memory now; only the new ones need free memory.
    for id in $(installed_ids); do
      case " $(wanted_ids | tr '\n' ' ')" in *" $id "*) instance_loaded "$id" && free=$((free + $(budget_mb "$id"))) ;; esac
    done
    where="$machine has about $free MB free (counting what its running runners already use)"
  fi
  if [ "$need" -gt "$free" ]; then
    echo "Warning: $CI_RUNNERS heavy runner(s)$([ "$CI_LIGHT" = 1 ] && echo " and the light one") need about $need MB at once,"
    echo "  and $where. Jobs may slow down or fail; lower ci.runners (or FACTORY_CI_RUNNERS)."
  fi
}

# Idle registrations of one instance on this machine (its names start with <prefix>-): removed after a scale-down.
remove_instance_registrations() {
  local ids
  ids="$(gh api "repos/$CI_REPO/actions/runners?per_page=100" --jq ".runners[] | select((.busy | not) and
    (.name | startswith(\"$1-\"))) | .id" 2>/dev/null)" || return 0
  for id in $ids; do
    gh api -X DELETE "repos/$CI_REPO/actions/runners/$id" >/dev/null && echo "Removed runner registration $id."
  done
}

# 0: busy, 1: idle, 2: can't tell (GitHub can't be read), which a scale-down treats as busy.
instance_busy() {
  local out
  out="$(gh api "repos/$CI_REPO/actions/runners?per_page=100" --jq ".runners[] | select(.busy and
    (.name | startswith(\"$1-\"))) | .id" 2>/dev/null)" || return 2
  [ -n "$out" ]
}

# Unloads one instance and removes its file and containers. $2 = keep-busy: leave it alone while it runs a job
# (a scale-down waits for that job; run install again afterwards).
remove_instance() {
  use_instance "$1"
  if [ "${2:-}" = keep-busy ] && [ "$1" != 1 ]; then
    local busy=0
    instance_busy "$I_PREFIX" || busy=$?
    if [ "$busy" -eq 0 ]; then
      echo "Instance $1 ($I_NAME) is running a job, so it stays for now. Run \`factory ci install\` again after it ends."
      return 0
    elif [ "$busy" -eq 2 ]; then
      echo "Can't tell whether instance $1 ($I_NAME) is running a job (GitHub can't be read), so it stays for now."
      echo "  Run \`factory ci install\` again when gh works."
      return 0
    fi
  fi
  if [ "$platform" = linux ]; then
    systemctl --user disable --now "$I_UNIT" >/dev/null 2>&1 || true
    rm -f "$I_UNIT_FILE"
  else
    launchctl bootout "$domain/$I_AGENT" 2>/dev/null || true
    wait_unloaded "$I_AGENT"
    rm -f "$I_PLIST"
  fi
  if docker info >/dev/null 2>&1; then
    RUNNER_REPO="$CI_REPO" RUNNER_NAME=none RUNNER_LABEL="$I_LABEL" \
      docker compose --file "$kit/$I_COMPOSE" --project-name "$I_PROJECT" down --volumes --remove-orphans \
      --timeout 10 >/dev/null 2>&1 || true
  fi
  [ "$1" = 1 ] || remove_instance_registrations "$I_PREFIX"
  echo "Removed instance $1 ($I_NAME)."
}

cmd_install() {
  if [ "$platform" = linux ]; then need gh docker systemctl; need_user_manager
  else need gh docker launchctl plutil; fi
  can_register || die "gh can't create a runner registration token for $CI_REPO. Log in with \`gh auth login\` as an admin of the repository, then run this again."
  if [ "$platform" = mac ]; then
    # An older install under another name would compete for the same jobs: unload it and remove its file.
    for old in $CI_REPLACES; do
      if agent_loaded "$old" || [ -f "$HOME/Library/LaunchAgents/$old.plist" ]; then
        echo "Removing the older LaunchAgent $old..."
        launchctl bootout "$domain/$old" 2>/dev/null || true
        wait_unloaded "$old"
        rm -f "$HOME/Library/LaunchAgents/$old.plist"
      fi
    done
  fi
  if [ -n "$(hand_pid || true)" ]; then
    echo "Stopping the runner started with \`factory ci start\` first..."
  fi
  stop_hand_loop
  copy_files
  on_main_note
  if docker info >/dev/null 2>&1; then
    echo "Pulling the runner images..."
    for f in compose.yaml $([ "$CI_LIGHT" = 1 ] && echo compose-light.yaml); do
      RUNNER_REPO="$CI_REPO" RUNNER_NAME=none RUNNER_LABEL="$CI_LABEL" \
        docker compose --file "$CI_INSTALLED/$f" --project-name "$CI_NAME" pull --quiet
    done
  fi
  build_image
  memory_note
  # Scale down first: instances this machine has but no longer wants.
  local id wanted
  wanted=" $(wanted_ids | tr '\n' ' ')"
  for id in $(installed_ids); do
    case "$wanted" in *" $id "*) ;; *) remove_instance "$id" keep-busy ;; esac
  done
  for id in $(wanted_ids); do
    use_instance "$id"
    if [ "$platform" = linux ]; then write_unit; else write_plist; fi
  done
  if [ "$platform" = linux ]; then
    # enable, then restart: starts each the first time, and replaces a loop that's already running after an update.
    systemctl --user daemon-reload
    for id in $(wanted_ids); do
      use_instance "$id"
      systemctl --user enable "$I_UNIT" >/dev/null 2>&1
      systemctl --user restart "$I_UNIT"
    done
    echo "Installed $CI_NAME (commit $(cat "$CI_STATE/commit")): systemd runs it as the user service $CI_UNIT."
  else
    for id in $(wanted_ids); do
      use_instance "$id"
      # Unload the old one first (its loop removes its containers), then load the new one. bootout returns
      # before launchd has let go, and bootstrap fails (error 5) until it has.
      launchctl bootout "$domain/$I_AGENT" 2>/dev/null || true
      wait_unloaded "$I_AGENT"
      launchctl bootstrap "$domain" "$I_PLIST"
    done
    echo "Installed $CI_NAME (commit $(cat "$CI_STATE/commit")): launchd runs it whenever you're logged in."
  fi
  echo "Repository $CI_REPO. Runners on $machine:"
  for id in $(wanted_ids); do
    use_instance "$id"
    echo "  $I_NAME: label $I_LABEL$([ "$id" = light ] && echo " (light jobs, no Docker)"), log $I_LOG"
  done
  [ "$platform" = linux ] && linger_note
  light_variable_note
  echo "Jobs go to them after \`factory ci use local\`. Check them with \`factory ci status\`."
}

# The light lane needs the repo variable CI_RUNS_ON_LIGHT. In local mode, set it now; otherwise say what
# `factory ci use local` will set.
# With the light lane off, a CI_RUNS_ON_LIGHT left from before would send every Factory guard to a runner that
# no longer exists: delete it, or say that a person must.
drop_light_variable() {
  local out
  out="$(gh api "repos/$CI_REPO/actions/variables/CI_RUNS_ON_LIGHT" --jq .value 2>/dev/null)" || return 0
  if gh variable delete CI_RUNS_ON_LIGHT --repo "$CI_REPO" >/dev/null 2>&1; then
    echo "The light lane is off, so I deleted the repo variable CI_RUNS_ON_LIGHT (it was $out); the Factory guard uses CI_RUNS_ON."
  else
    echo "The light lane is off: Delete the repo variable CI_RUNS_ON_LIGHT (it is $out) under Settings > Secrets and"
    echo "  variables > Actions > Variables; gh can't (it needs admin on $CI_REPO). Until then the Factory guard waits."
  fi
}

light_variable_note() {
  [ "$CI_LIGHT" = 1 ] || { drop_light_variable; return 0; }
  local value="[\"self-hosted\",\"$CI_LIGHT_LABEL\"]" rc=0
  runs_on >/dev/null || rc=$?
  if [ "$rc" -eq 0 ]; then
    if gh variable set CI_RUNS_ON_LIGHT --repo "$CI_REPO" --body "$value" >/dev/null 2>&1; then
      echo "Light jobs (the Factory guard) go to $CI_LIGHT_LABEL: the repo variable CI_RUNS_ON_LIGHT is $value."
    else
      echo "Set the repo variable CI_RUNS_ON_LIGHT to $value (Settings > Secrets and variables > Actions >"
      echo "  Variables); gh can't set it (it needs admin on $CI_REPO). Until then light jobs use CI_RUNS_ON."
    fi
  else
    echo "\`factory ci use local\` also sets CI_RUNS_ON_LIGHT to $value, so light jobs get their own runner."
  fi
}

cmd_uninstall() {
  if [ "$platform" = linux ]; then need systemctl; need_user_manager; else need launchctl; fi
  if [ -n "${1:-}" ]; then
    valid_id "$1" || die "say which instance: 1 to 16, or light."
    case " $(installed_ids | tr '\n' ' ')" in *" $1 "*) ;; *) die "instance $1 isn't installed on $machine." ;; esac
    remove_instance "$1"
    [ "$platform" = linux ] && systemctl --user daemon-reload 2>/dev/null || true
    return 0
  fi
  local id
  for id in $(installed_ids); do
    use_instance "$id"
    if [ "$platform" = linux ]; then
      systemctl --user disable --now "$I_UNIT" >/dev/null 2>&1 || true
      rm -f "$I_UNIT_FILE"
      echo "User service $I_UNIT removed."
    else
      launchctl bootout "$domain/$I_AGENT" 2>/dev/null || true
      wait_unloaded "$I_AGENT"
      rm -f "$I_PLIST"
      echo "LaunchAgent $I_AGENT removed."
    fi
  done
  [ "$platform" = linux ] && { systemctl --user daemon-reload 2>/dev/null || true; }
  rm -rf "$CI_INSTALLED"
  # The caches (compose-caches.yaml) and the built image go too.
  if docker info >/dev/null 2>&1; then
    docker rm -f "$CI_NAME-mirror" >/dev/null 2>&1 || true
    for id in $(seq 1 16) light; do
      use_instance "$id"
      docker network rm "$I_PROJECT-cache" >/dev/null 2>&1 || true
    done
    # <name>-pnpm-store: left by an earlier version, which shared a pnpm store.
    docker volume rm "$CI_NAME-mirror-data" "$CI_NAME-pnpm-store" >/dev/null 2>&1 || true
    docker image rm "$CI_NAME-runner:latest" >/dev/null 2>&1 || true
  fi
  cmd_stop
}

cmd_start() {
  need gh docker
  if any_loaded; then
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
  if any_loaded; then
    die "$CI_NAME is installed, so $manager would start it again. Remove it with \`factory ci uninstall\`."
  fi
  stop_hand_loop
  down
  remove_registrations
  echo "$CI_NAME stopped."
}

cmd_logs() {
  local id=1
  if [ -n "${1:-}" ] && [ "$1" != -f ]; then
    valid_id "$1" || die "say which instance: 1 to 16, or light."
    id="$1"; shift
  fi
  use_instance "$id"
  local file="$I_LOG"
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
      if [ "$CI_LIGHT" != 1 ]; then
        drop_light_variable
      else
        if gh variable set CI_RUNS_ON_LIGHT --repo "$CI_REPO" --body "[\"self-hosted\",\"$CI_LIGHT_LABEL\"]" >/dev/null; then
          echo "Light jobs (the Factory guard) run on the light runner, label $CI_LIGHT_LABEL (CI_RUNS_ON_LIGHT)."
        else
          echo "gh can't set CI_RUNS_ON_LIGHT; set it to [\"self-hosted\",\"$CI_LIGHT_LABEL\"] in the repo's Actions variables."
        fi
      fi
      if ! any_loaded && [ -z "$(hand_pid || true)" ]; then
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
      gh variable delete CI_RUNS_ON_LIGHT --repo "$CI_REPO" >/dev/null 2>&1 || true
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
  local installed="" id
  [ -n "$(installed_ids)" ] && installed=1
  if [ -n "$local_mode" ] || [ -n "$installed" ] || [ -n "$(hand_pid || true)" ]; then
    local pid
    for id in $( { echo 1; installed_ids; } | sort -u); do
      use_instance "$id"
      local what="Runner $I_NAME"
      [ "$id" = light ] && what="Runner $I_NAME (light lane, label $I_LABEL)"
      if instance_loaded "$id" && [ "$platform" = linux ]; then
        pid="$(systemctl --user show "$I_UNIT" -p MainPID --value 2>/dev/null || true)"
        if [ -n "$pid" ] && [ "$pid" != 0 ]; then
          echo "$what: running (systemd user service $I_UNIT, pid $pid). It starts again by itself after a restart."
        else
          echo "$what: installed, but its loop isn't running right now; systemd starts it again within 30 s."
        fi
      elif instance_loaded "$id"; then
        pid="$(launchctl print "$domain/$I_AGENT" 2>/dev/null | awk '$1 == "pid" && $2 == "=" { print $3; exit }')"
        if [ -n "$pid" ]; then
          echo "$what: running (LaunchAgent $I_AGENT, pid $pid). It starts again by itself after a restart."
        else
          echo "$what: installed, but its loop isn't running right now; launchd starts it again within 30 s."
        fi
      elif [ "$platform" = mac ] && [ -f "$I_PLIST" ]; then
        echo "$what: installed but not loaded. Run \`factory ci install\` again."
      elif [ "$id" = 1 ] && pid="$(hand_pid)"; then
        echo "$what: running (started by hand, pid $pid). It stops at a restart; \`factory ci install\` keeps it running."
      elif [ "$id" = 1 ]; then
        echo "$what: not running on $machine. \`factory ci install\` starts it (another machine may run one)."
      fi
    done
    local want
    want="$(wanted_ids | wc -l | tr -d ' ')"
    [ -n "$installed" ] && [ "$(installed_ids | wc -l | tr -d ' ')" != "$want" ] &&
      echo "  ci.runners and ci.light ask for $want instance(s) here; \`factory ci install\` brings it to that."
    if docker info >/dev/null 2>&1; then
      echo "Docker: running"
      image_note
    else
      echo "Docker: not running. Jobs for $machine wait in GitHub's queue until it is."
    fi
  fi
  # The light lane as GitHub will route it: the label in CI_RUNS_ON_LIGHT, if it is set, whatever ci.light says.
  local light_var light_label=""
  if light_var="$(gh api "repos/$CI_REPO/actions/variables/CI_RUNS_ON_LIGHT" --jq .value 2>/dev/null)"; then
    light_label="$(python3 -c 'import json,sys
v = json.loads(sys.argv[1]); v = [v] if isinstance(v, str) else v
print(next((x for x in v if x != "self-hosted"), ""))' "$light_var" 2>/dev/null || true)"
  elif [ "$CI_LIGHT" = 1 ]; then
    light_label="$CI_LIGHT_LABEL"
  fi
  python3 "$kit/ci_status.py" --repo "$CI_REPO" --label "$CI_LABEL" ${local_mode:+--local} \
    ${light_label:+--light-label "$light_label"} ${light_var:+--light-variable-set}
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
  uninstall) shift; cmd_uninstall "$@" ;;
  start) cmd_start ;;
  stop) cmd_stop ;;
  logs) shift; cmd_logs "$@" ;;
  names) for v in CI_REPO CI_NAME CI_LABEL CI_AGENT CI_PLIST CI_INSTALLED CI_STATE CI_REPLACES CI_UNIT CI_UNIT_FILE \
               CI_RUNNERS CI_LIGHT CI_LIGHT_LABEL CI_IMAGE CI_CACHES; do
      echo "$v=${!v}"
    done
    echo "CI_HOST=$host" ;;
  *) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
