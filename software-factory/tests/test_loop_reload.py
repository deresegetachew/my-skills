#!/usr/bin/env python3
"""factory-loop.sh restarts itself when main brings a newer factory-loop.sh, keeping its pid, agent and folder.
Runs the real loop script in a throwaway repo with stub hooks and a stub `claude`.
  python3 software-factory/tests/test_loop_reload.py"""
import os, shutil, subprocess, sys, tempfile, textwrap

KIT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "kit"))

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
    sys.exit(1)  # nothing more to do
'''

# The stub `claude` does the task by pushing a new factory-loop.sh to main, as a factory update would.
CLAUDE = r'''#!/usr/bin/env bash
set -e
echo "claude $*" >> "$LOOP_LOG"
d=$(mktemp -d); git clone -q "$LOOP_ORIGIN" "$d/c"; cd "$d/c"
python3 - <<'EOF'
p = "factory-loop.sh"; s = open(p).read()
s = s.replace("set -uo pipefail\n", 'set -uo pipefail\necho "RELOADED pid=$$ args=$*" >> "$LOOP_LOG"\n', 1)
open(p, "w").write(s)
EOF
git -c user.email=t@t -c user.name=t commit -qam "new loop" && git push -q origin HEAD:main
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
    shutil.copy(os.path.join(KIT, "factory-loop.sh"), os.path.join(work, "factory-loop.sh"))
    sh("git", "add", "-A", cwd=work)
    sh("git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "start", cwd=work)
    sh("git", "push", "-q", "origin", "HEAD:main", cwd=work)
    os.makedirs(bin_)
    open(os.path.join(bin_, "claude"), "w").write(CLAUDE)
    os.chmod(os.path.join(bin_, "claude"), 0o755)
    env = {**os.environ, "PATH": f"{bin_}:{os.environ['PATH']}", "LOOP_LOG": os.path.join(d, "log"),
           "LOOP_STATE": os.path.join(d, "state"), "LOOP_ORIGIN": origin}
    for k in ("FACTORY_AGENT", "FACTORY_RELOAD_AGENT", "FACTORY_RELOAD_DIR"):
        env.pop(k, None)
    return d, work, env


def test_loop_restarts_itself_with_the_new_script_on_main():
    d, work, env = setup()
    p = subprocess.Popen(["bash", "./factory-loop.sh", "3"], cwd=work, env=env,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    out, _ = p.communicate(timeout=60)
    log = open(env["LOOP_LOG"]).read().splitlines()
    assert p.returncode == 0, out
    assert "the factory loop changed on main: restarting with the new version" in out, out
    assert f"RELOADED pid={p.pid} args=2" in log, log  # same process; 3 tasks allowed, 1 done
    assert sum(l.startswith("factory_claims.py checkout") for l in log) == 1, log  # kept its agent and folder
    assert sum(l.startswith("claude ") for l in log) == 1, log  # the task ran once
    assert sum(l.startswith("factory_agents.py down") for l in log) == 1, log  # down only at the real exit


def test_loop_without_changes_does_not_restart():
    d, work, env = setup()
    open(os.path.join(d, "bin", "claude"), "w").write('#!/usr/bin/env bash\necho "claude $*" >> "$LOOP_LOG"\n')
    out = subprocess.run(["bash", "./factory-loop.sh", "3"], cwd=work, env=env, capture_output=True,
                         text=True, timeout=60).stdout
    assert "restarting" not in out, out
    assert not any(l.startswith("RELOADED") for l in open(env["LOOP_LOG"]).read().splitlines())


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
