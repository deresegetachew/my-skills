#!/usr/bin/env python3
"""`factory ci log <pr or run>` prints the failed job's log, trimmed to the failing step (#206). Read-only: it only
GETs. Runs with a fake `gh` on PATH that answers from a JSON file and logs every call.
  python3 software-factory/tests/test_ci_log.py"""
import json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SF = os.path.abspath(os.path.join(HERE, ".."))

FAKE_GH = r'''#!/usr/bin/env python3
import json, os, sys
db = json.load(open(os.environ["FAKE_DB"])); a = sys.argv[1:]
open(os.environ["FAKE_DB"] + ".calls", "a").write(" ".join(a) + "\n")
if a[:1] != ["api"]: sys.exit("fake gh: only api")
path = [x for x in a[1:] if not x.startswith("-")][0].replace("repos/{owner}/{repo}/", "").split("?")[0]
if "-X" in a: sys.exit("fake gh: a write was asked for")
if path in db["text"]: print(db["text"][path], end=""); sys.exit(0)
if path in db["json"]: print(json.dumps(db["json"][path])); sys.exit(0)
sys.exit("gh: Not Found (HTTP 404)")
'''

LOG = "\n".join([
    "2026-10-26T10:00:00.0000000Z ##[group]Run actions/checkout@v4",
    "2026-10-26T10:00:01.0000000Z checkout noise",
    "2026-10-26T10:00:02.0000000Z ##[endgroup]",
    "2026-10-26T10:00:03.0000000Z ##[group]Run python3 tools/run_tests.py",
    "2026-10-26T10:00:04.0000000Z test_a ok",
    "2026-10-26T10:00:05.0000000Z FAIL test_b: expected 1, got 2",
    "2026-10-26T10:00:06.0000000Z ##[error]Process completed with exit code 1.",
    "2026-10-26T10:00:07.0000000Z post-job noise",
]) + "\n"


def project(extra_json=None):
    d = tempfile.mkdtemp()
    os.makedirs(os.path.join(d, "bin"))
    subprocess.run(["git", "init", "-q", d], check=True)
    os.makedirs(os.path.join(d, ".claude"))
    os.symlink(os.path.join(SF, "hooks"), os.path.join(d, ".claude", "hooks"))
    open(os.path.join(d, ".claude", "factory.json"), "w").write("{}")
    gh = os.path.join(d, "bin", "gh")
    open(gh, "w").write(FAKE_GH)
    os.chmod(gh, 0o755)
    job = {"id": 77, "name": "test", "conclusion": "failure", "steps": [
        {"number": 1, "name": "Checkout", "conclusion": "success"},
        {"number": 2, "name": "Run the tests", "conclusion": "failure"}]}
    ok = {"id": 78, "name": "lint", "conclusion": "success", "steps": []}
    db = {"json": {"pulls/12": {"head": {"sha": "abc1234def"}},
                   "commits/abc1234def/check-runs": {"total_count": 2, "check_runs": [
                       {"id": 77, "name": "test", "conclusion": "failure"}, {"id": 78, "name": "lint", "conclusion": "success"}]},
                   "actions/jobs/77": job,
                   "actions/runs/999/jobs": {"jobs": [job, ok]}},
          "text": {"actions/jobs/77/logs": LOG}}
    db["json"].update(extra_json or {})
    path = os.path.join(d, "db.json")
    json.dump(db, open(path, "w"))
    env = {**os.environ, "PATH": f"{d}/bin:{os.environ['PATH']}", "FAKE_DB": path, "CLAUDE_PROJECT_DIR": d}
    return d, env


def ci_log(d, env, *args):
    p = subprocess.run(["bash", os.path.join(SF, "factory"), "ci", "log", *args], cwd=d, env=env, capture_output=True, text=True)
    return p.returncode, p.stdout, p.stderr


def test_a_pr_prints_the_failed_job_trimmed_to_the_failing_step():
    d, env = project()
    rc, out, err = ci_log(d, env, "12")
    assert rc == 0, (out, err)
    assert "job test" in out and "Run the tests" in out, out
    assert "FAIL test_b: expected 1, got 2" in out and "Process completed with exit code 1." in out, out
    assert "checkout noise" not in out and "post-job noise" not in out, out
    assert "2026-10-26T" not in out, out  # timestamps are stripped
    assert "lint" not in out, out  # the passing job is not shown


def test_a_run_id_works_too():
    d, env = project()
    rc, out, err = ci_log(d, env, "999")
    assert rc == 0 and "FAIL test_b" in out, (rc, out, err)


def test_a_pr_with_no_failed_job_says_so():
    d, env = project({"commits/abc1234def/check-runs": {"total_count": 1, "check_runs": [
        {"id": 78, "name": "lint", "conclusion": "success"}]}})
    rc, out, err = ci_log(d, env, "12")
    assert rc == 0 and "No failed job" in out, (rc, out, err)


def test_an_unknown_number_is_a_code_message_fix():
    d, env = project()
    rc, out, err = ci_log(d, env, "4040")
    assert rc == 1, (rc, out, err)
    e = json.loads(err)
    assert e["code"] == "ci-not-found" and e["message"] and "factory ci log" in e["fix"], e


def test_it_only_reads():
    d, env = project()
    ci_log(d, env, "12")
    calls = open(env["FAKE_DB"] + ".calls").read()
    assert "-X" not in calls and "POST" not in calls and "PATCH" not in calls, calls


def test_help_and_readme_list_the_command():
    help_ = subprocess.run(["bash", os.path.join(SF, "factory"), "help"], capture_output=True, text=True).stdout
    assert "ci log" in help_, help_
    assert "| `factory ci log" in open(os.path.join(SF, "README.md")).read()


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
