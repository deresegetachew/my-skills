#!/usr/bin/env python3
"""Every subagent in the kit names its model (#54). Only the `reviewer` starts on Sonnet (the owner's decision,
24 Oct); the safety and security reviews stay on Opus. The next-task skill re-reviews on Opus only a commit that fixes
the Sonnet pass's must-fixes, or an item marked unsure, so an Opus pass can't wave a must-fix through unfixed.
  python3 software-factory/tests/test_agent_models.py"""
import os, re

KIT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "kit", ".claude"))
AGENTS = os.path.join(KIT, "agents")


def frontmatter(name):
    text = open(os.path.join(AGENTS, f"{name}.md")).read()
    m = re.match(r"---\n(.*?)\n---\n", text, re.S)
    assert m, f"{name}.md has no frontmatter"
    return {k.strip(): v.strip() for k, v in (l.split(":", 1) for l in m.group(1).splitlines() if ":" in l)}, text


def test_every_subagent_names_its_model():
    for f in sorted(os.listdir(AGENTS)):
        if f.endswith(".md"):
            meta, _ = frontmatter(f[:-3])
            assert meta.get("model") in ("sonnet", "opus", "haiku", "inherit"), (f, meta)


def test_only_the_reviewer_starts_on_sonnet_and_the_safety_and_security_reviews_stay_on_opus():
    assert frontmatter("reviewer")[0]["model"] == "sonnet"
    for name in ("safety-auditor", "security-reviewer"):
        assert frontmatter(name)[0]["model"] == "opus", name


def test_the_reviewer_can_say_unsure_and_checks_earlier_must_fixes_before_its_pass():
    _, text = frontmatter("reviewer")
    assert "**unsure**" in text
    assert "earlier must-fix" in text and "before you record the pass" in text, text


def test_next_task_reviews_the_fixed_commit_on_opus_never_the_unfixed_one():
    skill = open(os.path.join(KIT, "skills", "next-task", "SKILL.md")).read()
    step = " ".join(skill[skill.index("**The reviewer starts on Sonnet"):].split("\n## ")[0].split())
    assert 'model: "opus"' in step and "fix it" in step and "fixed commit" in step, step
    assert "only for items it marked **unsure**" in step, step
    assert "`safety-auditor` and `security-reviewer` run on Opus" in step, step


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
