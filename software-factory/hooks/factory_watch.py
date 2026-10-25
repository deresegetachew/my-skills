#!/usr/bin/env python3
"""The dev manager's watcher (#109): from GitHub state alone, with no model, work out what needs a manager and what
needs the owner. It recomputes everything each time, so a missed event hides nothing, and it only reads.

  factory_watch.py            one line per item: ref, who it is for, how long it has waited, and why  (exit 3 when any)
  factory_watch.py --json     the same as JSON

The seven checks (thresholds are `manager.*` settings):
  1 review     an open PR whose head commit has no reviewed marker (factory-approved, factory-mustfix or pr-watch) and has
               been quiet for `quietMinutes` (5)
  2 question   a question with no later answer (`<!-- factory-question -->`, or `<!-- factory-msg ... kind=question
               to=dev-manager -->` as #107 defines it)
  3 fix        a must-fix, failing CI or a merge conflict on a PR with no new commit for `staleMinutes` (15)
  4 merge      an approved, green, unmerged PR (a PR the manager opened itself waits for the owner instead)
  5 owner-wait a PR labelled for the product owner (`roles.product-owner.workLabel`) or the owner (`factory:needs-owner`)
               that has waited `ownerWaitMinutes` (120)
  6 agent      a coding agent silent (for a manager), or down, or idle for `agentIdleMinutes` (45) while tasks are ready
               (for the owner)
  7 ci         a CI job queued for `ciQueuedMinutes` (10), with a note when no runner is online

Each item is {kind, ref, to ("manager" or "owner"), line, since, target, lease}. `target` is the issue or PR a lease and
the thread note go on; `lease` is (kind, key) for factory_lease.py. `since` is when the item became actionable, which the
dead-man's switch uses. Idempotent by construction: a head that carries a marker, a question that has an answer, a claim
that is unexpired, all clear their item.
"""
import json, os, re, sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import factory_ci_judge as judge  # noqa: E402
import factory_issues as fi  # noqa: E402
import factory_lease as lease  # noqa: E402
import factory_messages as fm  # noqa: E402
import factory_wait as fw  # noqa: E402
from factory_config import load, manager_setting, role_setting  # noqa: E402

WATCH = re.compile(r"<!--\s*pr-watch\s+sha=([0-9a-f]{7,40})")
OWNER_LABEL = "factory:needs-owner"
OWN_BRANCH = re.compile(r"^manager/")
OWN_BODY = re.compile(r"<!--\s*factory-role\s+role=dev-manager\b")
ORDER = {"merge": 0, "question": 1, "review": 2, "fix": 3, "stale": 4, "agent": 5, "owner": 6}


def when(text):
    try:
        return datetime.fromisoformat((text or "").replace("Z", "+00:00"))
    except ValueError:
        return None


def minutes(since, now):
    return (now - since).total_seconds() / 60 if since else 0.0


def review_state(comments, head):
    """("none" | "watch" | "approved" | "mustfix", when) for the head commit: the latest marker that names it (a verdict
    in a message envelope or the old marker; `pr-watch` ends the review of a head without a verdict)."""
    got = ("none", None)
    for c in comments:
        b = c.get("body") or ""
        for kind, sha in [(k, v) for k, v in fm.verdicts(b) if v] + [("watch", m) for m in WATCH.findall(b)]:
            if head.startswith(sha) or sha.startswith(head):
                if kind == "watch" and got[0] in ("approved", "mustfix"):
                    continue  # the pr-watch marker rides along with a verdict; the verdict is what counts
                got = (kind, when(c.get("created_at")))
    return got


def issue_of(pr):
    """The task issue a PR closes (`Closes #n`, else its task/<n>-... branch), else None."""
    m = re.search(r"\b(?:closes|fixes|resolves)\s+#(\d+)", pr.get("body") or "", re.I)
    if m:
        return int(m.group(1))
    m = re.match(r"task/(\d+)-", pr["head"].get("ref", ""))
    return int(m.group(1)) if m else None


def is_own(pr):
    return bool(OWN_BRANCH.match(pr["head"].get("ref", "")) or OWN_BODY.search(pr.get("body") or ""))


def ci_state(head):
    """The manager's CI verdict for a commit; "unknown" when GitHub cannot be read (nothing is acted on then)."""
    try:
        return judge.state(head)
    except RuntimeError:
        return "unknown", []


def make(kind, ref, line, to="manager", since=None, target=None, key=None, lease_kind="item", pr=None):
    return {"kind": kind, "ref": ref, "to": to, "line": line, "since": since, "target": target,
            "lease": (lease_kind, str(key if key is not None else ref)), "pr": pr}


ACTIVITY = re.compile(r"<!--\s*(?:factory-(?:approved|mustfix|answer)|pr-watch|factory-owner-ask)\b")


def last_activity(prs, comments_of, agents, cfg):
    """When a dev manager last did something visible: a verdict, an answer, a watch or an owner ask on an open PR, a merge,
    or a "working" ping from a dev-manager agent issue. Claims are left out on purpose: taking a lease is not progress."""
    best = None

    def see(t):
        nonlocal best
        if t and (best is None or t > best):
            best = t

    for p in prs:
        for c in comments_of(p["number"]):
            body = c.get("body") or ""
            if ACTIVITY.search(body) or fm.verdicts(body) or any(m.kind == "answer" for m in fm.parse_comment(c)):
                see(when(c.get("created_at")))
    for p in fi.gh_all("repos/{owner}/{repo}/pulls?state=closed&sort=updated&direction=desc&per_page=10")[:10]:
        see(when(p.get("merged_at")))
    if agents:
        import factory_agents
        for issue in agents.values():
            if fw_role(issue) == "dev-manager":
                st = factory_agents.state_of(cfg, issue)
                if st and st[1] == "working":
                    see(st[2])
    return best


def collect(cfg, now=None, info=None):
    """All items that need a manager or the owner, most urgent first. Reads GitHub only. `info`, when given, is filled
    with "activity": the time of the last visible dev-manager action (see last_activity)."""
    now = now or lease.now()
    quiet = float(manager_setting(cfg, "quietMinutes"))
    stale = float(manager_setting(cfg, "staleMinutes"))
    prs = fi.gh_all("repos/{owner}/{repo}/pulls?state=open")
    by_pr = {p["number"]: p for p in prs}
    cache = {}

    def comments_of(n):
        if n not in cache:
            cache[n] = fi.gh_all(f"repos/{{owner}}/{{repo}}/issues/{n}/comments")
        return cache[n]

    commit_times = {}

    def commit_time(sha):
        if sha not in commit_times:
            c = fi.gh("GET", f"repos/{{owner}}/{{repo}}/commits/{sha}") or {}
            commit_times[sha] = when(((c.get("commit") or {}).get("committer") or {}).get("date"))
        return commit_times[sha]

    items, seen_pr = [], {}
    agent_roles = {}
    if (cfg.get("tasks") or {}).get("source") == "issues":
        import factory_agents
        agent_roles = {factory_agents.name_of(i): i for i in factory_agents.current(factory_agents.agent_issues())}

    # checks 1 and 2 (and the silent agents and quiet issues the precheck knows), from the precheck itself
    for kind, ref, text in fw.precheck_items(cfg, prs, comments_of):
        if kind == "review":
            p = by_pr[ref]
            t = commit_time(p["head"]["sha"])
            if t and minutes(t, now) < quiet:
                continue  # the agent may still be pushing: give it a few minutes
            since = (t + timedelta(minutes=quiet)) if t else None
            items.append(make("review", f"pr-{ref}", text, since=since, target=ref, key=p["head"]["sha"],
                              lease_kind="review", pr=ref))
        elif kind == "question":
            tasks = fw.waiting_tasks(comments_of(ref))
            if not tasks:
                continue
            q = tasks[0].question
            items.append(make("question", f"question-{ref}", text, since=when(q.created), target=ref,
                              key=q.comment_id or tasks[0].id, lease_kind="answer", pr=ref if ref in by_pr else None))
        elif kind == "agent":
            issue = agent_roles.get(ref)
            if issue and fw_role(issue) != "coding-agent":
                continue  # a sleeping manager or product owner is not a dead coding agent
            items.append(make("agent", f"agent-{ref}", text, target=issue["number"] if issue else None,
                              key=f"agent-{ref}"))
        elif kind == "stale":
            items.append(make("stale", f"issue-{ref}", text, target=ref, key=f"issue-{ref}"))

    # checks 3, 4 and 5, per pull request
    po_label = str(role_setting(cfg, "product-owner", "workLabel", "") or "")
    for p in prs:
        n, head = p["number"], p["head"]["sha"]
        labels = {x["name"] for x in p.get("labels", [])}
        for label in [x for x in (po_label, OWNER_LABEL) if x and x in labels]:
            events = fi.gh_all(f"repos/{{owner}}/{{repo}}/issues/{n}/events")
            marked = [when(e.get("created_at")) for e in events if e.get("event") == "labeled"
                      and (e.get("label") or {}).get("name") == label]
            t = max([x for x in marked if x], default=None)
            if t and minutes(t, now) >= float(manager_setting(cfg, "ownerWaitMinutes")):
                who = "the product owner" if label == po_label else "the owner"
                items.append(make("owner", f"wait-{n}-{label}", f"PR #{n} has waited {minutes(t, now) / 60:.1f} h for {who} "
                                  f"(label {label})", to="owner", since=t, target=n, key=f"wait-{n}-{label}", pr=n))
        if p.get("draft"):
            continue
        state, marked_at = review_state(comments_of(n), head)
        if state == "none":
            continue  # check 1 owns it
        t = commit_time(head)
        reasons, green = [], False
        verdict, jobs = ci_state(head)
        if state == "approved" and verdict == "green":
            green = True
        if verdict == "failed" and t and minutes(t, now) >= stale:
            reasons.append(f"CI failed ({', '.join(jobs)})")
        if state == "mustfix" and marked_at and minutes(marked_at, now) >= stale:
            reasons.append("a must-fix waits for a new commit")
        if state in ("approved", "mustfix", "watch") and t and minutes(t, now) >= stale:
            detail = fi.gh("GET", f"repos/{{owner}}/{{repo}}/pulls/{n}") or {}
            if detail.get("mergeable_state") == "dirty":
                reasons.append("a merge conflict")
                green = False  # approved and green, but it cannot merge as it is
        if green and is_own(p):
            items.append(make("owner", f"own-{n}", f"PR #{n} is approved and green, but the manager opened it: it waits "
                              "for the owner to merge", to="owner", since=marked_at, target=n, key=f"own-{n}", pr=n))
        elif green:
            items.append(make("merge", f"pr-{n}", f"PR #{n}: approved and green, merge pending", since=marked_at,
                              target=n, key=head, lease_kind="review", pr=n))
        elif reasons:
            items.append(make("fix", f"pr-{n}", f"PR #{n}: " + "; ".join(reasons), since=(t + timedelta(minutes=stale)) if t else None,
                              target=n, key=head, lease_kind="review", pr=n))

    # check 6: agents that are down, or idle with work ready
    if agent_roles:
        import factory_agents
        ready = None
        for name, issue in agent_roles.items():
            if fw_role(issue) != "coding-agent":
                continue
            st = factory_agents.state_of(cfg, issue)
            if not st:
                continue
            _, status, t, quiet_min = st
            since = when(factory_agents.fields(issue).get("since"))  # when it entered this state (the heartbeat writes it)
            quiet_min = minutes(since, now) if since else 0.0
            if status == "down":
                items.append(make("owner", f"agent-down-{name}-{t:%Y%m%d%H}", f"agent {name} is down (last ping {t:%H:%M} UTC)",
                                  to="owner", since=t, target=issue["number"], key=f"agent-down-{name}-{t:%Y%m%d%H}"))
            elif status == "idle" and quiet_min >= float(manager_setting(cfg, "agentIdleMinutes")):
                ready = fi.ready_issues(cfg) if ready is None else ready
                if ready:
                    items.append(make("owner", f"agent-idle-{name}-{now:%Y%m%d}", f"agent {name} has been idle for "
                                      f"{quiet_min:.0f} min while {len(ready)} task(s) are ready", to="owner", since=t,
                                      target=issue["number"], key=f"agent-idle-{name}-{now:%Y%m%d}"))

    # check 7: queued CI
    try:
        runs = (fi.gh("GET", "repos/{owner}/{repo}/actions/runs?status=queued&per_page=50") or {}).get("workflow_runs", [])
        old = [r for r in runs if (when(r.get("created_at")) and minutes(when(r["created_at"]), now) >= float(manager_setting(cfg, "ciQueuedMinutes")))]
        if old:
            line = f"CI: {len(old)} run(s) queued for {minutes(min(when(r['created_at']) for r in old), now):.0f}+ min ({', '.join(sorted({r.get('name', '?') for r in old}))})"
            try:
                online = [r for r in (fi.gh("GET", "repos/{owner}/{repo}/actions/runners") or {}).get("runners", []) if r.get("status") == "online"]
                if not online:
                    line += "; no self-hosted runner is online"
            except SystemExit:
                pass  # listing runners needs admin rights: say nothing about them
            items.append(make("owner", "ci-queue", line, to="owner", since=min(when(r["created_at"]) for r in old),
                              key="ci-queue"))
    except SystemExit:
        pass  # Actions not readable: nothing to report

    if info is not None:
        info["activity"] = last_activity(prs, comments_of, agent_roles, cfg)
    return sorted(items, key=lambda i: (ORDER[i["kind"]], i["since"] or now))


def fw_role(issue):
    import factory_agents
    return factory_agents.role_of(issue)


def render(items, now=None):
    now = now or lease.now()
    return [f"{i['ref']:<18} {i['to']:<8} {minutes(i['since'], now):>5.0f} min  {i['line']}" for i in items]


def main(argv):
    cfg = load()
    items = collect(cfg)
    if "--json" in argv:
        print(json.dumps([{**i, "since": i["since"].isoformat() if i["since"] else None} for i in items], indent=2))
    elif items:
        print("\n".join(render(items)))
    else:
        print("nothing to do")
    return 3 if items else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
