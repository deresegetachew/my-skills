#!/usr/bin/env python3
"""`factory ci`: names from the project, the LaunchAgent it writes, `use local|github`, `status` in both modes, and
`stop` never killing a process that isn't its loop.  python3 software-factory/tests/test_ci.py

gh, launchctl, plutil, docker and scutil are fakes on PATH, and HOME is a temp folder, so nothing touches the real
Mac or GitHub. What launchd and macOS show (Login Items, Activity Monitor) can't be tested here."""
import json, os, plistlib, stat, subprocess, tempfile, time
from datetime import datetime, timedelta, timezone

KIT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "kit"))
SF = os.path.dirname(os.path.abspath(KIT))
CI = os.path.join(SF, "ci", "ci.sh")

# db: {"repo": "acme/Widget" | None, "vars": {...}, "api": {path: json}, "fail": [paths]}. --jq runs real jq.
FAKE_GH = r'''#!/usr/bin/env python3
import json, os, subprocess, sys
from urllib.parse import urlparse
f = os.environ["FAKE_DB"]; db = json.load(open(f)); a = sys.argv[1:]
open(f + ".gh.log", "a").write(json.dumps(a) + "\n")
def save(): json.dump(db, open(f, "w"))
if a[:2] == ["repo", "view"]:
    if not db.get("repo"): sys.exit("not a github repo")
    print(db["repo"]); sys.exit(0)
if a[:1] == ["variable"]:
    name = a[2]
    if a[1] == "set": db.setdefault("vars", {})[name] = a[a.index("--body") + 1]; save(); sys.exit(0)
    if a[1] == "delete":
        if db.get("no_delete"): sys.exit("HTTP 403: Resource not accessible")
        db.get("vars", {}).pop(name, None); save(); sys.exit(0)
if a[:1] != ["api"]: sys.exit("fake gh: no answer for %s" % a)
method, jq, path, k, rest = "GET", None, None, 0, a[1:]
while k < len(rest):
    if rest[k] == "-X": method = rest[k + 1]; k += 2
    elif rest[k] == "--jq": jq = rest[k + 1]; k += 2
    elif rest[k] in ("-H", "-f", "-F", "--input"): k += 2
    elif rest[k].startswith("-"): k += 1
    else: path = rest[k]; k += 1
p = urlparse(path).path
if p in db.get("fail", []): sys.exit("HTTP 403: Resource not accessible")
var = p.rsplit("/", 1)[1] if "/actions/variables/" in p else None
if var is not None:
    if var not in db.get("vars", {}): sys.stderr.write("gh: Not Found (HTTP 404)\n"); sys.exit(1)
    data = {"name": var, "value": db["vars"][var]}
elif p.endswith("/registration-token") and method == "POST":
    if not db.get("can_register", True): sys.exit("HTTP 403")
    data = {"token": "fresh-token"}
elif method == "DELETE":
    db.setdefault("deleted", []).append(p.rsplit("/", 1)[1]); save(); sys.exit(0)
elif p in db.get("api", {}):
    data = db["api"][p]
else:
    sys.exit("fake gh: no answer for " + p)
if jq:
    sys.stdout.write(subprocess.run(["jq", "-r", jq], input=json.dumps(data), capture_output=True, text=True,
                                    check=True).stdout)
else:
    print(json.dumps(data))
'''

# Loaded agents are files in $FAKE_LAUNCHD/<label>; print shows a pid when the file holds one.
FAKE_LAUNCHCTL = r'''#!/usr/bin/env bash
echo "$*" >>"$FAKE_DB.launchctl.log"
d="$FAKE_LAUNCHD"; mkdir -p "$d"
case "$1" in
  print) l="${2##*/}"; [ -f "$d/$l" ] || exit 113; echo "$l = {"; [ -s "$d/$l" ] && echo "	pid = $(cat "$d/$l")"; echo "}" ;;
  bootout) l="${2##*/}"; [ -f "$d/$l" ] || exit 3; rm -f "$d/$l" ;;
  bootstrap) l="$(basename "$3" .plist)"; echo 4242 >"$d/$l" ;;
esac
'''

FAKE_PLUTIL = r'''#!/usr/bin/env python3
import plistlib, sys
plistlib.load(open(sys.argv[2], "rb"))
'''

FAKE_DOCKER = r'''#!/usr/bin/env bash
echo "$*" >>"$FAKE_DB.docker.log"
[ "${FAKE_DOCKER_UP:-1}" = 1 ] || exit 1
case " $* " in
  *" build "*) [ -z "${FAKE_DOCKER_BUILD_FAILS:-}" ] || exit 1 ;;
  *" info "*"MemTotal"*) [ -n "${FAKE_DOCKER_MEMTOTAL:-}" ] && echo "$FAKE_DOCKER_MEMTOTAL"; exit 0 ;;
  *" image inspect "*) [ -n "${FAKE_DOCKER_IMAGE_LABELS:-}" ] || exit 1; echo "$FAKE_DOCKER_IMAGE_LABELS"; exit 0 ;;
  *" up "*)  # one round: say whether the runner got the given token, then fail registration (code 3)
    [ "${RUNNER_TOKEN:-}" = "given-token" ] && echo "token ok" >>"$FAKE_DB.docker.log"
    echo "name $RUNNER_NAME label $RUNNER_LABEL" >>"$FAKE_DB.docker.log"
    exit 3 ;;
esac
exit 0
'''


def git(d, *a):
    return subprocess.run(["git", *a], cwd=d, capture_output=True, text=True, check=True).stdout.strip()


def project(repo="acme/Widget", ci=None, remote="git@github.com:acme/Widget.git"):
    root = tempfile.mkdtemp()
    d, home, bin_ = os.path.join(root, "work"), os.path.join(root, "home"), os.path.join(root, "bin")
    for x in (d, home, bin_):
        os.makedirs(x)
    git(d, "init", "-q", "-b", "main")
    git(d, "config", "user.email", "t@t"); git(d, "config", "user.name", "t")
    git(d, "remote", "add", "origin", remote)
    os.makedirs(os.path.join(d, ".claude"))
    json.dump({"ci": ci} if ci else {}, open(os.path.join(d, ".claude", "factory.json"), "w"))
    git(d, "add", "-A"); git(d, "commit", "-qm", "x")
    for name, body in (("gh", FAKE_GH), ("launchctl", FAKE_LAUNCHCTL), ("plutil", FAKE_PLUTIL),
                       ("docker", FAKE_DOCKER), ("scutil", "#!/bin/sh\necho Test-Mac\n")):
        open(os.path.join(bin_, name), "w").write(body)
        os.chmod(os.path.join(bin_, name), 0o755)
    db = os.path.join(root, "db.json")
    json.dump({"repo": repo, "vars": {}, "api": {}}, open(db, "w"))
    env = {**os.environ, "PATH": f"{bin_}:{os.environ['PATH']}", "HOME": home, "FAKE_DB": db,
           "FAKE_LAUNCHD": os.path.join(root, "launchd")}
    for k in ("XDG_STATE_HOME", "RUNNER_TOKEN"):
        env.pop(k, None)
    return d, db, env


def ci(d, env, *args, stdin=None):
    p = subprocess.run(["bash", CI, *args], cwd=d, env=env, capture_output=True, text=True, input=stdin, timeout=120)
    return p.returncode, p.stdout + p.stderr


def names(d, env):
    rc, out = ci(d, env, "names")
    assert rc == 0, out
    return dict(line.split("=", 1) for line in out.splitlines() if "=" in line)


def update(db, **kw):
    data = json.load(open(db)); data.update(kw); json.dump(data, open(db, "w"))


def log(db, what):
    try:
        return open(f"{db}.{what}.log").read()
    except FileNotFoundError:
        return ""


def runs_and_pulls(db, runs, pulls=(), runners=None):
    api = {"repos/acme/Widget": {"default_branch": "main"},
           "repos/acme/Widget/actions/runs": {"workflow_runs": list(runs)},
           "repos/acme/Widget/pulls": list(pulls)}
    if runners is not None:
        api["repos/acme/Widget/actions/runners"] = {"runners": runners}
    update(db, api=api)


def ago(minutes):
    t = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def run(branch, status="completed", conclusion="success", created=None, name="CI"):
    created = created or ago(10)
    return {"head_branch": branch, "status": status, "conclusion": conclusion, "created_at": created, "name": name}


# --- names -------------------------------------------------------------------------------------------------------

def test_names_come_from_the_repository():
    d, db, env = project()
    n = names(d, env)
    home = env["HOME"]
    assert n["CI_REPO"] == "acme/Widget" and n["CI_NAME"] == "widget-ci" and n["CI_LABEL"] == "widget-local", n
    assert n["CI_AGENT"] == "dev.software-factory.widget-ci", n
    assert n["CI_PLIST"] == f"{home}/Library/LaunchAgents/dev.software-factory.widget-ci.plist", n
    assert n["CI_INSTALLED"] == f"{home}/Library/Application Support/widget-ci", n
    assert n["CI_STATE"] == f"{home}/.local/state/widget-ci" and n["CI_HOST"] == "test-mac", n


def test_factory_json_names_win_and_the_repo_falls_back_to_the_remote():
    d, db, env = project(repo=None, ci={"name": "shop-runner", "label": "shop-mac"},
                         remote="https://github.com/acme/shop.git")
    n = names(d, env)
    assert (n["CI_REPO"], n["CI_NAME"], n["CI_LABEL"]) == ("acme/shop", "shop-runner", "shop-mac"), n


def test_an_unsafe_name_is_refused():
    d, db, env = project(ci={"name": "Bad Name; rm -rf"})
    rc, out = ci(d, env, "names")
    assert rc != 0 and "the name 'Bad Name; rm -rf' must be lowercase" in out, out


# --- install -----------------------------------------------------------------------------------------------------

def test_install_writes_a_launchagent_that_runs_a_private_named_copy():
    d, db, env = project(ci={"replaces": ["com.example.old-runner"]})
    old = os.path.join(env["HOME"], "Library", "LaunchAgents", "com.example.old-runner.plist")
    os.makedirs(os.path.dirname(old)); open(old, "w").write("<plist/>")
    os.makedirs(env["FAKE_LAUNCHD"]); open(os.path.join(env["FAKE_LAUNCHD"], "com.example.old-runner"), "w").write("7")
    rc, out = ci(d, env, "install")
    assert rc == 0, out
    n = names(d, env)
    pl = plistlib.load(open(n["CI_PLIST"], "rb"))
    exe = os.path.join(n["CI_INSTALLED"], "widget-ci")
    assert pl["Label"] == "dev.software-factory.widget-ci" and pl["ProgramArguments"] == [exe], pl
    assert pl["RunAtLoad"] and pl["KeepAlive"] and pl["ThrottleInterval"] == 30, pl
    e = pl["EnvironmentVariables"]
    assert (e["CI_NAME"], e["CI_LABEL"], e["RUNNER_REPO"], e["CI_HOST"]) == \
        ("widget-ci", "widget-local", "acme/Widget", "test-mac"), e
    assert all(x.startswith("/") for x in e["PATH"].split(":")), e["PATH"]
    assert not any("TOKEN" in k for k in e), e
    # The copy, not the checkout: an executable with the project's name and a bash line.
    assert open(exe).readline() == "#!/bin/bash\n" and os.stat(exe).st_mode & 0o777 == 0o700
    assert not exe.startswith(d) and os.path.isfile(os.path.join(n["CI_INSTALLED"], "compose.yaml"))
    assert stat.S_IMODE(os.stat(n["CI_INSTALLED"]).st_mode) == 0o700
    # The older agent is unloaded and its file removed; then the new one is booted out and bootstrapped.
    lc = log(db, "launchctl")
    assert "bootout gui/" in lc and "/com.example.old-runner" in lc and not os.path.exists(old), lc
    assert lc.index("/dev.software-factory.widget-ci") < lc.index("bootstrap"), lc
    assert "fresh-token" not in json.dumps(pl) and "Installed widget-ci" in out, out


def test_install_refuses_without_a_working_gh_login():
    d, db, env = project()
    update(db, can_register=False)
    rc, out = ci(d, env, "install")
    assert rc == 1 and "gh can't create a runner registration token for acme/Widget" in out, out
    assert not os.path.exists(names(d, env)["CI_PLIST"])


# --- use ---------------------------------------------------------------------------------------------------------

def test_use_local_then_github_sets_and_deletes_ci_runs_on():
    d, db, env = project()
    rc, out = ci(d, env, "use", "local")
    assert rc == 0 and json.load(open(db))["vars"]["CI_RUNS_ON"] == '["self-hosted","widget-local"]', out
    assert "No runner is running on this Mac" in out, out
    rc, out = ci(d, env, "use", "github")
    assert rc == 0 and "CI_RUNS_ON" not in json.load(open(db))["vars"] and "GitHub's runners" in out, out
    rc, out = ci(d, env, "use", "github")
    assert rc == 0 and "already runs on GitHub" in out, out
    assert ci(d, env, "use", "elsewhere")[0] == 1


# --- status ------------------------------------------------------------------------------------------------------

def test_status_in_github_mode_shows_runs_and_no_local_runner():
    d, db, env = project()
    runs_and_pulls(db, [run("main"), run("feat", conclusion="failure"), run("old")],
                   pulls=[{"number": 12, "head": {"ref": "feat"}}])
    rc, out = ci(d, env, "status")
    assert rc == 0 and "Mode: github" in out, out
    assert "main   success" in out and "#12    failure" in out and " on old" not in out, out
    assert "Runner widget-ci" not in out and "Docker" not in out, out


def test_status_in_local_mode_shows_the_agent_the_runners_and_a_stuck_queue():
    d, db, env = project()
    assert ci(d, env, "install")[0] == 0
    update(db, vars={"CI_RUNS_ON": '["self-hosted","widget-local"]'})
    runs_and_pulls(db, [run("feat", status="queued", conclusion=None, created=ago(60))],
                   pulls=[{"number": 12, "head": {"ref": "feat"}}],
                   runners=[{"name": "widget-ci-other-1", "status": "offline", "busy": False,
                             "labels": [{"name": "self-hosted"}, {"name": "widget-local"}]},
                            {"name": "someone-else", "status": "online", "busy": False, "labels": [{"name": "x"}]}])
    n = names(d, env)
    open(os.path.join(n["CI_STATE"], "runner.log"), "w").write("2026-10-22T11:59:00Z round 3: job done\n")
    rc, out = ci(d, env, "status")
    assert rc == 0 and "Mode: local" in out, out
    assert "Runner widget-ci: running (LaunchAgent dev.software-factory.widget-ci, pid 4242)" in out, out
    assert "Docker: running" in out and "widget-ci-other-1: offline" in out and "someone-else" not in out, out
    assert "#12    queued" in out and "no runner with the label widget-local is online" in out, out
    assert "round 3: job done" in out, out


def test_status_says_when_github_cant_be_read():
    d, db, env = project()
    update(db, fail=["repos/acme/Widget/actions/variables/CI_RUNS_ON", "repos/acme/Widget/actions/runs"])
    rc, out = ci(d, env, "status")
    assert rc == 0 and "Mode: unknown" in out and "can't be read right now" in out, out


# --- start and stop ----------------------------------------------------------------------------------------------

def test_stop_leaves_an_unrelated_process_with_the_saved_pid_alone():
    d, db, env = project()
    n = names(d, env)
    os.makedirs(n["CI_STATE"])
    other = subprocess.Popen(["sleep", "60"])
    try:
        open(os.path.join(n["CI_STATE"], "pid"), "w").write(str(other.pid))
        rc, out = ci(d, env, "stop")
        assert rc == 0 and other.poll() is None, out
        assert not os.path.exists(os.path.join(n["CI_STATE"], "pid"))
    finally:
        other.kill()


def test_stop_ends_its_own_loop_and_removes_only_this_macs_idle_registrations():
    d, db, env = project()
    n = names(d, env)
    exe = os.path.join(n["CI_INSTALLED"], "widget-ci")
    os.makedirs(n["CI_STATE"]); os.makedirs(n["CI_INSTALLED"])
    open(exe, "w").write("#!/bin/bash\nsleep 60 & wait\n"); os.chmod(exe, 0o700)
    loop = subprocess.Popen(["/bin/bash", exe])
    time.sleep(0.3)
    open(os.path.join(n["CI_STATE"], "pid"), "w").write(str(loop.pid))
    runner = lambda i, name, status, busy=False: {"id": i, "name": name, "status": status, "busy": busy}
    update(db, api={"repos/acme/Widget/actions/runners": {"runners": [
        runner(1, "widget-ci-test-mac-100", "online"),          # this Mac, idle: removed
        runner(2, "widget-ci-test-mac-101", "online", True),    # this Mac, busy: kept
        runner(3, "widget-ci-other-200", "online"),             # another Mac, online: kept
        runner(4, "widget-ci-other-150", "offline"),            # gone away: removed
        runner(5, "unrelated-1", "offline")]}})                 # not this project's: kept
    try:
        rc, out = ci(d, env, "stop")
        assert rc == 0 and loop.wait(timeout=10) is not None, out
        assert sorted(json.load(open(db)).get("deleted", [])) == ["1", "4"], out
        assert "down --volumes" in log(db, "docker") and "--project-name widget-ci" in log(db, "docker")
    finally:
        if loop.poll() is None:
            loop.kill()


def test_stop_refuses_while_launchd_would_restart_it():
    d, db, env = project()
    assert ci(d, env, "install")[0] == 0
    rc, out = ci(d, env, "stop")
    assert rc == 1 and "factory ci uninstall" in out, out


def test_start_gives_the_token_on_stdin_and_never_writes_it():
    d2, db2, env2 = project()
    rc, out = ci(d2, {**env2, "RUNNER_TOKEN": "given-token"}, "start")
    assert rc == 0 and "started" in out, out
    n2 = names(d2, env2)
    pid = int(open(os.path.join(n2["CI_STATE"], "pid")).read())
    for _ in range(100):
        try:
            os.kill(pid, 0); time.sleep(0.1)
        except ProcessLookupError:
            break
    dl = log(db2, "docker")
    assert "token ok" in dl and "name widget-ci-test-mac-" in dl and "label widget-local" in dl, dl
    for base, _, files in os.walk(env2["HOME"]):
        for f in files:
            assert "given-token" not in open(os.path.join(base, f), errors="ignore").read(), f
    assert "registration failed" in open(os.path.join(n2["CI_STATE"], "runner.log")).read()


# --- Linux: a systemd --user service (#62) -------------------------------------------------------------------------

# Enabled units are files in $FAKE_SYSTEMD/<unit> holding the pid; every call is logged.
FAKE_SYSTEMCTL = r'''#!/usr/bin/env bash
echo "$*" >>"$FAKE_DB.systemctl.log"
d="$FAKE_SYSTEMD"; mkdir -p "$d"
[ "$1" = "--user" ] || { echo "only --user" >&2; exit 1; }
shift
case "$1" in
  daemon-reload) ;;
  enable) [ "$2" = "--now" ] && echo 4343 >"$d/$3" || echo 4343 >"$d/$2" ;;
  disable) rm -f "$d/${3:-$2}" ;;
  is-enabled) [ -f "$d/${3:-$2}" ] ;;
  show) [ -f "$d/$2" ] && cat "$d/$2" || echo 0 ;;
esac
'''


def linux_project(linger="yes", **kw):
    d, db, env = project(**kw)
    bin_ = env["PATH"].split(":")[0]
    for name in ("launchctl", "plutil", "scutil"):
        os.remove(os.path.join(bin_, name))
    for name, body in (("systemctl", FAKE_SYSTEMCTL), ("loginctl", f"#!/bin/sh\necho {linger}\n"),
                       ("hostname", "#!/bin/sh\necho Test-Box\n")):
        open(os.path.join(bin_, name), "w").write(body)
        os.chmod(os.path.join(bin_, name), 0o755)
    root = os.path.dirname(db)
    env.update({"FACTORY_CI_PLATFORM": "linux", "FAKE_SYSTEMD": os.path.join(root, "systemd"),
                "XDG_RUNTIME_DIR": os.path.join(root, "run")})
    for k in ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "DOCKER_HOST"):
        env.pop(k, None)
    os.makedirs(env["XDG_RUNTIME_DIR"])
    return d, db, env


def unit_env(path):
    return dict(l[len("Environment=\""):-1].split("=", 1) for l in open(path).read().splitlines()
                if l.startswith("Environment="))


def test_linux_names_use_xdg_folders_and_a_user_unit():
    d, db, env = linux_project()
    n = names(d, env)
    home = env["HOME"]
    assert n["CI_INSTALLED"] == f"{home}/.local/share/widget-ci", n
    assert n["CI_UNIT"] == "widget-ci.service", n
    assert n["CI_UNIT_FILE"] == f"{home}/.config/systemd/user/widget-ci.service", n
    assert n["CI_STATE"] == f"{home}/.local/state/widget-ci" and n["CI_HOST"] == "test-box", n


def test_linux_install_writes_and_starts_a_user_service_that_runs_the_private_copy():
    d, db, env = linux_project()
    rc, out = ci(d, env, "install")
    assert rc == 0, out
    n = names(d, env)
    unit = open(n["CI_UNIT_FILE"]).read()
    exe = os.path.join(n["CI_INSTALLED"], "widget-ci")
    assert f'ExecStart=/bin/bash "{exe}"' in unit and "Restart=always" in unit and "WantedBy=default.target" in unit, unit
    e = unit_env(n["CI_UNIT_FILE"])
    assert (e["CI_NAME"], e["CI_LABEL"], e["RUNNER_REPO"], e["CI_HOST"]) == \
        ("widget-ci", "widget-local", "acme/Widget", "test-box"), e
    assert all(x.startswith("/") for x in e["PATH"].split(":")), e["PATH"]
    assert not any("TOKEN" in k for k in e) and "fresh-token" not in unit, unit
    assert open(exe).readline() == "#!/bin/bash\n" and not exe.startswith(d)
    assert stat.S_IMODE(os.stat(n["CI_INSTALLED"]).st_mode) == 0o700
    sc = log(db, "systemctl")
    assert sc.index("--user daemon-reload") < sc.index("--user enable widget-ci.service"), sc
    assert "Installed widget-ci" in out and "linger" not in out.lower(), out


def test_linux_install_says_how_to_keep_it_running_when_linger_is_off():
    d, db, env = linux_project(linger="no")
    rc, out = ci(d, env, "install")
    assert rc == 0 and "sudo loginctl enable-linger" in out, out


def test_linux_install_finds_rootless_docker():
    d, db, env = linux_project()
    open(os.path.join(env["XDG_RUNTIME_DIR"], "docker.sock"), "w").close()
    rc, out = ci(d, env, "install")
    assert rc == 0, out
    e = unit_env(names(d, env)["CI_UNIT_FILE"])
    assert e["DOCKER_HOST"] == f"unix://{env['XDG_RUNTIME_DIR']}/docker.sock", e
    d, db, env = linux_project()
    rc, out = ci(d, env, "install")
    assert "DOCKER_HOST" not in unit_env(names(d, env)["CI_UNIT_FILE"]), "no rootless socket: Docker's default"
    env["DOCKER_HOST"] = "unix:///custom/docker.sock"
    ci(d, env, "install")
    assert unit_env(names(d, env)["CI_UNIT_FILE"])["DOCKER_HOST"] == "unix:///custom/docker.sock"


def test_linux_status_stop_and_uninstall():
    d, db, env = linux_project()
    assert ci(d, env, "install")[0] == 0
    update(db, vars={"CI_RUNS_ON": '["self-hosted","widget-local"]'})
    runs_and_pulls(db, [run("main")], runners=[])
    rc, out = ci(d, env, "status")
    assert rc == 0 and "Runner widget-ci: running (systemd user service widget-ci.service, pid 4343)" in out, out
    rc, out = ci(d, env, "stop")
    assert rc == 1 and "systemd would start it again" in out, out
    n = names(d, env)
    rc, out = ci(d, env, "uninstall")
    assert rc == 0, out
    assert "--user disable --now widget-ci.service" in log(db, "systemctl"), log(db, "systemctl")
    assert not os.path.exists(n["CI_UNIT_FILE"]) and not os.path.exists(n["CI_INSTALLED"]), out
    rc, out = ci(d, env, "status")
    assert "not running on this machine" in out, out


NO_BUS = '#!/bin/sh\necho "$*" >>"$FAKE_DB.systemctl.log"\necho "Failed to connect to bus: No medium found" >&2\nexit 1\n'


def test_linux_without_a_user_manager_stops_before_touching_anything():
    # `sudo -iu ci` or `su - ci`: no session bus, so every `systemctl --user` fails (dev manager, #87).
    d, db, env = linux_project()
    open(os.path.join(env["PATH"].split(":")[0], "systemctl"), "w").write(NO_BUS)
    n = names(d, env)
    for cmd in ("install", "uninstall", "stop", "status"):
        rc, out = ci(d, env, cmd)
        assert rc != 0, (cmd, out)
        assert "user manager" in out and "machinectl shell" in out and "enable-linger" in out, (cmd, out)
        assert "XDG_RUNTIME_DIR=/run/user/" in out, (cmd, out)
        assert "Installed" not in out and "removed" not in out and "stopped" not in out, (cmd, out)
    assert not os.path.exists(n["CI_UNIT_FILE"]) and not os.path.exists(n["CI_INSTALLED"]), "nothing written"
    calls = log(db, "systemctl").splitlines()
    assert calls and all(c == "--user show-environment" for c in calls), calls


def test_linux_install_starts_the_loop_once_and_escapes_the_unit():
    d, db, env = linux_project()
    env["HOME"] = os.path.join(env["HOME"], "50%$off")  # % and $ mean something to systemd
    os.makedirs(env["HOME"])
    rc, out = ci(d, env, "install")
    assert rc == 0, out
    sc = log(db, "systemctl")
    assert "--user enable widget-ci.service" in sc and "enable --now" not in sc, sc
    assert sc.index("--user enable widget-ci.service") < sc.index("--user restart widget-ci.service"), sc
    n = names(d, env)
    unit = open(n["CI_UNIT_FILE"]).read()
    assert "network-online" not in unit, unit
    assert "/50%%$$off/.local/share/widget-ci/widget-ci\"" in unit.split("ExecStart=")[1].splitlines()[0], unit
    assert "WorkingDirectory=" + n["CI_INSTALLED"].replace("%", "%%") + "\n" in unit, unit
    assert "append:" + n["CI_STATE"].replace("%", "%%") + "/runner.log" in unit, unit


# --- several runners and the light lane (#67, #90) ------------------------------------------------------------------

def agents_dir(env):
    return os.path.join(env["HOME"], "Library", "LaunchAgents")


def plist_env(env, label):
    return plistlib.load(open(os.path.join(agents_dir(env), f"{label}.plist"), "rb"))["EnvironmentVariables"]


def test_two_runners_and_the_light_lane_get_their_own_projects_names_and_logs():
    d, db, env = project(ci={"runners": 2})
    rc, out = ci(d, env, "install")
    assert rc == 0, out
    labels = sorted(f[:-6] for f in os.listdir(agents_dir(env)))
    assert labels == ["dev.software-factory.widget-ci", "dev.software-factory.widget-ci-2",
                      "dev.software-factory.widget-ci-light"], labels
    envs = {l: plist_env(env, l) for l in labels}
    for key in ("CI_PROJECT", "CI_RUNNER_PREFIX", "CI_LOG"):
        assert len({e[key] for e in envs.values()}) == 3, (key, envs)  # nothing shared: own dind, volumes, workspace
    one, two, light = (envs[l] for l in labels)
    assert (one["CI_PROJECT"], two["CI_PROJECT"], light["CI_PROJECT"]) == ("widget-ci", "widget-ci-2", "widget-ci-light")
    assert two["CI_RUNNER_PREFIX"] == "widget-ci-test-mac.2" and light["CI_RUNNER_PREFIX"] == "widget-ci-test-mac.light"
    assert one["CI_LABEL"] == two["CI_LABEL"] == "widget-local" and light["CI_LABEL"] == "widget-light", envs
    assert one["CI_COMPOSE"] == two["CI_COMPOSE"] == "compose.yaml" and light["CI_COMPOSE"] == "compose-light.yaml"
    lc = log(db, "launchctl")
    assert lc.count("bootstrap") == 3, lc
    assert "widget-ci-2: label widget-local" in out and "widget-ci-light: label widget-light (light jobs" in out, out


def test_the_light_runner_has_no_docker_and_is_small():
    import re
    text = open(os.path.join(SF, "ci", "compose-light.yaml")).read()
    body = "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("#"))
    assert "dind" not in body and "privileged" not in body and "docker.sock" not in body, body
    assert "RUNNER_DOCKER: '0'" in body and re.search(r"mem_limit: \d+[mg]", body), body
    entry = open(os.path.join(SF, "ci", "entrypoint.sh")).read()
    assert 'if [ "${RUNNER_DOCKER:-1}" != 0 ]' in entry


def test_each_loop_runs_its_own_compose_project_and_registration_name():
    d, db, env = project(ci={"runners": 2})
    assert ci(d, env, "install")[0] == 0
    n = names(d, env)
    exe = os.path.join(n["CI_INSTALLED"], "widget-ci")
    for label in ("dev.software-factory.widget-ci-2", "dev.software-factory.widget-ci-light"):
        e = plist_env(env, label)
        # One round with a given token: the fake runner fails registration (code 3), so the loop ends.
        subprocess.run(["/bin/bash", exe], input="given-token\n", env={**env, **e, "PATH": env["PATH"]},
                       capture_output=True, text=True, timeout=60, cwd=n["CI_INSTALLED"])
    dl = log(db, "docker")
    assert "--project-name widget-ci-2 up" in dl and "name widget-ci-test-mac.2-" in dl, dl
    assert "compose-light.yaml --project-name widget-ci-light up" in dl and "label widget-light" in dl, dl
    assert "name widget-ci-test-mac.light-" in dl, dl


def test_scaling_down_removes_extra_instances_and_their_idle_registrations_but_waits_for_a_busy_one():
    d, db, env = project(ci={"runners": 3})
    assert ci(d, env, "install")[0] == 0
    runner = lambda i, name, busy=False: {"id": i, "name": name, "status": "online", "busy": busy}
    update(db, api={"repos/acme/Widget/actions/runners": {"runners": [
        runner(21, "widget-ci-test-mac.2-100"),            # instance 2, idle: removed with it
        runner(31, "widget-ci-test-mac.3-100", True),      # instance 3, busy: it stays for now
        runner(11, "widget-ci-test-mac-100")]}})           # instance 1: kept
    rc, out = ci(d, env, "install", )
    assert rc == 0, out
    rc, out = ci(d, {**env, "FACTORY_CI_RUNNERS": "1"}, "install")
    assert rc == 0, out
    labels = sorted(f[:-6] for f in os.listdir(agents_dir(env)))
    assert labels == ["dev.software-factory.widget-ci", "dev.software-factory.widget-ci-3",
                      "dev.software-factory.widget-ci-light"], labels
    assert "Instance 3 (widget-ci-3) is running a job" in out and "Removed instance 2 (widget-ci-2)" in out, out
    assert json.load(open(db)).get("deleted") == ["21"], json.load(open(db))
    assert "bootout gui/" in log(db, "launchctl") and "/dev.software-factory.widget-ci-2" in log(db, "launchctl")
    assert "--project-name widget-ci-2 down --volumes" in log(db, "docker"), log(db, "docker")
    update(db, api={"repos/acme/Widget/actions/runners": {"runners": []}})  # its job ended
    rc, out = ci(d, {**env, "FACTORY_CI_RUNNERS": "1"}, "install")
    assert "Removed instance 3" in out and not os.path.exists(os.path.join(agents_dir(env), "dev.software-factory.widget-ci-3.plist")), out


def test_light_can_be_turned_off_and_one_instance_uninstalled():
    d, db, env = project(ci={"light": False})
    assert ci(d, env, "install")[0] == 0
    assert os.listdir(agents_dir(env)) == ["dev.software-factory.widget-ci.plist"]
    d, db, env = project()
    assert ci(d, env, "install")[0] == 0
    rc, out = ci(d, env, "uninstall", "light")
    assert rc == 0 and "Removed instance light" in out, out
    assert os.listdir(agents_dir(env)) == ["dev.software-factory.widget-ci.plist"]
    assert ci(d, env, "uninstall", "7")[0] == 1


def test_install_warns_when_the_runners_need_more_memory_than_is_free():
    d, db, env = project(ci={"runners": 3})
    rc, out = ci(d, {**env, "FACTORY_CI_FREE_MB": "6000"}, "install")
    assert rc == 0 and "Warning: 3 heavy runner(s) and the light one need about 13312 MB" in out, out
    rc, out = ci(d, {**env, "FACTORY_CI_FREE_MB": "64000"}, "install")
    assert "Warning" not in out, out


def test_use_local_also_sets_the_light_lane_variable_and_install_says_it():
    d, db, env = project()
    rc, out = ci(d, env, "install")
    assert "`factory ci use local` also sets CI_RUNS_ON_LIGHT to [\"self-hosted\",\"widget-light\"]" in out, out
    rc, out = ci(d, env, "use", "local")
    v = json.load(open(db))["vars"]
    assert v["CI_RUNS_ON_LIGHT"] == '["self-hosted","widget-light"]' and v["CI_RUNS_ON"] == '["self-hosted","widget-local"]'
    rc, out = ci(d, env, "install")  # in local mode, install sets it itself
    assert "the repo variable CI_RUNS_ON_LIGHT is [\"self-hosted\",\"widget-light\"]" in out, out
    rc, out = ci(d, env, "use", "github")
    assert "CI_RUNS_ON_LIGHT" not in json.load(open(db))["vars"], out


def test_status_lists_every_instance_and_logs_takes_one():
    d, db, env = project(ci={"runners": 2})
    assert ci(d, env, "install")[0] == 0
    update(db, vars={"CI_RUNS_ON": '["self-hosted","widget-local"]'})
    runs_and_pulls(db, [run("main")], runners=[{"name": "widget-ci-test-mac.light-1", "status": "online", "busy": False,
                                                "labels": [{"name": "self-hosted"}, {"name": "widget-light"}]}])
    rc, out = ci(d, env, "status")
    assert "Runner widget-ci: running (LaunchAgent dev.software-factory.widget-ci, pid 4242)" in out, out
    assert "Runner widget-ci-2: running (LaunchAgent dev.software-factory.widget-ci-2, pid 4242)" in out, out
    assert "Runner widget-ci-light (light lane, label widget-light): running" in out, out
    assert "Light lane (widget-light, the Factory guard):" in out and "widget-ci-test-mac.light-1: online" in out, out
    n = names(d, env)
    open(os.path.join(n["CI_STATE"], "runner-2.log"), "w").write("round 9: job done\n")
    rc, out = ci(d, env, "logs", "2")
    assert rc == 0 and "round 9" in out, out


def test_linux_two_runners_and_the_light_lane_are_user_units_and_scale_down():
    d, db, env = linux_project(ci={"runners": 2})
    rc, out = ci(d, env, "install")
    assert rc == 0, out
    unit_dir = os.path.join(env["HOME"], ".config", "systemd", "user")
    assert sorted(os.listdir(unit_dir)) == ["widget-ci-2.service", "widget-ci-light.service", "widget-ci.service"]
    projects = {unit_env(os.path.join(unit_dir, u))["CI_PROJECT"] for u in os.listdir(unit_dir)}
    assert projects == {"widget-ci", "widget-ci-2", "widget-ci-light"}, projects
    sc = log(db, "systemctl")
    for u in ("widget-ci.service", "widget-ci-2.service", "widget-ci-light.service"):
        assert f"--user enable {u}" in sc and f"--user restart {u}" in sc, (u, sc)
    update(db, api={"repos/acme/Widget/actions/runners": {"runners": []}})  # GitHub says nothing is busy
    rc, out = ci(d, {**env, "FACTORY_CI_RUNNERS": "1"}, "install")
    assert rc == 0 and sorted(os.listdir(unit_dir)) == ["widget-ci-light.service", "widget-ci.service"], out
    assert "--user disable --now widget-ci-2.service" in log(db, "systemctl")


def test_turning_the_light_lane_off_removes_its_variable_and_status_flags_a_stale_one():
    # (#91 review) Otherwise every Factory guard waits for a runner that no longer exists.
    d, db, env = project()
    assert ci(d, env, "install")[0] == 0 and ci(d, env, "use", "local")[0] == 0
    assert "CI_RUNS_ON_LIGHT" in json.load(open(db))["vars"]
    cfg = os.path.join(d, ".claude", "factory.json")
    json.dump({"ci": {"light": False}}, open(cfg, "w"))
    rc, out = ci(d, env, "install")
    assert rc == 0 and "CI_RUNS_ON_LIGHT" not in json.load(open(db))["vars"], out
    assert "deleted the repo variable CI_RUNS_ON_LIGHT" in out, out
    # use local with the light lane off deletes it too
    update(db, vars={"CI_RUNS_ON_LIGHT": '["self-hosted","widget-light"]'})
    rc, out = ci(d, env, "use", "local")
    assert "CI_RUNS_ON_LIGHT" not in json.load(open(db))["vars"], out
    update(db, vars={"CI_RUNS_ON": '["self-hosted","widget-local"]', "CI_RUNS_ON_LIGHT": '["self-hosted","widget-light"]'})
    # status: a set CI_RUNS_ON_LIGHT that no online runner has is flagged, whatever ci.light says
    runs_and_pulls(db, [run("main")], runners=[])
    rc, out = ci(d, env, "status")
    assert "CI_RUNS_ON_LIGHT asks for widget-light, and no runner with that label is online" in out, out


def test_light_variable_that_gh_cant_delete_is_a_persons_step():
    d, db, env = project(ci={"light": False})
    update(db, vars={"CI_RUNS_ON": '["self-hosted","widget-local"]', "CI_RUNS_ON_LIGHT": '["self-hosted","widget-light"]'},
           no_delete=True)
    rc, out = ci(d, env, "install")
    assert rc == 0 and "Delete the repo variable CI_RUNS_ON_LIGHT" in out, out


def test_registration_prefixes_dont_collide_between_hosts_foo_and_foo_2():
    # Instance 2 on `foo` and instance 1 on `foo-2` must never match each other (#91 review).
    d, db, env = project(ci={"runners": 2})
    bin_ = env["PATH"].split(":")[0]
    open(os.path.join(bin_, "scutil"), "w").write("#!/bin/sh\necho foo\n")
    assert ci(d, env, "install")[0] == 0
    runner = lambda i, name, busy=False: {"id": i, "name": name, "status": "online", "busy": busy}
    update(db, api={"repos/acme/Widget/actions/runners": {"runners": [
        runner(1, "widget-ci-foo-2-100", True),   # instance 1 on machine foo-2, busy
        runner(2, "widget-ci-foo-2-200"),         # instance 1 on machine foo-2, idle
        runner(3, "widget-ci-foo.2-300")]}})      # instance 2 on this machine (foo), idle
    rc, out = ci(d, {**env, "FACTORY_CI_RUNNERS": "1"}, "install")
    assert rc == 0 and "Removed instance 2" in out, out  # foo-2's busy runner didn't hold it back
    assert json.load(open(db)).get("deleted") == ["3"], json.load(open(db))  # and foo-2's idle one was left alone


def test_a_scale_down_that_cant_ask_github_leaves_the_instance_alone():
    d, db, env = project(ci={"runners": 2})
    assert ci(d, env, "install")[0] == 0
    update(db, fail=["repos/acme/Widget/actions/runners"])
    rc, out = ci(d, {**env, "FACTORY_CI_RUNNERS": "1"}, "install")
    assert rc == 0 and "Can't tell whether instance 2 (widget-ci-2) is running a job" in out, out
    assert os.path.exists(os.path.join(agents_dir(env), "dev.software-factory.widget-ci-2.plist"))


def test_the_memory_warning_uses_docker_desktops_vm_on_macos_and_counts_running_instances_on_linux():
    d, db, env = project(ci={"runners": 3})
    rc, out = ci(d, {**env, "FAKE_DOCKER_MEMTOTAL": str(8 * 1024 ** 3)}, "install")
    assert "Docker Desktop's VM has about 8192 MB" in out and "Warning" in out, out
    rc, out = ci(d, {**env, "FAKE_DOCKER_MEMTOTAL": str(32 * 1024 ** 3)}, "install")
    assert "Warning" not in out, out
    d, db, env = linux_project(ci={"runners": 2})
    assert ci(d, {**env, "FACTORY_CI_FREE_MB": "64000"}, "install")[0] == 0
    # Re-install with the 2 heavy and the light instance running: only a new third needs memory.
    rc, out = ci(d, {**env, "FACTORY_CI_FREE_MB": "5000", "FACTORY_CI_RUNNERS": "3"}, "install")
    assert rc == 0 and "Warning" not in out, out
    rc, out = ci(d, {**env, "FACTORY_CI_FREE_MB": "3000", "FACTORY_CI_RUNNERS": "4"}, "install")
    assert "Warning" in out, out


def test_the_light_label_must_differ_from_the_heavy_one():
    d, db, env = project(ci={"lightLabel": "widget-local"})
    rc, out = ci(d, env, "names")
    assert rc != 0 and "ci.lightLabel must differ from ci.label" in out, out


def test_the_workflow_template_puts_the_guard_on_the_light_lane_and_forks_on_github():
    import re
    text = open(os.path.join(KIT, ".github", "workflows", "ci.yml")).read()
    runs_on = dict(re.findall(r"\n  (\w+):\n(?:    .*\n)*?    runs-on: (.*)", text))
    fork = "github.event.pull_request.head.repo.full_name != github.repository && '\"ubuntu-latest\"'"
    assert fork in runs_on["guard"] and fork in runs_on["check"], runs_on
    assert "|| vars.CI_RUNS_ON_LIGHT || vars.CI_RUNS_ON || '\"ubuntu-latest\"'" in runs_on["guard"], runs_on
    assert "CI_RUNS_ON_LIGHT" not in runs_on["check"] and "|| vars.CI_RUNS_ON || '\"ubuntu-latest\"'" in runs_on["check"]


# --- faster rounds: a pre-built image and caches that outlive a job (#60) --------------------------------------------

def tooled_project(**kw):
    d, db, env = project(**kw)
    open(os.path.join(d, ".nvmrc"), "w").write("24\n")
    json.dump({"packageManager": "pnpm@9.12.0+sha512.abc"}, open(os.path.join(d, "package.json"), "w"))
    open(os.path.join(d, "pnpm-lock.yaml"), "w").write("  '@playwright/test@1.48.2':\n")
    return d, db, env


def test_install_builds_the_runner_image_with_the_projects_tools():
    d, db, env = tooled_project()
    rc, out = ci(d, env, "install")
    assert rc == 0, out
    dl = log(db, "docker")
    assert "build --quiet --tag widget-ci-runner:latest" in dl, dl
    for arg in ("NODE_VERSION=24", "PNPM_VERSION=9.12.0", "PLAYWRIGHT_VERSION=1.48.2"):
        assert f"--build-arg {arg}" in dl, (arg, dl)
    heavy, light = plist_env(env, "dev.software-factory.widget-ci"), plist_env(env, "dev.software-factory.widget-ci-light")
    assert (heavy["RUNNER_IMAGE"], heavy["CI_CACHES"]) == ("widget-ci-runner:latest", "1"), heavy
    assert (light["RUNNER_IMAGE"], light["CI_CACHES"]) == ("", "0"), light  # the light lane stays plain and small
    n = names(d, env)
    for f in ("runner.Dockerfile", "install-tools.sh", "compose-caches.yaml"):
        assert os.path.isfile(os.path.join(n["CI_INSTALLED"], f)), f


def test_a_failed_build_falls_back_to_the_plain_image_and_the_settings_turn_it_all_off():
    d, db, env = tooled_project()
    rc, out = ci(d, {**env, "FAKE_DOCKER_BUILD_FAILS": "1"}, "install")
    assert rc == 0 and "the runner image didn't build" in out, out
    assert plist_env(env, "dev.software-factory.widget-ci")["RUNNER_IMAGE"] == ""
    d, db, env = tooled_project(ci={"image": "base", "caches": False})
    assert ci(d, env, "install")[0] == 0
    assert " build " not in log(db, "docker"), log(db, "docker")
    assert plist_env(env, "dev.software-factory.widget-ci")["CI_CACHES"] == "0"


def test_only_the_registry_mirror_outlives_a_job_and_no_job_shares_a_network_or_a_writable_store():
    import re
    ci_dir = os.path.join(SF, "ci")
    caches = open(os.path.join(ci_dir, "compose-caches.yaml")).read()
    base = open(os.path.join(ci_dir, "compose.yaml")).read()
    body = "\n".join(l for l in (caches + base).splitlines() if not l.lstrip().startswith("#"))
    # No workspace mount, and no pnpm store (a job could poison it for later jobs; #92 review).
    assert "_work" not in body and "pnpm" not in body and "npm_config_store_dir" not in open(
        os.path.join(ci_dir, "entrypoint.sh")).read(), body
    assert re.findall(r"^  (\S+):\n    external: true", caches, re.M) == ["cache"], caches
    assert "--registry-mirror=http://${CI_MIRROR:?}:5000" in caches
    loop = open(os.path.join(ci_dir, "loop.sh")).read()
    assert 'CI_CACHE_NETWORK="$project-cache"' in loop, "each instance its own network"
    assert "MIRROR_IMAGE=registry:2." in loop and re.search(r"registry:2\.\d+\.\d+", loop), "pinned"
    assert 'docker network connect "$CI_CACHE_NETWORK" "$CI_MIRROR"' in loop
    docker_file = open(os.path.join(ci_dir, "runner.Dockerfile")).read()
    assert "RUNNER_TOOL_CACHE=/opt/hostedtoolcache" in docker_file and "PLAYWRIGHT_BROWSERS_PATH" in docker_file
    # The jobs' user owns the browsers: Playwright's install writes a lock there even when they're present.
    assert re.search(r"chown -R runner:runner [^\n]*/ms-playwright", docker_file), docker_file
    assert "a+rX /ms-playwright" not in docker_file
    assert 'LABEL factory.node="$NODE_VERSION"' in docker_file
    assert ".complete" in open(os.path.join(ci_dir, "install-tools.sh")).read()


def test_two_instances_get_their_own_cache_networks():
    d, db, env = project(ci={"runners": 2})
    assert ci(d, env, "install")[0] == 0
    n = names(d, env)
    exe = os.path.join(n["CI_INSTALLED"], "widget-ci")
    for label in ("dev.software-factory.widget-ci", "dev.software-factory.widget-ci-2"):
        e = plist_env(env, label)
        subprocess.run(["/bin/bash", exe], input="given-token\n", env={**env, **e, "PATH": env["PATH"]},
                       capture_output=True, text=True, timeout=60, cwd=n["CI_INSTALLED"])
    dl = log(db, "docker")
    assert "network inspect widget-ci-cache" in dl and "network inspect widget-ci-2-cache" in dl, dl
    assert "network connect widget-ci-cache widget-ci-mirror" in dl, dl
    assert "network connect widget-ci-2-cache widget-ci-mirror" in dl, dl
    assert "registry:2.8.3" in dl and "volume create" not in dl, dl


def test_status_says_when_the_image_is_older_than_the_checkouts_tools():
    d, db, env = tooled_project()
    assert ci(d, env, "install")[0] == 0
    update(db, vars={"CI_RUNS_ON": '["self-hosted","widget-local"]'})
    runs_and_pulls(db, [run("main")], runners=[])
    old = "node=22 pnpm=9.12.0 playwright=1.48.2"
    rc, out = ci(d, {**env, "FAKE_DOCKER_IMAGE_LABELS": old}, "status")
    assert f"Runner image: built for {old}, and this checkout wants node=24 pnpm=9.12.0 playwright=1.48.2" in out, out
    rc, out = ci(d, {**env, "FAKE_DOCKER_IMAGE_LABELS": "node=24 pnpm=9.12.0 playwright=1.48.2"}, "status")
    assert "Runner image:" not in out, out


# A Docker that keeps state in files: a project's volumes and workspace live in $STATE/<project>/ until
# `down --volumes`. Each `up` is one job: it says whether it can see the last job's file, then writes its own.
STATEFUL_DOCKER = r'''#!/usr/bin/env bash
echo "$*" >>"$FAKE_DB.docker.log"
st="$FAKE_DOCKER_STATE"; mkdir -p "$st/volumes"
project=""; prev=""
for a in "$@"; do [ "$prev" = --project-name ] && project="$a"; prev="$a"; done
case " $* " in
  *" up "*)
    ws="$st/$project/workspace"; mkdir -p "$ws"
    [ -e "$ws/job-file" ] && echo "SAW the last job's file" >>"$FAKE_DB.jobs.log" || echo "clean workspace" >>"$FAKE_DB.jobs.log"
    echo secret >"$ws/job-file"
    exit 0 ;;
  *" down "*"--volumes"*) rm -rf "${st:?}/$project" ;;
esac
exit 0
'''


def test_a_job_never_sees_the_last_jobs_files():
    d, db, env = project()
    assert ci(d, env, "install")[0] == 0
    n = names(d, env)
    e = plist_env(env, "dev.software-factory.widget-ci")
    bin2 = tempfile.mkdtemp()
    open(os.path.join(bin2, "docker"), "w").write(STATEFUL_DOCKER)
    os.chmod(os.path.join(bin2, "docker"), 0o755)
    run_env = {**env, **e, "PATH": f"{bin2}:{env['PATH']}", "FAKE_DOCKER_STATE": tempfile.mkdtemp()}
    loop = subprocess.Popen(["/bin/bash", os.path.join(n["CI_INSTALLED"], "widget-ci")], stdin=subprocess.DEVNULL,
                            env=run_env, cwd=n["CI_INSTALLED"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(200):
            if len(log(db, "jobs").splitlines()) >= 3:  # three jobs
                break
            time.sleep(0.1)
    finally:
        loop.terminate()
        loop.wait(timeout=20)
    jobs = log(db, "jobs").splitlines()
    assert jobs[:3] == ["clean workspace"] * 3, jobs
    assert "SAW" not in "".join(jobs)


def test_factory_help_lists_the_ci_commands():
    out = subprocess.run(["bash", os.path.join(SF, "factory"), "help"], cwd=project()[0], capture_output=True,
                         text=True).stdout
    for c in ("ci status", "ci use local|github", "ci install", "ci uninstall", "ci start | stop", "ci logs"):
        assert c in out, c


if __name__ == "__main__":
    for k, v in sorted(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
