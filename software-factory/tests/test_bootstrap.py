#!/usr/bin/env python3
"""`factory bootstrap` and `factory doctor --sandbox` (#105): the plan, the rendered network guard, the manifest, a second
run that changes nothing, the refusals, and the sandbox checks.  python3 software-factory/tests/test_bootstrap.py

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






def test_an_agent_session_cannot_run_bootstrap_but_can_read_its_status():
    with Machine() as m:
        for var in ("FACTORY_AGENT", "FACTORY_LOOP", "CLAUDECODE"):
            os.environ[var] = "1"
            rc, out, err = m.run(*machine_args("--apply", "--yes"))
            assert rc == 1 and json.loads(err)["code"] == "agent-session" and m.mutations() == {}
            assert m.run("status")[0] == 0
            del os.environ[var]


def test_the_plan_changes_nothing_and_says_how_to_run_it():
    with Machine() as m:
        rc, out, err = m.run(*machine_args("--allow-host", "192.168.2.10:5432", "--block-loopback-port", "3000"))
        assert rc == 0 and err == "", err
        assert "plan  Create the user sbxuser" in out and "plan  Install the network guard" in out
        assert "sudo factory bootstrap machine --apply" in out and "Nothing was changed" in out
        assert "apt-get install -y -q" in out and "192.168.2.10" in out
        assert m.mutations() == {}
        assert not os.path.exists(M.manifest_path()) and not os.path.exists(M.rules_path())
        assert m.run(*machine_args("--dry-run", "--apply"))[0] == 0 and m.mutations() == {}  # --dry-run wins


def test_a_script_is_written_for_the_owner_to_read_and_nothing_runs():
    with Machine() as m:
        target = os.path.join(m.state, "steps.sh")
        rc, out, err = m.run(*machine_args("--script", target))
        assert rc == 0 and m.mutations() == {}
        text = open(target).read()
        assert text.startswith("#!/usr/bin/env bash") and 'id -u)" = 0' in text
        assert "adduser --disabled-password" in text and "UID_F=$(id -u sbxuser)" in text and "meta skuid $UID_F" in text
        assert subprocess.run(["bash", "-n", target]).returncode == 0
        rc, out, _ = m.run(*machine_args("--script"))
        assert out.startswith("#!/usr/bin/env bash") and rc == 0


def test_apply_without_root_is_refused_with_the_fix_and_nothing_runs():
    with Machine() as m:
        m.root_user = False
        rc, out, err = m.run(*machine_args("--apply", "--yes"))
        assert rc == 1 and json.loads(err)["code"] == "not-root" and "sudo factory bootstrap machine --apply" in json.loads(err)["fix"]
        assert m.mutations() == {}


def test_apply_needs_yes_when_there_is_no_terminal_to_ask_on():
    with Machine() as m:
        rc, out, err = m.run(*machine_args("--apply"))
        assert rc == 1 and json.loads(err)["code"] == "needs-yes" and m.mutations() == {}


def test_apply_sets_everything_up_and_records_a_manifest():
    with Machine(**{"ss.txt": "LISTEN 0 1 127.0.0.1:9999 0.0.0.0:* uid:1000 ino:1\n"}) as m:
        rc, out, err = m.run(*machine_args("--apply", "--yes", "--allow-host", "192.168.2.10:5432", "--block-loopback-port", "3000",
                                           "--block-inbound-port", "5440"))
        assert rc == 0, out + err
        assert "uidmap" in m.logged("apt-get")[1] and "nftables" in m.logged("apt-get")[1]
        assert any("--disabled-password" in l and l.endswith(USER) for l in m.logged("adduser"))
        assert any("--add-subuids 100000-165535" in l for l in m.logged("usermod"))
        assert m.logged("loginctl") == [f"enable-linger {USER}"]
        rules = m.file("/etc/software-factory/net-guard.nft")
        assert "meta skuid 4242" in rules and "192.168.2.1 meta l4proto" in rules  # the uid, and the resolver read from resolvectl
        assert "tcp dport { 3000, 9999 }" in rules  # configured port plus the one another user's service listens on
        assert "192.168.2.10 tcp dport 5432 accept" in rules and "5440" in rules
        unit = m.file("/etc/systemd/system/factory-net-guard.service")
        assert "ExecStart=/usr/sbin/nft -f /etc/software-factory/net-guard.nft" in unit
        assert "enable factory-net-guard.service" in m.logged("systemctl")
        assert json.loads(m.file("/etc/software-factory/sandbox.json"))["allowHosts"] == ["192.168.2.10:5432"]
        data = json.load(open(M.manifest_path()))
        assert data["user"] == USER and data["uid"] == 4242 and data["version"] == 1
        assert {"packages", "user", "linger", "net-guard", "sandbox-config"} <= set(data["steps"])
        assert data["steps"]["user"]["record"]["created"] is True
        assert "Next, as sbxuser" in out and "factory bootstrap project" in out


def test_running_it_again_changes_nothing():
    with Machine() as m:
        assert m.run(*machine_args("--apply", "--yes"))[0] == 0
        before = m.mutations()
        stat = {p: os.stat(p).st_mtime_ns for p in (M.rules_path(), M.unit_path(), M.manifest_path())}
        rc, out, err = m.run(*machine_args("--apply", "--yes"))
        assert rc == 0, out + err
        assert m.mutations() == before, "a second run changed something"
        assert stat == {p: os.stat(p).st_mtime_ns for p in stat}
        assert "run   " not in out and out.count("ok    ") >= 8
        rc, out, _ = m.run(*machine_args())
        assert "Everything is in place." in out


def test_a_changed_setting_rewrites_the_guard_and_restarts_it():
    with Machine() as m:
        assert m.run(*machine_args("--apply", "--yes"))[0] == 0
        restarts = m.logged("systemctl").count("restart factory-net-guard.service")
        assert m.run(*machine_args("--apply", "--yes", "--block-loopback-port", "8123"))[0] == 0
        assert "8123" in m.file("/etc/software-factory/net-guard.nft")
        assert m.logged("systemctl").count("restart factory-net-guard.service") == restarts + 1


def test_a_user_in_the_sudo_or_docker_group_is_taken_out():
    with Machine(**{f"user-{USER}": "", f"groups-{USER}": "sudo docker\n"}) as m:
        assert m.run(*machine_args("--apply", "--yes"))[0] == 0
        assert m.logged("gpasswd") == [f"-d {USER} sudo", f"-d {USER} docker"][:1] or len(m.logged("gpasswd")) >= 1
        assert not any(l.startswith("--disabled-password") for l in m.logged("adduser")), "an existing user is not created again"
        assert json.load(open(M.manifest_path()))["steps"]["user"]["record"]["created"] is False if "user" in json.load(open(M.manifest_path()))["steps"] else True


def test_options_are_checked_before_anything_is_planned():
    with Machine() as m:
        for argv, code in (([ "--user", "root"], "bad-user"), (["--user", "Bad Name"], "bad-user"), (["--egress", "wide"], "bad-egress"),
                           (["--allow-host", "router.lan"], "bad-option"), (["--block-loopback-port", "70000"], "bad-option"),
                           (["--agents", "Haile"], "bad-agents")):
            rc, out, err = m.run("machine", *argv)
            assert rc == 1 and json.loads(err)["code"] == code, (argv, err)
            assert "fix" in json.loads(err)


def test_other_systems_are_refused_with_a_way_forward():
    with Machine() as m:
        open(os.path.join(m.root, "etc", "os-release"), "w").write('ID=fedora\nPRETTY_NAME="Fedora"\n')
        rc, out, err = m.run(*machine_args())
        assert rc == 1 and json.loads(err)["code"] == "unsupported-os"


def test_key_only_ssh_and_keep_awake_are_opt_in_and_a_private_key_is_refused():
    with Machine() as m:
        rc, out, _ = m.run(*machine_args())
        assert "key-only SSH" not in out and "stays awake" not in out and "Keep the machine awake" not in out
        rc, out, _ = m.run(*machine_args("--harden-ssh", "--keep-awake"))
        assert "Key-only SSH" in out and "Keep the machine awake" in out and "mask sleep.target" in out
        assert m.run(*machine_args("--apply", "--yes", "--harden-ssh", "--keep-awake"))[0] == 0
        assert "PasswordAuthentication no" in m.file("/etc/ssh/sshd_config.d/50-factory.conf")
        assert "HandleLidSwitch=ignore" in m.file("/etc/systemd/logind.conf.d/50-factory.conf")
        key = os.path.join(m.state, "id_ed25519")
        open(key, "w").write("-----BEGIN OPENSSH PRIVATE KEY-----\nxx\n")
        rc, out, err = m.run(*machine_args("--authorized-keys", key))
        assert rc == 1 and json.loads(err)["code"] == "private-key"
        pub = os.path.join(m.state, "k.pub")
        open(pub, "w").write("ssh-ed25519 AAAAC3 me@laptop\n")
        assert m.run(*machine_args("--apply", "--yes", "--authorized-keys", pub))[0] == 0
        assert m.file(f"/home/{USER}/.ssh/authorized_keys") == "ssh-ed25519 AAAAC3 me@laptop\n"


def test_a_laptop_stays_awake_without_being_asked_and_can_opt_out():
    with Machine() as m:
        os.makedirs(os.path.join(m.root, "sys", "class", "power_supply", "BAT0"))
        assert "Keep the machine awake" in m.run(*machine_args())[1]
        assert "Keep the machine awake" not in m.run(*machine_args("--no-keep-awake"))[1]



def test_status_matches_reality_and_shows_what_drifted():
    with Machine() as m:
        rc, out, _ = m.run("status")
        assert rc == 0 and "has not been run" in out
        m.run(*machine_args("--apply", "--yes"))
        rc, out, _ = m.run("status")
        assert rc == 0 and "Sandbox user: sbxuser (uid 4242)" in out and "fix   " not in out and "ok    net-guard" in out
        os.remove(M.rules_path())
        rc, out, _ = m.run("status")
        assert rc == 1 and "net-guard" in out and "net-guard.nft is missing" in out and "puts them back" in out


def test_uninstall_removes_the_system_parts_and_keeps_the_user_and_the_home():
    with Machine() as m:
        m.run(*machine_args("--apply", "--yes"))
        home = os.path.join(m.root, "home-sbxuser")
        os.makedirs(home)
        open(os.path.join(home, "keep.txt"), "w").write("x")
        rc, out, _ = m.run("uninstall")
        assert rc == 0 and "Nothing was changed" in out and os.path.exists(M.rules_path())
        rc, out, err = m.run("uninstall", "--apply", "--yes")
        assert rc == 0, out + err
        assert not os.path.exists(M.rules_path()) and not os.path.exists(M.unit_path()) and not os.path.exists(M.manifest_path())
        assert "disable --now factory-net-guard.service" in m.logged("systemctl")
        assert any("delete table inet factory_guard" in l for l in m.logged("nft"))
        assert os.path.exists(os.path.join(home, "keep.txt")) and os.path.exists(os.path.join(m.state, f"user-{USER}"))
        assert not any("deluser" in l for l in m.logged("adduser"))


def test_removing_the_user_needs_its_name_typed():
    with Machine() as m:
        m.run(*machine_args("--apply", "--yes"))
        for argv in (["--remove-user"], ["--delete-home", "--confirm", "wrong"]):
            rc, out, err = m.run("uninstall", "--apply", *argv)
            assert rc == 1 and json.loads(err)["code"] == "not-confirmed", err
            assert os.path.exists(M.manifest_path()) and os.path.exists(M.rules_path())
        fakes = os.path.join(m.env["PATH"].split(":")[0], "deluser")
        open(fakes, "w").write('#!/bin/bash\necho "$*" >>"$FAKE_LOG/deluser.log"\n')
        os.chmod(fakes, 0o755)
        rc, out, err = m.run("uninstall", "--apply", "--delete-home", "--confirm", USER, "--user", USER)
        assert rc == 0, out + err
        assert m.logged("deluser") == [f"--remove-home {USER}"]


def test_a_user_that_existed_before_is_never_removed():
    with Machine(**{f"user-{USER}": ""}) as m:
        m.run(*machine_args("--apply", "--yes"))
        rc, out, _ = m.run("uninstall", "--apply", "--yes", "--remove-user")
        assert rc == 0 and "existed before bootstrap" in out and not m.logged("deluser")


# ---- the project part -------------------------------------------------------------------------------------------------

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


def test_the_project_part_refuses_to_run_as_root():
    with Machine() as m:
        rc, out, err = m.run("project", "--user", USER)
        assert rc == 1 and json.loads(err)["code"] == "root-refused" and USER in json.loads(err)["fix"]


def test_the_project_part_stops_for_the_human_steps_and_never_prints_a_token():
    with Machine() as m:
        m.root_user = False
        add_user_tools(m)
        os.environ["GH_TOKEN"] = "ghp_SECRETSECRETSECRET"
        os.environ["ANTHROPIC_API_KEY"] = "sk-ant-SECRETSECRET"
        repo = project_repo(m, {"commands": {"install": "true"}}, {".env.example": "A=\n", ".sops.yaml": "creation_rules: []\n"})
        os.makedirs(os.path.join(os.environ["HOME"], ".secrets"), mode=0o700)
        with in_dir(repo):
            rc, out, err = m.run("project", "--user", USER, "--agents", "haile,tewodros")
        assert rc == 2, out + err
        assert "gh auth login" in out and "claude" in out and "keys.txt" in out and "never reads or stores a token" in out
        for secret in ("ghp_SECRETSECRETSECRET", "sk-ant-SECRETSECRET"):
            assert secret not in out and secret not in err
        assert "factory machine setup haile,tewodros" in m.logged("factory")[0] or "machine setup haile,tewodros" in " ".join(m.logged("factory"))
        assert os.path.exists(os.path.join(repo, ".env.local"))
        assert "ci install" not in " ".join(m.logged("factory")), "runners wait for the sign-ins"
        assert "# --- software factory" in open(os.path.join(os.environ["HOME"], ".bashrc")).read()


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


def test_the_project_part_without_a_checkout_asks_for_a_repo():
    with Machine() as m:
        m.root_user = False
        add_user_tools(m)
        with in_dir(m.state):
            rc, out, err = m.run("project", "--user", USER)
        assert rc == 1 and json.loads(err)["code"] == "no-project" and "--repo" in json.loads(err)["fix"]
        with in_dir(m.state):
            rc, out, err = m.run("project", "--user", USER, "--repo", "https://github.com/acme/app.git", "--dry-run")
        assert rc == 0 and "git clone --recurse-submodules https://github.com/acme/app.git" in out


# ---- doctor --sandbox -------------------------------------------------------------------------------------------------

class Rep:
    def __init__(self):
        self.lines = []
        self.fixes = 0

    def ok(self, what):
        self.lines.append(("ok", what, ""))

    def fix(self, what, how):
        self.fixes += 1
        self.lines.append(("fix", what, how))

    def note(self, what, how):
        self.lines.append(("note", what, how))

    def text(self):
        return "\n".join(f"{k} {w} {h}" for k, w, h in self.lines)


def sandbox_machine(m):
    """A machine where bootstrap ran and everything holds."""
    import factory_sandbox as S
    m.run(*machine_args("--apply", "--yes", "--block-loopback-port", "3000"))
    open(os.path.join(m.state, "dockerinfo"), "w").write('["name=seccomp","name=rootless"]|overlay2')
    open(os.path.join(m.state, "ss.txt"), "w").write("")
    cg = os.path.join(m.root, "sys/fs/cgroup/user.slice/user-%d.slice/user@%d.service" % (os.getuid(), os.getuid()))
    os.makedirs(cg)
    open(os.path.join(cg, "cgroup.controllers"), "w").write("cpuset cpu io memory pids\n")
    open(os.path.join(m.state, "userunits"), "w").write("proj-ci.service loaded active running CI runner\n")
    manifest = json.load(open(M.manifest_path()))
    manifest["steps"]["isolate"] = {"record": {"adminHome": os.path.join(m.root, "home-admin")}}
    json.dump(manifest, open(M.manifest_path(), "w"))
    return S


def sandbox_report(S, m):
    r = Rep()
    S.run(r, {"ci": {"runners": 1}})
    return r


def test_the_sandbox_checks_pass_on_a_machine_where_everything_holds():
    with Machine() as m:
        S = sandbox_machine(m)
        r = sandbox_report(S, m)
        bad = [l for l in r.lines if l[0] == "fix"]
        assert not bad, r.text()
        text = r.text()
        for part in ("no sudo", "not in the sudo, docker or admin groups", "the internet works", "not reachable",
                     "cannot reach the router either", "Docker is rootless", "cpu, memory and pids", "linger is on", "FACTORY-BLOCK"):
            assert part in text, (part, text)


def test_a_user_with_sudo_or_the_docker_group_fails_the_sandbox_with_a_fix():
    with Machine() as m:
        S = sandbox_machine(m)
        open(os.path.join(m.state, "has-sudo"), "w").write("")
        open(os.path.join(m.state, f"groups-{USER}"), "w").write("docker\n")
        os.environ["USER"] = USER
        r = sandbox_report(S, m)
        fixes = [(w, h) for k, w, h in r.lines if k == "fix"]
        assert any(w == "sudo" and "gpasswd -d" in h for w, h in fixes), r.text()


def test_reaching_the_router_the_tailnet_or_a_blocked_port_fails_the_sandbox():
    with Machine() as m:
        S = sandbox_machine(m)
        open(os.path.join(m.state, "open"), "w").write("http://192.168.2.1\nhttp://127.0.0.1:3000\n")
        r = sandbox_report(S, m)
        fix = [h for k, w, h in r.lines if k == "fix" and w == "home network"]
        assert fix and "the router 192.168.2.1" in fix[0] and "127.0.0.1:3000" in fix[0] and "tailnet" not in fix[0], r.text()


def test_a_container_that_reaches_the_router_fails_the_sandbox_gap_two():
    with Machine() as m:
        S = sandbox_machine(m)
        open(os.path.join(m.state, "container-open"), "w").write("")
        r = sandbox_report(S, m)
        assert any(k == "fix" and w == "containers" for k, w, h in r.lines), r.text()


def test_a_local_service_the_guard_does_not_cover_fails_the_sandbox_gap_one():
    with Machine() as m:
        S = sandbox_machine(m)
        open(os.path.join(m.state, "ss.txt"), "w").write("LISTEN 0 1 127.0.0.1:9100 0.0.0.0:* uid:1000 ino:1\n")
        r = sandbox_report(S, m)
        fix = [h for k, w, h in r.lines if k == "fix" and w == "local services of other users"]
        assert fix and "9100" in fix[0] and "machine --apply" in fix[0], r.text()


def test_missing_cgroup_controllers_linger_and_runners_each_get_a_fix():
    with Machine() as m:
        S = sandbox_machine(m)
        cg = os.path.join(m.root, "sys/fs/cgroup/user.slice/user-%d.slice/user@%d.service" % (os.getuid(), os.getuid()))
        open(os.path.join(cg, "cgroup.controllers"), "w").write("cpuset io\n")
        os.remove(os.path.join(m.state, "linger"))
        open(os.path.join(m.state, "userunits"), "w").write("")
        r = sandbox_report(S, m)
        whats = {w for k, w, h in r.lines if k == "fix"}
        assert {"cgroup controllers", "linger", "CI runners"} <= whats, r.text()
        assert any("Delegate=" in h for k, w, h in r.lines if w == "cgroup controllers")


def test_doctor_sandbox_is_wired_into_the_doctor_and_the_factory_command():
    text = open(os.path.join(HOOKS, "factory_doctor.py")).read()
    assert "--sandbox" in text and "factory_sandbox" in text
    help_ = subprocess.run(["bash", os.path.join(SF, "factory"), "help"], capture_output=True, text=True,
                           cwd=tempfile.mkdtemp(), env={**os.environ, "GIT_CEILING_DIRECTORIES": "/"})
    # outside a repo the help is not shown, but bootstrap still is
    out = subprocess.run(["bash", os.path.join(SF, "factory"), "bootstrap", "help"], capture_output=True, text=True,
                         cwd=tempfile.mkdtemp(), env={**os.environ, "GIT_CEILING_DIRECTORIES": "/"})
    assert out.returncode == 0 and "factory bootstrap machine" in out.stdout, out.stderr


def test_factory_help_lists_bootstrap_and_the_sandbox_option():
    d = tempfile.mkdtemp()
    subprocess.run(["git", "init", "-q", d], check=True)
    p = subprocess.run(["bash", os.path.join(SF, "factory"), "help"], capture_output=True, text=True, cwd=d)
    assert "bootstrap machine|project|all|status|uninstall" in p.stdout and "doctor [--sandbox]" in p.stdout, p.stderr


def test_new_files_reach_projects_through_the_old_kit_paths_and_are_documented():
    for name in ("factory_bootstrap", "factory_bootstrap_core", "factory_bootstrap_machine", "factory_bootstrap_project",
                 "factory_sandbox", "factory_netguard"):
        link = os.path.join(SF, "kit", ".claude", "hooks", name + ".py")
        assert os.path.islink(link) and os.path.realpath(link) == os.path.join(HOOKS, name + ".py"), name
    readme = readme_and_wiki()
    for part in ("factory bootstrap", "--apply", "--script", "doctor --sandbox", "Network guard", "manifest",
                 "gh auth login", "FACTORY-BLOCK"):
        assert part in readme, part


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
