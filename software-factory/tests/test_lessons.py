#!/usr/bin/env python3
"""The fixes from the 22 Oct lessons: free decision and migration numbers, CI that never started, a moved
repository (now in remote.test.ts, #252), and a finished branch waiting for a PR slot.  python3 software-factory/tests/test_lessons.py"""
import json, os, subprocess, sys, tempfile

KIT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "kit"))
SF = os.path.dirname(os.path.abspath(KIT))
HOOKS = os.path.join(SF, "hooks")
GATE = os.path.join(HOOKS, "pr-gate.py")

# Answers by path (without "repos/{owner}/{repo}/" and the query): "text" for calls with --jq (the text gh would
# print after the jq filter), "json" for the others. Unknown paths fail, like a broken gh.
FAKE_GH = r'''#!/usr/bin/env python3
import json, os, sys
from urllib.parse import urlparse
db = json.load(open(os.environ["FAKE_GH_DB"]))
a = sys.argv[1:]
open(os.environ["FAKE_GH_DB"] + ".log", "a").write(" ".join(a) + "\n")
if a[:1] == ["pr"] and a[1:2] == ["list"]:
    print(json.dumps(db.get("open_prs", []))); sys.exit(0)
if a[:2] == ["repo", "view"]:  # the default branch, as GitHub has it
    print("main"); sys.exit(0)
if a[:1] == ["api"] and "contents/.claude/factory.json" in " ".join(a):  # main's settings, as GitHub has them
    import subprocess
    r = subprocess.run(["git", "show", "origin/main:.claude/factory.json"], capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit("gh: Not Found (HTTP 404)")
    print(r.stdout); sys.exit(0)
if a[:1] != ["api"]:
    sys.exit("fake gh: no answer for " + " ".join(a))
rest, path, k = a[1:], None, 0
while k < len(rest):  # the first word that isn't a flag or a flag's value
    if rest[k] in ("-X", "-H", "--jq", "-f", "-F", "--input"):
        k += 2
    elif rest[k].startswith("-"):
        k += 1
    else:
        path = rest[k]; break
p = urlparse(path.replace("repos/{owner}/{repo}/", "")).path
if "--jq" in a and p in db.get("text", {}):
    print(db["text"][p]); sys.exit(0)
if p in db.get("json", {}):
    print(json.dumps(db["json"][p])); sys.exit(0)
if p.startswith("commits/") and p.endswith("/status"):  # GitHub's answer for a commit with no statuses
    print(json.dumps({"total_count": 0, "statuses": []})); sys.exit(0)
sys.exit("fake gh: no answer for " + p)
'''


def git(d, *a):
    return subprocess.run(["git", *a], cwd=d, capture_output=True, text=True, check=True).stdout.strip()


def project(main_files, branch_files, cfg=None):
    """A clone with origin/main holding `main_files` and branch task/1-x adding `branch_files`, plus a fake gh."""
    root = tempfile.mkdtemp()
    origin, d = os.path.join(root, "origin.git"), os.path.join(root, "work")
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", origin], check=True)
    subprocess.run(["git", "clone", "-q", origin, d], check=True, capture_output=True)
    git(d, "config", "user.email", "t@t"); git(d, "config", "user.name", "t")
    os.makedirs(os.path.join(d, ".claude"), exist_ok=True)
    json.dump({"reviewMarkers": "tmp/reviews", "protected": [], "alwaysAllowed": [], "maxOpenPRs": 3, **(cfg or {})},
              open(os.path.join(d, ".claude", "factory.json"), "w"))

    def write(files):
        for f in files:
            os.makedirs(os.path.dirname(os.path.join(d, f)), exist_ok=True)
            open(os.path.join(d, f), "w").write(f)
    write(main_files + ["README.md"])
    git(d, "add", "-A"); git(d, "commit", "-qm", "main"); git(d, "push", "-q", "origin", "HEAD:main")
    git(d, "checkout", "-qb", "task/1-x")
    write(branch_files)
    git(d, "add", "-A"); git(d, "commit", "-q", "--allow-empty", "-m", "task"); git(d, "fetch", "-q", "origin")
    os.makedirs(os.path.join(d, "tmp", "reviews"))
    open(os.path.join(d, "tmp", "reviews", "task_1-x.ok"), "w").write(git(d, "rev-parse", "HEAD"))
    os.makedirs(os.path.join(root, "bin"))
    open(os.path.join(root, "bin", "gh"), "w").write(FAKE_GH)
    os.chmod(os.path.join(root, "bin", "gh"), 0o755)
    db = os.path.join(root, "db.json")
    json.dump({"text": {"pulls": ""}}, open(db, "w"))
    env = {**os.environ, "PATH": f"{root}/bin:{os.environ['PATH']}", "FAKE_GH_DB": db}
    env.pop("FACTORY_AGENT", None)
    return d, db, env


def answers(db, **kw):
    data = json.load(open(db))
    for k, v in kw.items():
        data.setdefault(k, {}).update(v) if isinstance(v, dict) else data.__setitem__(k, v)
    json.dump(data, open(db, "w"))


def gate(d, env, command):
    p = subprocess.run([sys.executable, GATE], cwd=d, env=env, capture_output=True, text=True,
                       input=json.dumps({"tool_input": {"command": command}}))
    return p.returncode, p.stderr


CREATE = "gh pr create --title x --body 'Closes #1'"


# --- numbers -------------------------------------------------------------------------------------------------

def test_a_free_decision_number_opens_the_pr():
    d, db, env = project(["docs/decisions/0001-a.md", "docs/decisions/0002-b.md"], ["docs/decisions/0003-c.md"])
    assert gate(d, env, CREATE) == (0, ""), gate(d, env, CREATE)


def test_a_number_main_already_has_is_refused_with_the_next_free_one():
    d, db, env = project(["docs/decisions/0001-a.md", "docs/decisions/0002-b.md"], ["docs/decisions/0002-c.md"])
    rc, err = gate(d, env, CREATE)
    assert rc == 2 and "0002-c.md uses number 0002" in err and "on main" in err and "Rename it to 0003" in err, err


def test_a_number_another_open_pr_took_is_refused():
    d, db, env = project(["docs/decisions/0041-a.md"], ["docs/decisions/0042-demo-guides.md"])
    answers(db, text={"pulls": "127\ttask/3-3-reader\n145\ttask/106-home-page",
                      "pulls/127/files": "docs/decisions/0042-reader.md\napps/x.ts",
                      "pulls/145/files": "docs/decisions/0045-home-page.md"})
    rc, err = gate(d, env, CREATE)
    assert rc == 2 and "0042-reader.md in #127" in err and "Rename it to 0046" in err, err


def test_a_draft_skips_the_number_check():
    d, db, env = project(["docs/decisions/0001-a.md"], ["docs/decisions/0001-b.md"])
    assert gate(d, env, CREATE + " --draft")[0] == 0


def test_the_number_check_fails_closed_when_github_cant_be_read():
    d, db, env = project([], ["docs/decisions/0001-b.md"])
    answers(db, text={}, json={})
    json.dump({}, open(db, "w"))
    rc, err = gate(d, env, CREATE)
    assert rc == 2 and "Could not check the decision and migration numbers" in err, err


# --- CI that never started -----------------------------------------------------------------------------------

BILLING = ("The job was not started because recent account payments have failed or your spending limit needs to be "
           "increased. Please check the 'Billing & plans' section in your settings")


def ci(env, sha="abc"):
    p = subprocess.run([sys.executable, os.path.join(HOOKS, "factory_ci.py"), sha], env=env, capture_output=True,
                       text=True)
    return p.returncode, p.stdout


def test_ci_that_never_started_is_told_apart_from_a_failure():
    d, db, env = project([], [])
    runs = {"check_runs": [{"id": 1, "conclusion": "failure"}, {"id": 2, "conclusion": "failure"}]}
    answers(db, json={"commits/abc/check-runs": runs, "check-runs/1/annotations": [{"message": BILLING}],
                      "check-runs/2/annotations": [{"message": BILLING}]})
    rc, out = ci(env)
    assert rc == 3 and "isn't a result about your code" in out and "spending limit" in out, (rc, out)


def test_one_real_failure_is_a_failure_even_next_to_billing():
    d, db, env = project([], [])
    runs = {"check_runs": [{"id": 1, "conclusion": "failure"}, {"id": 2, "conclusion": "failure"}]}
    answers(db, json={"commits/abc/check-runs": runs, "check-runs/1/annotations": [{"message": BILLING}],
                      "check-runs/2/annotations": [{"message": "billing.test.ts: expected 3, got 4"}]})
    assert ci(env) == (0, "")


def test_the_gate_explains_a_merge_blocked_by_ci_that_never_ran():
    d, db, env = project([], [])
    head = git(d, "rev-parse", "HEAD")
    pr = {"number": 7, "headRefName": "task/1-x", "headRefOid": head, "comments": [], "labels": []}
    fake = os.path.join(os.path.dirname(db), "bin", "gh")
    src = open(fake).read().replace('if a[:1] != ["api"]:', '''if a[:2] == ["pr", "view"]:
    print(json.dumps(db["pr"])); sys.exit(0)
if a[:2] == ["pr", "checks"]:
    sys.exit(1)
if a[:1] != ["api"]:''', 1)
    open(fake, "w").write(src)
    answers(db, pr=pr, text={"pulls/7/files": "src/a.ts"},
            json={f"commits/{head}/check-runs": {"check_runs": [{"id": 1, "conclusion": "failure"}]},
                  "check-runs/1/annotations": [{"message": BILLING}]})
    rc, err = gate(d, env, f"gh pr merge 7 --squash --match-head-commit {head}")
    assert rc == 2 and "CI didn't run on this commit" in err, err


# --- a finished branch waiting for a PR slot --------------------------------------------------------------------

def pick(d, env):
    p = subprocess.run([sys.executable, os.path.join(HOOKS, "factory_issues.py"), "pick", "--agent", "taytu"],
                       cwd=d, env=env, capture_output=True, text=True)
    return p.returncode, p.stdout.strip(), p.stderr.strip()


def issues_project(open_prs, branch_ahead=3):
    d, db, env = project([], [], cfg={"tasks": {"source": "issues"}, "agents": ["menelik", "taytu"], "maxOpenPRs": 2})
    mine = {"number": 107, "title": "Demo guides", "state": "open", "body": "", "milestone": None,
            "labels": [{"name": "factory:in-progress"}, {"name": "agent:taytu"}]}
    ready = {"number": 108, "title": "Next", "state": "open", "body": "", "milestone": None,
             "labels": [{"name": "factory:ready"}]}
    answers(db, json={"issues": [mine, ready], "branches": [{"name": "task/107-demo-guides"}],
                      "pulls": open_prs, "issues/107/comments": [], "compare/main...task/107-demo-guides": {"ahead_by": branch_ahead},
                      "user": {"login": "owner"}, "repos/{owner}/{repo}": {"full_name": "deresegetachew/remanual"}})
    return d, db, env


def pr(n, ref, draft=False, by="owner"):
    return {"number": n, "head": {"ref": ref}, "draft": draft, "user": {"login": by}}


def test_a_pushed_branch_waits_quietly_while_the_cap_is_full():
    d, db, env = issues_project([pr(115, "a"), pr(144, "b")])
    rc, out, err = pick(d, env)
    assert out == "none" and "#107 is ready on its branch and waits for a pull-request slot (2 of 2 open: #115, #144)" in err, (out, err)
    assert "issues/108/labels" not in open(db + ".log").read()  # it took no new work meanwhile


def test_the_issue_comes_back_once_a_slot_frees_or_a_draft_does_not_count():
    d, db, env = issues_project([pr(115, "a"), pr(144, "b", draft=True)])
    assert pick(d, env)[1] == "issue-107 Demo guides"


def test_a_branch_still_being_built_is_not_waiting():
    d, db, env = issues_project([pr(115, "a"), pr(144, "b")], branch_ahead=0)
    assert pick(d, env)[1] == "issue-107 Demo guides"


# --- a long-running loop keeps its name -------------------------------------------------------------------------

def checkout(d, env, pid):
    p = subprocess.run([sys.executable, os.path.join(HOOKS, "factory_claims.py"), "checkout", "--pid", str(pid)],
                       cwd=d, env=env, capture_output=True, text=True)
    return p.stdout.split()[0] if p.returncode == 0 else p.stderr


def test_a_loop_running_longer_than_claim_stale_hours_keeps_its_name():
    d, db, env = project([], [], cfg={"agents": ["menelik", "taytu"], "claimStaleHours": 6})
    # A stand-in for menelik's loop, still at its "next task in 10 s" prompt after 7 hours.
    loop = subprocess.Popen(["bash", "-c", "exec -a factory-loop.sh sleep 60"])
    try:
        assert checkout(d, env, loop.pid) == "menelik"
        claims = os.path.join(git(d, "rev-parse", "--absolute-git-dir"), "factory", "claims.json")
        data = json.load(open(claims))
        data["checkouts"]["menelik"]["at"] -= 7 * 3600
        json.dump(data, open(claims, "w"))
        assert checkout(d, env, os.getpid()) == "taytu"  # the second loop, not a second menelik
    finally:
        loop.kill()
        loop.wait()
    assert checkout(d, env, os.getpid()) in ("menelik",)  # menelik's loop ended: its name is free again


def test_a_reused_pid_of_another_program_does_not_hold_a_name():
    d, db, env = project([], [], cfg={"agents": ["menelik", "taytu"]})
    other = subprocess.Popen(["sleep", "60"])
    try:
        assert checkout(d, env, other.pid) == "menelik"
        assert checkout(d, env, os.getpid()) == "menelik"  # `sleep` is no loop: the old claim doesn't count
    finally:
        other.kill()
        other.wait()


def test_other_accounts_prs_do_not_fill_this_accounts_slots():
    d, db, env = issues_project([pr(115, "a", by="someone-else"), pr(144, "b", by="someone-else")])
    assert pick(d, env)[1] == "issue-107 Demo guides"


def test_a_timed_out_job_next_to_billing_is_a_real_result():
    d, db, env = project([], [])
    runs = {"total_count": 2, "check_runs": [{"id": 1, "conclusion": "failure"}, {"id": 2, "conclusion": "timed_out"}]}
    answers(db, json={"commits/abc/check-runs": runs, "check-runs/1/annotations": [{"message": BILLING}],
                      "check-runs/2/annotations": []})
    assert ci(env) == (0, "")


def test_more_runs_than_one_page_is_treated_as_a_real_result():
    d, db, env = project([], [])
    answers(db, json={"commits/abc/check-runs": {"total_count": 150, "check_runs": [{"id": 1, "conclusion": "failure"}]},
                      "check-runs/1/annotations": [{"message": BILLING}]})
    assert ci(env) == (0, "")


def test_only_a_loop_or_claude_by_its_program_holds_a_name():
    sys.path.insert(0, HOOKS)
    from factory_claims import is_loop
    procs = [subprocess.Popen(["bash", "-c", "exec -a factory-loop.sh sleep 30"]),
             subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)", "/home/claude/factory-loop.sh"])]
    try:
        assert is_loop(procs[0].pid)
        assert not is_loop(procs[1].pid)  # "claude" and "factory-loop" only as arguments don't count
    finally:
        for p in procs:
            p.kill(); p.wait()


def test_a_loop_in_a_folder_with_spaces_is_still_a_loop():
    sys.path.insert(0, HOOKS)
    from factory_claims import is_loop
    d = os.path.join(tempfile.mkdtemp(), "My Projects", "app")
    os.makedirs(d)
    script = os.path.join(d, "factory-loop.sh")
    open(script, "w").write("sleep 30\n")
    loop = subprocess.Popen(["bash", script, "-i"])
    try:
        assert is_loop(loop.pid)
    finally:
        loop.kill(); loop.wait()


def test_a_token_in_a_remote_url_is_never_printed():
    d, db, env = project([], [])
    git(d, "remote", "set-url", "origin", "https://x-access-token:SECRET123@github.com/old/app.git")
    answers(db, text={"repos/old/app": "new/app"})
    rc, out = remote(d, env, "--check")
    assert rc == 1 and "SECRET123" not in out and "https://***@github.com/old/app.git" in out, out
    rc, out = remote(d, env)
    assert "SECRET123" not in out, out
    assert git(d, "config", "--get", "remote.origin.url") == "https://x-access-token:SECRET123@github.com/new/app.git"


def test_the_loop_script_is_the_shells_first_argument():
    sys.path.insert(0, HOOKS)
    from factory_claims import runs_loop_script
    spaced = os.path.join(tempfile.mkdtemp(), "My Projects", "app")
    os.makedirs(spaced)
    open(os.path.join(spaced, "factory-loop.sh"), "w").write("")
    for args, want in [("factory-loop.sh -i", True), ("./factory-loop.sh", True), ("/x/factory-loop.sh 5", True),
                       ("-x factory-loop.sh", True), (f"{spaced}/factory-loop.sh -i", True),
                       ("/tmp/worker.sh /tmp/factory-loop.sh", False), ("worker.sh factory-loop.sh", False),
                       ("-c echo factory-loop.sh", False), ("/no such/dir/factory-loop.sh -i", False), ("", False)]:
        assert runs_loop_script(args) is want, (args, want)


def test_a_failed_commit_status_next_to_billing_is_a_real_result():
    d, db, env = project([], [])
    answers(db, json={"commits/abc/check-runs": {"total_count": 1, "check_runs": [{"id": 1, "conclusion": "failure"}]},
                      "check-runs/1/annotations": [{"message": BILLING}],
                      "commits/abc/status": {"total_count": 1, "statuses": [{"state": "failure", "context": "ext"}]}})
    assert ci(env) == (0, "")
    answers(db, json={"commits/abc/status": {"total_count": 0, "statuses": []}})
    assert ci(env)[0] == 3


def test_a_fork_pr_with_the_same_branch_name_is_not_this_branchs_pr():
    d, db, env = issues_project([pr(115, "a"), pr(144, "b"), pr(200, "task/107-demo-guides")])
    data = json.load(open(db))
    data["json"]["pulls"][2]["head"]["repo"] = {"full_name": "stranger/fork"}
    data["json"]["repos/{owner}/{repo}"] = {"full_name": "deresegetachew/remanual"}
    json.dump(data, open(db, "w"))
    rc, out, err = pick(d, env)
    assert out == "none" and "waits for a pull-request slot" in err, (out, err)


def test_a_task_waiting_for_a_slot_is_not_stale():
    d, db, env = issues_project([pr(115, "a"), pr(144, "b")])
    data = json.load(open(db))
    data["json"]["issues"][0]["updated_at"] = "2020-01-01T00:00:00Z"
    data["json"]["branches"][0]["commit"] = {"sha": "c1"}
    data["json"]["commits/c1"] = {"commit": {"committer": {"date": "2020-01-01T00:00:00Z"}}}
    json.dump(data, open(db, "w"))
    p = subprocess.run([sys.executable, os.path.join(HOOKS, "factory_issues.py"), "stale"], cwd=d, env=env,
                       capture_output=True, text=True)
    assert "#107" not in p.stdout, p.stdout + p.stderr


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
