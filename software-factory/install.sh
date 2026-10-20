#!/usr/bin/env bash
# Copy the software-factory kit into a project without overwriting anything that's already there.
# Usage: bash install.sh <project dir>
set -euo pipefail
src="$(cd "$(dirname "$0")/kit" && pwd)"
[ -d "${1:?Usage: install.sh <project dir>}" ] || { echo "No such folder: $1" >&2; exit 1; }
dst="$(cd "$1" && pwd)"
cd "$src"
find . -type f | sort | while read -r f; do
  target="$dst/${f#./}"
  if [ -e "$target" ]; then
    echo "kept     ${f#./} (already exists; merge by hand if needed)"
  else
    mkdir -p "$(dirname "$target")"
    cp "$f" "$target"
    echo "added    ${f#./}"
  fi
done
chmod +x "$dst"/.claude/hooks/*.py "$dst"/.claude/hooks/*.sh "$dst"/factory-loop.sh 2>/dev/null || true
grep -qxF 'tmp/' "$dst/.gitignore" 2>/dev/null || echo 'tmp/' >> "$dst/.gitignore"
grep -qxF '__pycache__/' "$dst/.gitignore" 2>/dev/null || echo '__pycache__/' >> "$dst/.gitignore"
echo
echo "Next: fill in .claude/factory.json, write CLAUDE.md from CLAUDE.factory.md, write docs/build-plan.md."
