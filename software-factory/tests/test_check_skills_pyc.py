#!/usr/bin/env python3
"""tools/check_skills.py fails when a compiled .pyc file is tracked by git (#158), and passes when it is not.
  python3 software-factory/tests/test_check_skills_pyc.py"""
import os, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
CHECK = os.path.abspath(os.path.join(HERE, "..", "..", "tools", "check_skills.py"))
ENV = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
       "GIT_COMMITTER_EMAIL": "t@t"}


def git(d, *a):
    subprocess.run(["git", *a], cwd=d, check=True, capture_output=True, env=ENV)


def repo(tracked_pyc):
    """A repo with one valid skill, and optionally a committed .pyc under it."""
    d = tempfile.mkdtemp()
    git(d, "init", "-q", "-b", "main")
    os.makedirs(os.path.join(d, "tools"))
    shutil.copy(CHECK, os.path.join(d, "tools", "check_skills.py"))
    os.makedirs(os.path.join(d, "demo", "__pycache__"))
    open(os.path.join(d, "demo", "SKILL.md"), "w").write("---\nname: demo\ndescription: A demo.\n---\n")
    if tracked_pyc:
        open(os.path.join(d, "demo", "__pycache__", "x.cpython-313.pyc"), "wb").write(b"\0")
    git(d, "add", "-f", "-A")
    git(d, "commit", "-qm", "start")
    return d


def run(d):
    return subprocess.run([sys.executable, os.path.join(d, "tools", "check_skills.py")], cwd=d,
                          capture_output=True, text=True)


def test_tracked_pyc_fails():
    r = run(repo(True))
    assert r.returncode == 1, r.stdout + r.stderr
    assert "x.cpython-313.pyc" in r.stdout and "git rm --cached" in r.stdout, r.stdout


def test_untracked_pyc_passes():
    d = repo(False)
    open(os.path.join(d, "demo", "__pycache__", "y.pyc"), "wb").write(b"\0")  # on disk, not tracked
    r = run(d)
    assert r.returncode == 0, r.stdout + r.stderr


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
