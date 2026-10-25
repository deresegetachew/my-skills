#!/usr/bin/env python3
"""Token-free waits: factory wait ci|answer|slot|ready and the dev manager's precheck.  python3 software-factory/tests/test_wait.py

`gh` is a fake on PATH reading a JSON file; each call may also advance the world ("steps": a list of db patches applied
one per call to the pulls route), so a wait can see CI go from running to green. Sleeps are 0 seconds."""
import json, os, subprocess, sys, tempfile

SF = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
FACTORY = os.path.join(SF, "factory")
HOOK = os.path.join(SF, "hooks", "factory_wait.py")

FAKE_GH = r'''#!/usr/bin/env python3
import json, os, re, sys
from urllib.parse import urlparse, parse_qs
f = os.environ["FAKE_DB"]; db = json.load(open(f)); a = sys.argv[1:]
if a[:1] != ["api"]: sys.exit("fake gh: only gh api")
path = [x for x in a[1:] if not x.startswith("-") and x not in ("GET", "Accept: application/vnd.github+json")][0]
u = urlparse(path.replace("repos/{owner}/{repo}/", "")); p = u.path; page = int(parse_qs(u.query).get("page", ["1"])[0])
def out(x): print(json.dumps(x)); sys.exit(0)
def paged(x): out(x if page == 1 else [])
if p == "user": out({"login": "me"})
m = re.fullmatch(r"pulls/(\d+)", p)
if m:  # each look at a PR moves the scripted world one step on
    if db.get("steps"):
        step = db["steps"].pop(0) if len(db["steps"]) > 1 else db["steps"][0]
        db.update(step); json.dump(db, open(f, "w"))
    out(db["pulls"][m.group(1)])
if p == "pulls": paged(list(db["pulls"].values()))
m = re.fullmatch(r"commits/(\w+)/check-runs", p)
if m: out({"check_runs": db.get("runs", []), "total_count": len(db.get("runs", []))})
m = re.fullmatch(r"commits/(\w+)/status", p)
if m: out({"statuses": [], "total_count": 0})
if re.fullmatch(r"check-runs/\d+/annotations", p): out(db.get("annotations", []))
m = re.fullmatch(r"issues/(\d+)/comments", p)
if m:
    if db.get("steps_comments"):
        db["comments"] = db["steps_comments"].pop(0) if len(db["steps_comments"]) > 1 else db["steps_comments"][0]
        json.dump(db, open(f, "w"))
    paged([{"body": b} for b in db.get("comments", {}).get(m.group(1), [])])
if p == "issues": paged(db.get("issues", []))
if p in ("branches",): paged([])
sys.exit("fake gh: no route for " + p)
'''


def world(**db):
    d = tempfile.mkdtemp()
    os.makedirs(f"{d}/bin"); os.makedirs(f"{d}/.claude")
    open(f"{d}/bin/gh", "w").write(FAKE_GH); os.chmod(f"{d}/bin/gh", 0o755)
    json.dump(db.pop("cfg", {}), open(f"{d}/.claude/factory.json", "w"))
    json.dump(db, open(f"{d}/db.json", "w"))
    env = {**os.environ, "PATH": f"{d}/bin:{os.environ['PATH']}", "FAKE_DB": f"{d}/db.json",
           "FACTORY_WAIT_START": "0", "FACTORY_WAIT_MAX": "0"}
    return d, env


def wait(d, env, *args):
    p = subprocess.run([sys.executable, HOOK, *args], cwd=d, env=env, capture_output=True, text=True, timeout=60)
    return p.returncode, (p.stdout + p.stderr).strip()


def pr(n, sha="abc1234def", state="open", draft=False, user="me", merged=False):
    return {"number": n, "state": state, "merged": merged, "draft": draft, "user": {"login": user}, "head": {"sha": sha, "ref": f"b{n}"}}


def run(name, status="completed", conclusion="success"):
    return {"id": 1, "name": name, "status": status, "conclusion": conclusion}


def test_ci_waits_for_running_checks_then_reports_green():
    d, env = world(pulls={"7": pr(7)}, runs=[run("a", "in_progress", None)],
                   steps=[{}, {}, {"runs": [run("a"), run("b", conclusion="skipped")]}])
    rc, out = wait(d, env, "ci", "7", "5")
    assert rc == 0 and "CI green" in out and out.count("\n") == 0, (rc, out)


def test_ci_reports_the_failing_check_in_one_line():
    d, env = world(pulls={"7": pr(7)}, runs=[run("lint"), run("tests", conclusion="failure")])
    rc, out = wait(d, env, "ci", "7")
    assert rc == 1 and "tests" in out and "lint" not in out, (rc, out)


def test_ci_that_never_started_is_not_a_failure_of_the_code():
    note = {"message": "The job was not started because recent account payments have failed"}
    d, env = world(pulls={"7": pr(7)}, runs=[run("tests", conclusion="failure")], annotations=[note])
    rc, out = wait(d, env, "ci", "7")
    assert rc == 4 and "didn't run" in out, (rc, out)


def test_ci_times_out_with_exit_2_and_a_merged_pr_exits_3():
    d, env = world(pulls={"7": pr(7)}, runs=[run("a", "queued", None)])
    env["FACTORY_WAIT_START"] = "0.01"
    rc, out = wait(d, env, "ci", "7", "0.01")
    assert rc == 2 and "still running" in out, (rc, out)
    d, env = world(pulls={"7": pr(7, state="closed", merged=True)})
    rc, out = wait(d, env, "ci", "7")
    assert rc == 3 and "merged" in out, (rc, out)


Q, A = "<!-- factory-question -->\nWhich?", "<!-- factory-answer -->\nThis one."


def test_answer_returns_once_the_question_has_a_later_answer():
    d, env = world(pulls={"7": pr(7)}, steps_comments=[{"7": [Q]}, {"7": [Q]}, {"7": [Q, "chat", A]}])
    rc, out = wait(d, env, "answer", "7", "5")
    assert rc == 0 and "answered" in out, (rc, out)


def test_answer_with_nothing_asked_says_so_instead_of_waiting():
    d, env = world(pulls={"7": pr(7)}, comments={"7": ["hello"]})
    rc, out = wait(d, env, "answer", "7")
    assert rc == 1 and "no question" in out, (rc, out)


def test_a_question_asked_after_an_answer_is_open_again():
    d, env = world(pulls={"7": pr(7)}, comments={"7": [Q, A, Q]})
    env["FACTORY_WAIT_START"] = "0.01"
    assert wait(d, env, "answer", "7", "0.01")[0] == 2


def E(**kw):
    kw.setdefault("v", "1")
    return "<!-- factory-msg " + " ".join(f"{k.replace('_', '-')}={v}" for k, v in kw.items()) + " -->"


QX = E(id="q1x", kind="question", **{"from": "haile"}, to="dev-manager", state="submitted") + "\nWhich?"
AX = E(id="a1x", kind="answer", **{"from": "dev-manager"}, to="haile", state="completed", in_reply_to="q1x") + "\nThis one."


def test_answer_waits_for_the_answer_that_names_the_question():
    other = E(id="a2x", kind="answer", **{"from": "dev-manager"}, to="haile", state="completed", in_reply_to="zzz")
    d, env = world(pulls={"7": pr(7)}, steps_comments=[{"7": [QX]}, {"7": [QX, other]}, {"7": [QX, other, AX]}])
    rc, out = wait(d, env, "answer", "7", "5")
    assert rc == 0 and "answered" in out, (rc, out)


def test_answer_keeps_waiting_when_only_someone_elses_question_was_answered():
    po_q = E(id="q2x", kind="question", **{"from": "haile"}, to="po", state="submitted")
    d, env = world(pulls={"7": pr(7)}, comments={"7": [QX, po_q, AX]})
    env["FACTORY_WAIT_START"] = "0.01"
    rc, out = wait(d, env, "answer", "7", "0.01")
    assert rc == 2, (rc, out)


def test_answer_stops_when_the_addressee_asks_for_more_information():
    ask = E(id="s1x", kind="status", **{"from": "dev-manager"}, to="haile", state="input-required", in_reply_to="q1x") + "\nWhich one?"
    d, env = world(pulls={"7": pr(7)}, comments={"7": [QX, ask]})
    rc, out = wait(d, env, "answer", "7")
    assert rc == 0 and "more information" in out and "q1x" in out, (rc, out)


def test_a_failed_question_counts_as_answered_with_its_state_in_the_line():
    failed = E(id="a1x", kind="answer", **{"from": "dev-manager"}, state="failed", in_reply_to="q1x") + "\nneeds-owner: name"
    d, env = world(pulls={"7": pr(7)}, steps_comments=[{"7": [QX]}, {"7": [QX, failed]}])
    rc, out = wait(d, env, "answer", "7", "5")
    assert rc == 0 and "answered" in out, (rc, out)


def test_precheck_lists_questions_for_the_dev_manager_on_prs_and_issues_but_not_for_others():
    po_q = E(id="q2x", kind="question", **{"from": "haile"}, to="po", state="submitted")
    d, env = world(pulls={"7": pr(7, sha="abc1234def")}, issues=[{"number": 21, "title": "T", "body": "", "state": "open", "comments": 1,
                                                                    "labels": [], "updated_at": "2020-01-01T00:00:00Z"}],
                   comments={"7": ["<!-- factory-approved sha=abc1234 -->", QX, po_q], "21": [QX.replace("q1x", "q3x")]})
    rc, out = wait(d, env, "precheck")
    assert rc == 3 and "PR #7: question waits for an answer (q1x from haile)" in out, (rc, out)
    assert "issue #21: question waits for an answer (q3x from haile)" in out and "q2x" not in out, out
    answered = [QX, AX]
    d, env = world(pulls={"7": pr(7, sha="abc1234def")}, comments={"7": ["<!-- factory-approved sha=abc1234 -->", *answered]})
    assert wait(d, env, "precheck") == (0, "nothing to do")


def test_precheck_sees_an_approval_in_the_new_form():
    ok = E(id="p1x", kind="approval", **{"from": "dev-manager"}, state="completed", sha="abc1234")
    d, env = world(pulls={"7": pr(7, sha="abc1234def")}, comments={"7": [ok]})
    assert wait(d, env, "precheck") == (0, "nothing to do")


def test_slot_counts_only_my_ready_prs():
    pulls = {"1": pr(1), "2": pr(2), "3": pr(3, draft=True), "4": pr(4, user="other")}
    d, env = world(pulls=pulls, cfg={"maxOpenPRs": 2})
    env["FACTORY_WAIT_START"] = "0.01"
    rc, out = wait(d, env, "slot", "0.01")
    assert rc == 2 and "#1, #2" in out, (rc, out)
    d, env = world(pulls=pulls, cfg={"maxOpenPRs": 3})
    rc, out = wait(d, env, "slot")
    assert rc == 0 and "free" in out, (rc, out)


def issue(n, labels=("factory:ready",)):
    return {"number": n, "title": f"Task {n}", "body": "", "state": "open", "milestone": None, "updated_at": "2020-01-01T00:00:00Z",
            "labels": [{"name": l} for l in labels]}


def test_ready_prints_the_next_task_once_one_is_ready():
    d, env = world(issues=[issue(3)], cfg={"tasks": {"source": "issues"}})
    rc, out = wait(d, env, "ready")
    assert (rc, out) == (0, "issue-3 Task 3"), (rc, out)
    d, env = world(issues=[issue(3, ("factory:in-progress",))], cfg={"tasks": {"source": "issues"}})
    env["FACTORY_WAIT_START"] = "0.01"
    assert wait(d, env, "ready", "0.01")[0] == 2


def test_precheck_ends_with_nothing_to_do_when_everything_is_reviewed_and_answered():
    d, env = world(pulls={"7": pr(7, sha="abc1234def"), "8": pr(8, draft=True)},
                   comments={"7": ["<!-- factory-approved sha=abc1234 -->", Q, A]})
    rc, out = wait(d, env, "precheck")
    assert (rc, out) == (0, "nothing to do"), (rc, out)


def test_precheck_lists_an_unreviewed_commit_and_an_open_question():
    d, env = world(pulls={"7": pr(7, sha="bbb2222"), "8": pr(8)},
                   comments={"7": ["<!-- factory-approved sha=abc1234 -->"], "8": ["<!-- pr-watch sha=abc1234def -->", Q]})
    rc, out = wait(d, env, "precheck")
    assert rc == 3 and "PR #7: commit bbb2222 not reviewed" in out and "PR #8: question waits" in out, (rc, out)
    assert "PR #8: commit" not in out, out


def test_factory_command_routes_the_new_waits_and_keeps_wait_pr():
    d, env = world(pulls={"7": pr(7)}, runs=[run("a")])
    subprocess.run(["git", "init", "-q", d], check=True)
    # the factory script runs the project's own .claude/hooks, so link the kit's into the temp project
    os.symlink(os.path.join(SF, "hooks"), f"{d}/.claude/hooks")
    p = subprocess.run(["bash", FACTORY, "wait", "ci", "7"], cwd=d, env=env, capture_output=True, text=True)
    assert p.returncode == 0 and "CI green" in p.stdout, (p.returncode, p.stdout, p.stderr)
    p = subprocess.run(["bash", FACTORY, "precheck"], cwd=d, env=env, capture_output=True, text=True)
    assert p.returncode == 3 and "not reviewed" in p.stdout, (p.returncode, p.stdout, p.stderr)
    assert "wait <pr>" in subprocess.run(["bash", FACTORY, "help"], cwd=d, env=env, capture_output=True, text=True).stdout


if __name__ == "__main__":
    tests = [(k, v) for k, v in sorted(globals().items()) if k.startswith("test_")]
    for k, v in tests:
        v(); print("ok", k)
    print(f"{len(tests)} passed")
