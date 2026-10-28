#!/usr/bin/env bash
# Install the software-factory kit into a project.
#
#   bash install.sh <project dir>
#       Copy the whole kit, never overwriting a file that's already there.
#
#   bash vendor/my-skills/software-factory/install.sh . --link      (my-skills as a git submodule of the project)
#       Everything shared (the hook scripts, factory-loop.sh, the agents, the skills and the agents' rules in .claude/factory/settings.json) becomes
#       relative symlinks into the submodule, so the project has one version of it: the submodule's commit. What a
#       project fills in (factory.json, CLAUDE.factory.md, the docs templates, CI) is copied as before. A project's
#       own additions go in factory.json and .claude/factory/notes/<agent or skill>.md, never in the shared files.
#       A shared file that is already a plain copy identical to the kit becomes a link; one that differs is kept,
#       with a warning: move its project-specific lines to factory.json or a note, delete it, and run this again. Re-run it after `git submodule update --remote` to link new shared files.
#
#   Where the links point (#112): the factory's code is read from its own folders: .claude/hooks/x ->
#   software-factory/hooks/x, .claude/ci/x -> software-factory/ci/x, factory -> software-factory/factory,
#   factory-loop.sh likewise. The agents, skills and .claude/factory/settings.json come from software-factory/kit/.claude/.
#   A link a project made before the move (into software-factory/kit/, where the forwarders were until #176) is relinked.
#   `--layout new` and `--layout auto` are still accepted and change nothing: there is one layout. An older `factory
#   update` passes `--layout auto` when it moves the submodule to this version, so that must keep working. `--layout
#   old` was removed with the forwarders (#176) and is refused.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# Run a factory script (<path>.ts) with Bun. --no-env-file: Bun must not load the project's .env into the factory.
fh() {
  local s="$1"; shift
  command -v bun >/dev/null 2>&1 || { printf '{"code": "bun_missing", "message": "%s needs Bun, and bun is not on the PATH.", "fix": "Install Bun (curl -fsSL https://bun.sh/install | bash), open a new terminal, then run the command again."}\n' "${s##*/}.ts" >&2; return 127; }
  bun --no-env-file --config=/dev/null "$s.ts" "$@"
}
src="$here/kit"
[ -d "${1:?Usage: install.sh <project dir> [--link]}" ] || { echo "No such folder: $1" >&2; exit 1; }
dst="$(cd "$1" && pwd)"
link=0
shift
while [ $# -gt 0 ]; do
  case "$1" in
    --link) link=1 ;;
    --layout|--layout=*)
      if [ "$1" = --layout ]; then layout="${2:-}"; shift; else layout="${1#--layout=}"; fi
      case "$layout" in new|auto) ;; *) printf '{"code": "layout_removed", "message": "--layout %s is gone: the kit/ forwarders it linked through were removed (#176).", "fix": "run it again without --layout (or with --layout new); links into kit/ are relinked to the new folders."}\n' "$layout" >&2; exit 1 ;; esac ;;
    *) echo "Unknown option: $1 (use --link)" >&2; exit 1 ;;
  esac
  shift
done
# A project that already has .claude/factory.json is set up: a relink only updates the links, never re-adds templates.
setup=1; [ -f "$dst/.claude/factory.json" ] && setup=0
if [ "$link" = 1 ]; then
  case "$src/" in "$dst"/*) ;; *) echo "--link needs this installer inside the project (my-skills as a submodule, for example vendor/my-skills)" >&2; exit 1;; esac
fi

# Shared: used unchanged by every project. Everything else in kit/ is a template the project fills in.
is_engine() {
  case "$1" in
    ./factory|./factory-loop.sh|./.claude/hooks/*.ts|./.claude/hooks/*.sh|./.claude/ci/*) return 0;;
    ./.claude/agents/*.md|./.claude/skills/*/*.md|./.claude/factory/settings.json|./.claude/manager/settings.json|./.claude/product-owner/settings.json) return 0;;
    *) return 1;;
  esac
}

# Is $1 (a path in kit/, like ./.claude/hooks/x.ts) code that moved out of kit/ (#112)? Then its real file is at $2.
moved_to() {
  case "$1" in
    ./.claude/hooks/*) [ -f "$here/hooks/${1#./.claude/hooks/}" ] && echo "$here/hooks/${1#./.claude/hooks/}" ;;
    ./.claude/ci/*) [ -f "$here/ci/${1#./.claude/ci/}" ] && echo "$here/ci/${1#./.claude/ci/}" ;;
    ./factory|./factory-loop.sh) [ -f "$here/${1#./}" ] && echo "$here/${1#./}" ;;
  esac
  return 0
}

# Relative path from the folder holding $1 (inside the project) to the kit file $2.
# Both are absolute, normalized paths (from `cd ... && pwd`), so this is plain string work, like os.path.relpath.
rel() {
  local common="${1%/*}" up=""
  while [ -n "$common" ] && [ "${2#"$common"/}" = "$2" ]; do common="${common%/*}"; up="../$up"; done
  printf '%s\n' "$up${2#"$common"/}"
}

# The files to install, as paths a project has them (./.claude/hooks/x.ts, ./factory ...), one per line: what kit/
# holds, plus the factory's code from hooks/, ci/ and the two entry points.
list_files() {
  { ( cd "$src" && find . -type f -not -path '*/__pycache__/*' )
    ( cd "$here" && find hooks ci -type f -not -path '*/__pycache__/*' | sed 's#^hooks/#./.claude/hooks/#; s#^ci/#./.claude/ci/#'
      echo ./factory; echo ./factory-loop.sh ); } | sort -u
}

# The project's stack on a first install (#199): node (package.json), python, or unknown. Only python changes what is
# installed: its CI workflow template stands in for the pnpm one, and `commands.*` are filled in below.
stack=node
if [ "$setup" = 1 ]; then
  stack="$(fh "$here/hooks/factory_stack" detect "$dst" | sed -n 's/^  "stack": "\([a-z]*\)",*$/\1/p')"
fi
PY_WORKFLOW=./.github/workflows/ci-python.yml.template
# The agents' rules moved to .claude/factory/settings.json (#258), which the factory passes when it starts an agent.
# A .claude/settings.json that is still a link to the kit's old file would give them to every session here: it goes.
# Any other .claude/settings.json is the project's own and is never touched.
if [ "$link" = 1 ] && [ -L "$dst/.claude/settings.json" ]; then
  case "$(readlink "$dst/.claude/settings.json")" in
    */software-factory/kit/.claude/settings.json)
      rm -f "$dst/.claude/settings.json"
      echo "removed  .claude/settings.json (a link to the kit: the agents' rules are in .claude/factory/settings.json now, passed when the factory starts an agent)" ;;
  esac
fi
list_files | while read -r f; do
  [ "$f" != "$PY_WORKFLOW" ] || continue  # a template to choose from, never a workflow of its own
  target="$dst/${f#./}"
  from="$src/${f#./}"
  python_ci=0
  if [ "$setup" = 1 ] && [ "$stack" = python ] && [ "$f" = ./.github/workflows/ci.yml ] && [ ! -e "$target" ]; then
    from="$src/${PY_WORKFLOW#./}"; python_ci=1
  fi
  m="$(moved_to "$f")"; [ -z "$m" ] || from="$m"
  # The folder is made only when a file is put in it (#152): a template the project left out must not leave an empty docs/.
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
      mkdir -p "$(dirname "$target")"; ln -s "$want" "$target"; echo "linked   ${f#./}"
    fi
  elif [ -e "$target" ]; then
    if [ "$setup" = 1 ]; then echo "kept     ${f#./} (already exists; merge by hand if needed)"; fi  # not "&&": a false test would end a run with set -e (#152)
  elif [ "$setup" = 0 ]; then
    :  # a template the project chose not to keep (or not yet): leave it out
  else
    mkdir -p "$(dirname "$target")"; cp -L "$from" "$target"
    if [ "$python_ci" = 1 ]; then echo "added    ${f#./} (the Python template: it runs commands.install and commands.test from .claude/factory.json)"
    else echo "added    ${f#./}"; fi
  fi
done
# Never change files in the kit itself: with --link it is the project's submodule.
[ "$link" = 1 ] || chmod +x "$dst"/.claude/hooks/*.ts "$dst"/.claude/hooks/*.sh "$dst"/.claude/ci/*.sh "$dst"/factory-loop.sh "$dst"/factory 2>/dev/null || true
# The role folders (#102): README.md and reads.md per role, from the project's own documents. Never overwritten; a
# project that was set up before roles existed gets them with `factory init-roles`.
if [ "$setup" = 1 ] && [ -f "$dst/.claude/hooks/factory_roles.ts" ]; then
  ( cd "$dst" && CLAUDE_PROJECT_DIR="$dst" fh .claude/hooks/factory_roles init | sed 's/^/roles    /' ) || true
fi
grep -qxF 'tmp/' "$dst/.gitignore" 2>/dev/null || echo 'tmp/' >> "$dst/.gitignore"
grep -qxF '__pycache__/' "$dst/.gitignore" 2>/dev/null || echo '__pycache__/' >> "$dst/.gitignore"
if [ "$setup" = 1 ]; then
  echo
  fh "$here/hooks/factory_stack" apply "$dst" >/dev/null  # a Python project: the commands.* to match
  fh "$here/hooks/factory_stack" lines "$dst"
  echo "Next: fill in .claude/factory.json, write CLAUDE.md from CLAUDE.factory.md, write docs/build-plan.md."
  echo "Then run ./factory help (and ./factory install-shim once, to type just: factory ...)."
fi
