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


# GitHub's copy of main's settings, which verify uses (#83 review). Without one, gh can't reach GitHub.
FAKE_GH = r'''#!/usr/bin/env python3
import os, sys
main = os.environ.get("MAIN_SETTINGS")
if not main:
    sys.exit("gh: could not connect to api.github.com")
if sys.argv[1:3] == ["repo", "view"]:
    print("main"); sys.exit(0)
if sys.argv[1:2] == ["api"] and "/contents/.claude/factory.json" in " ".join(sys.argv):
    print(open(main).read()); sys.exit(0)
sys.exit("fake gh: no answer for " + " ".join(sys.argv[1:]))
'''


def project(ci, main=None):
    """A task branch whose factory.json sets commands.ci to `ci`; `main`: the settings GitHub has on main."""
    top = tempfile.mkdtemp()
    d, bin_ = os.path.join(top, "proj"), os.path.join(top, "bin")
    os.makedirs(bin_)
    open(os.path.join(bin_, "gh"), "w").write(FAKE_GH)
    os.chmod(os.path.join(bin_, "gh"), 0o755)
    if main is not None:
        json.dump(main, open(os.path.join(top, "main.json"), "w"))
    os.makedirs(d)
    git(d, "init", "-q", "-b", "main")
    os.makedirs(os.path.join(d, ".claude", "hooks"))
    for f in os.listdir(HOOKS):
        if f.endswith(".py"):
            os.symlink(os.path.join(HOOKS, f), os.path.join(d, ".claude", "hooks", f))
    json.dump({"commands": {"ci": ci}, "reviewMarkers": "tmp/reviews"}, open(os.path.join(d, ".claude", "factory.json"), "w"))
    open(os.path.join(d, ".gitignore"), "w").write("tmp/\n__pycache__/\nran\n")  # as install.sh writes it
    git(d, "add", "-A")
    git(d, "commit", "-qm", "start")
    git(d, "checkout", "-q", "-b", "task/1-x")
    return d


def verify(d):
    top = os.path.dirname(d)
    main = os.path.join(top, "main.json")
    env = {**ENV, "PATH": os.path.join(top, "bin") + os.pathsep + ENV["PATH"],
           "MAIN_SETTINGS": main if os.path.exists(main) else ""}
    env.pop("CLAUDE_PROJECT_DIR", None)
    return subprocess.run(["bash", os.path.join(KIT, "factory"), "verify"], cwd=d, capture_output=True, text=True,
                          env=env, timeout=60)


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



def test_an_untracked_file_is_refused():
    # The pass would be for a commit that doesn't have the file that made it pass (#83 review).
    d = project("test -f src/new.ts")
    os.makedirs(os.path.join(d, "src"))
    open(os.path.join(d, "src", "new.ts"), "w").write("x\n")
    p = verify(d)
    assert p.returncode == 1 and "commit your changes first" in p.stderr and "src/new.ts" in p.stderr, p
    assert mark(d) is None


def test_it_runs_mains_command_not_the_branchs():
    # A branch cut before main set commands.ci (or one that changed it) still runs what the gate requires.
    main = {"commands": {"ci": "echo main > ran"}, "reviewMarkers": "tmp/reviews"}
    d = project("", main=main)
    p = verify(d)
    assert p.returncode == 0, p
    assert open(os.path.join(d, "ran")).read().strip() == "main" and mark(d) == git(d, "rev-parse", "HEAD"), p
    d = project("echo branch > ran", main=main)
    assert verify(d).returncode == 0 and open(os.path.join(d, "ran")).read().strip() == "main"


def test_without_github_it_falls_back_to_the_worktrees_settings_and_says_so():
    d = project("echo local > ran")
    p = verify(d)
    assert p.returncode == 0 and open(os.path.join(d, "ran")).read().strip() == "local", p
    assert "can't read main's settings" in p.stderr, p

if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
