#!/usr/bin/env python3
"""`factory doctor` checks the machine and the project, one line each, and says how to fix what's missing (#63).
Runs with a PATH of stub tools, so it doesn't depend on what this machine has installed.
  python3 software-factory/tests/test_doctor.py"""
import json, os, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
KIT = os.path.abspath(os.path.join(HERE, "..", "kit"))
SF = os.path.dirname(os.path.abspath(KIT))
HOOKS = os.path.join(SF, "hooks")


def stub(bin_, name, body):
    p = os.path.join(bin_, name)
    open(p, "w").write("#!/bin/sh\n" + body + "\n")
    os.chmod(p, 0o755)


def machine(gh_signed_in=True, node="v22.11.0", extra=(), gh=None):
    """A bin folder with git, python3 and the basics linked in, plus stub gh, claude and node."""
    bin_ = tempfile.mkdtemp()
    for tool in ("git", "python3", "bash", "sh", "env", "uname", "dirname", "basename", "cat"):
        if shutil.which(tool):
            os.symlink(shutil.which(tool), os.path.join(bin_, tool))
    # signed out: every gh call fails, as it does with no token (`gh api` too, since #157)
    stub(bin_, "gh", gh or ("exit 0" if gh_signed_in else "echo 'gh: run gh auth login or set GH_TOKEN' >&2; exit 1"))
    stub(bin_, "claude", "echo '2.1.310 (Claude Code)'")
    if node:
        stub(bin_, "node", f"echo {node}")
    for name in extra:
        stub(bin_, name, "echo 9.0.0")
    env = {"PATH": bin_, "HOME": tempfile.mkdtemp()}
    return env


def project(files=None, cfg=None):
    d = tempfile.mkdtemp()
    subprocess.run(["git", "init", "-q", "-b", "main", d], check=True)
    os.makedirs(os.path.join(d, ".claude", "hooks"))
    for f in os.listdir(HOOKS):
        if f.endswith(".py"):
            os.symlink(os.path.join(HOOKS, f), os.path.join(d, ".claude", "hooks", f))
    json.dump(cfg or {"agents": ["menelik", "taytu"]}, open(os.path.join(d, ".claude", "factory.json"), "w"))
    json.dump({"hooks": {}}, open(os.path.join(d, ".claude", "settings.json"), "w"))
    for name, text in (files or {}).items():
        open(os.path.join(d, name), "w").write(text)
    return d


def doctor(d, env):
    return subprocess.run(["bash", os.path.join(SF, "factory"), "doctor"], cwd=d, env=env, capture_output=True,
                          text=True, timeout=60)


def lines(p, kind):
    return [l for l in p.stdout.splitlines() if l.startswith(kind)]


def test_a_good_machine_is_all_ok():
    d = project({"package.json": '{"packageManager": "pnpm@9.0.0"}', ".nvmrc": "22\n"})
    p = doctor(d, {**machine(extra=("pnpm", "factory")), "FACTORY_AGENTS": "taytu"})
    assert p.returncode == 0, p
    assert not lines(p, "fix"), p.stdout
    for what in ("git", "Claude Code", "gh is signed in", "Node v22", "pnpm", ".claude/settings.json", "taytu"):
        assert any(what in l for l in lines(p, "ok")), (what, p.stdout)
    assert "All the checks pass." in p.stdout


def test_gh_auth_status_failing_is_no_fix_when_the_api_works():
    # GH_TOKEN set: `gh auth status` complains, every `gh api` call works (#157)
    d = project()
    gh = "[ \"$1 $2\" = 'auth status' ] && { echo 'token scopes missing' >&2; exit 1; }; echo '{}'; exit 0"
    p = doctor(d, {**machine(gh=gh), "FACTORY_AGENTS": "taytu"})
    assert p.returncode == 0, p.stdout
    assert not lines(p, "fix"), p.stdout
    assert any("gh" in l for l in lines(p, "ok")), p.stdout
    assert "All the checks pass." in p.stdout


def test_a_failing_gh_api_names_the_reason():
    for err, reason in (("gh: To use GitHub CLI, set GH_TOKEN or run gh auth login", "no token"),
                        ("gh: Bad credentials (HTTP 401)", "token was refused"),
                        ("dial tcp: lookup api.github.com: no such host", "can't reach github.com")):
        d = project()
        gh = "echo '%s' >&2; exit 1" % err
        p = doctor(d, {**machine(gh=gh), "FACTORY_AGENTS": "taytu"})
        assert p.returncode == 1, p.stdout
        fixes = lines(p, "fix")
        assert any("GitHub CLI" in l and reason in l for l in fixes), (reason, p.stdout)


def test_each_problem_gets_a_one_line_fix():
    d = project({"package.json": '{"packageManager": "pnpm@9.0.0"}', ".nvmrc": "22\n", ".sops.yaml": "creation_rules: []\n"})
    os.remove(os.path.join(d, ".claude", "settings.json"))
    p = doctor(d, {**machine(gh_signed_in=False, node="v18.19.0"), "FACTORY_AGENTS": "ada"})
    assert p.returncode == 1, p
    fixes = "\n".join(lines(p, "fix"))
    for what, how in (("GitHub CLI", "gh auth login"), ("Node", "nvm install"), ("pnpm", "corepack enable"),
                      ("sops", "install sops"), (".claude/settings.json", "git submodule update --init"),
                      ("FACTORY_AGENTS", "ada")):
        assert any(what in l and how in l for l in lines(p, "fix")), (what, fixes)
    assert f"{len(lines(p, 'fix'))} to fix." in p.stdout


def pinned(d, content="print(1)\n", changed=False):
    """Give the project a release pin for one installed file (a project on releases, #113)."""
    import hashlib
    rel = ".claude/hooks/factory_demo.py"
    open(os.path.join(d, rel), "w").write(content + ("# edited\n" if changed else ""))
    pin = {"schema": "factory-pin/1", "repo": "acme/factory", "tag": "v1.2.0", "version": "1.2.0", "sha256": "0" * 64, "previous": None,
           "executable": [], "files": {rel: hashlib.sha256(content.encode()).hexdigest()}}
    os.makedirs(os.path.join(d, ".claude", "factory"), exist_ok=True)
    json.dump(pin, open(os.path.join(d, ".claude", "factory", "release.json"), "w"))


def test_a_project_on_releases_is_ok_when_its_files_match_the_pin():
    d = project()
    pinned(d)
    p = doctor(d, {**machine(), "FACTORY_AGENTS": "taytu"})
    assert any("factory v1.2.0" in l and "match the pin" in l for l in lines(p, "ok")), p.stdout
    assert not lines(p, "fix"), p.stdout


def test_a_project_on_releases_gets_a_fix_when_a_file_differs_from_the_pin():
    d = project()
    pinned(d, changed=True)
    p = doctor(d, {**machine(), "FACTORY_AGENTS": "taytu"})
    assert p.returncode == 1, p.stdout
    assert any("factory_demo.py differs from v1.2.0" in l and "factory update" in l for l in lines(p, "fix")), p.stdout


def test_checks_that_dont_apply_are_left_out():
    d = project()  # no package.json, no compose file, no .sops.yaml
    p = doctor(d, machine(node=None))
    assert p.returncode == 0, p
    assert not any(w in p.stdout for w in ("Node", "Docker", "sops")), p.stdout


def test_it_never_prints_a_secret():
    d = project({".sops.yaml": "creation_rules: []\n"})
    key = os.path.join(tempfile.mkdtemp(), "age.txt")
    open(key, "w").write("AGE-SECRET-KEY-1SHOULDNEVERSHOW\n")
    p = doctor(d, {**machine(extra=("sops",)), "SOPS_AGE_KEY_FILE": key})
    assert any("sops and its age key" in l for l in lines(p, "ok")), p.stdout
    assert "AGE-SECRET-KEY" not in p.stdout + p.stderr


def default_branch_gh(name):
    """A gh stub that answers `gh repo view` with GitHub's default branch and succeeds on everything else."""
    return f'case "$1" in repo) echo {name};; esac; exit 0'


def test_a_main_branch_that_differs_from_githubs_default_is_a_fix():
    d = project(cfg={"agents": ["taytu"], "mainBranch": "alpha-test"})
    p = doctor(d, {**machine(gh=default_branch_gh("main")), "FACTORY_AGENTS": "taytu"})
    assert p.returncode == 1, p.stdout
    fixes = lines(p, "fix")
    assert any("main-branch-differs" in l and "alpha-test" in l and "main" in l
               and "default branch" in l and "factory settings set mainBranch main" in l for l in fixes), p.stdout


def test_a_main_branch_that_matches_githubs_default_is_ok():
    d = project(cfg={"agents": ["taytu"], "mainBranch": "alpha-test"})
    p = doctor(d, {**machine(gh=default_branch_gh("alpha-test")), "FACTORY_AGENTS": "taytu"})
    assert p.returncode == 0, p.stdout
    assert any("mainBranch" in l and "alpha-test" in l for l in lines(p, "ok")), p.stdout


def test_an_unset_main_branch_is_judged_as_main():
    d = project(cfg={"agents": ["taytu"]})
    p = doctor(d, {**machine(gh=default_branch_gh("trunk")), "FACTORY_AGENTS": "taytu"})
    assert any("main-branch-differs" in l for l in lines(p, "fix")), p.stdout


def test_a_default_branch_gh_cannot_tell_is_no_fix():
    d = project(cfg={"agents": ["taytu"], "mainBranch": "alpha-test"})
    p = doctor(d, {**machine(), "FACTORY_AGENTS": "taytu"})  # gh prints nothing
    assert not any("main-branch" in l for l in lines(p, "fix")), p.stdout


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
