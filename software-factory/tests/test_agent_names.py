#!/usr/bin/env python3
"""Per-machine agent names (FACTORY_AGENTS, #48): `factory loop` on a second machine takes its own names.
python3 software-factory/tests/test_agent_names.py"""
import json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
CLAIMS = os.path.abspath(os.path.join(HERE, "..", "hooks", "factory_claims.py"))
ENV = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
       "GIT_COMMITTER_EMAIL": "t@t"}
for var in ("FACTORY_AGENT", "FACTORY_AGENTS", "FACTORY_LOOP", "CLAUDE_PROJECT_DIR"):
    ENV.pop(var, None)
NAMES = ["menelik", "taytu", "haile", "tewodros"]


def project():
    top = tempfile.mkdtemp()
    seed, origin, clone = (os.path.join(top, n) for n in ("seed", "origin.git", "proj"))
    subprocess.run(["git", "init", "-q", "-b", "main", seed], check=True, env=ENV)
    os.makedirs(os.path.join(seed, ".claude"))
    json.dump({"agents": NAMES}, open(os.path.join(seed, ".claude", "factory.json"), "w"))
    subprocess.run(["git", "-C", seed, "add", "-A"], check=True, env=ENV)
    subprocess.run(["git", "-C", seed, "commit", "-qm", "x"], check=True, env=ENV)
    subprocess.run(["git", "clone", "-q", "--bare", seed, origin], check=True, env=ENV)
    subprocess.run(["git", "clone", "-q", origin, clone], check=True, env=ENV)
    return clone


def a_loop():
    """A live process that looks like a factory loop to `ps` (a script named factory-loop.sh)."""
    d = tempfile.mkdtemp()
    script = os.path.join(d, "factory-loop.sh")
    open(script, "w").write("#!/bin/sh\nsleep 60\n")
    os.chmod(script, 0o755)
    # No pipes of ours inherited: the `sleep` this script leaves behind when killed must not keep a reader waiting.
    return subprocess.Popen([script], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def checkout(clone, agents=None):
    loop = a_loop()
    env = {**ENV, **({"FACTORY_AGENTS": agents} if agents is not None else {})}
    p = subprocess.run([sys.executable, CLAIMS, "checkout", "--pid", str(loop.pid)], cwd=clone, env=env,
                       capture_output=True, text=True)
    return p, loop


def test_this_machines_names_are_taken_in_order_with_their_own_folders():
    clone = project()
    loops = []
    try:
        p, l = checkout(clone, "haile,tewodros")
        loops.append(l)
        assert p.returncode == 0 and p.stdout.split()[0] == "haile", p
        assert p.stdout.split()[1].endswith("proj-agents/haile"), p.stdout
        p, l = checkout(clone, "haile, tewodros")
        loops.append(l)
        assert p.stdout.split()[0] == "tewodros", p
        p, l = checkout(clone, "haile,tewodros")
        loops.append(l)
        assert p.returncode != 0 and "FACTORY_AGENTS" in p.stderr, p
    finally:
        for l in loops:
            l.kill()


def test_an_unknown_name_is_refused():
    p, l = checkout(project(), "haile,nobody")
    l.kill()
    assert p.returncode != 0 and "nobody" in p.stderr and "FACTORY_AGENTS" in p.stderr, p


def test_without_the_setting_every_name_is_used_as_before():
    clone = project()
    p, l = checkout(clone)
    l.kill()
    assert p.returncode == 0 and p.stdout.split()[0] == "menelik", p


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
