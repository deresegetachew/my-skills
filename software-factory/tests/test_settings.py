#!/usr/bin/env python3
"""`factory settings` and the Stop check's changed-only commands.  python3 software-factory/tests/test_settings.py"""
import json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
HOOKS = os.path.abspath(os.path.join(HERE, "..", "kit", ".claude", "hooks"))
SETTINGS = os.path.join(HOOKS, "factory_settings.py")
CHECK = os.path.join(HOOKS, "check.py")


def project(cfg=None):
    d = tempfile.mkdtemp()
    subprocess.run(["git", "init", "-q", d], check=True)
    os.makedirs(os.path.join(d, ".claude"))
    if cfg is not None:
        json.dump(cfg, open(os.path.join(d, ".claude", "factory.json"), "w"))
    return d


def person_env():
    env = dict(os.environ)
    for var in ("FACTORY_AGENT", "FACTORY_LOOP", "CLAUDECODE"):
        env.pop(var, None)
    return env


def settings(d, *args, env=None):
    return subprocess.run([sys.executable, SETTINGS, *args], cwd=d, capture_output=True, text=True,
                          env=env or person_env())


def saved(d):
    return json.load(open(os.path.join(d, ".claude", "factory.json")))


def test_list_shows_values_here_defaults_and_other_keys():
    d = project({"_about": "x", "maxOpenPRs": 4, "custom": 1})
    p = settings(d)
    assert p.returncode == 0, p
    assert "maxOpenPRs" in p.stdout and "4" in p.stdout
    assert '"plan"  (default)' in p.stdout  # tasks.source, not set here
    assert "custom" in p.stdout and "_about" not in p.stdout.split("Other keys")[-1]


def test_show_names_the_options():
    p = settings(project({}), "show", "tasks.source")
    assert p.returncode == 0 and "plan, issues" in p.stdout and "here: (default)" in p.stdout, p


def test_set_checks_the_type_and_keeps_everything_else():
    d = project({"_about": "keep me", "tasks": {"source": "issues"}, "custom": [1]})
    assert settings(d, "set", "tasks.pingMinutes", "10").returncode == 0
    assert settings(d, "set", "tasks.showWhere", "yes").returncode == 0
    assert settings(d, "set", "agents", '["ada","grace"]').returncode == 0
    assert saved(d) == {"_about": "keep me", "tasks": {"source": "issues", "pingMinutes": 10, "showWhere": True},
                        "custom": [1], "agents": ["ada", "grace"]}, saved(d)
    for key, bad in (("tasks.source", "plans"), ("maxOpenPRs", "four"), ("maxOpenPRs", "-1"),
                     ("agents", '["../x"]'), ("agents", "ada"), ("tasks.showWhere", "maybe")):
        p = settings(d, "set", key, bad)
        assert p.returncode != 0, (key, bad, p)
    assert saved(d)["tasks"]["source"] == "issues"


def test_an_unknown_key_is_refused_and_nothing_is_written():
    d = project({"maxOpenPRs": 4})
    p = settings(d, "set", "protectedd", "[]")
    assert p.returncode != 0 and "isn't a setting" in p.stderr, p
    assert saved(d) == {"maxOpenPRs": 4}


def test_unset_goes_back_to_the_default():
    d = project({"maxOpenPRs": 4, "tasks": {"source": "issues"}})
    assert settings(d, "unset", "maxOpenPRs").returncode == 0
    assert settings(d, "get", "maxOpenPRs").stdout.strip() == "3"
    assert saved(d) == {"tasks": {"source": "issues"}}


def test_an_agent_session_can_read_but_never_change_settings():
    d = project({"maxOpenPRs": 4, "protected": ["^\\.claude/"]})
    for var in ("FACTORY_AGENT", "FACTORY_LOOP", "CLAUDECODE"):
        env = {**person_env(), var: "1"}
        assert settings(d, "set", "protected", "[]", env=env).returncode != 0
        assert settings(d, "unset", "protected", env=env).returncode != 0
        assert settings(d, "get", "maxOpenPRs", env=env).stdout.strip() == "4"
    assert saved(d) == {"maxOpenPRs": 4, "protected": ["^\\.claude/"]}


def test_agents_are_denied_the_settings_command():
    rules = json.load(open(os.path.join(HOOKS, "..", "settings.json")))["permissions"]["deny"]
    for rule in ("Bash(factory settings set*)", "Bash(factory settings unset*)", "Bash(*factory_settings.py*)"):
        assert rule in rules, rule


def stop_check(d, commands, out_lines=None):
    os.makedirs(os.path.join(d, "src"), exist_ok=True)
    cfg = {"codePaths": ["src"], "commands": commands}
    if out_lines:
        cfg["checkOutputLines"] = out_lines
    json.dump(cfg, open(os.path.join(d, ".claude", "factory.json"), "w"))
    open(os.path.join(d, "src", "a.ts"), "w").write("x")  # an untracked change under codePaths
    return subprocess.run([sys.executable, CHECK], cwd=d, input="{}", capture_output=True, text=True,
                          env={**person_env(), "CLAUDE_PROJECT_DIR": d})


def test_the_stop_check_runs_the_changed_only_command_when_set():
    d = project()
    p = stop_check(d, {"test": "echo full > ran; exit 0", "testChanged": "echo changed > ran; exit 0"})
    assert p.returncode == 0, p
    assert open(os.path.join(d, "ran")).read().strip() == "changed"
    p = stop_check(d, {"test": "echo full > ran; exit 0"})
    assert open(os.path.join(d, "ran")).read().strip() == "full"


def test_a_failing_check_shows_the_failures_first_within_the_limit():
    d = project()
    script = "; ".join([f"echo noise {i}" for i in range(200)] + ["echo 'FAIL src/a.test.ts > adds'"] +
                       [f"echo more {i}" for i in range(200)] + ["exit 1"])
    p = stop_check(d, {"test": script}, out_lines=10)
    assert p.returncode == 2, p
    shown = p.stderr.splitlines()[1:]
    assert "FAIL src/a.test.ts > adds" in shown, shown
    assert shown[-1] == "more 199", shown
    assert len([l for l in shown if l != "..."]) <= 10, shown


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
