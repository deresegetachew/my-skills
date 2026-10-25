#!/usr/bin/env python3
"""`factory next` says it does not claim and shows the claim command (#155).  python3 software-factory/tests/test_next_output.py"""
import os, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_issues import HOOKS, SF, issue, setup  # noqa: E402

CLAIM = "python3 .claude/hooks/next_task.py --claim taytu --pid $$"


def project(issues):
    d, db, env = setup(issues)
    subprocess.run(["git", "init", "-q", d], check=True)
    os.symlink(HOOKS, os.path.join(d, ".claude", "hooks"))
    env = {**env, "FACTORY_AGENT": "taytu"}
    return d, env


def factory(d, env, *args):
    p = subprocess.run(["bash", os.path.join(SF, "factory"), *args], cwd=d, env=env, capture_output=True, text=True)
    return p.returncode, p.stdout.strip().splitlines()


def test_factory_next_ends_with_a_line_saying_nothing_was_claimed():
    d, env = project([issue(7)])
    rc, lines = factory(d, env, "next")
    assert rc == 0 and lines[0] == "issue-7 Task 7", lines
    assert len(lines) == 2 and lines[-1].startswith("Not claimed."), lines
    assert CLAIM in lines[-1], lines


def test_factory_next_with_nothing_ready_prints_only_none():
    d, env = project([])
    rc, lines = factory(d, env, "next")
    assert (rc, lines) == (1, ["none"]), (rc, lines)


def test_the_script_itself_stays_one_line_for_other_programs():
    d, env = project([issue(7)])
    p = subprocess.run([sys.executable, os.path.join(HOOKS, "next_task.py")], cwd=d, env=env, capture_output=True, text=True)
    assert p.stdout.strip() == "issue-7 Task 7", p.stdout


def test_help_says_next_does_not_claim():
    d, env = project([])
    rc, lines = factory(d, env, "help")
    text = "\n".join(lines)
    assert "does not claim" in text and "next_task.py --claim" in text, text


def test_readme_says_next_does_not_claim():
    readme = open(os.path.join(SF, "README.md")).read()
    row = next(l for l in readme.splitlines() if l.startswith("| `factory next`"))
    assert "does not claim" in row and "--claim" in row, row


if __name__ == "__main__":
    for t in [v for k, v in sorted(globals().items()) if k.startswith("test_")]:
        t()
        print("ok", t.__name__)
