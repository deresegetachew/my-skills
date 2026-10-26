#!/usr/bin/env python3
"""my-skills builds itself with its own factory (#112): its CLAUDE.md, its .claude/factory.json and the links that make
`./factory` work in this repo.  python3 software-factory/tests/test_self_hosting.py"""
import json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SF = os.path.abspath(os.path.join(HERE, ".."))
REPO = os.path.dirname(SF)


def config():
    return json.load(open(os.path.join(REPO, ".claude", "factory.json")))


def test_the_repo_has_a_claude_md_that_names_the_commands_that_check_it():
    text = open(os.path.join(REPO, "CLAUDE.md")).read()
    for needle in ("tools/run_tests.py", "tools/check_skills.ts", "software-factory/README.md", "factory:ready", "#114"):
        assert needle in text, needle
    assert os.path.isfile(os.path.join(REPO, "tools", "run_tests.py")) and os.path.isfile(os.path.join(REPO, "tools", "check_skills.ts"))


def test_the_factory_settings_of_this_repo_are_valid_and_take_tasks_from_issues():
    env = {**os.environ, "CLAUDE_PROJECT_DIR": REPO}
    p = subprocess.run(["bun", "--no-env-file", os.path.join(SF, "hooks", "factory_settings.ts"), "validate"], cwd=REPO, env=env,
                       capture_output=True, text=True)
    assert p.returncode == 0 and "valid" in p.stdout, p.stdout + p.stderr
    cfg = config()
    assert cfg["tasks"]["source"] == "issues"
    assert cfg["commands"]["test"] == "python3 tools/run_tests.py"


def test_what_governs_the_agents_is_protected_and_the_notes_folder_exists():
    import re
    cfg = config()
    for path in ("CLAUDE.md", ".claude/factory.json", ".github/workflows/check.yml", "software-factory/hooks/pr-gate.py",
                 "software-factory/hooks/factory_guard.ts", "software-factory/kit/.claude/settings.json",
                 "software-factory/kit/.claude/agents/reviewer.md", "tools/build_release.py", "software-factory/VERSION"):
        assert any(re.search(rx, path) for rx in cfg["protected"]), path
    assert not any(re.search(rx, "software-factory/hooks/factory_doctor.py") for rx in cfg["protected"])  # ordinary code can self-merge
    assert os.path.isdir(os.path.join(REPO, cfg["notes"] if "notes" in cfg else ".claude/factory/notes"))


def test_every_link_the_repo_uses_for_its_own_factory_points_at_a_real_file_inside_software_factory():
    links = [os.path.join(REPO, "factory"), os.path.join(REPO, "factory-loop.sh")]
    for root, _dirs, files in os.walk(os.path.join(REPO, ".claude")):
        links += [os.path.join(root, f) for f in files if os.path.islink(os.path.join(root, f))]
    assert len(links) > 20, links
    for link in links:
        assert os.path.islink(link), link
        target = os.path.realpath(link)
        assert os.path.isfile(target), f"{os.path.relpath(link, REPO)} is a dangling link"
        assert target.startswith(SF + os.sep), f"{os.path.relpath(link, REPO)} leaves software-factory/"
        assert "/kit/.claude/hooks/" not in target and "/kit/.claude/ci/" not in target, f"{link} goes through a forwarder"
    assert os.access(os.path.join(REPO, "factory"), os.X_OK)


def test_the_repos_own_factory_command_runs_from_its_root():
    p = subprocess.run(["bash", os.path.join(REPO, "factory"), "help"], cwd=REPO, capture_output=True, text=True)
    assert p.returncode == 0 and "update" in p.stdout, p.stderr


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
