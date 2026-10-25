#!/usr/bin/env python3
"""`factory agents ls`: every agent in one table (#108): name, kind, where it runs, state, what it does, since when,
last seen and how to follow it.

  factory agents ls [--json] [--local] [--fresh]

This machine comes from the heartbeat daemon's state file (factory_heartbeat.py): instant, no network, and the full
picture (tmux session, Remote Control link). When the daemon is not running the state is worked out on the spot and
the line says how to start it. The other machines and the cloud agents come from their agent issues on GitHub (issues
mode), cached for FACTORY_AGENTS_CACHE_SECONDS (default 45) so a quick repeat costs nothing; `--fresh` asks again and
`--local` never asks. What a remote agent shows is what its machine posted: the hidden marker's kind, task, wait and
`since`, and the tmux session and follow link only when its project sets `tasks.showWhere`. A GitHub failure shows
this machine alone, with a line saying so.

--json prints {agents: [...], github: {...}, daemon: {...}, machine}; every row has name, kind, where, state, detail,
task, on, since, lastSeen, follow, session, activity and source (local or github).
"""
import json, os, re, sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import factory_clock  # noqa: E402

CACHE_FILE = "agents-cache.json"


def iso(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if epoch else None


def kind_text(kind):
    return (kind or "coding-agent").replace("-", " ")


def local_rows(cfg):
    """(rows, daemon info) for this machine: from the daemon's file when it is fresh, else derived now."""
    import factory_heartbeat as H
    from factory_machine import machine_id
    data = H.load_local()
    fresh = H.is_fresh(data)
    agents = data.get("agents") or {} if fresh else H.observe(cfg)
    seen = data.get("updated") if fresh else factory_clock.now()
    rows = []
    for name, r in sorted(agents.items()):
        rows.append({"name": name, "kind": kind_text(r.get("kind")), "where": "this machine", "state": r["state"],
                     "detail": r.get("detail") or r["state"], "task": r.get("task"), "on": r.get("on"),
                     "since": r.get("since"), "lastSeen": iso(seen) if r["state"] != "down" else None,
                     "follow": r.get("follow"), "session": r.get("session"), "activity": iso(r.get("activity")),
                     "machine": machine_id(), "source": "local"})
    return rows, {"running": fresh, "updated": iso(data.get("updated")) if data else None,
                  "errors": data.get("errors") or [] if fresh else []}


def cache_path():
    from factory_machine import state_dir
    return os.path.join(state_dir(), CACHE_FILE)


def read_cache():
    try:
        data = json.load(open(cache_path()))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) and isinstance(data.get("issues"), list) else None


def write_cache(issues, now):
    path = cache_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    slim = [{k: i.get(k) for k in ("number", "title", "body", "state", "labels")} for i in issues]
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump({"at": now, "issues": slim}, f)
    os.replace(tmp, path)


def github_issues(fresh, now):
    """(issues, info): the agent issues, from the cache while it is young. On a failure the old cache (if any) is used
    and the error is in info."""
    ttl = float(os.environ.get("FACTORY_AGENTS_CACHE_SECONDS") or 45)
    cached = read_cache()
    if cached and not fresh and 0 <= now - float(cached.get("at") or 0) < ttl:
        return cached["issues"], {"ok": True, "cached": True, "age": int(now - float(cached["at"]))}
    try:
        import factory_agents
        issues = factory_agents.agent_issues()
    except (Exception, SystemExit) as e:
        message = str(e).strip() or type(e).__name__
        info = {"ok": False, "error": message[:300]}
        if cached:
            return cached["issues"], {**info, "cached": True, "age": int(now - float(cached.get("at") or 0))}
        return [], info
    write_cache(issues, now)
    return issues, {"ok": True, "cached": False, "age": 0}


def remote_rows(cfg, issues, local_names):
    import factory_agents as FA
    from factory_machine import machine_id
    mine = machine_id()
    rows = []
    for issue in FA.current(issues):
        st = FA.state_of(cfg, issue)
        if not st:
            continue
        name, state, ping, _ = st
        if name in local_names:
            continue
        f = FA.fields(issue)
        cloud = f.get("where") == "cloud"
        machine = f.get("machine") or None
        where = "cloud" if cloud else ("this machine" if machine and machine == mine else
                                       f"machine {machine}" if machine else "-")
        title = issue.get("title") or ""
        detail = title.split(" · ", 1)[1] if " · " in title else state
        rows.append({"name": name, "kind": kind_text(f.get("kind")), "where": where, "state": state,
                     "detail": detail if state not in ("silent",) else f"{detail} (no keepalive)",
                     "task": f.get("task"), "on": f.get("on"), "since": f.get("since") or iso(ping.timestamp()),
                     "lastSeen": iso(ping.timestamp()), "follow": f.get("follow"), "session": f.get("session"),
                     "activity": None, "machine": machine, "source": "github"})
    return rows


def ago(stamp, now):
    if not stamp:
        return "-"
    t = datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp()
    m = max(int((now - t) // 60), 0)
    return "just now" if m < 1 else f"{m} min ago" if m < 120 else f"{m // 60} h ago"


def table(rows, now):
    head = ["Name", "Kind", "Where", "State", "Doing", "Since", "Last seen", "Follow"]
    body = [[r["name"], r["kind"], r["where"], r["state"], r["detail"] if r["detail"] != r["state"] else "-",
             ago(r["since"], now), ago(r["lastSeen"], now), r["follow"] or "-"] for r in rows]
    widths = [max(len(str(x[i])) for x in [head] + body) for i in range(len(head) - 1)]
    return ["  ".join(str(c).ljust(widths[i]) if i < len(widths) else str(c) for i, c in enumerate(row)).rstrip()
            for row in [head] + body]


def run(cfg, as_json=False, local_only=False, fresh=False):
    from factory_config import task_source
    from factory_machine import machine_id
    now = factory_clock.now()
    rows, daemon = local_rows(cfg)
    github = {"ok": True, "skipped": True}
    if not local_only and task_source(cfg) == "issues":
        issues, github = github_issues(fresh, now)
        rows += remote_rows(cfg, issues, {r["name"] for r in rows})
    rows.sort(key=lambda r: r["name"])
    if as_json:
        print(json.dumps({"agents": rows, "github": github, "daemon": daemon, "machine": machine_id()}, indent=1))
        return
    if rows:
        print("\n".join(table(rows, now)))
    else:
        print("No agents known yet. `factory machine setup <names>` names this machine's agents; `factory loop -i` starts one.")
    if not daemon["running"]:
        print("\nThe heartbeat daemon is not running here, so this machine's rows were worked out just now and nothing "
              "reports to GitHub while an agent waits. Start it: factory heartbeat install")
    if not github.get("ok"):
        print(f"\nGitHub: can't read the other machines' agents ({github['error']})."
              + (f" Showing what was cached {github['age']} s ago." if github.get("cached") else " Showing this machine only."))
    elif github.get("cached") and github.get("age", 0) >= 1:
        print(f"\n(other machines as of {github['age']} s ago; --fresh asks GitHub again)")
