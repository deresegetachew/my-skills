#!/usr/bin/env python3
"""Judging CI the way the dev manager does (#96): from a commit's check runs, take for each job name only the newest
run that is not `skipped`; the commit is green only when every one of those succeeded.

A re-run that passed replaces the failed run before it; a skipped job (a path filter, a cancelled duplicate) counts for
nothing; a job still queued or running is not green yet; a commit with no runs at all is not green (CI may not have
started). Commit statuses (the older API) are judged the same way by context.

  python3 factory_ci_judge.py <sha>       prints "green", "pending: <jobs>", "failed: <jobs>" or "none"; exit 0 only on green
"""
import json, os, subprocess, sys

OK = {"success"}


def judge(runs, statuses=()):
    """("green" | "pending" | "failed" | "none", [job names]) from check runs and commit statuses."""
    newest = {}
    for r in runs:
        if r.get("conclusion") == "skipped":
            continue
        key = r.get("name") or ""
        rank = (r.get("started_at") or r.get("created_at") or "", int(r.get("id") or 0))
        if key not in newest or rank > newest[key][0]:
            newest[key] = (rank, r)
    jobs = {k: ("pending" if v.get("status") != "completed" else "ok" if v.get("conclusion") in OK else "failed")
            for k, (_, v) in newest.items()}
    latest = {}
    for s in statuses:
        key = s.get("context") or ""
        rank = (s.get("updated_at") or s.get("created_at") or "", int(s.get("id") or 0))
        if key not in latest or rank > latest[key][0]:
            latest[key] = (rank, s)
    for k, (_, s) in latest.items():
        jobs[k] = {"success": "ok", "pending": "pending"}.get(s.get("state"), "failed")
    if not jobs:
        return "none", []
    failed = sorted(k for k, v in jobs.items() if v == "failed")
    pending = sorted(k for k, v in jobs.items() if v == "pending")
    if failed:
        return "failed", failed
    if pending:
        return "pending", pending
    return "green", sorted(jobs)


def gh_json(path):
    p = subprocess.run(["gh", "api", "--paginate", path], capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError((p.stderr or p.stdout).strip()[:300] or f"gh api {path} failed")
    text = p.stdout.strip()
    if not text:
        return []
    try:
        return json.loads(text)
    except ValueError:  # --paginate prints one JSON document per page
        out = []
        dec, i = json.JSONDecoder(), 0
        while i < len(text):
            obj, n = dec.raw_decode(text[i:])
            out.append(obj)
            i += n
            while i < len(text) and text[i].isspace():
                i += 1
        return out


def pages(path, key):
    got = gh_json(path)
    items = []
    for page in (got if isinstance(got, list) else [got]):
        items += page.get(key, []) if isinstance(page, dict) else [page]
    return items


def state(sha, repo="repos/{owner}/{repo}"):
    """judge() for a commit on GitHub. Raises RuntimeError when GitHub can't be read."""
    runs = pages(f"{repo}/commits/{sha}/check-runs?per_page=100", "check_runs")
    statuses = pages(f"{repo}/commits/{sha}/status?per_page=100", "statuses")
    return judge(runs, statuses)


def main(argv):
    if len(argv) != 1:
        print(__doc__, file=sys.stderr)
        return 2
    try:
        verdict, jobs = state(argv[0])
    except RuntimeError as e:
        print(f"unknown: {e}")
        return 1
    print("green" if verdict == "green" else f"{verdict}: {', '.join(jobs)}" if jobs else verdict)
    return 0 if verdict == "green" else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
