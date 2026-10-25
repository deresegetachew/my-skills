#!/usr/bin/env python3
"""The per-machine heartbeat daemon (#108): real agent liveness, reported to GitHub cheaply.

Liveness used to be a side effect of tool use: an agent pinged its issue when a tool finished. So an agent waiting
in `factory wait` for 30 minutes looked silent, and an agent whose machine reset kept saying `working`. This daemon
asks the machine instead. Every `tasks.heartbeatSeconds` (20) it looks, locally and for free, at each agent that
runs here:

  the claim          factory_claims.py: the checkout claim names the agent's loop or Claude process; is that pid
                     alive and a loop or Claude process, and does the agent hold a task?
  what it waits on   a `factory wait ci|answer <pr>`, `wait slot|ready` or `wait_for_merge.sh <pr>` below that pid
  the tmux session   `<repo>-<agent>` (factory resume starts it): its Remote Control link, read from the pane, and
                     when it last showed output
  the transcript     when Claude last wrote to the session's log

and works out one state:  working | waiting | idle | down.
  down      no live loop or Claude process holds the agent's checkout
  waiting   alive, and a `factory wait` runs below it: deliberately blocked (a PR slot, CI, an answer, a merge)
  working   alive and holds a task
  idle      alive, no task

What it saw goes to this machine's state file every cycle (`heartbeat.json` in the state folder, see `factory
machine show`), which `factory agents ls` reads: instant, no network. GitHub is written (one PATCH of the agent's own
issue, the hidden marker extended with kind, task, on, since, hb) only when the state has changed and lasted a few
seconds (FACTORY_HEARTBEAT_CONFIRM, default 15), plus a keepalive every `tasks.pingMinutes` (5): at most 12 writes
per agent per rolling hour, so 4 agents are about 48 edits an hour against GitHub's 5,000 requests. The one write that
is never held back is `down`: it goes out about a cycle after the process or session disappeared. Nothing is written
for an agent that has never reported, and nothing for `down` twice.

The tmux session name, the folder, the machine name and the Remote Control link go to GitHub only with
`tasks.showWhere` (agent issues are readable by anyone who can read the repo). Cloud agents (the dev manager)
have no daemon: they report with `factory_agents.py ping --cloud --follow <link>`.

The first cycle after the daemon starts (a boot) marks this machine's agents that GitHub still shows alive, but that
are not running here, as down. Stopping the daemon does not touch the agents.

While the daemon runs, the agent hooks leave the pings and `idle` to it (factory_agents.py), and the sweep never gives
away the issue of an agent it sees alive. Without it everything works as before: pings on tool use, 30 minutes to
silent.

  python3 .claude/hooks/factory_heartbeat.py run         the daemon: one cycle every few seconds, until stopped
  python3 .claude/hooks/factory_heartbeat.py once        one cycle, then print what it saw
  python3 .claude/hooks/factory_heartbeat.py status      is it installed and running, and what it last saw
  python3 .claude/hooks/factory_heartbeat.py install     keep it running: a systemd user service or a LaunchAgent
  python3 .claude/hooks/factory_heartbeat.py uninstall
  python3 .claude/hooks/factory_heartbeat.py restart     run the files now on disk (`factory update` does it)

`factory autostart install` installs it too (unless --no-heartbeat). One daemon runs per project and machine: a
second `run` stops with `{code: heartbeat-running}`. A GitHub failure is retried a minute later and never stops it.
It runs as the same user as the agents; an agent could stop it or forge its state, which is acceptable for
well-meaning agents, as the README says of the gate.
"""
import fcntl, json, os, re, signal, subprocess, sys, time
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import factory_clock  # noqa: E402

KIND = "coding-agent"
LOCAL_FILE = "heartbeat.json"
WRITES_PER_HOUR = 12
HOUR = 3600
SHELLS_AND_SCRIPTS_ONLY = ("claude", "node", "nodejs", "bun")  # their arguments hold prompts, not commands

# --- what a process is waiting on --------------------------------------------------------------------------------

_WAIT = r"(?:factory_wait\.py|\bfactory\s+wait)"
_ON_PR = re.compile(_WAIT + r"\s+(ci|answer)\s+#?(\d+)\b")
_BARE = re.compile(_WAIT + r"\s+(slot|ready)\b")
_MERGE = re.compile(r"(?:wait_for_merge\.sh|" + _WAIT + r")\s+#?(\d+)\b")
_TEXT = {"ci": "CI on PR #{n}", "answer": "an answer on PR #{n}", "merge": "the merge of PR #{n}",
         "slot": "a free PR slot", "ready": "a ready task"}


def parse_wait(args):
    """What a command line waits on, as {kind, pr, on, text}; None when it is not one of the factory's waits."""
    m = _ON_PR.search(args)
    if m:
        kind, pr = m.group(1), m.group(2)
    elif _BARE.search(args):
        kind, pr = _BARE.search(args).group(1), None
    elif _MERGE.search(args):
        kind, pr = "merge", _MERGE.search(args).group(1)
    else:
        return None
    return {"kind": kind, "pr": pr, "on": f"{kind}:{pr}" if pr else kind, "text": _TEXT[kind].format(n=pr)}


def waits_in_tree(procs, root):
    """The wait a process below `root` runs ({pid: (ppid, command line)} from `ps`); None when there is none."""
    kids = {}
    for pid, (ppid, _) in procs.items():
        kids.setdefault(ppid, []).append(pid)
    seen, queue = set(), list(kids.get(root, []))
    while queue:
        pid = queue.pop(0)
        if pid in seen:
            continue
        seen.add(pid)
        args = procs[pid][1]
        words = args.split()
        if words and os.path.basename(words[0]) not in SHELLS_AND_SCRIPTS_ONLY:
            got = parse_wait(args)
            if got:
                return got
        queue += kids.get(pid, [])
    return None


def processes():
    """{pid: (ppid, command line)} for every process, from `ps`; {} when there is no ps."""
    try:
        p = subprocess.run(["ps", "-eo", "pid=,ppid=,args="], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return {}
    out = {}
    for line in p.stdout.splitlines():
        m = re.match(r"\s*(\d+)\s+(\d+)\s+(.*)", line)
        if m:
            out[int(m.group(1))] = (int(m.group(2)), m.group(3))
    return out


# --- the tmux session and the transcript ----------------------------------------------------------------------------

def tmux(*args):
    try:
        p = subprocess.run(["tmux", *args], capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return p.stdout if p.returncode == 0 else None


def tmux_sessions():
    """{session name: when it last showed output (epoch seconds, or None)}; {} without tmux or sessions."""
    out = tmux("list-sessions", "-F", "#{session_name} #{session_activity}")
    sessions = {}
    for line in (out or "").splitlines():
        name, _, activity = line.strip().partition(" ")
        if name:
            sessions[name] = float(activity) if activity.strip().isdigit() else None
    return sessions


def follow_url(text):
    """The Remote Control link in a pane's text (the last one), or None. Only claude.ai/code links count."""
    found = re.findall(r"(?<![\w.-])https://claude\.ai/code/[A-Za-z0-9_\-/?=&%.]+", text or "")
    return found[-1].rstrip(".,)") if found else None


def transcript_activity(path):
    """When Claude last wrote to a session log of the project folder `path`, or None."""
    base = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")
    folder = os.path.join(base, "projects", re.sub(r"[^A-Za-z0-9]", "-", path or ""))
    try:
        with os.scandir(folder) as entries:
            times = [e.stat().st_mtime for e in entries if e.name.endswith(".jsonl")]
    except OSError:
        return None
    return max(times) if times else None


# --- the state ----------------------------------------------------------------------------------------------------

def task_number(task):
    """'42' for the claim key `issue-42`; any other key (a plan task like 3.2) as it is."""
    m = re.fullmatch(r"issue-(\d+)", task or "")
    return m.group(1) if m else (task or None)


def derive(inp):
    """The state of one agent from what was seen: {alive, task (claim key or None), wait (parse_wait or None)}."""
    if not inp.get("alive"):
        return {"state": "down", "detail": "down", "task": None, "on": None}
    number = task_number(inp.get("task"))
    wait = inp.get("wait")
    if wait:
        return {"state": "waiting", "detail": "waiting for " + wait["text"], "task": number, "on": wait["on"]}
    if number:
        shown = f"#{number}" if str(inp["task"]).startswith("issue-") else number
        return {"state": "working", "detail": f"working on {shown}", "task": number, "on": None}
    return {"state": "idle", "detail": "idle", "task": None, "on": None}


def key_of(state, task=None, on=None, session=None, follow=None):
    """What counts as a change worth writing: the state, the task, what it waits on, and the reach fields that are
    posted. Everything else (the since time, a new activity time) is not."""
    if state == "down":
        return "down"
    return "|".join([state, task or "", on or "", session or "", follow or ""])


def reported_key(stamp):
    """The key of what the last write to GitHub said, from the agent's stamp file (any writer's)."""
    if not stamp.get("status"):
        return ""
    ex = stamp.get("extra") or {}
    return key_of(stamp["status"], ex.get("task"), ex.get("on"), ex.get("session"), ex.get("follow"))


def plan(key, rep, now, cfg, confirm):
    """Whether to write `key` now. `rep` is {key: what GitHub last got, ping: when, writes: [times], cand: {key, at}}.
    Returns {write, why, cand}: a change is written once it has lasted `confirm` seconds, an unchanged state as a
    keepalive every `tasks.pingMinutes`, and neither more than 12 times in the last hour. `down` ignores the cap."""
    ping_s = float((cfg.get("tasks") or {}).get("pingMinutes", 5)) * 60
    recent = [t for t in rep.get("writes") or [] if now - t < HOUR]
    room = len(recent) < WRITES_PER_HOUR
    if key == rep.get("key"):
        if key != "down" and now - float(rep.get("ping") or 0) >= ping_s and room:
            return {"write": True, "why": "keepalive", "cand": None}
        return {"write": False, "why": None, "cand": None}
    cand = rep.get("cand")
    if not cand or cand.get("key") != key:
        return {"write": False, "why": None, "cand": {"key": key, "at": now}}
    if now - cand["at"] < confirm:
        return {"write": False, "why": None, "cand": cand}
    if key == "down" or room:
        return {"write": True, "why": "change", "cand": None}
    return {"write": False, "why": None, "cand": cand}


# --- this machine's state file -----------------------------------------------------------------------------------

def local_path():
    from factory_machine import state_dir
    return os.path.join(state_dir(), LOCAL_FILE)


def load_local():
    try:
        data = json.load(open(local_path()))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def save_local(data):
    path = local_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=1)
    os.replace(tmp, path)


def is_fresh(data, now=None):
    """Whether the daemon wrote its file recently (within three cycles, at least a minute)."""
    now = factory_clock.now() if now is None else now
    wait = max(3 * float(data.get("interval") or 20), 60)
    return bool(data) and 0 <= now - float(data.get("updated") or 0) <= wait


def managed(agent):
    """Whether the daemon on this machine is running and looks after `agent` (so the hooks need not write)."""
    try:
        data = load_local()
        return is_fresh(data) and agent in (data.get("agents") or {})
    except (OSError, SystemExit):
        return False


def alive_here(agent):
    """Whether the daemon on this machine sees `agent` alive (working, waiting or idle) right now."""
    try:
        data = load_local()
        row = (data.get("agents") or {}).get(agent) or {}
        return is_fresh(data) and row.get("state") in ("working", "waiting", "idle")
    except (OSError, SystemExit):
        return False


# --- looking at the machine --------------------------------------------------------------------------------------

def iso(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def interval_seconds(cfg):
    given = os.environ.get("FACTORY_HEARTBEAT_SECONDS") or (cfg.get("tasks") or {}).get("heartbeatSeconds", 20)
    try:
        return max(float(given), 5.0)
    except ValueError:
        return 20.0


def confirm_seconds(cfg):
    try:
        return float(os.environ["FACTORY_HEARTBEAT_CONFIRM"])
    except (KeyError, ValueError):
        return min(15.0, interval_seconds(cfg))


def known_agents(checkouts):
    """The agents to look at: the names this machine runs, whoever holds a checkout here, and any agent whose last
    report was not `down` (it may have crashed since)."""
    from factory_machine import machine_names
    import factory_claims
    names = list(machine_names()) + list(checkouts)
    try:
        for f in os.listdir(factory_claims.state_dir()):
            m = re.fullmatch(r"agent-([a-z0-9][a-z0-9-]*)\.json", f)
            if m:
                try:
                    stamp = json.load(open(os.path.join(factory_claims.state_dir(), f)))
                except (OSError, ValueError):
                    continue
                if stamp.get("status") not in (None, "down"):
                    names.append(m.group(1))
    except OSError:
        pass
    return list(dict.fromkeys(n for n in names if re.fullmatch(r"[a-z0-9][a-z0-9-]{0,39}", n)))


def observe(cfg, procs=None):
    """{agent: row}: what this machine shows about each agent, derived and not yet reported anywhere."""
    import factory_claims as fc
    from factory_machine import machine_id
    from factory_resume import session_name
    stale = float(cfg.get("claimStaleHours", 6))
    try:
        data = json.load(open(os.path.join(fc.state_dir(), "claims.json")))
    except (OSError, ValueError):
        data = {}
    checkouts, tasks = data.get("checkouts") or {}, data.get("tasks") or {}
    procs = processes() if procs is None else procs
    sessions = tmux_sessions()
    me = machine_id()
    rows = {}
    for name in known_agents(checkouts):
        claim = checkouts.get(name) or {}
        alive = bool(claim) and fc.alive(claim, stale, loop=True)
        pid = int(claim["pid"]) if alive else None
        task = next((t for t, c in tasks.items() if c.get("agent") == name and fc.alive(c, stale)), None) if alive else None
        wait = waits_in_tree(procs, pid) if alive else None
        row = {**derive({"alive": alive, "task": task, "wait": wait}), "name": name, "kind": KIND, "machine": me,
               "path": claim.get("path"), "pid": pid, "session": None, "follow": None, "activity": None}
        session = session_name(name)
        if session in sessions:
            row["session"] = session
            if alive:
                row["follow"] = follow_url(tmux("capture-pane", "-p", "-J", "-S", "-300", "-t", f"={session}"))
        if alive:
            times = [t for t in (sessions.get(session), transcript_activity(claim.get("path"))) if t]
            row["activity"] = max(times) if times else None
        rows[name] = row
    return rows


# --- reporting to GitHub -----------------------------------------------------------------------------------------

def reach_fields(cfg, row):
    """What goes to GitHub about where the agent runs: only with tasks.showWhere."""
    if not (cfg.get("tasks") or {}).get("showWhere"):
        return {}
    import socket
    return {"where": socket.gethostname(), "session": row.get("session"), "follow": row.get("follow")}


def report(cfg, name, row, now, confirm):
    """Writes one agent's state to GitHub if `plan` says so. Returns 'change', 'keepalive' or None."""
    import factory_agents as FA
    stamp = FA.recall(name)
    state = row["state"]
    if state == "down" and not stamp.get("status"):
        return None  # it never reported, so there is nothing to take back
    if now < float(stamp.get("retry") or 0):
        return None
    reach = reach_fields(cfg, row)
    key = key_of(state, row["task"], row["on"], reach.get("session"), reach.get("follow"))
    rep = {"key": reported_key(stamp), "ping": stamp.get("ping") or 0, "writes": stamp.get("writes") or [],
           "cand": stamp.get("cand")}
    got = plan(key, rep, now, cfg, confirm)
    if not got["write"]:
        if got["cand"] != stamp.get("cand"):
            FA.remember(name, cand=got["cand"])
        return None
    extra = {"kind": row["kind"], "task": row["task"], "on": row["on"], "since": row["since"], "hb": "1", **reach}
    try:
        FA.update(cfg, name, state, row["detail"] if state in ("working", "waiting") else "",
                  create=state != "down", extra=extra, replace_extra=True)
    except (Exception, SystemExit):
        FA.remember(name, retry=now + 60)  # GitHub is not answering: try again in a minute, not every cycle
        raise
    return got["why"]


def reconcile(cfg, rows):
    """At start (a boot): this machine's agents that GitHub shows alive but that are not running here are down."""
    import factory_agents as FA
    from factory_machine import machine_id
    mine = machine_id()
    for issue in FA.current(FA.agent_issues()):
        f, name = FA.fields(issue), FA.name_of(issue)
        if not name or not mine or f.get("machine") != mine or f.get("status") == "down":
            continue
        if rows.get(name, {}).get("state", "down") != "down":
            continue
        FA.update(cfg, name, "down", number=issue["number"])


def cycle(cfg):
    """One look at the machine: the rows, the state file, and the GitHub writes that are due. Returns the rows."""
    from factory_config import task_source
    now = factory_clock.now()
    prev = load_local()
    rows = observe(cfg)
    before = prev.get("agents") or {}
    for name, row in rows.items():
        old = before.get(name) or {}
        row["since"] = old["since"] if old.get("state") == row["state"] and old.get("since") else iso(now)
    errors = []
    boot = prev.get("boot")
    if task_source(cfg) == "issues":
        if boot != str(os.getpid()):
            try:
                reconcile(cfg, rows)
                boot = str(os.getpid())
            except (Exception, SystemExit) as e:
                errors.append(f"start: {str(e)[:160]}")
        confirm = confirm_seconds(cfg)
        for name, row in rows.items():
            try:
                report(cfg, name, row, now, confirm)
            except (Exception, SystemExit) as e:
                errors.append(f"{name}: {str(e)[:160]}")
    else:
        boot = str(os.getpid())
    from factory_machine import machine_id
    save_local({"machine": machine_id(), "pid": os.getpid(), "boot": boot, "updated": now,
                "interval": interval_seconds(cfg), "agents": rows, "errors": errors})
    return rows


# --- running it --------------------------------------------------------------------------------------------------

def acquire_lock():
    """One daemon per project and machine; the lock goes when the process does."""
    from factory_machine import refuse, repo_key, state_dir
    os.makedirs(state_dir(), exist_ok=True)
    f = open(os.path.join(state_dir(), "heartbeat.lock"), "a+")
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        f.seek(0)
        refuse("heartbeat-running", f"The heartbeat daemon already runs for this project (pid {f.read().strip() or '?'}).",
               "Nothing to do: `factory heartbeat status` shows what it sees. To restart it: "
               f"`systemctl --user restart {repo_key()}-factory-heartbeat` (Linux) or "
               f"`launchctl kickstart -k gui/$(id -u)/dev.software-factory.{repo_key()}-heartbeat` (macOS).")
    f.seek(0)
    f.truncate()
    f.write(str(os.getpid()))
    f.flush()
    return f


def run(once=False):
    from factory_config import load
    lock = acquire_lock()  # noqa: F841  (held open for as long as the process lives)
    stop = []
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.append(1))
    while not stop:
        cfg = load()
        try:
            cycle(cfg)
        except (Exception, SystemExit) as e:  # a bad cycle must never end the daemon
            print(f"heartbeat: {str(e)[:200]}", file=sys.stderr, flush=True)
        if once:
            return
        waited, interval = 0.0, interval_seconds(cfg)
        while waited < interval and not stop:
            time.sleep(min(1.0, interval - waited))
            waited += 1.0


def describe(rows):
    lines = []
    for name, r in sorted(rows.items()):
        doing = r.get("detail") or r["state"]
        lines.append(f"  {name:<12} {r['state']:<8} {doing if doing != r['state'] else ''}".rstrip())
    return lines or ["  no agents are known on this machine"]


def status():
    import factory_heartbeat_service as service
    data = load_local()
    if is_fresh(data):
        age = int(factory_clock.now() - float(data["updated"]))
        print(f"daemon: running (pid {data.get('pid')}, last look {age} s ago, every {int(data.get('interval') or 20)} s)")
    else:
        print("daemon: not running" + (" (the last look is old)" if data else ""))
    print("service: " + service.service_text())
    for line in describe(data.get("agents") or {}):
        print(line)
    for e in data.get("errors") or []:
        print(f"  trouble: {e}")


def main(argv):
    from factory_config import load
    cmd = argv[0] if argv else "status"
    if cmd == "run":
        return run()
    if cmd == "once":
        cfg = load()
        rows = cycle(cfg)
        for line in describe(rows):
            print(line)
        return
    if cmd == "status":
        return status()
    if cmd in ("install", "uninstall", "restart"):
        import factory_heartbeat_service as service
        return {"install": service.install_cli, "uninstall": service.uninstall_cli, "restart": service.restart_cli}[cmd]()
    from factory_machine import refuse
    refuse("unknown-command", f"unknown command {cmd!r}.", "Use status, run, once, install, uninstall or restart.")


if __name__ == "__main__":
    main(sys.argv[1:])
