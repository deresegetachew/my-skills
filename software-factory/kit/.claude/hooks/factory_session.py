#!/usr/bin/env python3
"""SessionStart hook: makes a plain `claude` session in a project folder or worktree a factory agent.

What factory-loop.sh does for its runs, this does for a session you start yourself, for example
`cd "$(python3 .claude/hooks/factory_claims.py worktree 2)" && claude`, then `/loop /next-task all`:

  1. Slot and name: slot 1 is the project folder, slot N `<project>-agents/<name>`; the names are `agents` in
     factory.json (menelik, taytu, ...).
  2. Checkout claim: records this session in the lock file, so factory-loop.sh won't use the same folder, and warns
     when another live session already works here.
  3. Submodules (`git submodule update --init`), then `commands.install` (worktrees), then `commands.agentSetup`.
  4. Issues mode: registers the agent on GitHub (factory_agents.py), so the dev manager sees it's alive.
  5. Environment: writes `agentEnv` (own ports and database), FACTORY_AGENT and FACTORY_PID to CLAUDE_ENV_FILE, so
     every command in the session uses them and `/next-task` claims its tasks as this agent.

Under factory-loop.sh (FACTORY_AGENT already set) it only updates the submodules: the loop did the rest.
"""
import json, os, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from factory_config import load  # noqa: E402


def sh(cmd, **kw):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, **kw)


def is_claude(args):
    """Whether a process's command line is Claude Code: the `claude` program, or node running Claude Code's script.
    Only the program and node's script count, so a folder named claude (/home/claude/...) in an argument doesn't."""
    words = args.split()
    if not words:
        return False
    prog = os.path.basename(words[0])
    if prog == "claude":
        return True
    return prog in ("node", "nodejs", "bun") and len(words) > 1 and (
        "claude-code" in words[1] or os.path.basename(words[1]) == "claude")


def claude_pid(strict=False):
    """The pid of the Claude process that started this hook (claims last as long as it runs). When none is found:
    the parent process, or None with `strict` (the stop hook, which must never signal some other process)."""
    pid = os.getppid()
    for _ in range(8):
        out = subprocess.run(["ps", "-o", "ppid=,args=", "-p", str(int(pid))], capture_output=True,
                             text=True).stdout.strip()
        if not out:
            break
        ppid, _, args = out.partition(" ")
        if is_claude(args.strip()):
            return pid
        if not ppid.strip().isdigit() or int(ppid) <= 1:
            break
        pid = int(ppid)
    return None if strict else os.getppid()


def main():
    try:
        json.load(sys.stdin)
    except ValueError:
        pass
    root = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    os.chdir(root)
    if not os.path.exists(os.path.join(".claude", "factory.json")):
        return
    if os.path.exists(".gitmodules"):
        sh("git submodule update --init -q")
    if os.environ.get("FACTORY_AGENT"):
        return  # factory-loop.sh set everything up

    from factory_claims import register
    from factory_env import agent_env, slot_of
    cfg = load()
    slot = slot_of(None, root)
    from factory_config import agent_name
    agent = agent_name(cfg, slot)
    pid = claude_pid()
    notes = []
    other = register(agent, pid, root, float(cfg.get("claimStaleHours", 6)))
    if other:
        notes.append(f"Another live session (pid {other.get('pid')}) already works in this folder as {agent}. Two "
                     "sessions in one folder share files and claims: use another worktree, "
                     "`cd \"$(python3 .claude/hooks/factory_claims.py worktree <N>)\"`.")

    env = agent_env(cfg, slot)
    env.update({"FACTORY_AGENT": agent, "FACTORY_PID": str(pid)})
    child = {**os.environ, **env}
    cmds = cfg.get("commands", {})
    # Each session start (worktrees only): main may have new dependencies since the worktree was last used.
    if cmds.get("install") and slot != 1:
        if sh(cmds["install"], env=child).returncode != 0:
            notes.append(f"`{cmds['install']}` failed in this worktree; run it before testing.")
    if cmds.get("agentSetup"):
        if sh(cmds["agentSetup"], env=child).returncode != 0:
            notes.append(f"`{cmds['agentSetup']}` failed (is the local stack running?); tests that need it will fail.")

    env_file = os.environ.get("CLAUDE_ENV_FILE")
    if env_file:
        import shlex
        with open(env_file, "a") as f:
            for k, v in env.items():
                f.write(f"export {k}={shlex.quote(v)}\n")
    else:
        notes.append("This Claude version gave the hook no CLAUDE_ENV_FILE, so the slot's variables aren't set: "
                     "run `eval \"$(python3 .claude/hooks/factory_env.py)\"` in each command, or use factory-loop.sh.")

    try:  # issues mode: the agent's own issue on GitHub says it's alive (factory_agents.py)
        subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "factory_agents.py"),
                        "register", "--agent", agent], env=child, timeout=30, capture_output=True, text=True)
    except subprocess.TimeoutExpired:
        pass
    shown = ", ".join(f"{k}={v}" for k, v in env.items() if k not in ("FACTORY_PID",))
    print(f"Factory slot {slot}: this session is {agent} ({shown}). /next-task claims its tasks as {agent}.")
    for n in notes:
        print(n)


if __name__ == "__main__":
    main()
