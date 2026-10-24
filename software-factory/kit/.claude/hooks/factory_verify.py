#!/usr/bin/env python3
"""`factory verify`: run what CI runs, here, for the current commit, before a pull request (#58).

Runs `commands.ci` from .claude/factory.json (for example
`pnpm turbo run typecheck lint test build --filter=...[{base}]`, where `{base}` becomes `origin/<main>`). When it
passes on a clean working tree, it records the commit in <reviewMarkers>/<branch>.ci.ok. The PR gate needs that
mark for `gh pr create` and `gh pr ready` when main's factory.json sets `commands.ci`; drafts don't.

  python3 .claude/hooks/factory_verify.py        exit 0: passed (or nothing to run); 1: it fails or can't run
"""
import os, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from factory_config import load  # noqa: E402


def git(*a):
    p = subprocess.run(["git", *a], capture_output=True, text=True)
    return p.returncode, p.stdout.strip()


def tail(text, limit):
    lines = [l for l in text.strip().splitlines() if l.strip()]
    return lines[-limit:]


def main():
    cfg = load()
    cmd = (cfg.get("commands") or {}).get("ci") or ""
    if not cmd:
        print("commands.ci isn't set in .claude/factory.json, so there is nothing to run. Set it to what CI runs.")
        return 0
    rc, branch = git("branch", "--show-current")
    if rc != 0 or not branch:
        print("factory verify: check out the task branch first (no branch here).", file=sys.stderr)
        return 1
    # The mark says "this commit passed", so the files must be that commit: nothing uncommitted.
    rc, dirty = git("status", "--porcelain", "--untracked-files=no")
    if rc != 0 or dirty:
        print("factory verify: commit your changes first. The pass is recorded for a commit, and these files "
              "aren't in it:\n" + dirty, file=sys.stderr)
        return 1
    head = git("rev-parse", "HEAD")[1]
    run_cmd = cmd.replace("{base}", f"origin/{cfg['mainBranch']}")
    print(f"factory verify: {run_cmd}", flush=True)
    p = subprocess.run(run_cmd, shell=True, capture_output=True, text=True)
    try:
        limit = max(int(cfg.get("checkOutputLines") or 40), 1)
    except (TypeError, ValueError):
        limit = 40
    if p.returncode != 0:
        print(f"`{run_cmd}` fails, so CI would fail too. The last lines:\n"
              + "\n".join(tail(p.stdout + p.stderr, limit)), file=sys.stderr)
        return 1
    if git("rev-parse", "HEAD")[1] != head or git("status", "--porcelain", "--untracked-files=no")[1]:
        print("factory verify: the commit or the files changed while it ran; run it again.", file=sys.stderr)
        return 1
    d = cfg["reviewMarkers"]
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, branch.replace("/", "_") + ".ci.ok"), "w") as f:
        f.write(head + "\n")
    print(f"factory verify: passed for {head[:12]} on {branch}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
