#!/usr/bin/env python3
"""Tests for issues mode, against a fake `gh` that keeps issues in a JSON file.  python3 software-factory/tests/test_issues.py"""
import json, os, subprocess, sys, tempfile, textwrap
from datetime import datetime, timezone

KIT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "kit")
HOOKS = os.path.abspath(os.path.join(KIT, ".claude", "hooks"))

FAKE_GH = r'''#!/usr/bin/env python3
import json, os, re, sys
from urllib.parse import unquote, urlparse, parse_qs
db_path = os.environ["FAKE_GH_DB"]
db = json.load(open(db_path))
a = sys.argv[1:]
if a[:1] != ["api"]:
    sys.exit("fake gh: only `gh api`")
method = a[a.index("-X") + 1] if "-X" in a else "GET"
path = [x for x in a[1:] if not x.startswith("-") and x not in (method, "Accept: application/vnd.github+json", "-")][0]
body = json.loads(sys.stdin.read()) if "--input" in a else None
u = urlparse(path.replace("repos/{owner}/{repo}/", "")); q = parse_qs(u.query); p = u.path
page = int(q.get("page", ["1"])[0])
def out(x): print(json.dumps(x)); json.dump(db, open(db_path, "w")); sys.exit(0)
def issue(n): return next(i for i in db["issues"] if i["number"] == n)
def lab(names): return [{"name": n} for n in names]
db["clock"] = db.get("clock", 0) + 1
m = re.fullmatch(r"issues/(\d+)", p)
if p == "issues" and method == "GET":
    if os.environ.get("FAKE_GH_MOVED"): out({"message": "Moved Permanently", "url": "https://api.github.com/repositories/1"})
    if page > 1: out([])
    res = [i for i in db["issues"] if q.get("state", ["open"])[0] in (i["state"], "all")]
    if "labels" in q: res = [i for i in res if q["labels"][0] in {l["name"] for l in i["labels"]}]
    out(res)
if p == "issues" and method == "POST":
    n = max([i["number"] for i in db["issues"]] + [0]) + 1
    i = {"number": n, "title": body["title"], "body": body["body"], "state": "open", "labels": lab(body.get("labels", [])),
         "milestone": {"number": body["milestone"]} if "milestone" in body else None, "updated_at": "2026-10-21T08:00:00Z",
         "html_url": f"https://x/{n}"}
    db["issues"].append(i); out(i)
if m and method == "GET": out(issue(int(m.group(1))))
if m and method == "PATCH": issue(int(m.group(1))).update(body); out(issue(int(m.group(1))))
m = re.fullmatch(r"issues/(\d+)/labels", p)
if m:
    i = issue(int(m.group(1)))
    for n in body["labels"]:
        if n not in {l["name"] for l in i["labels"]}: i["labels"].append({"name": n})
    out(i["labels"])
m = re.fullmatch(r"issues/(\d+)/labels/(.+)", p)
if m:
    i = issue(int(m.group(1))); i["labels"] = [l for l in i["labels"] if l["name"] != unquote(m.group(2))]; out([])
m = re.fullmatch(r"issues/(\d+)/comments", p)
if m:
    cs = db.setdefault("comments", {}).setdefault(m.group(1), [])
    if method == "POST":
        cs.append({"body": body["body"], "at": db["clock"]}); out(cs[-1])
    out([] if page > 1 else cs)
if p in ("branches", "labels", "milestones", "pulls"): out([] if page > 1 else db.get(p, []))
if p == "labels" and method == "POST": db.setdefault("labels", []).append(body); out(body)
sys.exit(f"fake gh: no route for {method} {p}")
'''


def setup(issues):
    d = tempfile.mkdtemp()
    os.makedirs(os.path.join(d, "bin"))
    os.makedirs(os.path.join(d, ".claude"))
    gh = os.path.join(d, "bin", "gh")
    open(gh, "w").write(FAKE_GH)
    os.chmod(gh, 0o755)
    json.dump({"tasks": {"source": "issues"}, "agents": ["menelik", "taytu"]}, open(os.path.join(d, ".claude", "factory.json"), "w"))
    db = os.path.join(d, "db.json")
    json.dump({"issues": issues}, open(db, "w"))
    env = {**os.environ, "PATH": f"{d}/bin:{os.environ['PATH']}", "FAKE_GH_DB": db}
    return d, db, env


def run(d, env, *args):
    p = subprocess.run([sys.executable, os.path.join(HOOKS, "factory_issues.py"), *args], cwd=d, env=env,
                       capture_output=True, text=True)
    return p.returncode, p.stdout.strip() + p.stderr.strip()


def issue(n, labels=("factory:ready",), body="", milestone=None):
    return {"number": n, "title": f"Task {n}", "body": body, "state": "open", "labels": [{"name": l} for l in labels],
            "milestone": {"number": milestone} if milestone else None, "updated_at": "2020-01-01T00:00:00Z"}


def labels(db, n):
    return sorted(l["name"] for l in next(i for i in json.load(open(db))["issues"] if i["number"] == n)["labels"])


def test_pick_claims_in_milestone_order_and_skips_dependencies():
    d, db, env = setup([issue(1, milestone=2), issue(2, milestone=1, body="Depends on #3"), issue(3, milestone=1)])
    rc, out = run(d, env, "pick", "--agent", "menelik")
    assert (rc, out) == (0, "issue-3 Task 3"), out
    assert labels(db, 3) == ["agent:menelik", "factory:in-progress"], labels(db, 3)


def test_agent_resumes_its_own_issue_first():
    d, db, env = setup([issue(1), issue(2, labels=("factory:in-progress", "agent:taytu"))])
    assert run(d, env, "pick", "--agent", "taytu")[1] == "issue-2 Task 2"
    assert run(d, env, "pick", "--agent", "menelik")[1] == "issue-1 Task 1"


def test_earlier_claim_wins():
    d, db, env = setup([issue(1), issue(2)])
    state = json.load(open(db))
    state["comments"] = {"1": [{"body": "<!-- factory-claim agent=taytu -->", "at": 0}]}  # taytu claimed first
    json.dump(state, open(db, "w"))
    rc, out = run(d, env, "pick", "--agent", "menelik")
    assert out == "issue-2 Task 2", out  # lost #1, so took #2
    assert labels(db, 1) == ["factory:in-progress"], labels(db, 1)  # menelik's label came off again


def test_tick_block_release_review():
    d, db, env = setup([issue(1, labels=("factory:in-progress", "agent:menelik"), body="- [ ] a\n- [ ] b")])
    run(d, env, "tick", "1", "2")
    assert json.load(open(db))["issues"][0]["body"] == "- [ ] a\n- [x] b"
    run(d, env, "review", "1")
    assert labels(db, 1) == ["agent:menelik", "factory:in-review"]
    run(d, env, "release", "1", "went quiet")
    assert labels(db, 1) == ["factory:ready"]
    run(d, env, "block", "1", "needs keys")
    assert labels(db, 1) == ["factory:blocked"]
    assert run(d, env, "pick", "--agent", "menelik")[0] == 1  # nothing ready


def test_release_lets_a_new_claim_win():
    d, db, env = setup([issue(1, labels=("factory:in-progress", "agent:taytu"))])
    state = json.load(open(db))
    state["comments"] = {"1": [{"body": "<!-- factory-claim agent=taytu -->", "at": 0}]}
    json.dump(state, open(db, "w"))
    run(d, env, "release", "1")
    assert run(d, env, "pick", "--agent", "menelik")[1] == "issue-1 Task 1"
    assert labels(db, 1) == ["agent:menelik", "factory:in-progress"]


def test_stale_lists_quiet_issues():
    d, db, env = setup([issue(1, labels=("factory:in-progress", "agent:taytu"))])
    rc, out = run(d, env, "stale", "--hours", "1")
    assert "#1 agent:taytu quiet for" in out, out


def agents(d, env, *args):
    p = subprocess.run([sys.executable, os.path.join(HOOKS, "factory_agents.py"), *args], cwd=d, env=env,
                       capture_output=True, text=True)
    return p.returncode, p.stdout.strip() + p.stderr.strip()


def test_agent_registers_pings_and_goes_down():
    d, db, env = setup([issue(1)])
    agents(d, env, "register", "--agent", "taytu")
    rc, out = agents(d, env, "list")
    assert out.startswith("taytu") and " idle " in out, out
    agents(d, env, "ping", "--agent", "taytu", "--status", "working on #1")
    titles = {i["title"] for i in json.load(open(db))["issues"]}
    assert "Agent: taytu · working on #1" in titles, titles
    assert run(d, env, "pick", "--agent", "menelik")[1] == "issue-1 Task 1"  # the agent issue is not a task
    agents(d, env, "down", "--agent", "taytu")
    assert "factory:agent-down" in labels(db, 2)


def test_sweep_marks_silent_agents_down_and_releases_their_issues():
    old = "<!-- factory-agent name=taytu status=working ping=2020-01-01T00:00:00Z -->\n**Started:** x\n**Where:** y"
    d, db, env = setup([issue(1, labels=("factory:in-progress", "agent:taytu")),
                        issue(2, labels=("factory:agent",), body=old)])
    rc, out = agents(d, env, "sweep")
    assert out.startswith("taytu: down") and "released #1" in out, out
    assert labels(db, 1) == ["factory:ready"], labels(db, 1)
    assert "factory:agent-down" in labels(db, 2)
    assert agents(d, env, "sweep")[1] == ""  # already down: nothing more to do


def test_tool_use_pings_at_most_every_few_minutes():
    d, db, env = setup([])
    env = {**env, "FACTORY_AGENT": "taytu"}
    agents(d, env, "register", "--agent", "taytu")
    before = json.load(open(db)).get("clock")
    p = subprocess.run([sys.executable, os.path.join(HOOKS, "factory_agents.py"), "hook"], cwd=d, env=env,
                       input=json.dumps({"hook_event_name": "PostToolUse"}), capture_output=True, text=True)
    assert p.returncode == 0
    assert json.load(open(db)).get("clock") == before  # registered moments ago: no network call


def agent_issue(n, name, ping, state="open"):
    body = f"<!-- factory-agent name={name} status=idle ping={ping} -->\n**Started:** x\n**Where:** y"
    return {"number": n, "title": f"Agent: {name} · idle", "body": body, "state": state,
            "labels": [{"name": "factory:agent"}], "milestone": None, "updated_at": "2020-01-01T00:00:00Z"}


def count_agent_issues(db):
    return sum(1 for i in json.load(open(db))["issues"] if "factory:agent" in {l["name"] for l in i["labels"]})


def test_a_ping_or_a_turns_end_never_opens_an_agent_issue():
    # 22 Oct: a lookup that came back empty made every ping open another issue (195 copies).
    d, db, env = setup([issue(1)])
    agents(d, env, "ping", "--agent", "menelik", "--force")
    agents(d, env, "ping", "--agent", "menelik", "--status", "working on #1")
    p = subprocess.run([sys.executable, os.path.join(HOOKS, "factory_agents.py"), "hook"], cwd=d,
                       env={**env, "FACTORY_AGENT": "menelik"}, input=json.dumps({"hook_event_name": "Stop"}),
                       capture_output=True, text=True)
    assert p.returncode == 0
    agents(d, env, "down", "--agent", "menelik")
    assert count_agent_issues(db) == 0


def test_register_reuses_the_agents_issue_even_a_closed_one():
    d, db, env = setup([agent_issue(5, "menelik", "2026-10-22T10:00:00Z", state="closed")])
    rc, out = agents(d, env, "register", "--agent", "menelik")
    assert out == "#5", out
    agents(d, env, "register", "--agent", "menelik")
    assert count_agent_issues(db) == 1
    assert json.load(open(db))["issues"][0]["state"] == "open"


def test_a_failed_lookup_is_not_an_empty_one():
    d, db, env = setup([])
    rc, out = agents(d, {**env, "FAKE_GH_MOVED": "1"}, "register", "--agent", "menelik")
    assert rc != 0 and "something other than a list" in out, out
    assert count_agent_issues(db) == 0


def test_only_an_agents_newest_issue_counts_and_sweep_closes_the_copies():
    fresh = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    d, db, env = setup([issue(1, labels=("factory:in-progress", "agent:menelik")),
                        agent_issue(2, "menelik", "2020-01-01T00:00:00Z"),
                        agent_issue(3, "menelik", fresh),
                        agent_issue(4, "menelik", "2020-01-01T00:00:00Z", state="closed")])
    rc, out = agents(d, env, "list")
    assert out.count("menelik") == 1 and " idle " in out, out
    rc, out = agents(d, env, "sweep")
    assert out == "closed 1 duplicate agent issue: #2", out  # the old copy went quiet, but the agent is alive
    assert labels(db, 1) == ["agent:menelik", "factory:in-progress"], labels(db, 1)  # its work stays with it
    state = {i["number"]: i["state"] for i in json.load(open(db))["issues"]}
    assert state == {1: "open", 2: "closed", 3: "open", 4: "closed"}, state


if __name__ == "__main__":
    os.environ.pop("FACTORY_AGENT", None)
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print("ok", t.__name__)
