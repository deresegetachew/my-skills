#!/usr/bin/env python3
"""`factory report`: per task, claim to PR to merge, rework rounds and CI runs, from GitHub (#65), against a fake
`gh` that answers from a scenario.  python3 software-factory/tests/test_report.py"""
import json, os, subprocess, tempfile
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
KIT = os.path.abspath(os.path.join(HERE, "..", "kit"))
HOOKS = os.path.join(KIT, ".claude", "hooks")

FAKE_GH = r'''#!/usr/bin/env python3
import json, os, sys
from urllib.parse import urlparse, parse_qs, unquote
s = json.load(open(os.environ["REPORT_SCENARIO"]))
a = sys.argv[1:]
if a[:1] != ["api"] or "-X" in a or "--input" in a:
    sys.exit("fake gh: report must only read")
u = urlparse(a[1].replace("repos/{owner}/{repo}/", "")); q = parse_qs(u.query)
if u.path == "pulls":
    print(json.dumps(s["pulls"] if q.get("page", ["1"])[0] == "1" else [])); sys.exit(0)
if u.path == "actions/runs":
    print(json.dumps({"workflow_runs": s["runs"].get(unquote(q["branch"][0]), [])})); sys.exit(0)
if u.path.startswith("issues/") and u.path.endswith("/comments"):
    print(json.dumps(s["comments"].get(u.path.split("/")[1], []))); sys.exit(0)
sys.exit("fake gh: no answer for " + a[1])
'''

NOW = datetime.now(timezone.utc).replace(microsecond=0)


def t(hours_ago):
    return (NOW - timedelta(hours=hours_ago)).strftime("%Y-%m-%dT%H:%M:%SZ")


def pr(n, branch, created, merged=None, state="closed"):
    return {"number": n, "head": {"ref": branch}, "created_at": created, "merged_at": merged,
            "state": state if merged or state == "open" else "closed"}


def setup(cfg):
    d = tempfile.mkdtemp()
    subprocess.run(["git", "init", "-q", "-b", "main", d], check=True)
    os.makedirs(os.path.join(d, ".claude", "hooks"))
    os.makedirs(os.path.join(d, "bin"))
    for f in os.listdir(HOOKS):
        if f.endswith(".py"):
            os.symlink(os.path.join(HOOKS, f), os.path.join(d, ".claude", "hooks", f))
    json.dump(cfg, open(os.path.join(d, ".claude", "factory.json"), "w"))
    open(os.path.join(d, "bin", "gh"), "w").write(FAKE_GH)
    os.chmod(os.path.join(d, "bin", "gh"), 0o755)
    scenario = {
        # newest first, as GitHub sorts them
        "pulls": [pr(30, "task/12-open", t(2), state="open"),
                  pr(29, "chore/not-a-task", t(3), t(1)),
                  pr(28, "task/11-merged", t(10), t(4)),
                  pr(20, "task/9-old", t(24 * 20), t(24 * 19))],
        "comments": {
            "11": [{"body": "<!-- factory-claim agent=taytu -->", "created_at": t(14)}],
            "12": [{"body": "<!-- factory-claim agent=menelik -->", "created_at": t(3)}],
            "28": [{"body": "<!-- factory-mustfix --> fix it", "created_at": t(8)},
                   {"body": "<!-- factory-mustfix --> and this", "created_at": t(6)},
                   {"body": "<!-- factory-approved sha=abc -->", "created_at": t(5)}],
        },
        "runs": {"task/11-merged": [{"conclusion": "failure"}, {"conclusion": "success"}, {"conclusion": "success"}],
                 "task/12-open": [{"conclusion": None}]},
    }
    json.dump(scenario, open(os.path.join(d, "scenario.json"), "w"))
    env = {**os.environ, "PATH": f"{d}/bin:{os.environ['PATH']}", "REPORT_SCENARIO": os.path.join(d, "scenario.json")}
    env.pop("CLAUDE_PROJECT_DIR", None)
    return d, env


def report(d, env, *args):
    return subprocess.run(["bash", os.path.join(KIT, "factory"), "report", *args], cwd=d, env=env,
                          capture_output=True, text=True, timeout=60)


def test_each_task_pr_gets_its_timings_rework_and_ci_runs():
    d, env = setup({"tasks": {"source": "issues"}})
    p = report(d, env, "--json")
    assert p.returncode == 0, p
    rows = {r["pr"]: r for r in json.loads(p.stdout)["tasks"]}
    assert set(rows) == {28, 30}, rows  # not the chore branch, not the PR from 20 days ago
    r = rows[28]
    assert (r["task"], r["agent"], r["state"]) == ("11", "taytu", "merged"), r
    assert (r["claimToPr"], r["prToMerge"], r["claimToMerge"]) == (4.0, 6.0, 10.0), r
    assert (r["rework"], r["ciRuns"], r["ciFailed"]) == (2, 3, 1), r
    assert rows[30]["state"] == "open" and rows[30]["prToMerge"] == 2.0 and rows[30]["claimToPr"] == 1.0, rows[30]


def test_the_text_view_and_a_longer_window():
    d, env = setup({"tasks": {"source": "issues"}})
    p = report(d, env)
    assert "#28" in p.stdout and "3 (1 failed)" in p.stdout and "so far" in p.stdout, p.stdout
    assert "Median PR->merge 6.0h, claim->merge 10.0h" in p.stdout, p.stdout
    p = report(d, env, "--since", "30d", "--json")
    assert {r["pr"] for r in json.loads(p.stdout)["tasks"]} == {20, 28, 30}


def test_plan_mode_has_no_claim_times():
    d, env = setup({})
    rows = {r["pr"]: r for r in json.loads(report(d, env, "--json").stdout)["tasks"]}
    assert rows[28]["claimToPr"] is None and rows[28]["prToMerge"] == 6.0, rows[28]


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
