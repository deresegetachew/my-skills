#!/usr/bin/env python3
"""`factory prs`: the one list a dev manager starts a pass from (#98), against a fake `gh` that answers from a scenario
(recorded-style REST replies) and logs every call.  python3 software-factory/tests/test_prs.py"""
import json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SF = os.path.abspath(os.path.join(HERE, ".."))
HOOKS = os.path.join(SF, "hooks")
sys.path.insert(0, HOOKS)

FAKE_GH = r'''#!/usr/bin/env python3
import json, os, sys
from urllib.parse import urlparse
s = json.load(open(os.environ["PRS_SCENARIO"]))
a = sys.argv[1:]
open(os.environ["PRS_LOG"], "a").write(" ".join(a) + "\n")
if a[:2] == ["repo", "view"]:
    print("main"); sys.exit(0)
method = a[a.index("-X") + 1] if "-X" in a else "GET"
if a[:1] != ["api"] or method != "GET" or "--input" in a or "-f" in a or "-F" in a:
    sys.exit("fake gh: prs must only read")
path = urlparse([x for x in a[1:] if not x.startswith("-") and x not in ("GET", "Accept: application/vnd.github+json")][0]
                .replace("repos/{owner}/{repo}/", "")).path
if path == "contents/.claude/factory.json":
    print(json.dumps(s.get("main_settings", {}))); sys.exit(0)
if path in s.get("broken", []):
    sys.exit("gh: HTTP 403")
if path in s:
    print(json.dumps(s[path])); sys.exit(0)
if path == "branches":
    print("[]"); sys.exit(0)
sys.exit("fake gh: no answer for " + path)
'''

LONG_AGO = "2020-01-01T00:00:00Z"
FAR = "2099-01-01T00:00:00Z"
SHAS = {n: f"{n:x}" * 40 for n in range(1, 12)}  # 1*40 ... b*40: hex, like real commit ids
OLD = "0" * 40
CFG = {"tasks": {"source": "issues"}, "agents": ["menelik", "taytu"]}
MAIN = {"tasks": {"source": "issues"}, "manager": {"flakes": ["e2e"]}, "protected": [r"^\.claude/"]}


def run(name, ci=(), comments=(), labels=(), draft=False, branch=None, body="", files=("src/a.py",)):
    return dict(name=name, ci=list(ci), comments=list(comments), labels=list(labels), draft=draft,
                branch=branch or f"task/{name}-x", body=body, files=list(files))


def check(name, conclusion="success", status="completed", id=1):
    return {"id": id, "name": name, "status": status, "conclusion": conclusion}


def marker(kind, sha, at="2020-01-01T01:00:00Z", extra=""):
    return {"body": f"<!-- {kind} sha={sha} {extra}-->", "created_at": at}


def scenario(prs, extra=None):
    s = {"pulls": [], "issues": [], "issues/comments": []}
    for n, p in prs.items():
        sha = SHAS[n]
        s["pulls"].append({"number": n, "title": f"Task {n}", "draft": p["draft"], "body": p["body"],
                           "html_url": f"https://github.com/o/r/pull/{n}", "head": {"sha": sha, "ref": p["branch"]},
                           "labels": [{"name": x} for x in p["labels"]]})
        s[f"commits/{sha}"] = {"commit": {"committer": {"date": LONG_AGO}}}
        s[f"commits/{sha}/check-runs"] = {"check_runs": p["ci"]}
        s[f"issues/{n}/comments"] = p["comments"]
        s[f"pulls/{n}/files"] = [{"filename": f} for f in p["files"]]
    s["main_settings"] = MAIN
    s.update(extra or {})
    return s


def project(sc, cfg=CFG):
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
    json.dump(sc, open(os.path.join(d, "scenario.json"), "w"))
    env = {**os.environ, "PATH": f"{d}/bin:{os.environ['PATH']}", "PRS_SCENARIO": os.path.join(d, "scenario.json"),
           "PRS_LOG": os.path.join(d, "log"), "PYTHONDONTWRITEBYTECODE": "1"}
    for k in ("FACTORY_AGENT", "FACTORY_LOOP", "CLAUDE_PROJECT_DIR"):
        env.pop(k, None)
    return d, env


def prs(sc, *args, cfg=CFG):
    d, env = project(sc, cfg)
    p = subprocess.run(["bash", os.path.join(SF, "factory"), "prs", *args], cwd=d, env=env, capture_output=True,
                       text=True, timeout=60)
    return d, p


def pulls_json(sc, cfg=CFG):
    d, p = prs(sc, "--json", cfg=cfg)
    assert p.returncode == 0, p
    out = json.loads(p.stdout)
    return {x["number"]: x for x in out["pulls"]}, out


# --- CI judged by the rule -------------------------------------------------------------------------------------

def test_a_rerun_replaces_a_failure_and_a_skipped_job_is_ignored():
    ci = [check("test", "failure", id=1), check("test", "success", id=5), check("lint", id=2),
          check("deploy", "success", id=3), check("deploy", "skipped", id=9)]  # the skipped run is the newest one
    got, _ = pulls_json(scenario({1: run(1, ci, [marker("factory-approved", SHAS[1])])}))
    assert got[1]["ci"]["state"] == "green" and got[1]["ci"]["notGreen"] == [], got[1]["ci"]
    assert got[1]["next"]["action"] == "merge", got[1]["next"]


def test_a_failed_newest_run_is_red_and_names_the_job():
    ci = [check("test", "success", id=1), check("test", "failure", id=5), check("lint", id=2)]
    got, _ = pulls_json(scenario({1: run(1, ci)}))
    assert got[1]["ci"]["state"] == "red", got[1]["ci"]
    assert got[1]["ci"]["notGreen"] == [{"name": "test", "state": "red"}], got[1]["ci"]


def test_running_and_queued_and_no_runs():
    running = [check("a", id=1), check("b", None, "in_progress", 2), check("c", None, "queued", 3)]
    queued = [check("a", id=1), check("c", None, "queued", 3)]
    got, _ = pulls_json(scenario({1: run(1, running), 2: run(2, queued), 3: run(3, [], [marker("factory-approved", SHAS[3])])}))
    assert got[1]["ci"]["state"] == "running" and got[2]["ci"]["state"] == "queued", got
    assert {x["name"] for x in got[1]["ci"]["notGreen"]} == {"b", "c"}, got[1]["ci"]
    assert got[3]["ci"]["state"] == "none" and got[3]["next"]["action"] == "wait-ci", got[3]


# --- markers per sha -------------------------------------------------------------------------------------------

def test_a_marker_for_an_older_head_does_not_count():
    got, _ = pulls_json(scenario({2: run(2, [check("t")], [marker("factory-approved", OLD)])}))
    p = got[2]
    assert p["headMarker"] is None and p["next"]["action"] == "review", p
    assert p["markers"] == [{"kind": "factory-approved", "sha": OLD, "at": "2020-01-01T01:00:00Z", "namesHead": False}], p


def test_the_newest_marker_per_sha_wins():
    cs = [marker("factory-mustfix", OLD, "2020-01-01T00:00:00Z"), marker("pr-watch", SHAS[1], "2020-01-01T01:00:00Z"),
          marker("factory-mustfix", SHAS[1], "2020-01-01T02:00:00Z"), marker("factory-approved", SHAS[1], "2020-01-01T03:00:00Z")]
    got, _ = pulls_json(scenario({1: run(1, [check("t")], cs)}))
    p = got[1]
    assert p["headMarker"] == "factory-approved", p
    assert [(m["sha"], m["kind"]) for m in p["markers"]] == [(OLD, "factory-mustfix"), (SHAS[1], "factory-approved")], p
    assert p["next"]["action"] == "merge"


def test_a_must_fix_holds_until_an_approval_of_the_head_follows():
    cs = [marker("factory-mustfix", SHAS[1])]
    got, _ = pulls_json(scenario({1: run(1, [check("t")], cs)}))
    assert got[1]["headMarker"] == "factory-mustfix" and got[1]["next"]["action"] == "waiting-for-agent", got[1]


def test_an_approval_from_a_login_main_does_not_trust_is_ignored():
    c = {**marker("factory-approved", SHAS[1]), "user": {"login": "someone-else"}}
    sc = scenario({1: run(1, [check("t")], [c])})
    sc["main_settings"] = {**MAIN, "trustedReviewers": ["manager-login"]}
    got, _ = pulls_json(sc)
    assert got[1]["headMarker"] is None and got[1]["next"]["action"] == "review", got[1]


# --- next action -----------------------------------------------------------------------------------------------

def test_a_draft_waits_for_its_agent():
    got, _ = pulls_json(scenario({3: run(3, [check("t")], draft=True)}))
    assert got[3]["draft"] is True and got[3]["next"]["action"] == "waiting-for-agent", got[3]
    assert got[3]["next"]["text"] == "waiting for agent"


def test_a_protected_pr_that_is_approved_and_green_goes_to_the_owner():
    p = run(4, [check("t")], [marker("factory-approved", SHAS[4])], files=[".claude/factory.json", "src/a.py"])
    got, _ = pulls_json(scenario({4: p}))
    assert got[4]["protected"] is True, got[4]
    assert got[4]["next"] == {"action": "owner-merges", "text": "owner merges (protected)", "reason": "protected"}, got[4]


def test_a_pr_that_says_a_person_merges_it_counts_as_protected():
    p = run(4, [check("t")], [marker("factory-approved", SHAS[4])], body="A person merges this one: CI")
    got, _ = pulls_json(scenario({4: p}))
    assert got[4]["next"]["text"] == "owner merges (protected)", got[4]


def test_a_pr_the_manager_opened_is_never_merged_by_the_manager():
    p = run(5, [check("t")], branch="chore/fix-ci")
    got, _ = pulls_json(scenario({5: p}))
    assert got[5]["agentPr"] is False, got[5]
    assert got[5]["next"] == {"action": "owner-merges", "text": "owner merges (own PR)", "reason": "not-agent-pr"}, got[5]


def test_an_unreviewed_head_needs_a_review_even_while_ci_runs():
    got, _ = pulls_json(scenario({1: run(1, [check("t", None, "in_progress")])}))
    assert got[1]["next"]["text"] == "review", got[1]


def test_approved_but_ci_still_running_waits_for_ci():
    got, _ = pulls_json(scenario({1: run(1, [check("t", None, "queued")], [marker("factory-approved", SHAS[1])])}))
    assert got[1]["next"]["text"] == "wait CI", got[1]


def test_a_known_flake_failing_for_the_first_time_is_rerun_a_second_failure_is_not():
    first = [check("e2e", "failure", id=1), check("lint", id=2)]
    again = [check("e2e", "failure", id=1), check("e2e", "failure", id=7), check("lint", id=2)]
    other = [check("unit", "failure", id=1)]
    got, _ = pulls_json(scenario({1: run(1, first, [marker("pr-watch", SHAS[1])]),
                                  2: run(2, again, [marker("pr-watch", SHAS[2])]),
                                  3: run(3, other, [marker("pr-watch", SHAS[3])])}))
    assert got[1]["next"]["text"] == "rerun flake", got[1]
    assert got[2]["next"]["text"] == "waiting for agent", got[2]
    assert got[3]["next"]["text"] == "waiting for agent", got[3]


def test_a_review_that_only_watches_leaves_nothing_to_do():
    got, _ = pulls_json(scenario({1: run(1, [check("t")], [marker("pr-watch", SHAS[1])])}))
    assert got[1]["headMarker"] == "pr-watch" and got[1]["next"]["text"] == "none", got[1]


# --- review claims and holds -----------------------------------------------------------------------------------

def claim(manager, sha, until, at="2020-01-01T01:00:00Z"):
    return {"body": f"<!-- factory-review-claim manager={manager} sha={sha} until={until} -->", "created_at": at}


def test_an_unexpired_claim_shows_who_and_until_when_and_the_pr_is_held():
    # claims are leases: recent comments, `until` shortly ahead (a claim never counts for long after its comment, #99)
    from datetime import datetime, timedelta, timezone
    t = lambda m: (datetime.now(timezone.utc) + timedelta(minutes=m)).strftime("%Y-%m-%dT%H:%M:%SZ")
    until = t(15)
    cs = [claim("ana", SHAS[7], until, at=t(-2)), claim("ben", SHAS[7], until, at=t(-1))]
    got, _ = pulls_json(scenario({7: run(7, [check("t")], cs, labels=["factory-hold"])}))
    p = got[7]
    assert p["claim"] == {"manager": "ana", "until": until, "expired": False}, p  # the earliest unexpired claim wins
    assert p["next"]["text"] == "held by ana", p
    assert "factory-hold" in p["labels"]


def test_an_expired_claim_or_one_for_an_older_head_is_not_a_claim_and_a_stale_hold_can_be_reviewed():
    cs = [claim("ana", SHAS[7], LONG_AGO), claim("ben", OLD, FAR)]
    got, _ = pulls_json(scenario({7: run(7, [check("t")], cs, labels=["factory-hold"])}))
    p = got[7]
    assert p["claim"] is None and p["next"]["text"] == "review" and p["staleHold"] is True, p


def test_a_hold_with_no_claim_at_all_is_held_by_a_manager():
    got, _ = pulls_json(scenario({7: run(7, [check("t")], labels=["factory-hold"])}))
    assert got[7]["next"]["text"] == "held by manager", got[7]


# --- the rest of the list --------------------------------------------------------------------------------------

def test_questions_owner_asks_and_agents_below_the_pull_requests():
    ask = lambda slug, at: {"id": hash((slug, at)) % 10**6, "body": f"<!-- factory-owner-ask id={slug} -->\nthis needs your yes",
                            "created_at": at, "html_url": f"https://github.com/o/r/issues/60#c-{slug}", "issue_url": "x/issues/60"}
    reply = {"id": 2, "body": "yes, do it", "created_at": "2020-01-01T02:00:00Z", "html_url": "u", "issue_url": "x/issues/60"}
    q = lambda n, body, at: {"id": n * 10, "body": body, "created_at": at, "html_url": f"https://github.com/o/r/issues/{n}#c",
                             "issue_url": f"x/issues/{n}"}
    sc = scenario({2: run(2, [check("t")], [{"body": "<!-- factory-question -->\nwhich?", "created_at": LONG_AGO,
                                              "html_url": "https://github.com/o/r/pull/2#c"}])})
    sc["issues"] = [
        {"number": 50, "title": "A task", "state": "open", "labels": [], "body": ""},
        {"number": 60, "title": "Dev manager: needs the owner", "state": "open", "labels": [], "body": ""},
        {"number": 90, "title": "Agent: taytu · working", "state": "open", "labels": [{"name": "factory:agent"}],
         "body": f"<!-- factory-agent name=taytu status=working ping={LONG_AGO} -->"},
        {"number": 91, "title": "Agent: menelik · working", "state": "open", "labels": [{"name": "factory:agent"}],
         "body": f"<!-- factory-agent name=menelik status=working ping={FAR} -->"},
    ]
    sc["issues/comments"] = [
        q(50, "<!-- factory-question -->\nneeds a ruling", LONG_AGO),
        q(51, "<!-- factory-question -->\nold and closed", LONG_AGO),  # #51 is not open: not listed
        q(50, "unrelated chat", "2020-01-02T00:00:00Z"),
    ]
    sc["issues/60/comments"] = [ask("a", "2020-01-01T01:00:00Z"), reply, ask("b", "2020-01-01T03:00:00Z")]
    sc["issues"].append({"number": 7, "title": "Stale", "state": "open", "body": "", "updated_at": LONG_AGO,
                         "labels": [{"name": "factory:in-progress"}]})
    d, p = prs(sc, "--json")
    out = json.loads(p.stdout)
    assert p.returncode == 0, p
    qs = {(x["kind"], x["number"]) for x in out["questions"]}
    assert qs == {("pr", 2), ("issue", 50)}, out["questions"]
    assert all(x["url"].startswith("https://github.com/o/r/") and x["ageMinutes"] > 1000 for x in out["questions"])
    assert [x["id"] for x in out["ownerAsks"]] == ["b"], out["ownerAsks"]
    assert [x["name"] for x in out["agents"]] == ["taytu"] and out["agents"][0]["status"] == "silent", out["agents"]
    assert [x["number"] for x in out["staleTasks"]] == [7], out["staleTasks"]


def test_plain_text_is_compact_and_has_every_part():
    p1 = run(1, [check("t")], [marker("factory-approved", SHAS[1])], labels=["agent:taytu"])
    p2 = run(2, [check("lint", "failure")], draft=True)
    sc = scenario({1: p1, 2: p2})
    d, p = prs(sc)
    assert p.returncode == 0, p
    out = p.stdout
    assert "#1 " in out and "merge" in out and "#2 " in out and "waiting for agent" in out, out
    assert "CI red (lint)" in out and "CI green" in out and "draft" in out and "agent:taytu" in out, out
    assert SHAS[1][:7] in out, out
    assert "Questions" in out and "Owner asks" in out and "Agents" in out, out
    assert len(out.splitlines()) < 40, out


def test_an_empty_repo_says_so():
    d, p = prs(scenario({}))
    assert p.returncode == 0 and "no open pull requests" in p.stdout.lower(), p


# --- read-only, REST only, errors ------------------------------------------------------------------------------

def test_it_only_reads_through_the_rest_api():
    d, p = prs(scenario({1: run(1, [check("t")], [marker("factory-approved", SHAS[1])])}))
    calls = open(os.path.join(d, "log")).read().splitlines()
    reads = [c for c in calls if not c.startswith("repo view --json defaultBranchRef")]
    assert reads and all(c.startswith("api ") and (" -X " not in c or " -X GET " in c) for c in reads), calls
    assert not any(c.startswith("pr ") or "graphql" in c for c in calls), calls


def test_a_pr_that_cannot_be_read_does_not_hide_the_others():
    sc = scenario({1: run(1, [check("t")]), 2: run(2, [check("t")])})
    sc["broken"] = [f"commits/{SHAS[2]}/check-runs"]
    got, _ = pulls_json(sc)
    assert got[1]["ci"]["state"] == "green" and got[2]["ci"]["state"] == "unknown", got[2]["ci"]
    assert got[2]["next"]["action"] == "none" and "error" in got[2]["next"], got[2]["next"]


def test_a_section_github_cannot_answer_says_so():
    sc = scenario({1: run(1, [check("t")])})
    sc["broken"] = ["issues/comments"]
    d, p = prs(sc)
    assert p.returncode == 0 and "can't read" in p.stdout, p


def test_status_uses_the_same_ci_rule():
    ci = [check("test", "failure", id=1), check("test", "success", id=5), check("deploy", "skipped", id=9)]
    sc = scenario({1: run(1, ci, [marker("factory-approved", SHAS[1])])})
    sc["actions/runs"] = {"workflow_runs": []}
    d, env = project(sc)
    p = subprocess.run(["bash", os.path.join(SF, "factory"), "status", "--json"], cwd=d, env=env, capture_output=True,
                       text=True, timeout=60)
    assert json.loads(p.stdout)["pulls"]["pulls"][0]["ci"] == "green", p.stdout


def test_the_judging_functions_directly():
    import factory_prs as fp
    assert fp.judge_ci([]) == ("none", [])
    state, bad = fp.judge_ci([check("x", "failure", id=2), check("x", "success", id=3)])
    assert state == "green" and bad == []
    assert fp.open_questions([{"body": "<!-- factory-question -->"}, {"body": "<!-- factory-answer -->"}]) == []


def test_settings_lists_the_flake_list():
    d, env = project(scenario({}))
    p = subprocess.run([sys.executable, os.path.join(HOOKS, "factory_settings.py"), "show", "manager.flakes"], cwd=d,
                       env=env, capture_output=True, text=True)
    assert p.returncode == 0 and "manager.flakes" in p.stdout, p


def test_a_must_fix_without_a_commit_is_kept_apart_from_the_pinned_markers():
    cs = [marker("factory-approved", SHAS[1]), {"body": "<!-- factory-mustfix -->\nfix it", "created_at": "2020-01-02T00:00:00Z"}]
    got, _ = pulls_json(scenario({1: run(1, [check("t")], cs)}))
    assert {m["kind"] for m in got[1]["markers"]} == {"factory-approved", "factory-mustfix"}, got[1]["markers"]
    assert got[1]["next"]["text"] == "waiting for agent", got[1]  # it holds the merge, as at the gate
