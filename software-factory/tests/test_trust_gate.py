#!/usr/bin/env python3
"""A headless loop run in a folder Claude Code does not trust stops with a plain {code, message, fix} before claude
starts, instead of spending tokens on a run that ignores the allow list (#193). A fake ~/.claude.json is only read.
  python3 software-factory/tests/test_trust_gate.py"""
import json, os, shutil, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import test_doctor as doc  # noqa: E402
import test_mcp_isolation as iso  # noqa: E402
from test_trust import claude_json  # noqa: E402


def loop(trusted):
    work, env = iso.loop_project()
    for name in ("factory_trust.py", "factory_roles.py", "factory_config.py"):
        shutil.copy(os.path.join(doc.HOOKS, name), os.path.join(work, ".claude", "hooks", name))
    home = env["HOME"] = os.path.join(os.path.dirname(work), "home")
    os.makedirs(home)
    claude_json(home, [work] if trusted else [], [] if trusted else [work])
    p = subprocess.run(["bash", "./factory-loop.sh", "1"], cwd=work, env=env, capture_output=True, text=True, timeout=60)
    return p, work, env


def test_a_headless_run_in_an_untrusted_folder_stops_with_a_plain_error_before_claude_starts():
    p, work, env = loop(trusted=False)
    assert p.returncode != 0, p
    assert not os.path.exists(env["CLAUDE_LOG"]), "claude must not be started"
    line = [l for l in p.stdout.splitlines() + p.stderr.splitlines() if "folder_not_trusted" in l][0]
    err = json.loads(line[line.index("{"):])
    assert set(err) == {"code", "message", "fix"} and os.path.realpath(work) in err["fix"], err
    assert "secret" not in p.stdout + p.stderr


def test_a_headless_run_in_a_trusted_folder_starts_as_before():
    p, work, env = loop(trusted=True)
    assert p.returncode == 0 and len(iso.calls(env)) == 1, p


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
