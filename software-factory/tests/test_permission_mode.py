#!/usr/bin/env python3
"""How an unattended run gets its permissions (#179): every headless `claude -p` the factory starts carries
`--permission-mode <permissionMode>` (default acceptEdits, so edits inside the project need no answer and the allow list
in settings.json covers the commands), the dry runs show it, interactive sessions are left alone, and `factory doctor`
prints the mode and says `fix` when a headless run would stall.
The `permissionMode` validation case is in permission_mode.test.ts (#252); these need factory_roles and factory_doctor.
  python3 software-factory/tests/test_permission_mode.py"""
import json, os, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import test_doctor as doc  # noqa: E402
import test_mcp_isolation as iso  # noqa: E402
import test_roles as roles  # noqa: E402


def loop_project():
    """The stub project of the MCP isolation tests, with the real role and config modules the loop asks for the flags."""
    work, env = iso.loop_project()
    for name in ("factory_roles.py", "factory_config.py"):
        shutil.copy(os.path.join(iso.HOOKS, name), os.path.join(work, ".claude", "hooks", name))
    return work, env


def loop_args(cfg=None, *extra):
    work, env = loop_project()
    if cfg is not None:
        json.dump({"waitMinutes": 0, **cfg}, open(os.path.join(work, ".claude", "factory.json"), "w"))
    p = subprocess.run(["bash", "./factory-loop.sh", *extra, "1"], cwd=work, env=env, capture_output=True, text=True, timeout=60)
    assert p.returncode == 0, p
    (args,) = iso.calls(env)
    return args


def test_a_headless_coding_agent_run_is_started_in_accept_edits_mode_before_the_prompt():
    args = loop_args()
    assert iso.flag(args, "--permission-mode") == "acceptEdits", args
    assert args.index("--permission-mode") < args.index("-p") and args[-2:] == ["-p", "/next-task 1.1"], args


def test_the_mode_is_a_setting_and_default_passes_no_flag_so_the_users_own_claude_settings_decide():
    assert iso.flag(loop_args({"permissionMode": "acceptEdits"}), "--permission-mode") == "acceptEdits"
    assert "--permission-mode" not in loop_args({"permissionMode": "default"})


def test_an_interactive_session_is_not_given_a_mode():
    work, env = loop_project()
    iso.run_on_a_terminal(work, env, timeout=45)
    (args,) = iso.calls(env)
    assert "--permission-mode" not in args, args


def test_the_coding_agent_dry_run_shows_the_mode():
    work, env = loop_project()
    p = subprocess.run(["bash", "./factory-loop.sh", "--dry-run"], cwd=work, env=env, capture_output=True, text=True, timeout=60)
    assert p.returncode == 0, p
    assert "would run: claude -p" in p.stdout and "--permission-mode acceptEdits" in p.stdout, p.stdout
    assert not os.path.exists(env["CLAUDE_LOG"]), "a dry run starts nothing"


def test_a_product_owner_pass_and_its_dry_run_carry_the_mode_and_the_setting_changes_it():
    d, work, env = roles.project(db=roles.PO_WORK)
    p = roles.factory(work, env, "product-owner", "loop", "--once", "--dry-run")
    assert "would run: claude" in p.stdout and "--permission-mode acceptEdits" in p.stdout, p.stdout
    roles.factory(work, env, "product-owner", "loop", "--once")
    c = roles.claude_calls(env)[0]
    assert "--permission-mode acceptEdits" in c and c.index("--permission-mode") < c.index(" -p "), c


def test_the_dev_managers_dry_run_shows_the_mode():
    d, work, env = roles.project(db=roles.UNREVIEWED)
    p = roles.factory(work, env, "dev-manager", "lead", "loop", "--once", "--dry-run")
    assert "--permission-mode acceptEdits" in p.stdout, p.stdout


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
