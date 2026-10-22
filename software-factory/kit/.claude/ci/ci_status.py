#!/usr/bin/env python3
"""The GitHub side of `factory ci status`: recent CI runs on main and on open pull requests, anything queued for
long, and (local mode) the runners registered with this project's label.

  python3 ci_status.py --repo owner/name --label remanual-local [--local] [--now 2026-10-22T12:00:00Z]

Reads GitHub through `gh api`. Prints plain lines; exit 0 even when GitHub can't be read (it says so).
"""
import argparse, json, subprocess
from datetime import datetime, timezone

QUEUED_LONG_MIN = 15  # a run queued longer than this is called out


def gh(path):
    p = subprocess.run(["gh", "api", path], capture_output=True, text=True)
    if p.returncode != 0:
        return None
    try:
        return json.loads(p.stdout)
    except json.JSONDecodeError:
        return None


def when(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def ago(t, now):
    m = int((now - t).total_seconds() // 60)
    return f"{m} min ago" if m < 120 else f"{m // 60} h ago"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--label", required=True)
    ap.add_argument("--local", action="store_true")
    ap.add_argument("--now", default=None)
    a = ap.parse_args()
    now = when(a.now) if a.now else datetime.now(timezone.utc)

    runs = gh(f"repos/{a.repo}/actions/runs?per_page=50")
    pulls = gh(f"repos/{a.repo}/pulls?state=open&per_page=100")
    repo = gh(f"repos/{a.repo}")
    if runs is None or pulls is None:
        print("CI runs: GitHub can't be read right now (gh offline or logged out).")
        return 0
    main_branch = (repo or {}).get("default_branch", "main")
    branches = {main_branch: "main"} | {p["head"]["ref"]: f"#{p['number']}" for p in pulls}
    latest = {}
    for r in runs.get("workflow_runs", []):
        b = r.get("head_branch")
        if b in branches and b not in latest:
            latest[b] = r
    print("CI runs (latest per branch):")
    if not latest:
        print("  none on main or on open pull requests")
    for b, r in latest.items():
        state = r.get("conclusion") or r.get("status")
        print(f"  {branches[b]:<6} {state:<11} {r.get('name', '')} on {b}, {ago(when(r['created_at']), now)}")

    queued = [r for r in runs.get("workflow_runs", []) if r.get("status") in ("queued", "waiting", "pending")]
    old = [r for r in queued if (now - when(r["created_at"])).total_seconds() >= QUEUED_LONG_MIN * 60]
    online = None
    if a.local:
        data = gh(f"repos/{a.repo}/actions/runners?per_page=100")
        mine = [x for x in (data or {}).get("runners", [])
                if a.label in {lab.get("name") for lab in x.get("labels", [])}]
        print(f"Runners on GitHub with the label {a.label}:" if data is not None
              else "Runners on GitHub: can't be read (it needs admin on the repository).")
        for x in mine:
            print(f"  {x['name']}: {x['status']}{', busy' if x.get('busy') else ''}")
        if data is not None and not mine:
            print("  none registered right now")
        online = None if data is None else [x for x in mine if x.get("status") == "online"]
    if old:
        longest = max(int((now - when(r["created_at"])).total_seconds() // 60) for r in old)
        msg = f"Waiting: {len(old)} run{'s' if len(old) > 1 else ''} queued for up to {longest} min"
        if a.local and online == []:
            msg += f", and no runner with the label {a.label} is online. Is the runner running (factory ci status " \
                   "above), Docker up and the machine awake? `factory ci use github` sends jobs back to GitHub."
        print(msg)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
