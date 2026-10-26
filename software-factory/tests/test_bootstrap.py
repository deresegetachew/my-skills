#!/usr/bin/env python3
"""`factory bootstrap project` ending with `factory doctor --sandbox`, and the doctor's --sandbox wiring (#105). These two
stay in Python until factory_doctor is ported (#252); everything else is in bootstrap.test.ts and netguard.test.ts.
Reference only: factory_bootstrap is now factory_bootstrap.ts, so port these to Bun with tests/bootstrap_support.ts
(Machine, projectRepo, addUserTools: the same fake machine) when the doctor lands.

apt-get, adduser, usermod, gpasswd, chmod, loginctl, systemctl, nft, ss, resolvectl, dpkg-query, id, docker, curl, sudo,
ip and journalctl are fakes on PATH that keep their state in files; system paths live under FACTORY_BOOTSTRAP_ROOT
(a temp folder). What apt, systemd and nftables really do on a machine can't be tested here.
The guard and sops tests are in netguard.test.ts (#252)."""
import contextlib, io, json, os, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SF = os.path.abspath(os.path.join(HERE, ".."))
HOOKS = os.path.join(SF, "hooks")
sys.path.insert(0, HOOKS)

import factory_bootstrap as B  # noqa: E402
import factory_bootstrap_machine as M  # noqa: E402
import factory_netguard as G  # noqa: E402
from wiki_text import readme_and_wiki

USER = "sbxuser"
MUTATING = ("apt-get", "adduser", "usermod", "gpasswd", "chmod", "loginctl", "systemctl", "nft", "sshd")

FAKES = {
    "dpkg-query": r'''pkg="${!#}"; if [ -f "$FAKE_STATE/pkg-$pkg" ]; then printf 'install ok installed'; else printf 'unknown ok not-installed'; exit 1; fi''',
    "apt-get": r'''echo "$*" >>"$FAKE_LOG/apt-get.log"; [ "$1" = install ] || exit 0
for a in "$@"; do case "$a" in -*|install) ;; *) touch "$FAKE_STATE/pkg-$a" ;; esac; done''',
    "adduser": r'''echo "$*" >>"$FAKE_LOG/adduser.log"; touch "$FAKE_STATE/user-${!#}"''',
    "id": r'''case "$1" in
  -u) [ -f "$FAKE_STATE/user-$2" ] && echo 4242 || exit 1 ;;
  -nG) n="${2:-$USER}"; echo "$n $(cat "$FAKE_STATE/groups-$n" 2>/dev/null)" ;;
  -un) echo "${USER:-sbxuser}" ;;
esac''',
    "usermod": r'''echo "$*" >>"$FAKE_LOG/usermod.log"; u="${!#}"
mkdir -p "$FAKE_ROOT/etc"; echo "$u:100000:65536" >>"$FAKE_ROOT/etc/subuid"; echo "$u:100000:65536" >>"$FAKE_ROOT/etc/subgid"''',
    "gpasswd": r'''echo "$*" >>"$FAKE_LOG/gpasswd.log"; rm -f "$FAKE_STATE/groups-$2"''',
    "chmod": r'''echo "$*" >>"$FAKE_LOG/chmod.log"''',
    "loginctl": r'''case "$1" in
  enable-linger) echo "$*" >>"$FAKE_LOG/loginctl.log"; touch "$FAKE_STATE/linger" ;;
  show-user) [ -f "$FAKE_STATE/linger" ] && echo yes || echo no ;;
esac''',
    "systemctl": r'''if [ "$1" = --user ]; then shift
  case "$1" in
    list-units|list-unit-files) cat "$FAKE_STATE/userunits" 2>/dev/null ;;
    *) echo "user $*" >>"$FAKE_LOG/systemctl-user.log" ;;
  esac; exit 0; fi
case "$1" in
  daemon-reload|reload|mask|unmask) echo "$*" >>"$FAKE_LOG/systemctl.log" ;;
  enable) echo "$*" >>"$FAKE_LOG/systemctl.log"; touch "$FAKE_STATE/enabled-$2" ;;
  restart|start) echo "$*" >>"$FAKE_LOG/systemctl.log"; touch "$FAKE_STATE/active-$2" ;;
  disable) echo "$*" >>"$FAKE_LOG/systemctl.log"; rm -f "$FAKE_STATE/enabled-${3:-$2}" "$FAKE_STATE/active-${3:-$2}" ;;
  is-active) [ -f "$FAKE_STATE/active-${3:-$2}" ] ;;
  is-enabled) [ -f "$FAKE_STATE/enabled-${3:-$2}" ] ;;
esac''',
    "nft": r'''echo "$*" >>"$FAKE_LOG/nft.log"''',
    "sops": "exit 0",
    "sshd": r'''echo "$*" >>"$FAKE_LOG/sshd.log"''',
    "ss": r'''cat "$FAKE_STATE/ss.txt" 2>/dev/null''',
    "resolvectl": r'''echo "Link 2 (eth0): 192.168.2.1"''',
    "ip": r'''echo "default via 192.168.2.1 dev eth0"''',
    "journalctl": r'''[ -f "$FAKE_STATE/nolog" ] && exit 1; echo "kernel: FACTORY-BLOCK IN= OUT=eth0 DST=192.168.2.1"''',
    "sudo": r'''[ -f "$FAKE_STATE/has-sudo" ]''',
    "ls": r'''[ -f "$FAKE_STATE/admin-readable" ]''',
    # curl: succeeds for the internet, fails for what the guard blocks (unless FAKE_OPEN lists it)
    "curl": r'''url="${!#}"
case "$url" in
  https://github.com|https://registry.npmjs.org|https://api.anthropic.com) printf 200 ;;
  *) if grep -qF "$url" "$FAKE_STATE/open" 2>/dev/null; then printf 200; else printf 000; exit 28; fi ;;
esac''',
    "docker": r'''case "$1" in
  info) cat "$FAKE_STATE/dockerinfo" 2>/dev/null || { echo "x" >&2; exit 1; } ;;
  run) [ -f "$FAKE_STATE/container-open" ] && exit 0 || exit 1 ;;
esac''',
}


def new_machine(**state):
    """A bin folder of fakes, a state folder and a root folder; returns (env, root, state_dir, log_dir)."""
    base = tempfile.mkdtemp()
    bin_, st, log, root = (os.path.join(base, n) for n in ("bin", "state", "log", "root"))
    for d in (bin_, st, log, os.path.join(root, "etc")):
        os.makedirs(d)
    for tool in ("python3", "bash", "sh", "env", "cat", "grep", "mkdir", "touch", "rm", "echo", "dirname", "git", "uname", "head", "tail"):
        if shutil.which(tool):
            os.symlink(shutil.which(tool), os.path.join(bin_, tool))
    for name, body in FAKES.items():
        with open(os.path.join(bin_, name), "w") as f:
            f.write("#!/bin/bash\n" + body + "\n")
        os.chmod(os.path.join(bin_, name), 0o755)
    open(os.path.join(root, "etc", "os-release"), "w").write('ID=ubuntu\nID_LIKE=debian\nPRETTY_NAME="Ubuntu 24.04"\n')
    open(os.path.join(root, "etc", "resolv.conf"), "w").write("nameserver 127.0.0.53\n")
    env = {"PATH": bin_ + ":" + os.path.dirname(sys.executable), "FAKE_STATE": st, "FAKE_LOG": log, "FAKE_ROOT": root,
           "HOME": os.path.join(base, "home"), "USER": USER}
    os.makedirs(env["HOME"])
    for k, v in state.items():
        open(os.path.join(st, k), "w").write(v)
    return env, root, st, log

class Machine:
    """Applies the fake machine's environment to this process for the length of a test."""

    def __init__(self, **state):
        self.env, self.root, self.state, self.log = new_machine(**state)

    def __enter__(self):
        self.saved = (dict(os.environ), M.ROOT, B.is_root)
        os.environ.clear()
        os.environ.update(self.env)
        M.ROOT = self.root
        B.is_root = lambda: self.root_user
        self.root_user = True
        return self

    def __exit__(self, *a):
        os.environ.clear()
        os.environ.update(self.saved[0])
        M.ROOT, B.is_root = self.saved[1], self.saved[2]

    def run(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = B.main(list(argv))
        return rc, out.getvalue(), err.getvalue()

    def logged(self, tool):
        try:
            return open(os.path.join(self.log, tool + ".log")).read().splitlines()
        except OSError:
            return []

    def mutations(self):
        return {t: self.logged(t) for t in MUTATING if self.logged(t)}

    def file(self, path):
        return open(M.P(path)).read()


def machine_args(*extra):
    return ["machine", "--user", USER, *extra]


def project_repo(m, factory_json=None, files=None):
    repo = os.path.join(m.state, "proj")
    os.makedirs(os.path.join(repo, ".claude"))
    subprocess.run(["git", "init", "-q", "-b", "main", repo], check=True, env={**os.environ})
    json.dump(factory_json or {}, open(os.path.join(repo, ".claude", "factory.json"), "w"))
    for name, text in (files or {}).items():
        os.makedirs(os.path.dirname(os.path.join(repo, name)), exist_ok=True)
        open(os.path.join(repo, name), "w").write(text)
    with open(os.path.join(repo, "factory"), "w") as f:
        f.write('#!/bin/bash\necho "factory $*" >>"$FAKE_LOG/factory.log"\n'
                '[ "$1" = install-shim ] && { mkdir -p "$HOME/.local/bin"; touch "$HOME/.local/bin/factory"; }\n'
                '[ "$1 $2" = "ci install" ] && echo "proj-ci.service enabled" >>"$FAKE_STATE/userunits"\n'
                '[ "$1 $2" = "machine setup" ] && echo "$3" >"$FAKE_STATE/names"\n[ "$1 $2" = "machine show" ] && cat "$FAKE_STATE/names"\n'
                '[ "$1 $2" = "autostart status" ] && grep -q "autostart install" "$FAKE_LOG/factory.log" && echo "autostart: on"\nexit 0\n')
    os.chmod(os.path.join(repo, "factory"), 0o755)
    return repo


def add_user_tools(m, node="v24.1.0"):
    bin_ = m.env["PATH"].split(":")[0]
    for name, body in {"node": f"echo {node}", "claude": "echo 2.1.0", "gh": '[ -f "$FAKE_STATE/gh-login" ]',
                       "dockerd-rootless-setuptool.sh": 'echo "$*" >>"$FAKE_LOG/setuptool.log"; echo rootless >"$FAKE_STATE/dockerinfo-rootless"'}.items():
        with open(os.path.join(bin_, name), "w") as f:
            f.write("#!/bin/bash\n" + body + "\n")
        os.chmod(os.path.join(bin_, name), 0o755)
    open(os.path.join(m.state, "dockerinfo"), "w").write('["name=seccomp,profile=builtin","name=rootless"]')


def in_dir(path):
    class C:
        def __enter__(s):
            s.old = os.getcwd()
            os.chdir(path)

        def __exit__(s, *a):
            os.chdir(s.old)
    return C()


def test_after_the_sign_ins_the_runners_and_autostart_are_installed_and_doctor_runs():
    with Machine() as m:
        m.root_user = False
        add_user_tools(m)
        open(os.path.join(m.state, "gh-login"), "w").write("")
        os.makedirs(os.path.join(os.environ["HOME"], ".claude"))
        open(os.path.join(os.environ["HOME"], ".claude", ".credentials.json"), "w").write("{}")
        repo = project_repo(m, {})
        with in_dir(repo):
            rc, out, err = m.run("project", "--user", USER, "--agents", "haile", "--runners", "2")
        calls = " ".join(m.logged("factory"))
        assert "ci install" in calls and "autostart install --agents haile" in calls, out + err
        assert "Sandbox (#105)" in out or "Sandbox" in out
        assert "claude" in out and "ok    GitHub, Claude and the age key are in place" in out


def test_doctor_sandbox_is_wired_into_the_doctor_and_the_factory_command():
    text = open(os.path.join(HOOKS, "factory_doctor.py")).read()
    assert "--sandbox" in text and "factory_sandbox" in text
    help_ = subprocess.run(["bash", os.path.join(SF, "factory"), "help"], capture_output=True, text=True,
                           cwd=tempfile.mkdtemp(), env={**os.environ, "GIT_CEILING_DIRECTORIES": "/"})
    # outside a repo the help is not shown, but bootstrap still is
    out = subprocess.run(["bash", os.path.join(SF, "factory"), "bootstrap", "help"], capture_output=True, text=True,
                         cwd=tempfile.mkdtemp(), env={**os.environ, "GIT_CEILING_DIRECTORIES": "/"})
    assert out.returncode == 0 and "factory bootstrap machine" in out.stdout, out.stderr


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
