#!/usr/bin/env python3
"""The dev manager closes a superseded or obsolete pull request that a factory agent opened, and asks the owner about one
anyone else opened (#203). The real manager_gate.py and the real profile run against the exact commands; a fake gh answers
for the pull request. A merge is still never allowed by this path.
  python3 software-factory/tests/test_manager_close.py"""
import json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import test_manager_gate as mg  # noqa: E402
import test_manager_verdict as mv  # noqa: E402

CLOSE = "gh api -X PATCH repos/{owner}/{repo}/pulls/7 -f state=closed"
SKILL = open(mg.SKILL).read()


def gate(pr=None, command=CLOSE):
    d, env = mg.world(pr=pr)
    return mg.gate(d, env, command)


def test_closing_a_pull_request_from_a_factory_agents_task_branch_is_allowed_by_the_profile_and_the_gate():
    assert mv.allowed_by_profile(CLOSE)
    code, msg = gate({"head": {"sha": mg.HEAD, "ref": "task/12-guard-rails"}})
    assert code == 0, msg


def test_closing_works_with_the_field_flag_spelling_and_a_state_in_any_order():
    for cmd in ("gh api -X PATCH repos/{owner}/{repo}/pulls/7 -F state=closed",
                "gh api repos/{owner}/{repo}/pulls/7 --method PATCH --raw-field state=closed -f base=main"):
        code, msg = gate(command=cmd)
        assert code == 0, (cmd, msg)


def test_a_pull_request_from_anyone_elses_branch_is_refused_with_an_owner_queue_ask():
    for ref in ("feature/login", "owner-fix", "docs/readme"):
        code, msg = gate({"head": {"sha": mg.HEAD, "ref": ref}})
        assert code == 2 and "owner" in msg and "factory-owner-ask" in msg, (ref, msg)


def test_a_pull_request_from_a_fork_is_refused_even_on_a_task_branch():
    code, msg = gate({"head": {"sha": mg.HEAD, "ref": "task/12-x", "repo": {"full_name": "someone/fork"}}, "base": {"repo": {"full_name": "me/repo"}}})
    assert code == 2 and "owner" in msg, msg


def test_the_managers_own_pull_request_may_be_closed():
    code, msg = gate({"head": {"sha": mg.HEAD, "ref": "manager/notes"}})
    assert code == 0, msg


def test_a_closed_or_missing_pull_request_is_left_to_github():
    code, msg = gate({"state": "closed", "head": {"sha": mg.HEAD, "ref": "feature/x"}})
    assert code == 0, msg


def test_retargeting_and_other_edits_to_a_pull_request_are_not_closing_and_are_untouched():
    for cmd in ("gh api -X PATCH repos/{owner}/{repo}/pulls/7 -f base=main", "gh api -X PATCH repos/{owner}/{repo}/pulls/7 -f state=open"):
        code, msg = gate({"head": {"sha": mg.HEAD, "ref": "feature/x"}}, cmd)
        assert code == 0, (cmd, msg)


def test_a_close_the_gate_cannot_read_is_refused():
    for cmd in ("gh api -X PATCH repos/{owner}/{repo}/pulls/7 --input body.json", "gh api -X PATCH repos/{owner}/{repo}/pulls/7 -f state=$S"):
        code, msg = gate({"head": {"sha": mg.HEAD, "ref": "task/12-x"}}, cmd)
        assert code == 2, (cmd, msg)


def test_merging_and_gh_pr_close_stay_unavailable():
    assert not mv.allowed_by_profile("gh pr close 7")
    assert not mv.allowed_by_profile("gh pr merge 7")


def test_the_skill_states_both_rules_and_the_exact_commands():
    assert "state=closed" in SKILL and "gh api -X PATCH repos/{owner}/{repo}/pulls/<n>" in SKILL
    assert re.search(r"superseded", SKILL) and re.search(r"task/", SKILL), "which pull requests it may close"
    assert re.search(r"owner-queue ask", SKILL) and re.search(r"opened by (the owner|a person|anyone else)", SKILL, re.I)
    assert re.search(r"comment.*(why|reason).*(commit|sha)", SKILL, re.I | re.S), "the comment says why and which commit supersedes it"


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
