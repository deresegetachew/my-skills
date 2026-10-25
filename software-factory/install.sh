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
#
#   --layout new|old|auto     (with --link; default auto)    where the project's links point (#112 step 2)
#       new   the factory's code is read from its own folders: .claude/hooks/x -> software-factory/hooks/x,
#             .claude/ci/x -> software-factory/ci/x, factory -> software-factory/factory, factory-loop.sh likewise.
#             The links stay where settings.json and the docs expect them; only where they point changes.
#             The agents, skills and settings.json still come from software-factory/kit/.claude/.
#       old   the paths under software-factory/kit/ (symlink forwarders to the new folders). What every project
#             linked before the move; it keeps working until the project switches.
#       auto  a project that already links through kit/ stays old (a re-run changes nothing); any other is new.
#             Switch a project with --layout new, in one reviewed commit.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
src="$here/kit"
[ -d "${1:?Usage: install.sh <project dir> [--link]}" ] || { echo "No such folder: $1" >&2; exit 1; }
dst="$(cd "$1" && pwd)"
link=0; layout=auto
shift
while [ $# -gt 0 ]; do
  case "$1" in
    --link) link=1 ;;
    --layout) layout="${2:-}"; shift ;;
    --layout=*) layout="${1#--layout=}" ;;
    *) echo "Unknown option: $1 (use --link and --layout new|old|auto)" >&2; exit 1 ;;
  esac
  shift
done
case "$layout" in new|old|auto) ;; *) echo "--layout takes new, old or auto, not '$layout'" >&2; exit 1 ;; esac
# A project that already has .claude/factory.json is set up: a relink only updates the links, never re-adds templates.
setup=1; [ -f "$dst/.claude/factory.json" ] && setup=0
if [ "$link" = 1 ]; then
  case "$src/" in "$dst"/*) ;; *) echo "--link needs this installer inside the project (my-skills as a submodule, for example vendor/my-skills)" >&2; exit 1;; esac
fi

# Shared: used unchanged by every project. Everything else in kit/ is a template the project fills in.
is_engine() {
  case "$1" in
    ./factory|./factory-loop.sh|./.claude/hooks/*.py|./.claude/hooks/*.sh|./.claude/ci/*) return 0;;
    ./.claude/agents/*.md|./.claude/skills/*/*.md|./.claude/settings.json) return 0;;
    *) return 1;;
  esac
}

# Is $1 (a path in kit/, like ./.claude/hooks/x.py) code that moved out of kit/ (#112)? Then its real file is at $2.
moved_to() {
  case "$1" in
    ./.claude/hooks/*) [ -f "$here/hooks/${1#./.claude/hooks/}" ] && echo "$here/hooks/${1#./.claude/hooks/}" ;;
    ./.claude/ci/*) [ -f "$here/ci/${1#./.claude/ci/}" ] && echo "$here/ci/${1#./.claude/ci/}" ;;
    ./factory|./factory-loop.sh) [ -f "$here/${1#./}" ] && echo "$here/${1#./}" ;;
  esac
  return 0
}

# Relative path from the folder holding $1 (inside the project) to the kit file $2.
rel() { python3 -c 'import os,sys;print(os.path.relpath(sys.argv[2], os.path.dirname(sys.argv[1])))' "$1" "$2"; }

# Layout of the links (see --layout above). Auto: a project that links through kit/ already stays on it.
if [ "$link" = 1 ] && [ "$layout" = auto ]; then
  layout=new
  for t in "$dst"/.claude/hooks/* "$dst"/.claude/ci/* "$dst/factory" "$dst/factory-loop.sh"; do
    if [ -L "$t" ]; then case "$(readlink "$t")" in */software-factory/kit/*) layout=old; break;; esac; fi
  done
fi
[ "$link" = 1 ] || layout=new  # a copy always takes the real files

# The files to install, as paths inside kit/ (./.claude/hooks/x.py, ./factory ...), one per line. In the new layout
# the forwarders in kit/ are replaced by what is really in hooks/, ci/ and the two entry points, so a file added
# there needs no forwarder to reach a project.
list_files() {
  if [ "$layout" = old ]; then
    ( cd "$src" && find . \( -type f -o -type l \) -not -path '*/__pycache__/*' )  # kit/ holds symlink forwarders to the moved code (#112 step 1), so symlinks count too
  else
    ( cd "$src" && find . \( -type f -o -type l \) -not -path '*/__pycache__/*' | while read -r f; do
        { [ -L "$f" ] && [ -n "$(moved_to "$f")" ]; } || echo "$f"
      done )
    ( cd "$here" && find hooks ci -type f -not -path '*/__pycache__/*' | sed 's#^hooks/#./.claude/hooks/#; s#^ci/#./.claude/ci/#'
      echo ./factory; echo ./factory-loop.sh )
  fi | sort -u
}

list_files | while read -r f; do
  target="$dst/${f#./}"
  from="$src/${f#./}"
  if [ "$layout" = new ]; then m="$(moved_to "$f")"; [ -z "$m" ] || from="$m"; fi
  mkdir -p "$(dirname "$target")"
  if [ "$link" = 1 ] && is_engine "$f"; then
    want="$(rel "$target" "$from")"
    if [ -L "$target" ] && [ "$(readlink "$target")" = "$want" ]; then
      echo "linked   ${f#./}"
    elif [ -L "$target" ] && [ "$from" != "$src/${f#./}" ] && case "$(readlink "$target")" in */software-factory/kit/*) true;; *) false;; esac; then
      rm -f "$target"; ln -s "$want" "$target"; echo "relinked ${f#./} (from kit/ to the new folder)"
    elif [ -L "$target" ] || { [ -f "$target" ] && cmp -s "$target" "$from"; }; then
      rm -f "$target"; ln -s "$want" "$target"; echo "linked   ${f#./} (was a copy)"
    elif [ -e "$target" ]; then
      echo "kept     ${f#./} (differs from the kit: link it by hand once the change is in my-skills)"
    else
      ln -s "$want" "$target"; echo "linked   ${f#./}"
    fi
  elif [ -e "$target" ]; then
    [ "$setup" = 1 ] && echo "kept     ${f#./} (already exists; merge by hand if needed)"
  elif [ "$setup" = 0 ]; then
    :  # a template the project chose not to keep (or not yet): leave it out
  else
    cp -L "$from" "$target"
    echo "added    ${f#./}"
  fi
done
# Never change files in the kit itself: with --link it is the project's submodule.
[ "$link" = 1 ] || chmod +x "$dst"/.claude/hooks/*.py "$dst"/.claude/hooks/*.sh "$dst"/.claude/ci/*.sh "$dst"/factory-loop.sh "$dst"/factory 2>/dev/null || true
grep -qxF 'tmp/' "$dst/.gitignore" 2>/dev/null || echo 'tmp/' >> "$dst/.gitignore"
grep -qxF '__pycache__/' "$dst/.gitignore" 2>/dev/null || echo '__pycache__/' >> "$dst/.gitignore"
if [ "$setup" = 1 ]; then
  echo
  echo "Next: fill in .claude/factory.json, write CLAUDE.md from CLAUDE.factory.md, write docs/build-plan.md."
  echo "Then run ./factory help (and ./factory install-shim once, to type just: factory ...)."
fi
