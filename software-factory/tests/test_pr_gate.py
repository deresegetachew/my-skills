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
if a[:2] == ["repo", "view"]:
    print(s.get("default_branch", "main")); sys.exit(0)
if a[:1] == ["api"] and "/contents/.claude/factory.json" in " ".join(a):
    if s.get("settings_error"):
        sys.exit(s["settings_error"])
    if s.get("main_settings") is None:
        sys.exit("gh: Not Found (HTTP 404)")
    print(json.dumps(s["main_settings"])); sys.exit(0)
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
    # The gate reads the settings from GitHub's default branch (#51): the fake gh serves the same ones.
    json.dump({"pr": pr, "main_settings": cfg, **scenario}, open(os.path.join(d, "scenario.json"), "w"))
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


def test_copilot_review_points_on_pr_36():
    d, env = setup()
    reply = os.path.join(d, "reply.md")
    open(reply, "w").write("<!-- factory-approved sha=aaaaaaa -->")
    assert gate(d, env, f"gh pr comment 7 -F{reply}")[0] == 2  # attached short value is read
    assert gate(d, env, "gh pr create --draft --label tests-reviewed --title x --body y")[0] == 2
    assert gate(d, env, f"gh -R other/repo pr comment 7 --body hi")[0] == 2  # other repos aren't checked
    os.remove(os.path.join(d, "tmp", "reviews", "task_1-x.ok"))
    assert gate(d, env, "gh pr create --draft=false --title x --body y")[0] == 2  # not a draft
    assert gate(d, env, "gh pr ready 7 --undo")[0] == 0  # back to draft needs nothing
    assert gate(d, env, f"gh pr merge https://github.com/other/repo/pull/7 --match-head-commit {HEAD}")[0] == 2
    d, env = setup(cfg_extra={"holdLabel": "review-in-progress"})
    assert gate(d, env, "gh pr edit 7 --remove-label review-in-progress")[0] == 2


def test_copilot_second_review_on_pr_36():
    d, env = setup()
    gate(d, env, f"gh pr merge -s 99 --match-head-commit {HEAD}")
    assert "pr view 99 " in log(d), log(d)  # -s is squash, not a value
    assert gate(d, env, 'gh pr comment 7 --body "$(cat reply.md)"')[0] == 2
    assert gate(d, env, "gh pr comment 7 --body `cat reply.md`")[0] == 2
    assert gate(d, env, 'gh pr comment 7 --body "$TEXT"')[0] == 2
    assert gate(d, env, "gh pr create --title x --body 'Closes #1'")[0] == 2  # no origin/main: git diff fails


def test_copilot_third_review_on_pr_36():
    d, env = setup(ci_green=False)
    for c in (f"bash -lc 'gh pr merge 7 --match-head-commit {HEAD}'", f"sh -c \"gh pr merge 7\"",
              "eval 'gh pr comment 7 --body hi'"):
        assert gate(d, env, c)[0] == 2, c
    d, env = setup()
    os.remove(os.path.join(d, "tmp", "reviews", "task_1-x.ok"))
    assert gate(d, env, "gh pr create --draft --draft=false --title x --body y")[0] == 2
    assert gate(d, env, "gh pr ready 7 --undo=false")[0] == 2
    assert gate(d, env, "echo 'use gh to open it'")[0] == 0  # plain text mentioning gh is fine


def test_copilot_fourth_review_on_pr_36():
    d, env = setup(ci_green=False)
    assert gate(d, env, f"gh pr \\\nmerge 7 --match-head-commit {HEAD}")[0] == 2  # backslash-newline
    assert gate(d, env, f"gh -Rother/repo pr merge 7 --match-head-commit {HEAD}")[0] == 2
    assert gate(d, env, f"gh pr merge 7 -Rother/repo --match-head-commit {HEAD}")[0] == 2
    assert gate(d, env, f"env GH_DEBUG=1 gh pr merge 7 --match-head-commit {HEAD}")[0] == 2  # still gh
    assert gate(d, env, "echo gh pr merge 7 --squash")[0] == 0  # gh as data, not the program
    assert gate(d, env, "grep -n 'gh pr merge' README.md")[0] == 0


def test_copilot_fifth_review_on_pr_36():
    d, env = setup(ci_green=False)
    for c in (f"if gh pr merge 7 --match-head-commit {HEAD}; then :; fi",
              f"! gh pr merge 7 --match-head-commit {HEAD}",
              'result="$(gh pr merge 7 --squash)"', "echo `gh pr merge 7`",
              "gh pr edit 7 --add-label \"$LABEL\"",
              "cd ../other && gh pr ready 7"):
        assert gate(d, env, c)[0] == 2, c



def test_agents_cannot_delete_remote_branches():
    d, env = setup()
    for c in ("git push origin :task/1-x", "git -C . push origin :x", "true && git push origin +:x",
              "git push origin a:a :b", "bash -c 'git push origin :x'"):
        rc, err = gate(d, env, c)
        assert rc == 2 and "delete remote branches" in err, (c, rc, err)
    for c in ("git push origin task/1-x", "git push -u origin HEAD", "git push origin task/1-x:task/1-x",
              "git push origin HEAD:refs/heads/task/1-x", "echo push: done"):
        assert gate(d, env, c)[0] == 0, c


def test_gh_run_through_a_package_runner_is_refused():
    d, env = setup()
    for c in (f"pnpm exec gh pr merge 7 --squash --match-head-commit {HEAD}", "npx gh pr merge 7",
              "pnpm dlx gh pr merge 7", "yarn exec gh pr comment 7 --body x"):
        rc, err = gate(d, env, c)
        assert rc == 2, (c, rc, err)
    for c in ("pnpm test", "pnpm -s typecheck", "npx vitest run"):
        assert gate(d, env, c)[0] == 0, c


def test_the_worktree_copy_of_the_settings_changes_nothing():
    # Main's settings protect .claude/ and know the hold label; the agent edits its own copy to drop both.
    d, env = setup(pr={"labels": [{"name": "factory-hold"}]})
    cfg = json.load(open(os.path.join(d, ".claude", "factory.json")))
    json.dump({**cfg, "holdLabel": "none", "protected": []}, open(os.path.join(d, ".claude", "factory.json"), "w"))
    rc, err = gate(d, env, MERGE)
    assert rc == 2 and "factory-hold" in err, (rc, err)
    d, env = setup(files=[".claude/settings.json"])
    cfg = json.load(open(os.path.join(d, ".claude", "factory.json")))
    json.dump({**cfg, "protected": []}, open(os.path.join(d, ".claude", "factory.json"), "w"))
    rc, err = gate(d, env, MERGE)
    assert rc == 2 and ".claude/settings.json" in err, (rc, err)


def test_settings_the_gate_cannot_read_from_github_fail_closed():
    d, env = setup(settings_error="gh: HTTP 500")
    rc, err = gate(d, env, MERGE)
    assert rc == 2 and "factory.json" in err, (rc, err)


def test_no_settings_on_main_yet_means_the_defaults():
    d, env = setup(files=[".claude/settings.json"], main_settings=None)
    rc, err = gate(d, env, MERGE)
    assert rc == 2 and ".claude/settings.json" in err, (rc, err)  # the default `protected` covers .claude/


def test_local_refs_and_mainbranch_cannot_steer_the_settings():
    # The agent points mainBranch at its own branch and plants a local `origin/main` with permissive settings.
    d, env = setup(files=[".claude/settings.json"])
    cfg = json.load(open(os.path.join(d, ".claude", "factory.json")))
    json.dump({**cfg, "mainBranch": "task/x", "protected": []}, open(os.path.join(d, ".claude", "factory.json"), "w"))
    git = ["git", "-C", d, "-c", "user.name=t", "-c", "user.email=t@t"]
    subprocess.run(git + ["add", "-A"], check=True)
    subprocess.run(git + ["commit", "-q", "-m", "x"], check=True)
    subprocess.run(git + ["branch", "origin/main"], check=True)
    subprocess.run(git + ["update-ref", "refs/remotes/origin/main", "HEAD"], check=True)
    rc, err = gate(d, env, MERGE)
    assert rc == 2 and ".claude/settings.json" in err, (rc, err)


def test_the_kits_settings_protect_the_mcp_config():
    # Claude starts the servers in main's .mcp.json without asking (#55), so a change to it needs a person.
    kit_cfg = json.load(open(os.path.join(KIT, ".claude", "factory.json")))
    d, env = setup(files=[".mcp.json"], cfg_extra={"protected": kit_cfg["protected"]})
    rc, err = gate(d, env, MERGE)
    assert rc == 2 and ".mcp.json" in err, (rc, err)
    deny = json.load(open(os.path.join(KIT, ".claude", "settings.json")))["permissions"]["deny"]
    assert "Edit(./.mcp.json)" in deny, deny

if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
