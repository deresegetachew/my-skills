#!/usr/bin/env python3
"""Prints the next build-plan task: the first unticked task, in order, that isn't in the blocked list.

  python3 .claude/hooks/next_task.py           -> "1.3 Validators"   (exit 1 when nothing is left)
  python3 .claude/hooks/next_task.py --json    -> {"id": "1.3", "title": "Validators", "remaining": 7, ...}
  python3 .claude/hooks/next_task.py --after 1.3   -> the next one after 1.3 (to work around a blocked PR)
  Rework comes first: an open PR whose latest must-fix (`<!-- factory-mustfix sha=<head> -->` or a `factory-msg` of kind mustfix) from the dev manager
  names its current head commit (nothing pushed since) is printed as "pr-42 Rework #42: <title> (<branch>)".
  A PR with the `holdLabel` label (default `factory-hold`) is the dev manager's to review: it's never rework.
  python3 .claude/hooks/next_task.py --note    -> what `factory next` runs: the same line, then "Not claimed. To claim it: ..."
  python3 .claude/hooks/next_task.py --claim taytu --pid 123
      -> the first task no other running loop holds, claimed for taytu (factory-loop.sh does this; see
         factory_claims.py). Exit 1 when every open task is done, blocked or held by another loop.

Issues mode (`tasks.source: "issues"`): tasks are GitHub issues (factory_issues.py). Rework still comes first; then
the agent's own in-progress issue, else the next `factory:ready` one, claimed on GitHub: "issue-42 <title>".

Reads the plan and blocked list from the main branch when it can (`git show origin/<main>:...`), so a stale
working copy can't make the agent skip or repeat a task.
"""
import argparse, json, os, re, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from factory_config import blocked_ids, load, task_source, tasks  # noqa: E402


def read(cfg, path):
    p = subprocess.run(["git", "show", f"origin/{cfg['mainBranch']}:{path}"], capture_output=True, text=True)
    if p.returncode == 0:
        return p.stdout
    try:
        return open(path).read()
    except FileNotFoundError:
        return ""


def rework(cfg):
    """[(id, title)] for open PRs with a must-fix on their current head commit, oldest first. Needs `gh`."""
    def gh(path):
        p = subprocess.run(["gh", "api", "--paginate", path], capture_output=True, text=True)
        if p.returncode != 0:
            return []
        try:
            return json.loads(p.stdout.replace("][", ","))
        except json.JSONDecodeError:
            return []
    out = []
    import factory_messages as fm
    hold = cfg.get("holdLabel", "factory-hold")
    for pr in sorted(gh("repos/{owner}/{repo}/pulls?state=open&per_page=100"), key=lambda p: p["number"]):
        if any(label.get("name") == hold for label in pr.get("labels", [])):
            continue  # the dev manager is reviewing it: not rework, and nothing for an agent to do
        shas = [sha for c in gh(f"repos/{{owner}}/{{repo}}/issues/{pr['number']}/comments?per_page=100")
                for kind, sha in fm.verdicts(c.get("body") or "") if kind == "mustfix" and sha]  # either form
        if shas and pr["head"]["sha"].startswith(shas[-1]):
            out.append((f"pr-{pr['number']}", f"Rework #{pr['number']}: {pr['title']} ({pr['head']['ref']})"))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--after", default=None, help="skip tasks up to and including this id")
    ap.add_argument("--claim", default=None, metavar="AGENT", help="claim the task for this loop")
    ap.add_argument("--pid", default=None, help="the loop's process id, with --claim")
    ap.add_argument("--note", action="store_true", help="end a text answer with a line saying nothing was claimed (factory next)")
    ap.add_argument("--no-rework", action="store_true", help="plan tasks only, skip PRs with a must-fix")
    a = ap.parse_args()
    cfg = load()
    subprocess.run(["git", "fetch", "-q", "origin", cfg["mainBranch"]], capture_output=True)
    if task_source(cfg) == "issues":
        return issues_mode(cfg, a)
    all_tasks = tasks(read(cfg, cfg["plan"]))
    blocked = blocked_ids(read(cfg, cfg["blocked"]))
    open_tasks = [(i, t) for i, done, t in all_tasks if not done and i not in blocked]
    if a.after:
        ids = [i for i, _ in open_tasks]
        open_tasks = open_tasks[ids.index(a.after) + 1:] if a.after in ids else open_tasks
    remaining = len(open_tasks)
    if not a.no_rework and not a.after:
        open_tasks = rework(cfg) + open_tasks  # fixing a reviewed PR comes before new work
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
        note(a)


def note(a):
    """`factory next` only looks: say so, and show the command that claims. Other programs read one line, so only --note adds it."""
    if a.note and not a.claim:
        who = os.environ.get("FACTORY_AGENT") or "<your-agent-name>"
        print(f"Not claimed. To claim it: python3 .claude/hooks/next_task.py --claim {who} --pid $$")


def issues_mode(cfg, a):
    import factory_issues
    jobs = [] if a.no_rework else rework(cfg)
    if jobs and a.claim:
        from factory_claims import claim_task
        tid = claim_task([i for i, _ in jobs], a.claim, a.pid or os.getppid(), cfg)
        jobs = [(i, t) for i, t in jobs if i == tid]
    if not jobs:
        if a.claim:
            i = factory_issues.pick(cfg, a.claim)
        else:
            ready = factory_issues.ready_issues(cfg)
            i = ready[0] if ready else None
        if i:
            jobs = [(f"issue-{i['number']}", i["title"])]
            if a.claim:
                subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "factory_agents.py"),
                                "ping", "--agent", a.claim, "--status", f"working on #{i['number']}"],
                               capture_output=True, timeout=60)
    if not jobs:
        print(json.dumps({"id": None, "remaining": 0}) if a.json else "none")
        sys.exit(1)
    tid, title = jobs[0]
    print(json.dumps({"id": tid, "title": title}) if a.json else f"{tid} {title}")
    if not a.json:
        note(a)


if __name__ == "__main__":
    main()
