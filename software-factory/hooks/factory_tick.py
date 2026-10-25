#!/usr/bin/env python3
"""One dev manager tick that costs nothing when there is nothing to do (#71).

  factory manage-tick [--dry-run] [--print-command]

Runs the precheck (factory_wait.py precheck, which reads GitHub only). When it finds nothing, it prints
`nothing to do` and exits 0: no model call, no tokens. Only when it lists work does it start ONE Claude session,
`claude -p "/manage-pass"`, on the manager settings profile with the `models.manager` flags, and the session ends
when the pass ends. Run it from cron, launchd, a systemd timer or a loop script instead of keeping a session
alive to tick: the idle ticks are shell only.

  --dry-run   print the precheck and the command that would start, start nothing
A second tick that starts while a pass still runs on this checkout does nothing (a lock in .git).
Exit: 0 nothing to do, or the session's own exit code; 1 the tick can't run (the line says why and what to do).
"""
import fcntl, os, shlex, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import factory_models as fmodels  # noqa: E402
import factory_wait as fw  # noqa: E402
from factory_config import load  # noqa: E402

PROFILE = os.path.join(".claude", "manager", "settings.json")
PROMPT = "/manage-pass"


def mcp_flags():
    """Only the project's MCP servers, from main on the remote (factory_mcp.py); none when it can't say."""
    here = os.path.dirname(os.path.abspath(__file__))
    p = subprocess.run([sys.executable, os.path.join(here, "factory_mcp.py")], capture_output=True, text=True, timeout=120)
    cfg = p.stdout.strip() or '{"mcpServers":{}}'
    return ["--mcp-config", cfg, "--strict-mcp-config"]


def command(models):
    return ["claude", "--setting-sources", "user", "--settings", PROFILE, *mcp_flags(),
            *fmodels.flags("manager", models), "-p", PROMPT]


def tick(args):
    todo = fw.precheck(load())
    if not todo:
        print("nothing to do")
        return 0
    print("\n".join(todo))
    if not os.path.isfile(PROFILE):
        print(f"factory manage-tick: {PROFILE} is missing, so the manager cannot start safely. "
              "Fix: run `factory update` (it links the manager profile), then try again.", file=sys.stderr)
        return 1
    try:
        cmd = command(fmodels.configured())
    except ValueError as e:
        print(f"factory manage-tick: {e}", file=sys.stderr)
        return 1
    if "--dry-run" in args:
        print("would run: " + " ".join(shlex.quote(c) for c in cmd))
        return 0
    lock = open(os.path.abspath(subprocess.run(["git", "rev-parse", "--git-path", "factory-manage-tick.lock"],
                                               capture_output=True, text=True).stdout.strip() or ".factory-manage-tick.lock"), "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print("a manager pass is already running here; this tick starts nothing")
        return 0
    return subprocess.call(cmd)


if __name__ == "__main__":
    sys.exit(tick(sys.argv[1:]))
