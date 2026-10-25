#!/usr/bin/env python3
"""The `models` setting: a model (and effort) per role, in factory.json (#94). A role with no entry behaves as before.
The values must reach the `claude` command line: --model and --effort for the builder (loop, `factory agent`) and
the manager, --agents for a subagent (the one mechanism that overrides a kit agent file per role; see factory_models.py).
  python3 software-factory/tests/test_models.py"""
import json, os, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
KIT = os.path.abspath(os.path.join(HERE, "..", "kit"))
HOOKS = os.path.abspath(os.path.join(HERE, "..", "hooks"))
AGENTS = os.path.join(KIT, ".claude", "agents")
sys.path.insert(0, HERE)
import test_mcp_isolation as iso  # noqa: E402  (its stub loop project and fake claude)

SUBAGENTS = ("test-writer", "reviewer", "architecture-reviewer", "safety-auditor", "security-reviewer")


def person_env():
    env = dict(os.environ)
    for var in ("FACTORY_AGENT", "FACTORY_LOOP", "CLAUDECODE"):
        env.pop(var, None)
    return env


def project(models=None):
    d = tempfile.mkdtemp()
    subprocess.run(["git", "init", "-q", "-b", "main", d], check=True)
    hooks = os.path.join(d, ".claude", "hooks")
    os.makedirs(hooks)
    os.symlink(AGENTS, os.path.join(d, ".claude", "agents"))
    for f in os.listdir(HOOKS):
        if f.endswith(".py"):
            os.symlink(os.path.join(HOOKS, f), os.path.join(hooks, f))
    cfg = {"agents": ["menelik", "taytu"]}
    if models is not None:
        cfg["models"] = models
    json.dump(cfg, open(os.path.join(d, ".claude", "factory.json"), "w"))
    json.dump({"hooks": {}}, open(os.path.join(d, ".claude", "settings.json"), "w"))
    return d


def models_py(d, *args):
    return subprocess.run([sys.executable, os.path.join(d, ".claude", "hooks", "factory_models.py"), *args], cwd=d,
                          capture_output=True, text=True)


def settings(d, *args):
    return subprocess.run([sys.executable, os.path.join(HOOKS, "factory_settings.py"), *args], cwd=d,
                          capture_output=True, text=True, env=person_env())


def test_settings_show_models_documents_the_shape():
    p = settings(project(), "show", "models")
    assert p.returncode == 0, p
    for word in ("builder", "manager", "test-writer", "reviewer", "architecture-reviewer", "safety-auditor",
                 "security-reviewer", "effort", "escalateTo"):
        assert word in p.stdout, (word, p.stdout)
    assert "factory settings" in settings(project()).stdout and "models" in settings(project()).stdout


def test_set_accepts_a_good_value_and_rejects_a_bad_role_an_empty_model_and_a_bad_effort():
    d = project()
    good = {"builder": {"model": "opus", "effort": "high"}, "reviewer": {"model": "sonnet", "escalateTo": "opus"},
            "architecture-reviewer": {}}
    p = settings(d, "set", "models", json.dumps(good))
    assert p.returncode == 0, p
    assert json.load(open(os.path.join(d, ".claude", "factory.json")))["models"] == good
    for bad in ({"janitor": {"model": "opus"}}, {"builder": {"model": ""}}, {"builder": {"model": "--dangerous"}},
                {"builder": {"model": "opus", "effort": "turbo"}}, {"test-writer": {"effort": "high"}},
                {"builder": {"escalateTo": "opus"}}, {"builder": "opus"}, ["builder"]):
        d = project()
        p = settings(d, "set", "models", json.dumps(bad))
        assert p.returncode != 0 and "models" in p.stderr, (bad, p)
        assert "models" not in json.load(open(os.path.join(d, ".claude", "factory.json"))), bad


def test_no_models_entry_means_no_flags_at_all():
    d = project()
    for role in ("builder", "manager"):
        p = models_py(d, "flags", role)
        assert p.returncode == 0 and p.stdout == "", (role, p)
    d = project({"builder": {}, "manager": {}, "reviewer": {}, "safety-auditor": {}})
    assert models_py(d, "flags", "builder").stdout == ""


def flags_of(d, role):
    p = models_py(d, "flags", role)
    assert p.returncode == 0, p
    return p.stdout.splitlines()


def test_builder_and_manager_get_model_and_effort():
    d = project({"builder": {"model": "opus", "effort": "high"}, "manager": {"model": "sonnet"}})
    assert flags_of(d, "builder") == ["--model", "opus", "--effort", "high"]
    assert flags_of(d, "manager") == ["--model", "sonnet"]


def test_each_subagent_role_reaches_claude_as_an_agents_override_that_keeps_its_instructions():
    for role in SUBAGENTS:
        d = project({role: {"model": "haiku"}})
        args = flags_of(d, "builder")
        assert args[0] == "--agents" and len(args) == 2, (role, args)
        agents = json.loads(args[1])
        assert list(agents) == [role], agents
        text = open(os.path.join(AGENTS, role + ".md")).read()
        assert agents[role]["model"] == "haiku"
        assert agents[role]["prompt"].strip() == text.split("\n---\n", 1)[1].strip(), role
        assert agents[role]["tools"] and "Read" in agents[role]["tools"] and agents[role]["description"], agents[role]
        assert flags_of(d, "manager")[:1] == ["--agents"]  # the manager starts subagents too


def run_loop(models):
    work, env = iso.loop_project()
    cfg = {"waitMinutes": 0}
    if models is not None:
        cfg["models"] = models
    json.dump(cfg, open(os.path.join(work, ".claude", "factory.json"), "w"))
    shutil.copy(os.path.join(HOOKS, "factory_models.py"), os.path.join(work, ".claude", "hooks", "factory_models.py"))
    shutil.copy(os.path.join(HOOKS, "factory_config.py"), os.path.join(work, ".claude", "hooks", "factory_config.py"))
    os.symlink(AGENTS, os.path.join(work, ".claude", "agents"))
    subprocess.run(["bash", "./factory-loop.sh", "1"], cwd=work, env=env, capture_output=True, text=True, timeout=60)
    (args,) = iso.calls(env)
    return args


def test_the_loop_passes_the_builder_model_effort_and_subagent_overrides_to_claude():
    args = run_loop({"builder": {"model": "opus", "effort": "xhigh"}, "test-writer": {"model": "haiku"}})
    assert iso.flag(args, "--model") == "opus" and iso.flag(args, "--effort") == "xhigh", args
    assert json.loads(iso.flag(args, "--agents"))["test-writer"]["model"] == "haiku", args
    assert args[-2:] == ["-p", "/next-task 1.1"], args


def test_a_loop_with_no_models_runs_exactly_as_before():
    args = run_loop(None)
    for f in ("--model", "--effort", "--agents"):
        assert f not in args, args
    assert args[:2] == ["--mcp-config", iso.EMPTY] and args[-2:] == ["-p", "/next-task 1.1"], args


def test_the_loop_refuses_a_bad_models_value_and_says_why():
    work, env = iso.loop_project()
    json.dump({"waitMinutes": 0, "models": {"janitor": {"model": "x"}}}, open(os.path.join(work, ".claude", "factory.json"), "w"))
    for f in ("factory_models.py", "factory_config.py"):
        shutil.copy(os.path.join(HOOKS, f), os.path.join(work, ".claude", "hooks", f))
    p = subprocess.run(["bash", "./factory-loop.sh", "1"], cwd=work, env=env, capture_output=True, text=True, timeout=60)
    assert p.returncode != 0 and "janitor" in p.stdout + p.stderr and not os.path.exists(env["CLAUDE_LOG"]), p


def agent_run(models):
    d = project(models)
    subprocess.run(["git", "add", "-A"], cwd=d, check=True)
    subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "s"], cwd=d, check=True)
    origin = os.path.join(d, "..", os.path.basename(d) + "-origin.git")
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", origin], check=True)
    subprocess.run(["git", "remote", "add", "origin", origin], cwd=d, check=True)
    subprocess.run(["git", "push", "-q", "origin", "HEAD:main"], cwd=d, check=True, capture_output=True)
    env = iso.fake_claude(tempfile.mkdtemp())
    p = subprocess.run(["bash", os.path.join(HERE, "..", "factory"), "agent", "menelik", "--resume"], cwd=d, env=env,
                       capture_output=True, text=True, timeout=60)
    assert p.returncode == 0, p
    (args,) = iso.calls(env)
    return args


def test_factory_agent_passes_the_models_setting_before_the_users_own_arguments():
    args = agent_run({"builder": {"model": "opus", "effort": "low"}, "reviewer": {"model": "haiku"}})
    assert iso.flag(args, "--model") == "opus" and iso.flag(args, "--effort") == "low", args
    assert json.loads(iso.flag(args, "--agents"))["reviewer"]["model"] == "haiku", args
    assert args[-1] == "--resume" and args.index("--model") < args.index("--resume"), args


def test_factory_agent_with_no_models_adds_nothing():
    args = agent_run(None)
    for f in ("--model", "--effort", "--agents"):
        assert f not in args, args


def test_doctor_shows_the_effective_model_per_role_and_where_it_came_from():
    d = project({"builder": {"model": "opus"}, "reviewer": {"model": "haiku"}})
    p = subprocess.run([sys.executable, os.path.join(HOOKS, "factory_doctor.py")], cwd=d, capture_output=True, text=True)
    out = [l for l in p.stdout.splitlines() if "model for" in l]
    by = {l.split("model for ")[1].split(":")[0]: l for l in out}
    assert set(by) == {"builder", "manager", *SUBAGENTS}, out
    assert "opus" in by["builder"] and "setting" in by["builder"], by["builder"]
    assert "Claude Code default" in by["manager"], by["manager"]
    assert "haiku" in by["reviewer"] and "setting" in by["reviewer"], by["reviewer"]
    assert "opus" in by["safety-auditor"] and "agent file" in by["safety-auditor"], by["safety-auditor"]
    assert "sonnet" in by["test-writer"] and "agent file" in by["test-writer"], by["test-writer"]


def test_doctor_flags_a_bad_models_value():
    d = project({"builder": {"model": ""}})
    p = subprocess.run([sys.executable, os.path.join(HOOKS, "factory_doctor.py")], cwd=d, capture_output=True, text=True)
    assert p.returncode == 1 and any(l.startswith("fix") and "models" in l for l in p.stdout.splitlines()), p.stdout


def test_escalate_prints_the_reviewers_escalation_model_and_opus_when_unset():
    assert models_py(project({"reviewer": {"model": "sonnet", "escalateTo": "claude-opus-5-5"}}), "escalate").stdout.strip() == "claude-opus-5-5"
    assert models_py(project(), "escalate").stdout.strip() == "opus"
    assert models_py(project({"reviewer": {"model": "haiku"}}), "escalate").stdout.strip() == "opus"


def test_the_next_task_skill_asks_for_the_escalation_model_from_the_setting():
    skill = open(os.path.join(KIT, ".claude", "skills", "next-task", "SKILL.md")).read()
    assert "factory_models.py escalate" in " ".join(skill.split()) and "models.reviewer.escalateTo" in skill


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
