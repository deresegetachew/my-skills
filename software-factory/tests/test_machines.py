#!/usr/bin/env python3
"""Per-machine agent names and a machine id in claims and agent pings (#45).
python3 software-factory/tests/test_machines.py"""
import json, os, subprocess, sys, tempfile
from datetime import datetime, timedelta, timezone

import test_agent_names as N
import test_issues as T

HOOKS = T.HOOKS
MACHINE = os.path.join(HOOKS, "factory_machine.py")


def with_machine(env, machine, **extra):
    return {**env, "FACTORY_MACHINE_ID": machine, **extra}


def claims_in(db, n):
    return [c["body"] for c in json.load(open(db)).get("comments", {}).get(str(n), [])]


# --- per-machine names -------------------------------------------------------------------------------------------

def checkout(clone, config_dir, machine, agents=None):
    loop = N.a_loop()
    env = {**N.ENV, "FACTORY_CONFIG_DIR": config_dir, "FACTORY_MACHINE_ID": machine}
    if agents is not None:
        env["FACTORY_AGENTS"] = agents
    p = subprocess.run([sys.executable, N.CLAIMS, "checkout", "--pid", str(loop.pid)], cwd=clone, env=env,
                       capture_output=True, text=True)
    return p, loop


def test_each_machine_takes_names_from_its_own_config_file():
    loops = []
    try:
        names = {}
        for machine, mine in (("aaaa1111", ["menelik", "taytu"]), ("bbbb2222", ["haile", "tewodros"])):
            clone, cfgdir = N.project(), tempfile.mkdtemp()  # same factory.json, a different machine each
            json.dump({"agents": mine}, open(os.path.join(cfgdir, "proj.json"), "w"))
            p, l = checkout(clone, cfgdir, machine)
            loops.append(l)
            assert p.returncode == 0, p
            names[machine] = p.stdout.split()[0]
        assert names == {"aaaa1111": "menelik", "bbbb2222": "haile"}, names
    finally:
        for l in loops:
            l.kill()


def test_the_environment_beats_the_config_file_and_an_unknown_name_is_refused():
    clone, cfgdir = N.project(), tempfile.mkdtemp()
    json.dump({"agents": ["menelik"]}, open(os.path.join(cfgdir, "proj.json"), "w"))
    p, l = checkout(clone, cfgdir, "aaaa1111", agents="tewodros")
    l.kill()
    assert p.returncode == 0 and p.stdout.split()[0] == "tewodros", p
    json.dump({"agents": ["nobody"]}, open(os.path.join(cfgdir, "proj.json"), "w"))
    p, l = checkout(clone, cfgdir, "aaaa1111")
    l.kill()
    assert p.returncode != 0 and "nobody" in p.stderr, p


def test_without_any_machine_config_names_are_as_before():
    p, l = checkout(N.project(), tempfile.mkdtemp(), "aaaa1111")
    l.kill()
    assert p.returncode == 0 and p.stdout.split()[0] == "menelik", p


def test_a_machine_id_is_made_once_and_kept():
    cfgdir = tempfile.mkdtemp()
    env = {**N.ENV, "FACTORY_CONFIG_DIR": cfgdir}
    env.pop("FACTORY_MACHINE_ID", None)
    ids = {subprocess.run([sys.executable, MACHINE, "id"], env=env, capture_output=True, text=True).stdout.strip()
           for _ in range(2)}
    assert len(ids) == 1 and len(next(iter(ids))) >= 8, ids
    assert os.path.exists(os.path.join(cfgdir, "machine-id"))


# --- claims carry the machine ------------------------------------------------------------------------------------

def test_a_claim_says_which_machine_made_it():
    d, db, env = T.setup([T.issue(1)])
    assert T.run(d, with_machine(env, "mach-a"), "pick", "--agent", "menelik")[1] == "issue-1 Task 1"
    assert "<!-- factory-claim agent=menelik machine=mach-a -->" in claims_in(db, 1)[0]


def test_same_name_on_two_machines_exactly_one_wins():
    d, db, env = T.setup([T.issue(1), T.issue(2)])
    state = json.load(open(db))
    state["comments"] = {"1": [{"body": "<!-- factory-claim agent=menelik machine=mach-a -->", "at": 0}]}
    json.dump(state, open(db, "w"))
    rc, out = T.run(d, with_machine(env, "mach-b"), "pick", "--agent", "menelik")
    assert out == "issue-2 Task 2", out  # mach-b lost #1 and picked again
    # the shared agent:menelik label is the winner's: the loser must not strip it from #1
    assert labels_of(db, 1) == ["agent:menelik", "factory:in-progress"], labels_of(db, 1)
    # and the first machine still wins it
    state = json.load(open(db))
    state["issues"][0]["labels"] = [{"name": "factory:in-progress"}, {"name": "agent:menelik"}]
    json.dump(state, open(db, "w"))
    assert T.run(d, with_machine(env, "mach-a"), "pick", "--agent", "menelik")[1] == "issue-1 Task 1"


def labels_of(db, n):
    return T.labels(db, n)


def test_an_old_claim_without_a_machine_still_counts_as_before():
    d, db, env = T.setup([T.issue(1), T.issue(2)])
    state = json.load(open(db))
    state["comments"] = {"1": [{"body": "<!-- factory-claim agent=taytu -->", "at": 0}]}
    json.dump(state, open(db, "w"))
    assert T.run(d, with_machine(env, "mach-b"), "pick", "--agent", "menelik")[1] == "issue-2 Task 2"
    d, db, env = T.setup([T.issue(1)])
    state = json.load(open(db))
    state["comments"] = {"1": [{"body": "<!-- factory-claim agent=menelik -->", "at": 0}]}
    json.dump(state, open(db, "w"))
    assert T.run(d, with_machine(env, "mach-b"), "pick", "--agent", "menelik")[1] == "issue-1 Task 1"  # as today


def test_an_agent_never_resumes_an_issue_claimed_from_another_machine():
    d, db, env = T.setup([T.issue(1, labels=("factory:in-progress", "agent:menelik")), T.issue(2)])
    state = json.load(open(db))
    state["comments"] = {"1": [{"body": "<!-- factory-claim agent=menelik machine=mach-a -->", "at": 0}]}
    json.dump(state, open(db, "w"))
    assert T.run(d, with_machine(env, "mach-b"), "pick", "--agent", "menelik")[1] == "issue-2 Task 2"
    assert T.run(d, with_machine(env, "mach-a"), "pick", "--agent", "menelik")[1] == "issue-1 Task 1"
    # an in-progress issue with no machine in its claim is resumed by the name, as today
    d, db, env = T.setup([T.issue(1, labels=("factory:in-progress", "agent:menelik"))])
    assert T.run(d, with_machine(env, "mach-b"), "pick", "--agent", "menelik")[1] == "issue-1 Task 1"


def test_the_report_reads_claims_with_a_machine():
    sys.path.insert(0, HOOKS)
    import factory_report
    m = factory_report.CLAIM.search("<!-- factory-claim agent=menelik machine=mach-a -->")
    assert m and m.group(1) == "menelik"


# --- agent issues ------------------------------------------------------------------------------------------------

def ago(minutes):
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%SZ")


def agent_issue(n, name, ping, machine=None, status="idle", state="open"):
    m = f" machine={machine}" if machine else ""
    body = f"<!-- factory-agent name={name} status={status} ping={ping}{m} -->\n**Started:** x\n**Where:** y"
    return {"number": n, "title": f"Agent: {name} · {status}", "body": body, "state": state,
            "labels": [{"name": "factory:agent"}], "milestone": None, "updated_at": "2020-01-01T00:00:00Z"}


def register(d, env, machine, agent="menelik"):
    return T.agents(d, with_machine(env, machine), "register", "--agent", agent)


def test_register_is_refused_while_another_machine_has_that_name_live():
    d, db, env = T.setup([agent_issue(1, "menelik", ago(2), machine="mach-a")])
    p = subprocess.run([sys.executable, os.path.join(HOOKS, "factory_agents.py"), "register", "--agent", "menelik"],
                       cwd=d, env=with_machine(env, "mach-b"), capture_output=True, text=True)
    assert p.returncode == 3, p
    err = json.loads(p.stderr.strip().splitlines()[-1])
    assert set(err) == {"code", "message", "fix"} and err["code"] == "agent-name-in-use", err
    assert "mach-b" not in json.dumps(json.load(open(db))["issues"]), "register must not touch the issue"
    assert "machine=mach-a" in json.load(open(db))["issues"][0]["body"]


def test_register_goes_ahead_when_the_name_is_ours_down_silent_or_from_an_old_kit():
    for issues in ([agent_issue(1, "menelik", ago(2), machine="mach-b")],           # ours
                   [agent_issue(1, "menelik", ago(2), machine="mach-a", status="down")],
                   [agent_issue(1, "menelik", ago(90), machine="mach-a")],          # silent past downMinutes
                   [agent_issue(1, "menelik", ago(2))],                             # an old ping, no machine
                   []):
        d, db, env = T.setup(issues)
        rc, out = register(d, env, "mach-b")
        assert rc == 0, out
        body = json.load(open(db))["issues"][0]["body"]
        assert "machine=mach-b" in body, body


def test_the_ping_marker_has_the_machine_and_the_hostname_only_with_show_where():
    d, db, env = T.setup([])
    register(d, env, "mach-b")
    body = json.load(open(db))["issues"][0]["body"]
    import socket
    assert "machine=mach-b" in body and socket.gethostname() not in body, body
    cfg = os.path.join(d, ".claude", "factory.json")
    json.dump({"tasks": {"source": "issues", "showWhere": True}, "agents": ["menelik"]}, open(cfg, "w"))
    T.agents(d, with_machine(env, "mach-b"), "ping", "--agent", "menelik", "--force")
    assert socket.gethostname() in json.load(open(db))["issues"][0]["body"]


def test_list_and_sweep_still_read_markers_with_and_without_a_machine():
    d, db, env = T.setup([agent_issue(1, "menelik", ago(2), machine="mach-a"), agent_issue(2, "taytu", ago(3))])
    rc, out = T.agents(d, with_machine(env, "mach-b"), "list")
    assert "menelik" in out and "taytu" in out and "mach-a" in out, out
    assert T.agents(d, env, "sweep")[1] == ""


def test_machine_setup_refuses_a_name_that_is_live_on_another_machine():
    d, db, env = T.setup([agent_issue(1, "menelik", ago(2), machine="mach-a")])
    cfgdir = tempfile.mkdtemp()
    env = with_machine(env, "mach-b", FACTORY_CONFIG_DIR=cfgdir)
    p = subprocess.run([sys.executable, MACHINE, "setup", "menelik,taytu"], cwd=d, env=env, capture_output=True, text=True)
    assert p.returncode == 1, p
    err = json.loads(p.stderr.strip().splitlines()[-1])
    assert err["code"] == "agent-name-in-use" and "menelik" in err["message"] and err["fix"], err
    assert not os.listdir(cfgdir), "nothing is written when a name is refused"
    p = subprocess.run([sys.executable, MACHINE, "setup", "taytu"], cwd=d, env=env, capture_output=True, text=True)
    assert p.returncode == 0, p
    key = os.path.basename(os.path.realpath(d))
    assert json.load(open(os.path.join(cfgdir, f"{key}.json"))) == {"agents": ["taytu"]}
    p = subprocess.run([sys.executable, MACHINE, "setup", "nobody"], cwd=d, env=env, capture_output=True, text=True)
    assert p.returncode == 1 and json.loads(p.stderr.strip().splitlines()[-1])["code"] == "unknown-agent", p


def test_a_loop_whose_name_is_live_elsewhere_stops_and_does_not_mark_that_agent_down():
    import test_loop_countdown as L
    work, env = L.setup()
    stub = ("#!/usr/bin/env python3\nimport os, sys\n"
            "open(os.environ['LOOP_LOG'], 'a').write('factory_agents.py ' + ' '.join(sys.argv[1:]) + '\\n')\n"
            "if sys.argv[1:2] == ['register']:\n"
            "    print('{\"code\": \"agent-name-in-use\", \"message\": \"solo runs elsewhere\", \"fix\": \"x\"}', file=sys.stderr)\n"
            "    sys.exit(3)\n")
    open(os.path.join(work, ".claude", "hooks", "factory_agents.py"), "w").write(stub)
    p = subprocess.run(["bash", "./factory-loop.sh"], cwd=work, env=env, capture_output=True, text=True, timeout=60)
    log = open(env["LOOP_LOG"]).read()
    assert p.returncode == 1 and "agent-name-in-use" in p.stderr, p
    assert "next_task.py" not in log, "no task is claimed"
    assert "factory_agents.py down" not in log, "the other machine's agent must not be marked down"
    assert "factory_claims.py release" in log, "this clone's checkout is let go"


if __name__ == "__main__":
    os.environ.pop("FACTORY_AGENT", None)
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
