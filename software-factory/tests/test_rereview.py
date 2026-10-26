#!/usr/bin/env python3
"""Incremental re-review (#70): a reviewer's second round reads only what changed since its last pass, with its own
earlier findings and the author's reply; a big or wide change, or a rewritten history, goes back to a full review.
The PR gate's marker is untouched. Ported to rereview.test.ts (#252); these two cases stay until pr-gate and
factory_settings are ported.  python3 software-factory/tests/test_rereview.py"""
import json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SF = os.path.abspath(os.path.join(HERE, ".."))
HOOKS = os.path.join(SF, "hooks")
SCRIPT = os.path.join(HOOKS, "factory_rereview.ts")
ENV = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
       "GIT_COMMITTER_EMAIL": "t@t", "PYTHONDONTWRITEBYTECODE": "1"}
ENV.pop("CLAUDE_PROJECT_DIR", None)

BIG = "".join(f"line {i} of the first file\n" for i in range(100))


def git(d, *a):
    return subprocess.run(["git", *a], cwd=d, check=True, capture_output=True, text=True, env=ENV).stdout.strip()


def write(d, name, text):
    p = os.path.join(d, name)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, "w").write(text)


def commit(d, msg):
    git(d, "add", "-A")
    git(d, "commit", "-qm", msg)
    return git(d, "rev-parse", "HEAD")


def project(settings=None):
    """main with two files, then a task branch with a 100-line change in a.py and a small one in b.py."""
    d = tempfile.mkdtemp()
    git(d, "init", "-q", "-b", "main")
    os.makedirs(os.path.join(d, ".claude"))
    json.dump({"reviewMarkers": "tmp/reviews", **(settings or {})}, open(os.path.join(d, ".claude", "factory.json"), "w"))
    write(d, ".gitignore", "tmp/\n__pycache__/\n")
    write(d, "src/a.py", "print('a')\n")
    write(d, "src/b.py", "print('b')\n")
    commit(d, "start")
    git(d, "checkout", "-qb", "task/70-x")
    write(d, "src/a.py", BIG)
    write(d, "src/b.py", "print('b')\nprint('more b')\n")
    commit(d, "the task")
    return d


def run(d, *args):
    p = subprocess.run(["bun", "--no-env-file", SCRIPT, "--base", "main", *args], cwd=d, capture_output=True, text=True, env=ENV)
    return p.returncode, p.stdout, p.stderr


def plan(d, kind="reviewer"):
    rc, out, err = run(d, "plan", "--kind", kind)
    assert rc == 0, err
    return json.loads(out)


def record(d, result="fail", findings="must-fix: src/b.py line 2 prints the wrong text", kind="reviewer"):
    rc, out, err = run(d, "record", "--kind", kind, "--result", result, "--findings", findings)
    assert rc == 0, err


def test_a_final_pass_on_head_after_a_delta_review_still_satisfies_the_gate():
    """The marker is the one the gate reads: HEAD's id and nothing else, however the review was done."""
    d = project()
    record(d)
    write(d, "src/b.py", "print('b')\nprint('right text')\n")
    head = commit(d, "fix")
    assert plan(d)["mode"] == "delta"
    record(d, result="pass", findings="no must-fix")
    marker = os.path.join(d, "tmp", "reviews", "task_70-x.ok")
    open(marker, "w").write(git(d, "rev-parse", "HEAD") + "\n")  # what the reviewer's snippet writes
    spec = __import__("importlib.util").util.spec_from_file_location("gate", os.path.join(HOOKS, "pr-gate.py"))
    gate = __import__("importlib.util").util.module_from_spec(spec)
    sys.path.insert(0, HOOKS)
    spec.loader.exec_module(gate)
    cwd = os.getcwd()
    os.chdir(d)
    try:
        assert gate.passed({"reviewMarkers": "tmp/reviews"}, "task/70-x", head)
        write(d, "src/b.py", "print('b')\n")
        newer = commit(d, "later")
        assert not gate.passed({"reviewMarkers": "tmp/reviews"}, "task/70-x", newer)  # a new commit needs a new review
    finally:
        os.chdir(cwd)


def test_the_setting_is_known_and_the_forwarder_exists():
    sys.path.insert(0, HOOKS)
    import factory_settings
    assert "reReviewPercent" in factory_settings.SETTINGS and factory_settings.default_of("reReviewPercent") == 30
    # (the forwarder and the factory command: rereview.test.ts, #252)


if __name__ == "__main__":
    bad = 0
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            try:
                v()
                print("ok", k)
            except Exception as e:
                bad += 1
                print("FAIL", k, repr(e))
    sys.exit(1 if bad else 0)
