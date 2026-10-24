#!/usr/bin/env python3
"""`factory agent <name>` with nothing else to do says that the queue runs better in `factory loop -i`, which gives
each task a fresh context (#56). With a prompt or other arguments it stays quiet.
  python3 software-factory/tests/test_agent_hint.py"""
import json, os, subprocess, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
KIT = os.path.abspath(os.path.join(HERE, "..", "kit"))
HOOKS = os.path.join(KIT, ".claude", "hooks")
HINT = "factory loop -i"


def project():
    d = tempfile.mkdtemp()
    work = os.path.join(d, "proj")
    git = lambda *a: subprocess.run(["git", *a], cwd=work, check=True, capture_output=True)
    os.makedirs(os.path.join(work, ".claude", "hooks"))
    git("init", "-q", "-b", "main")
    for f in os.listdir(HOOKS):
        if f.endswith(".py"):
            os.symlink(os.path.join(HOOKS, f), os.path.join(work, ".claude", "hooks", f))
    json.dump({"hooks": {}}, open(os.path.join(work, ".claude", "settings.json"), "w"))
    json.dump({"agents": ["menelik", "taytu"]}, open(os.path.join(work, ".claude", "factory.json"), "w"))
    git("add", "-A")
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "start")
    bin_ = os.path.join(d, "bin")
    os.makedirs(bin_)
    open(os.path.join(bin_, "claude"), "w").write("#!/bin/sh\necho CLAUDE STARTED\n")
    os.chmod(os.path.join(bin_, "claude"), 0o755)
    env = {**os.environ, "PATH": bin_ + os.pathsep + os.environ["PATH"], "FACTORY_REMOTE_CONTROL": "0"}
    for k in ("FACTORY_AGENT", "FACTORY_AGENTS", "FACTORY_LOOP", "CLAUDE_PROJECT_DIR"):
        env.pop(k, None)
    return work, env


def agent(*args):
    work, env = project()
    return subprocess.run(["bash", os.path.join(KIT, "factory"), "agent", *args], cwd=work, env=env,
                          capture_output=True, text=True, timeout=60)


def test_a_bare_agent_session_points_at_the_loop_for_the_queue():
    p = agent("menelik")
    assert p.returncode == 0 and "CLAUDE STARTED" in p.stdout, p
    hint = [l for l in (p.stdout + p.stderr).splitlines() if HINT in l]
    assert len(hint) == 1, p  # one line, not a lecture
    assert "fresh" in hint[0], hint


def test_an_agent_session_with_arguments_starts_without_the_hint():
    p = agent("menelik", "fix the flaky test in packages/x")
    assert p.returncode == 0 and "CLAUDE STARTED" in p.stdout, p
    assert HINT not in p.stdout + p.stderr, p


def test_no_name_says_how_to_use_it_and_mentions_the_loop():
    p = agent()
    assert p.returncode != 0 and "CLAUDE STARTED" not in p.stdout, p
    assert "factory agent <name|N>" in p.stderr and HINT in p.stderr, p



def test_help_keeps_each_entry_together_and_nothing_recommends_loop_in_one_session():
    out = subprocess.run(["bash", os.path.join(KIT, "factory"), "help"], cwd=project()[0], capture_output=True,
                         text=True).stdout.splitlines()
    for start, follow in (("  loop [-i] [N]", "which closes by itself"), ("  agent <name|N>", "To run the queue")):
        i = next(n for n, l in enumerate(out) if l.startswith(start))
        assert follow in out[i + 1], out[i:i + 3]
    session = open(os.path.join(HOOKS, "factory_session.py")).read().split('"""')[1]
    assert "then `/loop /next-task all`" not in session and "factory loop -i" in session, session

if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
