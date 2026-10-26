#!/usr/bin/env python3
"""The heartbeat daemon (#108): the check left in Python until factory_doctor is ported (#252);
everything else is in heartbeat.test.ts.  python3 software-factory/tests/test_heartbeat.py"""
import json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SF = os.path.abspath(os.path.join(HERE, ".."))
FACTORY = os.path.join(SF, "factory")
sys.path.insert(0, HERE)
import test_doctor as D  # noqa: E402


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


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
