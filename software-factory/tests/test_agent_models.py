#!/usr/bin/env python3
"""Every subagent in the kit names its model (#54), and the reviews that escalate say how: the first pass runs on
Sonnet, and the next-task skill asks for a second pass on Opus when it finds something.
  python3 software-factory/tests/test_agent_models.py"""
import os, re

KIT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "kit", ".claude"))
AGENTS = os.path.join(KIT, "agents")
ESCALATING = ("reviewer", "safety-auditor", "security-reviewer")


def frontmatter(name):
    text = open(os.path.join(AGENTS, f"{name}.md")).read()
    m = re.match(r"---\n(.*?)\n---\n", text, re.S)
    assert m, f"{name}.md has no frontmatter"
    return dict(l.split(":", 1) for l in m.group(1).splitlines() if ":" in l), text


def test_every_subagent_names_its_model():
    for f in sorted(os.listdir(AGENTS)):
        if f.endswith(".md"):
            meta, _ = frontmatter(f[:-3])
            assert meta.get("model", "").strip() in ("sonnet", "opus", "haiku", "inherit"), (f, meta)


def test_the_escalating_reviews_start_on_sonnet_and_can_say_they_are_unsure():
    for name in ESCALATING:
        meta, text = frontmatter(name)
        assert meta["model"].strip() == "sonnet", name
        assert "**unsure**" in text, name


def test_next_task_escalates_those_reviews_to_opus():
    skill = open(os.path.join(KIT, "skills", "next-task", "SKILL.md")).read()
    assert 'model: "opus"' in skill
    for name in ESCALATING:
        assert f"`{name}`" in skill, name


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
