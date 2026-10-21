#!/usr/bin/env python3
"""Live agents, tracked on GitHub (issues mode: `tasks.source: "issues"` in .claude/factory.json).

Each agent has one issue, `Agent: <name> · <status>`, labelled `factory:agent`, so the board and your phone show who
is alive and what each one does. The agent keeps it current itself:

  start          register: status `idle`, with its machine and folder        (factory-loop.sh, SessionStart hook)
  takes a task   `working on #42`                                             (next_task.py)
  any tool use   a ping, at most every `tasks.pingMinutes` (5), in the background   (PostToolUse hook)
  turn ends      `idle`                                                       (Stop hook)
  exits          `down`, label `factory:agent-down`                           (loop exit, SessionEnd hook)

An agent whose last ping is older than `tasks.downMinutes` (30) counts as down: it crashed, the laptop slept, or it
waits at a prompt nobody answers. The dev manager's `sweep` marks it down and puts its in-progress issues back to
ready, so a live agent takes them.

  python3 .claude/hooks/factory_agents.py list                  who is working, idle or down, and since when
  python3 .claude/hooks/factory_agents.py sweep                 mark silent agents down, release their issues
  python3 .claude/hooks/factory_agents.py register --agent taytu
  python3 .claude/hooks/factory_agents.py ping --agent taytu [--status "working on #42"] [--force]
  python3 .claude/hooks/factory_agents.py down --agent taytu
  python3 .claude/hooks/factory_agents.py hook                  the Claude hook entry (reads the event on stdin)

Hooks never fail or slow a session: errors are ignored, and the tool-use ping runs detached.
"""
import argparse, json, os, re, socket, subprocess, sys, time
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from factory_config import DEFAULTS, load, task_labels, task_source  # noqa: E402

LABEL, DOWN_LABEL = "factory:agent", "factory:agent-down"
MARK = re.compile(r"<!--\s*factory-agent\s+name=([\w.-]+)\s+status=(\w+)\s+ping=(\S+)\s*-->")


def setting(cfg, key):
    return (cfg.get("tasks") or {}).get(key, DEFAULTS["tasks"][key])


def now():
    return datetime.now(timezone.utc).replace(microsecond=0)


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def stamp_file(agent):
    from factory_claims import state_dir
    return os.path.join(state_dir(), f"agent-{agent}.json")


def remember(agent, **kw):
    try:
        path = stamp_file(agent)
        data = json.load(open(path)) if os.path.exists(path) else {}
        data.update(kw)
        json.dump(data, open(path, "w"))
        return data
    except (OSError, ValueError):
        return kw


def recall(agent):
    try:
        return json.load(open(stamp_file(agent)))
    except (OSError, ValueError):
        return {}


def agent_issues():
    from factory_issues import task_issues
    return task_issues(state="all", label=LABEL)


def find_issue(agent):
    for i in agent_issues():
        if re.match(rf"Agent: {re.escape(agent)}(\s|$)", i["title"]):
            return i
    return None


def render(agent, status, detail, started, ping=None, where=None):
    where = where or f"{socket.gethostname()} · {os.path.basename(os.getcwd())}"
    shown = {"working": detail or "working", "idle": "idle", "down": "down"}[status]
    t = iso(ping or now())
    body = (f"<!-- factory-agent name={agent} status={status} ping={t} -->\n"
            f"**Status:** {shown}\n**Last ping:** {t}\n**Started:** {started}\n**Where:** {where}\n\n"
            "This issue is kept up to date by the agent itself (see factory_agents.py). Don't close it.")
    return f"Agent: {agent} · {shown}", body


def update(cfg, agent, status, detail=""):
    from factory_issues import add_labels, gh, remove_label
    seen = recall(agent)
    n = seen.get("issue")
    if not n:
        i = find_issue(agent)
        if i:
            n = i["number"]
    started = seen.get("started") or iso(now())
    title, body = render(agent, status, detail, started)
    if n:
        gh("PATCH", f"repos/{{owner}}/{{repo}}/issues/{n}", {"title": title, "body": body, "state": "open"})
    else:
        n = gh("POST", "repos/{owner}/{repo}/issues", {"title": title, "body": body, "labels": [LABEL]})["number"]
    if status == "down":
        add_labels(n, [DOWN_LABEL])
    else:
        remove_label(n, DOWN_LABEL)
    remember(agent, issue=n, status=status, detail=detail, started=started, ping=time.time())
    return n


def state_of(cfg, issue):
    """(name, status, last ping, minutes since) from an agent issue; a silent agent counts as down."""
    m = MARK.search(issue.get("body") or "")
    if not m:
        return None
    name, status, ping = m.groups()
    t = datetime.fromisoformat(ping.replace("Z", "+00:00"))
    quiet = (now() - t).total_seconds() / 60
    if status != "down" and quiet >= float(setting(cfg, "downMinutes")):
        status = "silent"
    return name, status, t, quiet


def sweep(cfg):
    """Mark silent agents down and put their in-progress issues back to ready. Returns what it did."""
    import factory_issues
    L = task_labels(cfg)
    done = []
    for i in agent_issues():
        st = state_of(cfg, i)
        if not st or st[1] != "silent":
            continue
        name, _, t, quiet = st
        from factory_issues import add_labels, comment, gh
        old = i.get("body") or ""
        started = (re.search(r"\*\*Started:\*\* (\S+)", old) or [None, "?"])[1]
        where = (re.search(r"\*\*Where:\*\* (.+)", old) or [None, "?"])[1]
        title, body = render(name, "down", "", started, ping=t, where=where)
        gh("PATCH", f"repos/{{owner}}/{{repo}}/issues/{i['number']}", {"title": title, "body": body})
        add_labels(i["number"], [DOWN_LABEL])
        comment(i["number"], f"No ping for {quiet / 60:.1f} h (since {iso(t)}): marked down.")
        held = [x["number"] for x in factory_issues.task_issues(label=L["agentPrefix"] + name)
                if L["inProgress"] in {y["name"] for y in x["labels"]}]
        for n in held:
            factory_issues.release_issue(cfg, n, f"{name} went silent at {iso(t)}")
        done.append(f"{name}: down (silent {quiet / 60:.1f} h)" + (f", released {', '.join(f'#{n}' for n in held)}"
                                                                   if held else ""))
    return done


def hook(cfg):
    """Claude hook entry: PostToolUse pings (rate-limited, detached), Stop goes idle, SessionEnd goes down."""
    try:
        event = json.load(sys.stdin).get("hook_event_name", "")
    except ValueError:
        event = ""
    agent = os.environ.get("FACTORY_AGENT")
    if not agent:
        return
    seen = recall(agent)
    if event == "PostToolUse":
        if time.time() - float(seen.get("ping", 0)) < float(setting(cfg, "pingMinutes")) * 60:
            return  # pinged recently: no network at all
        remember(agent, ping=time.time())  # claim this ping slot before the detached call
        subprocess.Popen([sys.executable, os.path.abspath(__file__), "ping", "--agent", agent, "--force"],
                         start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    elif event == "Stop" and seen.get("status") != "idle":
        update(cfg, agent, "idle")
    elif event == "SessionEnd" and not os.environ.get("FACTORY_LOOP"):
        update(cfg, agent, "down")  # under factory-loop.sh the loop says down when it exits, not per session


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    for c in ("register", "ping", "down"):
        p = sub.add_parser(c)
        p.add_argument("--agent", default=os.environ.get("FACTORY_AGENT"))
        if c == "ping":
            p.add_argument("--status", default=None)
            p.add_argument("--force", action="store_true")
    sub.add_parser("list")
    sub.add_parser("sweep")
    sub.add_parser("hook")
    a = ap.parse_args()
    cfg = load()
    if task_source(cfg) != "issues":
        if a.cmd in ("list", "sweep"):
            print('Agent tracking needs issues mode: "tasks": {"source": "issues"} in .claude/factory.json.')
        return
    if a.cmd == "hook":
        try:
            hook(cfg)
        except BaseException:  # a hook must never break the session
            pass
        return
    if a.cmd in ("register", "ping", "down") and not a.agent:
        raise SystemExit("which agent? pass --agent <name> or set FACTORY_AGENT")
    if a.cmd == "register":
        remember(a.agent, started=iso(now()), issue=None)
        print(f"#{update(cfg, a.agent, 'idle')}")
    elif a.cmd == "down":
        update(cfg, a.agent, "down")
    elif a.cmd == "ping":
        seen = recall(a.agent)
        if a.status:
            status, detail = ("idle", "") if a.status == "idle" else ("working", a.status)
        else:
            status, detail = seen.get("status") or "idle", seen.get("detail") or ""
            if status == "down":
                status = "idle"
        if not a.force and not a.status and time.time() - float(seen.get("ping", 0)) < float(setting(cfg, "pingMinutes")) * 60:
            return
        update(cfg, a.agent, status, detail)
    elif a.cmd == "list":
        rows = [st for st in (state_of(cfg, i) for i in agent_issues()) if st]
        for name, status, t, quiet in sorted(rows):
            when = f"{quiet:.0f} min ago" if quiet < 120 else f"{quiet / 60:.1f} h ago"
            print(f"{name:<12} {status:<8} last ping {iso(t)} ({when})")
        if not rows:
            print("no agents have registered yet")
    elif a.cmd == "sweep":
        for line in sweep(cfg):
            print(line)


if __name__ == "__main__":
    main()
