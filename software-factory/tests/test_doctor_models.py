#!/usr/bin/env python3
"""`factory doctor` says which model a session role will use without spending tokens (#194, the doctor half): the
`models` setting when set; else the model Claude Code resolves from ANTHROPIC_MODEL or the `model` key of its settings
files (project, then user); else plainly that it can't tell, with the command that pins one. Read-only: only the
`model` key of those files is looked at, and nothing else from them is printed.
  python3 software-factory/tests/test_doctor_models.py"""
import json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import test_doctor as doc  # noqa: E402


def run(models=None, env_model=None, user=None, project_settings=None):
    d = doc.project(cfg={"agents": ["taytu"], **({"models": models} if models else {})})
    env = {**doc.machine(), "FACTORY_AGENTS": "taytu"}
    if env_model:
        env["ANTHROPIC_MODEL"] = env_model
    if user is not None:
        os.makedirs(os.path.join(env["HOME"], ".claude"))
        json.dump(user, open(os.path.join(env["HOME"], ".claude", "settings.json"), "w"))
    if project_settings is not None:
        json.dump(project_settings, open(os.path.join(d, ".claude", "settings.json"), "w"))
    p = doc.doctor(d, env)
    return p, {l.split("model for ")[1].split(":")[0]: l for l in p.stdout.splitlines() if "model for" in l}


def test_the_models_setting_wins_and_is_named():
    p, by = run(models={"builder": {"model": "opus"}}, env_model="sonnet")
    assert by["builder"].startswith("ok") and "opus" in by["builder"] and "setting" in by["builder"], by["builder"]


def test_an_unset_role_shows_the_model_anthropic_model_resolves_to():
    p, by = run(env_model="claude-sonnet-5-5")
    for role in ("builder", "manager"):
        assert by[role].startswith("ok") and "Claude Code default" in by[role] and "claude-sonnet-5-5" in by[role] and "ANTHROPIC_MODEL" in by[role], by[role]


def test_an_unset_role_shows_the_users_settings_model_and_only_that_key():
    p, by = run(user={"model": "opus", "env": {"SECRET_TOKEN": "hunter2"}, "apiKeyHelper": "get-my-key"})
    assert "opus" in by["builder"] and "~/.claude/settings.json" in by["builder"], by["builder"]
    assert "hunter2" not in p.stdout and "get-my-key" not in p.stdout


def test_the_project_settings_model_comes_before_the_users():
    p, by = run(user={"model": "opus"}, project_settings={"model": "haiku", "hooks": {}})
    assert "haiku" in by["builder"] and ".claude/settings.json" in by["builder"] and "opus" not in by["builder"], by["builder"]


def test_the_environment_comes_before_the_settings_files():
    p, by = run(env_model="sonnet", user={"model": "opus"})
    assert "sonnet" in by["builder"] and "opus" not in by["builder"], by["builder"]


def test_when_nothing_can_be_read_it_says_so_with_the_pin_command_and_is_a_note_not_a_fix():
    p, by = run()
    for role in ("builder", "manager"):
        assert by[role].startswith("note") and "can't tell" in by[role], by[role]
        assert f"""factory settings set models '{{"{role}":{{"model":"<name>"}}}}'""" in by[role], by[role]
        assert "Claude Code default" in by[role]
    assert p.returncode == 0, p.stdout


def test_doctor_makes_no_model_call():
    d = doc.project(cfg={"agents": ["taytu"]})
    bin_ = tempfile.mkdtemp()
    env = doc.machine()
    log = os.path.join(bin_, "claude.log")
    open(os.path.join(env["PATH"], "claude"), "w").write(f"#!/bin/sh\necho \"$*\" >> {log}\necho '2.1.310 (Claude Code)'\n")
    doc.doctor(d, {**env, "FACTORY_AGENTS": "taytu"})
    assert set(open(log).read().split()) <= {"--version", "2.1.310", "(Claude", "Code)"}, open(log).read()


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
