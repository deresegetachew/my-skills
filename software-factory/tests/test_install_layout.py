#!/usr/bin/env python3
"""install.sh and `factory update` know the new layout (#112 step 2): a project's links can point straight at the
factory's own folders (hooks/, ci/, factory, factory-loop.sh) instead of the forwarders under kit/. A project that
links through kit/ stays there until it asks for the switch (--layout new), so nothing flips on a plain re-run."""
import os
import shutil
import stat
import subprocess
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SF = os.path.abspath(os.path.join(HERE, ".."))
VENDOR = "vendor/my-skills/software-factory"
GIT_ENV = {**os.environ, "GIT_CONFIG_COUNT": "3", "GIT_CONFIG_KEY_0": "protocol.file.allow", "GIT_CONFIG_VALUE_0": "always",
           "GIT_CONFIG_KEY_1": "user.name", "GIT_CONFIG_VALUE_1": "t", "GIT_CONFIG_KEY_2": "user.email",
           "GIT_CONFIG_VALUE_2": "t@example.com", "PYTHONDONTWRITEBYTECODE": "1"}
ENGINE = [".claude/hooks/factory_guard.py", ".claude/hooks/wait_for_merge.sh", ".claude/ci/ci.sh", ".claude/ci/entrypoint.sh",
          "factory", "factory-loop.sh"]
KIT_ONLY = [".claude/agents/reviewer.md", ".claude/settings.json"]


def sh(*cmd, cwd, env=GIT_ENV, check=True):
    p = subprocess.run(list(cmd), cwd=cwd, capture_output=True, text=True, env=env)
    assert not check or p.returncode == 0, (cmd, p.stdout, p.stderr)
    return p


def copy_factory(dest):
    shutil.copytree(SF, dest, symlinks=True, ignore=shutil.ignore_patterns("__pycache__", "tests"))


def project():
    """A git project with a copy of the factory under vendor/my-skills (not a submodule: install.sh only needs it inside)."""
    d = tempfile.mkdtemp()
    sh("git", "init", "-q", cwd=d)
    copy_factory(os.path.join(d, VENDOR))
    return d


def install(d, *args):
    return sh("bash", os.path.join(d, VENDOR, "install.sh"), ".", *args, cwd=d)


def links(d, rels=ENGINE + KIT_ONLY):
    return {r: os.readlink(os.path.join(d, r)) for r in rels}


def test_a_fresh_link_install_points_the_code_straight_at_the_factorys_folders():
    d = project()
    install(d, "--link")
    got = links(d)
    for rel in ENGINE:
        assert "/kit/" not in got[rel], (rel, got[rel])
        assert os.path.isfile(os.path.join(d, rel)), rel
    assert got["factory"] == VENDOR + "/factory"
    assert got[".claude/hooks/factory_guard.py"] == "../../" + VENDOR + "/hooks/factory_guard.py"
    assert got[".claude/ci/entrypoint.sh"] == "../../" + VENDOR + "/ci/entrypoint.sh"
    for rel in KIT_ONLY:  # agents, skills and settings.json still come from kit/.claude, where they live
        assert got[rel] == os.path.relpath(VENDOR + "/kit/" + rel, os.path.dirname(rel)), got[rel]
    assert "factory <command>" in sh("bash", os.path.join(d, "factory"), "help", cwd=d).stdout


def test_a_file_added_to_hooks_reaches_a_project_without_a_forwarder():
    d = project()
    open(os.path.join(d, VENDOR, "hooks", "factory_zz.py"), "w").write("print('zz')\n")
    out = install(d, "--link").stdout
    assert "linked   .claude/hooks/factory_zz.py" in out
    assert sh("python3", ".claude/hooks/factory_zz.py", cwd=d).stdout == "zz\n"


def test_a_project_linked_through_kit_keeps_its_links_on_a_plain_rerun():
    d = project()
    install(d, "--link", "--layout", "old")  # what every project got before the move
    before = links(d)
    for rel in ENGINE:
        assert "/kit/" in before[rel] and os.path.isfile(os.path.join(d, rel)), (rel, before[rel])
    out = install(d, "--link").stdout  # auto: stays on kit/
    assert links(d) == before
    assert "relinked" not in out and "was a copy" not in out, out
    assert links(d) == before, "a second run changes nothing either"


def test_layout_new_switches_a_kit_linked_project_and_a_rerun_changes_nothing():
    d = project()
    install(d, "--link", "--layout", "old")
    out = install(d, "--link", "--layout", "new").stdout
    for rel in ENGINE:
        assert f"relinked {rel} (from kit/ to the new folder)" in out, (rel, out)
        assert "/kit/" not in os.readlink(os.path.join(d, rel)) and os.path.isfile(os.path.join(d, rel)), rel
    after = links(d)
    out = install(d, "--link").stdout  # auto now finds no kit/ link, so it is new and idempotent
    assert links(d) == after and "relinked" not in out, out
    assert "factory <command>" in sh("bash", os.path.join(d, "factory"), "help", cwd=d).stdout


def test_a_copy_that_differs_is_kept_and_a_plain_copy_becomes_a_link_in_either_layout():
    for layout in ("new", "old"):
        d = project()
        os.makedirs(os.path.join(d, ".claude", "hooks"))
        shutil.copy(os.path.join(SF, "hooks", "check.py"), os.path.join(d, ".claude", "hooks", "check.py"))
        open(os.path.join(d, ".claude", "hooks", "factory_env.py"), "w").write("# my own edit\n")
        out = install(d, "--link", "--layout", layout).stdout
        assert os.path.islink(os.path.join(d, ".claude", "hooks", "check.py"))
        assert "linked   .claude/hooks/check.py (was a copy)" in out
        assert not os.path.islink(os.path.join(d, ".claude", "hooks", "factory_env.py"))
        assert "kept     .claude/hooks/factory_env.py (differs" in out


def test_a_bad_option_is_refused_with_a_message():
    d = project()
    p = sh("bash", os.path.join(d, VENDOR, "install.sh"), ".", "--layout", "sideways", "--link", cwd=d, check=False)
    assert p.returncode == 1 and "--layout takes new, old or auto" in p.stderr
    p = sh("bash", os.path.join(d, VENDOR, "install.sh"), ".", "--lnk", cwd=d, check=False)
    assert p.returncode == 1 and "Unknown option" in p.stderr


def test_a_copy_install_holds_real_files_from_the_new_folders_with_the_same_modes():
    d = tempfile.mkdtemp()
    sh("bash", os.path.join(SF, "install.sh"), d, cwd=d)
    for root, dirs, files in os.walk(d):
        for f in files:
            assert not os.path.islink(os.path.join(root, f)), os.path.join(root, f)
    for rel in ENGINE + KIT_ONLY:
        assert os.path.isfile(os.path.join(d, rel)), rel
    for src, rel in (("hooks/factory_guard.py", ".claude/hooks/factory_guard.py"), ("ci/entrypoint.sh", ".claude/ci/entrypoint.sh"),
                     ("factory", "factory")):
        assert open(os.path.join(SF, src), "rb").read() == open(os.path.join(d, rel), "rb").read(), rel
    for rel in ("factory", "factory-loop.sh", ".claude/ci/ci.sh", ".claude/hooks/factory_guard.py"):
        assert os.stat(os.path.join(d, rel)).st_mode & stat.S_IXUSR, rel


# --- factory update, with the factory as a real submodule of the project ---

def upstream():
    u = tempfile.mkdtemp()
    copy_factory(os.path.join(u, "software-factory"))
    sh("git", "init", "-q", "-b", "main", cwd=u)
    sh("git", "add", "-A", cwd=u)
    sh("git", "commit", "-q", "-m", "release 1", cwd=u)
    return u


def submodule_project(up, *install_args):
    d = tempfile.mkdtemp()
    sh("git", "init", "-q", "-b", "main", cwd=d)
    sh("git", "submodule", "add", "-q", up, "vendor/my-skills", cwd=d)
    install(d, "--link", *install_args)
    sh("git", "add", "-A", cwd=d)
    sh("git", "commit", "-q", "-m", "set up", cwd=d)
    return d


def add_upstream_hook(up):
    open(os.path.join(up, "software-factory", "hooks", "factory_zz.py"), "w").write("print('zz')\n")
    sh("git", "add", "-A", cwd=up)
    sh("git", "commit", "-q", "-m", "add factory_zz", cwd=up)


def test_factory_update_links_a_new_file_straight_to_the_new_folder_in_a_new_layout_project():
    up = upstream()
    d = submodule_project(up)
    add_upstream_hook(up)
    out = sh("bash", "factory", "update", cwd=d).stdout
    assert "add factory_zz" in out, out
    assert os.readlink(os.path.join(d, ".claude/hooks/factory_zz.py")) == "../../vendor/my-skills/software-factory/hooks/factory_zz.py"
    assert sh("python3", ".claude/hooks/factory_zz.py", cwd=d).stdout == "zz\n"
    assert "/kit/" not in os.readlink(os.path.join(d, "factory"))


def test_factory_update_leaves_a_kit_linked_project_on_kit_until_asked():
    up = upstream()
    d = submodule_project(up, "--layout", "old")
    # upstream keeps the forwarder for the new file, as it must until step 5 (test_forwarders)
    add_upstream_hook(up)
    os.symlink("../../../hooks/factory_zz.py", os.path.join(up, "software-factory/kit/.claude/hooks/factory_zz.py"))
    sh("git", "add", "-A", cwd=up)
    sh("git", "commit", "-q", "-m", "forwarder", cwd=up)
    before = links(d)
    out = sh("bash", "factory", "update", cwd=d).stdout
    assert links(d) == before and "relinked" not in out, out
    assert "/kit/" in os.readlink(os.path.join(d, ".claude/hooks/factory_zz.py")), "new files follow the project's layout"
    assert sh("python3", ".claude/hooks/factory_zz.py", cwd=d).stdout == "zz\n"
    out = sh("bash", "factory", "update", "--layout", "new", cwd=d).stdout  # same commit, but the switch was asked for
    assert "relinked .claude/hooks/factory_zz.py" in out and "relinked factory " in out, out
    assert "/kit/" not in os.readlink(os.path.join(d, ".claude/hooks/factory_zz.py"))
    assert sh("python3", ".claude/hooks/factory_zz.py", cwd=d).stdout == "zz\n"
    assert "already at" in sh("bash", "factory", "update", cwd=d).stdout


def test_factory_update_refuses_an_unknown_layout():
    up = upstream()
    d = submodule_project(up)
    p = sh("bash", "factory", "update", "--layout", "sideways", cwd=d, check=False)
    assert p.returncode == 1 and "--layout takes new, old or auto" in p.stderr


REPO = os.path.abspath(os.path.join(SF, ".."))


def empty_dirs(d):
    return sorted(os.path.relpath(r, d) for r, dirs, files in os.walk(d)
                  if ".git" not in r.split(os.sep) and not dirs and not files)


def clean_copy_of_this_repo():
    d = os.path.join(tempfile.mkdtemp(), "repo")
    shutil.copytree(REPO, d, symlinks=True, ignore=shutil.ignore_patterns(".git", "__pycache__", "docs"))
    return d


def test_relinking_this_repo_leaves_no_empty_folder_and_check_skills_passes():
    # #152: the project already has .claude/factory.json, so the docs templates are left out; the folders they
    # would have sat in must not be made either (check_skills.py fails on a top-level folder that is not a skill).
    d = clean_copy_of_this_repo()
    assert not os.path.exists(os.path.join(d, "docs")), "the clean copy starts without docs/"
    for _ in range(2):  # twice: the second run changes nothing
        sh("bash", "software-factory/install.sh", ".", "--link", "--layout", "new", cwd=d)
        assert empty_dirs(d) == [], empty_dirs(d)
        assert not os.path.exists(os.path.join(d, "docs"))
        p = sh("python3", "tools/check_skills.py", cwd=d, check=False)
        assert p.returncode == 0, p.stdout + p.stderr


def test_a_setup_project_gets_no_empty_docs_folder_in_either_mode_and_layout():
    for args in (["--link", "--layout", "new"], ["--link", "--layout", "old"], []):
        d = project()
        install(d, *args)  # first run: the templates are copied, docs/ holds files
        assert os.path.isfile(os.path.join(d, "docs", "build-plan.md")), args
        shutil.rmtree(os.path.join(d, "docs"))  # the project chose not to keep them
        install(d, *args)
        assert not os.path.exists(os.path.join(d, "docs")), args
        assert empty_dirs(d) == [], (args, empty_dirs(d))


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
