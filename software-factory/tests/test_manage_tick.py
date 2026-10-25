#!/usr/bin/env python3
"""factory manage-tick: an idle dev manager tick makes no model call (#71).  python3 software-factory/tests/test_manage_tick.py"""
import json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from test_wait import world, pr, Q, SF  # noqa: E402

TICK = os.path.join(SF, "hooks", "factory_tick.py")
FACTORY = os.path.join(SF, "factory")
FAKE_CLAUDE = '#!/usr/bin/env python3\nimport json, os, sys\nopen(os.environ["CLAUDE_LOG"], "a").write(json.dumps(sys.argv[1:]) + "\\n")\n'


def project(models=None, profile=True, **db):
    d, env = world(**db)
    cfg = {"models": models} if models else {}
    json.dump(cfg, open(f"{d}/.claude/factory.json", "w"))
    if profile:
        os.makedirs(f"{d}/.claude/manager"); open(f"{d}/.claude/manager/settings.json", "w").write("{}")
    open(f"{d}/bin/claude", "w").write(FAKE_CLAUDE); os.chmod(f"{d}/bin/claude", 0o755)
    env["CLAUDE_LOG"] = f"{d}/claude.log"
    subprocess.run(["git", "init", "-q", d], check=True)
    return d, env


def tick(d, env, *args):
    p = subprocess.run([sys.executable, TICK, *args], cwd=d, env=env, capture_output=True, text=True, timeout=60)
    return p.returncode, p.stdout.strip(), p.stderr.strip()


def calls(d):
    try:
        return [json.loads(l) for l in open(f"{d}/claude.log")]
    except OSError:
        return []


def test_an_idle_tick_makes_no_model_call():
    d, env = project(pulls={"7": pr(7)}, comments={"7": ["<!-- factory-approved sha=abc1234 -->", Q, "<!-- factory-answer -->\nok"]})
    assert tick(d, env)[:2] == (0, "nothing to do")
    assert calls(d) == []


def test_a_tick_with_work_starts_one_manage_pass_on_the_manager_profile():
    d, env = project(models={"manager": {"model": "sonnet", "effort": "low"}}, pulls={"7": pr(7, sha="bbb2222")})
    rc, out, err = tick(d, env)
    assert rc == 0 and "PR #7: commit bbb2222 not reviewed" in out, (rc, out, err)
    [argv] = calls(d)
    assert argv[-2:] == ["-p", "/manage-pass"], argv
    assert argv[argv.index("--settings") + 1] == ".claude/manager/settings.json", argv
    assert argv[argv.index("--model") + 1] == "sonnet" and argv[argv.index("--effort") + 1] == "low", argv
    assert "--strict-mcp-config" in argv, argv


def test_no_models_setting_adds_no_model_flags():
    d, env = project(pulls={"7": pr(7, sha="bbb2222")})
    tick(d, env)
    [argv] = calls(d)
    assert "--model" not in argv and "--effort" not in argv, argv


def test_dry_run_prints_the_command_and_starts_nothing():
    d, env = project(pulls={"7": pr(7, sha="bbb2222")})
    rc, out, _ = tick(d, env, "--dry-run")
    assert rc == 0 and "would run: claude" in out and "/manage-pass" in out, out
    assert calls(d) == []


def test_a_missing_manager_profile_stops_with_the_fix_and_no_model_call():
    d, env = project(profile=False, pulls={"7": pr(7, sha="bbb2222")})
    rc, _, err = tick(d, env)
    assert rc == 1 and "Fix:" in err and calls(d) == [], (rc, err)


def test_a_bad_models_setting_stops_with_the_reason():
    d, env = project(models={"nobody": {"model": "x"}}, pulls={"7": pr(7, sha="bbb2222")})
    rc, _, err = tick(d, env)
    assert rc == 1 and "not a role" in err and calls(d) == [], (rc, err)


def test_factory_command_routes_manage_tick():
    d, env = project(pulls={"7": pr(7)}, comments={"7": ["<!-- factory-approved sha=abc1234 -->"]})
    os.symlink(os.path.join(SF, "hooks"), f"{d}/.claude/hooks")
    p = subprocess.run(["bash", FACTORY, "manage-tick"], cwd=d, env=env, capture_output=True, text=True)
    assert (p.returncode, p.stdout.strip()) == (0, "nothing to do"), (p.returncode, p.stdout, p.stderr)


if __name__ == "__main__":
    tests = [(k, v) for k, v in sorted(globals().items()) if k.startswith("test_")]
    for k, v in tests:
        v(); print("ok", k)
    print(f"{len(tests)} passed")
