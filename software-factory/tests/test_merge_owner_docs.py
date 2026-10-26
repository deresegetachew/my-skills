#!/usr/bin/env python3
"""Who merges a green task PR is said in one plain place, and an agent that does not merge points at the dev manager (#201).
  python3 software-factory/tests/test_merge_owner_docs.py"""
import os

SF = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))


def section(text, heading):
    start = text.index(heading)
    nxt = text.find("\n## ", start + 1)
    return text[start:nxt if nxt != -1 else len(text)]


def test_the_readme_states_who_merges_a_green_task_pr():
    s = section(open(os.path.join(SF, "README.md")).read(), "## Reviews and gates")
    assert "Who merges a green task pull request" in s, "no plain statement under Reviews and gates"
    for need in ("builder merges its own task pull request", "protected", "the owner", "factory dev-manager loop", "task pull requests with green CI"):
        assert need in s, need


def test_the_skill_ends_an_unmerged_task_with_a_pointer_to_the_dev_manager_loop():
    text = open(os.path.join(SF, "kit", ".claude", "skills", "next-task", "SKILL.md")).read()
    assert "not merged" in text and "factory dev-manager loop" in text, "the final message must point at the dev manager"


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
