#!/usr/bin/env python3
"""The next-task skill names a REST fallback for `gh pr create` and `gh pr comment` (#159): where GraphQL is blocked
(the dev manager's cloud workspace) those fail, and the builder would otherwise improvise. The skill also stays short.
  python3 software-factory/tests/test_ship_fallback.py"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL = os.path.join(HERE, "..", "kit", ".claude", "skills", "next-task", "SKILL.md")
LINE_LIMIT = 130  # 111 lines before #159; the skill is the core file and the rest is split into files beside it


def text():
    return open(SKILL).read()


def test_ship_step_names_the_rest_call_to_open_a_pr():
    t = text()
    assert "gh pr create` fails" in t
    assert "gh api repos/{owner}/{repo}/pulls -f title=" in t
    assert "-f head=<branch> -f base=<main>" in t and "-F body=@file" in t


def test_ship_step_names_the_rest_call_to_comment():
    assert "gh api repos/{owner}/{repo}/issues/<n>/comments -F body=@file" in text()


def test_the_fallback_sits_in_the_ship_step():
    t = text()
    ship = t[t.index("## 4. Ship it"):t.index("## 5.")]
    assert "gh api repos/{owner}/{repo}/pulls" in ship and "issues/<n>/comments" in ship


def test_the_skill_stays_under_its_line_limit():
    assert len(text().splitlines()) <= LINE_LIMIT


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
