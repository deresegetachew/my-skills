#!/usr/bin/env python3
"""How an unattended run gets its permissions (#179): every headless `claude -p` the factory starts carries
`--permission-mode <permissionMode>` (default acceptEdits, so edits inside the project need no answer and the allow list
in settings.json covers the commands), the dry runs show it, and interactive sessions are left alone. The doctor's
cases are in permission_mode.test.ts (#252); these need factory_roles, not ported yet.
The `permissionMode` validation case is in permission_mode.test.ts (#252); these need factory_roles and factory_doctor.
  python3 software-factory/tests/test_permission_mode.py"""
import json, os, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
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


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
