#!/usr/bin/env bash
# Install the software-factory kit into a project.
#
#   bash install.sh <project dir>
#       Copy the whole kit, never overwriting a file that's already there.
#
#   bash vendor/my-skills/software-factory/install.sh . --link      (my-skills as a git submodule of the project)
#       Everything shared (the hook scripts, factory-loop.sh, the agents, the skills and settings.json) becomes
#       relative symlinks into the submodule, so the project has one version of it: the submodule's commit. What a
#       project fills in (factory.json, CLAUDE.factory.md, the docs templates, CI) is copied as before. A project's
#       own additions go in factory.json and .claude/factory/notes/<agent or skill>.md, never in the shared files.
#       A shared file that is already a plain copy identical to the kit becomes a link; one that differs is kept,
#       with a warning: move its project-specific lines to factory.json or a note, delete it, and run this again. Re-run it after `git submodule update --remote` to link new shared files.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
src="$here/kit"
[ -d "${1:?Usage: install.sh <project dir> [--link]}" ] || { echo "No such folder: $1" >&2; exit 1; }
dst="$(cd "$1" && pwd)"
link=0; [ "${2:-}" = "--link" ] && link=1
if [ "$link" = 1 ]; then
  case "$src/" in "$dst"/*) ;; *) echo "--link needs this installer inside the project (my-skills as a submodule, for example vendor/my-skills)" >&2; exit 1;; esac
fi

# Shared: used unchanged by every project. Everything else in kit/ is a template the project fills in.
is_engine() {
  case "$1" in
    ./factory-loop.sh|./.claude/hooks/*.py|./.claude/hooks/*.sh) return 0;;
    ./.claude/agents/*.md|./.claude/skills/*/SKILL.md|./.claude/settings.json) return 0;;
    *) return 1;;
  esac
}

# Relative path from the folder holding $1 (inside the project) to the kit file $2.
rel() { python3 -c 'import os,sys;print(os.path.relpath(sys.argv[2], os.path.dirname(sys.argv[1])))' "$1" "$2"; }

cd "$src"
find . -type f -not -path '*/__pycache__/*' | sort | while read -r f; do
  target="$dst/${f#./}"
  mkdir -p "$(dirname "$target")"
  if [ "$link" = 1 ] && is_engine "$f"; then
    want="$(rel "$target" "$src/${f#./}")"
    if [ -L "$target" ] && [ "$(readlink "$target")" = "$want" ]; then
      echo "linked   ${f#./}"
    elif [ -L "$target" ] || { [ -f "$target" ] && cmp -s "$target" "$f"; }; then
      rm -f "$target"; ln -s "$want" "$target"; echo "linked   ${f#./} (was a copy)"
    elif [ -e "$target" ]; then
      echo "kept     ${f#./} (differs from the kit: link it by hand once the change is in my-skills)"
    else
      ln -s "$want" "$target"; echo "linked   ${f#./}"
    fi
  elif [ -e "$target" ]; then
    echo "kept     ${f#./} (already exists; merge by hand if needed)"
  else
    cp "$f" "$target"
    echo "added    ${f#./}"
  fi
done
chmod +x "$src"/.claude/hooks/*.py "$src"/.claude/hooks/*.sh "$src"/factory-loop.sh 2>/dev/null || true
[ "$link" = 1 ] || chmod +x "$dst"/.claude/hooks/*.py "$dst"/.claude/hooks/*.sh "$dst"/factory-loop.sh 2>/dev/null || true
grep -qxF 'tmp/' "$dst/.gitignore" 2>/dev/null || echo 'tmp/' >> "$dst/.gitignore"
grep -qxF '__pycache__/' "$dst/.gitignore" 2>/dev/null || echo '__pycache__/' >> "$dst/.gitignore"
echo
echo "Next: fill in .claude/factory.json, write CLAUDE.md from CLAUDE.factory.md, write docs/build-plan.md."
