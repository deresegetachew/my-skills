#!/usr/bin/env python3
"""`factory follow`, `factory say`, `factory remote` and `factory agent --detach` (#106), with a fake ssh and a fake tmux.
  python3 software-factory/tests/test_follow.py

The fake ssh runs the remote command on this machine, with the state of the remote it was asked for (a folder per host:
its tmux sessions, their screens, whether the account has sudo). The fake tmux keeps sessions in files and logs what it was
asked. Whether a real tmux shows the same screen to everyone is not tested here."""
import json, os, shutil, subprocess, sys, tempfile
from wiki_text import readme_and_wiki

HERE = os.path.dirname(os.path.abspath(__file__))
SF = os.path.abspath(os.path.join(HERE, ".."))
HOOKS = os.path.join(SF, "hooks")
FOLLOW = os.path.join(HOOKS, "factory_follow.py")
sys.path.insert(0, HOOKS)

FAKE_SSH = r'''#!/bin/bash
# fake ssh: skip the options, take the target, run the rest as the remote command on "that host"
echo "$*" >>"$FAKE_LOG/ssh.log"
while [ $# -gt 0 ]; do
  case "$1" in -o) shift 2 ;; -t|-tt|-T) shift ;; *) break ;; esac
done
target="$1"; shift; host="${target#*@}"
case "$host" in down*) echo "ssh: connect to host $host port 22: No route to host" >&2; exit 255 ;; esac
export FAKE_REMOTE="$host" SSH_CLIENT="10.0.0.9 5555 22"
exec bash -c "$*"
'''

FAKE_TMUX = r'''#!/bin/bash
host="${FAKE_REMOTE:-local}"; d="$FAKE_STATE/$host"; mkdir -p "$d"
echo "$host: $*" >>"$FAKE_LOG/tmux.log"
case "$1" in
  list-sessions) cat "$d/sessions" 2>/dev/null ;;
  capture-pane) name=""; while [ $# -gt 0 ]; do [ "$1" = -t ] && name="$2"; shift; done
                name="${name#=}"; name="${name%:}"; cat "$d/pane-$name" 2>/dev/null ;;
  has-session) name="${3#=}"; grep -qx -- "$name" "$d/sessions" 2>/dev/null ;;
  new-session) shift; name=""; while [ $# -gt 0 ]; do case "$1" in -s) name="$2"; shift 2 ;; -c) shift 2 ;; -d) shift ;; *) break ;; esac; done
               echo "$name" >>"$d/sessions"; echo "$*" >"$d/cmd-$name" ;;
  send-keys) shift; echo "keys: $*" >>"$d/keys" ;;
esac
'''


def sudo_body():
    return '[ -f "$FAKE_STATE/${FAKE_REMOTE:-local}/has-sudo" ]'


class World:
    def __init__(self, hosts=("pc",), agents=("haile", "tewodros")):
        self.base = tempfile.mkdtemp()
        b = self.bin = os.path.join(self.base, "bin")
        self.state, self.log, self.cfg = (os.path.join(self.base, n) for n in ("state", "log", "config"))
        for d in (b, self.state, self.log, self.cfg):
            os.makedirs(d)
        for tool in ("python3", "bash", "sh", "env", "cat", "grep", "sed", "tail", "mkdir", "date", "printf", "dirname", "git", "uname", "id", "tr"):
            if shutil.which(tool):
                os.symlink(shutil.which(tool), os.path.join(b, tool))
        for name, body in (("ssh", FAKE_SSH), ("tmux", FAKE_TMUX), ("sudo", "#!/bin/bash\n" + sudo_body() + "\n")):
            with open(os.path.join(b, name), "w") as f:
                f.write(body if body.startswith("#!") else "#!/bin/bash\n" + body)
            os.chmod(os.path.join(b, name), 0o755)
        self.repo = os.path.join(self.base, "app")
        os.makedirs(os.path.join(self.repo, ".claude"))
        subprocess.run(["git", "init", "-q", "-b", "main", self.repo], check=True)
        json.dump({"agents": list(agents)}, open(os.path.join(self.repo, ".claude", "factory.json"), "w"))
        with open(os.path.join(self.repo, "factory"), "w") as f:
            f.write('#!/bin/bash\necho "factory $*" >>"$FAKE_LOG/factory.log"\n')
        os.chmod(os.path.join(self.repo, "factory"), 0o755)
        self.env = {"PATH": b + ":" + os.path.dirname(sys.executable), "FAKE_STATE": self.state, "FAKE_LOG": self.log,
                    "FACTORY_CONFIG_DIR": self.cfg, "HOME": self.base, "XDG_CACHE_HOME": os.path.join(self.base, "cache"),
                    "XDG_STATE_HOME": os.path.join(self.base, "xstate"), "USER": "owner", "CLAUDE_PROJECT_DIR": self.repo}
        for h in hosts:
            os.makedirs(os.path.join(self.state, h), exist_ok=True)

    def session(self, host, name, screen=""):
        d = os.path.join(self.state, host)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "sessions"), "a") as f:
            f.write(name + "\n")
        open(os.path.join(d, f"pane-{name}"), "w").write(screen)

    def factory(self, *argv, stdin=None, env=None):
        return subprocess.run([sys.executable, FOLLOW, *argv], cwd=self.repo, env={**self.env, **(env or {})}, input=stdin,
                              capture_output=True, text=True, timeout=60)

    def read(self, rel):
        try:
            return open(os.path.join(self.base, rel)).read()
        except OSError:
            return ""

    def logged(self, name):
        return self.read(os.path.join("log", name + ".log")).splitlines()

    def keys(self, host):
        return self.read(os.path.join("state", host, "keys")).splitlines()


RC = "claude.ai/code/session_01ABCdef"
SCREEN = f"Claude Code\n /remote-control is active · https://{RC}\n> working\n"


def error(p):
    return json.loads(p.stderr.strip().splitlines()[-1])


def test_remotes_are_added_listed_and_removed_in_the_machine_file_not_the_project():
    w = World()
    assert "No remotes" in w.factory("remote", "list").stdout
    p = w.factory("remote", "add", "dev-pc", "factory@192.168.2.45")
    assert p.returncode == 0, p.stderr
    assert "dev-pc  ssh  factory@192.168.2.45" in w.factory("remote", "list").stdout
    machine_file = os.path.join(w.cfg, "app.json")
    assert json.load(open(machine_file))["remotes"]["dev-pc"] == {"kind": "ssh", "target": "factory@192.168.2.45"}
    assert "dev-pc" not in open(os.path.join(w.repo, ".claude", "factory.json")).read()
    assert w.factory("remote", "remove", "dev-pc").returncode == 0 and "No remotes" in w.factory("remote", "list").stdout
    assert error(w.factory("remote", "remove", "dev-pc"))["code"] == "no-such-remote"


def test_a_bad_name_target_or_an_admin_account_is_refused_with_a_fix():
    w = World()
    for argv, code in ((["add", "Dev PC", "factory@host"], "bad-name"), (["add", "dev-pc", "host-only"], "bad-target"),
                       (["add", "dev-pc", "root@host"], "admin-target"), (["cloud", "haile", "http://example.com/x"], "bad-url")):
        e = error(w.factory("remote", *argv))
        assert e["code"] == code and e["fix"], argv


def test_follow_without_a_name_lists_the_agents_on_every_remote_with_state_and_the_remote_control_link():
    w = World(hosts=("pc", "nuc"))
    w.session("pc", "haile", SCREEN)
    w.session("pc", "app-tewodros", "plain screen\n")
    w.session("pc", "unrelated-shell", "x")
    w.session("nuc", "dev-manager-pr-42", f"https://{RC}-mgr\n")
    for name, target in (("dev-pc", "factory@pc"), ("nuc", "factory@nuc")):
        w.factory("remote", "add", name, target)
    p = w.factory("follow")
    assert p.returncode == 0, p.stderr
    lines = {l.split()[0]: l for l in p.stdout.splitlines() if l and l.split()[0] in ("haile", "tewodros", "dev-manager-pr-42")}
    assert set(lines) == {"haile", "tewodros", "dev-manager-pr-42"}, p.stdout
    assert "dev-pc" in lines["haile"] and f"https://{RC}" in lines["haile"]
    assert "dev-pc" in lines["tewodros"] and "nuc" in lines["dev-manager-pr-42"] and "dev-manager on pr-42" in lines["dev-manager-pr-42"]
    assert "unrelated-shell" not in p.stdout
    data = json.loads(w.factory("follow", "--json").stdout)
    assert {a["name"] for a in data["agents"]} == {"haile", "tewodros", "dev-manager-pr-42"} and data["unreachable"] == []
    assert [a for a in data["agents"] if a["name"] == "dev-manager-pr-42"][0]["kind"] == "sub-manager"


def test_the_list_uses_github_for_state_task_and_last_ping_when_it_can():
    import factory_follow as F
    import factory_remotes as R
    w = World()
    w.session("pc", "haile", SCREEN)
    w.factory("remote", "add", "dev-pc", "factory@pc")
    old = dict(os.environ)
    os.environ.update(w.env)
    saved = F.github_states
    F.github_states = lambda cfg: {"haile": ("working", 3, "working on #42"), "tewodros": ("silent", 95, "idle")}
    try:
        os.chdir(w.repo)
        rows, down = F.rows({"agents": ["haile", "tewodros"]}, "app")
        by = {r["name"]: r for r in rows}
        assert by["haile"]["state"] == "alive" and by["haile"]["task"] == "working on #42" and by["haile"]["lastPing"] == "3 min ago"
        assert by["haile"]["remoteControl"] == f"https://{RC}"
        assert by["tewodros"]["state"] == "silent" and by["tewodros"]["where"] == "not on a remote", by
    finally:
        F.github_states = saved
        os.environ.clear()
        os.environ.update(old)


def test_an_unreachable_remote_is_named_and_the_others_still_list():
    w = World(hosts=("pc", "down1"))
    w.session("pc", "haile", SCREEN)
    w.factory("remote", "add", "dev-pc", "factory@pc")
    w.factory("remote", "add", "far", "factory@down1")
    p = w.factory("follow")
    assert p.returncode == 0 and "haile" in p.stdout and "far: unreachable" in p.stdout and "No route to host" in p.stdout


def test_follow_by_name_attaches_to_that_session_interactively_with_the_detach_note():
    w = World(hosts=("pc", "nuc"))
    w.session("pc", "haile", SCREEN)
    w.session("nuc", "tewodros", "")
    w.factory("remote", "add", "dev-pc", "factory@pc")
    w.factory("remote", "add", "nuc", "factory@nuc")
    p = w.factory("follow", "haile")
    assert p.returncode == 0, p.stderr
    attach = [l for l in w.logged("tmux") if " attach " in l]
    assert attach == ["pc: attach -t =haile"], attach
    ssh = [l for l in w.logged("ssh") if "attach" in l]
    assert len(ssh) == 1 and "factory@pc" in ssh[0] and " -t " in " " + ssh[0], ssh  # a terminal is requested
    assert "Ctrl-b d" in p.stderr and "Ctrl+C is not detach" in p.stderr and f"https://{RC}" in p.stderr
    assert "BatchMode=yes" in ssh[0] and "ControlMaster=auto" in ssh[0] and "ControlPersist" in ssh[0]


def test_read_attaches_with_the_read_only_flag_so_nothing_can_be_typed():
    w = World()
    w.session("pc", "haile", SCREEN)
    w.factory("remote", "add", "dev-pc", "factory@pc")
    p = w.factory("follow", "haile", "--read")
    assert p.returncode == 0 and [l for l in w.logged("tmux") if " attach " in l] == ["pc: attach -r -t =haile"]
    assert "Watching only" in p.stderr


def test_a_name_on_two_remotes_is_refused_and_on_picks_one():
    w = World(hosts=("pc", "nuc"))
    w.session("pc", "haile", SCREEN)
    w.session("nuc", "app-haile", "")
    w.factory("remote", "add", "dev-pc", "factory@pc")
    w.factory("remote", "add", "nuc", "factory@nuc")
    e = error(w.factory("follow", "haile"))
    assert e["code"] == "ambiguous" and "--on" in e["fix"] and "dev-pc" in e["message"] and "nuc" in e["message"]
    assert not [l for l in w.logged("tmux") if " attach " in l]
    assert w.factory("follow", "haile", "--on", "nuc").returncode == 0
    assert [l for l in w.logged("tmux") if " attach " in l] == ["nuc: attach -t =app-haile"]


def test_an_unknown_agent_an_unreachable_remote_and_a_missing_tmux_each_say_what_to_do():
    w = World(hosts=("pc", "down1"))
    w.session("pc", "haile", SCREEN)
    w.factory("remote", "add", "dev-pc", "factory@pc")
    e = error(w.factory("follow", "menelik"))
    assert e["code"] == "no-such-agent" and "dev-pc" in e["fix"] and "factory follow" in e["fix"]
    e = error(w.factory("follow", "zzz"))
    assert "Known names: haile, tewodros" in e["fix"]
    w.factory("remote", "add", "far", "factory@down1")
    assert error(w.factory("follow", "haile", "--on", "far"))["code"] in ("no-such-agent", "unreachable")
    w2 = World()
    e = error(w2.factory("follow", "haile"))
    assert e["code"] == "no-such-agent" and "factory remote add" in e["fix"]
    os.remove(os.path.join(w.bin, "tmux"))
    assert error(w.factory("follow", "haile"))["code"] == "no-such-agent"  # no tmux there: no sessions


def test_a_target_with_sudo_is_refused_for_every_command():
    w = World()
    w.session("pc", "haile", SCREEN)
    w.factory("remote", "add", "dev-pc", "factory@pc")
    open(os.path.join(w.state, "pc", "has-sudo"), "w").write("")
    p = w.factory("follow")
    assert "unreachable (the account can run sudo" in p.stdout
    for argv in (["follow", "haile"], ["say", "haile", "hello"]):
        e = error(w.factory(*argv))
        assert e["code"] in ("no-such-agent", "sudo-target"), (argv, e)
    assert not [l for l in w.logged("tmux") if " attach " in l] and w.keys("pc") == []
    import factory_remotes as R
    old = dict(os.environ)
    os.environ.update(w.env)
    try:
        R.ensure_sandbox_target("factory@pc")
        raise AssertionError("a sudo target was accepted")
    except R.RemoteError as e:
        assert e.code == "sudo-target"
    finally:
        os.environ.clear()
        os.environ.update(old)


def test_a_cloud_agent_prints_its_remote_control_link_instead_of_attaching():
    w = World()
    assert w.factory("remote", "cloud", "abebe", "https://claude.ai/code/session_01CLOUD").returncode == 0
    listing = w.factory("follow").stdout
    assert "abebe" in listing and "cloud" in listing and "https://claude.ai/code/session_01CLOUD" in listing
    p = w.factory("follow", "abebe")
    assert p.returncode == 0 and "runs in the cloud" in p.stdout and "https://claude.ai/code/session_01CLOUD" in p.stdout
    assert w.logged("ssh") == [] or not [l for l in w.logged("ssh") if "attach" in l]
    e = error(w.factory("say", "abebe", "hello"))
    assert e["code"] == "cloud-agent" and "Remote Control" in e["fix"]


def test_say_sends_the_text_to_that_session_only_and_logs_who_when_and_which_agent_without_the_text():
    w = World(hosts=("pc", "nuc"))
    w.session("pc", "haile", SCREEN)
    w.session("pc", "app-tewodros", "")
    w.session("nuc", "menelik", "")
    w.factory("remote", "add", "dev-pc", "factory@pc")
    w.factory("remote", "add", "nuc", "factory@nuc")
    msg = "-t please check the \"failing\" test $(rm -rf /) and carry on"
    p = w.factory("say", "haile", msg)
    assert p.returncode == 0, p.stderr
    sends = [l for l in w.logged("tmux") if "send-keys" in l]
    assert sends == [f"pc: send-keys -t =haile: -l -- {msg}", "pc: send-keys -t =haile: Enter"], sends
    assert w.keys("nuc") == [] and not any("tewodros" in l for l in sends)
    log = w.read("xstate/software-factory/say.log")
    assert "agent=haile" in log and "from=owner@" in log and "via=10.0.0.9" in log and "failing" not in log and "rm -rf" not in log


def test_say_refuses_empty_multi_line_and_control_character_messages_and_a_missing_session():
    w = World()
    w.session("pc", "haile", SCREEN)
    w.factory("remote", "add", "dev-pc", "factory@pc")
    for bad in ("", "  ", "line one\nline two", "tab\there", "x" * 2001):
        assert error(w.factory("say", "haile", bad))["code"] == "bad-message"
    assert w.keys("pc") == []
    os.remove(os.path.join(w.state, "pc", "sessions"))
    w.session("pc", "elsewhere", "")
    assert error(w.factory("say", "haile", "hi"))["code"] == "no-such-agent"


def test_an_agent_session_cannot_say_or_change_the_remotes_but_can_list():
    w = World()
    w.session("pc", "haile", SCREEN)
    w.factory("remote", "add", "dev-pc", "factory@pc")
    for env in ({"FACTORY_AGENT": "haile"}, {"FACTORY_LOOP": "1"}, {"CLAUDECODE": "1"}):
        assert error(w.factory("say", "haile", "hi", env=env))["code"] == "agent-session"
        assert error(w.factory("remote", "add", "x", "factory@y", env=env))["code"] == "agent-session"
        assert w.factory("remote", "list", env=env).returncode == 0 and w.factory("follow", env=env).returncode == 0
    assert w.keys("pc") == []


def test_log_streams_only_new_lines_without_a_terminal():
    import factory_follow as F
    assert F.new_lines(["a", "b", "c"], ["b", "c", "d", "e"]) == ["d", "e"]
    assert F.new_lines(["a", "b"], ["a", "b"]) == []
    assert F.new_lines(["a", "b"], ["x", "y"]) == ["x", "y"]
    w = World()
    w.session("pc", "haile", "line 1\nline 2\n")
    w.factory("remote", "add", "dev-pc", "factory@pc")
    p = w.factory("follow", "haile", "--log", "--polls", "1")
    assert p.returncode == 0 and p.stdout == "line 1\nline 2\n"
    assert not [l for l in w.logged("tmux") if " attach " in l] and not [l for l in w.logged("ssh") if l.startswith("-t ")]


def test_all_opens_one_read_only_pane_per_session_in_a_local_tmux():
    w = World(hosts=("pc", "nuc", "local"))
    w.session("pc", "haile", SCREEN)
    w.session("nuc", "tewodros", "")
    w.factory("remote", "add", "dev-pc", "factory@pc")
    w.factory("remote", "add", "nuc", "factory@nuc")
    p = w.factory("follow", "--all")
    assert p.returncode == 0, p.stderr
    local = [l for l in w.logged("tmux") if l.startswith("local:")]
    assert any("new-session -d -s factory-follow-" in l and "attach -r -t =haile" in l for l in local) or \
        any("attach -r -t =haile" in l for l in local), local
    assert any("split-window" in l and "attach -r -t =tewodros" in l for l in local) or any("attach -r -t =tewodros" in l for l in local)
    assert any("select-layout" in l and "tiled" in l for l in local)
    assert all("attach -t =" not in l or l.endswith(" -t factory-follow") or "factory-follow-" in l for l in local if "attach" in l)
    assert error(World().factory("follow", "--all"))["code"] == "nothing-to-follow"


def test_agent_detach_starts_a_named_tmux_session_the_follow_commands_find():
    w = World(hosts=("local",))
    p = w.factory("detach", "haile")
    assert p.returncode == 0, p.stderr
    session = "app-haile"
    assert session in open(os.path.join(w.state, "local", "sessions")).read().split()
    cmd = open(os.path.join(w.state, "local", f"cmd-{session}")).read()
    assert cmd.strip().endswith(f"exec {os.path.join(w.repo, 'factory')} agent haile"), cmd
    assert "factory follow haile" in p.stdout
    again = w.factory("detach", "haile")
    assert again.returncode == 0 and "already running" in again.stdout
    assert open(os.path.join(w.state, "local", "sessions")).read().split().count(session) == 1
    assert w.factory("detach", "1").returncode == 0 and "app-haile" in open(os.path.join(w.state, "local", "sessions")).read()
    assert error(w.factory("detach", "9"))["code"] == "no-such-agent"
    assert error(w.factory("detach"))["code"] == "usage"
    # and the session it made is found by name from a remote that is this machine
    w.factory("remote", "add", "me", "factory@local")
    assert "haile" in w.factory("follow").stdout


def test_the_factory_command_wires_the_new_commands_and_detach():
    w = World(hosts=("local",))
    subprocess.run(["git", "-C", w.repo, "add", "-A"], check=True)
    os.makedirs(os.path.join(w.repo, ".claude", "hooks"))
    for f in os.listdir(HOOKS):
        if f.endswith(".py"):
            os.symlink(os.path.join(HOOKS, f), os.path.join(w.repo, ".claude", "hooks", f))
    cli = os.path.join(SF, "factory")
    run = lambda *a: subprocess.run(["bash", cli, *a], cwd=w.repo, env=w.env, capture_output=True, text=True)
    p = run("help")
    for part in ("follow [<agent>]", "say <agent>", "remote [add|cloud|list|remove]", "--detach"):
        assert part in p.stdout, part
    assert run("remote", "add", "dev-pc", "factory@pc").returncode == 0 and "dev-pc" in run("remote", "list").stdout
    w.session("pc", "haile", SCREEN)
    assert "haile" in run("follow").stdout
    d = run("agent", "haile", "--detach")
    assert d.returncode == 0 and "app-haile" in open(os.path.join(w.state, "local", "sessions")).read(), d.stderr


def test_new_files_reach_projects_through_the_old_kit_paths_and_are_documented():
    for name in ("factory_follow", "factory_remotes"):
        link = os.path.join(SF, "kit", ".claude", "hooks", name + ".py")
        assert os.path.islink(link) and os.path.realpath(link) == os.path.join(HOOKS, name + ".py"), name
    readme = readme_and_wiki()
    for part in ("factory follow", "factory say", "factory remote add", "--detach", "Remote Control", "sub-manager", "sudo",
                 "ControlMaster", "Ctrl-b d"):
        assert part in readme, part


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
