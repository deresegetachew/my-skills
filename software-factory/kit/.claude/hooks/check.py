#!/usr/bin/env python3
"""Stop hook: don't let a turn end with a broken build.

Runs the project's typecheck and test commands (from .claude/factory.json) only when files under
`codePaths` changed. Exit 2 sends the failure back to Claude so it fixes it before stopping.
"""
import json, os, subprocess, sys

sys.path.insert(0, os.path.dirname(__file__))
from factory_config import load  # noqa: E402

try:
    data = json.load(sys.stdin)
except ValueError:
    data = {}
if data.get("stop_hook_active"):
    sys.exit(0)  # already continuing because of this hook; don't loop
cfg = load()
# Not installed yet (a fresh clone or worktree): nothing to check until `commands.install` has run.
needs = cfg.get("checkRequires", [])
if any(not os.path.exists(p) for p in needs):
    sys.exit(0)
paths = [p for p in cfg["codePaths"] if os.path.exists(p)]
if not paths:
    sys.exit(0)  # no code yet


def sh(cmd):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True)


def git(*a):  # paths go as arguments, never into a shell string
    return subprocess.run(["git", *a], capture_output=True, text=True)


changed = git("diff", "--quiet", "HEAD", "--", *paths).returncode != 0
untracked = git("ls-files", "--others", "--exclude-standard", "--", *paths).stdout.strip()
if not changed and not untracked:
    sys.exit(0)

for name in ("typecheck", "test"):
    cmd = cfg["commands"].get(name)
    if not cmd:
        continue
    r = sh(cmd)
    if r.returncode != 0:
        out = (r.stdout + r.stderr).strip().splitlines()[-40:]
        print(f"`{cmd}` fails. Fix it before finishing:\n" + "\n".join(out), file=sys.stderr)
        sys.exit(2)
sys.exit(0)
