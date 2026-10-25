#!/usr/bin/env python3
"""Incremental re-review (#70): a reviewer's second round reads only what changed since its last pass, with its own
earlier findings and the author's reply; a big or wide change, or a rewritten history, goes back to a full review.
The PR gate's marker is untouched.  python3 software-factory/tests/test_rereview.py"""
import json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SF = os.path.abspath(os.path.join(HERE, ".."))
HOOKS = os.path.join(SF, "hooks")
SCRIPT = os.path.join(HOOKS, "factory_rereview.py")
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
    p = subprocess.run([sys.executable, SCRIPT, "--base", "main", *args], cwd=d, capture_output=True, text=True, env=ENV)
    return p.returncode, p.stdout, p.stderr


def plan(d, kind="reviewer"):
    rc, out, err = run(d, "plan", "--kind", kind)
    assert rc == 0, err
    return json.loads(out)


def record(d, result="fail", findings="must-fix: src/b.py line 2 prints the wrong text", kind="reviewer"):
    rc, out, err = run(d, "record", "--kind", kind, "--result", result, "--findings", findings)
    assert rc == 0, err


def test_the_first_review_is_a_full_one():
    d = project()
    p = plan(d)
    assert p["mode"] == "full" and "first" in p["reason"], p
    rc, out, err = run(d, "prompt", "--kind", "reviewer")
    assert rc == 0 and "Full review" in out and "BEGIN DELTA" not in out, out


def test_a_small_fix_after_a_failed_pass_is_reviewed_as_a_delta():
    d = project()
    record(d)
    write(d, "src/b.py", "print('b')\nprint('right text')\n")
    head = commit(d, "fix")
    p = plan(d)
    assert p["mode"] == "delta" and p["head"] == head and p["delta"]["files"] == ["src/b.py"], p
    assert p["delta"]["percent"] < 30, p


def test_the_re_review_prompt_has_the_delta_and_the_earlier_findings_but_not_the_whole_diff():
    d = project()
    record(d)
    rc, out, err = run(d, "reply", "--kind", "reviewer", "--text", "Fixed the text in b.py; kept a.py as is.")
    assert rc == 0, err
    write(d, "src/b.py", "print('b')\nprint('right text')\n")
    commit(d, "fix")
    rc, out, err = run(d, "prompt", "--kind", "reviewer")
    assert rc == 0, err
    assert "Re-review" in out and "BEGIN DELTA" in out
    assert "+print('right text')" in out and "-print('more b')" in out  # the delta
    assert "must-fix: src/b.py line 2 prints the wrong text" in out  # its own earlier finding
    assert "Fixed the text in b.py" in out  # the author's reply
    assert "line 57 of the first file" not in out  # the 100-line file it already read is not in the prompt
    assert "git diff main...HEAD" not in out


def test_a_large_delta_goes_back_to_a_full_review():
    d = project()
    record(d)
    write(d, "src/a.py", BIG + "".join(f"extra {i}\n" for i in range(60)))
    commit(d, "big fix")
    p = plan(d)
    assert p["mode"] == "full" and "%" in p["reason"], p
    rc, out, err = run(d, "prompt", "--kind", "reviewer")
    assert "Full review" in out and "BEGIN DELTA" not in out
    assert "must-fix: src/b.py line 2" in out  # earlier findings still shown


def test_a_new_file_goes_back_to_a_full_review():
    d = project()
    record(d)
    write(d, "src/new.py", "x = 1\n")
    commit(d, "add a file")
    p = plan(d)
    assert p["mode"] == "full" and "src/new.py" in p["reason"], p


def test_the_percent_setting_moves_the_limit_and_zero_turns_it_off():
    d = project({"reReviewPercent": 1})
    record(d)
    write(d, "src/b.py", "print('b')\nprint('right text')\n")
    commit(d, "fix")
    assert plan(d)["mode"] == "full"
    d = project({"reReviewPercent": 0})
    record(d)
    write(d, "src/b.py", "print('b')\nprint('right text')\n")
    commit(d, "fix")
    p = plan(d)
    assert p["mode"] == "full" and "off" in p["reason"], p


def test_a_rewritten_history_goes_back_to_a_full_review():
    d = project()
    record(d)
    git(d, "reset", "-q", "--hard", "HEAD~1")
    write(d, "src/a.py", BIG)
    commit(d, "the task again")
    p = plan(d)
    assert p["mode"] == "full" and "history" in p["reason"], p


def test_a_branch_whose_base_moved_goes_back_to_a_full_review():
    d = project()
    record(d)
    git(d, "checkout", "-q", "main")
    write(d, "other.txt", "x\n")
    commit(d, "main moves")
    git(d, "checkout", "-q", "task/70-x")
    git(d, "merge", "-q", "--no-edit", "main")
    p = plan(d)
    assert p["mode"] == "full" and "base" in p["reason"], p


def test_nothing_new_since_the_last_pass_says_so():
    d = project()
    record(d, result="pass", findings="no must-fix")
    assert plan(d)["mode"] == "unchanged"


def test_each_reviewer_kind_has_its_own_history():
    d = project()
    record(d, kind="reviewer")
    write(d, "src/b.py", "print('b')\nprint('right text')\n")
    commit(d, "fix")
    assert plan(d, "reviewer")["mode"] == "delta"
    assert plan(d, "arch")["mode"] == "full"


def test_the_summary_is_kept_and_the_pass_marker_is_not_touched():
    d = project()
    record(d, result="pass", findings="no must-fix; checked the gate")
    state = json.load(open(os.path.join(d, "tmp", "reviews", "task_70-x.reviews.json")))
    last = state["reviewer"][-1]
    assert last["result"] == "pass" and last["findings"].startswith("no must-fix") and len(last["sha"]) == 40, last
    assert not os.path.exists(os.path.join(d, "tmp", "reviews", "task_70-x.ok"))  # only the reviewer writes that


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


def test_the_agents_and_the_next_task_skill_tell_the_reviewers_to_use_it():
    for agent in ("reviewer", "architecture-reviewer", "safety-auditor", "security-reviewer"):
        text = open(os.path.join(SF, "kit", ".claude", "agents", agent + ".md")).read()
        assert "factory_rereview.py prompt" in text and "factory_rereview.py record" in text, agent
    skill = open(os.path.join(SF, "kit", ".claude", "skills", "next-task", "SKILL.md")).read()
    rework = open(os.path.join(SF, "kit", ".claude", "skills", "next-task", "rework.md")).read()
    assert "factory_rereview.py reply" in skill and "factory_rereview.py reply" in rework


def test_the_setting_is_known_and_the_forwarder_exists():
    sys.path.insert(0, HOOKS)
    import factory_settings
    assert "reReviewPercent" in factory_settings.SETTINGS and factory_settings.default_of("reReviewPercent") == 30
    link = os.path.join(SF, "kit", ".claude", "hooks", "factory_rereview.py")
    assert os.path.islink(link) and os.path.realpath(link) == os.path.realpath(SCRIPT)
    assert "factory_rereview" in open(os.path.join(SF, "factory")).read()


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
