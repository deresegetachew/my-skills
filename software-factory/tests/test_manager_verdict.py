#!/usr/bin/env python3
"""A headless sub-manager can post its verdict and read what a review needs (#202). The exact commands the sandbox
sub-managers tried are run against the real manager profile (Claude Code's allow/deny matching, replayed) and the real
manager_gate.py; the skill gives the verdict command; a review that ends with no verdict does not restart for ever; and
`factory doctor` replays the skill's commands against the profile.
  python3 software-factory/tests/test_manager_verdict.py"""
import fnmatch, json, os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import test_doctor as doc  # noqa: E402
import test_manager_gate as mg  # noqa: E402
import test_orchestrator as to  # noqa: E402

PROFILE = json.load(open(mg.PROFILE))["permissions"]
SKILL = open(mg.SKILL).read()

import importlib.util  # noqa: E402
_spec = importlib.util.spec_from_file_location("pr_gate", os.path.join(mg.SF, "hooks", "pr-gate.py"))
PG = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(PG)


def rule_matches(rule, kind, subject):
    m = re.fullmatch(kind + r"\((.*)\)", rule)
    return bool(m) and fnmatch.fnmatchcase(subject, m.group(1))


def allowed_by_profile(command):
    """Whether Claude Code would run `command` without asking: no `$(...)` or backticks, and every simple command in it
    matches an allow rule and no deny rule."""
    import shlex
    if "$(" in command or "`" in command:
        return False  # "can't be checked before it runs"
    for tokens in PG.simple_commands(command):
        text = " ".join(shlex.quote(t) if re.search(r"\s", t) else t for t in tokens)
        raw = " ".join(tokens)
        if any(rule_matches(r, "Bash", x) for r in PROFILE["deny"] for x in (text, raw)):
            return False
        if not any(rule_matches(r, "Bash", x) for r in PROFILE["allow"] for x in (text, raw)):
            return False
    return True


def edit_allowed(path):
    return any(rule_matches(r, "Edit", path) for r in PROFILE["allow"]) and not any(rule_matches(r, "Edit", path) for r in PROFILE["deny"])


def gate_passes(command):
    d, env = mg.world()
    code, msg = mg.gate(d, env, command)
    return code == 0, msg


# --- 1. the verdict command ---------------------------------------------------------------------------------------------

VERDICT_ONE_LINE = 'gh api -X POST repos/{owner}/{repo}/issues/15/comments -f body="<!-- factory-mustfix sha=%s -->  Must-fix: tests fail."' % ("a" * 40)
VERDICT_FILE = "gh api -X POST repos/{owner}/{repo}/issues/15/comments -F body=@tmp/manager-15.md"
CLOSE_5 = 'gh api -X POST repos/{owner}/{repo}/issues/5/comments -f body="<!-- pr-watch sha=%s -->  Superseded by main."' % ("a" * 40)


def test_a_verdict_comment_through_gh_api_is_allowed_by_the_profile_and_the_gate():
    for cmd in (VERDICT_ONE_LINE, VERDICT_FILE, CLOSE_5):
        assert allowed_by_profile(cmd), cmd
        ok, msg = gate_passes(cmd)
        assert ok, (cmd, msg)


def test_the_body_file_can_be_written_under_tmp_manager_and_nowhere_else():
    assert edit_allowed("tmp/manager-15.md")
    for path in ("tmp/other.md", "src/x.py", ".claude/settings.json", "docs/PRD.md", "/etc/passwd"):
        assert not edit_allowed(path), path


def test_pr_comment_review_and_merge_stay_unavailable_so_the_gh_api_form_is_the_only_one():
    for cmd in ("gh pr comment 15 --body x", "gh pr review 5 --request-changes --body x", "gh pr merge 5 --squash"):
        assert not allowed_by_profile(cmd), cmd


def test_a_heredoc_is_still_refused_by_the_gate_so_the_skill_must_not_suggest_one():
    assert not re.search(r"<<\s*'?EOF", SKILL), "the skill must not tell sub-managers to use a heredoc"


def test_the_skill_gives_the_exact_verdict_command_and_the_one_command_per_call_rule():
    assert "gh api -X POST repos/{owner}/{repo}/issues/<n>/comments" in SKILL, "step 5 names the verdict command"
    assert "-F body=@tmp/manager-" in SKILL, "a multi-line body goes through a file"
    assert re.search(r"never `gh pr comment`", SKILL, re.I) and "gh pr review" in SKILL
    assert re.search(r"one command per (Bash|shell) call", SKILL, re.I) and "$(" in SKILL


# --- 3. the read commands a review needs -------------------------------------------------------------------------------

def test_the_reads_a_review_needs_are_allowed_one_per_call():
    for cmd in ("gh run view 123 --log-failed", "git merge-tree origin/main origin/task/5-x", "git ls-tree -r origin/main --name-only",
                "git cat-file -p origin/main:README.md", "git merge-base origin/main origin/task/5-x"):
        assert allowed_by_profile(cmd), cmd
        ok, msg = gate_passes(cmd)
        assert ok, (cmd, msg)


def test_chained_and_substituted_commands_still_need_every_part_allowed():
    assert not allowed_by_profile("git merge-base a b; rm -rf x")
    assert not allowed_by_profile("git rev-parse HEAD | sh")
    assert not allowed_by_profile("git log $(git rev-parse HEAD)")


# --- doctor replays the skill's commands against the profile -----------------------------------------------------------

def manager_project(profile_allow=None, skill=SKILL):
    d = doc.project(cfg={"agents": ["taytu"]})
    prof = json.loads(json.dumps(json.load(open(mg.PROFILE))))
    if profile_allow is not None:
        prof["permissions"]["allow"] = profile_allow
    os.makedirs(os.path.join(d, ".claude", "manager"))
    json.dump(prof, open(os.path.join(d, ".claude", "manager", "settings.json"), "w"))
    os.makedirs(os.path.join(d, ".claude", "skills", "manage-pass"))
    open(os.path.join(d, ".claude", "skills", "manage-pass", "SKILL.md"), "w").write(skill)
    for h in ("manager_gate.py", "pr-gate.py"):
        os.symlink(os.path.join(doc.HOOKS, h), os.path.join(d, ".claude", "hooks", h)) if not os.path.exists(os.path.join(d, ".claude", "hooks", h)) else None
    return d


def test_doctor_is_quiet_when_every_command_the_skill_names_is_allowed_by_the_profile():
    d = manager_project()
    p = doc.doctor(d, {**doc.machine(), "FACTORY_AGENTS": "taytu"})
    assert [l for l in doc.lines(p, "ok") if "manager profile" in l and "skill" in l], p.stdout
    assert not [l for l in doc.lines(p, "fix") if "manager" in l], p.stdout


def test_doctor_fixes_a_profile_that_would_prompt_for_a_command_the_skill_names():
    allow = [r for r in PROFILE["allow"] if "gh run view" not in r]
    d = manager_project(profile_allow=allow)
    p = doc.doctor(d, {**doc.machine(), "FACTORY_AGENTS": "taytu"})
    fixes = [l for l in doc.lines(p, "fix") if "gh run view" in l]
    assert fixes and "factory update" in fixes[0] and p.returncode == 1, p.stdout


# --- 4. a review that ends with no verdict does not restart for ever ---------------------------------------------------

def run_sub(work, env):
    return to.py(work, env, "factory_orchestrator.py", "sub", "--name", "lead", "--item", "pr-5")


def green_world():
    return to.world(db={"pulls": [to.pr(5)], "commits": {to.H: to.iso(60)}, "checks": {to.H: [to.ok_run()]}})


def test_a_session_that_ends_with_no_review_marks_the_head_failed_and_asks_the_owner_once():
    d, work, env = green_world()
    run_sub(work, env)
    skips = to.skip_comments(d, 5)
    assert len(skips) == 1 and f"<!-- factory-review-failed sha={to.H} -->" in skips[0], to.posted(d, 5)
    run_sub(work, env)
    asks = [b for b in sum((to.posted(d, i["number"]) for i in to.db_of(d)["issues"]), []) if "factory-owner-ask id=review-failed-5" in b]
    assert len(asks) == 1, asks


def test_the_next_pass_does_not_restart_a_head_marked_failed_but_does_for_a_new_commit():
    d, work, env = green_world()
    run_sub(work, env)
    to.cycle(work, env, "--wait")
    calls_after_first = len(to.prompts(env))
    to.cycle(work, env, "--wait")
    assert len(to.prompts(env)) == calls_after_first, "a head marked failed is not started again"
    to.put(d, pulls=[to.pr(5, sha=to.H2)], commits={to.H2: to.iso(60)}, checks={to.H2: [to.ok_run()]})
    to.cycle(work, env, "--wait")
    assert len(to.prompts(env)) == calls_after_first + 1, "a new head is reviewed"


def test_a_conflict_or_unfinished_ci_is_not_marked_failed_because_it_can_change_by_itself():
    d, work, env = to.world(db={"pulls": [to.pr(5, mergeable_state="dirty")], "commits": {to.H: to.iso(60)}})
    run_sub(work, env)
    assert not [b for b in to.posted(d, 5) if "factory-review-failed" in b], to.posted(d, 5)


def test_a_green_task_pr_is_started_before_a_pr_without_green_ci():
    d, work, env = to.world(db={"pulls": [to.pr(1, sha="1" * 40, ref="docs/1"), to.pr(2, sha="2" * 40)],
                                "commits": {"1" * 40: to.iso(60), "2" * 40: to.iso(50)},
                                "checks": {"2" * 40: [to.ok_run()]}},
                            cfg={"manager": {"maxSubManagers": 1}})
    p = to.cycle(work, env, "--dry-run")
    lines = [l for l in p.stdout.splitlines() if "would start a sub-manager" in l]
    assert lines and "pr-2" in lines[0], p.stdout


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
