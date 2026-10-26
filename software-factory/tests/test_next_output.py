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


def agent_issue(n, name, status, ping="2020-01-01T00:00:00Z"):
    body = f"<!-- factory-agent name={name} status={status} ping={ping} -->\n**Started:** x\n**Where:** y"
    return issue(n, labels=("factory:agent",), body=body)


def test_factory_next_says_which_issue_a_down_agent_still_holds_and_how_to_free_it():
    # #191: the agent is down, its claim stays, and `next` skipped the issue without a word.
    d, env = project([issue(3, labels=("factory:in-progress", "agent:menelik")), issue(7),
                      agent_issue(9, "menelik", "down")])
    p = subprocess.run(["bash", os.path.join(SF, "factory"), "next"], cwd=d, env=env, capture_output=True, text=True)
    assert p.returncode == 0 and p.stdout.splitlines()[0] == "issue-7 Task 7", p
    assert "#3" in p.stderr and "menelik" in p.stderr and "down" in p.stderr, p.stderr
    assert "factory issues release 3" in p.stderr, p.stderr


def test_a_live_agents_claim_is_not_called_stale():
    d, env = project([issue(3, labels=("factory:in-progress", "agent:menelik")), issue(7),
                      agent_issue(9, "menelik", "working", ping="2999-01-01T00:00:00Z")])
    p = subprocess.run(["bash", os.path.join(SF, "factory"), "next"], cwd=d, env=env, capture_output=True, text=True)
    assert p.returncode == 0 and "release" not in p.stderr, p.stderr


def test_the_dry_run_says_it_too():
    d, env = project([issue(3, labels=("factory:in-progress", "agent:menelik")), issue(7),
                      agent_issue(9, "menelik", "down")])
    p = subprocess.run(["bash", os.path.join(SF, "factory-loop.sh"), "--once", "--dry-run"],
                       cwd=d, env={**env, "FACTORY_ROLE": "coding-agent", "FACTORY_NAME": "taytu"}, capture_output=True, text=True)
    out = p.stdout + p.stderr
    assert "factory issues release 3" in out and "issue-7" in out, out


if __name__ == "__main__":
    for t in [v for k, v in sorted(globals().items()) if k.startswith("test_")]:
        t()
        print("ok", t.__name__)
