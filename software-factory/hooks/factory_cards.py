#!/usr/bin/env python3
"""Agent cards (#107): who an agent is and what it can do, as data. This is the card a local agent would publish to an
A2A peer (A2A's Agent Card); in this step nothing serves it, and `factory agents` renders from the same structure.
The `/.well-known/agent-card.json` endpoint belongs to the later A2A adapter (docs/messages.md).

  name       the agent's name (lowercase letters, digits, dashes; dev-manager, po and owner are the well-known ones)
  kind       coding-agent | dev-manager | po
  skills     what it does or answers, as short ids
  state      working | idle | input-required | down, or silent (no ping for tasks.downMinutes), or unknown
  location   machine (a terminal session) or cloud (a cloud session)
  machine    the machine id when known (factory_machine.py), else null
  follow     how to watch it: remote-control:<name> for an agent on a machine (the name its Remote Control session
             has), null for a cloud session
  version    the factory version it runs
  lastPing   the time of its last ping (ISO 8601), or null
"""
import os, sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

KINDS = {"dev-manager": "dev-manager", "po": "po"}
SKILLS = {
    "coding-agent": ["build-tasks"],
    "dev-manager": ["review-pull-requests", "answer-technical-questions", "answer-process-questions"],
    "po": ["answer-product-questions", "keep-acceptance-criteria"],
}


def kind_of(name):
    return KINDS.get(name, "coding-agent")


def factory_version():
    """The factory's own version (software-factory/VERSION), 'unknown' when it can't be read."""
    here = os.path.dirname(os.path.realpath(__file__))
    try:
        with open(os.path.join(here, "..", "VERSION")) as f:
            return f.read().strip() or "unknown"
    except OSError:
        return "unknown"


def card(name, state="unknown", machine_id=None, version=None, last_ping=None):
    kind = kind_of(name)
    machine = kind == "coding-agent" or bool(machine_id)
    return {"name": name, "kind": kind, "skills": list(SKILLS[kind]), "state": state,
            "location": "machine" if machine else "cloud", "machine": machine_id or None,
            "follow": f"remote-control:{name}" if machine else None, "version": version or factory_version(),
            "lastPing": last_ping}


def cards(cfg, issues, version=None):
    """The cards of the agents registered on GitHub (their current agent issue each), by name."""
    import factory_agents as fa
    out = []
    for issue in fa.current(issues):
        st = fa.state_of(cfg, issue)
        if st:
            name, status, ping, _ = st
            out.append(card(name, status, fa.machine_of(issue), version, fa.iso(ping)))
    return sorted(out, key=lambda c: (c["name"], c["state"]))


def row(c):
    """One line of `factory agents list`."""
    ping = c["lastPing"]
    quiet = (datetime.now(timezone.utc) - datetime.fromisoformat(ping.replace("Z", "+00:00"))).total_seconds() / 60 if ping else 0
    when = f"{quiet:.0f} min ago" if quiet < 120 else f"{quiet / 60:.1f} h ago"
    return (f"{c['name']:<12} {c['state']:<8} last ping {ping} ({when})"
            + (f"  machine {c['machine']}" if c["machine"] else ""))
