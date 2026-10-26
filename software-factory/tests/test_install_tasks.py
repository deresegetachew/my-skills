#!/usr/bin/env python3
"""A first release install makes the tasks choice visible and one step (#245): `factory update vX --tasks plan|issues`
writes tasks.source into the install's factory.json, and without the flag the install prints where the tasks come from and
how to change it. It never runs `factory issues setup` (that writes to GitHub).  python3 software-factory/tests/test_install_tasks.py"""
import json, os, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_release_client import UNITTEST_TESTS, commit, fac, snapshot, stack_world  # noqa: E402

LINE = ("Tasks: from the build plan (docs/build-plan.md). For GitHub issues: run again with --tasks issues, or "
        "`factory settings set tasks.source issues`, then `factory issues setup` for the labels.")


def source(d):
    return (json.load(open(os.path.join(d, ".claude/factory.json"))).get("tasks") or {}).get("source", "plan")


def test_without_the_flag_the_install_says_where_tasks_come_from_and_how_to_change_it():
    gh, d, env = stack_world({"package.json": "{}\n"})
    rc, out = fac(d, env, "update", "v1.0.0")
    assert rc == 0, out
    assert LINE in out, out
    assert source(d) == "plan"


def test_tasks_issues_writes_the_setting_and_names_the_next_step_without_running_it():
    gh, d, env = stack_world({"package.json": "{}\n"})
    rc, out = fac(d, env, "update", "v1.0.0", "--tasks", "issues")
    assert rc == 0, out
    assert source(d) == "issues"
    assert "Tasks: from GitHub issues" in out and "`factory issues setup`" in out and LINE not in out, out
    assert "does not run it" in out or "not run" in out, out
    assert gh.hits and all("/releases" in h or h.startswith("/dl/") for h in gh.hits), "only release downloads, nothing written to GitHub"


def test_tasks_issues_also_works_in_a_python_project():
    gh, d, env = stack_world({"tests/test_a.py": UNITTEST_TESTS})
    rc, out = fac(d, env, "update", "v1.0.0", "--tasks", "issues")
    assert rc == 0, out
    cfg = json.load(open(os.path.join(d, ".claude/factory.json")))
    assert cfg["tasks"]["source"] == "issues" and cfg["commands"]["test"] == "python3 -m unittest discover", cfg


def test_tasks_plan_is_written_explicitly():
    gh, d, env = stack_world({"package.json": "{}\n"})
    rc, out = fac(d, env, "update", "v1.0.0", "--tasks", "plan")
    assert rc == 0, out
    assert json.load(open(os.path.join(d, ".claude/factory.json")))["tasks"]["source"] == "plan"
    assert "Tasks: from the build plan" in out, out


def test_a_wrong_value_is_code_message_fix_and_changes_nothing():
    gh, d, env = stack_world({"package.json": "{}\n"})
    before = snapshot(d)
    rc, out = fac(d, env, "update", "v1.0.0", "--tasks", "jira")
    assert rc == 1 and "[bad_tasks]" in out and "Fix:" in out and "plan" in out and "issues" in out, out
    assert snapshot(d) == before and gh.hits == []


def test_a_later_update_keeps_the_choice_and_prints_no_tasks_line():
    gh, d, env = stack_world({"package.json": "{}\n"})
    assert fac(d, env, "update", "v1.0.0", "--tasks", "issues")[0] == 0
    commit(d, "install")
    gh.add("1.1.0")
    rc, out = fac(d, env, "update")
    assert rc == 0, out
    assert source(d) == "issues" and "Tasks:" not in out, out


def test_help_and_readme_mention_the_flag():
    sf = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
    helped = subprocess.run(["bash", os.path.join(sf, "factory"), "help"], capture_output=True, text=True).stdout
    assert "--tasks" in helped, helped
    row = next(l for l in open(os.path.join(sf, "README.md")).read().splitlines() if l.startswith("| `factory update [version]`"))
    assert "--tasks" in row, row


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
