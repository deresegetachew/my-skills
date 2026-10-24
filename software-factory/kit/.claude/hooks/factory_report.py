#!/usr/bin/env python3
"""`factory report`: how long each task took and how often it went round, from GitHub (#65). The tokens are in
`factory usage`, from this machine's logs; this is the part GitHub knows, the same on every machine.

Per task pull request (branch task/<id>-...) opened since the cut-off:
  claim -> PR     issues mode: from the agent's last claim comment on the issue before the PR opened
  PR -> merge     from opening the PR to merging it (open: so far; closed unmerged: "closed")
  rework          the dev manager's must-fix comments on the PR (each one is a round of rework)
  CI runs         workflow runs on the PR's branch, and how many of them failed

  factory report                  the last 7 days
  factory report --since 2026-10-20
  factory report --json           the same as JSON

Reads only, through `gh api`.
"""
import argparse, json, os, re, statistics, subprocess, sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from factory_config import branch_task, load, task_source  # noqa: E402

CLAIM = re.compile(r"<!--\s*factory-claim\s+agent=([\w.-]+)\s*-->")
MUSTFIX = re.compile(r"<!--\s*factory-mustfix\b")


def gh(path):
    p = subprocess.run(["gh", "api", path], capture_output=True, text=True)
    if p.returncode != 0:
        raise SystemExit(f"factory report: gh api {path.split('?')[0]} failed: {(p.stderr or p.stdout).strip()[:200]}")
    return json.loads(p.stdout) if p.stdout.strip() else None


def when(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")) if s else None


def hours(a, b):
    return round((b - a).total_seconds() / 3600, 1) if a and b else None


def pulls_since(cut):
    """Task PRs opened at or after `cut`, newest first (the list is sorted by creation, so stop at the first older)."""
    out, page = [], 1
    while True:
        chunk = gh(f"repos/{{owner}}/{{repo}}/pulls?state=all&sort=created&direction=desc&per_page=100&page={page}") or []
        for p in chunk:
            if when(p["created_at"]) < cut:
                return out
            if branch_task(p["head"]["ref"]):
                out.append(p)
        if len(chunk) < 100:
            return out
        page += 1


def row(p, issues_mode, now):
    branch, opened = p["head"]["ref"], when(p["created_at"])
    tid = branch_task(branch)
    claimed, agent = None, None
    if issues_mode:
        for c in gh(f"repos/{{owner}}/{{repo}}/issues/{tid.split('.')[0]}/comments?per_page=100") or []:
            m = CLAIM.search(c.get("body") or "")
            if m and when(c["created_at"]) <= opened:
                claimed, agent = when(c["created_at"]), m.group(1)
    comments = gh(f"repos/{{owner}}/{{repo}}/issues/{p['number']}/comments?per_page=100") or []
    runs = (gh(f"repos/{{owner}}/{{repo}}/actions/runs?branch={quote(branch, safe='')}&per_page=100") or {}).get("workflow_runs", [])
    merged = when(p.get("merged_at"))
    state = "merged" if merged else ("closed" if p.get("state") == "closed" else "open")
    return {"task": tid, "pr": p["number"], "agent": agent, "state": state,
            "claimToPr": hours(claimed, opened),
            "prToMerge": hours(opened, merged) if merged else (hours(opened, now) if state == "open" else None),
            "claimToMerge": hours(claimed, merged),
            "rework": sum(1 for c in comments if MUSTFIX.search(c.get("body") or "")),
            "ciRuns": len(runs), "ciFailed": sum(1 for r in runs if r.get("conclusion") == "failure")}


def cell(v, unit="h"):
    return "-" if v is None else f"{v}{unit}"


def show(rows, cut):
    print(f"Task pull requests opened since {cut:%Y-%m-%d}: {len(rows)}")
    if not rows:
        return
    print(f"{'task':<8} {'PR':<6} {'state':<7} {'claim->PR':>10} {'PR->merge':>13} {'rework':>7} {'CI runs':>14}  agent")
    for r in rows:
        merge = cell(r["prToMerge"]) + (" so far" if r["state"] == "open" else "")
        print(f"{r['task']:<8} #{r['pr']:<5} {r['state']:<7} {cell(r['claimToPr']):>10} {merge:>13} "
              f"{r['rework']:>7} {str(r['ciRuns']) + (' (' + str(r['ciFailed']) + ' failed)' if r['ciFailed'] else ''):>14}"
              f"  {r['agent'] or '-'}")
    done = [r for r in rows if r["state"] == "merged"]
    if done:
        med = lambda k: statistics.median([r[k] for r in done if r[k] is not None] or [0])
        print(f"Merged: {len(done)}. Median PR->merge {med('prToMerge')}h"
              + (f", claim->merge {med('claimToMerge')}h" if any(r["claimToMerge"] is not None for r in done) else "")
              + f". Rework rounds {sum(r['rework'] for r in done)}, CI runs {sum(r['ciRuns'] for r in done)} "
                f"({sum(r['ciFailed'] for r in done)} failed).")


def main():
    ap = argparse.ArgumentParser(description="Per-task timings, rework rounds and CI runs, from GitHub.")
    ap.add_argument("--since", help="a date (2026-10-20) or a number of days (7d); default 7d", default="7d")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    cfg = load()
    now = datetime.now(timezone.utc)
    m = re.fullmatch(r"(\d+)d", a.since)
    cut = now - timedelta(days=int(m.group(1))) if m else datetime.fromisoformat(a.since).replace(tzinfo=timezone.utc)
    issues_mode = task_source(cfg) == "issues"
    with ThreadPoolExecutor(8) as pool:
        rows = list(pool.map(lambda p: row(p, issues_mode, now), pulls_since(cut)))
    if a.json:
        print(json.dumps({"since": cut.strftime("%Y-%m-%d"), "tasks": rows}, indent=2))
    else:
        show(rows, cut)
    return 0


if __name__ == "__main__":
    sys.exit(main())
