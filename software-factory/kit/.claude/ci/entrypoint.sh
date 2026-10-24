#!/usr/bin/env bash
# Runs inside the runner container: registers one ephemeral runner, takes one job, exits.
# Exit 3 means the registration failed (a wrong or expired token): the loop stops then.
set -euo pipefail

: "${RUNNER_REPO:?}" "${RUNNER_NAME:?}" "${RUNNER_LABEL:?}"
token="${RUNNER_TOKEN:-}"
unset RUNNER_TOKEN
if [ -z "$token" ]; then
  echo "No registration token." >&2
  exit 3
fi

# The light runner (compose-light.yaml) has no Docker; the heavy ones wait for their dind.
if [ "${RUNNER_DOCKER:-1}" != 0 ]; then
  for _ in $(seq 1 60); do
    docker info >/dev/null 2>&1 && break
    sleep 1
  done
  docker info >/dev/null
fi

cd /home/runner
if ! ./config.sh --unattended --ephemeral --replace \
  --url "https://github.com/$RUNNER_REPO" --token "$token" \
  --name "$RUNNER_NAME" --labels "$RUNNER_LABEL" --work _work; then
  exit 3
fi
unset token

# exec, so the job's processes inherit an environment without the token.
exec ./run.sh
