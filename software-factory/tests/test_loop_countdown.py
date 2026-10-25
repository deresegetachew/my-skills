#!/usr/bin/env python3
"""factory-loop.sh -i: when a task's session closes before the task is done, the loop carries on after a 10 s
countdown instead of waiting for a key. Runs the real loop on a pseudo-terminal with stub hooks and a stub `claude`.
  python3 software-factory/tests/test_loop_countdown.py"""
import os, pty, select, shutil, subprocess, tempfile, time

KIT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "kit"))
SF = os.path.dirname(os.path.abspath(KIT))

# next_task hands out one task, then nothing (waitMinutes 0 makes the loop exit). take-done prints nothing, so the
# loop sees a session that ended before its task was done.
STUB = r'''#!/usr/bin/env python3
import os, sys
name = os.path.basename(__file__)
open(os.environ["LOOP_LOG"], "a").write(f"{name} {' '.join(sys.argv[1:])}\n")
if name == "factory_claims.py" and sys.argv[1:2] == ["checkout"]:
    print("solo", os.getcwd())
if name == "next_task.py":
    state = os.environ["LOOP_STATE"]
    n = int(open(state).read()) if os.path.exists(state) else 0
    open(state, "w").write(str(n + 1))
    if n == 0:
        print("1.1 First task")
        sys.exit(0)
    sys.exit(1)
'''


def sh(*a, cwd=None):
    subprocess.run(a, cwd=cwd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def setup():
    d = tempfile.mkdtemp()
    origin, work, bin_ = (os.path.join(d, x) for x in ("origin.git", "work", "bin"))
    sh("git", "init", "-q", "--bare", "-b", "main", origin)
    sh("git", "clone", "-q", origin, work)
    hooks = os.path.join(work, ".claude", "hooks")
    os.makedirs(hooks)
    for name in ("factory_claims.py", "factory_env.py", "factory_agents.py", "next_task.py"):
        open(os.path.join(hooks, name), "w").write(STUB)
    open(os.path.join(work, ".claude", "factory.json"), "w").write('{"waitMinutes": 0}')
    shutil.copy(os.path.join(SF, "factory-loop.sh"), os.path.join(work, "factory-loop.sh"))
    sh("git", "add", "-A", cwd=work)
    sh("git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "start", cwd=work)
    sh("git", "push", "-q", "origin", "HEAD:main", cwd=work)
    os.makedirs(bin_)
    open(os.path.join(bin_, "claude"), "w").write('#!/usr/bin/env bash\necho "claude $*" >> "$LOOP_LOG"\n')
    os.chmod(os.path.join(bin_, "claude"), 0o755)
    env = {**os.environ, "PATH": f"{bin_}:{os.environ['PATH']}", "LOOP_LOG": os.path.join(d, "log"),
           "LOOP_STATE": os.path.join(d, "state")}
    for k in ("FACTORY_AGENT", "FACTORY_RELOAD_AGENT", "FACTORY_RELOAD_DIR"):
        env.pop(k, None)
    return work, env


def run_on_a_terminal(work, env, timeout, keys=b""):
    """Runs the loop with a controlling terminal (so it can read /dev/tty). Returns (exit code or None, output)."""
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(work)
        os.execvpe("bash", ["bash", "./factory-loop.sh", "-i", "3"], env)
    out, end, sent = b"", time.time() + timeout, False
    while time.time() < end:
        if keys and not sent and b"type q and Enter to stop" in out:
            os.write(fd, keys)
            sent = True
        r, _, _ = select.select([fd], [], [], 0.5)
        if r:
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                chunk = b""
            if not chunk:  # the terminal closed: the loop has exited
                _, status = os.waitpid(pid, 0)
                return os.waitstatus_to_exitcode(status), out.decode(errors="replace")
            out += chunk
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            return os.waitstatus_to_exitcode(status), out.decode(errors="replace")
    try:
        os.kill(pid, 9)
        os.waitpid(pid, 0)
    except OSError:
        pass
    return None, out.decode(errors="replace")


def test_an_unfinished_session_carries_on_after_the_countdown():
    work, env = setup()
    start = time.time()
    code, out = run_on_a_terminal(work, env, timeout=45)
    assert code == 0, (code, out)  # it went on by itself, found nothing more to do and exited
    assert "session ended before it was done. Carrying on in 10 s" in out, out
    assert time.time() - start >= 9, "the countdown should give about 10 s to type q"
    assert sum(l.startswith("next_task.py") for l in open(env["LOOP_LOG"]).read().splitlines()) == 2


def test_q_still_stops_the_loop():
    work, env = setup()
    code, out = run_on_a_terminal(work, env, timeout=45, keys=b"q\n")
    assert code == 0 and "Stopped." in out, (code, out)
    assert sum(l.startswith("next_task.py") for l in open(env["LOOP_LOG"]).read().splitlines()) == 1


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
