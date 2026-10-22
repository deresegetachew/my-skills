#!/usr/bin/env python3
"""The PR gate (pr-gate.py) against the bypasses the 22 Oct security audit found, with a fake `gh`.
  python3 software-factory/tests/test_pr_gate.py"""
import json, os, subprocess, sys, tempfile

KIT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "kit"))
GATE = os.path.join(KIT, ".claude", "hooks", "pr-gate.py")
HEAD = "a" * 40

# Answers from a scenario file; every call is logged, so a test can see which PR the gate looked at.
FAKE_GH = r'''#!/usr/bin/env python3
import json, os, sys
s = json.load(open(os.environ["GATE_SCENARIO"]))
a = sys.argv[1:]
open(os.environ["GATE_LOG"], "a").write(" ".join(a) + "\n")
if s.get("gh_broken"):
    sys.exit("gh: not signed in")
if a[:2] == ["pr", "view"]:
    print(json.dumps(s["pr"])); sys.exit(0)
if a[:2] == ["pr", "checks"]:
    sys.exit(0 if s.get("ci_green", True) else 1)
if a[:2] == ["pr", "list"]:
    print(json.dumps(s.get("open_prs", []))); sys.exit(0)
if a[:1] == ["api"] and "/files" in " ".join(a):
    print("\n".join(s.get("files", ["src/a.ts"]))); sys.exit(0)
if a[:1] == ["api"] and "/issues/" in " ".join(a):
    print(json.dumps(s.get("issue", {"state": "open", "labels": []}))); sys.exit(0)
sys.exit("fake gh: no answer for " + " ".join(a))
'''


def setup(pr=None, cfg_extra=None, **scenario):
    d = tempfile.mkdtemp()
    os.makedirs(os.path.join(d, "bin"))
    os.makedirs(os.path.join(d, ".claude"))
    os.makedirs(os.path.join(d, "tmp", "reviews"))
    gh = os.path.join(d, "bin", "gh")
    open(gh, "w").write(FAKE_GH)
    os.chmod(gh, 0o755)
    cfg = {"reviewMarkers": "tmp/reviews", "protected": [r"^\.claude/"], "alwaysAllowed": [], "maxOpenPRs": 3,
           **(cfg_extra or {})}
    json.dump(cfg, open(os.path.join(d, ".claude", "factory.json"), "w"))
    open(os.path.join(d, "tmp", "reviews", "task_1-x.ok"), "w").write(HEAD)  # the reviewer passed HEAD
    pr = {"number": 7, "headRefName": "task/1-x", "headRefOid": HEAD, "comments": [], "labels": [], "body": "",
          **(pr or {})}
    json.dump({"pr": pr, **scenario}, open(os.path.join(d, "scenario.json"), "w"))
    subprocess.run(["git", "init", "-q", d], check=True)
    env = {**os.environ, "PATH": f"{d}/bin:{os.environ['PATH']}", "GATE_SCENARIO": os.path.join(d, "scenario.json"),
           "GATE_LOG": os.path.join(d, "log")}
    env.pop("FACTORY_AGENT", None)
    return d, env


def gate(d, env, command):
    p = subprocess.run([sys.executable, GATE], cwd=d, env=env, capture_output=True, text=True,
                       input=json.dumps({"tool_input": {"command": command}}))
    return p.returncode, p.stderr


def log(d):
    return open(os.path.join(d, "log")).read() if os.path.exists(os.path.join(d, "log")) else ""


MERGE = f"gh pr merge 7 --squash --match-head-commit {HEAD}"


def test_a_good_merge_passes():
    d, env = setup()
    assert gate(d, env, MERGE) == (0, ""), gate(d, env, MERGE)


def test_other_commands_pass_untouched():
    d, env = setup()
    for c in ("git status", "pnpm test", "gh pr view 7", "gh pr list", "echo gh-pr-merge"):
        assert gate(d, env, c)[0] == 0, c


def test_fails_closed_on_a_broken_config():
    d, env = setup()
    open(os.path.join(d, ".claude", "factory.json"), "w").write("{ not json")
    rc, err = gate(d, env, MERGE)
    assert rc == 2 and "PR gate hit an error" in err, (rc, err)


def test_fails_closed_when_gh_fails():
    d, env = setup(gh_broken=True)
    assert gate(d, env, MERGE)[0] == 2


def test_the_pr_number_after_flags_is_the_one_checked():
    d, env = setup()
    gate(d, env, f"gh pr merge --squash 99 --match-head-commit {HEAD}")
    assert "pr view 99 " in log(d), log(d)


def test_a_merge_needs_the_checked_head_commit():
    d, env = setup()
    rc, err = gate(d, env, "gh pr merge 7 --squash")
    assert rc == 2 and "--match-head-commit" in err, err
    assert gate(d, env, "gh pr merge 7 --squash --match-head-commit " + "b" * 40)[0] == 2


def test_hidden_merges_are_gated():
    d, env = setup(ci_green=False)
    for c in (f"gh -R o/r pr merge 7 --match-head-commit {HEAD}", f"cd x && gh pr merge 7 --match-head-commit {HEAD}",
              f"/usr/bin/gh pr merge 7 --match-head-commit {HEAD}"):
        assert gate(d, env, c)[0] == 2, c  # CI is red, so every one of these must be blocked


def test_one_merge_per_command_and_no_push_with_it():
    d, env = setup()
    assert gate(d, env, f"{MERGE}; gh pr merge 8 --match-head-commit {HEAD}")[0] == 2
    assert gate(d, env, f"git push origin task/1-x && {MERGE}")[0] == 2


def test_pr_new_and_ready_are_gated_like_create():
    d, env = setup()
    os.remove(os.path.join(d, "tmp", "reviews", "task_1-x.ok"))
    assert gate(d, env, "gh pr ready 7")[0] == 2
    assert gate(d, env, "gh pr new --title x --body y")[0] == 2
    assert gate(d, env, "gh pr create --draft --title x --body y")[0] == 0  # drafts are for questions
    assert gate(d, env, "gh pr create --title 'not a -d draft' --body y")[0] == 2


def test_aliases_are_refused():
    d, env = setup()
    assert gate(d, env, "gh alias set m 'pr merge'")[0] == 2
    assert gate(d, env, "gh m 7")[0] == 2


def test_agents_cannot_post_dev_manager_markers_or_touch_review_labels():
    d, env = setup()
    body = os.path.join(d, "body.md")
    open(body, "w").write("<!-- factory-approved sha=aaaaaaa -->")
    for c in ("gh pr comment 7 --body '<!-- factory-approved sha=aaaaaaa -->'",
              f"gh pr comment 7 --body-file {body}",
              "gh issue comment 9 -b '<!-- factory-answer -->'",
              "gh pr edit 7 --remove-label factory-hold",
              "gh pr edit 7 --add-label tests-reviewed",
              "gh pr review 7 --approve"):
        assert gate(d, env, c)[0] == 2, c
    assert gate(d, env, "gh pr comment 7 --body '<!-- factory-question --> which one?'")[0] == 0


def test_a_mustfix_holds_until_an_approval_of_this_commit():
    mustfix = {"body": "<!-- factory-mustfix sha=aaaaaaa -->", "author": {"login": "owner"}}
    d, env = setup(pr={"comments": [mustfix]})
    assert gate(d, env, MERGE)[0] == 2
    old = {"body": "<!-- factory-approved sha=bbbbbbb -->", "author": {"login": "owner"}}
    d, env = setup(pr={"comments": [mustfix, old]})
    assert gate(d, env, MERGE)[0] == 2  # approval of another commit
    ok = {"body": f"<!-- factory-approved sha={HEAD[:7]} -->", "author": {"login": "owner"}}
    d, env = setup(pr={"comments": [mustfix, ok]})
    assert gate(d, env, MERGE)[0] == 0


def test_only_trusted_reviewers_approvals_count():
    mustfix = {"body": "<!-- factory-mustfix sha=aaaaaaa -->", "author": {"login": "owner"}}
    forged = {"body": f"<!-- factory-approved sha={HEAD[:7]} -->", "author": {"login": "agent-bot"}}
    d, env = setup(pr={"comments": [mustfix, forged]}, cfg_extra={"trustedReviewers": ["owner"]})
    assert gate(d, env, MERGE)[0] == 2


def test_hold_label_and_protected_files_beyond_100():
    d, env = setup(pr={"labels": [{"name": "factory-hold"}]})
    assert gate(d, env, MERGE)[0] == 2
    many = [f"src/f{i}.ts" for i in range(150)] + [".claude/settings.json"]
    d, env = setup(files=many)
    rc, err = gate(d, env, MERGE)
    assert rc == 2 and ".claude/settings.json" in err, err


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
