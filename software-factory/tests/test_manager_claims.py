#!/usr/bin/env python3
"""Several dev managers at once (#99): review and question claims with a lease, a stale hold cleaned, a merge that
GitHub refuses because someone else got there first, and owner-queue asks posted once. A fake `gh` keeps one
repository in a JSON file (with a lock, so two managers can really race); the managers are the real command.
python3 software-factory/tests/test_manager_claims.py"""
import json, os, subprocess, sys, tempfile, threading
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
SF = os.path.abspath(os.path.join(HERE, ".."))
HOOKS = os.path.join(SF, "hooks")
SCRIPT = os.path.join(HOOKS, "factory_manager_claims.py")
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


# ------------------------------------------------------------------------------------------------ review claims

def test_a_free_pr_is_claimed_with_a_lease_and_the_hold_goes_on():
    r = Repo([pull(5)])
    rc, out, err = r.run("review", "5", "--manager", "dm-1")
    assert rc == 0 and "claimed" in out, (out, err)
    cs = r.comments(5)
    assert len(cs) == 1 and f"factory-review-claim manager=dm-1 sha={HEAD} until=" in cs[0]["body"], cs
    until = datetime.strptime(cs[0]["body"].split("until=")[1].split()[0], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    assert 19 <= (until - now()).total_seconds() / 60 <= 21, until  # manager.claimMinutes defaults to 20
    assert "factory-hold" in r.labels(5)


def test_claim_minutes_comes_from_the_manager_setting():
    r = Repo([pull(5)], cfg={"manager": {"claimMinutes": 7}})
    assert r.run("review", "5", "--manager", "dm-1")[0] == 0
    body = r.comments(5)[0]["body"]
    until = datetime.strptime(body.split("until=")[1].split()[0], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    assert 6 <= (until - now()).total_seconds() / 60 <= 8, until


def test_an_unexpired_claim_by_another_manager_is_respected_and_nothing_is_posted():
    r = Repo([pull(5, labels=["factory-hold"])], {5: [comment(claim_text("dm-1", HEAD, 15), 1)]})
    rc, out, _ = r.run("review", "5", "--manager", "dm-2")
    assert rc == 3 and "held by dm-1" in out, out
    assert r.writes() == [] and len(r.comments(5)) == 1


def test_two_claims_racing_the_earliest_wins_and_the_loser_does_nothing_more():
    r = Repo([pull(5)])
    # dm-1's claim lands between dm-2's look and dm-2's own post: dm-2 re-reads, sees dm-1 first and stands down
    r.edit(lambda s: s.update(race={"5": [claim_text("dm-1", HEAD, 20)]}))
    rc, out, _ = r.run("review", "5", "--manager", "dm-2")
    assert rc == 3 and "lost the claim to dm-1" in out, out
    assert "factory-hold" not in r.labels(5), "the loser must not put the hold on"
    bodies = [c["body"] for c in r.comments(5)]
    assert len(bodies) == 2 and "manager=dm-1" in bodies[0] and "manager=dm-2" in bodies[1], bodies
    assert [w for w in r.writes() if "labels" in w] == [], r.writes()
    # and the winner, when it carries on, is still the winner
    rc, out, _ = r.run("review", "5", "--manager", "dm-1")
    assert rc == 0 and "already claimed" in out and "factory-hold" in r.labels(5), out
    assert len(r.comments(5)) == 2, "the winner does not post a second claim"


def test_an_expired_claim_can_be_claimed_again():
    old = claim_text("dm-1", HEAD, -5)  # ran out five minutes ago
    r = Repo([pull(5)], {5: [comment(old, 1, ago=30)]})
    rc, out, _ = r.run("review", "5", "--manager", "dm-2")
    assert rc == 0 and "claimed" in out, out
    assert "manager=dm-2" in r.comments(5)[-1]["body"] and "factory-hold" in r.labels(5)


def test_a_claim_cannot_hold_a_pr_for_longer_than_the_lease_cap():
    far = f"<!-- factory-review-claim manager=dm-1 sha={HEAD} until=2999-01-01T00:00:00Z -->"
    r = Repo([pull(5)], {5: [comment(far, 1, ago=180)]})  # posted three hours ago: capped at two hours, so expired
    rc, out, _ = r.run("review", "5", "--manager", "dm-2")
    assert rc == 0, out
    fresh = Repo([pull(5)], {5: [comment(far, 1, ago=1)]})  # posted a minute ago: holds for the capped time
    assert fresh.run("review", "5", "--manager", "dm-2")[0] == 3


def test_a_new_head_commit_makes_the_old_claim_mean_nothing():
    r = Repo([pull(5, head=NEWHEAD)], {5: [comment(claim_text("dm-1", HEAD, 15), 1)]})
    rc, out, _ = r.run("review", "5", "--manager", "dm-2")
    assert rc == 0 and f"sha={NEWHEAD}" in r.comments(5)[-1]["body"], out


def test_a_head_that_already_has_a_review_marker_is_not_claimed():
    for marker in ("factory-approved", "factory-mustfix", "pr-watch"):
        r = Repo([pull(5)], {5: [comment(f"<!-- {marker} sha={HEAD[:7]} -->", 1)]})
        rc, out, _ = r.run("review", "5", "--manager", "dm-1")
        assert rc == 4 and r.writes() == [], (marker, out)
    older = Repo([pull(5, head=NEWHEAD)], {5: [comment(f"<!-- factory-approved sha={HEAD[:7]} -->", 1)]})
    assert older.run("review", "5", "--manager", "dm-1")[0] == 0  # a marker for an older head does not count


def test_release_takes_the_hold_off_and_frees_the_pr():
    r = Repo([pull(5)])
    r.run("review", "5", "--manager", "dm-1")
    assert r.run("release", "5", "--manager", "dm-2")[0] == 3 and "factory-hold" in r.labels(5)  # not dm-2's to release
    rc, out, _ = r.run("release", "5", "--manager", "dm-1")
    assert rc == 0 and "factory-hold" not in r.labels(5), out
    assert r.run("review", "5", "--manager", "dm-2")[0] == 0  # free again, before the lease ran out


def test_manager_names_are_required_and_checked():
    r = Repo([pull(5)])
    rc, out, err = r.run("review", "5")
    assert rc != 0 and "--manager" in err, err
    assert r.run("review", "5", "--manager", "Bad Name")[0] != 0 and r.writes() == []


# ------------------------------------------------------------------------------------------------ stale holds

def test_a_stale_hold_is_taken_off_but_a_running_lease_and_a_hand_placed_hold_are_left():
    stale = claim_text("dm-1", HEAD, -10)
    live = claim_text("dm-2", HEAD, 10)
    r = Repo([pull(1, labels=["factory-hold"]), pull(2, labels=["factory-hold"]), pull(3, labels=["factory-hold"]), pull(4)],
             {1: [comment(stale, 1, ago=40)], 2: [comment(live, 2)], 3: []})
    rc, out, _ = r.run("sweep")
    assert rc == 0 and "#1" in out and "#2" not in out and "#3" not in out, out
    assert "factory-hold" not in r.labels(1)
    assert "factory-hold" in r.labels(2), "a lease is still running"
    assert "factory-hold" in r.labels(3), "no claim was ever made: the owner's own hold"


def test_a_hold_whose_manager_died_after_a_marker_is_also_cleared():
    # approved, then the manager died before taking the hold off: nobody could merge it
    r = Repo([pull(1, labels=["factory-hold"])],
             {1: [comment(claim_text("dm-1", HEAD, -10), 1, ago=40), comment(f"<!-- factory-approved sha={HEAD[:7]} -->", 2, ago=35)]})
    assert "#1" in r.run("sweep")[1] and "factory-hold" not in r.labels(1)


def test_a_manager_whose_lease_ran_out_can_claim_again_after_the_sweep():
    r = Repo([pull(1, labels=["factory-hold"])], {1: [comment(claim_text("dm-1", HEAD, -10), 1, ago=40)]})
    rc, out, _ = r.run("next", "--manager", "dm-2")
    assert rc == 0 and "swept: PR #1" in out and "review: PR #1" in out, out
    assert "factory-hold" in r.labels(1) and "manager=dm-2" in r.comments(1)[-1]["body"]


# ------------------------------------------------------------------------------------------------ questions

def test_a_question_claim_two_managers_earliest_wins():
    q = comment("<!-- factory-question -->\nWhich database?", 10)
    r = Repo([pull(5)], {5: [q]})
    r.edit(lambda s: s.update(race={"5": [claim_text("dm-1", 10, 20, kind="answer", subject="question")]}))
    rc, out, _ = r.run("answer", "10", "--manager", "dm-2")
    assert rc == 3 and "lost the claim to dm-1" in out, out
    rc, out, _ = r.run("answer", "10", "--manager", "dm-1")
    assert rc == 0, out
    assert r.run("answer", "10", "--manager", "dm-3")[0] == 3


def test_an_expired_question_claim_can_be_taken_over_and_an_answer_ends_it():
    q = comment("<!-- factory-question -->\nWhich database?", 10, ago=60)
    old = comment(claim_text("dm-1", 10, -5, kind="answer", subject="question"), 11, ago=30)
    r = Repo([pull(5)], {5: [q, old]})
    assert r.run("answer", "10", "--manager", "dm-2")[0] == 0
    r.edit(lambda s: s["comments"]["5"].append(comment("<!-- factory-answer -->\nPostgres.", 99)))
    rc, out, _ = r.run("answer", "10", "--manager", "dm-3")
    assert rc == 4 and "already answered" in out, out
    assert r.run("list")[1].count("comment 10") == 0, "an answered question is not listed"


def test_a_claim_is_not_mistaken_for_an_answer_by_the_waiting_code():
    # factory wait answer / precheck treat a later factory-answer as the end of a question; a claim must not be one
    q = comment("<!-- factory-question -->\nWhich database?", 10)
    r = Repo([pull(5)], {5: [q, comment(claim_text("dm-1", 10, 20, kind="answer", subject="question"), 11)]})
    p = r.factory("precheck")
    assert p.returncode == 3 and "question waits for an answer" in p.stdout, (p.stdout, p.stderr)


def test_questions_on_issues_and_draft_prs_are_found_and_listed():
    issues = [{"number": 30, "title": "A task", "state": "open", "labels": [], "comments": 1}]
    r = Repo([pull(5, draft=True)], {5: [comment("<!-- factory-question -->\nA?", 10)], 30: [comment("<!-- factory-question -->\nB?", 20)]},
             issues=issues)
    rc, out, _ = r.run("list", "--json")
    s = json.loads(out)
    assert sorted(q["id"] for q in s["questions"]) == [10, 20], s
    assert s["prs"][0]["state"] == "draft", s


# ------------------------------------------------------------------------------------------------ two managers

def test_two_managers_over_one_pr_list_review_every_pr_exactly_once():
    prs = [pull(n, head=f"{n:x}" * 40 if n < 10 else "c" * 40) for n in range(1, 7)]
    r = Repo(prs)
    r.edit(lambda s: s.update(issues=[]))
    won = {"dm-1": [], "dm-2": []}

    def manager(who):
        rc, out, err = r.run("next", "--manager", who, "--max", "6", "--json")
        assert rc == 0, err
        won[who] = [x["number"] for x in json.loads(out)["reviews"]]

    threads = [threading.Thread(target=manager, args=(w,)) for w in won]
    [t.start() for t in threads]
    [t.join() for t in threads]
    both = won["dm-1"] + won["dm-2"]
    assert sorted(both) == [1, 2, 3, 4, 5, 6], won  # each PR won once, none twice, none dropped
    # the "review" itself: each winner posts its marker and lets go; a second pass finds nothing left
    for who, numbers in won.items():
        for n in numbers:
            r.edit(lambda s, n=n: s["comments"][str(n)].append(
                {"id": 5000 + n, "body": f"<!-- pr-watch sha={s['pulls'][n - 1]['head']['sha'][:7]} -->", "created_at": iso(now()), "user": {"login": "owner"}}))
            assert r.run("release", str(n), "--manager", who)[0] == 0
    for who in won:
        assert "nothing to claim" in r.run("next", "--manager", who)[1]
    for n in range(1, 7):
        claims = [c for c in r.comments(n) if "factory-review-claim" in c["body"]]
        assert len([c for c in claims if "dm-" in c["body"]]) >= 1
        assert "factory-hold" not in r.labels(n)


def test_alternating_managers_split_the_list_without_overlap():
    r = Repo([pull(n, head=str(n) * 40) for n in range(1, 6)])
    a = json.loads(r.run("next", "--manager", "dm-1", "--max", "2", "--json")[1])["reviews"]
    b = json.loads(r.run("next", "--manager", "dm-2", "--max", "2", "--json")[1])["reviews"]
    c = json.loads(r.run("next", "--manager", "dm-1", "--max", "2", "--json")[1])["reviews"]
    nums = [x["number"] for x in a + b + c]
    assert len(a) == 2 and len(b) == 2 and len(c) == 1 and sorted(nums) == [1, 2, 3, 4, 5], (a, b, c)


def test_drafts_are_not_reviewed_and_list_shows_every_claim():
    r = Repo([pull(1, draft=True), pull(2), pull(3)], {3: [comment(claim_text("dm-9", HEAD, 12), 1)]})
    out = json.loads(r.run("next", "--manager", "dm-1", "--json")[1])
    assert [x["number"] for x in out["reviews"]] == [2], out
    text = r.run("list")[1]
    assert "claimed by dm-9" in text and "claimed by dm-1" in text and "draft" in text, text


# ------------------------------------------------------------------------------------------------ merge

def approved(head=HEAD):
    return comment(f"<!-- factory-approved sha={head[:7]} -->", 3)


def test_merge_carries_the_head_sha_and_only_an_approved_head_is_merged():
    r = Repo([pull(5)], {5: [approved()]})
    rc, out, _ = r.run("merge", "5", "--manager", "dm-1")
    assert rc == 0 and "merged" in out, out
    assert any("pulls/5/merge" in w for w in r.writes()) and next(p for p in r.data()["pulls"])["state"] == "closed"
    unapproved = Repo([pull(5)], {5: []})
    rc, out, err = unapproved.run("merge", "5", "--manager", "dm-1")
    assert rc == 1 and "no factory-approved" in err and not any("merge" in w for w in unapproved.writes())
    stale = Repo([pull(5, head=NEWHEAD)], {5: [approved(HEAD)]})
    assert stale.run("merge", "5", "--manager", "dm-1")[0] == 1


def test_a_merge_already_done_by_another_manager_is_not_an_error():
    r = Repo([pull(5)], {5: [approved()]})
    assert r.run("merge", "5", "--manager", "dm-1")[0] == 0
    rc, out, _ = r.run("merge", "5", "--manager", "dm-2")
    assert rc == 0 and "someone else" in out, out


def test_a_merge_refused_because_the_head_moved_is_reported_and_nothing_merged():
    r = Repo([pull(5)], {5: [approved()]})
    # the head moves after the manager looked: GitHub refuses the sha-pinned merge with a 409
    gh = open(os.path.join(r.d, "bin", "gh")).read()
    marker = 'if parts[0] == "pulls" and parts[-1] == "merge" and method == "PUT":\n'
    assert marker in gh
    open(os.path.join(r.d, "bin", "gh"), "w").write(gh.replace(marker, marker + f'    p0 = issue_view(parts[1]); p0["head"]["sha"] = "{NEWHEAD}"\n    body["sha"] = "{HEAD}"\n'))
    rc, out, err = r.run("merge", "5", "--manager", "dm-2")
    assert rc == 0 and "head moved" in out and "needs a new review" in out, (out, err)
    assert next(p for p in r.data()["pulls"])["state"] == "open"


# ------------------------------------------------------------------------------------------------ owner queue

def test_an_owner_ask_is_posted_once_by_its_id():
    r = Repo([])
    rc, out, _ = r.run("ask", "--id", "pick-a-name", "--text", "Choose the product name. I recommend Remanual.")
    assert rc == 0 and "posted" in out, out
    issue = r.data()["issues"][0]
    assert issue["title"] == "Dev manager: needs the owner"
    cs = r.comments(issue["number"])
    assert len(cs) == 1 and cs[0]["body"].startswith("<!-- factory-owner-ask id=pick-a-name -->") and "needs your yes" in cs[0]["body"]
    rc, out, _ = r.run("ask", "--id", "pick-a-name", "--text", "same again")
    assert rc == 0 and "already" in out and len(r.comments(issue["number"])) == 1
    r.run("ask", "--id", "other", "--text", "something else")
    assert len(r.comments(issue["number"])) == 2


def test_two_managers_posting_the_same_ask_at_once_leave_one_comment():
    r = Repo([], issues=[{"number": 40, "title": "Dev manager: needs the owner", "state": "open", "labels": [], "comments": 0}])
    r.edit(lambda s: s.update(race={"40": ["<!-- factory-owner-ask id=dup -->\nThis needs your yes: first"]}))
    rc, out, _ = r.run("ask", "--id", "dup", "--text", "second")
    assert rc == 0 and "another manager posted it first" in out, out
    bodies = [c["body"] for c in r.comments(40)]
    assert len(bodies) == 1 and "first" in bodies[0], bodies


# ------------------------------------------------------------------------------------------------ wiring

def test_factory_command_help_settings_and_status_know_the_claims():
    r = Repo([pull(5)], {5: [comment(claim_text("dm-1", HEAD, 15), 1)]}, cfg={"reviewMarkers": "tmp/reviews"})
    h = r.factory("help")
    assert "manager-claims" in h.stdout, h.stdout
    p = r.factory("manager-claims", "list")
    assert p.returncode == 0 and "claimed by dm-1" in p.stdout, (p.stdout, p.stderr)
    s = r.factory("settings", "show", "manager.claimMinutes")
    assert s.returncode == 0 and "20" in s.stdout, (s.stdout, s.stderr)
    st = r.factory("status")
    assert "claimed by dm-1" in st.stdout, (st.stdout, st.stderr)
    js = json.loads(r.factory("status", "--json").stdout)
    assert js["pulls"]["pulls"][0]["claim"]["manager"] == "dm-1", js["pulls"]


def test_builders_cannot_run_the_claim_commands_or_post_the_markers():
    settings = json.load(open(os.path.join(SF, "kit", ".claude", "settings.json")))
    deny = settings["permissions"]["deny"]
    import fnmatch
    for cmd in ("factory manager-claims review 5", "./factory manager-claims next",
                "python3 .claude/hooks/factory_manager_claims.py next"):
        assert any(fnmatch.fnmatch(f"Bash({cmd})", d) for d in deny), cmd
    for cmd in ("gh pr comment 7 --body '<!-- factory-review-claim x -->'", "gh pr comment 7 --body '<!-- factory-claim-release x -->'"):
        assert any(fnmatch.fnmatch(f"Bash({cmd})", d) for d in deny), cmd
    gate = os.path.join(HOOKS, "pr-gate.py")
    r = Repo([])
    for marker in ("factory-review-claim", "factory-answer-claim", "factory-claim-release", "factory-owner-ask"):
        p = subprocess.run([sys.executable, gate], cwd=r.d, env={**r.env, "FACTORY_AGENT": "haile"}, capture_output=True, text=True,
                           input=json.dumps({"tool_input": {"command": f"gh pr comment 7 --body '<!-- {marker} manager=x -->'"}}))
        assert p.returncode == 2, (marker, p.stderr)


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
