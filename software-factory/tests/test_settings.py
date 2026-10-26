#!/usr/bin/env python3
"""`factory settings` and the Stop check's changed-only commands.  python3 software-factory/tests/test_settings.py"""
import json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
HOOKS = os.path.abspath(os.path.join(HERE, "..", "hooks"))
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


def test_the_release_repository_is_a_setting_with_a_default_and_can_be_changed():
    d = project({})
    p = settings(d, "show", "release.repo")
    assert p.returncode == 0 and "deresegetachew/my-skills" in p.stdout and "factory update" in p.stdout, p
    assert settings(d, "set", "release.repo", "acme/factory").returncode == 0
    assert saved(d)["release"] == {"repo": "acme/factory"}


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
    for var, value in (("FACTORY_AGENT", "1"), ("FACTORY_LOOP", "1"), ("CLAUDECODE", "1"), ("CLAUDECODE", "")):
        env = {**person_env(), var: value}
        assert settings(d, "set", "protected", "[]", env=env).returncode != 0
        assert settings(d, "unset", "protected", env=env).returncode != 0
        assert settings(d, "get", "maxOpenPRs", env=env).stdout.strip() == "4"
    assert saved(d) == {"maxOpenPRs": 4, "protected": ["^\\.claude/"]}


def test_agents_are_denied_the_settings_command():
    rules = json.load(open(os.path.join(HOOKS, "..", "kit", ".claude", "settings.json")))["permissions"]["deny"]
    for rule in ("Bash(factory settings set*)", "Bash(factory settings unset*)", "Bash(*factory_setting*)"):
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


def test_a_bad_output_limit_never_skips_the_check():
    d = project()
    p = stop_check(d, {"test": "echo 'FAIL x'; exit 1"}, out_lines="forty")
    assert p.returncode == 2 and "FAIL x" in p.stderr, p


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


# ---------------------------------------------------------------------------------------------------------------
# #49: the interactive `factory settings`, sections, help, diff, validate, --local, saving through a PR.

PR_GATE = os.path.join(HOOKS, "pr-gate.py")
README = os.path.abspath(os.path.join(HERE, "..", "README.md"))
TEMPLATE = os.path.abspath(os.path.join(HERE, "..", "kit", ".claude", "factory.json"))


def with_env(d, **extra):
    env = person_env()
    env["FACTORY_CONFIG_DIR"] = os.path.join(d, "machine-config")
    for var in ("FACTORY_AGENTS", "FACTORY_REMOTE_CONTROL"):
        env.pop(var, None)
    env.update(extra)
    return env


def session(d, script, *args, env=None):
    """A scripted `factory settings interactive` session: `script` is what the person types, one line each."""
    return subprocess.run([sys.executable, SETTINGS, "interactive", *args], cwd=d, input=script, capture_output=True,
                          text=True, env=env or with_env(d))


def test_list_can_be_limited_to_a_section_and_gives_json():
    d = project({"maxOpenPRs": 4})
    p = settings(d, "list", "--section", "commands")
    assert p.returncode == 0 and "commands.typecheck" in p.stdout and "maxOpenPRs" not in p.stdout, p
    rows = json.loads(settings(d, "list", "--json").stdout)
    by = {r["key"]: r for r in rows}
    row = by["maxOpenPRs"]
    assert row["value"] == 4 and row["default"] == 3 and row["overridden"] is True and row["section"], row
    assert row["description"] and row["scope"] == "project", row
    assert by["tasks.source"]["overridden"] is False and by["tasks.source"]["value"] == "plan"
    bad = settings(d, "list", "--section", "nope")
    assert bad.returncode != 0 and "commands" in bad.stderr, bad


def test_list_says_which_settings_are_overridden_and_what_the_default_is():
    d = project({"maxOpenPRs": 4})
    line = [l for l in settings(d, "list").stdout.splitlines() if l.startswith("maxOpenPRs")][0]
    assert "4" in line and "(default 3, overridden)" in line, line


def test_every_default_and_every_template_key_is_a_known_setting():
    sys.path.insert(0, HOOKS)
    from factory_config import DEFAULTS
    from factory_settings_schema import SETTINGS as table, is_known_path

    def leaves(node, prefix=""):
        for k, v in node.items():
            if k.startswith("_"):
                continue
            path = prefix + k
            if isinstance(v, dict) and v and not is_free_form(path):
                yield from leaves(v, path + ".")
            else:
                yield path

    from factory_settings_schema import is_free_form
    missing = [k for k in list(leaves(DEFAULTS)) + list(leaves(json.load(open(TEMPLATE)))) if not is_known_path(k)]
    assert not missing, missing
    for key, s in table.items():
        assert s.short and s.section and s.kind in ("str", "int", "bool", "list", "dict", "enum"), key


def test_the_help_says_the_owner_merges_a_change_under_claude_never_the_dev_manager():
    d = project({})
    for key in ("tasks.source", "protected"):
        out = settings(d, "help", key).stdout
        assert "owner merges" in out and "dev manager" not in out, (key, out)


def test_help_without_a_key_lists_the_sections_and_with_a_key_gives_the_long_help():
    d = project({})
    p = settings(d, "help")
    assert p.returncode == 0 and "Paths & docs" in p.stdout and "Machine" in p.stdout, p
    p = settings(d, "help", "testPaths")
    assert p.returncode == 0, p
    for part in ("testPaths", "Read by", "Example", "tests-reviewed", "Default"):
        assert part in p.stdout, (part, p.stdout)
    p = settings(d, "help", "maxOpenPRs")
    assert "pr-gate" in p.stdout or "PR gate" in p.stdout, p.stdout


def test_diff_shows_what_differs_from_the_defaults():
    d = project({"_about": "x", "maxOpenPRs": 4, "mainBranch": "main", "custom": 1})
    p = settings(d, "diff")
    assert p.returncode == 0 and "maxOpenPRs" in p.stdout and "default 3" in p.stdout, p
    assert "mainBranch" not in p.stdout  # same as the default
    assert "custom" in p.stdout
    assert "no differences" in settings(project({}), "diff").stdout.lower()


def test_validate_fails_with_clear_messages():
    d = project({"testPaths": ["(unclosed"], "tasks": {"source": "plans"}, "agents": ["ada", "ada"], "maxOpenPRs": 0})
    p = settings(d, "validate")
    assert p.returncode == 1, p
    out = p.stderr + p.stdout
    for part in ("testPaths", "regex", "tasks.source", "plan, issues", "agents", "ada", "twice", "maxOpenPRs", "1"):
        assert part in out, (part, out)
    ok = project({"maxOpenPRs": 4, "tasks": {"source": "issues"}, "testPaths": ["^t/"]})
    p = settings(ok, "validate")
    assert p.returncode == 0 and "ok" in p.stdout.lower(), p


def test_validate_warns_about_unknown_keys_and_missing_paths_and_port_collisions():
    d = project({"maxOpenPR": 3, "tasks": {"sourse": "plan"}, "prd": "docs/NOPE.md"})
    p = settings(d, "validate")
    assert p.returncode == 1 and "docs/NOPE.md" in p.stderr + p.stdout, p
    assert "maxOpenPR" in p.stdout + p.stderr and "tasks.sourse" in p.stdout + p.stderr
    d = project({"agents": ["ada", "grace"], "portStep": 5, "agentEnv": {"API": "{port:4100}", "WEB": "{port:4105}"}})
    p = settings(d, "validate")
    assert p.returncode == 1 and "4105" in p.stderr + p.stdout, p
    d = project({"agents": ["ada", "grace"], "portStep": 10, "agentEnv": {"API": "{port:4100}", "WEB": "{port:4105}"}})
    assert settings(d, "validate").returncode == 0
    # an unknown key alone is only a warning
    d = project({"typo": 1})
    p = settings(d, "validate")
    assert p.returncode == 0 and "typo" in p.stdout + p.stderr, p


def test_validate_reports_a_broken_file():
    d = project()
    open(os.path.join(d, ".claude", "factory.json"), "w").write("{nope")
    p = settings(d, "validate")
    assert p.returncode == 1 and "valid JSON" in p.stderr + p.stdout, p


def test_set_checks_minimums_and_regexes():
    d = project({"maxOpenPRs": 4})
    for key, bad in (("maxOpenPRs", "0"), ("portStep", "0"), ("reReviewPercent", "101"), ("testPaths", '["(x"]'),
                     ("protected", '[1]'), ("agents", '["ada","ada"]'), ("agentEnv", '{"A": 1}')):
        p = settings(d, "set", key, bad)
        assert p.returncode != 0, (key, bad)
    assert settings(d, "set", "waitMinutes", "0").returncode == 0  # 0 means exit, so it is allowed
    assert saved(d) == {"maxOpenPRs": 4, "waitMinutes": 0}


def test_a_save_keeps_about_key_order_indent_and_a_trailing_newline():
    d = project()
    path = os.path.join(d, ".claude", "factory.json")
    open(path, "w").write('{\n    "_about": "keep",\n    "zeta": 1,\n    "maxOpenPRs": 4,\n    "tasks": {\n        "source": "issues"\n    }\n}\n')
    assert settings(d, "set", "prSizeWarn", "700").returncode == 0
    text = open(path).read()
    assert text.endswith("}\n") and not text.endswith("\n\n")
    assert '\n    "_about": "keep"' in text, text  # the file's own 4-space indent
    assert list(json.loads(text)) == ["_about", "zeta", "maxOpenPRs", "tasks", "prSizeWarn"], text
    assert settings(d, "unset", "tasks.source").returncode == 0
    assert "tasks" not in saved(d)  # an emptied group goes
    assert not [f for f in os.listdir(os.path.join(d, ".claude")) if f != "factory.json"]  # no temp file left


def test_the_machine_scope_has_its_own_file_outside_the_project():
    d = project({"agents": ["ada", "grace", "haile"]})
    env = with_env(d)
    assert settings(d, "--local", "set", "agents", "grace,haile", env=env).returncode == 0
    assert settings(d, "--local", "set", "remoteControl", "off", env=env).returncode == 0
    assert settings(d, "--local", "set", "autostart", "true", env=env).returncode == 0
    machine = [os.path.join(env["FACTORY_CONFIG_DIR"], f) for f in os.listdir(env["FACTORY_CONFIG_DIR"])
               if f.endswith(".json")]
    assert len(machine) == 1 and json.load(open(machine[0])) == {"agents": ["grace", "haile"],
                                                               "remoteControl": False, "autostart": True}
    assert saved(d) == {"agents": ["ada", "grace", "haile"]}  # the project file is untouched
    assert settings(d, "--local", "get", "agents", env=env).stdout.strip() == '["grace", "haile"]'
    rows = {r["key"]: r for r in json.loads(settings(d, "--local", "list", "--json", env=env).stdout)}
    assert rows["remoteControl"]["value"] is False and rows["remoteControl"]["scope"] == "machine"
    assert rows["remoteControl"]["overridden"] is True and rows["autostartReport"]["overridden"] is False
    assert "maxOpenPRs" not in rows
    for key, bad in (("agents", "nobody"), ("agents", "../x"), ("remoteControl", "maybe")):
        assert settings(d, "--local", "set", key, bad, env=env).returncode != 0, (key, bad)
    assert settings(d, "--local", "unset", "remoteControl", env=env).returncode == 0
    assert "remoteControl" not in json.load(open(machine[0]))
    # a project-only key isn't a machine setting, and the other way round
    assert settings(d, "--local", "set", "maxOpenPRs", "5", env=env).returncode != 0
    assert settings(d, "set", "autostart", "true", env=env).returncode != 0
    # the shell side reads the default from here
    p = subprocess.run([sys.executable, os.path.join(HOOKS, "factory_machine.py"), "remote"], cwd=d, env=env,
                       capture_output=True, text=True)
    assert p.stdout.strip() == "1", p
    settings(d, "--local", "set", "remoteControl", "off", env=env)
    p = subprocess.run([sys.executable, os.path.join(HOOKS, "factory_machine.py"), "remote"], cwd=d, env=env,
                       capture_output=True, text=True)
    assert p.stdout.strip() == "0", p
    p = subprocess.run([sys.executable, os.path.join(HOOKS, "factory_machine.py"), "remote"], cwd=d,
                       env={**env, "FACTORY_REMOTE_CONTROL": "1"}, capture_output=True, text=True)
    assert p.stdout.strip() == "1", p  # the environment variable still wins


def test_an_agent_session_cannot_change_the_machine_scope_or_save_or_open_a_pr():
    d = project({"agents": ["ada"]})
    for var in ("FACTORY_AGENT", "FACTORY_LOOP", "CLAUDECODE"):
        env = with_env(d, **{var: "1"})
        assert settings(d, "--local", "set", "agents", "ada", env=env).returncode != 0
        assert settings(d, "pr", env=env).returncode != 0
        p = session(d, "/maxOpenPRs\n1\nc\n9\ns\nw\nq\n", env=env)
        assert saved(d) == {"agents": ["ada"]}, (var, p.stdout)
        assert "only a person" in p.stdout + p.stderr


def test_the_pr_gate_blocks_settings_changes_but_not_reading():
    def gate(command):
        return subprocess.run([sys.executable, PR_GATE], input=json.dumps({"tool_input": {"command": command}}),
                              capture_output=True, text=True, env=person_env())
    for command in ("factory settings set maxOpenPRs 9", "./factory settings unset maxOpenPRs",
                    "factory settings --local set agents ada", "factory settings pr", "factory settings interactive",
                    "factory settings -i", "cd x && factory settings set a b", "bash -c 'factory settings set a b'",
                    "python3 software-factory/hooks/factory_settings.py set a b",
                    "FOO=1 factory settings docs --write", "factory settings --local unset autostart"):
        p = gate(command)
        assert p.returncode == 2 and "settings" in p.stderr, (command, p)
    for command in ("factory settings", "factory settings list --json", "factory settings get maxOpenPRs",
                    "./factory settings help tasks.source", "factory settings diff", "factory settings validate",
                    "factory settings --local list", "factory settings docs --check", "echo factory settings is fine"):
        assert gate(command).returncode == 0, command


def test_the_deny_rules_cover_every_way_of_changing_settings():
    rules = json.load(open(os.path.join(HOOKS, "..", "kit", ".claude", "settings.json")))["permissions"]["deny"]
    for rule in ("Bash(factory settings pr*)", "Bash(factory settings interactive*)", "Bash(factory settings --local*)",
                 "Bash(./factory settings pr*)", "Bash(./factory settings --local*)", "Bash(factory settings -i*)",
                 "Bash(./factory settings interactive*)", "Bash(./factory settings -i*)"):
        assert rule in rules, rule


def test_a_scripted_session_changes_a_setting_and_saves_only_after_the_diff_and_a_yes():
    d = project({"_about": "keep", "maxOpenPRs": 4, "custom": 1})
    p = session(d, "/maxOpenPRs\n1\nc\n6\ns\nw\nq\n")
    assert p.returncode == 0, p
    assert "Paths & docs" in p.stdout and "Commands" in p.stdout and "Machine" in p.stdout  # the menu
    assert '-  "maxOpenPRs": 4' in p.stdout and '+  "maxOpenPRs": 6' in p.stdout, p.stdout  # the unified diff
    assert saved(d) == {"_about": "keep", "maxOpenPRs": 6, "custom": 1}
    assert list(saved(d)) == ["_about", "maxOpenPRs", "custom"]


def test_a_session_that_quits_or_declines_writes_nothing():
    d = project({"maxOpenPRs": 4})
    session(d, "/maxOpenPRs\n1\nc\n6\nq\nq\n")  # quit with unsaved changes: asked, answered with q again -> leaves
    assert saved(d) == {"maxOpenPRs": 4}
    session(d, "/maxOpenPRs\n1\nc\n6\ns\nc\nq\ny\n")  # cancel at the save question
    assert saved(d) == {"maxOpenPRs": 4}
    p = session(d, "/maxOpenPRs\n1\nc\n6\n")  # the input just ends
    assert saved(d) == {"maxOpenPRs": 4}, p
    p = session(d, "q\n")
    assert p.returncode == 0 and saved(d) == {"maxOpenPRs": 4}


def test_a_session_validates_resets_helps_and_searches():
    d = project({"maxOpenPRs": 4, "tasks": {"source": "issues"}})
    p = session(d, "/maxOpenPRs\n1\nc\nfour\n0\n\nr\ns\nw\nq\n")  # bad, bad, blank cancels; then reset
    assert p.returncode == 0, p
    assert "whole number" in p.stdout and "at least 1" in p.stdout, p.stdout
    assert saved(d) == {"tasks": {"source": "issues"}}  # reset removed the key
    p = session(d, "/maxOpenPRs\n1\n?\nb\nq\n")
    assert "Read by" in p.stdout and "Example" in p.stdout, p.stdout
    p = session(d, "/ready PRs\nq\n")  # search finds it by description
    assert "maxOpenPRs" in p.stdout
    p = session(d, "/zzzzqqq\nq\n")
    assert "No setting matches" in p.stdout
    p = session(d, "99\nx\nq\n")  # nonsense is answered, never a crash
    assert p.returncode == 0 and "Traceback" not in p.stderr, p


def test_a_session_edits_lists_item_by_item_and_tests_regexes():
    d = project({"testPaths": ["^t/", "\\.spec\\."]})
    script = "\n".join([
        "/testPaths", "1", "c",            # change opens the list editor
        "a", "(bad",                       # add an invalid regex: refused
        "a", "^spec/",                     # add a good one
        "e", "1", "^tests/",               # edit item 1
        "r", "2",                          # remove item 2
        "t", "tests/a.py spec/b.py src/c.py", "",  # test paths against the patterns
        "b",                               # back to the setting
        "s", "w", "q"])
    p = session(d, script + "\n")
    assert p.returncode == 0, p
    assert "isn't a valid regex" in p.stdout, p.stdout
    assert "tests/a.py" in p.stdout and "matches" in p.stdout and "src/c.py" in p.stdout and "no match" in p.stdout
    assert saved(d)["testPaths"] == ["^tests/", "^spec/"], saved(d)


def test_a_session_edits_dicts_and_the_machine_section():
    d = project({"agents": ["ada", "grace"], "agentEnv": {"A": "{port:4100}"}})
    env = with_env(d)
    p = session(d, "/agentEnv\n1\nc\na\nB\n{port:4101}\nr\nA\nb\ns\nw\nq\n", env=env)
    assert saved(d)["agentEnv"] == {"B": "{port:4101}"}, (saved(d), p.stdout)
    p = session(d, "10\n1\nc\nw\n[\"ada\"]\nb\nq\nq\n", env=env)  # the machine section, then leave it unsaved
    assert "Machine (local)" in p.stdout
    session(d, "10\n1\nc\nw\n[\"ada\"]\nb\ns\nw\nq\n", env=env)
    machine = [os.path.join(env["FACTORY_CONFIG_DIR"], f) for f in os.listdir(env["FACTORY_CONFIG_DIR"])
               if f.endswith(".json")]
    assert json.load(open(machine[0]))["agents"] == ["ada"]
    assert saved(d)["agents"] == ["ada", "grace"]


FAKE_GH_PR = """#!/usr/bin/env python3
import os, sys
open(os.environ["GH_LOG"], "a").write(" ".join(sys.argv[1:]) + "\\n")
if sys.argv[1:3] == ["pr", "create"]:
    print("https://github.com/o/r/pull/7")
"""


def git_project(cfg):
    d = project(cfg)
    run = lambda *a: subprocess.run(a, cwd=d, check=True, capture_output=True, text=True)
    run("git", "checkout", "-q", "-b", "main")
    run("git", "add", "-A")
    run("git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init")
    remote = tempfile.mkdtemp()
    subprocess.run(["git", "init", "-q", "--bare", remote], check=True)
    run("git", "remote", "add", "origin", remote)
    run("git", "push", "-q", "origin", "main")
    bindir = os.path.join(d, "..", "bin-" + os.path.basename(d))
    os.makedirs(bindir)
    gh = os.path.join(bindir, "gh")
    open(gh, "w").write(FAKE_GH_PR)
    os.chmod(gh, 0o755)
    env = with_env(d, GH_LOG=os.path.join(d, "..", "gh-" + os.path.basename(d) + ".log"),
                   PATH=bindir + os.pathsep + os.environ["PATH"], GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t",
                   GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")
    return d, remote, env


def test_saving_can_open_a_pull_request_with_the_changes_and_the_reviews_they_need():
    d, remote, env = git_project({"maxOpenPRs": 4, "testPaths": ["^t/"]})
    p = session(d, "/maxOpenPRs\n1\nc\n5\n/testPaths\n1\nc\nw\n[\"^t/\", \"^e2e/\"]\nb\ns\nb\nd\nq\n", env=env)
    assert p.returncode == 0, p
    assert "https://github.com/o/r/pull/7" in p.stdout, p.stdout
    branches = subprocess.run(["git", "branch", "-r", "--list", "origin/settings/*"], cwd=d, capture_output=True,
                              text=True).stdout.split()
    assert len(branches) == 1 and branches[0].startswith("origin/settings/"), branches
    pushed = subprocess.run(["git", "--git-dir", remote, "show", f"{branches[0].split('origin/')[1]}:.claude/factory.json"],
                            capture_output=True, text=True).stdout
    assert json.loads(pushed) == {"maxOpenPRs": 5, "testPaths": ["^t/", "^e2e/"]}
    main_file = subprocess.run(["git", "--git-dir", remote, "show", "main:.claude/factory.json"],
                               capture_output=True, text=True).stdout
    assert json.loads(main_file) == {"maxOpenPRs": 4, "testPaths": ["^t/"]}  # main is untouched
    log = open(env["GH_LOG"]).read()
    assert "pr create" in log and "--draft" in log and "--base main" in log, log
    assert "maxOpenPRs" in log and "tests-reviewed" in log, log  # the body lists each change and the review it needs
    # the person's own branch carries the change; the tree is clean after the commit
    status = subprocess.run(["git", "status", "--porcelain"], cwd=d, capture_output=True, text=True).stdout
    assert status.strip() == "", status


def test_the_pr_command_proposes_an_edited_file_and_refuses_off_the_main_branch():
    d, remote, env = git_project({"maxOpenPRs": 4})
    assert settings(d, "set", "maxOpenPRs", "5", env=env).returncode == 0
    subprocess.run(["git", "checkout", "-q", "-b", "other"], cwd=d, check=True)
    p = settings(d, "pr", env=env)
    assert p.returncode != 0 and "main" in p.stderr, p
    subprocess.run(["git", "checkout", "-q", "main"], cwd=d, check=True)
    p = settings(d, "pr", "--ready", env=env)
    assert p.returncode == 0 and "pull/7" in p.stdout, p
    assert "--draft" not in open(env["GH_LOG"]).read()
    p = settings(d, "pr", env=env)  # nothing left to propose
    assert p.returncode != 0 and "nothing" in (p.stderr + p.stdout).lower(), p


def test_the_readme_settings_table_is_generated_from_the_metadata():
    p = subprocess.run([sys.executable, SETTINGS, "docs", "--check", "--file", README], capture_output=True, text=True,
                       env=person_env())
    assert p.returncode == 0, p.stdout + p.stderr
    text = open(README).read()
    assert "<!-- settings:begin -->" in text and "<!-- settings:end -->" in text
    stale = text.replace("Ready PRs the account may have open at once", "x", 1)
    tmp = os.path.join(tempfile.mkdtemp(), "README.md")
    open(tmp, "w").write(stale)
    p = subprocess.run([sys.executable, SETTINGS, "docs", "--check", "--file", tmp], capture_output=True, text=True,
                       env=person_env())
    assert p.returncode == 1 and "docs --write" in p.stderr + p.stdout, p
    p = subprocess.run([sys.executable, SETTINGS, "docs", "--write", "--file", tmp], capture_output=True, text=True,
                       env=person_env())
    assert p.returncode == 0 and "Ready PRs" in open(tmp).read()


def test_factory_help_lists_the_settings_commands():
    factory = os.path.abspath(os.path.join(HERE, "..", "factory"))
    text = open(factory).read()
    for part in ("settings help", "settings validate", "settings diff", "settings --local", "settings interactive"):
        assert part in text, part


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
