#!/usr/bin/env python3
"""Auto-format and auto-fix the changed files before the checks (#69): `commands.fix` runs on the files this branch
changed and no others, the agent hears one line, the Stop check and `factory verify` run it first.
  python3 software-factory/tests/test_fix.py"""
import json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SF = os.path.abspath(os.path.join(HERE, ".."))
HOOKS = os.path.join(SF, "hooks")
ENV = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
       "GIT_COMMITTER_EMAIL": "t@t"}
for var in ("FACTORY_AGENT", "FACTORY_LOOP", "CLAUDECODE", "CLAUDE_PROJECT_DIR"):
    ENV.pop(var, None)

# The "formatter": strips trailing spaces from the files it is given, and logs which files it was given.
FORMATTER = '''import sys
with open("fixer.log", "a") as log:
    log.write(" ".join(sys.argv[1:]) + "\\n")
for name in sys.argv[1:]:
    text = open(name).read()
    open(name, "w").write("".join(l.rstrip() + "\\n" for l in text.splitlines()))
'''
FAKE_GH = r'''#!/usr/bin/env python3
import os, sys
if sys.argv[1:3] == ["repo", "view"]:
    print("main"); sys.exit(0)
if sys.argv[1:2] == ["api"]:
    print(open(os.environ["MAIN_SETTINGS"]).read()); sys.exit(0)
sys.exit("fake gh")
'''


def git(d, *a):
    return subprocess.run(["git", *a], cwd=d, check=True, capture_output=True, text=True, env=ENV).stdout.strip()


def put(d, rel, text):
    os.makedirs(os.path.dirname(os.path.join(d, rel)), exist_ok=True)
    open(os.path.join(d, rel), "w").write(text)


def project(fix="python3 fmt.py {files}", extra=None, commands=None):
    """Main holds untidy.ts (untidy on purpose) and a clean tree; the task branch starts from it."""
    top = tempfile.mkdtemp()
    d = os.path.join(top, "proj")
    os.makedirs(d)
    git(d, "init", "-q", "-b", "main")
    cfg = {"codePaths": ["src"], "commands": {"fix": fix, "test": "true", **(commands or {})}, **(extra or {})}
    put(d, ".claude/factory.json", json.dumps(cfg))
    os.makedirs(os.path.join(d, ".claude", "hooks"))
    for f in os.listdir(HOOKS):  # as a project that links the kit has them
        if f.endswith(".py"):
            os.symlink(os.path.join(HOOKS, f), os.path.join(d, ".claude", "hooks", f))
    put(d, "fmt.py", FORMATTER)
    put(d, ".gitignore", "tmp/\nfixer.log\n.claude/hooks/\n__pycache__/\n")
    put(d, "src/untidy.ts", "unrelated   \n")
    git(d, "add", "-A")
    git(d, "commit", "-qm", "start")
    git(d, "checkout", "-q", "-b", "task/1-x")
    return d


def fix(d, *args):
    return subprocess.run([sys.executable, os.path.join(HOOKS, "factory_fix.py"), *args], cwd=d,
                          capture_output=True, text=True, env={**ENV, "CLAUDE_PROJECT_DIR": d})


def fixed_files(d):
    p = os.path.join(d, "fixer.log")
    return open(p).read().split() if os.path.exists(p) else []


def test_only_files_changed_on_the_branch_are_touched():
    d = project()
    put(d, "src/a.ts", "committed   \n")
    git(d, "add", "-A"); git(d, "commit", "-qm", "a")           # committed on the branch
    put(d, "src/b.ts", "new file   \n")                          # untracked
    put(d, "src/c.ts", "x\n"); git(d, "add", "-A"); git(d, "commit", "-qm", "c")
    put(d, "src/c.ts", "edited   \n")                            # edited after the commit
    r = fix(d)
    assert r.returncode == 0, r.stderr
    assert sorted(fixed_files(d)) == ["src/a.ts", "src/b.ts", "src/c.ts"], fixed_files(d)
    assert open(os.path.join(d, "src/untidy.ts")).read() == "unrelated   \n", "an unchanged file must not churn"
    assert open(os.path.join(d, "src/a.ts")).read() == "committed\n"


def test_the_agent_hears_one_line_and_no_diff():
    d = project()
    put(d, "src/a.ts", "one  \n"); put(d, "src/b.ts", "two  \n"); put(d, "src/ok.ts", "fine\n")
    r = fix(d)
    assert r.stdout.strip() == "formatted 2 files", r
    assert r.stderr == ""
    put(d, "src/a.ts", "one  \n")
    assert fix(d).stdout.strip() == "formatted 1 file"


def test_nothing_changed_means_nothing_runs_and_nothing_is_said():
    d = project()
    r = fix(d)
    assert r.returncode == 0 and r.stdout.strip() == "nothing to format", r
    assert fixed_files(d) == []


def test_without_commands_fix_it_does_nothing_and_says_how_to_set_it():
    d = project(fix="")
    put(d, "src/a.ts", "x  \n")
    r = fix(d)
    assert r.returncode == 0 and "commands.fix isn't set" in r.stdout and "{files}" in r.stdout
    assert open(os.path.join(d, "src/a.ts")).read() == "x  \n"


def test_deleted_files_and_fixpaths_are_respected():
    d = project(extra={"fixPaths": [r"\.ts$"]})
    put(d, "src/a.ts", "a  \n"); put(d, "notes.md", "md  \n")
    git(d, "rm", "-q", "src/untidy.ts")
    fix(d)
    assert fixed_files(d) == ["src/a.ts"], fixed_files(d)


def test_file_names_with_spaces_are_quoted_and_the_list_is_appended_without_a_placeholder():
    d = project(fix="python3 fmt.py")
    put(d, "src/my file.ts", "x  \n")
    r = fix(d)
    assert r.returncode == 0 and r.stdout.strip() == "formatted 1 file", r
    assert open(os.path.join(d, "src/my file.ts")).read() == "x\n"


def test_a_long_list_runs_in_chunks():
    d = project()
    for i in range(250):
        put(d, f"src/f{i}.ts", "x  \n")
    r = fix(d)
    assert r.stdout.strip() == "formatted 250 files", r
    assert len(open(os.path.join(d, "fixer.log")).read().splitlines()) == 3


def test_a_failing_fixer_shows_the_capped_findings_and_the_log_path():
    noisy = "for i in $(seq 1 300); do echo \"noise $i\"; done; echo 'src/a.ts:3:1 error unfixable rule'; exit 1"
    d = project(fix=noisy, extra={"checkOutputLines": 10})
    put(d, "src/a.ts", "x\n")
    r = fix(d)
    assert r.returncode == 1
    assert len(r.stderr.strip().splitlines()) <= 14 and "src/a.ts:3:1 error unfixable rule" in r.stderr
    assert "tmp/checks/fix.log" in r.stderr


def stop(d):
    return subprocess.run([sys.executable, os.path.join(HOOKS, "check.py")], cwd=d, input="{}", capture_output=True,
                          text=True, env={**ENV, "CLAUDE_PROJECT_DIR": d})


def test_the_stop_check_formats_before_the_tests_run_and_says_so():
    # the test command fails on any trailing space, so it passes only if the fixer ran first
    d = project(commands={"test": "! grep -rn ' $' src/a.ts"})
    put(d, "src/a.ts", "sloppy  \n")
    r = stop(d)
    assert r.returncode == 0, r
    assert json.loads(r.stdout)["systemMessage"] == "factory: formatted 1 file."
    assert open(os.path.join(d, "src/a.ts")).read() == "sloppy\n"


def test_the_stop_check_carries_the_note_into_a_test_failure():
    d = project(commands={"test": "echo 'FAIL src/a.ts:1:1 expected 1'; exit 1"})
    put(d, "src/a.ts", "sloppy  \n")
    r = stop(d)
    assert r.returncode == 2 and "(formatted 1 file.)" in r.stderr and "FAIL src/a.ts:1:1" in r.stderr, r


def test_the_stop_check_sends_unfixable_findings_back_as_a_failure():
    d = project(fix="echo 'src/a.ts:1:1 no-undef'; exit 1")
    put(d, "src/a.ts", "x\n")
    r = stop(d)
    assert r.returncode == 2 and "no-undef" in r.stderr, r


def test_the_stop_check_is_quiet_when_there_is_nothing_to_format():
    d = project()
    put(d, "src/a.ts", "tidy\n")
    r = stop(d)
    assert r.returncode == 0 and r.stdout == "" and r.stderr == "", r


def verify(d, ci="true"):
    top = os.path.dirname(d)
    os.makedirs(os.path.join(top, "bin"), exist_ok=True)
    gh = os.path.join(top, "bin", "gh")
    open(gh, "w").write(FAKE_GH); os.chmod(gh, 0o755)
    main = os.path.join(top, "main.json")
    json.dump({"commands": {"ci": ci, "fix": "python3 fmt.py {files}"}, "reviewMarkers": "tmp/reviews"}, open(main, "w"))
    env = {**ENV, "PATH": os.path.join(top, "bin") + os.pathsep + ENV["PATH"], "MAIN_SETTINGS": main}
    return subprocess.run(["bash", os.path.join(SF, "factory"), "verify"], cwd=d, capture_output=True, text=True,
                          env=env, timeout=60)


def test_verify_refuses_when_the_fixer_changed_files_then_passes_once_they_are_committed():
    d = project()
    put(d, "src/a.ts", "sloppy  \n")
    git(d, "add", "-A"); git(d, "commit", "-qm", "work")
    p = verify(d)
    assert p.returncode == 1 and "formatted 1 file" in p.stderr and "Commit them" in p.stderr, p
    assert not os.path.exists(os.path.join(d, "tmp/reviews/task_1-x.ci.ok"))
    git(d, "add", "-A"); git(d, "commit", "-qm", "format")
    p = verify(d)
    assert p.returncode == 0 and "passed" in p.stdout, p


def test_the_factory_command_runs_it():
    d = project()
    put(d, "src/a.ts", "x  \n")
    p = subprocess.run(["bash", os.path.join(SF, "factory"), "fix"], cwd=d, capture_output=True, text=True, env=ENV)
    assert p.returncode == 0 and p.stdout.strip() == "formatted 1 file", p


def test_reviewers_are_told_not_to_comment_on_what_the_fixer_handles():
    for name in ("reviewer", "architecture-reviewer"):
        text = open(os.path.join(SF, "kit", ".claude", "agents", name + ".md")).read()
        assert "Formatting is not your job" in text and "commands.fix" in text, name


def test_the_fix_settings_are_listed_in_the_template_and_the_registry():
    tpl = json.load(open(os.path.join(SF, "kit", ".claude", "factory.json")))
    assert tpl["commands"]["fix"] == "" and tpl["fixPaths"] == []
    out = subprocess.run([sys.executable, os.path.join(HOOKS, "factory_settings.py")], cwd=tempfile.mkdtemp(),
                         capture_output=True, text=True, env=ENV).stdout
    assert "commands.fix" in out and "fixPaths" in out
