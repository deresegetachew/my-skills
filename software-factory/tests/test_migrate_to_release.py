#!/usr/bin/env python3
"""factory migrate-to-release (#170): take a project off the my-skills submodule links and onto a release.
python3 software-factory/tests/test_migrate_to_release.py

Uses the fake GitHub and the archive builder of test_release_client.py. The fixture is a project whose factory files
are relative symlinks into vendor/my-skills, as `install.sh --link` leaves them."""
import os, shutil, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import test_release_client as T

VENDOR = "vendor/my-skills/software-factory"
SHIPPED = {  # what the fake release owns: project path -> where the submodule keeps it
    "factory": "factory", "factory-loop.sh": "factory-loop.sh",
    ".claude/hooks/factory_x.py": "hooks/factory_x.py", ".claude/hooks/factory_old.py": "hooks/factory_old.py",
    ".claude/ci/ci.sh": "ci/ci.sh", ".claude/agents/a.md": "kit/.claude/agents/a.md",
    ".claude/settings.json": "kit/.claude/settings.json"}
KEPT = ".claude/skills/nestjs-best-practices"  # not in the release: stays a link into the submodule


def link(d, rel, to):
    p = os.path.join(d, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    os.symlink(os.path.relpath(os.path.join(d, to), os.path.dirname(p)), p)


def submodule_project(dir_link=False):
    """A committed project whose factory files are links into vendor/my-skills (a plain folder stands in for the submodule)."""
    d = tempfile.mkdtemp()
    T.git(d, "init", "-q", "-b", "main")
    for src in set(SHIPPED.values()) | {"hooks/custom.py"}:
        p = os.path.join(d, VENDOR, src)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        shutil.copy(os.path.join(T.SF, "factory"), p) if src.startswith("factory") else open(p, "w").write("# from the submodule: %s\n" % src)
    os.makedirs(os.path.join(d, "vendor", "my-skills", "nestjs-best-practices"))
    open(os.path.join(d, "vendor", "my-skills", "nestjs-best-practices", "SKILL.md"), "w").write("nest\n")
    open(os.path.join(d, ".gitmodules"), "w").write('[submodule "vendor/my-skills"]\n\tpath = vendor/my-skills\n\turl = x\n')
    for rel, src in SHIPPED.items():
        if dir_link and rel.startswith(".claude/hooks/"):
            continue
        link(d, rel, VENDOR + "/" + src)
    if dir_link:
        link(d, ".claude/hooks", VENDOR + "/hooks")
    else:
        link(d, ".claude/hooks/custom.py", VENDOR + "/hooks/custom.py")
    link(d, KEPT, "vendor/my-skills/nestjs-best-practices")
    open(os.path.join(d, ".claude", "factory.json"), "w").write("{}\n")
    T.commit(d, "project on the submodule")
    return d


def state(d):
    """Every path outside .git: links by what they point to, files by bytes and mode, to prove nothing changed."""
    out = {}
    for root, dirs, files in os.walk(d):
        dirs[:] = [x for x in dirs if x != ".git"]
        for n in dirs + files:
            p = os.path.join(root, n)
            rel = os.path.relpath(p, d)
            if os.path.islink(p):
                out[rel] = ("link", os.readlink(p))
            elif os.path.isfile(p):
                out[rel] = ("file", open(p, "rb").read(), os.stat(p).st_mode)
            else:
                out[rel] = ("dir",)
    return out


def test_a_submodule_project_ends_on_the_release_with_real_files_and_the_unshipped_links_kept():
    gh, _d, env = T.world("1.0.0", "1.1.0")
    d = submodule_project()
    before_vendor = {k: v for k, v in state(d).items() if k.startswith("vendor")}
    rc, out = T.fac(d, env, "migrate-to-release")
    assert rc == 0, out
    assert T.pin(d)["tag"] == "v1.1.0", out
    for rel in SHIPPED:
        p = os.path.join(d, rel)
        assert os.path.isfile(p) and not os.path.islink(p), rel
    assert "1.1.0" in open(os.path.join(d, ".claude/hooks/factory_x.py")).read()
    assert os.access(os.path.join(d, "factory"), os.X_OK)
    assert os.path.islink(os.path.join(d, KEPT)) and os.path.islink(os.path.join(d, ".claude/hooks/custom.py"))
    assert os.path.isfile(os.path.join(d, KEPT, "SKILL.md"))
    assert {k: v for k, v in state(d).items() if k.startswith("vendor")} == before_vendor  # the submodule is not touched
    assert open(os.path.join(d, ".gitmodules")).read().count("vendor/my-skills") == 1
    changed = {l[3:] for l in T.git(d, "status", "--porcelain", "--untracked-files=all").splitlines()}
    assert changed <= set(SHIPPED) | {T.PIN}, changed  # only the intended change
    assert KEPT not in changed and ".claude/hooks/custom.py" not in changed
    for word in ("Migrated", "kept", KEPT, "git add -A", "pull request"):
        assert word in out, (word, out)
    T.commit(d, "migrate")
    assert T.git(d, "status", "--porcelain", "--untracked-files=all") == ""
    assert T.fac(d, env, "version")[0] == 0 and "match the pin" in T.fac(d, env, "version")[1]


def test_a_named_release_can_be_migrated_to():
    gh, _d, env = T.world("1.0.0", "1.1.0")
    d = submodule_project()
    rc, out = T.fac(d, env, "migrate-to-release", "1.0.0")
    assert rc == 0 and T.pin(d)["tag"] == "v1.0.0", out


def test_a_whole_folder_linked_into_the_submodule_becomes_real_and_keeps_the_links_the_release_does_not_ship():
    gh, _d, env = T.world("1.0.0")
    d = submodule_project(dir_link=True)
    assert os.path.islink(os.path.join(d, ".claude/hooks"))
    rc, out = T.fac(d, env, "migrate-to-release")
    assert rc == 0, out
    assert os.path.isdir(os.path.join(d, ".claude/hooks")) and not os.path.islink(os.path.join(d, ".claude/hooks"))
    assert not os.path.islink(os.path.join(d, ".claude/hooks/factory_x.py"))
    assert "1.0.0" in open(os.path.join(d, ".claude/hooks/factory_x.py")).read()
    assert os.path.islink(os.path.join(d, ".claude/hooks/custom.py")) and os.path.isfile(os.path.join(d, ".claude/hooks/custom.py"))
    assert not os.path.exists(os.path.join(d, VENDOR, "hooks", "factory_x.py.factory-tmp"))
    assert "# from the submodule" in open(os.path.join(d, VENDOR, "hooks", "factory_x.py")).read()  # not written through the link
    T.commit(d, "migrate")
    assert T.git(d, "status", "--porcelain") == ""


def test_it_works_when_the_projects_factory_command_is_itself_a_link():
    gh, _d, env = T.world("1.0.0")
    d = submodule_project()
    assert os.path.islink(os.path.join(d, "factory"))
    rc, out = T.fac(d, env, "migrate-to-release")  # run from the release client, as from a downloaded release
    assert rc == 0 and not os.path.islink(os.path.join(d, "factory")), out
    assert "echo factory" in open(os.path.join(d, "factory")).read()
    assert "echo factory" not in open(os.path.join(d, VENDOR, "factory")).read()  # the submodule's copy was not overwritten


def test_a_dirty_tree_is_refused_and_nothing_changes():
    gh, _d, env = T.world("1.0.0")
    d = submodule_project()
    open(os.path.join(d, "notes.txt"), "w").write("wip\n")
    before = state(d)
    rc, out = T.fac(d, env, "migrate-to-release")
    assert rc == 1 and "[dirty_tree]" in out and "notes.txt" in out and "Fix:" in out, out
    assert state(d) == before and gh.hits == []


def test_a_bad_checksum_changes_nothing():
    gh, _d, env = T.world("1.0.0")
    gh.corrupt.add("software-factory-1.0.0.tar.gz")
    d = submodule_project()
    before = state(d)
    rc, out = T.fac(d, env, "migrate-to-release")
    assert rc == 1 and "[bad_checksum]" in out, out
    assert state(d) == before and T.cached(env) == []


def test_a_failure_after_the_links_are_gone_puts_every_link_back():
    gh, _d, env = T.world("1.0.0")
    d = submodule_project()
    before = state(d)
    open(env["FAKE_CI_BROKEN"], "w").write("x")  # the verification at the end fails
    rc, out = T.fac(d, env, "migrate-to-release")
    assert rc == 1 and "[verification_failed]" in out and "Fix:" in out, out
    assert state(d) == before, "the project is not as it was"
    assert T.git(d, "status", "--porcelain", "--untracked-files=all") == ""


def test_a_failure_while_writing_puts_every_link_back():
    gh, _d, env = T.world("1.0.0")
    d = submodule_project()
    os.remove(os.path.join(d, ".claude/agents/a.md"))  # a real folder where the release wants a file
    os.makedirs(os.path.join(d, ".claude/agents/a.md"))
    open(os.path.join(d, ".claude/agents/a.md/keep"), "w").write("x\n")
    T.commit(d, "odd")
    before = state(d)
    rc, out = T.fac(d, env, "migrate-to-release")
    assert rc == 1 and "Fix:" in out, out
    assert state(d) == before
    assert T.git(d, "status", "--porcelain", "--untracked-files=all") == ""


def test_a_project_with_no_links_into_the_submodule_is_pointed_to_update():
    gh, d, env = T.world("1.0.0")
    rc, out = T.fac(d, env, "migrate-to-release")
    assert rc == 1 and "[nothing_to_migrate]" in out and "factory update --release" in out, out
    assert gh.hits == []


def test_a_project_already_on_a_release_is_told_so():
    gh, d, env = T.world("1.0.0")
    assert T.fac(d, env, "update")[0] == 0
    T.commit(d)
    rc, out = T.fac(d, env, "migrate-to-release")
    assert rc == 1 and "[already_on_release]" in out and "Fix:" in out, out


def test_agents_and_the_factorys_own_repo_are_refused():
    gh, _d, env = T.world("1.0.0")
    d = submodule_project()
    before = state(d)
    rc, out = T.fac(d, {**env, "FACTORY_AGENT": "haile"}, "migrate-to-release")
    assert rc == 1 and "[agent_session]" in out and state(d) == before, out
    own = T.factory_repo_copy()
    rc, out = T.fac(own, env, "migrate-to-release")
    assert rc == 1 and "[factory_repo]" in out, out


def test_the_factory_command_runs_it_and_help_lists_it():
    gh, _d, env = T.world("1.0.0")
    d = submodule_project()
    rc, out = T.run_factory(d, env, "help")
    assert "migrate-to-release" in out, out
    rc, out = T.run_factory(d, env, "migrate-to-release")
    assert rc == 0 and T.pin(d)["tag"] == "v1.0.0", out


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
