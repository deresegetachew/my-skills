#!/usr/bin/env python3
"""Factory sessions load only the project's MCP servers, never the user's own connectors (#55): every `claude` that
factory-loop.sh (headless and -i) and `factory agent` start gets --strict-mcp-config, --mcp-config with the
.mcp.json main has on origin (or an empty config), never the worktree's copy, and settings that turn the claude.ai
connectors off. Runs the real scripts with stub
hooks and a stub `claude` that records its arguments.
  python3 software-factory/tests/test_mcp_isolation.py"""
import json, os, pty, select, shutil, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
KIT = os.path.abspath(os.path.join(HERE, "..", "kit"))
HOOKS = os.path.join(KIT, ".claude", "hooks")
EMPTY = '{"mcpServers":{}}'
NO_CONNECTORS = '{"disableClaudeAiConnectors": true}'

# next_task hands out one task, then nothing (waitMinutes 0 makes the loop exit).
STUB = r'''#!/usr/bin/env python3
import os, sys
name = os.path.basename(__file__)
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
CLAUDE = '#!/usr/bin/env python3\nimport json, os, sys\nopen(os.environ["CLAUDE_LOG"], "a").write(json.dumps(sys.argv[1:]) + "\\n")\n'


def sh(*a, cwd=None):
    subprocess.run(a, cwd=cwd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def fake_claude(d):
    bin_ = os.path.join(d, "bin")
    os.makedirs(bin_)
    open(os.path.join(bin_, "claude"), "w").write(CLAUDE)
    os.chmod(os.path.join(bin_, "claude"), 0o755)
    env = {**os.environ, "PATH": f"{bin_}:{os.environ['PATH']}", "CLAUDE_LOG": os.path.join(d, "claude.log"),
           "LOOP_STATE": os.path.join(d, "state"), "FACTORY_REMOTE_CONTROL": "0"}
    for k in ("FACTORY_AGENT", "FACTORY_AGENTS", "FACTORY_RELOAD_AGENT", "FACTORY_RELOAD_DIR", "FACTORY_LOOP",
              "CLAUDE_PROJECT_DIR"):
        env.pop(k, None)
    return env


def loop_project(mcp=None, worktree_mcp=None):
    d = tempfile.mkdtemp()
    origin, work = os.path.join(d, "origin.git"), os.path.join(d, "work")
    sh("git", "init", "-q", "--bare", "-b", "main", origin)
    sh("git", "clone", "-q", origin, work)
    hooks = os.path.join(work, ".claude", "hooks")
    os.makedirs(hooks)
    for name in ("factory_claims.py", "factory_env.py", "factory_agents.py", "factory_remote.py", "next_task.py"):
        open(os.path.join(hooks, name), "w").write(STUB)
    shutil.copy(os.path.join(HOOKS, "factory_mcp.py"), os.path.join(hooks, "factory_mcp.py"))
    open(os.path.join(work, ".claude", "factory.json"), "w").write('{"waitMinutes": 0}')
    if mcp is not None:
        json.dump(mcp, open(os.path.join(work, ".mcp.json"), "w"))
    shutil.copy(os.path.join(KIT, "factory-loop.sh"), os.path.join(work, "factory-loop.sh"))
    sh("git", "add", "-A", cwd=work)
    sh("git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "start", cwd=work)
    sh("git", "push", "-q", "origin", "HEAD:main", cwd=work)
    if worktree_mcp is not None:  # only in this worktree: untracked, or an uncommitted edit
        json.dump(worktree_mcp, open(os.path.join(work, ".mcp.json"), "w"))
    return work, fake_claude(d)


def calls(env):
    return [json.loads(l) for l in open(env["CLAUDE_LOG"]).read().splitlines()]


def flag(args, name):
    assert name in args, args
    return args[args.index(name) + 1]


MAIN_COPY = os.path.join(".git", "factory-mcp.json")


def main_copy(work):
    return os.path.join(os.path.realpath(work), MAIN_COPY)


def assert_isolated(args, mcp_config):
    assert "--strict-mcp-config" in args, args
    assert flag(args, "--mcp-config") == mcp_config, args
    assert json.loads(flag(args, "--settings")) == json.loads(NO_CONNECTORS), args


def run_on_a_terminal(work, env, timeout):
    """factory-loop.sh -i reads /dev/tty, so it runs on a pseudo-terminal. Returns its output."""
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(work)
        os.execvpe("bash", ["bash", "./factory-loop.sh", "-i", "1"], env)
    out, end = b"", time.time() + timeout
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.5)
        if r:
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                chunk = b""
            if not chunk:
                os.waitpid(pid, 0)
                return out.decode(errors="replace")
            if b"type q and Enter to stop" in out + chunk:
                os.write(fd, b"q\n")
            out += chunk
        done, _ = os.waitpid(pid, os.WNOHANG)
        if done:
            return out.decode(errors="replace")
    os.kill(pid, 9)
    os.waitpid(pid, 0)
    return out.decode(errors="replace")


def test_a_headless_loop_run_gets_an_empty_mcp_config_without_a_project_file():
    work, env = loop_project()
    p = subprocess.run(["bash", "./factory-loop.sh", "1"], cwd=work, env=env, capture_output=True, text=True,
                       timeout=60)
    assert p.returncode == 0, p
    (args,) = calls(env)
    assert_isolated(args, EMPTY)
    assert args[-2:] == ["-p", "/next-task 1.1"], args


def headless(work, env):
    p = subprocess.run(["bash", "./factory-loop.sh", "1"], cwd=work, env=env, capture_output=True, text=True,
                       timeout=60)
    assert p.returncode == 0, p
    (args,) = calls(env)
    return args


DOCS = {"mcpServers": {"docs": {"command": "docs-server"}}}
EVIL = {"mcpServers": {"github": {"command": "github-mcp-server"}}}


def test_a_headless_loop_run_uses_the_mcp_json_main_has():
    work, env = loop_project(mcp=DOCS)
    args = headless(work, env)
    assert_isolated(args, main_copy(work))
    assert json.load(open(main_copy(work))) == DOCS


def test_a_worktree_only_mcp_json_is_never_passed_to_claude():
    work, env = loop_project(worktree_mcp=EVIL)  # untracked, main has none
    assert_isolated(headless(work, env), EMPTY)
    work, env = loop_project(mcp=DOCS, worktree_mcp=EVIL)  # an uncommitted edit: main's copy wins
    args = headless(work, env)
    assert_isolated(args, main_copy(work))
    assert json.load(open(main_copy(work))) == DOCS and "github-mcp-server" not in json.dumps(args)


def test_the_worktree_cannot_steer_which_branch_the_config_comes_from():
    # An agent pushes a branch with its own .mcp.json, then points the worktree at it: an uncommitted `mainBranch`
    # in .claude/factory.json, and a planted local origin/main ref. main's copy must still win.
    work, env = loop_project(mcp=DOCS)
    sh("git", "checkout", "-q", "-b", "task/x", cwd=work)
    json.dump(EVIL, open(os.path.join(work, ".mcp.json"), "w"))
    sh("git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "evil", cwd=work)
    sh("git", "push", "-q", "origin", "task/x", cwd=work)
    sh("git", "update-ref", "refs/remotes/origin/main", "HEAD", cwd=work)
    open(os.path.join(work, ".claude", "factory.json"), "w").write('{"waitMinutes": 0, "mainBranch": "task/x"}')
    args = headless(work, env)
    assert_isolated(args, main_copy(work))
    assert json.load(open(main_copy(work))) == DOCS and "github-mcp-server" not in json.dumps(args)


def test_an_interactive_loop_session_is_isolated_too():
    work, env = loop_project()
    out = run_on_a_terminal(work, env, timeout=45)
    got = calls(env)
    assert len(got) == 1, (got, out)
    assert_isolated(got[0], EMPTY)
    assert got[0][-1] == "/next-task 1.1", got


def test_factory_agent_starts_claude_isolated_and_passes_its_own_arguments_on():
    d = tempfile.mkdtemp()
    work = os.path.join(d, "proj")
    sh("git", "init", "-q", "-b", "main", work)
    os.makedirs(os.path.join(work, ".claude", "hooks"))
    for f in os.listdir(HOOKS):
        if f.endswith(".py"):
            os.symlink(os.path.join(HOOKS, f), os.path.join(work, ".claude", "hooks", f))
    json.dump({"hooks": {}}, open(os.path.join(work, ".claude", "settings.json"), "w"))
    json.dump({"agents": ["menelik", "taytu"]}, open(os.path.join(work, ".claude", "factory.json"), "w"))
    json.dump(DOCS, open(os.path.join(work, ".mcp.json"), "w"))
    sh("git", "add", "-A", cwd=work)
    sh("git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "start", cwd=work)
    origin = os.path.join(d, "origin.git")
    sh("git", "init", "-q", "--bare", "-b", "main", origin)
    sh("git", "remote", "add", "origin", origin, cwd=work)
    sh("git", "push", "-q", "origin", "HEAD:main", cwd=work)
    json.dump(EVIL, open(os.path.join(work, ".mcp.json"), "w"))  # the agent's edit, not on main
    env = fake_claude(d)
    p = subprocess.run(["bash", os.path.join(KIT, "factory"), "agent", "menelik", "--resume"], cwd=work, env=env,
                       capture_output=True, text=True, timeout=60)
    assert p.returncode == 0, p
    (args,) = calls(env)
    assert_isolated(args, main_copy(work))
    assert json.load(open(main_copy(work))) == DOCS
    assert args[-1] == "--resume", args


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
