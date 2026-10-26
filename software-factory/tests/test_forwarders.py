#!/usr/bin/env python3
"""The factory's code lives in software-factory/ (#112). The old kit paths that projects link are symlinks to it
(forwarders), so a project that links the old paths keeps working until it switches.
Ported to forwarders.test.ts (#252); the install case stays until factory_stack (run by install.sh) is ported."""
import os
import subprocess
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SF = os.path.abspath(os.path.join(HERE, ".."))
KIT = os.path.join(SF, "kit")
MOVED = [(".claude/hooks", "hooks"), (".claude/ci", "ci")]


def test_link_install_in_a_project_resolves_through_the_forwarders():
    with tempfile.TemporaryDirectory() as d:
        os.makedirs(os.path.join(d, "vendor"))
        # install.sh --link needs the kit inside the project, so copy the tree (symlinks kept)
        subprocess.run(["cp", "-a", os.path.dirname(SF), os.path.join(d, "vendor", "my-skills")], check=True)
        subprocess.run(["git", "init", "-q"], cwd=d, check=True)
        p = subprocess.run(["bash", os.path.join(d, "vendor", "my-skills", "software-factory", "install.sh"), ".", "--link"],
                           cwd=d, capture_output=True, text=True)
        assert p.returncode == 0, p.stderr
        for rel in (".claude/hooks/factory_guard.ts", ".claude/ci/ci.sh", "factory", "factory-loop.sh"):
            path = os.path.join(d, rel)
            assert os.path.islink(path) and os.path.isfile(path), rel
        out = subprocess.run(["bash", os.path.join(d, "factory"), "help"], cwd=d, capture_output=True, text=True)
        assert out.returncode == 0 and "factory <command>" in out.stdout, out.stderr
        out = subprocess.run(["bun", "--no-env-file", os.path.join(d, ".claude", "hooks", "factory_guard.ts"), "--help"], cwd=d,
                             capture_output=True, text=True)
        assert out.returncode == 0 and "Cannot find module" not in out.stderr, out.stderr


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
