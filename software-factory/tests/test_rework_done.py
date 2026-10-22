#!/usr/bin/env python3
"""After rework on a PR, an interactive agent marks it done so its session closes and the loop goes on.
  python3 software-factory/tests/test_rework_done.py"""
import json, os, re, subprocess, sys, tempfile

KIT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "kit"))
HOOKS = os.path.join(KIT, ".claude", "hooks")
SKILL = os.path.join(KIT, ".claude", "skills", "next-task", "SKILL.md")


def claims(cwd, *args):
    p = subprocess.run([sys.executable, os.path.join(HOOKS, "factory_claims.py"), *args], cwd=cwd,
                       capture_output=True, text=True)
    assert p.returncode == 0, p.stderr
    return p.stdout.strip()


def test_a_rework_mark_is_seen_by_the_loop():
    d = tempfile.mkdtemp()
    subprocess.run(["git", "init", "-q", d], check=True)
    os.makedirs(os.path.join(d, ".claude"))
    json.dump({"agents": ["taytu"]}, open(os.path.join(d, ".claude", "factory.json"), "w"))
    claims(d, "done", "--agent", "taytu", "--task", "pr-118")
    assert claims(d, "take-done", "--agent", "taytu") == "pr-118"  # the loop: finished, count down, go on
    assert claims(d, "take-done", "--agent", "taytu") == ""  # taken once


def test_the_rework_step_tells_an_interactive_agent_to_mark_it_done():
    text = open(SKILL).read()
    rework = text.split("## 1b. Rework a reviewed PR", 1)[1].split("\n## ", 1)[0]
    assert "FACTORY_INTERACTIVE=1" in rework, rework
    assert re.search(r"factory_claims\.py done --agent \"\$FACTORY_AGENT\" --task pr-<n>", rework), rework


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
