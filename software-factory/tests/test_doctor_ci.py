#!/usr/bin/env python3
"""`factory doctor` looks at CI before a test run (#205, the doctor part of #199): the runs-on variables and whether a
runner with that label is online, whether the newest run on main is green, stale claims and Agent issues for agents
that never ran, and a workflow whose setup does not match factory.json. Everything is read through `gh api` GETs; a
fake gh answers from a JSON file and records what it was asked.
  python3 software-factory/tests/test_doctor_ci.py"""
import json, os, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import test_doctor as doc  # noqa: E402

FAKE_GH = r'''#!/usr/bin/env python3
import json, os, re, sys
a = sys.argv[1:]
open(os.environ["GH_LOG"], "a").write(" ".join(a) + "\n")
if a[:1] != ["api"]:
    sys.exit(0)
rest, path, i = a[1:], None, 0
method = "GET"
while i < len(rest):
    if rest[i] in ("-X", "--method"):
        method = rest[i + 1]; i += 2
    elif rest[i] in ("-H", "--jq", "-q", "--input", "-f", "-F"):
        i += 2
    elif rest[i].startswith("-"):
        i += 1
    else:
        path = path or rest[i]; i += 1
if method != "GET":
    print("fake gh: a write was attempted: " + " ".join(a), file=sys.stderr); sys.exit(1)
db = json.load(open(os.environ["GH_DB"]))
page2 = re.search(r"[&?]page=([2-9])", path)
key = re.sub(r"[&?]page=\d+", "", re.sub(r"[&?]per_page=100", "", path))
if key in db:
    print(json.dumps([] if page2 else db[key])); sys.exit(0)
if key.startswith("repos/{owner}/{repo}/issues?"):
    print("[]"); sys.exit(0)
print("gh: Not Found (HTTP 404)", file=sys.stderr); sys.exit(1)
'''

P = "repos/{owner}/{repo}/"
OK_RUN = {"workflow_runs": [{"name": "ci", "conclusion": "success", "status": "completed", "html_url": "https://x/runs/1", "head_sha": "a" * 40}]}
BAD_RUN = {"workflow_runs": [{"name": "ci", "conclusion": "failure", "status": "completed", "html_url": "https://x/runs/9", "head_sha": "b" * 40}]}


def runner(name, labels, status="online"):
    return {"name": name, "status": status, "labels": [{"name": l} for l in labels]}


def agent_issue(n, name, status, minutes_ago, state="open"):
    from datetime import datetime, timedelta, timezone
    ping = (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {"number": n, "title": f"Agent: {name} · {status}", "state": state, "labels": [{"name": "factory:agent"}],
            "body": f"<!-- factory-agent name={name} status={status} ping={ping} -->"}


def task_issue(n, agent):
    return {"number": n, "title": f"Task {n}", "state": "open", "body": "", "labels": [{"name": "factory:in-progress"}, {"name": "agent:" + agent}]}


def run(db=None, cfg=None, files=None, runs=OK_RUN):
    d = doc.project(cfg={"agents": ["taytu"], **(cfg or {})})
    for name, text in (files or {}).items():
        os.makedirs(os.path.dirname(os.path.join(d, name)), exist_ok=True)
        open(os.path.join(d, name), "w").write(text)
    scratch = tempfile.mkdtemp()
    bin_ = tempfile.mkdtemp()
    env = doc.machine()
    gh = os.path.join(bin_, "gh")
    open(gh, "w").write(FAKE_GH)
    os.chmod(gh, 0o755)
    for tool in os.listdir(env["PATH"]):
        if tool != "gh":
            os.symlink(os.path.join(env["PATH"], tool), os.path.join(bin_, tool))
    json.dump({"user": {"login": "me"}, "repos/{owner}/{repo}": {}, P + "actions/runs?branch=main&per_page=1": runs, **(db or {})}, open(os.path.join(scratch, "db.json"), "w"))
    env.update({"PATH": bin_, "GH_DB": os.path.join(scratch, "db.json"), "GH_LOG": os.path.join(scratch, "log"), "FACTORY_AGENTS": "taytu"})
    open(env["GH_LOG"], "w").close()
    p = doc.doctor(d, env)
    return p, open(env["GH_LOG"]).read()


def mine(p, kind, word):
    return [l for l in p.stdout.splitlines() if l.startswith(kind) and word in l]


def variables(**kw):
    return {P + "actions/variables": {"variables": [{"name": k, "value": v} for k, v in kw.items()]}}


# --- (1) runs-on variables and runners --------------------------------------------------------------------------------

def test_a_runs_on_variable_with_no_online_runner_of_that_label_is_a_fix_that_names_the_label_and_the_way_out():
    db = {**variables(CI_RUNS_ON_LIGHT='["self-hosted","sandbox-light"]'), P + "actions/runners": {"runners": [runner("a", ["self-hosted", "sandbox-heavy"])]}}
    p, log = run(db)
    fixes = mine(p, "fix", "CI_RUNS_ON_LIGHT")
    assert fixes and "sandbox-light" in fixes[0] and "factory ci" in fixes[0], p.stdout
    assert p.returncode == 1


def test_an_offline_runner_does_not_count():
    db = {**variables(CI_RUNS_ON='["self-hosted","x-local"]'), P + "actions/runners": {"runners": [runner("a", ["self-hosted", "x-local"], "offline")]}}
    p, log = run(db)
    assert mine(p, "fix", "CI_RUNS_ON") and "x-local" in mine(p, "fix", "CI_RUNS_ON")[0], p.stdout


def test_an_online_runner_with_the_label_is_ok_and_github_hosted_needs_no_runner():
    db = {**variables(CI_RUNS_ON='["self-hosted","x-local"]', CI_RUNS_ON_LIGHT='"ubuntu-latest"'),
          P + "actions/runners": {"runners": [runner("a", ["self-hosted", "Linux", "x-local"])]}}
    p, log = run(db)
    assert mine(p, "ok", "CI_RUNS_ON ") and mine(p, "ok", "CI_RUNS_ON_LIGHT"), p.stdout
    assert not mine(p, "fix", "CI_RUNS_ON"), p.stdout


def test_runners_gh_cannot_read_are_a_note_not_a_fix():
    p, log = run(variables(CI_RUNS_ON='["self-hosted","x-local"]'))  # no runners answer: needs admin
    assert mine(p, "note", "runner") and not mine(p, "fix", "CI_RUNS_ON"), p.stdout


# --- (2) the newest run on main ----------------------------------------------------------------------------------------

def test_a_failed_newest_run_on_main_is_a_fix_with_the_run_link():
    p, log = run(runs=BAD_RUN)
    fixes = mine(p, "fix", "main")
    assert fixes and "https://x/runs/9" in fixes[0] and "failure" in fixes[0], p.stdout
    assert p.returncode == 1


def test_a_green_newest_run_on_main_is_ok_and_no_run_yet_is_a_note():
    p, log = run()
    assert mine(p, "ok", "main"), p.stdout
    p, log = run(runs={"workflow_runs": []})
    assert mine(p, "note", "main") and not mine(p, "fix", "main"), p.stdout


# --- (3) stale claims and agent issues for agents that never ran -----------------------------------------------------

ISSUES = "repos/{owner}/{repo}/issues?state=all&labels=factory:agent"


def test_an_in_progress_issue_held_by_a_down_agent_is_a_note_with_the_release_command():
    db = {ISSUES: [agent_issue(4, "menelik", "down", 600)], P + "issues?state=open&labels=factory:in-progress": [task_issue(30, "menelik")],
          P + "issues?state=open&labels=factory:agent": [agent_issue(4, "menelik", "down", 600)]}
    p, log = run(db, cfg={"tasks": {"source": "issues"}, "agents": ["taytu", "menelik"]})
    notes = mine(p, "note", "#30")
    assert notes and "menelik" in notes[0] and "factory issues release 30" in notes[0], p.stdout
    assert p.returncode == 0, "a stale claim is a note, not a fix"


def test_an_open_agent_issue_for_a_name_that_is_not_configured_is_a_note():
    old = agent_issue(11, "ghost", "idle", 5000)
    db = {ISSUES: [old], P + "issues?state=open&labels=factory:agent": [old]}
    p, log = run(db, cfg={"tasks": {"source": "issues"}})
    notes = mine(p, "note", "#11")
    assert notes and "ghost" in notes[0] and "close" in notes[0], p.stdout


# --- (4) the workflow against factory.json ---------------------------------------------------------------------------

PNPM_CI = ("name: ci\njobs:\n  test:\n    steps:\n      - uses: pnpm/action-setup@v4\n      - uses: actions/setup-node@v4\n"
           "      - run: pnpm install --frozen-lockfile\n      - run: pnpm test\n")


def test_a_pnpm_workflow_in_a_project_without_package_json_is_a_fix_naming_the_files():
    p, log = run(files={".github/workflows/ci.yml": PNPM_CI}, cfg={"commands": {"test": "python3 tests/test_x.py"}})
    fixes = mine(p, "fix", "ci.yml")
    assert fixes and "package.json" in fixes[0] and "commands.test" in fixes[0], p.stdout


def test_a_workflow_that_runs_a_command_factory_json_leaves_empty_is_a_fix():
    p, log = run(files={".github/workflows/ci.yml": "jobs:\n  t:\n    steps:\n      - run: pnpm test\n", "package.json": "{}"})
    fixes = mine(p, "fix", "commands.test")
    assert fixes and "pnpm test" in fixes[0], p.stdout


def test_a_matching_workflow_and_no_workflow_are_quiet():
    p, log = run(files={".github/workflows/ci.yml": PNPM_CI, "package.json": '{"packageManager": "pnpm@9.0.0"}', ".nvmrc": "22\n"},
                 cfg={"commands": {"test": "pnpm test"}})
    assert not mine(p, "fix", "ci.yml") and not mine(p, "fix", "commands."), p.stdout
    p, log = run()
    assert not mine(p, "fix", "ci.yml"), p.stdout


# --- read-only --------------------------------------------------------------------------------------------------------

def test_doctor_only_reads_from_github():
    p, log = run({**variables(CI_RUNS_ON='["self-hosted","x"]'), P + "actions/runners": {"runners": []}}, cfg={"tasks": {"source": "issues"}})
    calls = [l for l in log.splitlines() if l.startswith("api")]
    assert calls and not [l for l in calls if any(w in l for w in ("-X POST", "-X PATCH", "-X PUT", "-X DELETE", "--input"))], log


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
