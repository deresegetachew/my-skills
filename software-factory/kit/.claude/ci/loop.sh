#!/bin/bash
# The runner loop. `factory ci install` copies it, with compose.yaml and entrypoint.sh, into
# ~/Library/Application Support/<name>/ as an executable called <name>, and launchd runs that copy (never the
# checkout); `factory ci start` runs the same copy once, by hand. One round per job: a fresh compose project
# (dind + runner), the runner takes one job and exits, then everything is removed, volumes included.
#
# A registration token lasts one hour, and an ephemeral runner needs one per job. So each round asks the
# owner's `gh` login for a new one; a token `factory ci start` was given (on stdin) is used for the first round.
# No token is written to disk or printed. Each `docker compose up` gets the round's token in its environment,
# because compose passes it to the runner from there.
#
# Environment (from the LaunchAgent, or from `factory ci start`): CI_NAME, CI_LABEL, RUNNER_REPO, CI_STATE, and
# CI_HOST (this Mac, in the runner's name, so `factory ci stop` removes only this Mac's registrations).
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
: "${CI_NAME:?}" "${CI_LABEL:?}" "${RUNNER_REPO:?}" "${CI_STATE:?}"
compose=(docker compose --file "$here/compose.yaml" --project-name "$CI_NAME")
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
  local file="$CI_STATE/runner.log"
  [ -f "$file" ] || return 0
  if [ "$(wc -c <"$file")" -gt 20000000 ]; then
    tail -c 1000000 "$file" >"$file.tmp" && cat "$file.tmp" >"$file"
    rm -f "$file.tmp"
  fi
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

  round=$((round + 1))
  log "round $round: starting a runner for one job"
  # The token goes through this command's environment only (compose passes RUNNER_TOKEN through).
  RUNNER_TOKEN="$token" RUNNER_REPO="$RUNNER_REPO" RUNNER_NAME="$CI_NAME-${CI_HOST:-mac}-$(date +%s)" RUNNER_LABEL="$CI_LABEL" \
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
