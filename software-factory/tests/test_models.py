#!/usr/bin/env python3
"""The `models` setting: a model (and effort) per role, in factory.json (#94). A role with no entry behaves as before.
The values must reach the `claude` command line: --model and --effort for the builder (loop, `factory agent`) and
the manager, --agents for a subagent (the one mechanism that overrides a kit agent file per role; see factory_models.ts).
  python3 software-factory/tests/test_models.py
Everything else is in models.test.ts (#252); these need factory_doctor, not ported yet."""
import json, os, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
KIT = os.path.abspath(os.path.join(HERE, "..", "kit"))
HOOKS = os.path.abspath(os.path.join(HERE, "..", "hooks"))
AGENTS = os.path.join(KIT, ".claude", "agents")

SUBAGENTS = ("test-writer", "reviewer", "architecture-reviewer", "safety-auditor", "security-reviewer")


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




if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
