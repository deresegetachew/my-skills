#!/usr/bin/env python3
"""`--once` is one pass in every case, and a worktree without the factory is refused plainly (#189): no Python
tracebacks, no polling, an error with {code, message, fix}, and no wrong slot number.
  python3 software-factory/tests/test_loop_once.py"""
import json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import test_mcp_isolation as iso  # noqa: E402

NOTHING = '#!/usr/bin/env python3\nimport sys\nsys.exit(1)\n'
CLAIMS = r'''#!/usr/bin/env python3
import os, sys
if sys.argv[1:2] == ["checkout"]:
    print("taytu", os.environ["AGENT_DIR"])
'''


def git(*a, cwd):
    subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", *a], cwd=cwd, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def project(wait_minutes=5):
    work, env = iso.loop_project()
    hooks = os.path.join(work, ".claude", "hooks")
    open(os.path.join(hooks, "next_task.py"), "w").write(NOTHING)
    open(os.path.join(hooks, "factory_claims.py"), "w").write(CLAIMS)
    json.dump({"waitMinutes": wait_minutes, "agents": ["menelik", "taytu"]},
              open(os.path.join(work, ".claude", "factory.json"), "w"))
    git("commit", "-qam", "config", cwd=work)
    git("push", "-q", "origin", "HEAD:main", cwd=work)
    return work, env


def run_once(work, env, *args):
    return subprocess.run(["bash", "./factory-loop.sh", "--once", *args], cwd=work, env=env, capture_output=True,
                          text=True, timeout=60)


def test_once_with_nothing_ready_exits_after_one_look_and_does_not_poll():
    work, env = project()
    p = run_once(work, {**env, "AGENT_DIR": work})
    assert p.returncode == 0, p
    assert "Checking again" not in p.stdout + p.stderr and "nothing ready" in (p.stdout + p.stderr).lower(), p


def test_a_worktree_without_the_factory_is_refused_with_a_fix_and_no_traceback():
    work, env = project()
    git("rm", "-rq", ".claude", cwd=work)
    git("commit", "-qm", "no factory here", cwd=work)
    git("push", "-q", "origin", "HEAD:main", cwd=work)
    git("reset", "-q", "--hard", "HEAD~1", cwd=work)
    wt = os.path.join(tempfile.mkdtemp(), "agent")
    git("worktree", "add", "-q", "--detach", wt, "HEAD", cwd=work)
    p = run_once(work, {**env, "AGENT_DIR": wt})
    out = p.stdout + p.stderr
    assert p.returncode == 1, p
    assert "Traceback" not in out and "Checking again" not in out and "(slot 1)" not in out, out
    err = json.loads(next(l for l in out.splitlines() if l.startswith("{")))
    assert err["code"] == "no-factory" and ".claude/factory.json" in err["message"] and err["fix"], err


def test_the_slot_shown_is_the_agents_own():
    work, env = project()
    env = {**env, "AGENT_DIR": work}
    open(os.path.join(work, ".claude", "hooks", "factory_env.py"), "w").write(
        '#!/usr/bin/env python3\nprint("export FACTORY_SLOT=2")\n')
    p = run_once(work, env)
    assert "(slot 2)" in p.stdout, p


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_") and callable(v):
            v()
            print("ok", k)
