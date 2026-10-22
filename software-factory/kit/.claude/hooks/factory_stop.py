#!/usr/bin/env python3
"""Stop hook for `factory loop -i`: when the agent has marked its task done, close the session.

The next-task skill runs `factory_claims.py done --agent $FACTORY_AGENT --task <id>` once its PR is open. When the
turn ends, this hook sees the mark and ends the Claude process a few seconds later (so the last message stays on
screen). The loop then counts down and starts the next task in a fresh session. Without the mark, or outside an
interactive loop, it does nothing.
"""
import json, os, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    json.load(sys.stdin)
except ValueError:
    pass
agent = os.environ.get("FACTORY_AGENT")
if os.environ.get("FACTORY_INTERACTIVE") != "1" or not agent:
    sys.exit(0)
os.chdir(os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd())
from factory_claims import done_file  # noqa: E402
from factory_session import claude_pid  # noqa: E402

mark = done_file(agent)
if not os.path.exists(mark) or os.path.exists(mark + ".closing"):
    sys.exit(0)
pid = claude_pid(strict=True)
if pid is None:
    sys.exit(0)  # not sure which process is Claude: never signal a guess; the session stays open for /exit
open(mark + ".closing", "w").close()
# Detached, so the hook returns at once and Claude can draw its last message before it's asked to quit. The
# values go to sh as arguments ($1, $2), never into the script text.
subprocess.Popen(["sh", "-c", 'sleep 3; kill -TERM "$1" 2>/dev/null; rm -f -- "$2"', "factory-stop", str(int(pid)),
                  mark + ".closing"],
                 start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
sys.exit(0)
