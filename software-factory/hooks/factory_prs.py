#!/usr/bin/env python3
"""`factory prs`: the one list a dev manager starts a pass from (#98). Read-only, REST only (`gh api`; no `gh pr`).

For every open pull request: the head and its age, labels, CI judged by one rule, the newest marker per commit,
the review claim, and the next action. Below them: unanswered questions, unanswered owner asks, agents that went
quiet. `factory status` uses the same CI rule and the same reading of the dev manager's markers (this file).

  python3 .claude/hooks/factory_prs.py [--json] [--since-days N]

The CI rule: per job name, the newest run that was not skipped decides (a re-run replaces a failure; a skipped run
decides nothing). One state for the PR: red (a job failed), running, queued, green; `none` when GitHub shows no
runs yet; `unknown` when they could not be read. The next action is one of: review, merge, wait CI, rerun flake,
waiting for agent, owner merges (protected), owner merges (own PR), held by <manager>, none.
"""
import argparse, json, os, re, sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import factory_issues as fi  # noqa: E402
from factory_config import branch_task, load, load_from_main, task_labels, task_source  # noqa: E402

SHA_IN = re.compile(r"sha=([0-9a-f]{7,40})")
MARKER = re.compile(r"<!--\s*(factory-approved|factory-mustfix|pr-watch)\b([^>]*?)-->")
CLAIM = re.compile(r"<!--\s*factory-review-claim\s+manager=([\w.-]+)\s+sha=([0-9a-f]{7,40})\s+until=(\S+?)\s*-->")
QUESTION = re.compile(r"<!--\s*factory-question\b")
ANSWER = re.compile(r"<!--\s*factory-answer\b")
OWNER_ASK = re.compile(r"<!--\s*factory-owner-ask\s+id=([\w.-]+)(?:\s+[^>]*?)?\s*-->")  # for=product may follow
OWNER_ANSWER = re.compile(r"<!--\s*factory-owner-answer\s+id=([\w.-]+)\s*-->")
OWNER_QUEUE_TITLE = "Dev manager: needs the owner"
PERSON_MERGES = "a person merges this one"
GREEN = ("success", "neutral")
TEXT = {"review": "review", "merge": "merge", "wait-ci": "wait CI", "rerun-flake": "rerun flake",
        "waiting-for-agent": "waiting for agent", "none": "none"}


def section(fn, *a):
    try:
        return fn(*a)
    except (RuntimeError, ValueError, OSError, KeyError, TypeError, SystemExit) as e:  # factory_issues exits on errors
        return {"error": str(e) or type(e).__name__}


def parse_time(stamp):
    return datetime.fromisoformat(stamp.replace("Z", "+00:00"))


def minutes_since(stamp, now):
    return max(0, int((now - parse_time(stamp)).total_seconds() // 60)) if stamp else None


def human(m):
    return "" if m is None else f"{m} min" if m < 120 else f"{m // 60} h" if m < 2880 else f"{m // 1440} d"


# --- CI judged by the rule --------------------------------------------------------------------------------------

def newest_runs(runs):
    """{job name: (its newest run that was not skipped, how many such runs there are)}."""
    by = {}
    for r in runs:
        if r.get("conclusion") == "skipped":
            continue
        by.setdefault(r.get("name", "?"), []).append(r)
    return {n: (max(rs, key=lambda r: (r.get("started_at") or "", r.get("id") or 0)), len(rs)) for n, rs in by.items()}


def job_state(run):
    if run.get("status") != "completed":
        return "queued" if run.get("status") in ("queued", "waiting", "pending", "requested") else "running"
    return "green" if run.get("conclusion") in GREEN else "red"


def judge_ci(runs):
    """(state, the jobs that are not green as [{name, state}]). red beats running beats queued beats green."""
    if not runs:
        return "none", []
    jobs = {n: job_state(r) for n, (r, _) in newest_runs(runs).items()}
    bad = [{"name": n, "state": s} for n, s in sorted(jobs.items()) if s != "green"]
    for state in ("red", "running", "queued"):
        if any(s == state for s in jobs.values()):
            return state, bad
    return "green", bad  # also when every run was skipped: nothing is failing or waiting


def check_runs(sha):
    out, page = [], 1
    while True:
        chunk = (fi.gh("GET", f"repos/{{owner}}/{{repo}}/commits/{sha}/check-runs?per_page=100&page={page}") or {}
                 ).get("check_runs", [])
        out += chunk
        if len(chunk) < 100:
            return out
        page += 1


def ci_state(sha):
    """(state, notGreen, runs) for a commit. `unknown` when its checks could not be read; the others still show."""
    try:
        runs = check_runs(sha)
    except (RuntimeError, SystemExit):
        return "unknown", [], []
    state, bad = judge_ci(runs)
    return state, bad, runs


# --- the dev manager's markers ----------------------------------------------------------------------------------

def names_head(sha, head):
    return bool(sha) and (head.startswith(sha) or sha.startswith(head))


def gate_word(comments, head, trusted):
    """The dev manager's word on a PR, by the PR gate's rule (pr-gate.py, gate_merge): the last marker counts; an
    approval only from a trusted login (when `trustedReviewers` is set on main) and only for the head commit."""
    last, mustfix_sha = None, None
    for c in comments:
        body = c.get("body") or ""
        login = (c.get("user") or c.get("author") or {}).get("login", "")
        if "<!-- factory-mustfix" in body:
            last = "mustfix"
            m = SHA_IN.search(body)
            mustfix_sha = m.group(1) if m else None
        elif "<!-- factory-approved" in body and (not trusted or login in trusted):
            m = re.search(r"factory-approved\s+sha=([0-9a-f]{7,40})", body)
            last = "approved" if m and head.startswith(m.group(1)) else "stale"
    if last == "mustfix":  # it holds the merge whatever commit it names, until an approval of the head
        return "must-fix" if not mustfix_sha or head.startswith(mustfix_sha) else "must-fix (older commit)"
    return {"approved": "approved", "stale": "approval stale"}.get(last)


def markers_of(comments, head, trusted):
    """The newest marker per commit, oldest first: [{kind, sha, at, namesHead}], and the kind that names the head."""
    newest = {}
    for c in comments:
        login = (c.get("user") or c.get("author") or {}).get("login", "")
        for kind, rest in MARKER.findall(c.get("body") or ""):
            if kind == "factory-approved" and trusted and login not in trusted:
                continue  # only a trusted login's approval counts, as at the merge gate
            m = SHA_IN.search(rest)
            sha = m.group(1) if m else None
            key = sha if sha is None else next((k for k in newest if k and (names_head(k, sha) or names_head(sha, k))), sha)
            newest[key] = {"kind": kind, "sha": sha, "at": c.get("created_at"), "namesHead": names_head(sha, head)}
    found = sorted(newest.values(), key=lambda m: m["at"] or "")
    return found, next((m["kind"] for m in reversed(found) if m["namesHead"]), None)


def claim_of(comments, head, now):
    """(the earliest unexpired review claim for this head or None, whether an expired one exists for it)."""
    live, expired = [], False
    for c in comments:
        for manager, sha, until in CLAIM.findall(c.get("body") or ""):
            if not names_head(sha, head):
                continue
            if parse_time(until) > now:
                live.append({"manager": manager, "until": until, "expired": False})
            else:
                expired = True
    return (live[0] if live else None), expired


def open_questions(comments):
    """Comments with a `factory-question` and no later `factory-answer` (an answer clears what is open before it)."""
    asked = []
    for c in comments:
        body = c.get("body") or ""
        if QUESTION.search(body):
            asked.append(c)
        elif ANSWER.search(body):
            asked = []
    return asked


def open_owner_asks(comments):
    """Owner-queue asks nobody has answered: no later comment before the next ask, and no owner-answer marker."""
    asks, answered = [], set()
    for c in comments:
        body = c.get("body") or ""
        ask = OWNER_ASK.search(body)
        if ask:
            asks.append((ask.group(1), c))
            continue
        marked = OWNER_ANSWER.search(body)
        if marked:
            answered.add(marked.group(1))
        elif asks and asks[-1][0] not in answered:
            answered.add(asks[-1][0])  # a reply under the newest ask, before the next one
    return [(slug, c) for slug, c in asks if slug not in answered]


# --- the next action ---------------------------------------------------------------------------------------------

def act(action, **more):
    return {"action": action, "text": TEXT.get(action, action), **more}


def next_action(p, held, runs_by_job, flakes):
    """One next step for the manager, from what the record already holds (see the README for the order)."""
    ci, claim, head = p["ci"], p["claim"], p["headMarker"]
    if held:
        if not (p["staleHold"] and head is None):
            who = claim["manager"] if claim else "manager"
            return act("held", text=f"held by {who}", by=who)
    if p["draft"]:
        return act("waiting-for-agent")
    if ci["state"] == "unknown":
        return act("none", error="CI could not be read")
    waiting = ci["state"] in ("running", "queued", "none")
    if not p["agentPr"]:  # the manager's own PR (or a person's): the manager never merges it
        if ci["state"] == "red":
            return act("none", reason="not-agent-pr")
        if waiting:
            return act("wait-ci")
        return act("owner-merges", text="owner merges (own PR)", reason="not-agent-pr")
    if head == "factory-mustfix" or (head == "factory-approved" and p["gate"] and p["gate"].startswith("must-fix")):
        return act("waiting-for-agent")
    if ci["state"] == "red":
        red = [j["name"] for j in ci["notGreen"] if j["state"] == "red"]
        if red and all(n in flakes and runs_by_job.get(n) == 1 for n in red):
            return act("rerun-flake", jobs=red)
        return act("waiting-for-agent")
    if head is None:
        return act("review")
    if head == "pr-watch":
        return act("none")
    if waiting:
        return act("wait-ci")
    if p["protected"] is None:
        return act("none", error="changed files could not be read")
    if p["protected"]:
        return act("owner-merges", text="owner merges (protected)", reason="protected")
    return act("merge")


# --- assembling the list -----------------------------------------------------------------------------------------

def is_protected(number, body, cfg):
    if PERSON_MERGES in (body or "").lower():
        return True
    files = [f["filename"] for f in fi.gh_all(f"repos/{{owner}}/{{repo}}/pulls/{number}/files")]
    return any(f not in cfg["alwaysAllowed"] and any(re.search(rx, f) for rx in cfg["protected"]) for f in files)


def pulls(cfg, gate_cfg, now):
    trusted = set(gate_cfg.get("trustedReviewers") or [])
    hold = gate_cfg.get("holdLabel", "factory-hold")
    flakes = set((gate_cfg.get("manager") or {}).get("flakes") or [])
    prefix = task_labels(gate_cfg)["agentPrefix"]
    comments_by = {}

    def one(p):
        n, sha, branch = p["number"], p["head"]["sha"], p["head"]["ref"]
        out = {"number": n, "title": p.get("title", ""), "url": p.get("html_url"), "branch": branch,
               "draft": bool(p.get("draft"))}
        try:
            labels = [x["name"] for x in p.get("labels", [])]
            comments = fi.gh_all(f"repos/{{owner}}/{{repo}}/issues/{n}/comments")
            comments_by[n] = comments
            date = ((fi.gh("GET", f"repos/{{owner}}/{{repo}}/commits/{sha}") or {}).get("commit", {})
                    .get("committer", {}).get("date"))
            state, bad, runs = ci_state(sha)
            marks, head_kind = markers_of(comments, sha, trusted)
            claim, expired = claim_of(comments, sha, now)
            agent = next((x[len(prefix):] for x in labels if x.startswith(prefix)), None)
            out.update({"head": {"sha": sha, "ageMinutes": minutes_since(date, now)}, "labels": labels,
                        "agent": agent, "agentPr": bool(agent) or branch_task(branch) is not None,
                        "ci": {"state": state, "notGreen": bad, "runs": len(runs)},
                        "markers": marks, "headMarker": head_kind, "gate": gate_word(comments, sha, trusted),
                        "claim": claim, "staleHold": hold in labels and expired and claim is None,
                        "protected": None})
            held = hold in labels
            ready = out["agentPr"] and not out["draft"] and head_kind == "factory-approved" and state == "green" and not held
            if ready:  # only a PR that could be merged is worth the extra call
                try:
                    out["protected"] = is_protected(n, p.get("body"), gate_cfg)
                except (RuntimeError, SystemExit):
                    out["protected"] = None
            runs_by_job = {k: c for k, (_, c) in newest_runs(runs).items()}
            out["next"] = next_action(out, held, runs_by_job, flakes)
        except (RuntimeError, SystemExit, KeyError, ValueError) as e:
            out["next"] = act("none", error=str(e) or type(e).__name__)
        return out

    with ThreadPoolExecutor(8) as pool:
        rows = list(pool.map(one, sorted(fi.gh_all("repos/{owner}/{repo}/pulls?state=open"), key=lambda p: p["number"])))
    return {"pulls": rows, "comments": comments_by}


def questions_and_asks(open_prs, comments_by, now, since_days):
    """Unanswered questions on open PRs and open issues, and unanswered owner-queue asks."""
    issues = fi.gh_all("repos/{owner}/{repo}/issues?state=open")
    plain = {i["number"]: i for i in issues if "pull_request" not in i}
    prs = {p["number"]: p for p in open_prs}
    found = []
    for n, comments in comments_by.items():
        for c in open_questions(comments):
            found.append(("pr", n, prs[n]["title"], c, prs[n].get("url")))
    since = (now - timedelta(days=since_days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    per_issue = {}
    for c in fi.gh_all(f"repos/{{owner}}/{{repo}}/issues/comments?sort=created&direction=asc&since={since}"):
        m = re.search(r"/issues/(\d+)$", c.get("issue_url") or "")
        if m and int(m.group(1)) in plain:
            per_issue.setdefault(int(m.group(1)), []).append(c)
    for n, comments in per_issue.items():
        for c in open_questions(comments):
            found.append(("issue", n, plain[n]["title"], c, None))
    qs = [{"kind": k, "number": n, "title": t, "url": c.get("html_url") or u, "ageMinutes": minutes_since(c.get("created_at"), now)}
          for k, n, t, c, u in sorted(found, key=lambda x: x[3].get("created_at") or "")]
    asks = []
    for n, i in plain.items():
        if i["title"].startswith(OWNER_QUEUE_TITLE):
            for slug, c in open_owner_asks(fi.gh_all(f"repos/{{owner}}/{{repo}}/issues/{n}/comments")):
                asks.append({"id": slug, "issue": n, "url": c.get("html_url"),
                             "ageMinutes": minutes_since(c.get("created_at"), now)})
    return qs, asks


def quiet(cfg, now):
    """Agents silent or down, and in-progress tasks with no activity (issues mode)."""
    if task_source(cfg) != "issues":
        return {"note": "agents report on GitHub in issues mode only (tasks.source \"issues\")", "agents": [],
                "staleTasks": []}
    import factory_agents
    rows = [factory_agents.state_of(cfg, i) for i in factory_agents.current(factory_agents.agent_issues())]
    agents = [{"name": n, "status": s, "minutesAgo": round(q)} for n, s, t, q in sorted(r for r in rows if r)
              if s in ("silent", "down")]
    L = task_labels(cfg)
    hours = float((cfg.get("tasks") or {}).get("staleHours", 3))
    stale = []
    for i in fi.task_issues(label=L["inProgress"]):
        if L["inProgress"] not in fi.names(i):
            continue
        age = (now - fi.last_activity(cfg, i)).total_seconds() / 3600
        if age >= hours and not fi.waiting_for_slot(cfg, i):
            stale.append({"number": i["number"], "title": i["title"], "quietHours": round(age, 1)})
    return {"agents": agents, "staleTasks": stale}


def build(cfg, since_days=14):
    now = datetime.now(timezone.utc)
    try:
        gate_cfg = load_from_main(cfg)  # main's settings, as the gate reads them: an agent can't widen them
    except RuntimeError:
        gate_cfg = cfg
    got = section(pulls, cfg, gate_cfg, now)
    result = {"generatedAt": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "pulls": got.get("pulls", got)}
    if "error" in got:
        result.update(questions={"error": got["error"]}, ownerAsks={"error": got["error"]})
    else:
        both = section(questions_and_asks, got["pulls"], got["comments"], now, since_days)
        if isinstance(both, dict):
            result.update(questions=both, ownerAsks=both)
        else:
            result.update(questions=both[0], ownerAsks=both[1])
    q = section(quiet, cfg, now)
    result.update(agents=q if "error" in q else q["agents"], staleTasks=[] if "error" in q else q["staleTasks"])
    if "note" in q:
        result["note"] = q["note"]
    return result


def show(r):
    def failed(part):
        return f"  can't read it: {part['error']}"

    prs = r["pulls"]
    print(f"Open pull requests ({len(prs) if isinstance(prs, list) else '?'})")
    if isinstance(prs, dict):
        print(failed(prs))
    elif not prs:
        print("  no open pull requests")
    for p in prs if isinstance(prs, list) else []:
        nxt = p["next"]
        print(f"#{p['number']} {nxt['text'] if 'error' not in nxt else 'none (' + nxt['error'] + ')'}: {p['title'][:60]}")
        if "head" not in p:
            continue
        ci = p["ci"]
        bits = [p["branch"][:36], f"{p['head']['sha'][:7]} ({human(p['head']['ageMinutes'])})"]
        bits += (["draft"] if p["draft"] else []) + p["labels"]
        print("    " + " | ".join(bits))
        names = ", ".join(j["name"] for j in ci["notGreen"])
        mark = p["headMarker"] or "no marker for the head"
        if p["headMarker"] is None and p["markers"]:
            mark += f" (older: {p['markers'][-1]['kind']} {p['markers'][-1]['sha'] and p['markers'][-1]['sha'][:7]})"
        claim = f"claim {p['claim']['manager']} until {p['claim']['until']}" if p["claim"] else "no claim"
        print(f"    CI {ci['state']}{' (' + names + ')' if names and ci['state'] != 'green' else ''} | {mark} | {claim}")
    print("Questions")
    q = r["questions"]
    if isinstance(q, dict):
        print(failed(q))
    for x in q if isinstance(q, list) else []:
        print(f"  {x['kind']} #{x['number']} waiting {human(x['ageMinutes'])}: {x['url']}")
    if isinstance(q, list) and not q:
        print("  none waiting")
    print("Owner asks")
    a = r["ownerAsks"]
    if isinstance(a, dict):
        print(failed(a))
    for x in a if isinstance(a, list) else []:
        print(f"  {x['id']} waiting {human(x['ageMinutes'])}: {x['url']}")
    if isinstance(a, list) and not a:
        print("  none waiting")
    print("Agents")
    ag = r["agents"]
    if isinstance(ag, dict):
        print(failed(ag))
    elif r.get("note"):
        print("  " + r["note"])
    else:
        for x in ag:
            print(f"  {x['name']} {x['status']}, last ping {human(x['minutesAgo'])} ago")
        for x in r["staleTasks"]:
            print(f"  #{x['number']} in progress, quiet for {x['quietHours']} h: {x['title'][:50]}")
        if not ag and not r["staleTasks"]:
            print("  all agents answering")


def main():
    ap = argparse.ArgumentParser(description="The list a dev manager starts a pass from. Read-only.")
    ap.add_argument("--json", action="store_true", help="the same, as JSON for scripts (schema in the README)")
    ap.add_argument("--since-days", type=int, default=14,
                    help="how far back to look for unanswered questions on issues (default 14)")
    a = ap.parse_args()
    r = build(load(), a.since_days)
    if a.json:
        print(json.dumps(r, indent=2))
    else:
        show(r)
    return 0


if __name__ == "__main__":
    sys.exit(main())
