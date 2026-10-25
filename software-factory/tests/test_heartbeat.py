#!/usr/bin/env python3
"""The per-machine heartbeat daemon (#108): real agent liveness (working, waiting, idle, down), written to GitHub
only on change plus a keepalive, and a live `factory agents ls`.  python3 software-factory/tests/test_heartbeat.py

A fake `gh` (it also logs every call), a fake `tmux`, and real processes standing in for a loop and for its
`factory wait` child. Time is fake: FACTORY_NOW moves by hand, so hours of daemon cycles take a moment."""
import contextlib, json, os, re, signal, socket, subprocess, sys, tempfile, time
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
SF = os.path.abspath(os.path.join(HERE, ".."))
HOOKS = os.path.join(SF, "hooks")
sys.path.insert(0, HERE)
sys.path.insert(0, HOOKS)
import test_issues as T  # noqa: E402  (the fake gh that keeps issues in a file)
import test_autostart as A  # noqa: E402  (fake systemctl, launchctl and a project to install into)
import test_doctor as D  # noqa: E402

HEARTBEAT = os.path.join(HOOKS, "factory_heartbeat.py")
AGENTS = os.path.join(HOOKS, "factory_agents.py")
FACTORY = os.path.join(SF, "factory")

FAKE_TMUX = r'''#!/bin/sh
case "$1" in
  list-sessions) [ -f "$FAKE_TMUX_DIR/sessions" ] || exit 1; cat "$FAKE_TMUX_DIR/sessions" ;;
  capture-pane)
    while [ $# -gt 0 ]; do case "$1" in -t) t="${2#=}"; shift ;; esac; shift; done
    [ -f "$FAKE_TMUX_DIR/$t.pane" ] && cat "$FAKE_TMUX_DIR/$t.pane" ;;
esac
'''

GH_LOGGER = '#!/bin/sh\necho "$*" >>"$FAKE_LOG/gh.log"\nexec "$(dirname "$0")/gh.real" "$@"\n'


def iso(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def marker(db, n):
    """The key=value pairs of an agent issue's hidden marker."""
    body = next(i for i in json.load(open(db))["issues"] if i["number"] == n)["body"]
    inner = re.search(r"<!--\s*factory-agent\s+(.*?)\s*-->", body, re.S).group(1)
    return dict(kv.split("=", 1) for kv in inner.split())


def issue_of(db, n):
    return next(i for i in json.load(open(db))["issues"] if i["number"] == n)


class World:
    """One project with a fake gh, a fake tmux, this machine's config, and a clock that moves by hand."""

    AGENT_ISSUE = 99

    def __init__(self, issues=(), agent="taytu", tasks=None, status="idle", agent_issue=True):
        self.d, self.db, env = T.setup(list(issues))
        real = os.path.join(self.d, "bin", "gh")
        os.rename(real, real + ".real")
        open(real, "w").write(GH_LOGGER)
        os.chmod(real, 0o755)
        tmux = os.path.join(self.d, "bin", "tmux")
        open(tmux, "w").write(FAKE_TMUX)
        os.chmod(tmux, 0o755)
        self.repo = os.path.basename(self.d)
        self.clock = int(time.time())
        self.log_dir = tempfile.mkdtemp()
        self.tmux_dir = tempfile.mkdtemp()
        self.state_home = tempfile.mkdtemp()
        self.config_dir = tempfile.mkdtemp()
        json.dump({"agents": [agent]}, open(os.path.join(self.config_dir, self.repo + ".json"), "w"))
        json.dump({"tasks": {"source": "issues", **(tasks or {})}, "agents": ["menelik", "taytu", "haile"]},
                  open(os.path.join(self.d, ".claude", "factory.json"), "w"))
        self.env = {**env, "FACTORY_MACHINE_ID": "aaaa1111", "FACTORY_CONFIG_DIR": self.config_dir,
                    "XDG_STATE_HOME": self.state_home, "FAKE_LOG": self.log_dir, "FAKE_TMUX_DIR": self.tmux_dir,
                    "FACTORY_NOW": str(self.clock), "FACTORY_HEARTBEAT_SECONDS": "20"}
        for k in ("FACTORY_AGENT", "FACTORY_AGENTS", "FACTORY_LOOP", "CLAUDE_PROJECT_DIR"):
            self.env.pop(k, None)
        self.agent = agent
        self.procs = []
        if agent_issue:
            self.add_agent_issue(self.AGENT_ISSUE, agent, status, machine="aaaa1111", hb=True)

    # --- the clock -------------------------------------------------------------------------------------------
    def advance(self, seconds):
        self.clock += seconds
        self.env["FACTORY_NOW"] = str(self.clock)

    # --- GitHub ----------------------------------------------------------------------------------------------
    def add_agent_issue(self, n, name, status, ping=None, machine="aaaa1111", hb=False, **fields):
        ping = iso(self.clock if ping is None else ping)
        pairs = {"name": name, "status": status, "ping": ping, **({"machine": machine} if machine else {}),
                 **({"hb": "1"} if hb else {}), **fields}
        body = "<!-- factory-agent " + " ".join(f"{k}={v}" for k, v in pairs.items()) + " -->\n**Status:** x"
        db = json.load(open(self.db))
        db["issues"].append({"number": n, "title": f"Agent: {name} · {status}", "body": body, "state": "open",
                             "labels": [{"name": "factory:agent"}], "milestone": None,
                             "updated_at": "2020-01-01T00:00:00Z"})
        json.dump(db, open(self.db, "w"))

    def gh_calls(self):
        try:
            return open(os.path.join(self.log_dir, "gh.log")).read().splitlines()
        except FileNotFoundError:
            return []

    def patches(self, n=None):
        """The PATCH calls made on GitHub (all issues, or issue n)."""
        return [l for l in self.gh_calls() if "-X PATCH" in l and (n is None or f"/issues/{n} " in l + " ")]

    # --- a loop and what it waits for -------------------------------------------------------------------------
    def start_loop(self, agent=None, wait=None):
        """A live process that `ps` shows as a factory-loop.sh, with a `factory_wait.py <args>` child when `wait`."""
        agent = agent or self.agent
        folder = tempfile.mkdtemp()
        open(os.path.join(folder, "factory_wait.py"), "w").write("#!/bin/sh\nsleep 600\n")
        os.chmod(os.path.join(folder, "factory_wait.py"), 0o755)
        script = os.path.join(folder, "factory-loop.sh")
        child = f'"$D/factory_wait.py" {wait} &\n' if wait else ""
        open(script, "w").write(f'#!/bin/sh\nD=$(dirname "$0")\n{child}sleep 600 &\nwait\n')
        os.chmod(script, 0o755)
        p = subprocess.Popen([script], start_new_session=True)
        self.procs.append(p)
        self.claim_checkout(agent, p.pid)
        time.sleep(0.3)  # let the shell start its children
        return p

    def kill(self, p):
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(p.pid, signal.SIGKILL)
        p.wait()

    def close(self):
        for p in self.procs:
            self.kill(p)

    def claims_file(self):
        d = os.path.join(self.d, ".git", "factory")
        os.makedirs(d, exist_ok=True)
        return os.path.join(d, "claims.json")

    def claims(self):
        try:
            return json.load(open(self.claims_file()))
        except (OSError, ValueError):
            return {"checkouts": {}, "tasks": {}}

    def save_claims(self, data):
        json.dump(data, open(self.claims_file(), "w"))

    def claim_checkout(self, agent, pid):
        data = self.claims()
        data["checkouts"][agent] = {"agent": agent, "pid": pid, "host": socket.gethostname(), "at": time.time(),
                                    "path": self.d}
        self.save_claims(data)

    def claim_task(self, task, agent=None):
        data = self.claims()
        agent = agent or self.agent
        data["tasks"][task] = {"agent": agent, "pid": data["checkouts"][agent]["pid"], "host": socket.gethostname(),
                               "at": time.time()}
        self.save_claims(data)

    def drop_task(self, task):
        data = self.claims()
        data["tasks"].pop(task, None)
        self.save_claims(data)

    # --- tmux ------------------------------------------------------------------------------------------------
    def tmux_session(self, agent=None, activity=None, pane=""):
        agent = agent or self.agent
        name = f"{self.repo}-{agent}"
        with open(os.path.join(self.tmux_dir, "sessions"), "a") as f:
            f.write(f"{name} {int(self.clock if activity is None else activity)}\n")
        open(os.path.join(self.tmux_dir, name + ".pane"), "w").write(pane)

    # --- running the code in this process, in the project's environment ---------------------------------------
    @contextlib.contextmanager
    def here(self):
        saved_env, saved_cwd = dict(os.environ), os.getcwd()
        os.environ.clear()
        os.environ.update(self.env)
        os.chdir(self.d)
        try:
            yield
        finally:
            os.chdir(saved_cwd)
            os.environ.clear()
            os.environ.update(saved_env)

    def cycle(self):
        import factory_config, factory_heartbeat
        with self.here():
            return factory_heartbeat.cycle(factory_config.load())

    def run_for(self, seconds, step=20):
        for _ in range(0, seconds, step):
            self.advance(step)
            self.cycle()

    def sweep(self):
        import factory_agents, factory_config
        with self.here():
            return factory_agents.sweep(factory_config.load())

    def state_file(self):
        return os.path.join(self.state_home, self.repo + "-factory", "heartbeat.json")

    def cli(self, script, *args, stdin=None, extra_env=None):
        return subprocess.run([sys.executable, script, *args], cwd=self.d, env={**self.env, **(extra_env or {})},
                              capture_output=True, text=True, input=stdin, timeout=120)


@contextlib.contextmanager
def world(*a, **kw):
    w = World(*a, **kw)
    try:
        yield w
    finally:
        w.close()


# --- reading what is running: waits, and the follow link ----------------------------------------------------------

def test_what_an_agent_waits_for_is_read_from_the_command_it_runs():
    import factory_heartbeat as H
    cases = {
        "python3 /p/.claude/hooks/factory_wait.py ci 12": ("ci:12", "CI on PR #12"),
        "python3 /p/.claude/hooks/factory_wait.py answer 7 45": ("answer:7", "an answer on PR #7"),
        "python3 /p/.claude/hooks/factory_wait.py slot": ("slot", "a free PR slot"),
        "python3 /p/.claude/hooks/factory_wait.py ready 20": ("ready", "a ready task"),
        "bash /p/.claude/hooks/wait_for_merge.sh 33 30": ("merge:33", "the merge of PR #33"),
        "bash /p/factory wait 33": ("merge:33", "the merge of PR #33"),
        "bash /p/factory wait ci 5 10": ("ci:5", "CI on PR #5"),
        "bash /p/factory wait slot": ("slot", "a free PR slot"),
    }
    for args, (on, text) in cases.items():
        got = H.parse_wait(args)
        assert got and got["on"] == on and got["text"] == text, (args, got)
    for args in ("python3 factory_wait.py precheck", "bash /p/factory next", "sleep 30", "python3 factory_agents.py ping"):
        assert H.parse_wait(args) is None, args


def test_a_wait_counts_only_below_the_agents_own_process():
    import factory_heartbeat as H
    procs = {100: (1, "bash factory-loop.sh"), 101: (100, "claude --remote-control haile 42"),
             102: (101, "bash -c factory wait ci 12"), 103: (102, "python3 factory_wait.py ci 12"),
             200: (1, "bash factory-loop.sh"), 201: (200, "python3 factory_wait.py slot")}
    assert H.waits_in_tree(procs, 100)["on"] == "ci:12"
    assert H.waits_in_tree(procs, 200)["on"] == "slot"
    assert H.waits_in_tree({100: (1, "bash factory-loop.sh"), 101: (100, "claude")}, 100) is None
    assert H.waits_in_tree(procs, 999) is None


def test_the_remote_control_link_is_read_from_the_pane():
    import factory_heartbeat as H
    pane = "Claude Code\n/remote-control is active · https://claude.ai/code/session_01AbC-xyz_9\nmore text\n"
    assert H.follow_url(pane) == "https://claude.ai/code/session_01AbC-xyz_9"
    assert H.follow_url("see https://evil.example/code/session_1 and https://claude.ai.evil.example/code/x") is None
    assert H.follow_url("") is None


# --- the state ------------------------------------------------------------------------------------------------

def test_state_comes_from_the_process_the_task_and_the_wait():
    import factory_heartbeat as H
    assert H.derive({"alive": False, "task": "issue-42", "wait": None})["state"] == "down"
    assert H.derive({"alive": False, "task": None, "wait": {"on": "slot", "text": "a free PR slot"}})["state"] == "down"
    got = H.derive({"alive": True, "task": None, "wait": None})
    assert got["state"] == "idle" and got["detail"] == "idle", got
    got = H.derive({"alive": True, "task": "issue-42", "wait": None})
    assert got["state"] == "working" and got["detail"] == "working on #42" and got["task"] == "42", got
    got = H.derive({"alive": True, "task": "3.2", "wait": None})
    assert got["detail"] == "working on 3.2" and got["task"] == "3.2", got
    got = H.derive({"alive": True, "task": "issue-42", "wait": {"on": "ci:12", "text": "CI on PR #12"}})
    assert got["state"] == "waiting" and got["detail"] == "waiting for CI on PR #12" and got["on"] == "ci:12", got
    assert got["task"] == "42"


# --- when to write ----------------------------------------------------------------------------------------------

def rep(key="idle", ping=0, writes=(), cand=None):
    return {"key": key, "ping": ping, "writes": list(writes), "cand": cand}


def test_an_unchanged_state_is_written_only_as_a_keepalive():
    import factory_heartbeat as H
    cfg = {"tasks": {"pingMinutes": 5}}
    assert H.plan("idle", rep("idle", ping=1000), 1000 + 299, cfg, 15)["write"] is False
    got = H.plan("idle", rep("idle", ping=1000), 1000 + 300, cfg, 15)
    assert got["write"] is True and got["why"] == "keepalive", got


def test_a_change_is_written_once_it_has_lasted_a_few_seconds():
    import factory_heartbeat as H
    cfg = {"tasks": {"pingMinutes": 5}}
    first = H.plan("waiting", rep("idle", ping=1000), 1010, cfg, 15)
    assert first["write"] is False and first["cand"] == {"key": "waiting", "at": 1010}, first
    second = H.plan("waiting", rep("idle", ping=1000, cand=first["cand"]), 1030, cfg, 15)
    assert second["write"] is True and second["why"] == "change", second
    flicker = H.plan("idle", rep("idle", ping=1000, cand=first["cand"]), 1030, cfg, 15)  # it went away again
    assert flicker["write"] is False and flicker["cand"] is None, flicker


def test_flapping_never_writes_more_than_twelve_times_an_hour_but_down_always_goes_out():
    import factory_heartbeat as H
    cfg = {"tasks": {"pingMinutes": 5}}
    r = rep("idle", ping=0)
    writes = []
    now = 0
    for step in range(3 * 3600 // 20):  # three hours, a cycle every 20 s, the state changes every 60 s
        now += 20
        key = "working" if (step // 3) % 2 else "waiting"
        got = H.plan(key, r, now, cfg, 15)
        r["cand"] = got["cand"]
        if got["write"]:
            writes.append(now)
            r.update(key=key, ping=now, writes=[t for t in r["writes"] if now - t < 3600] + [now], cand=None)
    assert len(writes) > 12, "it never wrote enough to test the cap"
    for t in writes:
        assert len([w for w in writes if t - 3600 < w <= t]) <= 12, (t, writes)
    down = H.plan("down", r, now + 20, cfg, 15)
    down = H.plan("down", {**r, "cand": down["cand"]}, now + 40, cfg, 15)
    assert down["write"] is True, down  # even when the hour's budget is spent


# --- the daemon, end to end -------------------------------------------------------------------------------------

def test_an_agent_waiting_in_a_wait_for_forty_five_minutes_shows_waiting_and_is_not_swept():
    with world([T.issue(1, labels=("factory:in-progress", "agent:taytu"))]) as w:
        w.start_loop(wait="slot")
        w.claim_task("issue-1")
        w.run_for(45 * 60)
        m = marker(w.db, w.AGENT_ISSUE)
        assert m["status"] == "waiting" and m["on"] == "slot" and m["task"] == "1" and m["hb"] == "1", m
        assert issue_of(w.db, w.AGENT_ISSUE)["title"] == "Agent: taytu · waiting for a free PR slot"
        assert w.sweep() == [], "a live, waiting agent was swept"
        assert [l["name"] for l in issue_of(w.db, 1)["labels"]] == ["factory:in-progress", "agent:taytu"]
        out = w.cli(AGENTS, "list").stdout
        assert " waiting " in out and "silent" not in out, out
        assert len(w.patches(w.AGENT_ISSUE)) <= 11, len(w.patches(w.AGENT_ISSUE))  # one change, then keepalives


def test_killing_the_session_shows_down_within_two_minutes_and_then_stays_quiet():
    with world() as w:
        p = w.start_loop()
        w.claim_task("issue-5")
        w.run_for(120)
        assert marker(w.db, w.AGENT_ISSUE)["status"] == "working"
        died = w.clock
        w.kill(p)
        seen = None
        for _ in range(6):
            w.advance(20)
            w.cycle()
            if marker(w.db, w.AGENT_ISSUE)["status"] == "down":
                seen = w.clock - died
                break
        assert seen is not None and seen <= 120, seen
        assert "factory:agent-down" in [l["name"] for l in issue_of(w.db, w.AGENT_ISSUE)["labels"]]
        before = len(w.patches())
        w.run_for(600)
        assert len(w.patches()) == before, "kept writing after down"


def test_working_and_idle_follow_the_task_claim_and_a_write_is_one_patch():
    with world() as w:
        w.start_loop()
        w.run_for(60)
        assert marker(w.db, w.AGENT_ISSUE)["status"] == "idle"
        w.claim_task("issue-8")
        n = len(w.gh_calls())
        w.run_for(60)
        m = marker(w.db, w.AGENT_ISSUE)
        assert m["status"] == "working" and m["task"] == "8" and "since" in m, m
        assert issue_of(w.db, w.AGENT_ISSUE)["title"] == "Agent: taytu · working on #8"
        new = w.gh_calls()[n:]
        assert len(new) == 1 and "-X PATCH" in new[0], new  # no label calls for a change between live states


def test_a_state_that_lasts_less_than_the_confirm_time_is_not_written():
    with world() as w:
        w.start_loop()
        w.run_for(40)
        n = len(w.patches())
        w.claim_task("issue-8")
        w.advance(5)
        w.cycle()  # seen once, just now: not yet
        assert len(w.patches()) == n
        w.drop_task("issue-8")
        w.run_for(60)
        assert len(w.patches()) == n and marker(w.db, w.AGENT_ISSUE)["status"] == "idle"


def test_writes_per_agent_stay_within_twelve_an_hour_even_when_the_agent_changes_state_all_the_time():
    with world() as w:
        w.start_loop()
        history = []  # (clock, patches so far)
        for step in range(2 * 3600 // 20):
            w.advance(20)
            if (step // 6) % 2:
                w.claim_task("issue-3")
            else:
                w.drop_task("issue-3")
            w.cycle()
            history.append((w.clock, len(w.patches(w.AGENT_ISSUE))))
        assert history[-1][1] > 12, "it never changed state often enough to test the cap"
        for t, count in history:
            then = max([c for tt, c in history if tt <= t - 3600] or [0])
            assert count - then <= 12, (t, count, then)


def test_a_boot_marks_this_machines_dead_agents_down_at_once_and_leaves_other_machines_alone():
    with world(agent_issue=False) as w:
        w.add_agent_issue(50, "taytu", "working", ping=w.clock - 3600, machine="aaaa1111")
        w.add_agent_issue(51, "haile", "working", ping=w.clock - 60, machine="bbbb2222")
        w.cycle()
        assert marker(w.db, 50)["status"] == "down"
        assert marker(w.db, 51)["status"] == "working"
        before = len(w.patches())
        w.run_for(120)
        assert len(w.patches()) == before


def test_a_machine_that_never_ran_an_agent_writes_nothing():
    with world(agent_issue=False) as w:
        w.run_for(120)
        assert w.patches() == [] and not [l for l in w.gh_calls() if "-X POST" in l], w.gh_calls()
        assert len(w.gh_calls()) <= 1, w.gh_calls()  # at most the one look at the agent issues when it starts


def test_reach_information_goes_to_github_only_with_show_where():
    pane = "/remote-control is active · https://claude.ai/code/session_01Q\n"
    for show in (False, True):
        with world(tasks={"showWhere": show}) as w:
            w.start_loop()
            w.tmux_session(pane=pane)
            w.run_for(60)
            m = marker(w.db, w.AGENT_ISSUE)
            if show:
                assert m.get("session") == f"{w.repo}-taytu" and m.get("follow") == "https://claude.ai/code/session_01Q", m
            else:
                assert "session" not in m and "follow" not in m and "where" not in m, m
                assert "claude.ai" not in issue_of(w.db, w.AGENT_ISSUE)["body"]
            local = json.load(open(w.state_file()))["agents"]["taytu"]
            assert local["follow"] == "https://claude.ai/code/session_01Q" and local["session"] == f"{w.repo}-taytu", local


def test_the_local_file_says_what_the_daemon_saw():
    with world() as w:
        w.start_loop(wait="ci 12")
        w.claim_task("issue-4")
        w.tmux_session(activity=w.clock - 30)
        w.run_for(40)
        data = json.load(open(w.state_file()))
        assert data["machine"] == "aaaa1111" and data["updated"] == w.clock and data["interval"] == 20, data
        a = data["agents"]["taytu"]
        assert a["state"] == "waiting" and a["task"] == "4" and a["on"] == "ci:12", a
        assert a["kind"] == "coding-agent" and a["activity"] >= w.clock - 80, a


def test_the_daemon_runs_once_per_project_and_a_second_copy_says_so():
    with world() as w:
        env = {**w.env, "FACTORY_HEARTBEAT_SECONDS": "5"}
        first = subprocess.Popen([sys.executable, HEARTBEAT, "run"], cwd=w.d, env=env, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, text=True)
        try:
            for _ in range(100):
                if os.path.exists(w.state_file()):
                    break
                time.sleep(0.1)
            assert os.path.exists(w.state_file()), "the daemon wrote no state file"
            second = subprocess.run([sys.executable, HEARTBEAT, "run"], cwd=w.d, env=env, capture_output=True,
                                    text=True, timeout=30)
            assert second.returncode == 1, second
            err = json.loads(second.stderr.strip().splitlines()[-1])
            assert err["code"] == "heartbeat-running" and err["fix"], err
        finally:
            first.terminate()
            first.wait(timeout=10)


def test_a_github_failure_is_retried_later_and_never_stops_the_daemon():
    with world() as w:
        w.start_loop()
        w.claim_task("issue-2")
        os.rename(w.db, w.db + ".gone")  # the fake gh now fails
        w.run_for(60)
        assert json.load(open(w.state_file()))["agents"]["taytu"]["state"] == "working"
        os.rename(w.db + ".gone", w.db)
        w.run_for(120)
        assert marker(w.db, w.AGENT_ISSUE)["status"] == "working"


# --- the other writers step aside -------------------------------------------------------------------------------

def hook(w, event, agent="taytu"):
    return subprocess.run([sys.executable, AGENTS, "hook"], cwd=w.d, env={**w.env, "FACTORY_AGENT": agent},
                          input=json.dumps({"hook_event_name": event}), capture_output=True, text=True)


def test_hooks_leave_idle_to_the_daemon_while_it_runs_but_session_end_still_says_down():
    with world() as w:
        w.start_loop()
        w.claim_task("issue-2")
        w.run_for(60)
        assert marker(w.db, w.AGENT_ISSUE)["status"] == "working"
        n = len(w.patches())
        assert hook(w, "PostToolUse").returncode == 0
        assert hook(w, "Stop").returncode == 0  # a turn ends mid-task: the daemon knows it is still working
        time.sleep(0.5)
        assert len(w.patches()) == n, "a hook wrote while the daemon is running"
        assert hook(w, "SessionEnd").returncode == 0
        assert marker(w.db, w.AGENT_ISSUE)["status"] == "down"


def test_hooks_write_as_before_when_no_daemon_runs():
    with world() as w:
        w.start_loop()
        w.claim_task("issue-2")
        w.run_for(60)
        w.advance(600)  # the daemon's file is old now: nobody is running it
        n = len(w.patches())
        assert hook(w, "Stop").returncode == 0
        assert len(w.patches()) == n + 1 and marker(w.db, w.AGENT_ISSUE)["status"] == "idle"


# --- the sweep uses real liveness -------------------------------------------------------------------------------

def test_a_silent_looking_agent_that_is_alive_here_is_not_swept():
    import factory_agents
    with world([T.issue(1, labels=("factory:in-progress", "agent:taytu"))]) as w:
        w.start_loop(wait="ci 3")
        w.claim_task("issue-1")
        w.run_for(60)
        db = json.load(open(w.db))
        a = next(i for i in db["issues"] if i["number"] == w.AGENT_ISSUE)
        a["body"] = re.sub(r"ping=\S+", f"ping={iso(w.clock - 25 * 60)}", a["body"])
        json.dump(db, open(w.db, "w"))
        with w.here():
            assert factory_agents.state_of({"tasks": {}}, issue_of(w.db, w.AGENT_ISSUE))[1] == "silent"
        assert w.sweep() == [], "swept an agent whose process is alive and waiting"
        assert [l["name"] for l in issue_of(w.db, 1)["labels"]] == ["factory:in-progress", "agent:taytu"]


def test_a_missed_keepalive_counts_as_silent_within_minutes_for_a_daemon_managed_agent():
    import factory_agents
    with world(agent_issue=False) as w:
        w.add_agent_issue(60, "taytu", "working", ping=w.clock - 13 * 60, hb=True)
        w.add_agent_issue(61, "haile", "working", ping=w.clock - 13 * 60, machine="bbbb2222")
        w.add_agent_issue(62, "menelik", "working", ping=w.clock - 11 * 60, hb=True)
        with w.here():
            cfg = {"tasks": {}}
            assert factory_agents.state_of(cfg, issue_of(w.db, 60))[1] == "silent"
            assert factory_agents.state_of(cfg, issue_of(w.db, 61))[1] == "working"  # no daemon: the old 30 minutes
            assert factory_agents.state_of(cfg, issue_of(w.db, 62))[1] == "working"


def test_sweep_gives_a_down_agents_task_back_after_a_grace_period_and_not_before():
    for minutes, released in ((3, False), (11, True)):
        with world([T.issue(1, labels=("factory:in-progress", "agent:taytu"))], agent_issue=False) as w:
            w.add_agent_issue(70, "taytu", "down", ping=w.clock - minutes * 60)
            out = w.sweep()
            labels = [l["name"] for l in issue_of(w.db, 1)["labels"]]
            if released:
                assert labels == ["factory:ready"] and out and "released #1" in out[0], (labels, out)
            else:
                assert labels == ["factory:in-progress", "agent:taytu"] and out == [], (labels, out)


def test_a_cloud_agent_reports_its_kind_place_and_link_with_every_ping():
    with world(agent_issue=False) as w:
        link = "https://claude.ai/code/session_01DEV"
        p = w.cli(AGENTS, "register", "--agent", "dev-manager", "--kind", "dev-manager", "--cloud", "--follow", link)
        assert p.returncode == 0, p
        n = int(p.stdout.strip().lstrip("#"))
        m = marker(w.db, n)
        assert m["kind"] == "dev-manager" and m["where"] == "cloud" and m["follow"] == link, m
        w.cli(AGENTS, "ping", "--agent", "dev-manager", "--status", "working on #9", "--force")
        m = marker(w.db, n)
        assert m["follow"] == link and m["where"] == "cloud" and m["status"] == "working", m
        bad = w.cli(AGENTS, "register", "--agent", "po", "--cloud", "--follow", "https://evil.example/x --> <b>")
        assert bad.returncode != 0 and "follow" in bad.stderr, bad


# --- factory agents ls ------------------------------------------------------------------------------------------

def ls(w, *args):
    return w.cli(AGENTS, "ls", *args)


def fleet(w):
    w.add_agent_issue(80, "haile", "waiting", ping=w.clock - 120, machine="bbbb2222", hb=True, kind="coding-agent",
                      task="31", on="ci:44", since=iso(w.clock - 900))
    w.add_agent_issue(81, "dev-manager", "working", ping=w.clock - 60, machine="", kind="dev-manager", where="cloud",
                      follow="https://claude.ai/code/session_01DEV", since=iso(w.clock - 7200))


def test_ls_shows_local_agents_from_the_state_file_and_the_others_from_github():
    with world() as w:
        fleet(w)
        w.start_loop(wait="ci 12")
        w.claim_task("issue-4")
        w.tmux_session(pane="/remote-control is active · https://claude.ai/code/session_01Q\n")
        w.run_for(60)
        p = ls(w, "--json")
        assert p.returncode == 0, p
        rows = {r["name"]: r for r in json.loads(p.stdout)["agents"]}
        t = rows["taytu"]
        assert (t["state"], t["kind"], t["where"], t["task"], t["on"]) == ("waiting", "coding agent", "this machine", "4", "ci:12"), t
        assert t["follow"] == "https://claude.ai/code/session_01Q" and t["session"] == f"{w.repo}-taytu", t
        assert t["since"] and t["lastSeen"] and t["source"] == "local", t
        h = rows["haile"]
        assert (h["state"], h["where"], h["task"], h["on"], h["source"]) == ("waiting", "machine bbbb2222", "31", "ci:44", "github"), h
        c = rows["dev-manager"]
        assert (c["kind"], c["where"], c["follow"]) == ("dev manager", "cloud", "https://claude.ai/code/session_01DEV"), c
        text = ls(w).stdout
        for word in ("taytu", "haile", "dev-manager", "waiting", "cloud", "this machine", "session_01DEV", "session_01Q"):
            assert word in text, (word, text)
        assert "STATE" not in text and "State" in text, text  # sentence case, no all-caps labels


def test_ls_reads_this_machine_without_asking_github_and_caches_the_others():
    with world() as w:
        fleet(w)
        w.start_loop()
        w.run_for(40)
        before = len(w.gh_calls())
        local = ls(w, "--local")
        assert local.returncode == 0 and "taytu" in local.stdout and "haile" not in local.stdout, local
        assert len(w.gh_calls()) == before, "--local asked GitHub"
        ls(w)
        asked = len(w.gh_calls())
        assert asked > before
        ls(w)
        assert len(w.gh_calls()) == asked, "a second ls within the cache time asked GitHub again"
        w.advance(90)
        ls(w)
        assert len(w.gh_calls()) > asked, "the cache never expired"
        n = len(w.gh_calls())
        ls(w, "--fresh")
        assert len(w.gh_calls()) > n, "--fresh used the cache"


def test_ls_still_lists_this_machine_when_github_cannot_be_reached():
    with world() as w:
        w.start_loop()
        w.run_for(40)
        os.rename(w.db, w.db + ".gone")
        p = ls(w, "--fresh")
        assert p.returncode == 0 and "taytu" in p.stdout and "GitHub" in p.stdout, p
        data = json.loads(ls(w, "--fresh", "--json").stdout)
        assert data["github"]["error"] and [r["name"] for r in data["agents"]] == ["taytu"], data


def test_ls_without_a_daemon_derives_this_machine_on_the_spot_and_says_how_to_start_it():
    with world(agent_issue=False) as w:
        w.start_loop()
        w.claim_task("issue-6")
        p = ls(w, "--local")
        assert "working" in p.stdout and "factory heartbeat install" in p.stdout, p
        assert not os.path.exists(w.state_file()), "ls must not write the daemon's file"


def test_ls_marks_a_missed_keepalive_as_silent():
    with world(agent_issue=False) as w:
        w.add_agent_issue(90, "haile", "working", ping=w.clock - 15 * 60, machine="bbbb2222", hb=True)
        rows = {r["name"]: r for r in json.loads(ls(w, "--json").stdout)["agents"]}
        assert rows["haile"]["state"] == "silent", rows


# --- installing the daemon with autostart -----------------------------------------------------------------------

def unit_path(env, name):
    return os.path.join(env["XDG_CONFIG_HOME"], "systemd", "user", name)


def test_heartbeat_install_on_linux_writes_a_restarting_user_service_and_starts_it():
    clone = A.project()
    env = A.machine(clone)
    p = A.py(HEARTBEAT, clone, env, "install")
    assert p.returncode == 0, p
    text = open(unit_path(env, "proj-factory-heartbeat.service")).read()
    assert "Type=simple" in text and "Restart=always" in text and "WantedBy=default.target" in text, text
    assert re.search(r'^ExecStart=/bin/bash ".*/factory" heartbeat run$', text, re.M), text
    assert f"WorkingDirectory={clone}" in text, text
    sc = A.log(env, "systemctl")
    assert "--user enable --now proj-factory-heartbeat.service" in sc, sc
    status = A.py(HEARTBEAT, clone, env, "status").stdout
    assert "service: installed" in status, status
    assert "enable-linger" in A.log(env, "loginctl")
    q = A.py(HEARTBEAT, clone, env, "uninstall")
    assert q.returncode == 0 and not os.path.exists(unit_path(env, "proj-factory-heartbeat.service")), q
    assert "disable --now proj-factory-heartbeat.service" in A.log(env, "systemctl")


def test_heartbeat_restart_restarts_an_installed_service_and_does_nothing_without_one():
    clone = A.project()
    env = A.machine(clone)
    p = A.py(HEARTBEAT, clone, env, "restart")
    assert p.returncode == 0 and p.stdout == "" and "restart" not in A.log(env, "systemctl"), p
    assert A.py(HEARTBEAT, clone, env, "install").returncode == 0
    p = A.py(HEARTBEAT, clone, env, "restart")
    assert p.returncode == 0 and "Restarted proj-factory-heartbeat.service" in p.stdout, p
    assert "--user restart proj-factory-heartbeat.service" in A.log(env, "systemctl"), A.log(env, "systemctl")


def test_heartbeat_install_on_macos_writes_a_keep_alive_launch_agent():
    import plistlib
    clone = A.project()
    env = A.machine(clone, extra={"FACTORY_AUTOSTART_PLATFORM": "mac"})
    p = A.py(HEARTBEAT, clone, env, "install")
    assert p.returncode == 0, p
    plist = os.path.join(env["HOME"], "Library", "LaunchAgents", "dev.software-factory.proj-heartbeat.plist")
    data = plistlib.load(open(plist, "rb"))
    assert data["ProgramArguments"][-3:] == [os.path.join(clone, "factory"), "heartbeat", "run"], data
    assert data["RunAtLoad"] is True and data["KeepAlive"] is True and data["WorkingDirectory"] == clone, data
    assert "bootstrap" in A.log(env, "launchctl")
    assert A.py(HEARTBEAT, clone, env, "uninstall").returncode == 0 and not os.path.exists(plist)


def test_autostart_installs_and_removes_the_heartbeat_with_the_boot_service_unless_told_not_to():
    clone = A.project()
    env = A.machine(clone)
    p = A.py(A.AUTOSTART, clone, env, "install", "--agents", "haile")
    assert p.returncode == 0, p
    assert os.path.exists(unit_path(env, "proj-factory-resume.service"))
    assert os.path.exists(unit_path(env, "proj-factory-heartbeat.service")), p.stdout
    assert "heartbeat" in p.stdout, p.stdout
    status = A.py(A.AUTOSTART, clone, env, "status").stdout
    assert "heartbeat: installed" in status, status
    A.py(A.AUTOSTART, clone, env, "uninstall")
    assert not os.path.exists(unit_path(env, "proj-factory-heartbeat.service"))
    assert not os.path.exists(unit_path(env, "proj-factory-resume.service"))

    clone = A.project()
    env = A.machine(clone)
    p = A.py(A.AUTOSTART, clone, env, "install", "--agents", "haile", "--no-heartbeat")
    assert p.returncode == 0, p
    assert not os.path.exists(unit_path(env, "proj-factory-heartbeat.service"))
    assert "factory heartbeat install" in A.py(A.AUTOSTART, clone, env, "status").stdout


def test_doctor_notes_a_missing_daemon_and_agents_cannot_install_or_stop_it():
    deny = json.load(open(os.path.join(SF, "kit", ".claude", "settings.json")))["permissions"]["deny"]
    for rule in ("Bash(factory heartbeat install*)", "Bash(factory heartbeat uninstall*)",
                 "Bash(./factory heartbeat install*)", "Bash(./factory heartbeat uninstall*)",
                 "Bash(*factory_heartbeat*)"):
        assert rule in deny, rule
    d = D.project(cfg={"agents": ["menelik", "taytu"], "tasks": {"source": "issues"}})
    p = D.doctor(d, {**D.machine(), "FACTORY_AGENTS": "taytu"})
    assert any("heartbeat" in l and "factory heartbeat install" in l for l in D.lines(p, "note")), p.stdout
    d = D.project()  # plan mode: nothing reports to GitHub, so nothing to say
    p = D.doctor(d, {**D.machine(), "FACTORY_AGENTS": "taytu"})
    assert not any("heartbeat" in l for l in p.stdout.splitlines()), p.stdout


def test_help_and_settings_know_the_heartbeat():
    d = D.project()
    env = D.machine()
    out = subprocess.run(["bash", FACTORY, "help"], cwd=d, env=env, capture_output=True, text=True).stdout
    assert "heartbeat" in out and "agents ls" in out, out
    shown = subprocess.run(["bash", FACTORY, "settings"], cwd=d, env=env, capture_output=True, text=True).stdout
    for key in ("tasks.heartbeatSeconds", "tasks.heartbeatMissMinutes", "tasks.releaseDownMinutes"):
        assert key in shown, (key, shown)


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
