#!/bin/bash
# The project image (ci.projectImage, #92's rule kept): <name>-runner:project is the heavy runners' image plus a
# pnpm store filled from main's lockfile (project.Dockerfile). The runner loop starts this before each job, in the
# background, from its installed copy; a job never waits for it.
#
# One round:
#   1. Asks GitHub for the git hashes of pnpm-lock.yaml, pnpm-workspace.yaml and .npmrc on the default branch
#      (one call). Never a pull request's files, and never this machine's checkout.
#   2. Compares them, with the base image's id, to the label factory.project-key on the image it built last.
#      The same: nothing to do. No docker build is started.
#   3. Different: downloads those files by hash, checks each against its hash, and builds. `docker build` tags the
#      image only when it succeeds, so after a failed build the runners keep the last good one (or the base image).
# A failure is one {code, message, fix} line in the runner's log, at most once in CI_PROJECT_RETRY_MINUTES (10) for
# the same cause, and the build is tried again after that.
#
# Environment (from the loop): CI_NAME, RUNNER_REPO, CI_STATE, RUNNER_IMAGE (the base image). Several loops share
# one lock (a folder in CI_STATE), so only one builds at a time and the others carry on with what is there.
# Exit 0: up to date, built, or another loop is at it. Exit 1: a failure it logged (or logged a moment ago).
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
: "${CI_NAME:?}" "${RUNNER_REPO:?}" "${CI_STATE:?}"
base="${RUNNER_IMAGE:-}"
tag="$CI_NAME-runner:project"
lock="$CI_STATE/project-image.lock"
memo="$CI_STATE/project-image.failed"
retry="${CI_PROJECT_RETRY_MINUTES:-10}"
FILES="pnpm-lock.yaml pnpm-workspace.yaml .npmrc"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# A value inside a JSON string: backslashes and quotes escaped, on one line.
esc() { local s="${1//\\/\\\\}"; s="${s//\"/\\\"}"; printf '%s' "$s" | tr '\n\t' '  '; }

# fail <code> <message> <fix> [cause]: logs it unless the same cause was logged in the last $retry minutes.
fail() {
  local cause="${4:-$1}"
  if [ "$retry" != 0 ] && [ "$(cat "$memo" 2>/dev/null)" = "$cause" ] && [ -n "$(find "$memo" -mmin "-$retry" 2>/dev/null)" ]; then
    exit 1
  fi
  printf '%s\n' "$cause" >"$memo"
  log "$(printf '{"code": "%s", "message": "%s", "fix": "%s"}' "$(esc "$1")" "$(esc "$2")" "$(esc "$3")")"
  exit 1
}

mkdir -p "$CI_STATE"
# A lock left by a loop that was killed mid-build: gone after an hour.
[ -n "$(find "$lock" -maxdepth 0 -mmin +60 2>/dev/null)" ] && rmdir "$lock" 2>/dev/null
mkdir "$lock" 2>/dev/null || exit 0
ctx=""
# shellcheck disable=SC2317
done_() { [ -z "$ctx" ] || rm -rf "$ctx"; rmdir "$lock" 2>/dev/null; }
trap done_ EXIT
trap 'exit 0' TERM INT

[ -n "$base" ] || fail project_image_no_base "ci.projectImage is on, but there is no runner image to build on (ci.image is base, or its build failed)." \
  "Set ci.image to build and run \`factory ci install\` on this machine."
base_id="$(docker image inspect --format '{{.Id}}' "$base" 2>/dev/null)"
[ -n "$base_id" ] || fail project_image_no_base "The runner image $base isn't on this machine, so the project image can't be built on it." \
  "Run \`factory ci install\` on this machine; it builds $base."

# path and git hash, one per line, for the files main has. HEAD is the repository's default branch.
tree="$(gh api "repos/$RUNNER_REPO/git/trees/HEAD" --jq '.tree[] | select(.type == "blob" and (.path == "pnpm-lock.yaml" or .path == "pnpm-workspace.yaml" or .path == ".npmrc")) | "\(.path) \(.sha)"' 2>/dev/null)" ||
  fail project_image_github "gh can't read $RUNNER_REPO's main branch, so the project image wasn't checked." \
    "Check \`gh auth status\` and the network on this machine. The runners use the image they have."
sha_of() { awk -v p="$1" '$1 == p { print $2 }' <<<"$tree"; }
lock_sha="$(sha_of pnpm-lock.yaml)"
case "$lock_sha" in
  '') fail project_image_no_lockfile "$RUNNER_REPO has no pnpm-lock.yaml on its main branch, so there is nothing to put in the project image." \
        "Commit pnpm-lock.yaml to main, or turn it off: \`factory settings set ci.projectImage false\`, then \`factory ci install\`." ;;
  *[!0-9a-f]*) fail project_image_github "GitHub gave an odd hash for pnpm-lock.yaml." "Try again later; the runners use the image they have." ;;
esac

key="$base_id"
for f in $FILES; do s="$(sha_of "$f")"; key="$key/${s:-none}"; done
have="$(docker image inspect --format '{{index .Config.Labels "factory.project-key"}}' "$tag" 2>/dev/null || true)"
if [ "$have" = "$key" ]; then
  rm -f "$memo"
  exit 0
fi
# This exact build failed a moment ago: wait before trying again.
if [ "$retry" != 0 ] && [ "$(cat "$memo" 2>/dev/null)" = "build $key" ] && [ -n "$(find "$memo" -mmin "-$retry" 2>/dev/null)" ]; then
  exit 1
fi

# The build context: a private folder with those files only, each checked against the hash GitHub listed.
ctx="$(mktemp -d "$CI_STATE/project-image.XXXXXX")" || fail project_image_build_failed "Can't make a folder in $CI_STATE." "Check that folder's owner and free disk space."
chmod 700 "$ctx"
for f in $FILES; do
  s="$(sha_of "$f")"
  [ -n "$s" ] || continue
  case "$s" in *[!0-9a-f]*) continue ;; esac
  if ! gh api -H "Accept: application/vnd.github.raw+json" "repos/$RUNNER_REPO/git/blobs/$s" >"$ctx/$f" 2>/dev/null ||
     [ "$(git hash-object "$ctx/$f" 2>/dev/null)" != "$s" ]; then
    fail project_image_github "Main's $f didn't download whole from GitHub (its git hash doesn't match)." \
      "Check the network and that git is on the runner service's PATH. The runners use the image they have; it is tried again in $retry minutes."
  fi
  chmod 600 "$ctx/$f"
done

log "project image: main's lockfile is ${lock_sha:0:12}; building $tag on $base"
if ! out="$(docker build --quiet --tag "$tag" --file "$here/project.Dockerfile" --build-arg "BASE_IMAGE=$base" \
      --label "factory.project=$CI_NAME" --label "factory.lockfile=$lock_sha" --label "factory.project-key=$key" \
      "$ctx" 2>&1 >/dev/null)"; then
  if docker image inspect "$tag" >/dev/null 2>&1; then using="the last one that built ($tag)"; else using="$base"; fi
  fail project_image_build_failed "The project image didn't build for main's lockfile ${lock_sha:0:12}: $(tail -n 1 <<<"$out"). The runners use $using." \
    "Nothing to do if it was the network: it is tried again in $retry minutes. Else run \`docker build --file \"$here/project.Dockerfile\" --build-arg BASE_IMAGE=$base <a folder with main's pnpm-lock.yaml>\` to see the whole error." \
    "build $key"
fi
rm -f "$memo"
# The image this one replaced has no tag now: remove it, unless a running job still uses it.
docker image prune --force --filter "label=factory.project=$CI_NAME" >/dev/null 2>&1 || true
log "project image: built $tag for main's lockfile ${lock_sha:0:12}; the next jobs use it"
