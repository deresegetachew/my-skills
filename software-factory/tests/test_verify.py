#!/usr/bin/env python3
"""`factory verify` runs what CI runs (`commands.ci`) for the current commit and records a pass the PR gate needs
for `gh pr create` and `gh pr ready` (#58).  python3 software-factory/tests/test_verify.py"""
import json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
KIT = os.path.abspath(os.path.join(HERE, "..", "kit"))
HOOKS = os.path.join(KIT, ".claude", "hooks")
ENV = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
       "GIT_COMMITTER_EMAIL": "t@t"}


def git(d, *a):
    return subprocess.run(["git", *a], cwd=d, check=True, capture_output=True, text=True, env=ENV).stdout.strip()


def project(ci):
    d = tempfile.mkdtemp()
    git(d, "init", "-q", "-b", "main")
    os.makedirs(os.path.join(d, ".claude", "hooks"))
    for f in os.listdir(HOOKS):
        if f.endswith(".py"):
            os.symlink(os.path.join(HOOKS, f), os.path.join(d, ".claude", "hooks", f))
    json.dump({"commands": {"ci": ci}, "reviewMarkers": "tmp/reviews"}, open(os.path.join(d, ".claude", "factory.json"), "w"))
    open(os.path.join(d, ".gitignore"), "w").write("tmp/\nran\n")
    git(d, "add", "-A")
    git(d, "commit", "-qm", "start")
    git(d, "checkout", "-q", "-b", "task/1-x")
    return d


def verify(d):
    return subprocess.run(["bash", os.path.join(KIT, "factory"), "verify"], cwd=d, capture_output=True, text=True,
                          env=ENV, timeout=60)


def mark(d):
    p = os.path.join(d, "tmp", "reviews", "task_1-x.ci.ok")
    return open(p).read().strip() if os.path.exists(p) else None


def test_a_passing_run_records_this_commit():
    d = project("echo {base} > ran")
    p = verify(d)
    assert p.returncode == 0, p
    assert mark(d) == git(d, "rev-parse", "HEAD"), mark(d)
    assert open(os.path.join(d, "ran")).read().strip() == "origin/main", "{base} is origin/<main>"


def test_a_failing_run_records_nothing_and_shows_the_end_of_the_output():
    d = project("echo 'src/a.ts(9,1): error TS7022'; exit 1")
    p = verify(d)
    assert p.returncode == 1 and "error TS7022" in p.stderr, p
    assert mark(d) is None


def test_uncommitted_changes_are_refused():
    d = project("true")
    open(os.path.join(d, ".gitignore"), "a").write("more\n")
    p = verify(d)
    assert p.returncode == 1 and "commit your changes first" in p.stderr, p
    assert mark(d) is None


def test_without_commands_ci_there_is_nothing_to_run():
    d = project("")
    p = verify(d)
    assert p.returncode == 0 and "commands.ci" in p.stdout, p
    assert mark(d) is None


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
