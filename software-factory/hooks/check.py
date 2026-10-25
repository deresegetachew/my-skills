#!/usr/bin/env python3
"""Stop hook: don't let a turn end with a broken build.

Runs the project's typecheck and test commands (from .claude/factory.json) only when files under
`codePaths` changed. `commands.typecheckChanged` and `commands.testChanged`, when set, run instead, for the
changed packages only. Before them it runs `commands.fix` on the changed files (#69, `factory_fix.py`), so style never
costs a turn; the agent hears "formatted 3 files" and nothing more. Exit 2 sends the failure back to Claude so it fixes it before stopping: the lines that
name a failure first, then the end of the output, `checkOutputLines` in all.

After a green run it remembers what it checked (HEAD, every tracked change, every untracked file that isn't ignored,
the commands, and when each `checkRequires` path last changed) in the git folder, and skips the next Stop if all of
that is the same. A failure is never remembered. Other ignored files (`.env`, build output) aren't in it.
"""
import hashlib, json, os, re, subprocess, sys

sys.path.insert(0, os.path.dirname(__file__))
from factory_config import load  # noqa: E402
from factory_run_check import excerpt, line_limit, write_log  # noqa: E402
import factory_fix  # noqa: E402

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

# Format and auto-fix the files this branch changed, before anything is compared or run. What it did is one line.
fix_rc, fix_msg = factory_fix.run(cfg)
if fix_rc != 0:
    print(fix_msg, file=sys.stderr)
    sys.exit(2)
if fix_msg:
    print(json.dumps({"systemMessage": f"factory: {fix_msg}."}))
note = f"({fix_msg}.) " if fix_msg else ""


def sh(cmd):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True)


def git(*a):  # paths go as arguments, never into a shell string
    return subprocess.run(["git", *a], capture_output=True, text=True)


changed = git("diff", "--quiet", "HEAD", "--", *paths).returncode != 0
untracked = git("ls-files", "--others", "--exclude-standard", "--", *paths).stdout.strip()
if not changed and not untracked:
    sys.exit(0)


def fingerprint(commands):
    """What a green run covered: HEAD, the commands, the whole tracked diff (a root tsconfig.json or lockfile counts
    too), each untracked file that isn't ignored, and when each `checkRequires` path last changed (an install)."""
    h = hashlib.sha256()
    h.update(git("rev-parse", "HEAD").stdout.encode())
    h.update(json.dumps(commands, sort_keys=True).encode())
    h.update(subprocess.run(["git", "diff", "--binary", "HEAD"], capture_output=True).stdout)
    names = subprocess.run(["git", "ls-files", "-z", "--others", "--exclude-standard"], capture_output=True).stdout
    for name in sorted(n for n in names.split(b"\0") if n):
        h.update(name + b"\0")
        try:
            with open(name, "rb") as f:
                h.update(hashlib.sha256(f.read()).digest())
        except OSError:
            h.update(b"?")
    for p in needs:
        try:
            h.update(f"{p}:{os.stat(p).st_mtime_ns}".encode())
        except OSError:
            h.update(f"{p}:-".encode())
    return h.hexdigest()


# In the git folder: one per worktree, never in the working tree, never committed.
last_green = git("rev-parse", "--git-path", "factory-check-green").stdout.strip()
commands = [cfg["commands"].get(f"{n}Changed") or cfg["commands"].get(n) or "" for n in ("typecheck", "test")]
current = fingerprint(commands)
try:
    if last_green and open(last_green).read().strip() == current:
        sys.exit(0)  # nothing changed since the last green check
except OSError:
    pass

limit = line_limit(cfg)
for name in ("typecheck", "test"):
    cmd = cfg["commands"].get(f"{name}Changed") or cfg["commands"].get(name)
    if not cmd:
        continue
    r = sh(cmd)
    if r.returncode != 0:
        text = r.stdout + r.stderr
        out = excerpt(text, limit)
        log = write_log(cfg, name, f"$ {cmd}\n{text}")
        more = f" Full log: {log}" if log else ""
        print(f"{note}`{cmd}` fails. Fix it before finishing:{more}\n" + "\n".join(out), file=sys.stderr)
        sys.exit(2)
try:
    if last_green:
        with open(last_green, "w") as f:
            f.write(current + "\n")
except OSError:
    pass  # can't remember it: the next Stop just runs the check again
sys.exit(0)
