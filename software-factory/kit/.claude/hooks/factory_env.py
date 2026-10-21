#!/usr/bin/env python3
"""Per-loop environment, so several loops on one machine don't share ports, databases or queues.

Each loop has a slot: 1 for the project folder, N for the worktree `<project>-agents/<name>` of the Nth name in
`agents` (menelik, taytu, ...). `agentEnv` in .claude/factory.json maps variable names to templates:

  {slot}        the slot number: 1, 2, 3 ...
  {suffix}      "" in slot 1, "_N" in slot N (a database name: remanual, remanual_2 ...)
  {port:4101}   4101 in slot 1, 4101 + portStep * (N - 1) in slot N (portStep defaults to 10)

Slot 1 gets the project's defaults, so the main folder works exactly as before.

  eval "$(python3 .claude/hooks/factory_env.py)"            in a worktree: the slot comes from the folder name
  eval "$(python3 .claude/hooks/factory_env.py --agent taytu)"
  python3 .claude/hooks/factory_env.py --dotenv              KEY=value lines instead of exports

factory-loop.sh does the eval for you and then runs `commands.agentSetup` (for example, create the slot's
database) before the first task.
"""
import argparse, os, re, shlex, sys

sys.path.insert(0, os.path.dirname(__file__))
from factory_config import load  # noqa: E402


def slot_of(agent=None, path=None):
    """The slot of an agent name (or the old agent-N), else of the folder (<project>-agents/<name>), else 1."""
    from factory_config import agent_slot
    cfg = load()
    name = agent or os.environ.get("FACTORY_AGENT") or ""
    slot = agent_slot(cfg, name)
    if slot:
        return slot
    m = re.search(r"-agents[/\\]([^/\\]+)$", os.path.abspath(path or "."))
    return (agent_slot(cfg, m.group(1)) or 1) if m else 1


def render(template, slot, step):
    def sub(m):
        key, _, arg = m.group(1).partition(":")
        if key == "slot":
            return str(slot)
        if key == "suffix":
            return "" if slot == 1 else f"_{slot}"
        if key == "port":
            return str(int(arg) + step * (slot - 1))
        raise SystemExit(f"agentEnv: unknown placeholder {{{m.group(1)}}} in {template!r}")
    return re.sub(r"\{([a-z]+(?::\d+)?)\}", sub, template)


def agent_env(cfg, slot):
    step = int(cfg.get("portStep", 10))
    env = {"FACTORY_SLOT": str(slot)}
    for key, template in cfg.get("agentEnv", {}).items():
        if not key.startswith("_"):
            env[key] = render(str(template), slot, step)
    return env


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--agent")
    ap.add_argument("--dotenv", action="store_true")
    a = ap.parse_args()
    here = os.getcwd()
    cfg = load()
    env = agent_env(cfg, slot_of(a.agent, here))
    for k, v in env.items():
        print(f"{k}={v}" if a.dotenv else f"export {k}={shlex.quote(v)}")
