#!/usr/bin/env python3
"""`factory autostart` and `factory resume` (#88): a machine brings the stack and its agents back after a reboot,
without losing unfinished work.  python3 software-factory/tests/test_autostart.py

tmux, docker, systemctl, loginctl, launchctl, plutil and gh are fakes on PATH; HOME and the config and state
folders are temp folders. What systemd and launchd do at a real boot can't be tested here."""
import json, os, plistlib, re, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SF = os.path.abspath(os.path.join(HERE, ".."))
HOOKS = os.path.join(SF, "hooks")
AUTOSTART = os.path.join(HOOKS, "factory_autostart.py")
RESUME = os.path.join(HOOKS, "factory_resume.py")
MACHINE = os.path.join(HOOKS, "factory_machine.py")
CLAIMS = os.path.join(HOOKS, "factory_claims.py")
LOOP = os.path.join(SF, "factory-loop.sh")
FACTORY = os.path.join(SF, "factory")

sys.path.insert(0, HERE)
import test_issues as T  # noqa: E402  (the fake gh that keeps issues in a file)
import test_doctor as D  # noqa: E402

GIT = {"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "protocol.file.allow", "GIT_CONFIG_VALUE_0": "always",
       "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}
NAMES = ["menelik", "taytu", "haile", "tewodros"]

FAKE_TMUX = r'''#!/usr/bin/env bash
echo "$*" >>"$FAKE_LOG/tmux.log"
d="$FAKE_TMUX"; mkdir -p "$d"
case "$1" in
  has-session) name="${3#=}"; [ -f "$d/$name" ] ;;
  new-session)
    shift; name=""
    while [ $# -gt 0 ]; do
      case "$1" in -s) name="$2"; shift 2 ;; -c) echo "$2" >"$d/$name.dir"; shift 2 ;; -d) shift ;; *) break ;; esac
    done
    printf '%s\n' "$*" >"$d/$name" ;;
esac
'''

# Fails `docker info` the first $FAKE_DOCKER_FAILS times it is asked (a Docker that is still starting).
FAKE_DOCKER = r'''#!/usr/bin/env bash
echo "$*" >>"$FAKE_LOG/docker.log"
n="$FAKE_LOG/docker.fails"; [ -f "$n" ] || echo "${FAKE_DOCKER_FAILS:-0}" >"$n"
left="$(cat "$n")"
if [ "$left" -gt 0 ]; then echo $((left - 1)) >"$n"; echo "Cannot connect to the Docker daemon" >&2; exit 1; fi
exit 0
'''

FAKE_SYSTEMCTL = r'''#!/usr/bin/env bash
echo "$*" >>"$FAKE_LOG/systemctl.log"
d="$FAKE_SYSTEMD"; mkdir -p "$d"
[ "$1" = "--user" ] || { echo "only --user" >&2; exit 1; }
shift
case "$1" in
  show-environment) [ -z "${FAKE_NO_BUS:-}" ] || { echo "Failed to connect to bus" >&2; exit 1; } ;;
  daemon-reload) ;;
  enable) u="$2"; [ "$2" = "--now" ] && u="$3"; echo 1 >"$d/$u" ;;
  disable) u="$2"; [ "$2" = "--now" ] && u="$3"; rm -f "$d/$u" ;;
  is-enabled) [ -f "$d/${3:-$2}" ] ;;
esac
'''

# Linger is a file: `enable-linger` creates it, `show-user` answers yes or no from it.
FAKE_LOGINCTL = r'''#!/usr/bin/env bash
echo "$*" >>"$FAKE_LOG/loginctl.log"
case "$1" in
  show-user) [ -f "$FAKE_LOG/linger" ] && echo yes || echo no ;;
  enable-linger) [ -z "${FAKE_LINGER_DENIED:-}" ] || { echo "Access denied" >&2; exit 1; }; touch "$FAKE_LOG/linger" ;;
esac
'''

FAKE_LAUNCHCTL = r'''#!/usr/bin/env bash
echo "$*" >>"$FAKE_LOG/launchctl.log"
d="$FAKE_LOG/launchd"; mkdir -p "$d"
case "$1" in
  print) l="${2##*/}"; [ -f "$d/$l" ] ;;
  bootout) l="${2##*/}"; [ -f "$d/$l" ] || exit 3; rm -f "$d/$l" ;;
  bootstrap) touch "$d/$(basename "$3" .plist)" ;;
esac
'''

FAKE_PLUTIL = r'''#!/usr/bin/env python3
import plistlib, sys
plistlib.load(open(sys.argv[2], "rb"))
'''


def sh(*a, cwd=None, check=True):
    return subprocess.run(a, cwd=cwd, check=check, env={**os.environ, **GIT}, capture_output=True, text=True)


def project(cfg=None):
    """A clone (named proj) of a bare origin; .claude/settings.json is a link into a submodule, as in a real project."""
    top = tempfile.mkdtemp()
    kit, origin, work = (os.path.join(top, n) for n in ("kit.git", "origin.git", "seed"))
    seed_kit = os.path.join(top, "kit-seed")
    os.makedirs(os.path.join(seed_kit, "kit"))
    json.dump({"hooks": {}}, open(os.path.join(seed_kit, "kit", "settings.json"), "w"))
    sh("git", "init", "-q", "-b", "main", seed_kit)
    sh("git", "add", "-A", cwd=seed_kit)
    sh("git", "commit", "-qm", "kit", cwd=seed_kit)
    sh("git", "clone", "-q", "--bare", seed_kit, kit)
    sh("git", "init", "-q", "-b", "main", work)
    sh("git", "submodule", "add", "-q", kit, "vendor/my-skills", cwd=work)
    os.makedirs(os.path.join(work, ".claude"))
    os.makedirs(os.path.join(work, "docs"))
    open(os.path.join(work, "docs", "a.txt"), "w").write("one\n")
    open(os.path.join(work, "docs", "b.txt"), "w").write("two\n")
    os.symlink("../vendor/my-skills/kit/settings.json", os.path.join(work, ".claude", "settings.json"))
    json.dump(cfg or {"agents": NAMES}, open(os.path.join(work, ".claude", "factory.json"), "w"))
    sh("git", "add", "-A", cwd=work)
    sh("git", "commit", "-qm", "project", cwd=work)
    sh("git", "clone", "-q", "--bare", work, origin)
    clone = os.path.join(top, "proj")
    sh("git", "clone", "-q", "--recurse-submodules", origin, clone)
    return clone


def machine(clone, extra=None, tmux=True):
    """The environment of a machine: fake tools first on PATH, and its own HOME, config and state folders. With
    tmux=False the PATH holds only the fakes and the few real tools the scripts need, so there is no tmux at all."""
    top = os.path.dirname(clone)
    bin_, log = os.path.join(top, "bin"), os.path.join(top, "log")
    os.makedirs(bin_, exist_ok=True)
    os.makedirs(log, exist_ok=True)
    fakes = [("docker", FAKE_DOCKER), ("systemctl", FAKE_SYSTEMCTL), ("loginctl", FAKE_LOGINCTL),
             ("launchctl", FAKE_LAUNCHCTL), ("plutil", FAKE_PLUTIL), ("claude", "#!/bin/sh\necho claude\n")]
    if tmux:
        fakes.append(("tmux", FAKE_TMUX))
    for name, body in fakes:
        path = os.path.join(bin_, name)
        open(path, "w").write(body)
        os.chmod(path, 0o755)
    path_var = bin_ + os.pathsep + os.environ["PATH"]
    if not tmux:
        for tool in ("git", "python3", "bash", "sh", "env", "sleep", "hostname", "cat", "uname"):
            real = shutil.which(tool)
            if real and not os.path.exists(os.path.join(bin_, tool)):
                os.symlink(real, os.path.join(bin_, tool))
        path_var = bin_
    env = {**os.environ, **GIT, "PATH": path_var, "HOME": os.path.join(top, "home"),
           "FACTORY_CONFIG_DIR": os.path.join(top, "config"), "XDG_STATE_HOME": os.path.join(top, "state"),
           "XDG_CONFIG_HOME": os.path.join(top, "home", ".config"), "XDG_RUNTIME_DIR": os.path.join(top, "run"),
           "FAKE_LOG": log, "FAKE_TMUX": os.path.join(top, "tmux"), "FAKE_SYSTEMD": os.path.join(top, "systemd"),
           "FACTORY_AUTOSTART_PLATFORM": "linux", "FACTORY_MACHINE_ID": "aaaa1111",
           "FACTORY_RESUME_WAIT": "3", "FACTORY_RESUME_POLL": "0.1"}
    for k in ("FACTORY_AGENT", "FACTORY_AGENTS", "FACTORY_LOOP", "CLAUDE_PROJECT_DIR", "CLAUDECODE",
              "DOCKER_HOST", "FACTORY_CI_PLATFORM"):
        env.pop(k, None)
    os.makedirs(env["XDG_RUNTIME_DIR"], exist_ok=True)
    env.update(extra or {})
    return env


def machine_file(env, **data):
    os.makedirs(env["FACTORY_CONFIG_DIR"], exist_ok=True)
    json.dump(data, open(os.path.join(env["FACTORY_CONFIG_DIR"], "proj.json"), "w"))


def state(env, *parts):
    return os.path.join(env["XDG_STATE_HOME"], "proj-factory", *parts)


def py(script, clone, env, *args):
    return subprocess.run([sys.executable, script, *args], cwd=clone, env=env, capture_output=True, text=True,
                          timeout=120)


def log(env, name):
    try:
        return open(os.path.join(env["FAKE_LOG"], name + ".log")).read()
    except FileNotFoundError:
        return ""


def sessions(env):
    d = env["FAKE_TMUX"]
    return sorted(f for f in os.listdir(d) if not f.endswith(".dir")) if os.path.isdir(d) else []


def boot_log(env):
    try:
        return open(state(env, "boot.log")).read()
    except FileNotFoundError:
        return ""


def write_config(clone, env, with_stack=True, **extra):
    stack = os.path.join(env["FAKE_LOG"], "stack.log")
    cfg = {"agents": NAMES, **extra}
    if with_stack:
        cfg["commands"] = {"stackUp": f"echo up >>{stack}", "stackHealth": f"test -s {stack}"}
    json.dump(cfg, open(os.path.join(clone, ".claude", "factory.json"), "w"))


def worktree_of(clone, env, name):
    p = py(CLAIMS, clone, env, "worktree", name)
    assert p.returncode == 0, p
    return p.stdout.strip().splitlines()[-1]


def unfinished_work(clone, env, name="haile"):
    """A worktree like the one in the issue: on task/412-manual-page with one unpushed commit, a modified file and
    an untracked one. Returns its path."""
    wt = worktree_of(clone, env, name)
    sh("git", "checkout", "-q", "-b", "task/412-manual-page", cwd=wt)
    open(os.path.join(wt, "docs", "a.txt"), "w").write("one\nsaved in a commit\n")
    sh("git", "commit", "-qam", "Add the manual page intro", cwd=wt)
    open(os.path.join(wt, "docs", "a.txt"), "a").write("half-written line\n")
    open(os.path.join(wt, "docs", "b.txt"), "a").write("more\n")
    open(os.path.join(wt, "docs", "new.txt"), "w").write("not added yet\n")
    return wt


def porcelain(wt):
    return sh("git", "status", "--porcelain", cwd=wt).stdout


# --- status and the machine's own settings -------------------------------------------------------------------------

def test_status_shows_what_would_start_without_starting_anything():
    clone = project()
    env = machine(clone)
    machine_file(env, autostart=True, autostartAgents=["haile", "tewodros"])
    write_config(clone, env)
    p = py(AUTOSTART, clone, env, "status")
    assert p.returncode == 0, p
    out = p.stdout
    assert "autostart: on" in out and "haile" in out and "tewodros" in out, out
    assert "menelik" not in out and "taytu" not in out, out  # not this machine's
    assert "echo up" in out, out  # the stack command it would run
    assert "not installed" in out, out
    assert sessions(env) == [] and not os.path.exists(os.path.join(clone + "-agents", "haile")), "status changed things"


def test_status_describes_unfinished_work_and_a_running_session():
    clone = project()
    env = machine(clone)
    machine_file(env, autostart=True, autostartAgents=["haile"])
    unfinished_work(clone, env)
    os.makedirs(env["FAKE_TMUX"], exist_ok=True)
    open(os.path.join(env["FAKE_TMUX"], "proj-haile"), "w").write("x\n")
    out = py(AUTOSTART, clone, env, "status").stdout
    assert "task/412-manual-page" in out and "uncommitted" in out and "unpushed" in out, out
    assert "backup" in out and "running" in out, out


def test_status_off_says_how_to_turn_it_on():
    clone = project()
    env = machine(clone)
    out = py(AUTOSTART, clone, env, "status").stdout
    assert "autostart: off" in out and "factory autostart install" in out, out


def test_machine_setup_keeps_the_autostart_settings():
    clone = project()
    env = machine(clone)
    machine_file(env, autostart=True, autostartAgents=["haile"], agents=["menelik"])
    p = py(MACHINE, clone, env, "setup", "haile,tewodros")
    assert p.returncode == 0, p
    data = json.load(open(os.path.join(env["FACTORY_CONFIG_DIR"], "proj.json")))
    assert data == {"agents": ["haile", "tewodros"], "autostart": True, "autostartAgents": ["haile"]}, data


# --- install and uninstall -----------------------------------------------------------------------------------------

def test_install_on_linux_writes_a_user_unit_enables_it_and_turns_linger_on():
    clone = project()
    env = machine(clone)
    p = py(AUTOSTART, clone, env, "install", "--agents", "haile,tewodros")
    assert p.returncode == 0, p
    unit = os.path.join(env["XDG_CONFIG_HOME"], "systemd", "user", "proj-factory-resume.service")
    text = open(unit).read()
    assert "Type=oneshot" in text and "RemainAfterExit=yes" in text, text
    assert "KillMode=process" in text, text  # the tmux sessions must outlive the oneshot
    assert re.search(r'^ExecStart=.*/factory"? resume$', text, re.M), text
    assert f"WorkingDirectory={clone}" in text and "WantedBy=default.target" in text, text
    assert "TimeoutStartSec=" in text, text
    sc = log(env, "systemctl")
    assert "--user daemon-reload" in sc and "--user enable proj-factory-resume.service" in sc, sc
    assert "enable-linger" in log(env, "loginctl"), log(env, "loginctl")
    data = json.load(open(os.path.join(env["FACTORY_CONFIG_DIR"], "proj.json")))
    assert data["autostart"] is True and data["autostartAgents"] == ["haile", "tewodros"], data
    assert "Note: linger" not in p.stdout, p.stdout
    status = py(AUTOSTART, clone, env, "status").stdout
    assert "installed" in status and "not installed" not in status, status


def test_install_says_how_to_turn_linger_on_when_it_may_not():
    clone = project()
    env = machine(clone, extra={"FAKE_LINGER_DENIED": "1"})
    p = py(AUTOSTART, clone, env, "install", "--agents", "haile")
    assert p.returncode == 0, p
    assert "sudo loginctl enable-linger" in p.stdout, p.stdout


def test_install_refuses_a_name_that_is_not_an_agent_and_changes_nothing():
    clone = project()
    env = machine(clone)
    p = py(AUTOSTART, clone, env, "install", "--agents", "nobody")
    assert p.returncode == 1, p
    err = json.loads(p.stderr.strip().splitlines()[-1])
    assert err["code"] == "unknown-agent" and "nobody" in err["message"] and err["fix"], err
    assert not os.path.exists(os.path.join(env["XDG_CONFIG_HOME"], "systemd")), "wrote a unit"
    assert not os.path.exists(os.path.join(env["FACTORY_CONFIG_DIR"], "proj.json"))


def test_install_without_a_user_manager_stops_before_changing_anything():
    clone = project()
    env = machine(clone, extra={"FAKE_NO_BUS": "1"})
    p = py(AUTOSTART, clone, env, "install", "--agents", "haile")
    assert p.returncode == 1, p
    err = json.loads(p.stderr.strip().splitlines()[-1])
    assert err["code"] == "no-user-manager" and "linger" in err["fix"], err
    assert not os.path.exists(os.path.join(env["FACTORY_CONFIG_DIR"], "proj.json"))


def test_install_without_tmux_says_to_install_it():
    clone = project()
    env = machine(clone, tmux=False)
    p = py(AUTOSTART, clone, env, "install", "--agents", "haile")
    assert p.returncode == 1, p
    err = json.loads(p.stderr.strip().splitlines()[-1])
    assert err["code"] == "no-tmux" and "install tmux" in err["fix"], err
    assert not os.path.exists(os.path.join(env["FACTORY_CONFIG_DIR"], "proj.json"))


def test_install_on_macos_writes_a_launch_agent_and_loads_it():
    clone = project()
    env = machine(clone, extra={"FACTORY_AUTOSTART_PLATFORM": "mac"})
    p = py(AUTOSTART, clone, env, "install", "--agents", "haile")
    assert p.returncode == 0, p
    plist = os.path.join(env["HOME"], "Library", "LaunchAgents", "dev.software-factory.proj-resume.plist")
    data = plistlib.load(open(plist, "rb"))
    assert data["Label"] == "dev.software-factory.proj-resume", data
    assert data["ProgramArguments"][-2:] == [os.path.join(clone, "factory"), "resume"], data
    assert data["RunAtLoad"] is True and data["WorkingDirectory"] == clone, data
    assert not data.get("KeepAlive"), data  # it resumes once per boot, it isn't a daemon
    assert data["AbandonProcessGroup"] is True, data  # the tmux sessions must outlive the job
    assert "bootstrap" in log(env, "launchctl"), log(env, "launchctl")
    assert log(env, "loginctl") == "" and log(env, "systemctl") == ""
    assert "installed" in py(AUTOSTART, clone, env, "status").stdout
    p = py(AUTOSTART, clone, env, "uninstall")
    assert p.returncode == 0 and not os.path.exists(plist), p
    assert "bootout" in log(env, "launchctl")


def test_uninstall_removes_the_unit_turns_autostart_off_and_leaves_agents_running():
    clone = project()
    env = machine(clone)
    py(AUTOSTART, clone, env, "install", "--agents", "haile")
    os.makedirs(env["FAKE_TMUX"], exist_ok=True)
    open(os.path.join(env["FAKE_TMUX"], "proj-haile"), "w").write("x\n")
    p = py(AUTOSTART, clone, env, "uninstall")
    assert p.returncode == 0, p
    unit = os.path.join(env["XDG_CONFIG_HOME"], "systemd", "user", "proj-factory-resume.service")
    assert not os.path.exists(unit), "unit left behind"
    assert "disable --now proj-factory-resume.service" in log(env, "systemctl"), log(env, "systemctl")
    data = json.load(open(os.path.join(env["FACTORY_CONFIG_DIR"], "proj.json")))
    assert data["autostart"] is False and data["autostartAgents"] == ["haile"], data
    assert sessions(env) == ["proj-haile"], "uninstall must not stop running agents"
    assert "kill" not in log(env, "tmux")


# --- resume: the boot step -----------------------------------------------------------------------------------------

def test_resume_waits_for_docker_starts_the_stack_then_the_agents_in_detached_sessions():
    clone = project()
    env = machine(clone, extra={"FAKE_DOCKER_FAILS": "3"})
    write_config(clone, env)
    machine_file(env, autostart=True, autostartAgents=["haile", "tewodros"])
    p = py(RESUME, clone, env)
    assert p.returncode == 0, (p.stdout, p.stderr)
    assert log(env, "docker").count("info") >= 4, log(env, "docker")  # it asked until Docker answered
    assert open(os.path.join(env["FAKE_LOG"], "stack.log")).read().strip() == "up"
    assert sessions(env) == ["proj-haile", "proj-tewodros"], sessions(env)
    calls = log(env, "tmux")
    assert "new-session -d -s proj-haile" in calls and "new-session -d -s proj-tewodros" in calls, calls
    cmd = open(os.path.join(env["FAKE_TMUX"], "proj-haile")).read()
    assert "FACTORY_AGENTS=haile" in cmd and "loop -i" in cmd and os.path.join(clone, "factory") in cmd, cmd
    assert "FACTORY_RESUME" not in cmd, "a clean agent starts normally"
    for name in ("haile", "tewodros"):  # each in its own worktree, with the settings resolving
        wt = clone + "-agents/" + name
        assert os.path.exists(os.path.join(wt, ".claude", "settings.json")), wt
    out = boot_log(env)
    assert re.search(r"stack: up", out), out
    for name in ("haile", "tewodros"):
        assert re.search(rf"agent {name}: started", out), out
    assert "stack: up" in p.stdout and "agent haile: started" in p.stdout, p.stdout
    assert not os.path.exists(state(env, "backups")), "nothing to back up"


def test_a_second_resume_leaves_running_sessions_alone():
    clone = project()
    env = machine(clone)
    machine_file(env, autostart=True, autostartAgents=["haile"])
    assert py(RESUME, clone, env).returncode == 0
    assert log(env, "tmux").count("new-session") == 1
    p = py(RESUME, clone, env)
    assert p.returncode == 0, p
    assert log(env, "tmux").count("new-session") == 1, log(env, "tmux")
    assert "agent haile: already running" in p.stdout, p.stdout


def test_resume_with_autostart_off_does_nothing_unless_forced():
    clone = project()
    env = machine(clone)
    machine_file(env, autostart=False, autostartAgents=["haile"])
    p = py(RESUME, clone, env)
    assert p.returncode == 0 and "autostart is off" in p.stdout, p
    assert sessions(env) == []
    p = py(RESUME, clone, env, "--force")
    assert p.returncode == 0 and sessions(env) == ["proj-haile"], (p, sessions(env))


def test_resume_dry_run_starts_nothing():
    clone = project()
    env = machine(clone)
    write_config(clone, env)
    machine_file(env, autostart=True, autostartAgents=["haile"])
    p = py(RESUME, clone, env, "--dry-run")
    assert p.returncode == 0, p
    assert sessions(env) == [] and log(env, "docker") == "", "a dry run must not touch anything"
    assert not os.path.exists(os.path.join(env["FAKE_LOG"], "stack.log"))
    assert "would" in p.stdout and "haile" in p.stdout, p.stdout


def test_unfinished_work_is_backed_up_left_in_place_and_the_agent_is_told():
    clone = project()
    env = machine(clone)
    machine_file(env, autostart=True, autostartAgents=["haile"])
    wt = unfinished_work(clone, env)
    before = porcelain(wt)
    head = sh("git", "rev-parse", "HEAD", cwd=wt).stdout
    p = py(RESUME, clone, env)
    assert p.returncode == 0, (p.stdout, p.stderr)
    # nothing reset, cleaned or switched
    assert porcelain(wt) == before and sh("git", "rev-parse", "HEAD", cwd=wt).stdout == head
    assert sh("git", "branch", "--show-current", cwd=wt).stdout.strip() == "task/412-manual-page"
    assert open(os.path.join(wt, "docs", "new.txt")).read() == "not added yet\n"
    # one backup, named for the agent, the branch and the time
    root = state(env, "backups")
    found = os.listdir(root)
    assert len(found) == 1 and re.fullmatch(r"haile-task-412-manual-page-\d{8}-\d{6}", found[0]), found
    b = os.path.join(root, found[0])
    patch = open(os.path.join(b, "changes.patch")).read()
    assert "half-written line" in patch and "+more" in patch, patch
    status = open(os.path.join(b, "status.txt")).read()
    assert "docs/a.txt" in status and "docs/new.txt" in status, status
    assert "Add the manual page intro" in open(os.path.join(b, "unpushed.txt")).read()
    assert open(os.path.join(b, "untracked", "docs", "new.txt")).read() == "not added yet\n"
    # the session is started so the loop leaves the folder alone, and the first prompt says what happened
    cmd = open(os.path.join(env["FAKE_TMUX"], "proj-haile")).read()
    assert "FACTORY_RESUME=1" in cmd and "FACTORY_RESUME_NOTE=" in cmd, cmd
    note_path = re.search(r"FACTORY_RESUME_NOTE=(\S+)", cmd).group(1).strip("'\"")
    note = open(note_path).read()
    assert "unexpected restart" in note and "task/412-manual-page" in note, note
    assert "docs/a.txt" in note and "docs/b.txt" in note and b in note, note
    assert "own in-progress" in note, note  # resume, don't start something new
    out = boot_log(env)
    assert re.search(r"backup haile: .*" + re.escape(b), out), out
    assert re.search(r"agent haile: started .*resuming", out), out


def test_a_clean_worktree_gets_no_backup_and_no_note():
    clone = project()
    env = machine(clone)
    machine_file(env, autostart=True, autostartAgents=["haile"])
    worktree_of(clone, env, "haile")
    assert py(RESUME, clone, env).returncode == 0
    assert not os.path.exists(state(env, "backups")) or os.listdir(state(env, "backups")) == []


def test_an_agent_whose_settings_do_not_resolve_is_not_started():
    clone = project()
    env = machine(clone)
    machine_file(env, autostart=True, autostartAgents=["haile", "tewodros"])
    wt = clone + "-agents/haile"
    sh("git", "worktree", "add", "-q", "--detach", wt, "origin/main", cwd=clone)  # by hand: no submodule
    os.rename(os.path.join(wt, ".gitmodules"), os.path.join(wt, ".gitmodules.off"))
    p = py(RESUME, clone, env)
    assert p.returncode == 1, (p.stdout, p.stderr)
    assert sessions(env) == ["proj-tewodros"], sessions(env)  # the other agent is not held back
    out = boot_log(env)
    assert re.search(r"agent haile: NOT started.*settings\.json", out), out
    assert "git submodule update --init" in out, out
    assert re.search(r"agent tewodros: started", out), out


def test_without_network_the_stack_still_starts_but_no_agent_does():
    clone = project()
    env = machine(clone, extra={"FACTORY_RESUME_WAIT": "1"})
    write_config(clone, env)
    machine_file(env, autostart=True, autostartAgents=["haile"])
    sh("git", "remote", "set-url", "origin", "/nonexistent/origin.git", cwd=clone)
    p = py(RESUME, clone, env)
    assert p.returncode == 1, p
    assert os.path.exists(os.path.join(env["FAKE_LOG"], "stack.log"))
    assert sessions(env) == []
    assert re.search(r"agent haile: NOT started.*network", boot_log(env)), boot_log(env)


def test_a_stack_that_fails_is_reported_and_the_agents_still_start():
    clone = project()
    env = machine(clone)
    json.dump({"agents": NAMES, "commands": {"stackUp": "echo no database >&2; exit 7"}},
              open(os.path.join(clone, ".claude", "factory.json"), "w"))
    machine_file(env, autostart=True, autostartAgents=["haile"])
    p = py(RESUME, clone, env)
    assert p.returncode == 1, p
    assert re.search(r"stack: .*failed.*7.*no database", boot_log(env)), boot_log(env)
    assert sessions(env) == ["proj-haile"], sessions(env)


def test_environment_file_values_reach_the_agents():
    clone = project()
    env = machine(clone)
    machine_file(env, autostart=True, autostartAgents=["haile"])
    open(os.path.join(env["FACTORY_CONFIG_DIR"], "proj.env"), "w").write("# keys\nSOPS_AGE_KEY_FILE=/home/x/age.txt\n")
    assert py(RESUME, clone, env).returncode == 0
    assert "SOPS_AGE_KEY_FILE" in open(os.path.join(env["FAKE_TMUX"], "proj-haile")).read()


def issues_project():
    clone = project({"agents": NAMES, "tasks": {"source": "issues"}})
    env = machine(clone)
    gh = os.path.join(env["PATH"].split(os.pathsep)[0], "gh")
    open(gh, "w").write(T.FAKE_GH)
    os.chmod(gh, 0o755)
    db = os.path.join(os.path.dirname(clone), "db.json")
    marker = "<!-- factory-agent name=haile status=down ping=2026-10-24T20:16:00Z machine=aaaa1111 -->"
    agent_issue = {**T.issue(7, labels=("factory:agent", "factory:agent-down")), "title": "Agent: haile · down",
                   "body": marker + "\n**Status:** down\n**Last ping:** 2026-10-24T20:16:00Z\n**Started:** x\n**Where:** slot 3"}
    task = T.issue(412, labels=("factory:in-progress", "agent:haile"))
    json.dump({"issues": [agent_issue, task]}, open(db, "w"))
    env["FAKE_GH_DB"] = db
    return clone, env, db


def test_issues_mode_marks_the_agent_working_on_its_issue_and_posts_the_boot_report():
    clone, env, db = issues_project()
    machine_file(env, autostart=True, autostartAgents=["haile"])
    p = py(RESUME, clone, env)
    assert p.returncode == 0, (p.stdout, p.stderr)
    data = json.load(open(db))
    agent_issue = next(i for i in data["issues"] if i["number"] == 7)
    assert "status=working" in agent_issue["body"] and "#412" in agent_issue["title"], agent_issue
    assert "factory:agent-down" not in [l["name"] for l in agent_issue["labels"]], agent_issue["labels"]
    comments = [c["body"] for c in data.get("comments", {}).get("7", [])]
    assert len(comments) == 1 and "rebooted" in comments[0] and "agent haile: started" in comments[0], comments
    assert "aaaa1111" in comments[0], comments  # which machine
    assert "registered haile as working on #412" in boot_log(env), boot_log(env)


def test_the_boot_report_post_can_be_turned_off_and_never_breaks_a_resume():
    clone, env, db = issues_project()
    machine_file(env, autostart=True, autostartAgents=["haile"], autostartReport=False)
    assert py(RESUME, clone, env).returncode == 0
    assert not json.load(open(db)).get("comments"), "posted although autostartReport is false"
    # and a GitHub that refuses everything is only lines in the log
    clone, env, db = issues_project()
    machine_file(env, autostart=True, autostartAgents=["haile"])
    gh = os.path.join(env["PATH"].split(os.pathsep)[0], "gh")
    open(gh, "w").write("#!/bin/sh\necho 'HTTP 403' >&2\nexit 1\n")
    p = py(RESUME, clone, env)
    assert p.returncode == 0 and sessions(env) == ["proj-haile"], (p.stdout, p.stderr)
    assert "GitHub" in boot_log(env), boot_log(env)


# --- the loop: resuming never moves a worktree off its work -------------------------------------------------------

STUB = r'''#!/usr/bin/env python3
import os, sys
name = os.path.basename(__file__)
open(os.environ["LOOP_LOG"], "a").write(f"{name} {' '.join(sys.argv[1:])}\n")
if name == "factory_claims.py" and sys.argv[1:2] == ["checkout"]:
    print("haile", os.environ["LOOP_WT"])
if name == "next_task.py":
    state = os.environ["LOOP_STATE"]
    n = int(open(state).read()) if os.path.exists(state) else 0
    open(state, "w").write(str(n + 1))
    if n == 0:
        print("issue-412 Manual page")
        sys.exit(0)
    sys.exit(1)
'''


def loop_setup(resume):
    d = tempfile.mkdtemp()
    origin, work, bin_ = (os.path.join(d, x) for x in ("origin.git", "work", "bin"))
    sh("git", "init", "-q", "--bare", "-b", "main", origin)
    sh("git", "clone", "-q", origin, work)
    hooks = os.path.join(work, ".claude", "hooks")
    os.makedirs(hooks)
    for name in ("factory_claims.py", "factory_env.py", "factory_agents.py", "next_task.py", "factory_remote.py"):
        open(os.path.join(hooks, name), "w").write(STUB)
    open(os.path.join(work, ".claude", "factory.json"), "w").write('{"waitMinutes": 0}')
    os.makedirs(os.path.join(work, "docs"))
    open(os.path.join(work, "docs", "a.txt"), "w").write("one\n")
    open(os.path.join(work, "factory-loop.sh"), "w").write(open(LOOP).read())
    sh("git", "add", "-A", cwd=work)
    sh("git", "commit", "-qm", "start", cwd=work)
    sh("git", "push", "-q", "origin", "HEAD:main", cwd=work)
    wt = os.path.join(d, "work-agents", "haile")
    sh("git", "worktree", "add", "-q", "--detach", wt, "origin/main", cwd=work)
    sh("git", "checkout", "-q", "-b", "task/412-manual-page", cwd=wt)
    open(os.path.join(wt, "docs", "a.txt"), "a").write("half-written line\n")
    os.makedirs(bin_)
    open(os.path.join(bin_, "claude"), "w").write('#!/usr/bin/env bash\nprintf "claude %s\\n" "$*" >>"$LOOP_LOG"\n')
    os.chmod(os.path.join(bin_, "claude"), 0o755)
    note = os.path.join(d, "resume-haile.md")
    open(note, "w").write("You are resuming after an unexpected restart of this machine. Branch task/412-manual-page.\n")
    env = {**os.environ, **GIT, "PATH": f"{bin_}:{os.environ['PATH']}", "LOOP_LOG": os.path.join(d, "log"),
           "LOOP_STATE": os.path.join(d, "state"), "LOOP_WT": wt, "FACTORY_REMOTE_CONTROL": "0"}
    for k in ("FACTORY_AGENT", "FACTORY_RELOAD_AGENT", "FACTORY_RELOAD_DIR", "FACTORY_RESUME", "FACTORY_RESUME_NOTE"):
        env.pop(k, None)
    if resume:
        env.update({"FACTORY_RESUME": "1", "FACTORY_RESUME_NOTE": note})
    return d, work, wt, note, env


def test_a_resumed_loop_keeps_the_branch_and_the_changes_and_puts_the_note_in_the_first_prompt():
    d, work, wt, note, env = loop_setup(resume=True)
    p = subprocess.run(["bash", "./factory-loop.sh", "-i", "1"], cwd=work, env=env, capture_output=True, text=True,
                       timeout=60, stdin=subprocess.DEVNULL)
    assert p.returncode == 0, (p.stdout, p.stderr)
    assert sh("git", "branch", "--show-current", cwd=wt).stdout.strip() == "task/412-manual-page"
    assert "half-written line" in open(os.path.join(wt, "docs", "a.txt")).read()
    log_text = open(env["LOOP_LOG"]).read()
    claude = [l for l in log_text.splitlines() if l.startswith("claude")]
    assert len(claude) == 1 and "/next-task issue-412" in claude[0], claude
    assert "unexpected restart" in log_text and "task/412-manual-page" in log_text, log_text
    assert not os.path.exists(note), "the note is used once"
    assert "resuming" in p.stdout, p.stdout


def test_a_loop_that_is_not_resuming_still_moves_to_main_as_before():
    d, work, wt, note, env = loop_setup(resume=False)
    sh("git", "checkout", "--", ".", cwd=wt)  # clean, so the checkout can happen
    subprocess.run(["bash", "./factory-loop.sh", "-i", "1"], cwd=work, env=env, capture_output=True, text=True,
                   timeout=60, stdin=subprocess.DEVNULL)
    assert sh("git", "branch", "--show-current", cwd=wt).stdout.strip() == "", "expected a detached main"
    assert "unexpected restart" not in open(env["LOOP_LOG"]).read()


# --- help, doctor, settings -----------------------------------------------------------------------------------------

def test_help_doctor_and_settings_know_about_autostart():
    d = D.project()
    env = D.machine(extra=("tmux",))
    out = subprocess.run(["bash", FACTORY, "help"], cwd=d, env=env, capture_output=True, text=True).stdout
    assert "autostart" in out and "resume" in out, out
    # off: a note that says how to turn it on
    p = D.doctor(d, env)
    assert any("autostart" in l and "factory autostart install" in l for l in D.lines(p, "note")), p.stdout
    # on, but no tmux and no service: fixes that say what to do
    cfg = tempfile.mkdtemp()
    json.dump({"autostart": True, "autostartAgents": ["menelik"]},
              open(os.path.join(cfg, os.path.basename(d) + ".json"), "w"))
    env = {**D.machine(), "FACTORY_CONFIG_DIR": cfg, "FACTORY_AUTOSTART_PLATFORM": "linux"}
    p = D.doctor(d, env)
    fixes = "\n".join(D.lines(p, "fix"))
    assert "tmux" in fixes and "factory autostart install" in fixes, p.stdout
    # settings lists the stack commands and this machine's autostart
    senv = {**os.environ, "FACTORY_CONFIG_DIR": cfg}
    out = subprocess.run(["bash", FACTORY, "settings"], cwd=d, env=senv, capture_output=True, text=True).stdout
    assert "commands.stackUp" in out and "commands.stackHealth" in out, out
    assert "autostart" in out and "autostartAgents" in out, out
    shown = subprocess.run(["bash", FACTORY, "settings", "show", "commands.stackUp"], cwd=d, env=senv,
                           capture_output=True, text=True)
    assert shown.returncode == 0 and "stack" in shown.stdout.lower(), shown


def test_agents_cannot_install_or_run_autostart():
    deny = json.load(open(os.path.join(SF, "kit", ".claude", "settings.json")))["permissions"]["deny"]
    for rule in ("Bash(factory autostart install*)", "Bash(factory autostart uninstall*)", "Bash(./factory autostart install*)",
                 "Bash(*factory_autostart*)", "Bash(factory resume*)", "Bash(./factory resume*)", "Bash(*factory_resume*)"):
        assert rule in deny, rule


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
