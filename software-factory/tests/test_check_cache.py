#!/usr/bin/env python3
"""The Stop check skips a rerun when nothing changed since its last green run (#61): same HEAD, same changes under
`codePaths` (tracked and untracked) and the same commands. A failure is never remembered.
  python3 software-factory/tests/test_check_cache.py"""
import json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
CHECK = os.path.abspath(os.path.join(HERE, "..", "hooks", "check.py"))
ENV = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
       "GIT_COMMITTER_EMAIL": "t@t"}
for var in ("FACTORY_AGENT", "FACTORY_LOOP", "CLAUDECODE"):
    ENV.pop(var, None)


def git(d, *a):
    subprocess.run(["git", *a], cwd=d, check=True, capture_output=True, env=ENV)


def project(exit_code=0):
    """A repo with one committed file under src/, and a test command that logs each run outside the repo."""
    d = tempfile.mkdtemp()
    log = os.path.join(tempfile.mkdtemp(), "runs")
    git(d, "init", "-q", "-b", "main")
    os.makedirs(os.path.join(d, ".claude"))
    os.makedirs(os.path.join(d, "src"))
    cfg = {"codePaths": ["src"], "commands": {"test": f"echo run >> '{log}'; exit {exit_code}"}}
    json.dump(cfg, open(os.path.join(d, ".claude", "factory.json"), "w"))
    open(os.path.join(d, "src", "a.ts"), "w").write("one\n")
    git(d, "add", "-A")
    git(d, "commit", "-qm", "start")
    return d, log


def stop(d):
    return subprocess.run([sys.executable, CHECK], cwd=d, input="{}", capture_output=True, text=True,
                          env={**ENV, "CLAUDE_PROJECT_DIR": d})


def runs(log):
    return len(open(log).read().splitlines()) if os.path.exists(log) else 0


def write(d, path, text):
    open(os.path.join(d, path), "w").write(text)


def test_a_second_stop_with_no_new_changes_skips_the_check():
    d, log = project()
    write(d, "src/a.ts", "two\n")
    assert stop(d).returncode == 0 and runs(log) == 1
    assert stop(d).returncode == 0 and runs(log) == 1, "nothing changed since the green run"


def test_a_new_edit_after_a_green_check_runs_it_again():
    d, log = project()
    write(d, "src/a.ts", "two\n")
    stop(d)
    write(d, "src/a.ts", "three\n")
    assert stop(d).returncode == 0 and runs(log) == 2


def test_an_edited_untracked_file_runs_it_again():
    d, log = project()
    write(d, "src/new.ts", "x\n")
    stop(d)
    write(d, "src/new.ts", "y\n")
    stop(d)
    assert runs(log) == 2


def test_a_new_commit_runs_it_again_even_with_the_same_working_tree_change():
    d, log = project()
    write(d, "src/b.ts", "b\n")
    stop(d)
    write(d, "notes.txt", "outside codePaths\n")
    git(d, "add", "notes.txt")
    git(d, "commit", "-qm", "another")
    stop(d)
    assert runs(log) == 2


def test_changed_commands_run_it_again():
    d, log = project()
    write(d, "src/a.ts", "two\n")
    stop(d)
    cfg = json.load(open(os.path.join(d, ".claude", "factory.json")))
    cfg["commands"]["typecheck"] = f"echo run >> '{log}'"
    json.dump(cfg, open(os.path.join(d, ".claude", "factory.json"), "w"))
    stop(d)
    assert runs(log) == 3, "typecheck and test both ran"


def test_a_change_outside_code_paths_runs_it_again():
    # A root tsconfig.json, package.json or lockfile changes the result too (dev manager, #81).
    d, log = project()
    write(d, "tsconfig.json", "good\n")
    git(d, "add", "tsconfig.json")
    git(d, "commit", "-qm", "config")
    write(d, "src/a.ts", "two\n")
    stop(d)
    write(d, "tsconfig.json", "broken\n")
    stop(d)
    assert runs(log) == 2, "a tracked change outside codePaths must rerun"
    write(d, "vitest.config.ts", "new\n")  # untracked, outside codePaths
    stop(d)
    assert runs(log) == 3


def test_a_new_install_runs_it_again():
    d, log = project()
    cfg = json.load(open(os.path.join(d, ".claude", "factory.json")))
    json.dump({**cfg, "checkRequires": ["node_modules"]}, open(os.path.join(d, ".claude", "factory.json"), "w"))
    open(os.path.join(d, ".gitignore"), "w").write("node_modules/\n")
    git(d, "add", "-A")
    git(d, "commit", "-qm", "ignore")
    os.makedirs(os.path.join(d, "node_modules"))
    write(d, "src/a.ts", "two\n")
    stop(d)
    t = os.stat(os.path.join(d, "node_modules")).st_mtime + 5
    os.utime(os.path.join(d, "node_modules"), (t, t))  # `pnpm install` touched it
    stop(d)
    assert runs(log) == 2


def test_a_failing_check_is_never_skipped():
    d, log = project(exit_code=1)
    write(d, "src/a.ts", "two\n")
    assert stop(d).returncode == 2
    assert stop(d).returncode == 2 and runs(log) == 2


def test_the_remembered_check_lives_in_the_git_folder_not_the_working_tree():
    d, log = project()
    write(d, "src/a.ts", "two\n")
    stop(d)
    status = subprocess.run(["git", "status", "--porcelain"], cwd=d, capture_output=True, text=True).stdout
    assert status.split() == ["M", "src/a.ts"], status


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
