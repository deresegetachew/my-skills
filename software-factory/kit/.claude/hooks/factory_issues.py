#!/usr/bin/env python3
"""Tasks as GitHub issues (`tasks.source: "issues"` in .claude/factory.json).

Each task is an open issue written from the factory-task template: what we're building, goals, acceptance
criteria and a checklist of todos. Labels carry the state, so the board and your phone show it:

  factory:ready        can be picked up            factory:in-review   its PR is open
  factory:in-progress  an agent is on it           factory:blocked     needs a person (the issue says why)
  agent:<name>         which agent has it          factory-hold        the dev manager is reviewing its PR

The branch is task/<issue number>-<short-name>, the PR says `Closes #<n>`, and merging the PR closes the issue.

  python3 .claude/hooks/factory_issues.py pick --agent taytu      the agent's own in-progress issue, else claim the
                                                                   next ready one: prints "issue-42 <title>"
  python3 .claude/hooks/factory_issues.py peek                     the next ready issue, without claiming it
  python3 .claude/hooks/factory_issues.py show 42                  title, labels and body
  python3 .claude/hooks/factory_issues.py tick 42 3                tick the 3rd checkbox (1-based) in the body
  python3 .claude/hooks/factory_issues.py review 42                in-progress -> in-review (after opening the PR)
  python3 .claude/hooks/factory_issues.py block 42 "needs the Stripe keys"
  python3 .claude/hooks/factory_issues.py release 42 ["why"]       back to ready, the agent's label off
  python3 .claude/hooks/factory_issues.py stale [--hours 3]        in-progress issues with no activity (dev manager)
  python3 .claude/hooks/factory_issues.py new --title T --body-file F [--milestone "Phase 3"] [--label L ...]
  python3 .claude/hooks/factory_issues.py setup                    create the labels
  python3 .claude/hooks/factory_issues.py list                     open task issues and their state

Claims are race-free across machines: a claim is labels plus a `<!-- factory-claim agent=<name> -->` comment, and
when two agents claim at once the earlier comment wins; the other takes its label off and picks again.
Everything goes through the GitHub REST API (`gh api`).
"""
import argparse, json, os, re, subprocess, sys, time
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from factory_config import load, task_labels  # noqa: E402

CLAIM = re.compile(r"<!--\s*factory-claim\s+agent=([\w.-]+)\s*-->")
RELEASE = re.compile(r"<!--\s*factory-release\s+agent=([\w.-]+)\s*-->")
DEPENDS = re.compile(r"depends on\s+((?:#\d+[\s,and]*)+)", re.I)
BOX = re.compile(r"^(\s*[-*]\s+\[)([ xX])(\]\s+)", re.M)
COLORS = {"ready": "0e8a16", "inProgress": "1d76db", "inReview": "5319e7", "blocked": "b60205"}


def gh(method, path, data=None, ok_404=False):
    args = ["gh", "api", "-X", method, path, "-H", "Accept: application/vnd.github+json"]
    if data is not None:
        args += ["--input", "-"]
    p = subprocess.run(args, input=json.dumps(data) if data is not None else None, capture_output=True, text=True)
    if p.returncode != 0:
        if ok_404 and ("404" in p.stderr or "Not Found" in p.stdout + p.stderr):
            return None
        raise SystemExit(f"gh api {method} {path} failed: {(p.stderr or p.stdout).strip()[:300]}")
    return json.loads(p.stdout) if p.stdout.strip() else None


def gh_all(path):
    out, page = [], 1
    while True:
        sep = "&" if "?" in path else "?"
        chunk = gh("GET", f"{path}{sep}per_page=100&page={page}") or []
        if not isinstance(chunk, list):
            # A redirect or error object is not an empty list: callers would act on "nothing there".
            raise SystemExit(f"gh api GET {path} answered something other than a list: {str(chunk)[:200]}")
        out += chunk
        if len(chunk) < 100:
            return out
        page += 1


def names(issue):
    return {label["name"] for label in issue.get("labels", [])}


def add_labels(n, labels):
    gh("POST", f"repos/{{owner}}/{{repo}}/issues/{n}/labels", {"labels": list(labels)})


def remove_label(n, label):
    from urllib.parse import quote
    gh("DELETE", f"repos/{{owner}}/{{repo}}/issues/{n}/labels/{quote(label, safe='')}", ok_404=True)


def comment(n, body):
    gh("POST", f"repos/{{owner}}/{{repo}}/issues/{n}/comments", {"body": body})


def task_issues(state="open", label=None):
    q = f"repos/{{owner}}/{{repo}}/issues?state={state}" + (f"&labels={label}" if label else "")
    return [i for i in gh_all(q) if "pull_request" not in i
            and (label == "factory:agent" or "factory:agent" not in names(i))]  # agent issues aren't tasks


def order(issue):
    """Milestones in the order they were made (Phase 3 before Phase 4), then issue number."""
    m = issue.get("milestone")
    return (m["number"] if m else 10**9, issue["number"])


def open_dependencies(issue, open_numbers, looked_up=None):
    """The issues and pull requests this one depends on ("Depends on #12, #14") that are still open. One of the
    open task issues in `open_numbers` is known; any other number (a pull request, an issue that isn't a task) is
    looked up once, since `open_numbers` holds no pull requests. A number that doesn't exist doesn't hold it back.
    `looked_up` caches the answers across issues."""
    deps = set()
    for group in DEPENDS.findall(issue.get("body") or ""):
        deps |= {int(d) for d in re.findall(r"#(\d+)", group)}
    looked_up = {} if looked_up is None else looked_up
    still_open = []
    for d in sorted(deps):
        if d not in open_numbers and d not in looked_up:
            found = gh("GET", f"repos/{{owner}}/{{repo}}/issues/{d}", ok_404=True)
            looked_up[d] = bool(found) and found.get("state") == "open"
        if d in open_numbers or looked_up[d]:
            still_open.append(d)
    return still_open


def claim_winner(n):
    """The agent whose claim comment came first since the last release, or None. Block and release both post a
    release, so an old claim never outlives them (unblock an issue with `release`, not by editing labels)."""
    winner = None
    for c in gh_all(f"repos/{{owner}}/{{repo}}/issues/{n}/comments"):
        body = c.get("body") or ""
        if RELEASE.search(body):
            winner = None
        m = CLAIM.search(body)
        if m and winner is None:
            winner = m.group(1)
    return winner


def ready_issues(cfg):
    L = task_labels(cfg)
    open_now = task_issues()
    open_numbers = {i["number"] for i in open_now}
    ready = [i for i in open_now if L["ready"] in names(i) and L["blocked"] not in names(i)
             and not any(x.startswith(L["agentPrefix"]) for x in names(i))]
    looked_up = {}
    return [i for i in sorted(ready, key=order) if not open_dependencies(i, open_numbers, looked_up)]


def pick(cfg, agent):
    L = task_labels(cfg)
    mine = L["agentPrefix"] + agent
    own = [i for i in task_issues(label=mine) if L["inProgress"] in names(i)]
    if own:
        i = sorted(own, key=order)[0]
        full = waiting_for_slot(cfg, i)
        if full:
            # Its branch is pushed but the PR can't open yet: wait instead of a session that the gate stops, and
            # don't take new work meanwhile. The next pick after a merge frees a slot opens the PR.
            print(f"#{i['number']} is ready on its branch and waits for a pull-request slot ({full}).", file=sys.stderr)
            return None
        return i  # carry on with what this agent already holds
    for i in ready_issues(cfg):
        n = i["number"]
        add_labels(n, [L["inProgress"], mine])
        remove_label(n, L["ready"])
        comment(n, f"<!-- factory-claim agent={agent} -->\n**{agent}** is working on this.")
        time.sleep(2)  # let a simultaneous claim land, then let the earliest comment decide
        winner = claim_winner(n)
        if winner == agent:
            return i
        remove_label(n, mine)  # someone else was first; their labels stay
    return None


def waiting_for_slot(cfg, issue):
    """When the issue's task branch is pushed with no open PR and `maxOpenPRs` ready PRs are open (the gate's cap),
    a short reason; else None. A branch with no commits beyond main is still being built, so it doesn't wait."""
    n = issue["number"]
    branches = [b["name"] for b in gh_all("repos/{owner}/{repo}/branches") if b["name"].startswith(f"task/{n}-")]
    if not branches:
        return None
    prs = gh_all("repos/{owner}/{repo}/pulls?state=open")
    base = (gh("GET", "repos/{owner}/{repo}") or {}).get("full_name")
    if any(p["head"]["ref"] in branches and ((p["head"].get("repo") or {}).get("full_name") or base) == base
           for p in prs):
        return None  # its PR is open: rework and review go their own way
    main = cfg.get("mainBranch", "main")
    ahead = [b for b in branches
             if (gh("GET", f"repos/{{owner}}/{{repo}}/compare/{main}...{b}") or {}).get("ahead_by", 0) > 0]
    me = (gh("GET", "user") or {}).get("login")  # the gate's cap counts this account's ready PRs (--author @me)
    ready = sorted(p["number"] for p in prs if not p.get("draft") and (p.get("user") or {}).get("login") == me)
    if ahead and len(ready) >= int(cfg.get("maxOpenPRs", 3)):
        return f"{len(ready)} of {cfg.get('maxOpenPRs', 3)} open: " + ", ".join(f"#{x}" for x in ready)
    return None


def release_issue(cfg, n, reason=""):
    """Back to ready: the agent's label and the in-progress, in-review or blocked label come off."""
    L = task_labels(cfg)
    i = gh("GET", f"repos/{{owner}}/{{repo}}/issues/{n}")
    agents = [x[len(L["agentPrefix"]):] for x in names(i) if x.startswith(L["agentPrefix"])]
    for x in names(i):
        if x.startswith(L["agentPrefix"]) or x in (L["inProgress"], L["inReview"], L["blocked"]):
            remove_label(n, x)
    add_labels(n, [L["ready"]])
    who = agents[0] if agents else "none"
    comment(n, f"<!-- factory-release agent={who} -->\nBack to ready" + (f": {reason}" if reason else "."))


def tick(n, index):
    issue = gh("GET", f"repos/{{owner}}/{{repo}}/issues/{n}")
    body = issue.get("body") or ""
    boxes = list(BOX.finditer(body))
    if not 0 < index <= len(boxes):
        raise SystemExit(f"#{n} has {len(boxes)} checkboxes; there is no number {index}")
    m = boxes[index - 1]
    body = body[:m.start(2)] + "x" + body[m.end(2):]
    gh("PATCH", f"repos/{{owner}}/{{repo}}/issues/{n}", {"body": body})


def last_activity(cfg, issue):
    """The latest of: the issue's own update, and a commit on its task branch."""
    times = [issue["updated_at"]]
    for b in gh_all("repos/{owner}/{repo}/branches"):
        if re.match(rf"task/{issue['number']}-", b["name"]):
            c = gh("GET", f"repos/{{owner}}/{{repo}}/commits/{b['commit']['sha']}")
            times.append(c["commit"]["committer"]["date"])
    return max(datetime.fromisoformat(t.replace("Z", "+00:00")) for t in times)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("pick"); p.add_argument("--agent", required=True)
    sub.add_parser("peek")
    s = sub.add_parser("show"); s.add_argument("n", type=int)
    t = sub.add_parser("tick"); t.add_argument("n", type=int); t.add_argument("index", type=int)
    r = sub.add_parser("review"); r.add_argument("n", type=int)
    b = sub.add_parser("block"); b.add_argument("n", type=int); b.add_argument("reason")
    rl = sub.add_parser("release"); rl.add_argument("n", type=int); rl.add_argument("reason", nargs="?", default="")
    st = sub.add_parser("stale"); st.add_argument("--hours", type=float)
    nw = sub.add_parser("new"); nw.add_argument("--title", required=True); nw.add_argument("--body-file", required=True)
    nw.add_argument("--milestone"); nw.add_argument("--label", action="append", default=[])
    sub.add_parser("setup")
    sub.add_parser("list")
    a = ap.parse_args()
    cfg = load()
    L = task_labels(cfg)

    if a.cmd == "pick":
        i = pick(cfg, a.agent)
        if not i:
            print("none")
            sys.exit(1)
        print(f"issue-{i['number']} {i['title']}")
    elif a.cmd == "peek":
        ready = ready_issues(cfg)
        if not ready:
            print("none")
            sys.exit(1)
        print(f"issue-{ready[0]['number']} {ready[0]['title']}")
    elif a.cmd == "show":
        i = gh("GET", f"repos/{{owner}}/{{repo}}/issues/{a.n}")
        print(f"#{a.n} {i['title']}  [{', '.join(sorted(names(i)))}]  {i['state']}\n\n{i.get('body') or ''}")
    elif a.cmd == "tick":
        tick(a.n, a.index)
    elif a.cmd == "review":
        add_labels(a.n, [L["inReview"]])
        remove_label(a.n, L["inProgress"])
    elif a.cmd == "block":
        i = gh("GET", f"repos/{{owner}}/{{repo}}/issues/{a.n}")
        for x in names(i):
            if x.startswith(L["agentPrefix"]) or x in (L["inProgress"], L["ready"]):
                remove_label(a.n, x)
        add_labels(a.n, [L["blocked"]])
        # A block ends the claim too, so whoever takes it after the unblock wins it (factory-release).
        held = [x[len(L["agentPrefix"]):] for x in names(i) if x.startswith(L["agentPrefix"])]
        comment(a.n, f"<!-- factory-release agent={held[0] if held else 'none'} -->\n**Blocked:** {a.reason}")
    elif a.cmd == "release":
        release_issue(cfg, a.n, a.reason)
    elif a.cmd == "stale":
        hours = a.hours or float((cfg.get("tasks") or {}).get("staleHours", 3))
        now = datetime.now(timezone.utc)
        for i in task_issues(label=L["inProgress"]):
            age = (now - last_activity(cfg, i)).total_seconds() / 3600
            if age >= hours and waiting_for_slot(cfg, i):
                continue  # finished and pushed, waiting for a PR slot: not abandoned, nothing to hand over
            if age >= hours:
                agents = [x for x in names(i) if x.startswith(L["agentPrefix"])]
                print(f"#{i['number']} {', '.join(agents) or '(no agent)'} quiet for {age:.1f} h: {i['title']}")
    elif a.cmd == "new":
        data = {"title": a.title, "body": open(a.body_file).read(), "labels": [L["ready"], *a.label]}
        if a.milestone:
            ms = {m["title"]: m["number"] for m in gh_all("repos/{owner}/{repo}/milestones?state=all")}
            if a.milestone not in ms:
                ms[a.milestone] = gh("POST", "repos/{owner}/{repo}/milestones", {"title": a.milestone})["number"]
            data["milestone"] = ms[a.milestone]
        i = gh("POST", "repos/{owner}/{repo}/issues", data)
        print(f"#{i['number']} {i['html_url']}")
    elif a.cmd == "setup":
        have = {x["name"] for x in gh_all("repos/{owner}/{repo}/labels")}
        wanted = [(L[k], COLORS[k]) for k in COLORS] + [("factory-hold", "fbca04")]
        wanted += [("factory:agent", "bfdadc"), ("factory:agent-down", "d4c5f9")]
        wanted += [(L["agentPrefix"] + n, "c5def5") for n in cfg.get("agents") or []]
        for name, color in wanted:
            if name not in have:
                gh("POST", "repos/{owner}/{repo}/labels", {"name": name, "color": color})
                print(f"created {name}")
    elif a.cmd == "list":
        for i in sorted(task_issues(), key=order):
            state = [x for x in names(i) if x.startswith("factory") or x.startswith(L["agentPrefix"])]
            ms = (i.get("milestone") or {}).get("title", "")
            print(f"#{i['number']:<5} {ms:<10} {', '.join(sorted(state)):<45} {i['title']}")


if __name__ == "__main__":
    main()
