#!/usr/bin/env python3
"""The PR gate (pr-gate.py) against the bypasses the 22 Oct security audit found, with a fake `gh`.
  python3 software-factory/tests/test_pr_gate.py"""
import json, os, subprocess, sys, tempfile

KIT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "kit"))
SF = os.path.dirname(os.path.abspath(KIT))
GATE = os.path.join(SF, "hooks", "pr-gate.py")
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
if a[:1] == ["api"] and "/comments" in " ".join(a):
    if "thread" not in s:
        sys.exit("gh: no thread")
    print(json.dumps(s["thread"])); sys.exit(0)
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


def envelope(**kw):
    kw.setdefault("v", "1")
    return "<!-- factory-msg " + " ".join(f"{k.replace('_', '-')}={v}" for k, v in kw.items()) + " -->"


def post(d, env, text, n="7", cmd="pr"):
    body = os.path.join(d, "msg.md")
    open(body, "w").write(text)
    return gate(d, env, f"gh {cmd} comment {n} --body-file {body}")


def thread_of(*messages):
    return [{"id": i + 1, "body": b, "user": {"login": "me"}} for i, b in enumerate(messages)]


QUESTION_TO_HAILE = envelope(id="q1x", kind="question", **{"from": "taytu"}, to="haile", state="submitted", ref="pr#7")
ANSWER_FROM_HAILE = envelope(id="a1x", kind="answer", **{"from": "haile"}, to="taytu", state="completed",
                             in_reply_to="q1x", ref="pr#7") + "\nUse blue."


def test_an_agent_may_ask_a_question_in_the_new_form():
    d, env = setup()
    env["FACTORY_AGENT"] = "haile"
    q = envelope(id="q9x", kind="question", **{"from": "haile"}, to="po", state="submitted") + "\nWhich colour?"
    assert post(d, env, q) == (0, ""), post(d, env, q)
    assert post(d, env, q, n="9", cmd="issue")[0] == 0


def test_an_agent_cannot_post_as_someone_else():
    d, env = setup()
    env["FACTORY_AGENT"] = "haile"
    q = envelope(id="q9x", kind="question", **{"from": "po"}, state="submitted")
    rc, err = post(d, env, q)
    assert rc == 2 and "yourself" in err, (rc, err)


def test_agents_cannot_post_approvals_or_mustfixes_in_the_new_form():
    d, env = setup()
    env["FACTORY_AGENT"] = "haile"
    for kind, state in (("approval", "completed"), ("mustfix", "submitted")):
        rc, err = post(d, env, envelope(id="m1x", kind=kind, **{"from": "haile"}, state=state, sha="aaaaaaa"))
        assert rc == 2 and "reserved" in err, (kind, rc, err)


def test_an_agent_answers_only_a_question_addressed_to_it():
    d, env = setup(thread=thread_of(QUESTION_TO_HAILE))
    env["FACTORY_AGENT"] = "haile"
    assert post(d, env, ANSWER_FROM_HAILE) == (0, ""), post(d, env, ANSWER_FROM_HAILE)
    d, env = setup(thread=thread_of(QUESTION_TO_HAILE.replace("to=haile", "to=po")))
    env["FACTORY_AGENT"] = "haile"
    rc, err = post(d, env, ANSWER_FROM_HAILE)
    assert rc == 2 and "addressed to po" in err, (rc, err)


def test_a_po_answer_from_an_agent_is_refused():
    d, env = setup(thread=thread_of(QUESTION_TO_HAILE.replace("to=haile", "to=po")))
    env["FACTORY_AGENT"] = "haile"
    forged = ANSWER_FROM_HAILE.replace("from=haile", "from=po")
    rc, err = post(d, env, forged)
    assert rc == 2 and "yourself" in err, (rc, err)


def test_a_reply_must_name_its_thread_and_a_question_in_it():
    d, env = setup(thread=thread_of(QUESTION_TO_HAILE))
    env["FACTORY_AGENT"] = "haile"
    no_ref = ANSWER_FROM_HAILE.replace(" ref=pr#7", "")
    body = os.path.join(d, "msg.md")
    open(body, "w").write(no_ref)
    rc, err = gate(d, env, f"gh pr comment --body-file {body}")                       # no number and no ref: the thread is unknown
    assert rc == 2 and "ref=" in err, (rc, err)
    assert post(d, env, no_ref)[0] == 0                                               # the number on the command names it
    rc, err = post(d, env, ANSWER_FROM_HAILE.replace("in-reply-to=q1x", "in-reply-to=zzz"))
    assert rc == 2 and "can't find" in err, (rc, err)
    rc, err = post(d, env, ANSWER_FROM_HAILE.replace(" in-reply-to=q1x", ""))
    assert rc == 2 and "in-reply-to" in err, (rc, err)
    rc, err = post(d, env, ANSWER_FROM_HAILE, n="9")                                  # comments on 9 but ref says pr#7
    assert rc == 2 and "pr#7" in err, (rc, err)


def test_a_thread_gh_cannot_read_fails_closed():
    d, env = setup()                                                                   # the fake has no thread to give
    env["FACTORY_AGENT"] = "haile"
    rc, err = post(d, env, ANSWER_FROM_HAILE)
    assert rc == 2 and "read" in err, (rc, err)


def test_an_invalid_transition_is_refused():
    done = ANSWER_FROM_HAILE.replace("a1x", "a0x")
    d, env = setup(thread=thread_of(QUESTION_TO_HAILE, done))
    env["FACTORY_AGENT"] = "haile"
    rc, err = post(d, env, ANSWER_FROM_HAILE.replace("state=completed", "state=failed"))
    assert rc == 2 and "completed" in err, (rc, err)
    assert post(d, env, done)[0] == 0                                                 # the same message again is a no-op


def test_unknown_versions_and_plain_text_pass_and_old_markers_stay_reserved():
    d, env = setup()
    env["FACTORY_AGENT"] = "haile"
    assert post(d, env, envelope(v="2", id="a1x", kind="approval", state="completed"))[0] == 0
    assert post(d, env, "<!-- factory-answer -->\nx")[0] == 2
    assert post(d, env, envelope(id="a1x", kind="answer", **{"from": "haile"}, in_reply_to="q1x") + "\n<!-- factory-answer -->")[0] == 2


def test_a_merge_honours_a_mustfix_and_an_approval_in_the_new_form():
    mustfix = {"body": envelope(id="m1x", kind="mustfix", **{"from": "dev-manager"}, state="submitted", sha="aaaaaaa"),
               "author": {"login": "owner"}}
    d, env = setup(pr={"comments": [mustfix]})
    assert gate(d, env, MERGE)[0] == 2
    ok = {"body": envelope(id="p1x", kind="approval", **{"from": "dev-manager"}, state="completed", sha=HEAD[:7]),
          "author": {"login": "owner"}}
    d, env = setup(pr={"comments": [mustfix, ok]})
    assert gate(d, env, MERGE)[0] == 0
    d, env = setup(pr={"comments": [mustfix, ok]}, cfg_extra={"trustedReviewers": ["someone-else"]})
    assert gate(d, env, MERGE)[0] == 2


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


CI_CMD = "pnpm turbo run typecheck lint test build --filter=...[{base}]"


def give_origin(d):
    """A bare origin with one commit on main, so the gate's number check can fetch it."""
    git = ["git", "-C", d, "-c", "user.name=t", "-c", "user.email=t@t"]
    origin = tempfile.mkdtemp()
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", origin], check=True)
    open(os.path.join(d, "README"), "w").write("start\n")
    subprocess.run(git + ["add", "README"], check=True)
    subprocess.run(git + ["commit", "-q", "-m", "start"], check=True)
    subprocess.run(git + ["remote", "add", "origin", origin], check=True)
    subprocess.run(git + ["push", "-q", "origin", "HEAD:main"], check=True, capture_output=True)
    subprocess.run(git + ["fetch", "-q", "origin"], check=True)
    return git


def branch_with_a_commit(d):
    """A real task branch one commit past origin/main, reviewed; returns its HEAD."""
    git = give_origin(d)
    subprocess.run(git + ["checkout", "-q", "-b", "task/1-x"], check=True)
    os.makedirs(os.path.join(d, "src"), exist_ok=True)
    open(os.path.join(d, "src", "a.ts"), "w").write("x\n")
    subprocess.run(git + ["add", "src"], check=True)
    subprocess.run(git + ["commit", "-q", "-m", "work"], check=True)
    head = subprocess.run(git + ["rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    open(os.path.join(d, "tmp", "reviews", "task_1-x.ok"), "w").write(head)
    return head


def ci_mark(d, sha):
    open(os.path.join(d, "tmp", "reviews", "task_1-x.ci.ok"), "w").write(sha)


def test_a_ready_pr_needs_the_local_ci_check_for_its_head_commit():
    d, env = setup(cfg_extra={"commands": {"ci": CI_CMD}})
    give_origin(d)
    rc, err = gate(d, env, "gh pr ready 7")
    assert rc == 2 and "factory verify" in err, (rc, err)  # no marker
    ci_mark(d, "b" * 40)
    rc, err = gate(d, env, "gh pr ready 7")
    assert rc == 2 and "factory verify" in err, (rc, err)  # a marker for an older commit
    ci_mark(d, HEAD)
    assert gate(d, env, "gh pr ready 7") == (0, ""), gate(d, env, "gh pr ready 7")


def test_pr_create_needs_the_local_ci_check_but_a_draft_does_not():
    d, env = setup(cfg_extra={"commands": {"ci": CI_CMD}})
    head = branch_with_a_commit(d)
    rc, err = gate(d, env, "gh pr create --title x --body y")
    assert rc == 2 and "factory verify" in err, (rc, err)
    assert gate(d, env, "gh pr create --draft --title x --body y")[0] == 0
    ci_mark(d, head)
    assert gate(d, env, "gh pr create --title x --body y") == (0, ""), gate(d, env, "gh pr create --title x --body y")


def test_without_commands_ci_on_main_no_local_ci_check_is_needed():
    d, env = setup()
    give_origin(d)
    assert gate(d, env, "gh pr ready 7") == (0, "")
    # An agent can't switch the check off in its own copy of the settings either.
    d, env = setup(cfg_extra={"commands": {"ci": CI_CMD}})
    json.dump({"reviewMarkers": "tmp/reviews", "commands": {"ci": ""}}, open(os.path.join(d, ".claude", "factory.json"), "w"))
    assert gate(d, env, "gh pr ready 7")[0] == 2


def test_a_merge_doesnt_need_the_local_ci_check():
    d, env = setup(cfg_extra={"commands": {"ci": CI_CMD}})  # CI itself is green on GitHub by then
    assert gate(d, env, MERGE) == (0, ""), gate(d, env, MERGE)


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
