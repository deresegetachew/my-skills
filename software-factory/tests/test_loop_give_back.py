#!/usr/bin/env python3
"""factory-loop.sh (#192): the loop says which issue it claimed, and when its run ends it gives back the claims that have
no branch or pull request, and prints what it released. Runs the real loop (headless) with stub hooks and a `claude`
that exits early.  python3 software-factory/tests/test_loop_give_back.py"""
import os, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_loop_countdown import STUB, setup  # noqa: E402

NEXT = STUB.replace('print("1.1 First task")', 'print("issue-5 Build the thing")')
GIVE_BACK = STUB + '''
if name == "factory_issues.py" and sys.argv[1:2] == ["give-back"]:
    print("released #5: the run ended with no branch or pull request, so it is ready again.")
'''


def run_loop(exit_code):
    work, env = setup()
    hooks = os.path.join(work, ".claude", "hooks")
    open(os.path.join(hooks, "next_task.py"), "w").write(NEXT)
    for name in ("factory_issues.py", "factory_roles.py"):
        open(os.path.join(hooks, name), "w").write(GIVE_BACK)
    claude = os.path.join(os.path.dirname(env["LOOP_LOG"]), "bin", "claude")
    open(claude, "w").write(f'#!/usr/bin/env bash\necho "claude $*" >> "$LOOP_LOG"\nexit {exit_code}\n')
    subprocess.run(["git", "add", "-A"], cwd=work, check=True)
    subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "stubs"], cwd=work, check=True)
    subprocess.run(["git", "push", "-q", "origin", "HEAD:main"], cwd=work, check=True)
    p = subprocess.run(["bash", "./factory-loop.sh", "1"], cwd=work, env=env, capture_output=True, text=True, timeout=60)
    return p, open(env["LOOP_LOG"]).read()


def test_a_failed_run_gives_its_claim_back_and_says_so():
    p, log = run_loop(1)
    out = p.stdout + p.stderr
    assert "claimed issue #5" in out, out
    assert "give-back --agent solo" in log, log
    assert "released #5" in out, out


def test_a_run_that_ends_cleanly_also_gives_back_what_has_no_branch():
    p, log = run_loop(0)
    assert "give-back --agent solo" in log and "released #5" in p.stdout + p.stderr, (p.stdout, p.stderr, log)


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
