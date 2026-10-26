#!/usr/bin/env python3
"""`factory review-pass <kind>`: a review agent records its pass for the current commit (#197).

  python3 .claude/hooks/factory_review_pass.py reviewer     writes <reviewMarkers>/<branch>.ok
  python3 .claude/hooks/factory_review_pass.py arch         writes <reviewMarkers>/<branch>.arch.ok

The file holds HEAD's id. The PR gate reads it. The agent runs only this one command, so no chained shell, `mkdir`,
`cd` or `git rev-parse` has to be allowed. Run it only when there is no must-fix item, for a commit you reviewed.
Exit 0: written; 1: not written (no branch, or no commit), with `{code, message, fix}` on stderr.
"""
import json, os, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from factory_config import load  # noqa: E402

SUFFIX = {"reviewer": ".ok", "arch": ".arch.ok"}


def git(*a):
    p = subprocess.run(["git", *a], capture_output=True, text=True)
    return p.returncode, p.stdout.strip()


def refuse(code, message, fix):
    print(json.dumps({"code": code, "message": message, "fix": fix}), file=sys.stderr)
    return 1


def main(argv):
    if len(argv) != 1 or argv[0] not in SUFFIX:
        return refuse("bad-kind", "Say which review passed: reviewer or arch.",
                      "Run: python3 .claude/hooks/factory_review_pass.py reviewer (or arch).")
    rc, branch = git("branch", "--show-current")
    if rc != 0 or not branch:
        return refuse("no-branch", "There is no task branch checked out here.", "Check out the task branch and try again.")
    rc, head = git("rev-parse", "HEAD")
    if rc != 0 or not head:
        return refuse("no-commit", "This branch has no commit to pass.", "Commit the change, then ask for the review.")
    cfg = load()
    d = cfg["reviewMarkers"]
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, branch.replace("/", "_") + SUFFIX[argv[0]])
    with open(path, "w") as f:
        f.write(head + "\n")
    rc, dirty = git("status", "--porcelain", "--untracked-files=no")
    print(f"{argv[0]} pass recorded for {head[:12]} on {branch}: {path}")
    if dirty:
        print("Note: tracked files have uncommitted changes. The pass names the commit, not those changes.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
