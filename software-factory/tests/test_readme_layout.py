#!/usr/bin/env python3
"""The README's "Where things live" section matches the folders (#112), so it cannot drift from the move.
python3 software-factory/tests/test_readme_layout.py"""
import os, re, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
SF = os.path.abspath(os.path.join(HERE, ".."))
README = open(os.path.join(SF, "README.md")).read()


def section():
    m = re.search(r"^## Where things live\n(.*?)^## ", README, re.S | re.M)
    assert m, "the README has no 'Where things live' section"
    return m.group(1)


def test_the_section_names_every_top_level_part_of_software_factory_that_exists():
    text = section()
    for name in ("factory", "factory-loop.sh", "install.sh", "VERSION", "hooks", "ci", "tests", "docs", "kit"):
        assert os.path.exists(os.path.join(SF, name)), name
        assert re.search(r"^  " + re.escape(name) + r"\b", text, re.M), f"{name} is missing from the tree"
    top = {n for n in os.listdir(SF) if not n.startswith(".") and n != "__pycache__" and os.path.isdir(os.path.join(SF, n))}
    for folder in top:
        assert re.search(r"^  " + re.escape(folder) + r"/", text, re.M), f"the folder {folder}/ is not described"


def test_the_section_says_how_a_project_switches_and_what_is_left():
    text = section()
    assert "factory update --layout new" in text
    assert "ls -l .claude/hooks" in text and "factory doctor" in text
    for left in ("first release", "Remanual", "forwarders"):
        assert left in text, left


def test_the_switch_command_the_section_gives_is_one_the_factory_command_and_installer_accept():
    help_text = subprocess.run(["bash", os.path.join(SF, "factory"), "help"], capture_output=True, text=True).stdout
    assert "update [--layout new]" in help_text, help_text
    assert "--layout new|old|auto" in open(os.path.join(SF, "install.sh")).read()


def test_the_files_in_the_kit_tree_lists_the_hooks_and_ci_folders_beside_kit_not_inside_it():
    m = re.search(r"software-factory/\n  README\.md .*?\n```", README, re.S)
    assert m
    tree = m.group(0)
    assert re.search(r"^  hooks/$", tree, re.M) and re.search(r"^  ci/ ", tree, re.M), tree[:400]
    assert not re.search(r"^    \.claude/hooks/$", tree, re.M) and not re.search(r"^    \.claude/ci/ ", tree, re.M)
    for hook in sorted(os.listdir(os.path.join(SF, "hooks"))):
        if hook.startswith("factory_release") or hook == "pr-gate.py":
            assert hook in tree, hook


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
