#!/usr/bin/env python3
"""A headless sub-manager can post its verdict and read what a review needs (#202). The exact commands the sandbox
sub-managers tried are run against the real manager profile (Claude Code's allow/deny matching, replayed) and the real
manager_gate.py; the skill gives the verdict command; a review that ends with no verdict does not restart for ever; and
`factory doctor` replays the skill's commands against the profile.
The rest is in manager_verdict.test.ts (#252); these cases need factory_doctor.
  python3 software-factory/tests/test_manager_verdict.py"""
import fnmatch, json, os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import test_doctor as doc  # noqa: E402
import test_manager_gate as mg  # noqa: E402

PROFILE = json.load(open(mg.PROFILE))["permissions"]
SKILL = open(mg.SKILL).read()

import importlib.util  # noqa: E402
_spec = importlib.util.spec_from_file_location("pr_gate", os.path.join(mg.SF, "hooks", "pr-gate.py"))
PG = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(PG)


def rule_matches(rule, kind, subject):
    m = re.fullmatch(kind + r"\((.*)\)", rule)
    return bool(m) and fnmatch.fnmatchcase(subject, m.group(1))


def allowed_by_profile(command):
    """Whether Claude Code would run `command` without asking: no `$(...)` or backticks, and every simple command in it
    matches an allow rule and no deny rule."""
    import shlex
    if "$(" in command or "`" in command:
        return False  # "can't be checked before it runs"
    for tokens in PG.simple_commands(command):
        text = " ".join(shlex.quote(t) if re.search(r"\s", t) else t for t in tokens)
        raw = " ".join(tokens)
        if any(rule_matches(r, "Bash", x) for r in PROFILE["deny"] for x in (text, raw)):
            return False
        if not any(rule_matches(r, "Bash", x) for r in PROFILE["allow"] for x in (text, raw)):
            return False
    return True


def edit_allowed(path):
    return any(rule_matches(r, "Edit", path) for r in PROFILE["allow"]) and not any(rule_matches(r, "Edit", path) for r in PROFILE["deny"])


def gate_passes(command):
    d, env = mg.world()
    code, msg = mg.gate(d, env, command)
    return code == 0, msg


# --- doctor replays the skill's commands against the profile -----------------------------------------------------------

def manager_project(profile_allow=None, skill=SKILL):
    d = doc.project(cfg={"agents": ["taytu"]})
    prof = json.loads(json.dumps(json.load(open(mg.PROFILE))))
    if profile_allow is not None:
        prof["permissions"]["allow"] = profile_allow
    os.makedirs(os.path.join(d, ".claude", "manager"))
    json.dump(prof, open(os.path.join(d, ".claude", "manager", "settings.json"), "w"))
    os.makedirs(os.path.join(d, ".claude", "skills", "manage-pass"))
    open(os.path.join(d, ".claude", "skills", "manage-pass", "SKILL.md"), "w").write(skill)
    for h in ("manager_gate.py", "pr-gate.py"):
        os.symlink(os.path.join(doc.HOOKS, h), os.path.join(d, ".claude", "hooks", h)) if not os.path.exists(os.path.join(d, ".claude", "hooks", h)) else None
    return d


def test_doctor_is_quiet_when_every_command_the_skill_names_is_allowed_by_the_profile():
    d = manager_project()
    p = doc.doctor(d, {**doc.machine(), "FACTORY_AGENTS": "taytu"})
    assert [l for l in doc.lines(p, "ok") if "manager profile" in l and "skill" in l], p.stdout
    assert not [l for l in doc.lines(p, "fix") if "manager" in l], p.stdout


def test_doctor_fixes_a_profile_that_would_prompt_for_a_command_the_skill_names():
    allow = [r for r in PROFILE["allow"] if "gh run view" not in r]
    d = manager_project(profile_allow=allow)
    p = doc.doctor(d, {**doc.machine(), "FACTORY_AGENTS": "taytu"})
    fixes = [l for l in doc.lines(p, "fix") if "gh run view" in l]
    assert fixes and "factory update" in fixes[0] and p.returncode == 1, p.stdout
