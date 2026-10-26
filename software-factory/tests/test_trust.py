#!/usr/bin/env python3
"""A folder Claude Code does not trust makes it ignore the whole allow list (#180, #193): `factory doctor` says `fix`
for the project folder and each agent worktree before tokens are spent, and a headless loop run stops with a
{code, message, fix} instead of starting claude. A fake ~/.claude.json stands in for the user's; it is only read.
  python3 software-factory/tests/test_trust.py"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import test_doctor as doc  # noqa: E402
import test_mcp_isolation as iso  # noqa: E402

TRUST = os.path.join(doc.HOOKS, "factory_trust.py")


def claude_json(home, trusted=(), untrusted=()):
    projects = {os.path.realpath(p): {"hasTrustDialogAccepted": True} for p in trusted}
    projects.update({os.path.realpath(p): {"hasTrustDialogAccepted": False, "allowedTools": ["secret-token-xyz"]} for p in untrusted})
    path = os.path.join(home, ".claude.json")
    json.dump({"projects": projects, "oauthAccount": {"emailAddress": "secret@example.com"}}, open(path, "w"))
    return path


def doctor(trusted=(), untrusted=(), worktree=False, write=True):
    d = doc.project(cfg={"agents": ["taytu"]})
    d = os.path.realpath(d)
    env = {**doc.machine(), "FACTORY_AGENTS": "taytu"}
    wt = d + "-agents/taytu"
    if worktree:
        os.makedirs(wt)
    if write:
        claude_json(env["HOME"], [d if t == "project" else wt if t == "worktree" else t for t in trusted], untrusted)
    return doc.doctor(d, env), d, wt, env


def trust_lines(p):
    return [l for l in p.stdout.splitlines() if "trust" in l.lower() and l.split()[0] in ("ok", "fix", "note")]


def test_doctor_says_ok_for_a_trusted_project_folder():
    p, d, wt, env = doctor(trusted=["project"])
    assert [l for l in trust_lines(p) if l.startswith("ok")], p.stdout
    assert not [l for l in trust_lines(p) if l.startswith("fix")], p.stdout


def test_doctor_says_fix_with_the_exact_step_for_an_untrusted_project_folder_and_never_prints_the_config():
    p, d, wt, env = doctor(trusted=[])
    fixes = [l for l in trust_lines(p) if l.startswith("fix")]
    assert fixes and f"cd {d} && claude" in fixes[0], p.stdout
    assert p.returncode == 1
    assert "secret" not in p.stdout + p.stderr
    before = open(os.path.join(env["HOME"], ".claude.json")).read()
    doc.doctor(d, env)
    assert open(os.path.join(env["HOME"], ".claude.json")).read() == before, "doctor never writes the config"


def test_doctor_checks_each_agent_worktree_that_exists():
    p, d, wt, env = doctor(trusted=["project"], worktree=True)
    fixes = [l for l in trust_lines(p) if l.startswith("fix")]
    assert len(fixes) == 1 and f"cd {wt} && claude" in fixes[0], p.stdout
    p, d, wt, env = doctor(trusted=["project", "worktree"], worktree=True)
    assert not [l for l in trust_lines(p) if l.startswith("fix")], p.stdout


def test_a_folder_inside_a_trusted_folder_is_trusted():
    p, d, wt, env = doctor(trusted=[os.path.dirname(os.path.realpath(doc.project()))], worktree=False)
    assert not [l for l in trust_lines(p) if l.startswith("fix")], p.stdout


def test_no_claude_json_is_only_a_note():
    p, d, wt, env = doctor(write=False)
    assert not [l for l in trust_lines(p) if l.startswith("fix")] and p.returncode == 0, p.stdout
    assert [l for l in trust_lines(p) if l.startswith("note")], p.stdout


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
