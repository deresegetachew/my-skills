#!/usr/bin/env python3
"""`factory migrate-to-release` takes a project off the my-skills submodule links and onto a numbered release (#170).
The release client runs from the downloaded release (python3 <release>/hooks/factory_release.py), so it works when
./factory is itself one of the links.  python3 software-factory/tests/test_migrate_to_release.py"""
import json, os, subprocess, sys, tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_release_client import PIN, commit, fac, git, world  # noqa: E402
from wiki_text import readme_and_wiki

SUB = "vendor/my-skills"


def link(d, rel, target_in_sub, content):
    """A project file that is a link into the submodule, as install.sh --link made it."""
    src = os.path.join(d, SUB, target_in_sub)
    os.makedirs(os.path.dirname(src), exist_ok=True)
    open(src, "w").write(content)
    dst = os.path.join(d, rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    os.symlink(os.path.relpath(src, os.path.dirname(dst)), dst)


def submodule_project(*versions):
    gh, d, env = world(*(versions or ("1.0.0",)))
    open(os.path.join(d, ".gitmodules"), "w").write(f'[submodule "{SUB}"]\n\tpath = {SUB}\n\turl = https://github.com/deresegetachew/my-skills.git\n')
    link(d, "factory", "software-factory/factory", "#!/usr/bin/env bash\necho old\n")
    link(d, ".claude/hooks/factory_x.py", "software-factory/hooks/factory_x.py", "OLD = 1\n")
    link(d, ".claude/agents/a.md", "software-factory/kit/.claude/agents/a.md", "old agent\n")
    link(d, ".claude/settings.json", "software-factory/kit/.claude/settings.json", "{}\n")
    link(d, ".claude/skills/nestjs-x/SKILL.md", "nestjs-x/SKILL.md", "not in the release\n")
    open(os.path.join(d, ".claude", "factory.json"), "w").write("{}\n")
    commit(d, "linked to the submodule")
    return gh, d, env


def state(d):
    """Every path (not .git) with what it is: a link's target or a file's bytes and mode."""
    out = {}
    for root, dirs, files in os.walk(d):
        dirs[:] = [x for x in dirs if x != ".git"]
        for f in files + [x for x in dirs if os.path.islink(os.path.join(root, x))]:
            p = os.path.join(root, f)
            out[os.path.relpath(p, d)] = ("link", os.readlink(p)) if os.path.islink(p) else (open(p, "rb").read(), os.stat(p).st_mode)
    return out


def test_it_ends_on_the_release_keeps_the_links_it_does_not_ship_and_prints_the_steps():
    gh, d, env = submodule_project()
    rc, out = fac(d, env, "migrate-to-release")
    assert rc == 0, out
    for rel in ("factory", ".claude/hooks/factory_x.py", ".claude/agents/a.md", ".claude/settings.json"):
        assert not os.path.islink(os.path.join(d, rel)) and os.path.isfile(os.path.join(d, rel)), rel
    assert "VERSION = '1.0.0'" in open(os.path.join(d, ".claude/hooks/factory_x.py")).read()
    assert os.path.islink(os.path.join(d, ".claude/skills/nestjs-x/SKILL.md")), "what the release does not ship stays a link"
    assert json.load(open(os.path.join(d, PIN)))["tag"] == "v1.0.0"
    assert open(os.path.join(d, SUB, "software-factory/hooks/factory_x.py")).read() == "OLD = 1\n", "the submodule is never written through"
    assert "nestjs-x" in out and "git submodule deinit" not in out, out  # links remain, so the submodule stays
    assert "git add -A" in out and "pull request" in out, out
    status = git(d, "status", "--porcelain")
    assert all(l[:2].strip() in ("M", "T", "A", "??", "AM") for l in status.splitlines()), status
    assert ".gitmodules" not in status and SUB not in status, status


def test_when_no_link_is_left_it_prints_the_commands_to_drop_the_submodule_and_runs_none():
    gh, d, env = submodule_project()
    os.remove(os.path.join(d, ".claude/skills/nestjs-x/SKILL.md"))
    commit(d, "no nestjs link")
    rc, out = fac(d, env, "migrate-to-release")
    assert rc == 0, out
    assert f"git submodule deinit -f {SUB}" in out and f"git rm -f {SUB}" in out, out
    assert os.path.isdir(os.path.join(d, SUB)) and ".gitmodules" in git(d, "ls-files"), "it only prints them"


def test_a_dirty_tree_is_refused_and_nothing_changes():
    gh, d, env = submodule_project()
    open(os.path.join(d, "notes.txt"), "w").write("mine\n")
    before = state(d)
    rc, out = fac(d, env, "migrate-to-release")
    assert rc == 1 and "[dirty_tree]" in out and "Fix:" in out, out
    assert state(d) == before and gh.hits == [], "nothing changed, nothing downloaded"


def test_a_failure_midway_puts_every_link_back():
    gh, d, env = submodule_project()
    # the release ships ci/ci.sh: a plain file where its folder should be makes the write fail after other files were written
    open(os.path.join(d, ".claude", "ci"), "w").write("in the way\n")
    commit(d, "a file where the ci folder goes")
    before = state(d)
    rc, out = fac(d, env, "migrate-to-release")
    assert rc == 1 and "[install_failed]" in out, out
    assert state(d) == before, "links and files are as they were"
    assert git(d, "status", "--porcelain") == ""


def test_it_is_safe_to_run_twice():
    gh, d, env = submodule_project()
    assert fac(d, env, "migrate-to-release")[0] == 0
    after = state(d)
    rc, out = fac(d, env, "migrate-to-release")
    assert rc == 0 and "already on" in out, out
    assert state(d) == after


def test_a_project_with_no_submodule_links_is_told_what_to_use_instead():
    gh, d, env = world("1.0.0")
    before = state(d)
    rc, out = fac(d, env, "migrate-to-release")
    assert rc == 1 and "[nothing_to_migrate]" in out and "factory update --release" in out, out
    assert state(d) == before


def test_it_refuses_inside_the_factorys_own_repo_and_in_an_agent_session():
    gh, d, env = submodule_project()
    rc, out = fac(d, {**env, "FACTORY_AGENT": "taytu"}, "migrate-to-release")
    assert rc == 1 and "[agent_session]" in out, out


def test_help_and_readme_list_the_command():
    sf = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
    helped = subprocess.run(["bash", os.path.join(sf, "factory"), "help"], capture_output=True, text=True).stdout
    assert "migrate-to-release" in helped, helped
    assert "| `factory migrate-to-release" in readme_and_wiki()


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
