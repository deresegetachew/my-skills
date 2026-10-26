#!/usr/bin/env python3
"""The manager handover (#100): `factory handover snapshot` reads the state a manager hands over from GitHub, and the
runbook and the rewritten playbook say what the owner runs.

Runs the real factory in a throwaway project (see test_roles.py) with the stateful fake `gh` of fakegh.py.
python3 software-factory/tests/test_handover.py"""
import json, os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_product_owner import issue, po_project, posted  # noqa: E402
from test_roles import SF, factory  # noqa: E402

PR = {"number": 21, "title": "Add the login form", "draft": False, "head": {"sha": "a" * 40, "ref": "task/12-login"},
      "user": {"login": "agent-bot"}, "labels": []}
DB = {"pulls": [PR],
      "issues": [dict(issue(12, "Login form", labels=["factory:in-progress"])),
                 dict(issue(13, "Billing", labels=["factory:blocked"])),
                 dict(issue(14, "Profile page", labels=["factory:ready"])),
                 dict(issue(15, "Search", labels=["factory:ready"])),
                 dict(issue(40, "Dev manager: needs the owner"))],
      "comments": {"40": ["<!-- factory-owner-ask id=renumber for=product -->\nthis needs your yes: renumber the stories?",
                          "<!-- factory-owner-ask id=ci-queued -->\nCI is queued",
                          "<!-- factory-owner-answer id=ci-queued -->\nok"]}}
FILES = {"docs/decisions/0001-start.md": "x", "docs/decisions/0007-colours.md": "x", "docs/decisions/README.md": "x"}


def snapshot(work, env, *args):
    return factory(work, env, "handover", "snapshot", *args)


def test_the_snapshot_lists_what_a_manager_hands_over_from_github():
    d, work, env = po_project(db=DB, files=FILES)
    p = snapshot(work, env)
    assert p.returncode == 0, (p.stdout, p.stderr)
    out = p.stdout
    assert out.startswith("## Manager handover snapshot (") and "**Open pull requests (1)**" in out, out
    assert "- #21 Add the login form (by agent-bot, head aaaaaaa)" in out, out
    assert "**Tasks in progress (1)**\n- #12 Login form" in out and "**Tasks blocked (1)**\n- #13 Billing" in out, out
    assert "**Tasks ready (2)**" in out and "- #14 Profile page" in out and "- #15 Search" in out, out
    assert "**Open owner-queue asks (1)**, issue #40" in out and "- `renumber`: this needs your yes: renumber the stories?" in out, out
    assert "ci-queued" not in out, "an answered ask is not open"
    assert "**Needs a manager right now (1)**" in out and "PR #21: commit aaaaaaa not reviewed yet" in out, out
    assert "- docs/decisions: 7" in out, out
    assert not posted(d), "the snapshot wrote to GitHub"


def test_the_snapshot_is_read_only_and_has_a_json_form():
    d, work, env = po_project(db=DB, files=FILES)
    data = json.loads(snapshot(work, env, "--json").stdout)
    assert [p["number"] for p in data["pullRequests"]] == [21] and data["ownerQueue"] == 40, data
    assert data["ownerAsks"] == [{"id": "renumber", "line": "this needs your yes: renumber the stories?"}], data
    assert data["numbers"] == {"docs/decisions": 7}, data
    assert not posted(d), "the snapshot wrote to GitHub"


def test_a_quiet_project_says_so_and_has_no_queue_issue_yet():
    d, work, env = po_project(db={}, files=FILES)
    out = snapshot(work, env).stdout
    assert "**Open pull requests (0)**\n- none" in out and "no queue issue yet" in out and "- nothing" in out, out
    assert not posted(d), "no queue issue is made by a read"


def test_the_runbook_has_the_steps_with_exact_commands():
    text = open(os.path.join(SF, "docs", "manager-handover.md")).read()
    for step in ("## 1. Capture the state in GitHub", "## 2. Dry run (owner)", "## 3. Shadow (owner)",
                 "## 4. Cutover (owner)", "## 5. Rollback", "## 6. Done when"):
        assert step in text, step
    for cmd in ("factory handover snapshot", "factory dev-manager loop --once --dry-run", "factory dev-manager lead loop -i",
                "factory autostart install", "factory usage --by role", "trig_01LeAQFva2b4Vvg8yqN6qyb2", "factory artifacts status"):
        assert cmd in text, cmd
    commands = set(re.findall(r"^\s*(factory [a-z-]+)", text, re.M))
    known = {"factory version", "factory doctor", "factory init-roles", "factory handover", "factory dev-manager",
             "factory autostart", "factory usage", "factory prs", "factory follow", "factory artifacts", "factory watch"}
    assert commands <= known, commands - known
    for c in commands:  # every command the runbook runs is one `factory help` lists
        assert c.split()[1] in factory_help(), c


def factory_help():
    import subprocess
    return subprocess.run(["bash", os.path.join(SF, "factory"), "help"], capture_output=True, text=True).stdout


def test_the_playbook_is_rewritten_around_the_orchestrator_and_keeps_the_owners_rule():
    dm = open(os.path.join(SF, "DEV-MANAGER.md")).read()
    assert "orchestrator" in dm and "one-item sub-manager" in dm and "factory dev-manager loop -i" in dm, "the new role"
    assert "Remote Control" in dm and "There is no web console" in dm
    assert "small, short sessions" in dm and "factory usage --by role" in dm and "come from reusing a prompt cache" in dm
    assert "docs/manager-handover.md" in dm and "If you run a manager in a cloud session" in dm
    for gone in ("[Dev manager tick]", "hourly scheduled task as a backup"):
        assert gone not in dm, gone
    for line in (l for l in dm.splitlines() if "send_later" in l):  # only as history or a warning, never an instruction
        assert "woke itself" in line or "do not also run" in line, line
    assert "The rule (owner, 21 Oct 2026)" in dm and "kit/.claude/skills/manage-pass/SKILL.md" in dm
    assert "factory_lessons.ts suggest" in dm


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
