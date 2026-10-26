#!/usr/bin/env python3
"""Incremental re-review (#70): a reviewer's second round reads only what changed since its last pass, with its own
earlier findings and the author's reply; a big or wide change, or a rewritten history, goes back to a full review.
The PR gate's marker is untouched. Ported to rereview.test.ts (#252); this case stays until factory_settings is
ported.  python3 software-factory/tests/test_rereview.py"""
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
