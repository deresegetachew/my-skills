#!/usr/bin/env bash
# Runs once while runner.Dockerfile builds (as root), with Bun on the PATH. See that file for the three versions.
set -euo pipefail

arch="$(dpkg --print-architecture)"
case "$arch" in amd64) node_arch=x64 ;; arm64) node_arch=arm64 ;; *) node_arch="$arch" ;; esac

if [ -n "${NODE_VERSION:-}" ]; then
  want="${NODE_VERSION#v}"
  # "24" or "24.1": the newest release with that prefix; "24.1.0": exactly that one.
  version="$(curl -fsSL https://nodejs.org/dist/index.json | bun --no-env-file -e '
const want = (process.argv.at(-1) ?? "").split(".");
const releases = JSON.parse(await Bun.stdin.text()) as { version: string }[];
for (const r of releases) {
  const v = r.version.replace(/^v+/, "").split(".");
  if (want.every((w, i) => v[i] === w)) { console.log(v.join(".")); break; }
}' "$want")"
  [ -n "$version" ] || { echo "No Node release matches $NODE_VERSION" >&2; exit 1; }
  dir="/opt/hostedtoolcache/node/$version/$node_arch"
  mkdir -p "$dir"
  curl -fsSL "https://nodejs.org/dist/v$version/node-v$version-linux-$node_arch.tar.xz" | tar -xJ -C "$dir" --strip-components 1
  touch "$dir.complete"  # what actions/setup-node checks before it downloads anything
  for tool in node npm npx corepack; do ln -sf "$dir/bin/$tool" "/usr/local/bin/$tool"; done
  echo "Node $version in the tool cache"
fi

if [ -n "${PNPM_VERSION:-}" ] && command -v corepack >/dev/null; then
  corepack enable --install-directory /usr/local/bin
  corepack prepare "pnpm@$PNPM_VERSION" --activate
  echo "pnpm $PNPM_VERSION through corepack"
fi

if [ -n "${PLAYWRIGHT_VERSION:-}" ] && command -v npx >/dev/null; then
  npx -y "playwright@$PLAYWRIGHT_VERSION" install --with-deps chromium
  echo "Playwright $PLAYWRIGHT_VERSION's Chromium in $PLAYWRIGHT_BROWSERS_PATH"
fi
