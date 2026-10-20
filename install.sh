#!/usr/bin/env bash
# Install skills from this repo into Claude Code by symlinking them.
#
#   ./install.sh                    list skills and what's installed
#   ./install.sh <skill> [...]      install one or more skills globally (~/.claude/skills)
#   ./install.sh --all              install every skill
#   ./install.sh --project <dir> <skill> [...]   install into one project (<dir>/.claude/skills)
#   ./install.sh --project <dir> --copy <skill> [...]
#                                   copy instead of linking, so the project commits its own pinned copy
#                                   (CI, the cloud dev manager and fresh clones can't follow a link to this
#                                   clone). Run it again to update the copy.
#   ./install.sh --remove <skill> [...]          remove a link (or a copy) this script made
#
# Links point back into this clone, so `git pull` here updates every linked install.
set -euo pipefail
repo="$(cd "$(dirname "$0")" && pwd)"
dest="$HOME/.claude/skills"
mode=install
copy=0

args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --all) mode=all ;;
    --remove) mode=remove ;;
    --copy) copy=1 ;;
    --project) shift; dest="$(cd "${1:?--project needs a directory}" && pwd)/.claude/skills" ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) args+=("$1") ;;
  esac
  shift
done

skills() { find "$repo" -mindepth 2 -maxdepth 2 -name SKILL.md | sort | xargs -rn1 dirname | xargs -rn1 basename; }

if [ "$mode" = install ] && [ ${#args[@]} -eq 0 ]; then
  echo "Skills in $repo (install with: $0 <name>, or --all):"
  for s in $(skills); do
    state=" "
    [ -e "$dest/$s" ] && state="*"
    desc=$(sed -n 's/^description: //p' "$repo/$s/SKILL.md" | head -1 | cut -c1-80)
    printf '  %s %-20s %s\n' "$state" "$s" "$desc"
  done
  echo "  (* = already in $dest)"
  exit 0
fi

if [ "$mode" = all ]; then
  args=()
  while IFS= read -r s; do args+=("$s"); done < <(skills)
fi
mkdir -p "$dest"
for s in "${args[@]}"; do
  src="$repo/$s"
  [ -f "$src/SKILL.md" ] || { echo "no such skill: $s" >&2; exit 1; }
  link="$dest/$s"
  marker="$link/.installed-from-my-skills"
  if [ "$mode" = remove ]; then
    if [ -L "$link" ]; then rm "$link"; echo "removed  $s"
    elif [ -f "$marker" ]; then rm -rf "$link"; echo "removed  $s (copy)"
    elif [ -e "$link" ]; then echo "kept     $s ($link is not a symlink; remove it yourself)"
    else echo "absent   $s"; fi
  elif [ "$copy" = 1 ]; then
    if [ -e "$link" ] && [ ! -f "$marker" ]; then
      echo "kept     $s ($link exists and wasn't copied by this script; remove it first)" >&2; continue
    fi
    rm -rf "$link" && cp -R "$src" "$link"
    (cd "$repo" && git rev-parse --short HEAD 2>/dev/null || echo unknown) > "$marker"
    echo "copied   $s -> $link (my-skills $(cat "$marker"))"
  elif [ -L "$link" ]; then
    ln -sfn "$src" "$link"; echo "updated  $s -> $link"
  elif [ -e "$link" ]; then
    echo "kept     $s ($link exists and is not a symlink; remove it first)" >&2
  else
    ln -s "$src" "$link"; echo "installed $s -> $link"
  fi
done
