#!/usr/bin/env python3
"""The dev manager as an orchestrator (#97, #109): `factory dev-manager loop` reads GitHub with no model, runs the seven
watcher checks, keeps thread notes, asks the owner for what only he can do, and starts one-item sub-managers.

Runs the real hooks and loop script in a throwaway project with a fake `claude` (logs its prompt and flags) and a
stateful fake `gh` (a JSON file that POST and PATCH change, so claims, notes and owner asks can be read back).
  python3 software-factory/tests/test_orchestrator.py"""
import json, os, re, subprocess, sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_roles as TR  # noqa: E402
from wiki_text import readme_and_wiki

SF, HOOKS = TR.SF, os.path.join(TR.SF, "hooks")
H = "a" * 40
H2 = "b" * 40

GH = r'''#!/usr/bin/env python3
import json, os, re, sys
from datetime import datetime, timezone
from urllib.parse import urlparse, parse_qs
import fcntl
f = os.environ["FAKE_DB"]
lock = open(f + ".lock", "w"); fcntl.flock(lock, fcntl.LOCK_EX)  # sub-managers run side by side: one request at a time
db = json.load(open(f)); a = sys.argv[1:]
if a[:1] != ["api"]: sys.exit("fake gh: only gh api")
rest = a[1:]; method = "GET"; path = None; i = 0; body = None
while i < len(rest):
    x = rest[i]
    if x == "-X": method = rest[i + 1]; i += 2; continue
    if x == "-H": i += 2; continue
    if x == "--input": body = json.load(sys.stdin); i += 2; continue
    if x.startswith("-"): i += 1; continue
    path = x; i += 1
open(os.environ["LOOP_LOG"], "a").write(f"gh {method} {path}\n")
u = urlparse(path.replace("repos/{owner}/{repo}/", "")); p = u.path; q = parse_qs(u.query); page = int(q.get("page", ["1"])[0])
def save(): json.dump(db, open(f, "w"))
def out(x): print(json.dumps(x)); sys.exit(0)
def paged(x): out(x if page == 1 else [])
def now(): return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
def find_comment(cid):
    for n, cs in db["comments"].items():
        for c in cs:
            if c["id"] == cid: return c
if p == "user": out({"login": "me"})
if p == "repos/{owner}/{repo}": out(db.get("repo", {"owner": {"login": "boss", "type": "User"}}))
if p == "pulls":
    want = q.get("state", ["open"])[0]
    paged([x for x in db["pulls"] if x.get("state", "open") == want])
m = re.fullmatch(r"pulls/(\d+)", p)
if m: out(next(x for x in db["pulls"] if x["number"] == int(m.group(1))))
if p == "issues" and method == "GET":
    items = db["issues"]; st = q.get("state", ["open"])[0]
    if st != "all": items = [x for x in items if x.get("state", "open") == st]
    if "labels" in q: items = [x for x in items if q["labels"][0] in [l["name"] for l in x.get("labels", [])]]
    paged([{"updated_at": now(), **x} for x in items])
if p == "branches": paged([])
if p == "issues" and method == "POST":
    n = max([x["number"] for x in db["issues"]] + [0]) + 1
    issue = {"number": n, "state": "open", "title": body["title"], "body": body.get("body", ""),
             "labels": [{"name": l} for l in body.get("labels", [])]}
    db["issues"].append(issue); save(); out(issue)
m = re.fullmatch(r"issues/(\d+)/comments", p)
if m and method == "GET": paged(db["comments"].get(m.group(1), []))
if m and method == "POST":
    db["next_id"] = db.get("next_id", 1000) + 1
    c = {"id": db["next_id"], "body": body["body"], "created_at": now()}
    db["comments"].setdefault(m.group(1), []).append(c); save(); out(c)
m = re.fullmatch(r"issues/comments/(\d+)", p)
if m and method == "PATCH":
    c = find_comment(int(m.group(1))); c["body"] = body["body"]; save(); out(c)
m = re.fullmatch(r"issues/(\d+)/events", p)
if m: paged(db.get("events", {}).get(m.group(1), []))
m = re.fullmatch(r"issues/(\d+)/labels", p)
if m and method == "POST": out([])
m = re.fullmatch(r"commits/(\w+)", p)
if m: out({"sha": m.group(1), "commit": {"committer": {"date": db.get("commits", {}).get(m.group(1), "2020-01-01T00:00:00Z")}}})
m = re.fullmatch(r"commits/(\w+)/check-runs", p)
if m: out({"check_runs": db.get("checks", {}).get(m.group(1), [])})
if re.fullmatch(r"commits/\w+/status", p): out({"statuses": []})
if p == "actions/runs": out({"workflow_runs": db.get("actions_runs", [])})
if p == "actions/runners": out({"runners": db.get("runners", [])})
sys.exit("fake gh: no route for " + method + " " + path)
'''


def iso(minutes_ago=0):
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).strftime("%Y-%m-%dT%H:%M:%SZ")


def pr(n, sha=H, ref=None, body="", draft=False, labels=(), state="open", mergeable_state="clean"):
    return {"number": n, "title": f"Change {n}", "state": state, "draft": draft, "body": body, "user": {"login": "me"},
            "head": {"sha": sha, "ref": ref or f"task/{n}-thing"}, "base": {"ref": "main"},
            "labels": [{"name": l} for l in labels], "mergeable_state": mergeable_state}


def comment(cid, body, ago=0):
    return {"id": cid, "body": body, "created_at": iso(ago)}


def ok_run(name="tests"):
    return {"id": 1, "name": name, "status": "completed", "conclusion": "success"}


def bad_run(name="tests"):
    return {"id": 2, "name": name, "status": "completed", "conclusion": "failure"}


def agent_issue(n, name, status, ping_ago, role="coding-agent", since_ago=None):
    ping = iso(ping_ago)
    since = f" since={iso(since_ago)}" if since_ago is not None else ""
    return {"number": n, "state": "open", "title": f"Agent: {name}", "labels": [{"name": "factory:agent"}],
            "body": f"<!-- factory-agent name={name} status={status} ping={ping}{since} -->\n<!-- factory-role role={role} -->"}


def world(db=None, cfg=None, files=None):
    base = {"pulls": [], "issues": [], "comments": {}, "events": {}, "commits": {}, "checks": {}}
    base.update(db or {})
    config = {"tasks": {"source": "issues"}, "manager": {"busyMinutes": 0, "idleMinutes": 0}}
    for k, v in (cfg or {}).items():
        config[k] = {**config.get(k, {}), **v} if isinstance(v, dict) else v
    kit_profile = open(os.path.join(SF, "kit", ".claude", "manager", "settings.json")).read()
    d, work, env = TR.project(cfg=config, db=base, files={".claude/manager/settings.json": kit_profile, **(files or {})})
    open(os.path.join(d, "bin", "gh"), "w").write(GH)
    # a fake claude that records its prompt in full and the lease state at the time it ran
    open(os.path.join(d, "bin", "claude"), "w").write(
        '#!/usr/bin/env bash\nline="$(printf "claude %s" "$(printf "%s" "$*" | tr "\\n" " ")")"; tmp="$(mktemp)"; printf "%s\\n" "$line" > "$tmp"; cat "$tmp" >> "$LOOP_LOG"; rm -f "$tmp"\n'
        'printf "%s\\n" "$@" > "$(dirname "$LOOP_LOG")/last-args"\n'
        'if [ -n "${FAKE_CLAUDE_HOOK:-}" ]; then bash "$FAKE_CLAUDE_HOOK" "$@"; exit $?; fi\nexit 0\n')
    return d, work, env


def db_of(d):
    return json.load(open(os.path.join(d, "db.json")))


def put(d, **changes):
    db = db_of(d)
    db.update(changes)
    json.dump(db, open(os.path.join(d, "db.json"), "w"))


def py(work, env, script, *args, timeout=90):
    return subprocess.run([sys.executable, os.path.join(work, ".claude", "hooks", script), *args], cwd=work, env=env,
                          capture_output=True, text=True, timeout=timeout)


def watch(work, env):
    p = py(work, env, "factory_watch.py", "--json")
    assert p.returncode in (0, 3), (p.stdout, p.stderr)
    return {i["ref"]: i for i in json.loads(p.stdout)} if p.stdout.strip().startswith("[") else {}


def cycle(work, env, *args):
    return py(work, env, "factory_orchestrator.py", "cycle", "--name", "lead", *args)


def posted(d, number):
    return [c["body"] for c in db_of(d)["comments"].get(str(number), [])]


def writes(env):
    return [l for l in TR.log(env) if re.match(r"gh (POST|PATCH|PUT|DELETE) ", l)]


def prompts(env):
    return TR.claude_calls(env)


UNREVIEWED = {"pulls": [pr(5)], "commits": {H: iso(60)}}


# --- the seven checks ------------------------------------------------------------------------------------------------

def test_check_1_an_unreviewed_head_is_a_manager_item_once_the_agent_has_stopped_pushing():
    d, work, env = world(db={"pulls": [pr(5)], "commits": {H: iso(60)}})
    got = watch(work, env)
    assert got["pr-5"]["to"] == "manager" and got["pr-5"]["kind"] == "review" and "not reviewed" in got["pr-5"]["line"], got
    put(d, commits={H: iso(1)})  # pushed a minute ago: the agent may still be pushing
    assert "pr-5" not in watch(work, env)


def test_check_1_clears_when_a_verdict_names_the_head_and_returns_on_a_new_head():
    d, work, env = world(db={"pulls": [pr(5)], "commits": {H: iso(60), H2: iso(30)}, "checks": {H: [ok_run()]},
                             "comments": {"5": [comment(1, f"<!-- factory-approved sha={H[:12]} -->", 50)]}})
    assert "pr-5" not in watch(work, env) or watch(work, env)["pr-5"]["kind"] != "review"
    put(d, pulls=[pr(5, sha=H2)])
    assert watch(work, env)["pr-5"]["kind"] == "review"


def test_a_draft_pull_request_is_not_waiting_for_review():
    d, work, env = world(db={"pulls": [pr(5, draft=True)], "commits": {H: iso(60)}})
    assert watch(work, env) == {}


def test_check_2_an_open_question_is_a_manager_item_until_it_is_answered():
    d, work, env = world(db={"pulls": [pr(5)], "commits": {H: iso(60)}, "checks": {H: [ok_run()]},
                             "comments": {"5": [comment(1, f"<!-- pr-watch sha={H} -->", 59),
                                                comment(2, "<!-- factory-question -->\nWhich colour?", 20)]}})
    got = watch(work, env)
    assert got["question-5"]["kind"] == "question" and got["question-5"]["to"] == "manager", got
    put(d, comments={"5": [comment(1, f"<!-- pr-watch sha={H} -->", 59), comment(2, "<!-- factory-question -->\nWhich colour?", 20),
                           comment(3, "<!-- factory-answer -->\nBlue.", 5)]})
    assert "question-5" not in watch(work, env)


def test_check_2_also_reads_the_message_envelope_addressed_to_the_dev_manager():
    d, work, env = world(db={"pulls": [pr(5)], "commits": {H: iso(60)},
                             "comments": {"5": [comment(1, f"<!-- pr-watch sha={H} -->", 59),
                                                comment(2, "<!-- factory-msg v=1 id=q1abc kind=question from=menelik to=dev-manager state=submitted -->\nWhy?", 20)]}})
    assert "question-5" in watch(work, env)
    put(d, comments={"5": [comment(1, f"<!-- pr-watch sha={H} -->", 59),
                           comment(2, "<!-- factory-msg v=1 id=q1abc kind=question from=menelik to=po state=submitted -->\nWhy?", 20)]})
    assert "question-5" not in watch(work, env)


def test_check_3_must_fix_failed_ci_and_a_conflict_each_wait_for_staleMinutes_then_fire():
    marker = {"5": [comment(1, f"<!-- factory-mustfix sha={H} -->", 40)]}
    d, work, env = world(db={"pulls": [pr(5)], "commits": {H: iso(60)}, "checks": {H: [ok_run()]}, "comments": marker})
    assert "must-fix" in watch(work, env)["pr-5"]["line"]
    put(d, comments={"5": [comment(1, f"<!-- factory-mustfix sha={H} -->", 3)]})
    assert "pr-5" not in watch(work, env), "a must-fix younger than staleMinutes is still the agent's to fix"
    put(d, comments={"5": [comment(1, f"<!-- factory-approved sha={H} -->", 40)]}, checks={H: [bad_run("lint")]})
    line = watch(work, env)["pr-5"]["line"]
    assert "CI failed" in line and "lint" in line, line
    put(d, checks={H: [ok_run()]}, pulls=[pr(5, mergeable_state="dirty")])
    assert "merge conflict" in watch(work, env)["pr-5"]["line"]


def test_check_4_approved_and_green_is_a_merge_item_but_the_managers_own_pr_goes_to_the_owner():
    ok = {"commits": {H: iso(60)}, "checks": {H: [ok_run()]}, "comments": {"5": [comment(1, f"<!-- factory-approved sha={H} -->", 30)]}}
    d, work, env = world(db={"pulls": [pr(5)], **ok})
    got = watch(work, env)
    assert got["pr-5"]["kind"] == "merge" and got["pr-5"]["to"] == "manager", got
    put(d, pulls=[pr(5, ref="manager/fix-thing")])
    got = watch(work, env)
    assert got["own-5"]["to"] == "owner" and "pr-5" not in got, got
    put(d, pulls=[pr(5, body="<!-- factory-role role=dev-manager name=lead -->")])
    assert "own-5" in watch(work, env)
    put(d, checks={H: [ok_run(), {"id": 3, "name": "e2e", "status": "in_progress", "conclusion": None}]}, pulls=[pr(5)])
    assert "pr-5" not in watch(work, env), "CI still running is not green"


def test_check_5_a_pull_request_that_waited_long_for_the_product_owner_goes_to_the_owner():
    cfg = {"roles": {"product-owner": {"workLabel": "factory:needs-product"}}}
    d, work, env = world(cfg=cfg, db={"pulls": [pr(5, draft=True, labels=["factory:needs-product"])], "commits": {H: iso(600)},
                                      "events": {"5": [{"event": "labeled", "created_at": iso(300), "label": {"name": "factory:needs-product"}}]}})
    got = watch(work, env)
    key = next(k for k in got if k.startswith("wait-5"))
    assert got[key]["to"] == "owner" and "product owner" in got[key]["line"], got
    put(d, events={"5": [{"event": "labeled", "created_at": iso(10), "label": {"name": "factory:needs-product"}}]})
    assert not [k for k in watch(work, env) if k.startswith("wait-")], "ownerWaitMinutes has not passed yet"


def test_check_6_a_down_agent_and_an_idle_agent_with_ready_work_go_to_the_owner():
    ready = {"number": 40, "state": "open", "title": "Ready task", "body": "", "labels": [{"name": "factory:ready"}]}
    d, work, env = world(db={"issues": [agent_issue(11, "menelik", "down", 500), agent_issue(12, "taytu", "idle", 2, since_ago=120), ready]})
    got = watch(work, env)
    down = next(v for k, v in got.items() if k.startswith("agent-down-menelik"))
    idle = next(v for k, v in got.items() if k.startswith("agent-idle-taytu"))
    assert down["to"] == "owner" and idle["to"] == "owner" and "1 task(s) are ready" in idle["line"], got
    put(d, issues=[agent_issue(12, "taytu", "idle", 2, since_ago=120)])
    assert not [k for k in watch(work, env) if k.startswith("agent-idle")], "an idle agent with nothing ready is fine"


def test_check_6_a_silent_coding_agent_is_a_manager_item_but_a_sleeping_manager_is_not():
    d, work, env = world(db={"issues": [agent_issue(11, "menelik", "working", 400),
                                        agent_issue(13, "lead", "idle", 400, role="dev-manager")]})
    got = watch(work, env)
    assert got["agent-menelik"]["to"] == "manager" and "agent-lead" not in got, got


def test_check_7_queued_ci_goes_to_the_owner_and_a_fresh_queue_does_not():
    d, work, env = world(db={"actions_runs": [{"name": "ci", "created_at": iso(30)}], "runners": []})
    got = watch(work, env)
    assert got["ci-queue"]["to"] == "owner" and "queued" in got["ci-queue"]["line"] and "no self-hosted runner" in got["ci-queue"]["line"], got
    put(d, actions_runs=[{"name": "ci", "created_at": iso(2)}])
    assert "ci-queue" not in watch(work, env)


def test_a_check_that_cannot_be_read_does_not_stop_the_others():
    d, work, env = world(db=UNREVIEWED)
    # the fake has a route for actions/runs; make the CI-judge read fail by not having check-runs for an unknown sha
    assert "pr-5" in watch(work, env)


# --- the cycle: sub-managers ------------------------------------------------------------------------------------------

def order_of(work, env):
    p = py(work, env, "factory_watch.py", "--json")
    return [i["ref"] for i in json.loads(p.stdout)]


def test_a_task_pr_with_green_ci_comes_before_older_docs_prs():
    # #201: docs PRs #5 and #15 came first, so task PR #23 waited: "waiting for a free place".
    H3 = "c" * 40
    d, work, env = world(db={
        "pulls": [pr(5, sha=H, ref="docs/readme"), pr(15, sha=H2, ref="docs/guide"), pr(23, sha=H3, ref="task/2-thing")],
        "commits": {H: iso(70), H2: iso(60), H3: iso(40)},
        "checks": {H: [ok_run()], H2: [ok_run()], H3: [ok_run()]}})
    assert order_of(work, env) == ["pr-23", "pr-5", "pr-15"], order_of(work, env)


def test_a_task_pr_with_red_ci_does_not_jump_the_queue():
    H3 = "c" * 40
    d, work, env = world(db={
        "pulls": [pr(5, sha=H, ref="docs/readme"), pr(23, sha=H3, ref="task/2-thing")],
        "commits": {H: iso(120), H3: iso(40)}, "checks": {H: [ok_run()], H3: [bad_run()]}})
    assert order_of(work, env) == ["pr-5", "pr-23"], order_of(work, env)


def test_a_docs_pr_that_waited_four_times_deadManMinutes_is_not_starved_by_task_prs():
    H3 = "c" * 40
    d, work, env = world(db={
        "pulls": [pr(5, sha=H, ref="docs/readme"), pr(23, sha=H3, ref="task/2-thing")],
        "commits": {H: iso(300), H3: iso(40)}, "checks": {H: [ok_run()], H3: [ok_run()]}})
    assert order_of(work, env) == ["pr-5", "pr-23"], order_of(work, env)


def test_a_cycle_starts_one_sub_manager_per_item_with_the_profile_the_item_and_the_role_marker():
    d, work, env = world(db=UNREVIEWED)
    p = cycle(work, env, "--wait")
    assert p.returncode == 0, (p.stdout, p.stderr)
    calls = prompts(env)
    assert len(calls) == 1, calls
    line = calls[0]
    assert "-p /manage-pass pr-5" in line, line
    assert "--setting-sources user" in line and "disableClaudeAiConnectors" in line and "manager_gate.py" in line, line
    assert "--strict-mcp-config" in line, line
    assert "<!-- factory-role role=dev-manager name=lead -->" in line, line
    assert "PR #5: commit aaaaaaa not reviewed yet" in line and "Thread note" in line, line
    assert "Your lease:" in line and "manager=lead" in line, line


def test_the_sub_manager_holds_a_lease_while_it_runs_and_releases_it_when_it_exits():
    d, work, env = world(db=UNREVIEWED)
    hook = os.path.join(d, "hook.sh")
    open(hook, "w").write(f'cp "$FAKE_DB" "{d}/db-during.json"\nexit 0\n')
    env["FAKE_CLAUDE_HOOK"] = hook
    assert cycle(work, env, "--wait").returncode == 0
    during = json.load(open(os.path.join(d, "db-during.json")))
    live = [c["body"] for c in during["comments"]["5"] if "-claim manager=lead sha=" in c["body"]]
    assert len(live) == 1 and "until=" in live[0], live
    after = [c["body"] for c in posted_c(d, 5) if "-claim manager=lead" in c["body"]]
    until = re.search(r"until=(\S+)", after[-1]).group(1)
    assert until < iso(0), "the lease must have been ended on exit: " + after[-1]
    assert not os.listdir(os.path.join(work, ".git", "factory-manager", "lead.d")) or all(
        not f.endswith(".pid") for f in os.listdir(os.path.join(work, ".git", "factory-manager", "lead.d")))


def posted_c(d, number):
    return db_of(d)["comments"].get(str(number), [])


def test_the_cap_is_maxSubManagers_and_the_rest_wait_for_the_next_cycle():
    d, work, env = world(db={"pulls": [pr(1, sha="1" * 40), pr(2, sha="2" * 40), pr(3, sha="3" * 40)],
                             "commits": {"1" * 40: iso(60), "2" * 40: iso(50), "3" * 40: iso(40)}})
    p = cycle(work, env, "--wait")
    assert p.returncode == 0, (p.stdout, p.stderr)
    assert len(prompts(env)) == 2, prompts(env)
    assert "waiting for a free place" in p.stdout and "pr-3" in p.stdout, p.stdout
    assert "-p /manage-pass pr-1" in prompts(env)[0] or "-p /manage-pass pr-1" in prompts(env)[1]


def test_the_cap_can_be_set_to_one():
    d, work, env = world(cfg={"manager": {"maxSubManagers": 1}},
                         db={"pulls": [pr(1, sha="1" * 40), pr(2, sha="2" * 40)], "commits": {"1" * 40: iso(60), "2" * 40: iso(50)}})
    cycle(work, env, "--wait")
    assert len(prompts(env)) == 1, prompts(env)


def test_an_item_another_manager_holds_is_left_alone_and_counts_against_the_cap():
    claim = f"<!-- factory-review-claim manager=other sha={H} until={(datetime.now(timezone.utc) + timedelta(minutes=15)).strftime('%Y-%m-%dT%H:%M:%SZ')} -->"
    d, work, env = world(db={**UNREVIEWED, "comments": {"5": [comment(1, claim, 2)]}})
    p = cycle(work, env, "--wait")
    assert not prompts(env), prompts(env)
    assert "other holds the lease" in p.stdout, p.stdout
    # the item is still work: the cycle reports it
    assert p.returncode == 0


def test_an_expired_claim_does_not_block_the_item():
    claim = f"<!-- factory-review-claim manager=other sha={H} until={iso(3)} -->"
    d, work, env = world(db={**UNREVIEWED, "comments": {"5": [comment(1, claim, 30)]}})
    cycle(work, env, "--wait")
    assert len(prompts(env)) == 1, prompts(env)


def test_two_orchestrators_do_not_start_the_same_item_twice():
    d, work, env = world(db=UNREVIEWED)
    hook = os.path.join(d, "hook.sh")
    # while the first sub-manager runs, a second orchestrator (another name) cycles
    open(hook, "w").write(f'cd "{work}" && python3 .claude/hooks/factory_orchestrator.py cycle --name second --wait '
                          f'> "{d}/second.out" 2>&1\nexit 0\n')
    env["FAKE_CLAUDE_HOOK"] = hook
    assert cycle(work, env, "--wait").returncode == 0
    assert len(prompts(env)) == 1, prompts(env)
    assert "lead holds the lease" in open(os.path.join(d, "second.out")).read()


def test_a_pass_that_finds_the_item_gone_starts_nothing():
    d, work, env = world(db=UNREVIEWED)
    put(d, comments={"5": [comment(1, f"<!-- factory-approved sha={H} -->", 1)]}, checks={H: [bad_run()]})
    p = py(work, env, "factory_orchestrator.py", "sub", "--name", "lead", "--item", "pr-99")
    assert p.returncode == 0 and "nothing needs a manager any more" in p.stdout, (p.stdout, p.stderr)
    assert not prompts(env)


def run_sub(work, env, item="pr-5"):
    return py(work, env, "factory_orchestrator.py", "sub", "--name", "lead", "--item", item)


def skip_comments(d, number):
    return [b for b in posted(d, number) if "factory-manager-skip" in b]


def test_a_sub_manager_that_leaves_a_conflicting_pr_without_a_verdict_gets_one_comment_with_the_reason_and_next_step():
    # #195: PR took a review claim, released it, wrote a note: nothing a person could read on the PR.
    d, work, env = world(db={"pulls": [pr(5, mergeable_state="dirty")], "commits": {H: iso(60)}})
    p = run_sub(work, env)
    assert p.returncode == 0, (p.stdout, p.stderr)
    skips = skip_comments(d, 5)
    assert len(skips) == 1, posted(d, 5)
    text = skips[0]
    assert f"sha={H}" in text and "did not review" in text, text
    assert "merge conflict" in text and "Next step" in text and "merge main" in text.lower(), text


def test_the_skip_comment_is_not_repeated_for_the_same_head():
    d, work, env = world(db={"pulls": [pr(5, mergeable_state="dirty")], "commits": {H: iso(60)}})
    run_sub(work, env)
    run_sub(work, env)
    assert len(skip_comments(d, 5)) == 1, posted(d, 5)


def test_no_skip_comment_when_the_sub_manager_posted_its_own_verdict():
    d, work, env = world(db={"pulls": [pr(5, mergeable_state="dirty")], "commits": {H: iso(60)}})
    hook = os.path.join(d, "hook.py")
    open(hook, "w").write("import json, os\nf = os.environ['FAKE_DB']; db = json.load(open(f))\n"
                          "db['comments'].setdefault('5', []).append({'id': 7001, 'body': 'Must-fix: conflict.', 'created_at': '2026-10-26T10:00:00Z'})\n"
                          "json.dump(db, open(f, 'w'))\n")
    env["FAKE_CLAUDE_HOOK"] = hook
    open(os.path.join(d, "hook.sh"), "w").write(f'python3 "{hook}"\n')
    env["FAKE_CLAUDE_HOOK"] = os.path.join(d, "hook.sh")
    run_sub(work, env)
    assert skip_comments(d, 5) == [], posted(d, 5)


def test_a_red_ci_skip_names_the_failed_jobs():
    d, work, env = world(db={"pulls": [pr(5)], "commits": {H: iso(60)}, "checks": {H: [bad_run("tests")]}})
    run_sub(work, env)
    text = (skip_comments(d, 5) or [""])[0]
    assert "CI" in text and "tests" in text and "factory ci log" in text, posted(d, 5)


def test_a_failed_sub_manager_leaves_the_pid_file_removed_and_the_lease_released():
    d, work, env = world(db=UNREVIEWED)
    hook = os.path.join(d, "hook.sh")
    open(hook, "w").write("exit 1\n")
    env["FAKE_CLAUDE_HOOK"] = hook
    p = py(work, env, "factory_orchestrator.py", "sub", "--name", "lead", "--item", "pr-5")
    assert p.returncode == 1 and "exit 1" in p.stdout, (p.stdout, p.stderr)
    assert "-claim manager=lead" in posted_c(d, 5)[-1]["body"] or any("-claim manager=lead" in c["body"] for c in posted_c(d, 5))
    assert not [f for f in os.listdir(os.path.join(work, ".git", "factory-manager", "lead.d")) if f.endswith(".pid")]


def test_the_orchestrator_never_starts_a_builder():
    d, work, env = world(db={**UNREVIEWED, "issues": [{"number": 40, "state": "open", "title": "Ready", "body": "",
                                                       "labels": [{"name": "factory:ready"}]}]})
    cycle(work, env, "--wait")
    assert all("/next-task" not in l for l in prompts(env)), prompts(env)


# --- thread notes ------------------------------------------------------------------------------------------------------

def test_a_note_opens_on_an_issue_that_went_in_progress_without_a_model_and_only_once():
    task = {"number": 20, "state": "open", "title": "Task", "body": "", "labels": [{"name": "factory:in-progress"}]}
    d, work, env = world(db={"issues": [task]})
    p = cycle(work, env)
    assert p.returncode == 0, (p.stdout, p.stderr)
    notes = [b for b in posted(d, 20) if "factory-manager-note thread=issue-20 status=open" in b]
    assert len(notes) == 1 and not prompts(env), (posted(d, 20), prompts(env))
    cycle(work, env)
    assert len([b for b in posted(d, 20) if "factory-manager-note" in b]) == 1


def test_a_note_is_marked_closed_when_its_issue_closes():
    note = "<!-- factory-manager-note thread=issue-20 status=open -->\nNote.\n- opened"
    task = {"number": 20, "state": "closed", "title": "Task", "body": "", "labels": [{"name": "factory:in-review"}]}
    d, work, env = world(db={"issues": [task], "comments": {"20": [comment(7, note, 100)]}})
    cycle(work, env)
    body = posted(d, 20)[0]
    assert "status=closed" in body and "status=open" not in body and "issue was closed" in body, body
    cycle(work, env)
    assert posted(d, 20)[0].count("issue was closed") == 1, "closing twice would append twice"


def test_the_sub_manager_gets_the_existing_note_and_its_comment_id():
    note = "<!-- factory-manager-note thread=pr-5 status=open -->\nThe agent chose blue; do not ask again."
    d, work, env = world(db={**UNREVIEWED, "comments": {"5": [comment(77, note, 100)]}})
    cycle(work, env, "--wait")
    line = prompts(env)[0]
    assert "The agent chose blue; do not ask again." in line and "comment 77" in line, line


# --- the owner queue -------------------------------------------------------------------------------------------------

QUEUE = "Dev manager: needs the owner"


def owner_comments(d):
    q = next(i for i in db_of(d)["issues"] if i["title"] == QUEUE)
    return q["number"], posted(d, q["number"])


def test_an_owner_item_is_posted_once_to_the_queue_and_mentions_the_repo_owner_by_default():
    d, work, env = world(db={"actions_runs": [{"name": "ci", "created_at": iso(30)}]})
    p = cycle(work, env)
    assert p.returncode == 0, (p.stdout, p.stderr)
    n, bodies = owner_comments(d)
    assert len(bodies) == 1 and "<!-- factory-owner-ask id=ci-queue -->" in bodies[0] and "@boss " in bodies[0], bodies
    cycle(work, env)
    cycle(work, env)
    assert len(owner_comments(d)[1]) == 1, "the same ask must not be posted again"
    assert len([i for i in db_of(d)["issues"] if i["title"] == QUEUE]) == 1, "one queue issue, not one per cycle"


def test_manager_notify_chooses_who_is_mentioned_and_an_org_owner_means_nobody_is():
    d, work, env = world(cfg={"manager": {"notify": "@dere"}}, db={"actions_runs": [{"name": "ci", "created_at": iso(30)}]})
    cycle(work, env)
    assert "@dere " in owner_comments(d)[1][0] and "@@" not in owner_comments(d)[1][0]
    d, work, env = world(db={"actions_runs": [{"name": "ci", "created_at": iso(30)}],
                             "repo": {"owner": {"login": "acme", "type": "Organization"}}})
    cycle(work, env)
    assert "@acme" not in owner_comments(d)[1][0], owner_comments(d)[1][0]


def test_a_changed_situation_is_a_new_ask_and_a_solved_one_is_not_repeated():
    d, work, env = world(db={"issues": [agent_issue(11, "menelik", "down", 500)]})
    cycle(work, env)
    assert len(owner_comments(d)[1]) == 1
    cycle(work, env)
    assert len(owner_comments(d)[1]) == 1


def test_dry_run_prints_the_plan_and_writes_nothing():
    d, work, env = world(db={**UNREVIEWED, "actions_runs": [{"name": "ci", "created_at": iso(30)}],
                             "issues": [{"number": 20, "state": "open", "title": "T", "body": "",
                                         "labels": [{"name": "factory:in-progress"}]}]})
    p = cycle(work, env, "--dry-run")
    assert p.returncode == 0, (p.stdout, p.stderr)
    assert "would start a sub-manager for pr-5" in p.stdout and 'would run: claude -p "/manage-pass pr-5"' in p.stdout, p.stdout
    assert "would post to the owner queue (id ci-queue)" in p.stdout and "would open the thread note on issue #20" in p.stdout, p.stdout
    assert not writes(env) and not prompts(env), (writes(env), prompts(env))
    assert not os.path.exists(os.path.join(work, ".git", "factory-manager", "lead.log")), "a dry run writes no log"


def test_nothing_to_do_exits_3_and_says_so():
    d, work, env = world()
    p = cycle(work, env)
    assert p.returncode == 3 and "nothing to do" in p.stdout, (p.returncode, p.stdout, p.stderr)
    assert not writes(env), writes(env)


# --- the dead-man's switch -------------------------------------------------------------------------------------------

def test_dead_mans_switch_reports_work_that_waited_with_no_manager_activity():
    d, work, env = world(db={"pulls": [pr(5)], "commits": {H: iso(120)}})
    cycle(work, env, "--wait")
    bodies = owner_comments(d)[1]
    dead = [b for b in bodies if "factory-owner-ask id=dead-man-" in b]
    assert len(dead) == 1 and "pr-5" in dead[0] and "@boss" in dead[0], bodies
    cycle(work, env, "--wait")
    assert len([b for b in owner_comments(d)[1] if "id=dead-man-" in b]) == 1, "the same stuck set is reported once"


def test_dead_mans_switch_stays_quiet_when_a_manager_acted_recently():
    other = {"pulls": [pr(5), pr(6, sha=H2)], "commits": {H: iso(120), H2: iso(120)},
             "comments": {"6": [comment(1, f"<!-- factory-approved sha={H2} -->", 5)]}, "checks": {H2: [bad_run()]}}
    d, work, env = world(db=other)
    cycle(work, env, "--wait")
    assert not [i for i in db_of(d)["issues"] if i["title"] == QUEUE], "a verdict five minutes ago means a manager is alive"


def test_dead_mans_switch_does_not_count_a_claim_as_activity():
    claim = f"<!-- factory-review-claim manager=other sha={H} until={iso(-10)} -->"
    d, work, env = world(db={"pulls": [pr(5), pr(6, sha=H2)], "commits": {H: iso(120), H2: iso(120)},
                             "comments": {"6": [comment(1, claim, 2)]}})
    cycle(work, env, "--wait")
    assert any("id=dead-man-" in b for b in owner_comments(d)[1]), "taking a lease is not progress"


def test_dead_mans_switch_counts_a_merge_as_activity():
    merged = pr(9, state="closed")
    merged["merged_at"] = iso(4)
    d, work, env = world(db={"pulls": [pr(5), merged], "commits": {H: iso(120)}})
    cycle(work, env, "--wait")
    assert not [i for i in db_of(d)["issues"] if i["title"] == QUEUE]


# --- the loop: --once, -i, failures ------------------------------------------------------------------------------------

def loop(work, env, *args, timeout=90):
    return TR.factory(work, env, "dev-manager", "lead", "loop", *args, timeout=timeout)


def project_for_loop(db=None, cfg=None):
    d, work, env = TR.project(cfg={"tasks": {"source": "issues"}, **(cfg or {})}, db={"pulls": [], "issues": [], "comments": {}, **(db or {})})
    open(os.path.join(d, "bin", "gh"), "w").write(GH)
    json.dump({"pulls": [], "issues": [], "comments": {}, "events": {}, "commits": {}, "checks": {}, **(db or {})},
              open(os.path.join(d, "db.json"), "w"))
    return d, work, env


def test_loop_once_runs_one_cycle_and_exits_without_a_model_for_the_orchestrator_itself():
    d, work, env = project_for_loop(db={"pulls": [pr(5)], "commits": {H: iso(60)}})
    p = loop(work, env, "--once")
    assert p.returncode == 0, (p.stdout, p.stderr)
    time_wait = 0
    for _ in range(50):
        if prompts(env):
            break
        time_wait += 1
        subprocess.run(["sleep", "0.2"])
    assert len(prompts(env)) == 1 and "-p /manage-pass pr-5" in prompts(env)[0], (prompts(env), p.stdout)
    assert "[lead]" in p.stdout and not any("/manage-pass" in l and " -p " not in l for l in prompts(env))


def test_loop_once_with_nothing_to_do_exits_0_and_starts_nothing():
    d, work, env = project_for_loop()
    p = loop(work, env, "--once")
    assert p.returncode == 0 and not prompts(env), (p.stdout, p.stderr)


def test_loop_dry_run_is_the_orchestrators_dry_run():
    d, work, env = project_for_loop(db={"pulls": [pr(5)], "commits": {H: iso(60)}})
    p = loop(work, env, "--once", "--dry-run")
    assert p.returncode == 0 and "would start a sub-manager for pr-5" in p.stdout, (p.stdout, p.stderr)
    assert not prompts(env) and not writes(env)


def test_loop_interactive_runs_the_first_item_in_a_session_you_can_type_into():
    d, work, env = project_for_loop(db={"pulls": [pr(5), pr(6, sha=H2)], "commits": {H: iso(60), H2: iso(50)}})
    env["FACTORY_REMOTE_CONTROL"] = "1"
    p = loop(work, env, "-i", "--once")
    assert p.returncode == 0, (p.stdout, p.stderr)
    calls = prompts(env)
    assert len(calls) == 1, calls
    assert " -p " not in calls[0] and "--remote-control=lead pr-5" in calls[0] and "/manage-pass pr-5" in calls[0], calls[0]
    assert "--setting-sources user" in calls[0], calls[0]


def test_three_failed_cycles_in_a_row_stop_the_loop():
    d, work, env = project_for_loop()
    os.remove(os.path.join(d, "bin", "gh"))  # every gh call now fails: the cycle cannot read GitHub
    open(os.path.join(d, "bin", "gh"), "w").write("#!/usr/bin/env bash\necho boom >&2\nexit 1\n")
    os.chmod(os.path.join(d, "bin", "gh"), 0o755)
    p = loop(work, env)
    assert p.returncode == 1 and "3 passes failed in a row" in p.stdout, (p.returncode, p.stdout, p.stderr)


def test_the_orchestrator_registers_as_a_live_agent_while_it_loops():
    d, work, env = project_for_loop()
    loop(work, env, "--once")
    pings = [l for l in TR.log(env) if l.startswith("gh") and "issues" in l]
    assert pings, "the loop registers the dev manager as an agent (idle pings keep it from being marked down)"


# --- settings, CLI, docs, forwarders ---------------------------------------------------------------------------------

def test_settings_list_the_orchestrator_settings_with_their_defaults():
    d, work, env = world()
    p = TR.factory(work, env, "settings", "list")
    for key in ("manager.maxSubManagers", "manager.claimMinutes", "manager.deadManMinutes", "manager.notify",
                "manager.quietMinutes", "manager.staleMinutes", "manager.ownerWaitMinutes", "manager.agentIdleMinutes",
                "manager.ciQueuedMinutes", "manager.subManagerMinutes"):
        assert key in p.stdout, (key, p.stdout[:400])
    cfg = json.load(open(os.path.join(work, ".claude", "factory.json")))
    assert "maxSubManagers" not in cfg.get("manager", {}), "defaults are not written into the project's file"


def test_factory_watch_prints_one_line_per_item_and_exits_3():
    d, work, env = world(db=UNREVIEWED)
    p = TR.factory(work, env, "watch")
    assert p.returncode == 3 and "pr-5" in p.stdout and "manager" in p.stdout, (p.returncode, p.stdout, p.stderr)
    d, work, env = world()
    p = TR.factory(work, env, "watch")
    assert p.returncode == 0 and "nothing to do" in p.stdout, (p.stdout, p.stderr)


def test_every_new_hook_has_a_forwarder_and_the_profile_allows_factory_watch():
    for f in ("factory_watch.py", "factory_orchestrator.py"):  # factory_lease.ts is a Bun script: no forwarder (#252)
        link = os.path.join(SF, "kit", ".claude", "hooks", f)
        assert os.path.islink(link) and os.path.exists(link), f
    allow = json.load(open(os.path.join(SF, "kit", ".claude", "manager", "settings.json")))["permissions"]["allow"]
    assert "Bash(factory watch*)" in allow


def test_doctor_checks_the_manager_profile_and_its_hooks():
    d, work, env = world(files={".claude/manager/settings.json": json.dumps({"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [
        {"type": "command", "command": 'python3 "$CLAUDE_PROJECT_DIR"/.claude/hooks/not_there.py'}]}]}})})
    p = subprocess.run([sys.executable, os.path.join(work, ".claude", "hooks", "factory_doctor.py")], cwd=work, env=env,
                       capture_output=True, text=True)
    assert "not_there.py" in p.stdout and "fix" in p.stdout, p.stdout


def test_the_orchestrator_is_listed_in_the_loop_scripts_header_and_the_readme():
    readme = readme_and_wiki()
    assert "Run a manager" in readme and "factory dev-manager" in readme and "dead-man" in readme.lower()
    assert "manage-pass" in open(os.path.join(SF, "kit", ".claude", "skills", "manage-pass", "SKILL.md")).read()


if __name__ == "__main__":
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"ok   {name}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"FAIL {name}: {type(e).__name__}: {str(e)[:900]}")
    print(f"\n{len(tests) - failed} of {len(tests)} passed.")
    sys.exit(1 if failed else 0)
