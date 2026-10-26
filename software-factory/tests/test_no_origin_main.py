#!/usr/bin/env python3
"""A clone of an empty repo has no fetch refspec, so no origin/main (#181). `factory doctor` says so (the claims hook's
check is in no_origin_main.test.ts, #252).  python3 software-factory/tests/test_no_origin_main.py"""
import json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SF = os.path.abspath(os.path.join(HERE, ".."))
HOOKS = os.path.join(SF, "hooks")
FIX = "git config --add remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*' && git fetch origin"


def sh(*a, cwd=None):
    subprocess.run(a, cwd=cwd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def clone_without_refspec():
    d = tempfile.mkdtemp()
    origin, work = os.path.join(d, "origin.git"), os.path.join(d, "work")
    sh("git", "init", "-q", "--bare", "-b", "main", origin)
    sh("git", "init", "-q", "-b", "main", work)
    sh("git", "remote", "add", "origin", origin, cwd=work)
    sh("git", "config", "--unset-all", "remote.origin.fetch", cwd=work)  # what cloning an empty repo leaves
    os.makedirs(os.path.join(work, ".claude"))
    json.dump({"agents": ["menelik", "taytu"]}, open(os.path.join(work, ".claude", "factory.json"), "w"))
    open(os.path.join(work, "a.txt"), "w").write("x")
    sh("git", "add", "-A", cwd=work)
    sh("git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "first", cwd=work)
    sh("git", "push", "-q", "origin", "main", cwd=work)  # pushed, but nothing tracks it
    return work


def test_doctor_names_the_missing_origin_main():
    work = clone_without_refspec()
    sys.path.insert(0, HOOKS)
    os.environ["CLAUDE_PROJECT_DIR"] = work
    os.chdir(work)
    import factory_doctor as fd

    class R:
        def __init__(self): self.lines = []
        def ok(self, what): self.lines.append(("ok", what))
        def fix(self, what, how): self.lines.append(("fix", what, how))
        def note(self, what, how): self.lines.append(("note", what, how))
    r = R()
    fd.origin_main(r, {"mainBranch": "main"})
    assert r.lines and r.lines[0][0] == "fix" and "no-origin-main" in r.lines[0][1] and FIX in r.lines[0][2], r.lines
    sh("git", "config", "--add", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*", cwd=work)
    sh("git", "fetch", "-q", "origin", cwd=work)
    r = R()
    fd.origin_main(r, {"mainBranch": "main"})
    assert r.lines[0][0] == "ok", r.lines


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
