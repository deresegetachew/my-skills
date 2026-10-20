#!/usr/bin/env python3
"""Prints the next build-plan task: the first unticked task, in order, that isn't in the blocked list.

  python3 .claude/hooks/next_task.py           -> "1.3 Validators"   (exit 1 when nothing is left)
  python3 .claude/hooks/next_task.py --json    -> {"id": "1.3", "title": "Validators", "remaining": 7, ...}
  python3 .claude/hooks/next_task.py --after 1.3   -> the next one after 1.3 (to work around a blocked PR)
  python3 .claude/hooks/next_task.py --claim agent-2 --pid 123
      -> the first task no other running loop holds, claimed for agent-2 (factory-loop.sh does this; see
         factory_claims.py). Exit 1 when every open task is done, blocked or held by another loop.

Reads the plan and blocked list from the main branch when it can (`git show origin/<main>:...`), so a stale
working copy can't make the agent skip or repeat a task.
"""
import argparse, json, os, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from factory_config import blocked_ids, load, tasks  # noqa: E402


def read(cfg, path):
    p = subprocess.run(["git", "show", f"origin/{cfg['mainBranch']}:{path}"], capture_output=True, text=True)
    if p.returncode == 0:
        return p.stdout
    try:
        return open(path).read()
    except FileNotFoundError:
        return ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--after", default=None, help="skip tasks up to and including this id")
    ap.add_argument("--claim", default=None, metavar="AGENT", help="claim the task for this loop")
    ap.add_argument("--pid", default=None, help="the loop's process id, with --claim")
    a = ap.parse_args()
    cfg = load()
    subprocess.run(["git", "fetch", "-q", "origin", cfg["mainBranch"]], capture_output=True)
    all_tasks = tasks(read(cfg, cfg["plan"]))
    blocked = blocked_ids(read(cfg, cfg["blocked"]))
    open_tasks = [(i, t) for i, done, t in all_tasks if not done and i not in blocked]
    if a.after:
        ids = [i for i, _ in open_tasks]
        open_tasks = open_tasks[ids.index(a.after) + 1:] if a.after in ids else open_tasks
    remaining = len(open_tasks)
    if a.claim and open_tasks:
        from factory_claims import claim_task
        tid = claim_task([i for i, _ in open_tasks], a.claim, a.pid or os.getppid(), cfg)
        open_tasks = [(i, t) for i, t in open_tasks if i == tid]
    if not open_tasks:
        print(json.dumps({"id": None, "remaining": 0, "blocked": sorted(blocked)}) if a.json else "none")
        sys.exit(1)
    tid, title = open_tasks[0]
    if a.json:
        print(json.dumps({"id": tid, "title": title, "remaining": remaining, "blocked": sorted(blocked)}))
    else:
        print(f"{tid} {title}")


if __name__ == "__main__":
    main()
