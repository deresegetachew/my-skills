#!/usr/bin/env python3
"""`factory status`: one read-only view of agents, pull requests, CI and tasks across machines (#64), against a fake
`gh` that answers from a scenario and logs every call.  python3 software-factory/tests/test_status.py"""
import json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
KIT = os.path.abspath(os.path.join(HERE, "..", "kit"))
HOOKS = os.path.join(KIT, ".claude", "hooks")
SHA = "c" * 40

FAKE_GH = r'''#!/usr/bin/env python3
import json, os, sys
from urllib.parse import urlparse
s = json.load(open(os.environ["STATUS_SCENARIO"]))
a = sys.argv[1:]
open(os.environ["STATUS_LOG"], "a").write(" ".join(a) + "\n")
if a[:2] == ["repo", "view"]:  # the default branch, for main's settings
    print("main"); sys.exit(0)
method = a[a.index("-X") + 1] if "-X" in a else "GET"
if a[:1] != ["api"] or method != "GET" or "--input" in a or "-f" in a or "-F" in a:
    sys.exit("fake gh: status must only read")
path = urlparse([x for x in a[1:] if not x.startswith("-") and x not in ("GET", "Accept: application/vnd.github+json")][0]
                .replace("repos/{owner}/{repo}/", "")).path
if path == "contents/.claude/factory.json":
    if "main_settings" not in s:
        sys.exit("gh: Not Found (HTTP 404)")
    print(json.dumps(s["main_settings"])); sys.exit(0)
if path in s.get("broken", []):
    sys.exit("gh: HTTP 403")
if path in s:
    print(json.dumps(s[path])); sys.exit(0)
if path.startswith("issues/") and path.endswith("/comments"):
    print("[]"); sys.exit(0)
sys.exit("fake gh: no answer for " + path)
'''


def setup(scenario, cfg):
    d = tempfile.mkdtemp()
    subprocess.run(["git", "init", "-q", "-b", "main", d], check=True)
    os.makedirs(os.path.join(d, ".claude", "hooks"))
    os.makedirs(os.path.join(d, "bin"))
    for f in os.listdir(HOOKS):
        if f.endswith(".py"):
            os.symlink(os.path.join(HOOKS, f), os.path.join(d, ".claude", "hooks", f))
    json.dump(cfg, open(os.path.join(d, ".claude", "factory.json"), "w"))
    open(os.path.join(d, "bin", "gh"), "w").write(FAKE_GH)
    os.chmod(os.path.join(d, "bin", "gh"), 0o755)
    json.dump(scenario, open(os.path.join(d, "scenario.json"), "w"))
    env = {**os.environ, "PATH": f"{d}/bin:{os.environ['PATH']}", "STATUS_SCENARIO": os.path.join(d, "scenario.json"),
           "STATUS_LOG": os.path.join(d, "log")}
    for k in ("FACTORY_AGENT", "FACTORY_LOOP", "CLAUDE_PROJECT_DIR"):
        env.pop(k, None)
    return d, env


def status(d, env, *args):
    return subprocess.run(["bash", os.path.join(KIT, "factory"), "status", *args], cwd=d, env=env,
                          capture_output=True, text=True, timeout=60)


def agent_issue(name, status, ping):
    return {"number": 90, "title": f"Agent: {name} · {status}", "state": "open", "labels": [{"name": "factory:agent"}],
            "body": f"<!-- factory-agent name={name} status={status} ping={ping} -->"}


def task(n, label, milestone=None):
    return {"number": n, "title": f"Task {n}", "state": "open", "body": "", "labels": [{"name": label}],
            "milestone": {"number": 1, "title": milestone} if milestone else None}


ISSUES_MODE = {"tasks": {"source": "issues"}, "reviewMarkers": "tmp/reviews", "agents": ["menelik", "taytu"]}


def scenario():
    now = "2099-01-01T00:00:00Z"  # a ping in the future: never silent, whatever the clock says
    return {
        "issues": [agent_issue("taytu", "working", now), task(5, "factory:ready", "Phase 3"),
                   task(6, "factory:ready", "Phase 3"), task(7, "factory:in-progress"), task(8, "factory:blocked")],
        "pulls": [{"number": 12, "title": "Task 7", "draft": False, "body": "Closes #7\nA person merges this one: CI",
                   "head": {"sha": SHA, "ref": "task/7-x"}, "labels": [{"name": "factory-hold"}]}],
        f"commits/{SHA}/check-runs": {"check_runs": [{"status": "completed", "conclusion": "failure"}]},
        "issues/12/comments": [{"body": "<!-- factory-mustfix --> fix the test"}],
        "actions/runs": {"workflow_runs": [{"created_at": "2020-01-01T00:00:00Z", "status": "queued"}]},
        "actions/runners": {"runners": [{"name": "dev-pc-1", "status": "online", "busy": True}]},
    }


def test_one_view_of_agents_prs_ci_and_tasks():
    d, env = setup(scenario(), ISSUES_MODE)
    os.makedirs(os.path.join(d, "tmp", "reviews"))
    open(os.path.join(d, "tmp", "reviews", "task_7-x.ok"), "w").write(SHA)
    p = status(d, env)
    assert p.returncode == 0, p
    out = p.stdout
    assert "taytu" in out and "working" in out, out
    assert "#12" in out and "CI failed" in out and "reviewed" in out and "hold" in out, out
    assert "must-fix" in out and "a person merges it" in out, out
    assert "1 queued" in out and "dev-pc-1 online busy" in out, out
    assert "ready: 2 in Phase 3" in out and "in progress 1" in out and "blocked 1" in out, out


def test_json_for_scripts():
    d, env = setup(scenario(), ISSUES_MODE)
    p = status(d, env, "--json")
    s = json.loads(p.stdout)
    assert s["pulls"]["pulls"][0]["ci"] == "failed", s
    assert s["pulls"]["pulls"][0]["reviewed"] is None, "no marker on this machine: unknown, not false"
    assert s["tasks"]["ready"] == {"Phase 3": 2}, s


def test_it_only_reads():
    d, env = setup(scenario(), ISSUES_MODE)
    status(d, env)
    calls = open(os.path.join(d, "log")).read().splitlines()
    reads = [c for c in calls if not c.startswith("repo view --json defaultBranchRef")]  # main's name: a read too
    assert reads and all(c.startswith("api ") and (" -X " not in c or " -X GET " in c) for c in reads), calls


def test_a_section_github_cant_answer_says_so_and_the_rest_still_shows():
    s = scenario()
    s["broken"] = ["actions/runs", "actions/runners"]
    d, env = setup(s, ISSUES_MODE)
    p = status(d, env)
    assert p.returncode == 0, p
    assert "can't read it" in p.stdout and "#12" in p.stdout and "ready: 2 in Phase 3" in p.stdout, p.stdout
    s = scenario()
    s["broken"] = ["actions/runners"]  # listing runners needs admin
    d, env = setup(s, ISSUES_MODE)
    assert "runners: can't be listed" in status(d, env).stdout



OTHER = "d" * 40


def dev_manager_view(comments, main_settings=None, local=None):
    s = scenario()
    s["issues/12/comments"] = comments
    if main_settings is not None:
        s["main_settings"] = main_settings
    d, env = setup(s, {**ISSUES_MODE, **(local or {})})
    p = status(d, env, "--json")
    assert p.returncode == 0, p
    return json.loads(p.stdout)["pulls"]["pulls"][0]["devManager"]


def c(body, login="dm"):
    return {"body": body, "user": {"login": login}}


def test_an_approval_counts_only_as_the_gate_counts_it():
    # Only for the head commit, and (with trustedReviewers on main) only from a trusted login (#85 review).
    assert dev_manager_view([c(f"<!-- factory-approved sha={SHA[:12]} -->")]) == "approved"
    assert dev_manager_view([c(f"<!-- factory-approved sha={OTHER[:12]} -->")]) == "approval stale"
    assert dev_manager_view([c("<!-- factory-approved -->")]) == "approval stale"  # names no commit
    trusted = {**ISSUES_MODE, "trustedReviewers": ["dm"]}
    assert dev_manager_view([c(f"<!-- factory-approved sha={SHA[:12]} -->", login="agent")], trusted) is None
    assert dev_manager_view([c("<!-- factory-mustfix -->"),
                             c(f"<!-- factory-approved sha={SHA[:12]} -->", login="agent")], trusted) == "must-fix"
    # trustedReviewers comes from main, not this worktree's copy.
    assert dev_manager_view([c(f"<!-- factory-approved sha={SHA[:12]} -->", login="agent")], trusted,
                            local={"trustedReviewers": []}) is None


def test_a_must_fix_holds_until_an_approval_of_the_head_and_says_when_it_is_for_an_older_commit():
    assert dev_manager_view([c(f"<!-- factory-mustfix sha={SHA} -->")]) == "must-fix"
    assert dev_manager_view([c(f"<!-- factory-mustfix sha={OTHER} -->")]) == "must-fix (older commit)"
    assert dev_manager_view([c("<!-- factory-mustfix -->"), c(f"<!-- factory-approved sha={SHA} -->")]) == "approved"
    assert dev_manager_view([c(f"<!-- factory-approved sha={SHA} -->"), c("<!-- factory-mustfix -->")]) == "must-fix"


def test_one_prs_ci_failing_to_read_shows_ci_unknown_and_keeps_the_rest():
    s = scenario()
    s["broken"] = [f"commits/{SHA}/check-runs"]
    d, env = setup(s, ISSUES_MODE)
    out = status(d, env).stdout
    assert "#12" in out and "CI unknown" in out, out


def test_claims_and_the_next_task_that_cant_be_read_say_so():
    d, env = setup(scenario(), {"reviewMarkers": "tmp/reviews"})  # plan mode: no build plan, no origin
    hooks = os.path.join(d, ".claude", "hooks")
    for f in ("factory_claims.py", "next_task.py"):
        os.remove(os.path.join(hooks, f))
        open(os.path.join(hooks, f), "w").write("import sys\nsys.exit('boom')\n")
    out = status(d, env).stdout
    assert "claims: can't read them" in out and "no claims" not in out, out
    assert "next task: can't read it" in out and "nothing ready" not in out, out

if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
