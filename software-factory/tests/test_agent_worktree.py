#!/usr/bin/env python3
"""A new agent worktree gets its submodules, so the kit's links in .claude/ resolve before Claude starts (#46).
python3 software-factory/tests/test_agent_worktree.py"""
import json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
HOOKS = os.path.abspath(os.path.join(HERE, "..", "kit", ".claude", "hooks"))
FACTORY = os.path.abspath(os.path.join(HERE, "..", "kit", "factory"))
ENV = {**os.environ, "GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "protocol.file.allow",
       "GIT_CONFIG_VALUE_0": "always", "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
       "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}
for var in ("FACTORY_AGENT", "FACTORY_LOOP", "CLAUDE_PROJECT_DIR"):
    ENV.pop(var, None)


def git(*a, cwd=None):
    subprocess.run(["git", *a], cwd=cwd, check=True, env=ENV, capture_output=True, text=True)


def project():
    """A bare origin whose .claude/settings.json is a link into a submodule, and a fresh clone of it."""
    top = tempfile.mkdtemp()
    kit, origin, work = (os.path.join(top, n) for n in ("kit.git", "origin.git", "seed"))
    seed_kit = os.path.join(top, "kit-seed")
    os.makedirs(os.path.join(seed_kit, "kit"))
    json.dump({"hooks": {}}, open(os.path.join(seed_kit, "kit", "settings.json"), "w"))
    git("init", "-q", "-b", "main", seed_kit)
    git("add", "-A", cwd=seed_kit)
    git("commit", "-qm", "kit", cwd=seed_kit)
    git("clone", "-q", "--bare", seed_kit, kit)
    git("init", "-q", "-b", "main", work)
    git("submodule", "add", "-q", kit, "vendor/my-skills", cwd=work)
    os.makedirs(os.path.join(work, ".claude"))
    os.symlink("../vendor/my-skills/kit/settings.json", os.path.join(work, ".claude", "settings.json"))
    json.dump({"agents": ["menelik", "taytu"]}, open(os.path.join(work, ".claude", "factory.json"), "w"))
    git("add", "-A", cwd=work)
    git("commit", "-qm", "project", cwd=work)
    git("clone", "-q", "--bare", work, origin)
    clone = os.path.join(top, "proj")
    git("clone", "-q", "--recurse-submodules", origin, clone)
    return clone


def test_a_new_worktree_gets_the_submodule_so_the_settings_link_resolves():
    clone = project()
    p = subprocess.run([sys.executable, os.path.join(HOOKS, "factory_claims.py"), "worktree", "taytu"], cwd=clone,
                       env=ENV, capture_output=True, text=True)
    assert p.returncode == 0, p
    path = p.stdout.strip().splitlines()[-1]
    assert path == clone + "-agents/taytu" or path.endswith("/proj-agents/taytu"), path
    assert os.path.isfile(os.path.join(path, "vendor", "my-skills", "kit", "settings.json")), os.listdir(path)
    assert os.path.exists(os.path.join(path, ".claude", "settings.json")), "the settings link doesn't resolve"


def test_factory_agent_refuses_to_start_claude_without_the_settings():
    clone = project()
    wt = clone + "-agents/taytu"
    git("worktree", "add", "-q", "--detach", wt, "origin/main", cwd=clone)  # made by hand, no submodule
    # Break the submodule in that worktree so it can't be fetched, and leave the link dangling.
    os.rename(os.path.join(wt, ".gitmodules"), os.path.join(wt, ".gitmodules.off"))
    fake = tempfile.mkdtemp()
    open(os.path.join(fake, "claude"), "w").write("#!/bin/sh\necho CLAUDE STARTED\n")
    os.chmod(os.path.join(fake, "claude"), 0o755)
    os.makedirs(os.path.join(clone, ".claude", "hooks"), exist_ok=True)
    for f in os.listdir(HOOKS):
        dst = os.path.join(clone, ".claude", "hooks", f)
        if not os.path.exists(dst):
            os.symlink(os.path.join(HOOKS, f), dst)
    env = {**ENV, "PATH": fake + os.pathsep + ENV["PATH"], "FACTORY_REMOTE_CONTROL": "0"}
    p = subprocess.run(["bash", FACTORY, "agent", "taytu"], cwd=clone, env=env, capture_output=True, text=True)
    assert p.returncode != 0 and "CLAUDE STARTED" not in p.stdout, p
    assert "settings.json doesn't resolve" in p.stderr, p


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
