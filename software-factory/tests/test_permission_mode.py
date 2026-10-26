#!/usr/bin/env python3
"""How an unattended run gets its permissions (#179): every headless `claude -p` the factory starts carries
`--permission-mode <permissionMode>` (default acceptEdits, so edits inside the project need no answer and the allow list
in settings.json covers the commands), the dry runs show it, interactive sessions are left alone, and `factory doctor`
prints the mode and says `fix` when a headless run would stall.
The rest is in permission_mode.test.ts (#252); these need factory_doctor.
  python3 software-factory/tests/test_permission_mode.py"""
import json, os, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import test_doctor as doc  # noqa: E402


# --- factory doctor ---------------------------------------------------------------------------------------------------

ALLOW = ["Bash(git fetch*)", "Bash(git add*)", "Bash(git commit*)", "Bash(git push*)", "Bash(gh pr *)"]


def doctor(cfg, allow=ALLOW, home_settings=None):
    d = doc.project(cfg={"agents": ["taytu"], **cfg})
    json.dump({"hooks": {"PreToolUse": [{"hooks": [{"type": "command", "command": "python3 .claude/hooks/pr-gate.py"}]}]},
               "permissions": {"allow": allow}}, open(os.path.join(d, ".claude", "settings.json"), "w"))
    env = {**doc.machine(), "FACTORY_AGENTS": "taytu"}
    if home_settings is not None:
        os.makedirs(os.path.join(env["HOME"], ".claude"))
        json.dump(home_settings, open(os.path.join(env["HOME"], ".claude", "settings.json"), "w"))
    return doc.doctor(d, env)


def test_doctor_prints_the_effective_mode_for_unattended_runs():
    p = doctor({})
    assert any("unattended runs" in l and "acceptEdits" in l for l in doc.lines(p, "ok")), p.stdout
    assert not [l for l in doc.lines(p, "fix") if "permission" in l.lower()], p.stdout


def test_doctor_says_fix_when_the_allow_list_lacks_a_command_the_loop_needs():
    p = doctor({}, allow=["Bash(git fetch*)"])
    fixes = [l for l in doc.lines(p, "fix") if "git commit" in l or "git push" in l]
    assert fixes and "factory.json" in fixes[0] and "permissions.allow" in fixes[0], p.stdout
    p = doctor({"permissions": {"allow": ["Bash(git commit*)", "Bash(git add*)", "Bash(git push*)", "Bash(gh pr *)"]}}, allow=["Bash(git fetch*)"])
    assert not [l for l in doc.lines(p, "fix") if "git commit" in l], "rules the project lists in factory.json count"


def test_doctor_says_fix_for_mode_default_unless_the_users_own_settings_set_one():
    p = doctor({"permissionMode": "default"})
    assert any("permissionMode" in l and "acceptEdits" in l for l in doc.lines(p, "fix")), p.stdout
    p = doctor({"permissionMode": "default"}, home_settings={"permissions": {"defaultMode": "acceptEdits"}})
    assert not [l for l in doc.lines(p, "fix") if "permission" in l.lower()], p.stdout
    assert any("unattended runs" in l and "acceptEdits" in l for l in doc.lines(p, "ok")), p.stdout


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
