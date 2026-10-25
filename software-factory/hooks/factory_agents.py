#!/usr/bin/env python3
"""Live agents, tracked on GitHub (issues mode: `tasks.source: "issues"` in .claude/factory.json).

Each agent has one issue, `Agent: <name> · <status>`, labelled `factory:agent`, so the board and your phone show who
is alive and what each one does. The agent keeps it current itself:

  start          register: status `idle`, with its machine id (the hostname only with showWhere)       (factory-loop.sh, SessionStart hook)
  takes a task   `working on #42`                                             (next_task.py)
  any tool use   a ping, at most every `tasks.pingMinutes` (5), in the background   (PostToolUse hook)
  turn ends      `idle`                                                       (Stop hook)
  exits          `down`, label `factory:agent-down`                           (loop exit, SessionEnd hook)
  waits on a question  `input-required` (ping --status input-required): the same word as a question waiting for
                 more information; the next tool use after the wait puts it back to `working`

The issue body also carries a `factory-msg kind=status` envelope (factory_messages.py, docs/messages.md), so the status
uses the shared message format and `factory messages ls --kind status` lists it.

An agent whose last ping is older than `tasks.downMinutes` (30) counts as down: it crashed, the laptop slept, or it
waits at a prompt nobody answers. The dev manager's `sweep` marks it down and puts its in-progress issues back to
ready, so a live agent takes them.

  python3 .claude/hooks/factory_agents.py list [--json]         who is working, idle or down, and since when (--json: cards)
  python3 .claude/hooks/factory_agents.py card <name>           one agent's card (factory_cards.py), also for dev-manager and po
  python3 .claude/hooks/factory_agents.py sweep                 mark silent agents down, release their issues
  python3 .claude/hooks/factory_agents.py register --agent taytu
  python3 .claude/hooks/factory_agents.py ping --agent taytu [--status "working on #42"] [--force]
  python3 .claude/hooks/factory_agents.py down --agent taytu
  python3 .claude/hooks/factory_agents.py hook                  the Claude hook entry (reads the event on stdin)

Each ping marker carries `machine=<id>` (factory_machine.py). `register` refuses, exit 3 and a `{code, message, fix}`
on stderr, when the open issue of that name was pinged by another machine within `downMinutes`; a marker without a
machine (an older kit) never blocks.

Hooks never fail or slow a session: errors are ignored, and the tool-use ping runs detached.
"""
import argparse, json, os, re, socket, subprocess, sys, tempfile, time
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from factory_config import DEFAULTS, load, task_labels, task_source  # noqa: E402

LABEL, DOWN_LABEL = "factory:agent", "factory:agent-down"
MARK = re.compile(r"<!--\s*factory-agent\s+name=([\w.-]+)\s+status=([\w-]+)\s+ping=(\S+?)(?:\s+machine=([\w-]+))?\s*-->")


def setting(cfg, key):
    return (cfg.get("tasks") or {}).get(key, DEFAULTS["tasks"][key])


def now():
    return datetime.now(timezone.utc).replace(microsecond=0)


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def stamp_file(agent):
    """Where an agent's last ping and issue number are kept: the repository's factory folder, or, when that can't be
    written (a sandboxed hook), a private folder in the temp directory, so pings stay rate-limited either way."""
    from factory_config import safe_agent
    name = f"agent-{safe_agent(agent)}.json"
    try:
        from factory_claims import state_dir
        d = state_dir()
        if os.access(d, os.W_OK):
            return os.path.join(d, name)
    except (OSError, SystemExit):
        pass
    d = os.path.join(tempfile.gettempdir(), f"factory-{os.getuid() if hasattr(os, 'getuid') else 'user'}")
    os.makedirs(d, mode=0o700, exist_ok=True)
    return os.path.join(d, name)


def remember(agent, **kw):
    try:
        path = stamp_file(agent)
        try:
            data = json.load(open(path)) if os.path.exists(path) else {}
        except ValueError:
            data = {}
        data.update(kw)
        # Written whole, then moved into place: two hooks at once never leave half a file that reads as empty.
        tmp = f"{path}.{os.getpid()}.tmp"
        with open(tmp, "w") as f:
            json.dump(data, f)
        os.replace(tmp, path)
        return data
    except OSError:
        return kw


def recall(agent):
    try:
        return json.load(open(stamp_file(agent)))
    except (OSError, ValueError):
        return {}


def agent_issues():
    from factory_issues import task_issues
    return task_issues(state="all", label=LABEL)


def name_of(issue):
    """The agent an agent issue belongs to: the marker's name, else the title's (`Agent: <name> · ...`)."""
    m = MARK.search(issue.get("body") or "")
    if m:
        return m.group(1)
    m = re.match(r"Agent: ([\w.-]+)(\s|$)", issue.get("title") or "")
    return m.group(1) if m else None


def last_ping(issue):
    m = MARK.search(issue.get("body") or "")
    return m.group(3) if m else ""


def ranked(issues):
    """An agent's issues, the one to use first: open before closed, then the newest ping, then the newest issue."""
    return sorted(issues, key=lambda i: (i.get("state") == "open", last_ping(i), i["number"]), reverse=True)


def by_agent(issues):
    """{agent: its issues, the one to use first}. Several issues for one agent are duplicates."""
    out = {}
    for i in issues:
        name = name_of(i)
        if name:
            out.setdefault(name, []).append(i)
    return {name: ranked(found) for name, found in out.items()}


def find_issue(agent):
    found = by_agent(agent_issues()).get(agent)
    return found[0] if found else None


def render(agent, status, detail, started, ping=None, where=None, machine=""):
    where = where or f"slot {os.environ.get('FACTORY_SLOT') or 1}"
    shown = {"working": detail or "working", "idle": "idle", "down": "down",
             "input-required": f"input-required ({detail})" if detail else "input-required"}[status]
    t = iso(ping or now())
    mark = f" machine={machine}" if machine else ""
    # The old marker stays first (older kits read only it); the envelope says the same in the shared message format:
    # the agent's status is a status message whose id is stable, because the body is rewritten on every ping.
    import factory_messages as fm
    envelope = fm.render(fm.Message(id=f"agent-{agent}", kind="status", frm=agent, state=status))
    body = (f"<!-- factory-agent name={agent} status={status} ping={t}{mark} -->\n{envelope}\n"
            f"**Status:** {shown}\n**Last ping:** {t}\n**Started:** {started}\n**Where:** {where}\n\n"
            "This issue is kept up to date by the agent itself (see factory_agents.py). Don't close it.")
    return f"Agent: {agent} · {'input-required' if status == 'input-required' else shown}", body


def machine_of(issue):
    """The machine id in an agent issue's marker; None when it has none (an older kit)."""
    m = MARK.search(issue.get("body") or "")
    return m.group(4) if m else None


def held_elsewhere(cfg, agent, machine):
    """The other machine's id when `agent`'s open issue was pinged by it within `downMinutes` and isn't down, else
    None. A marker without a machine (an older kit), a down or silent agent and our own machine all return None."""
    i = find_issue(agent)
    if not i or i.get("state") != "open" or not machine:
        return None
    st = state_of(cfg, i)
    other = machine_of(i)
    if not st or st[1] in ("down", "silent") or not other or other == machine:
        return None
    return other


def update(cfg, agent, status, detail="", create=False):
    """Updates the agent's one issue. Only `register` (create=True) may open a new one, and only when the agent has
    none at all, open or closed: a ping, a turn's end or a session's end that can't find the issue changes nothing.
    (On 22 Oct a lookup that came back empty made every ping open another issue: 195 copies in two hours.)"""
    from factory_issues import add_labels, gh, remove_label
    seen = recall(agent)
    n = seen.get("issue")
    if not n:
        i = find_issue(agent)
        if i:
            n = i["number"]
        elif not create:
            return None
    started = seen.get("started") or iso(now())
    # The machine and folder are posted to GitHub only when the project opts in (tasks.showWhere: true).
    where = (f"{socket.gethostname()} · {os.path.basename(os.getcwd())}"
             if (cfg.get("tasks") or {}).get("showWhere") else None)
    from factory_machine import machine_id
    title, body = render(agent, status, detail, started, where=where, machine=machine_id())
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
    name, status, ping = m.groups()[:3]
    t = datetime.fromisoformat(ping.replace("Z", "+00:00"))
    quiet = (now() - t).total_seconds() / 60
    if status != "down" and quiet >= float(setting(cfg, "downMinutes")):
        status = "silent"
    return name, status, t, quiet


def current(issues):
    """Each agent's one issue: its open issue with the newest ping. Closed ones and older copies don't count."""
    return [found[0] for found in by_agent(issues).values() if found[0].get("state") == "open"]


def close_copies(issues):
    """Closes an agent's other open issues, keeping its current one. Returns the numbers it closed."""
    from factory_issues import gh
    closed = []
    for name, found in by_agent(issues).items():
        for extra in found[1:]:
            if extra.get("state") == "open":
                gh("PATCH", f"repos/{{owner}}/{{repo}}/issues/{extra['number']}",
                   {"state": "closed", "state_reason": "not_planned"})
                closed.append(extra["number"])
    return closed


def sweep(cfg):
    """Close duplicate agent issues, then mark silent agents down and put their in-progress issues back to ready.
    Only an agent's current issue counts: an old copy that went quiet must never release a live agent's work."""
    import factory_issues
    L = task_labels(cfg)
    issues = agent_issues()
    done = []
    copies = close_copies(issues)
    if copies:
        done.append(f"closed {len(copies)} duplicate agent issue{'s' if len(copies) > 1 else ''}: "
                    + ", ".join(f"#{n}" for n in sorted(copies)))
    for i in current(issues):
        st = state_of(cfg, i)
        if not st or st[1] != "silent":
            continue
        name, _, t, quiet = st
        from factory_issues import add_labels, comment, gh
        old = i.get("body") or ""
        started = (re.search(r"\*\*Started:\*\* (\S+)", old) or [None, "?"])[1]
        where = (re.search(r"\*\*Where:\*\* (.+)", old) or [None, "?"])[1]
        title, body = render(name, "down", "", started, ping=t, where=where, machine=machine_of(i) or "")
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
    ls = sub.add_parser("list")
    ls.add_argument("--json", action="store_true", help="the agents' cards as JSON")
    card = sub.add_parser("card")
    card.add_argument("name")
    sub.add_parser("sweep")
    sub.add_parser("hook")
    a = ap.parse_args()
    cfg = load()
    if task_source(cfg) != "issues":
        if a.cmd in ("list", "sweep", "card"):
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
        from factory_machine import machine_id, refuse
        other = held_elsewhere(cfg, a.agent, machine_id())
        if other:  # exit 3: factory-loop.sh stops here instead of running as a second copy of this agent
            refuse("agent-name-in-use", f"{a.agent} is already running on another machine (machine {other}).",
                   "Start this machine's agents under names no other machine uses: "
                   "`factory machine setup <names>`, or set FACTORY_AGENTS.", exit_code=3)
        remember(a.agent, started=iso(now()), issue=None)
        print(f"#{update(cfg, a.agent, 'idle', create=True)}")
    elif a.cmd == "down":
        update(cfg, a.agent, "down")
    elif a.cmd == "ping":
        seen = recall(a.agent)
        if a.status == "input-required":  # blocked on a question: keeps what it was doing, to show and to go back to
            status, detail = "input-required", seen.get("detail") or ""
        elif a.status:
            status, detail = ("idle", "") if a.status == "idle" else ("working", a.status)
        else:
            status, detail = seen.get("status") or "idle", seen.get("detail") or ""
            if status == "down":
                status = "idle"
            elif status == "input-required":
                status = "working"  # a tool ran since: it is not waiting any more
        if not a.force and not a.status and time.time() - float(seen.get("ping", 0)) < float(setting(cfg, "pingMinutes")) * 60:
            return
        update(cfg, a.agent, status, detail)
    elif a.cmd == "list":
        import factory_cards
        found = factory_cards.cards(cfg, agent_issues())
        if a.json:
            print(json.dumps(found, indent=2))
        for c in ([] if a.json else found):
            print(factory_cards.row(c))
        if not found and not a.json:
            print("no agents have registered yet")
    elif a.cmd == "card":
        import factory_cards
        from factory_config import safe_agent
        found = [c for c in factory_cards.cards(cfg, agent_issues()) if c["name"] == a.name]
        print(json.dumps(found[0] if found else factory_cards.card(safe_agent(a.name)), indent=2))
    elif a.cmd == "sweep":
        for line in sweep(cfg):
            print(line)


if __name__ == "__main__":
    main()
