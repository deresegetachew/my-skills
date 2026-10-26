#!/usr/bin/env python3
"""Several dev managers at once (#99): review and question claims with a lease, a stale hold cleaned, a merge that
GitHub refuses because someone else got there first, and owner-queue asks posted once. A fake `gh` keeps one
repository in a JSON file (with a lock, so two managers can really race); the managers are the real command.
The rest is in manager_claims.test.ts (#252); these two stay until factory_wait and factory_settings are ported.
python3 software-factory/tests/test_manager_claims.py"""
import json, os, subprocess, sys, tempfile, threading
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
SF = os.path.abspath(os.path.join(HERE, ".."))
HOOKS = os.path.join(SF, "hooks")
SCRIPT = os.path.join(HOOKS, "factory_manager_claims.ts")
HEAD = "a" * 40
NEWHEAD = "b" * 40

FAKE_GH = r'''#!/usr/bin/env python3
import fcntl, json, os, sys
from datetime import datetime, timezone
from urllib.parse import urlparse, parse_qs, unquote
state_path = os.environ["FAKE_GH_STATE"]
lock = open(state_path + ".lock", "w")
fcntl.flock(lock, fcntl.LOCK_EX)
S = json.load(open(state_path))
a = sys.argv[1:]
S.setdefault("log", []).append(" ".join(a))
def save():
    json.dump(S, open(state_path, "w"))
def fail(code, msg):
    save(); sys.stderr.write(f"gh: {msg} (HTTP {code})\n"); sys.exit(1)
def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
if a[:2] == ["repo", "view"]:
    save(); print("main"); sys.exit(0)
if a[0] != "api":
    fail(400, "only api")
method = a[a.index("-X") + 1] if "-X" in a else "GET"
raw = [x for i, x in enumerate(a[1:], 1) if not x.startswith("-") and a[i - 1] not in ("-X", "-H")][0]
u = urlparse(raw.replace("repos/{owner}/{repo}/", ""))
path, q = u.path, parse_qs(u.query)
body = json.load(sys.stdin) if "--input" in a else {}
def issue_view(n):
    n = int(n)
    base = next((p for p in S["pulls"] if p["number"] == n), None) or next((i for i in S["issues"] if i["number"] == n), None)
    return base
def page(rows):
    per = int(q.get("per_page", ["30"])[0]); pg = int(q.get("page", ["1"])[0])
    return rows[(pg - 1) * per: pg * per]
parts = path.split("/")
def out(x):
    save(); print(json.dumps(x)); sys.exit(0)
if path == "pulls" and method == "GET":
    out(page([p for p in S["pulls"] if p["state"] == "open"]))
if path == "issues" and method == "GET":
    rows = [i for i in S["issues"] if i["state"] == "open"] + [dict(p, pull_request={}, comments=len(S["comments"].get(str(p["number"]), []))) for p in S["pulls"] if p["state"] == "open"]
    out(page(rows))
if path == "issues" and method == "POST":
    n = max([i["number"] for i in S["issues"]] + [p["number"] for p in S["pulls"]] + [0]) + 1
    S["issues"].append({"number": n, "title": body["title"], "body": body["body"], "state": "open", "labels": [], "comments": 0})
    out({"number": n})
if path == "user":
    out({"login": "owner"})
if parts[0] == "pulls" and len(parts) == 2 and method == "GET":
    p = issue_view(parts[1]); out(p) if p else fail(404, "Not Found")
if parts[0] == "pulls" and parts[-1] == "merge" and method == "PUT":
    p = issue_view(parts[1])
    if p["state"] != "open":
        fail(405, "Pull Request is not mergeable")
    if body.get("sha") != p["head"]["sha"]:
        fail(409, "Head branch was modified. Review and try the merge again.")
    p["state"] = "closed"; p["merged"] = True
    out({"merged": True})
if parts[0] == "issues" and parts[1] == "comments":
    cid = int(parts[2])
    for n, cs in S["comments"].items():
        for c in cs:
            if c["id"] == cid:
                if method == "DELETE":
                    cs.remove(c); out({})
                out(dict(c, issue_url=f"https://api.github.com/repos/o/r/issues/{n}"))
    fail(404, "Not Found")
if parts[0] == "issues" and len(parts) == 3 and parts[2] == "comments":
    n = parts[1]
    cs = S["comments"].setdefault(n, [])
    if method == "GET":
        out(page(cs))
    for other in S.pop("race", {}).get(n, []):   # another manager gets in just before this post
        S["next_id"] += 1
        cs.append({"id": S["next_id"], "body": other, "created_at": now(), "user": {"login": "owner"}})
    S["next_id"] += 1
    c = {"id": S["next_id"], "body": body["body"], "created_at": now(), "user": {"login": "owner"}}
    cs.append(c)
    out(c)
if parts[0] == "issues" and len(parts) == 3 and parts[2] == "labels" and method == "POST":
    p = issue_view(parts[1])
    for name in body["labels"]:
        if name not in [x["name"] for x in p["labels"]]:
            p["labels"].append({"name": name})
    out(p["labels"])
if parts[0] == "issues" and len(parts) == 4 and parts[2] == "labels" and method == "DELETE":
    p = issue_view(parts[1])
    p["labels"] = [x for x in p["labels"] if x["name"] != unquote(parts[3])]
    out([])
if parts[0] == "commits":
    out({"check_runs": [], "statuses": []})
fail(404, "Not Found: fake gh has no " + method + " " + path)
'''


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def now():
    return datetime.now(timezone.utc).replace(microsecond=0)


def claim_text(who, head, mins, kind="review", subject="sha"):
    return f"<!-- factory-{kind}-claim manager={who} {subject}={head} until={iso(now() + timedelta(minutes=mins))} -->"


def comment(body, cid, ago=1):
    return {"id": cid, "body": body, "created_at": iso(now() - timedelta(minutes=ago)), "user": {"login": "owner"}}


def pull(n, head=HEAD, draft=False, labels=()):
    return {"number": n, "title": f"Task {n}", "state": "open", "draft": draft, "head": {"sha": head, "ref": f"task/{n}-x"},
            "labels": [{"name": x} for x in labels], "body": ""}


class Repo:
    """A project folder with the factory's hooks linked in and a fake gh in front of the real one."""

    def __init__(self, pulls=(), comments=None, issues=(), cfg=None):
        self.d = tempfile.mkdtemp()
        subprocess.run(["git", "init", "-q", "-b", "main", self.d], check=True)
        os.makedirs(os.path.join(self.d, ".claude", "hooks"))
        os.makedirs(os.path.join(self.d, "bin"))
        for f in os.listdir(HOOKS):
            if f.endswith((".py", ".sh")):
                os.symlink(os.path.join(HOOKS, f), os.path.join(self.d, ".claude", "hooks", f))
        os.symlink(os.path.join(SF, "factory"), os.path.join(self.d, "factory"))
        json.dump(cfg or {}, open(os.path.join(self.d, ".claude", "factory.json"), "w"))
        open(os.path.join(self.d, "bin", "gh"), "w").write(FAKE_GH)
        os.chmod(os.path.join(self.d, "bin", "gh"), 0o755)
        self.state = os.path.join(self.d, "state.json")
        json.dump({"pulls": list(pulls), "issues": list(issues), "next_id": 1000,
                   "comments": {str(k): v for k, v in (comments or {}).items()}}, open(self.state, "w"))
        self.env = {**os.environ, "PATH": f"{self.d}/bin:{os.environ['PATH']}", "FAKE_GH_STATE": self.state,
                    "PYTHONDONTWRITEBYTECODE": "1"}
        for k in ("FACTORY_AGENT", "FACTORY_LOOP", "CLAUDE_PROJECT_DIR"):
            self.env.pop(k, None)

    def run(self, *args):
        p = subprocess.run([sys.executable, SCRIPT, *args], cwd=self.d, env=self.env, capture_output=True, text=True,
                           timeout=120)
        return p.returncode, p.stdout.strip(), p.stderr.strip()

    def factory(self, *args):
        return subprocess.run(["bash", os.path.join(self.d, "factory"), *args], cwd=self.d, env=self.env,
                              capture_output=True, text=True, timeout=120)

    def data(self):
        return json.load(open(self.state))

    def edit(self, fn):
        s = self.data()
        fn(s)
        json.dump(s, open(self.state, "w"))

    def comments(self, n):
        return self.data()["comments"].get(str(n), [])

    def labels(self, n):
        p = next(p for p in self.data()["pulls"] if p["number"] == n)
        return {x["name"] for x in p["labels"]}

    def writes(self):
        return [l for l in self.data().get("log", []) if l.startswith("api -X POST") or l.startswith("api -X DELETE")
                or l.startswith("api -X PUT")]


def test_a_claim_is_not_mistaken_for_an_answer_by_the_waiting_code():
    # factory wait answer / precheck treat a later factory-answer as the end of a question; a claim must not be one
    q = comment("<!-- factory-question -->\nWhich database?", 10)
    r = Repo([pull(5)], {5: [q, comment(claim_text("dm-1", 10, 20, kind="answer", subject="question"), 11)]})
    p = r.factory("precheck")
    assert p.returncode == 3 and "question waits for an answer" in p.stdout, (p.stdout, p.stderr)


def approved(head=HEAD):
    return comment(f"<!-- factory-approved sha={head[:7]} -->", 3)


def test_factory_settings_know_the_claim_minutes():
    r = Repo([pull(5)], {5: [comment(claim_text("dm-1", HEAD, 15), 1)]}, cfg={"reviewMarkers": "tmp/reviews"})
    s = r.factory("settings", "show", "manager.claimMinutes")
    assert s.returncode == 0 and "20" in s.stdout, (s.stdout, s.stderr)


