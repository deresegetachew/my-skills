#!/usr/bin/env python3
"""The dev manager as an orchestrator (#97, #109): `factory dev-manager loop` reads GitHub with no model, runs the seven
watcher checks, keeps thread notes, asks the owner for what only he can do, and starts one-item sub-managers.

Runs the real hooks and loop script in a throwaway project with a fake `claude` (logs its prompt and flags) and a
stateful fake `gh` (a JSON file that POST and PATCH change, so claims, notes and owner asks can be read back).
The rest is in orchestrator.test.ts (#252); this case needs factory_doctor.
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


def test_doctor_checks_the_manager_profile_and_its_hooks():
    d, work, env = world(files={".claude/manager/settings.json": json.dumps({"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [
        {"type": "command", "command": 'python3 "$CLAUDE_PROJECT_DIR"/.claude/hooks/not_there.py'}]}]}})})
    p = subprocess.run([sys.executable, os.path.join(work, ".claude", "hooks", "factory_doctor.py")], cwd=work, env=env,
                       capture_output=True, text=True)
    assert "not_there.py" in p.stdout and "fix" in p.stdout, p.stdout
