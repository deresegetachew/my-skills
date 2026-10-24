#!/bin/bash
# The runner loop. `factory ci install` copies it, with compose.yaml and entrypoint.sh, into
# ~/Library/Application Support/<name>/ (macOS) or ~/.local/share/<name>/ (Linux) as an executable called <name>,
# and launchd or a systemd --user service runs that copy (never the checkout); `factory ci start` runs the same
# copy once, by hand. One round per job: a fresh compose project
# (dind + runner), the runner takes one job and exits, then everything is removed, volumes included.
#
# A registration token lasts one hour, and an ephemeral runner needs one per job. So each round asks the
# owner's `gh` login for a new one; a token `factory ci start` was given (on stdin) is used for the first round.
# No token is written to disk or printed. Each `docker compose up` gets the round's token in its environment,
# because compose passes it to the runner from there.
#
# Environment (from the LaunchAgent or the systemd unit, or from `factory ci start`): CI_NAME, CI_LABEL,
# RUNNER_REPO, CI_STATE, CI_HOST (this machine, in the runner's name, so `factory ci stop` removes only this
# machine's registrations), and on Linux DOCKER_HOST when Docker is rootless. With several loops on one machine
# (ci.runners, and the light lane), each also gets its own CI_PROJECT (compose project: its dind, volumes and
# workspace), CI_RUNNER_PREFIX (registration names), CI_COMPOSE (compose.yaml, or compose-light.yaml for the light
# lane) and CI_LOG; without them it is the single runner it always was.
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
: "${CI_NAME:?}" "${CI_LABEL:?}" "${RUNNER_REPO:?}" "${CI_STATE:?}"
project="${CI_PROJECT:-$CI_NAME}"
compose=(docker compose --file "$here/${CI_COMPOSE:-compose.yaml}")
# CI_CACHES=1 (heavy runners, ci.caches on): the Docker Hub mirror that outlives a job (compose-caches.yaml, #60),
# one per project and machine, on a network of this instance's own.
if [ "${CI_CACHES:-0}" = 1 ]; then
  compose+=(--file "$here/compose-caches.yaml")
  export CI_MIRROR="$CI_NAME-mirror" CI_CACHE_NETWORK="$project-cache"
fi
compose+=(--project-name "$project")
prefix="${CI_RUNNER_PREFIX:-$CI_NAME-${CI_HOST:-mac}}"
# `factory ci start` writes the token it was given (or an empty line) on stdin; under launchd, stdin is empty.
given_token=""
IFS= read -r given_token || true
exec </dev/null

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

new_token() {
  gh api -X POST "repos/$RUNNER_REPO/actions/runners/registration-token" --jq .token 2>/dev/null
}

cleanup() {
  RUNNER_REPO="$RUNNER_REPO" RUNNER_NAME=none RUNNER_LABEL="$CI_LABEL" \
    "${compose[@]}" down --volumes --remove-orphans --timeout 10 >/dev/null 2>&1
}
trap 'cleanup; log "stopped"; exit 0' TERM INT

# The log grows by megabytes per job; past 20 MB, keep its last megabyte. Rewritten in place, so whoever
# holds it open (the start redirect, launchd) keeps appending to the same file.
trim_log() {
  local file="${CI_LOG:-$CI_STATE/runner.log}"
  [ -f "$file" ] || return 0
  if [ "$(wc -c <"$file")" -gt 20000000 ]; then
    tail -c 1000000 "$file" >"$file.tmp" && cat "$file.tmp" >"$file"
    rm -f "$file.tmp"
  fi
}

# The mirror: idempotent, so several loops can race to it. A registry in proxy mode (read-only to jobs), pinned,
# restarted with Docker, and attached to each instance's own network, so instances never share a network.
MIRROR_IMAGE=registry:2.8.3
ensure_caches() {
  [ "${CI_CACHES:-0}" = 1 ] || return 0
  docker network inspect "$CI_CACHE_NETWORK" >/dev/null 2>&1 || docker network create "$CI_CACHE_NETWORK" >/dev/null 2>&1
  if [ "$(docker inspect -f '{{.State.Running}}' "$CI_MIRROR" 2>/dev/null)" != true ]; then
    docker rm -f "$CI_MIRROR" >/dev/null 2>&1 || true
    docker run -d --name "$CI_MIRROR" --restart unless-stopped --network "$CI_CACHE_NETWORK" \
      -e REGISTRY_PROXY_REMOTEURL=https://registry-1.docker.io -v "$CI_NAME-mirror-data:/var/lib/registry" \
      "$MIRROR_IMAGE" >/dev/null 2>&1 || log "the Docker Hub mirror didn't start; jobs pull from Docker Hub"
  fi
  docker network connect "$CI_CACHE_NETWORK" "$CI_MIRROR" >/dev/null 2>&1 || true  # already there: fine
}

wait_and_retry() {
  log "$1; trying again in ${backoff} s"
  # In the background: bash runs the TERM trap only once a foreground command ends.
  sleep "$backoff" &
  wait $!
  backoff=$((backoff < 300 ? backoff * 2 : 300))
}

round=0
backoff=5
cleaned=0
while true; do
  trim_log
  # Docker Desktop may still be starting (after a login, for example).
  if ! docker info >/dev/null 2>&1; then
    wait_and_retry "Docker isn't running"
    continue
  fi
  # A loop that was killed (launchd restarts it) couldn't remove its containers and volumes: do it once
  # now, so the next job doesn't start on the old one's dind data.
  if [ "$cleaned" -eq 0 ]; then
    cleanup
    cleaned=1
  fi

  # The given token is tried first, before gh is asked.
  token="$given_token"
  given_token=""
  [ -n "$token" ] || token="$(new_token || true)"
  if [ -z "$token" ]; then
    # Offline, or gh is logged out (`gh auth status`).
    wait_and_retry "no registration token: gh can't create one"
    continue
  fi

  ensure_caches
  round=$((round + 1))
  log "round $round: starting a runner for one job"
  # The token goes through this command's environment only (compose passes RUNNER_TOKEN through).
  RUNNER_TOKEN="$token" RUNNER_REPO="$RUNNER_REPO" RUNNER_NAME="$prefix-$(date +%s)" RUNNER_LABEL="$CI_LABEL" \
    "${compose[@]}" up --abort-on-container-exit --exit-code-from runner &
  wait $!
  code=$?
  token=""
  cleanup

  if [ "$code" -eq 3 ]; then
    # A token from gh is fresh, so this is a given token that was wrong or had expired.
    log "registration failed: the token is wrong or expired"
    exit 1
  fi
  if [ "$code" -ne 0 ]; then
    wait_and_retry "the runner ended with code $code"
    continue
  fi
  backoff=5
  log "round $round: job done, containers and volumes removed"
done
