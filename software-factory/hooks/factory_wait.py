#!/usr/bin/env python3
"""Token-free waiting. A Claude session that waits by checking again and again pays for every check (each turn
re-sends the whole context), so every wait is a shell loop here that only returns when there is something to do,
with one short line. Exit codes: 0 = it happened, 2 = timed out (do other work), 1 = it can't happen (see the line),
3 = the PR is closed or merged, 4 = CI never started (billing; see factory_ci.py).

  factory_wait.py ci <pr> [minutes]       until every check on the PR's head commit has finished: 0 green, 1 failed
  factory_wait.py answer <pr> [minutes]   until every `<!-- factory-question -->` on the PR has a later
                                          `<!-- factory-answer -->` (1 when nothing is asked)
  factory_wait.py slot [minutes]          until this account has fewer than `maxOpenPRs` ready PRs open
  factory_wait.py ready [minutes]         until a task is ready to take (issues mode): prints "issue-N title"
  factory_wait.py precheck                for the dev manager: exit 0 and "nothing to do" when no PR has an unreviewed
                                          commit, no question waits and no agent went quiet; else exit 3, one line each

Waits default to 30 minutes and look every FACTORY_WAIT_START seconds (default 15), growing by half each time up to
FACTORY_WAIT_MAX seconds (default 60). Everything goes through the GitHub REST API (`gh api`).
"""
import os, re, sys, time
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import factory_issues as fi  # noqa: E402
from factory_config import load, task_labels  # noqa: E402

QUESTION = re.compile(r"<!--\s*factory-question\b")
ANSWER = re.compile(r"<!--\s*factory-answer(?!-)\b")  # not factory-answer-claim
REVIEWED = re.compile(r"<!--\s*(?:factory-approved|factory-mustfix|pr-watch)\s+sha=([0-9a-f]{7,40})")
BAD = {"failure", "startup_failure", "timed_out", "cancelled", "action_required", "stale"}


def wait_until(check, minutes):
    """Calls check() with a growing pause until it returns something (not None) or the minutes are up."""
    delay = float(os.environ.get("FACTORY_WAIT_START", 15))
    cap = float(os.environ.get("FACTORY_WAIT_MAX", 60))
    end = time.monotonic() + minutes * 60
    while True:
        got = check()
        if got is not None:
            return got
        if time.monotonic() + delay > end:
            return None
        time.sleep(delay)
        delay = min(delay * 1.5, cap)


def pr_of(n):
    return fi.gh("GET", f"repos/{{owner}}/{{repo}}/pulls/{n}")


def ci_state(sha):
    """('green' | 'failed' | 'pending', detail) for the commit, from its check runs and commit statuses."""
    runs = fi.gh("GET", f"repos/{{owner}}/{{repo}}/commits/{sha}/check-runs?per_page=100").get("check_runs", [])
    st = fi.gh("GET", f"repos/{{owner}}/{{repo}}/commits/{sha}/status?per_page=100").get("statuses", [])
    bad = [r["name"] for r in runs if r.get("conclusion") in BAD] + [s["context"] for s in st if s["state"] in ("failure", "error")]
    if bad:
        return "failed", ", ".join(bad)
    if not runs and not st:
        return "pending", "no checks yet"
    waiting = [r["name"] for r in runs if r.get("status") != "completed"] + [s["context"] for s in st if s["state"] == "pending"]
    if waiting:
        return "pending", ", ".join(waiting)
    return "green", f"{len(runs) + len(st)} checks"


def wait_ci(n, minutes):
    seen = {}

    def check():
        pr = pr_of(n)
        if pr["state"] != "open":
            return 3, f"PR #{n} is {'merged' if pr.get('merged') else 'closed'}"
        sha = pr["head"]["sha"]
        state, detail = ci_state(sha)
        seen["last"] = detail
        if state == "green":
            return 0, f"PR #{n}: CI green ({detail}) on {sha[:7]}"
        if state == "failed":
            import factory_ci
            if factory_ci.not_started(sha):
                return 4, f"PR #{n}: CI didn't run on {sha[:7]} (GitHub didn't start the jobs). Run: python3 .claude/hooks/factory_ci.py {sha}"
            return 1, f"PR #{n}: CI failed on {sha[:7]}: {detail}"
        return None

    return wait_until(check, minutes) or (2, f"PR #{n}: CI still running after {minutes} minutes ({seen.get('last', '?')})")


def open_questions(n):
    """Comments with a question and no later answer, oldest first."""
    asked = []
    for c in fi.gh_all(f"repos/{{owner}}/{{repo}}/issues/{n}/comments"):
        body = c.get("body") or ""
        if QUESTION.search(body):
            asked.append(c)
        elif ANSWER.search(body):
            asked = []  # the dev manager answers what is open at that point
    return asked


def wait_answer(n, minutes):
    if not open_questions(n):
        return 1, f"PR #{n}: no question is waiting for an answer"
    got = wait_until(lambda: None if open_questions(n) else (0, f"PR #{n}: answered. Read it: gh api repos/{{owner}}/{{repo}}/issues/{n}/comments"), minutes)
    return got or (2, f"PR #{n}: still no answer after {minutes} minutes; carry on with other work")


def my_ready_prs():
    me = (fi.gh("GET", "user") or {}).get("login")
    return sorted(p["number"] for p in fi.gh_all("repos/{owner}/{repo}/pulls?state=open")
                  if not p.get("draft") and (p.get("user") or {}).get("login") == me)


def wait_slot(minutes, cfg):
    cap = int(cfg.get("maxOpenPRs", 3))

    def check():
        ready = my_ready_prs()
        return (0, f"a PR slot is free ({len(ready)} of {cap} open)") if len(ready) < cap else None

    return wait_until(check, minutes) or (2, f"still {cap} of {cap} PRs open after {minutes} minutes: " + ", ".join(f"#{x}" for x in my_ready_prs()))


def wait_ready(minutes, cfg):
    def check():
        found = fi.ready_issues(cfg)
        return (0, f"issue-{found[0]['number']} {found[0]['title']}") if found else None

    return wait_until(check, minutes) or (2, f"no task became ready in {minutes} minutes")


def precheck(cfg):
    """What the dev manager has to do right now, one line each; empty when nothing. Reads GitHub only."""
    todo = []
    prs = fi.gh_all("repos/{owner}/{repo}/pulls?state=open")
    for p in prs:
        n, sha = p["number"], p["head"]["sha"]
        comments = fi.gh_all(f"repos/{{owner}}/{{repo}}/issues/{n}/comments")
        if not p.get("draft"):
            marks = [m for c in comments for m in REVIEWED.findall(c.get("body") or "")]
            if not any(sha.startswith(m) or m.startswith(sha) for m in marks):
                todo.append(f"PR #{n}: commit {sha[:7]} not reviewed yet")
        asked = []
        for c in comments:
            b = c.get("body") or ""
            if QUESTION.search(b):
                asked.append(c)
            elif ANSWER.search(b):
                asked = []
        if asked:
            todo.append(f"PR #{n}: question waits for an answer")
    if (cfg.get("tasks") or {}).get("source") == "issues":
        import factory_agents
        L = task_labels(cfg)
        for i in factory_agents.current(factory_agents.agent_issues()):
            st = factory_agents.state_of(cfg, i)
            if st and st[1] == "silent":
                todo.append(f"agent {st[0]} has been silent for {st[3] / 60:.1f} h")
        hours = float((cfg.get("tasks") or {}).get("staleHours", 3))
        now = datetime.now(timezone.utc)
        for i in fi.task_issues(label=L["inProgress"]):
            age = (now - fi.last_activity(cfg, i)).total_seconds() / 3600
            if age >= hours and not fi.waiting_for_slot(cfg, i):
                todo.append(f"#{i['number']} in progress but quiet for {age:.1f} h")
    return todo


def minutes_arg(args, k, default=30):
    try:
        return float(args[k]) if len(args) > k else default
    except ValueError:
        sys.exit(f"factory wait: '{args[k]}' is not a number of minutes")


def main():
    a = sys.argv[1:]
    if not a:
        sys.exit(__doc__)
    cmd, rest = a[0], a[1:]
    cfg = load()
    if cmd in ("ci", "answer"):
        if not rest or not rest[0].isdigit():
            sys.exit(f"usage: factory wait {cmd} <pr> [minutes]")
        code, line = (wait_ci if cmd == "ci" else wait_answer)(int(rest[0]), minutes_arg(rest, 1))
    elif cmd == "slot":
        code, line = wait_slot(minutes_arg(rest, 0), cfg)
    elif cmd == "ready":
        code, line = wait_ready(minutes_arg(rest, 0), cfg)
    elif cmd == "precheck":
        todo = precheck(cfg)
        print("\n".join(todo) if todo else "nothing to do")
        sys.exit(3 if todo else 0)
    else:
        sys.exit(f"factory wait: unknown wait '{cmd}' (ci, answer, slot, ready; or a PR number)")
    print(line)
    sys.exit(code)


if __name__ == "__main__":
    main()
