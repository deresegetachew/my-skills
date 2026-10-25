#!/usr/bin/env python3
"""`factory run-check` and the quiet Stop check (#68): a pass prints a line, a failure prints a capped summary and
the log path, the full output is on disk, and the log never shows up as an untracked file.
  python3 software-factory/tests/test_run_check.py"""
import json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
HOOKS = os.path.abspath(os.path.join(HERE, "..", "hooks"))
ENV = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
       "GIT_COMMITTER_EMAIL": "t@t"}
for var in ("FACTORY_AGENT", "FACTORY_LOOP", "CLAUDECODE"):
    ENV.pop(var, None)


def project(test_cmd="true", extra=None):
    d = tempfile.mkdtemp()
    run = lambda *a: subprocess.run(["git", *a], cwd=d, check=True, capture_output=True, env=ENV)
    run("init", "-q", "-b", "main")
    os.makedirs(os.path.join(d, ".claude"))
    os.makedirs(os.path.join(d, "src"))
    json.dump({"codePaths": ["src"], "commands": {"test": test_cmd}, **(extra or {})},
              open(os.path.join(d, ".claude", "factory.json"), "w"))
    open(os.path.join(d, "src", "a.ts"), "w").write("one\n")
    run("add", "-A")
    run("commit", "-qm", "start")
    return d


def run_check(d, *args):
    return subprocess.run([sys.executable, os.path.join(HOOKS, "factory_run_check.py"), *args], cwd=d,
                          capture_output=True, text=True, env={**ENV, "CLAUDE_PROJECT_DIR": d})


NOISY_PASS = "for i in $(seq 1 500); do echo \"PASS test $i\"; done"
NOISY_FAIL = ("for i in $(seq 1 300); do echo \"PASS test $i\"; done; echo 'FAIL src/a.test.ts:12:3 expected 1'; "
              "for i in $(seq 1 300); do echo \"noise $i\"; done; exit 1")


def test_a_passing_run_prints_one_line_and_keeps_the_log():
    d = project()
    r = run_check(d, "--name", "unit", NOISY_PASS)
    assert r.returncode == 0
    assert len(r.stdout.strip().splitlines()) == 1 and "tmp/checks/unit.log" in r.stdout
    assert r.stderr == ""
    assert open(os.path.join(d, "tmp/checks/unit.log")).read().count("\nPASS test") == 500


def test_a_failing_run_prints_the_failure_capped_and_the_log_path():
    d = project()
    r = run_check(d, "--name", "unit", "--lines", "10", NOISY_FAIL)
    assert r.returncode == 1
    lines = r.stderr.strip().splitlines()
    assert len(lines) <= 12, len(lines)
    assert "FAIL src/a.test.ts:12:3 expected 1" in r.stderr
    assert "tmp/checks/unit.log" in r.stderr
    assert "noise 300" in open(os.path.join(d, "tmp/checks/unit.log")).read()


def test_the_exit_code_is_the_commands_own():
    d = project()
    assert run_check(d, "exit 3").returncode == 3


def test_the_log_is_not_an_untracked_file():
    d = project()
    run_check(d, NOISY_PASS)
    status = subprocess.run(["git", "status", "--porcelain", "--untracked-files=all"], cwd=d, capture_output=True,
                            text=True).stdout
    assert status == "", status


def test_check_log_dir_setting_moves_the_log():
    d = project(extra={"checkLogDir": "logs/out"})
    run_check(d, "--name", "x", "true")
    assert os.path.exists(os.path.join(d, "logs/out/x.log"))


def test_no_command_is_a_usage_error():
    assert run_check(project()).returncode == 2


def test_the_stop_check_names_the_log_and_stays_capped():
    d = project(test_cmd=NOISY_FAIL, extra={"checkOutputLines": 10})
    open(os.path.join(d, "src", "a.ts"), "w").write("two\n")
    r = subprocess.run([sys.executable, os.path.join(HOOKS, "check.py")], cwd=d, input="{}", capture_output=True,
                       text=True, env={**ENV, "CLAUDE_PROJECT_DIR": d})
    assert r.returncode == 2
    assert "FAIL src/a.test.ts:12:3" in r.stderr and "Full log: tmp/checks/test.log" in r.stderr.splitlines()[0]
    assert len(r.stderr.strip().splitlines()) <= 12
    assert os.path.exists(os.path.join(d, "tmp/checks/test.log"))


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
