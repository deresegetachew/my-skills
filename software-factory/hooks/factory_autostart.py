#!/usr/bin/env python3
"""`factory autostart`: make this machine bring the factory back after every boot (#88).

  factory autostart status                        what is set up here and what would start; read-only
  factory autostart install [--agents a,b]       turn it on for this machine and install the boot service:
                                                  a systemd user unit (with linger) on Linux, a LaunchAgent on macOS
  factory autostart uninstall                     remove the service and turn it off; running agents keep running

At boot the service runs `factory resume` (factory_resume.py): it waits for Docker and the network, runs
`commands.stackUp`, saves any unfinished work of this machine's agents, and starts them in detached tmux sessions
with the settings and hooks loaded. Opt-in per machine: the names, "autostart", "autostartAgents" and "autostartReport"
live in this machine's file (`factory machine show` prints where), never in the project. Errors are
`{code, message, fix}` on stderr.

The service is named <repo>-factory-resume.service (Linux) or dev.software-factory.<repo>-resume (macOS), where <repo>
is the folder name of the main clone, so projects on one machine do not collide.
"""
import getpass, os, plistlib, shutil, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from factory_machine import (autostart_settings, checked_names, names_file, refuse, repo_key,  # noqa: E402
                             save_machine_settings, state_dir)
import factory_resume as R  # noqa: E402


def platform():
    given = os.environ.get("FACTORY_AUTOSTART_PLATFORM") or os.environ.get("FACTORY_CI_PLATFORM")
    if given in ("mac", "linux"):
        return given
    return "mac" if sys.platform == "darwin" or shutil.which("launchctl") else "linux"


def run(*a, timeout=60):
    try:
        p = subprocess.run(a, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as e:
        return 1, "", str(e)
    return p.returncode, p.stdout.strip(), p.stderr.strip()


def unit_name():
    return f"{repo_key()}-factory-resume.service"


def agent_label():
    return f"dev.software-factory.{repo_key()}-resume"


def unit_file():
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    return os.path.join(base, "systemd", "user", unit_name())


def plist_file():
    return os.path.join(os.path.expanduser("~"), "Library", "LaunchAgents", agent_label() + ".plist")


def domain():
    return f"gui/{os.getuid()}"


def service_path():
    """A PATH for the boot service: the folders of the tools the agents use, then the usual system ones. A service
    starts with a short PATH, and `claude`, `gh`, `tmux` and `docker` are often in the user's own folders."""
    dirs = []
    for tool in ("tmux", "claude", "gh", "docker", "git", "node", "pnpm", "python3", "sops"):
        found = shutil.which(tool)
        d = os.path.dirname(found) if found else ""
        if d.startswith("/") and d not in dirs:
            dirs.append(d)
    extra = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"] if platform() == "mac" else \
        ["/usr/local/bin", "/usr/bin", "/bin", "/usr/local/sbin", "/usr/sbin", "/sbin"]
    return ":".join(dirs + [d for d in extra if d not in dirs])


def docker_host():
    """The rootless Docker socket when this user has one (a service does not inherit DOCKER_HOST)."""
    if os.environ.get("DOCKER_HOST"):
        return os.environ["DOCKER_HOST"]
    sock = os.path.join(os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}", "docker.sock")
    return f"unix://{sock}" if os.path.exists(sock) else ""


def user_manager_ok():
    return shutil.which("systemctl") is not None and run("systemctl", "--user", "show-environment")[0] == 0


def service_state():
    """'enabled' | 'not installed' | 'unknown' (can't ask: no systemctl or no user manager)."""
    if platform() == "mac":
        if not shutil.which("launchctl"):
            return "unknown"
        return "enabled" if run("launchctl", "print", f"{domain()}/{agent_label()}")[0] == 0 else "not installed"
    if not user_manager_ok():
        return "unknown"
    return "enabled" if run("systemctl", "--user", "is-enabled", "--quiet", unit_name())[0] == 0 else "not installed"


def linger_on():
    return run("loginctl", "show-user", getpass.getuser(), "-p", "Linger", "--value")[1] == "yes"


def sd_quote(value):
    """A systemd command-line word: quoted, with \\ and \" escaped and % and $ doubled."""
    v = value.replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%").replace("$", "$$")
    return f'"{v}"'


def sd_env(key, value):
    v = f"{key}={value}".replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%")
    return f'Environment="{v}"'


def write_unit(top):
    path = unit_file()
    lines = ["[Unit]",
             f"Description={repo_key()}: bring the software factory back after a reboot (factory resume)",
             "After=docker.service", "",
             "[Service]",
             "Type=oneshot",
             "RemainAfterExit=yes",
             "# The agents run in tmux sessions started by this job: stopping or finishing it must not kill them.",
             "KillMode=process",
             "# Waiting for Docker, the network and the stack can take a while.",
             "TimeoutStartSec=infinity",
             f"WorkingDirectory={top.replace('%', '%%')}",
             f"ExecStart=/bin/bash {sd_quote(os.path.join(top, 'factory'))} resume",
             sd_env("PATH", service_path())]
    if docker_host():
        lines.append(sd_env("DOCKER_HOST", docker_host()))
    lines += ["", "[Install]", "WantedBy=default.target", ""]
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".tmp", "w") as f:
        f.write("\n".join(lines))
    os.replace(path + ".tmp", path)
    return path


def write_plist(top):
    path = plist_file()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    os.makedirs(state_dir(), exist_ok=True)
    data = {"Label": agent_label(), "ProgramArguments": [os.path.join(top, "factory"), "resume"],
            "WorkingDirectory": top, "EnvironmentVariables": {"PATH": service_path()}, "RunAtLoad": True,
            "AbandonProcessGroup": True,  # the tmux sessions must outlive this job
            "StandardOutPath": os.path.join(state_dir(), "launchd.log"),
            "StandardErrorPath": os.path.join(state_dir(), "launchd.log")}
    with open(path + ".tmp", "wb") as f:
        plistlib.dump(data, f)
    if run("plutil", "-lint", path + ".tmp")[0] != 0:
        os.remove(path + ".tmp")
        refuse("bad-plist", "The LaunchAgent file did not pass plutil -lint.", "Report this as a bug; nothing was installed.")
    os.replace(path + ".tmp", path)
    return path


def need_tools():
    if not shutil.which("tmux"):
        refuse("no-tmux", "tmux is not installed, and the agents are started in detached tmux sessions.",
               "Install tmux (for example `sudo apt install tmux` or `brew install tmux`), then run `factory autostart install` again.")
    if platform() == "mac":
        for tool in ("launchctl", "plutil"):
            if not shutil.which(tool):
                refuse("no-launchctl", f"{tool} was not found, so the LaunchAgent cannot be installed.",
                       "Run this on the Mac itself, or set FACTORY_AUTOSTART_PLATFORM=linux for a systemd machine.")
    else:
        if not shutil.which("systemctl"):
            refuse("no-systemd", "systemctl was not found, so the boot service cannot be installed.",
                   "This needs systemd. On another init system, run `factory resume` from your own boot script.")
        if not user_manager_ok():
            user = getpass.getuser()
            refuse("no-user-manager", f"systemd's user manager for {user} is not reachable (`systemctl --user` cannot "
                   "connect to its bus), so the service cannot be installed. Nothing was changed.",
                   f"Log in as {user} directly (ssh {user}@<host>, or `machinectl shell {user}@`), or run "
                   f"`sudo loginctl enable-linger {user}` and `export XDG_RUNTIME_DIR=/run/user/{os.getuid()}` here, "
                   "and try again.")


def install(args, cfg, top):
    need_tools()
    given = None
    if "--agents" in args:
        i = args.index("--agents")
        given = args[i + 1] if i + 1 < len(args) else ""
    on, current, _ = autostart_settings()
    names = checked_names(cfg, given if given is not None else ",".join(current),
                          "factory autostart install --agents")
    save_machine_settings(autostart=True, autostartAgents=names)
    if platform() == "mac":
        path = write_plist(top)
        run("launchctl", "bootout", f"{domain()}/{agent_label()}")
        rc, _, err = run("launchctl", "bootstrap", domain(), path)
        if rc != 0:
            refuse("launchctl-failed", f"launchctl could not load {path}: {err[:200]}",
                   "Log in to the Mac's desktop session as this user, then run `factory autostart install` again.")
        print(f"Installed {path}. It runs `factory resume` each time you log in (launchd runs it once now, too; "
              "agents that are already running are left alone).")
        print("A LaunchAgent starts at login, not at power-on: turn on automatic login for this user, or keep the "
              "Mac logged in, if it must come back by itself.")
    else:
        path = write_unit(top)
        run("systemctl", "--user", "daemon-reload")
        rc, _, err = run("systemctl", "--user", "enable", unit_name())
        if rc != 0:
            refuse("systemctl-failed", f"systemctl could not enable {unit_name()}: {err[:200]}",
                   "Check `systemctl --user status`, then run `factory autostart install` again.")
        print(f"Installed {path} and enabled {unit_name()}. It runs `factory resume` at every boot.")
        user = getpass.getuser()
        if not linger_on():
            run("loginctl", "enable-linger", user)
        if not linger_on():
            print(f"Note: linger is off for {user}, so the service does not start at boot (only after you log in).\n"
                  f"  Turn it on once: sudo loginctl enable-linger {user}")
    print(f"This machine starts: {', '.join(names)}. Change the names with `factory autostart install --agents a,b`.")
    print("Check it with `factory autostart status`; bring everything up now, without a reboot, with `factory resume`.")


def uninstall(top):
    if platform() == "mac":
        if os.path.exists(plist_file()) or service_state() == "enabled":
            run("launchctl", "bootout", f"{domain()}/{agent_label()}")
        if os.path.exists(plist_file()):
            os.remove(plist_file())
    elif os.path.exists(unit_file()) or service_state() == "enabled":
        if not user_manager_ok():
            refuse("no-user-manager", "systemd's user manager is not reachable, so the service cannot be removed.",
                   f"Log in as {getpass.getuser()} directly, then run `factory autostart uninstall` again.")
        run("systemctl", "--user", "disable", "--now", unit_name())
        if os.path.exists(unit_file()):
            os.remove(unit_file())
        run("systemctl", "--user", "daemon-reload")
    save_machine_settings(autostart=False)
    print("Autostart is off on this machine and the boot service is removed. Running agents and the stack were not "
          "stopped. The names stay in the machine file, so `factory autostart install` brings it back.")


def describe(cfg, top, agent):
    path = R.agent_path(cfg, top, agent)
    info = R.inspect(path)
    where = path if os.path.isdir(path) else f"{path} (made at boot)"
    work = []
    if info["branch"]:
        work.append(f"on {info['branch']}")
    if info["changes"]:
        work.append(f"{len(info['changes'])} uncommitted file{'s' if len(info['changes']) != 1 else ''}")
    if info["unpushed"]:
        work.append(f"{len(info['unpushed'])} unpushed commit{'s' if len(info['unpushed']) != 1 else ''}")
    running = subprocess.run(["tmux", "has-session", "-t", f"={R.session_name(agent)}"], capture_output=True).returncode == 0 \
        if shutil.which("tmux") else False
    print(f"  {agent}: {where}")
    print(f"    {', '.join(work) if work else 'clean, nothing to protect'}"
          + (" -> a backup is saved first, then it resumes in place" if info["changes"] or info["unpushed"] else ""))
    kit_ok = os.path.exists(os.path.join(path, ".claude", "settings.json")) or not os.path.isdir(path)
    if not kit_ok:
        print(f"    settings.json does not resolve here: it would NOT start ({R.SETTINGS_FIX})")
    print(f"    session {R.session_name(agent)}: {'running, left alone' if running else 'not running, would start'}")


def status(cfg, top):
    on, agents, post = autostart_settings()
    state = service_state()
    print(f"autostart: {'on' if on else 'off'}   (this machine's file: {names_file()})")
    if not on:
        print("  Turn it on for this machine: factory autostart install --agents "
              + (",".join((cfg.get("agents") or [])[:2]) or "<names>"))
    service = "systemd user unit " + unit_name() if platform() == "linux" else "LaunchAgent " + agent_label()
    print("service: " + {"enabled": f"installed ({service}, enabled)",
                         "not installed": f"not installed ({service}); `factory autostart install` adds it",
                         "unknown": f"cannot tell ({service}): no usable "
                                    + ("launchctl" if platform() == "mac" else "systemctl --user")}[state])
    if platform() == "linux":
        print("linger: " + ("on" if linger_on() else "off (the service would not start at boot: "
                            f"sudo loginctl enable-linger {getpass.getuser()})"))
    print("tmux: " + ("found" if shutil.which("tmux") else "NOT found (install it; agents run in tmux sessions)"))
    up = (cfg.get("commands") or {}).get("stackUp") or ""
    health = (cfg.get("commands") or {}).get("stackHealth") or ""
    print("stack: " + (f"`{up}`" + (f", healthy when `{health}` passes" if health else "") if up else
                       "no commands.stackUp is set, so no stack is started (`factory settings set commands.stackUp ...`)"))
    print(f"boot report on the agent's issue: {'yes' if post else 'no'} (issues mode only)")
    print(f"agents it would start{'' if on else ' once it is on'}: {', '.join(agents) if agents else 'none'}")
    for agent in agents:
        describe(cfg, top, agent)
    try:
        last = [l for l in open(os.path.join(state_dir(), "boot.log")).read().splitlines()]
    except OSError:
        last = []
    starts = [i for i, l in enumerate(last) if " resume: " in l and "autostart on" in l]
    if starts:
        print(f"last boot ({os.path.join(state_dir(), 'boot.log')}):")
        for l in last[starts[-1]:][:20]:
            print("  " + l)
    else:
        print("last boot: none yet")


def doctor(cfg):
    """[(level, what, how)] for `factory doctor`: level is ok, fix or note."""
    on, agents, _ = autostart_settings()
    if not on:
        return [("note", "autostart", "off on this machine: after a reboot the stack and the agents do not come back. "
                 "Run `factory autostart install --agents <names>` (see `factory autostart status`).")]
    out = []
    known = cfg.get("agents") or []
    unknown = [n for n in agents if n not in known]
    if not agents:
        out.append(("fix", "autostart agents", "autostart is on but no agent names are set: run "
                    "`factory autostart install --agents <names>`"))
    elif unknown:
        out.append(("fix", "autostart agents", f"{', '.join(unknown)} aren't in `agents` in .claude/factory.json "
                    f"({', '.join(known)}): run `factory autostart install --agents <names>`"))
    else:
        out.append(("ok", "autostart agents", ", ".join(agents)))
    out.append(("ok", "tmux", "") if shutil.which("tmux") else ("fix", "tmux", "autostart starts agents in tmux "
                                                              "sessions: install tmux"))
    if service_state() == "enabled":
        out.append(("ok", "autostart service", "installed"))
    else:
        out.append(("fix", "autostart service", "autostart is on but nothing runs `factory resume` at boot: run "
                    "`factory autostart install`"))
    if platform() == "linux" and shutil.which("loginctl") and not linger_on():
        out.append(("fix", "linger", f"off, so the service does not start at boot: sudo loginctl enable-linger {getpass.getuser()}"))
    if not (cfg.get("commands") or {}).get("stackUp"):
        out.append(("note", "commands.stackUp", "not set, so the dev stack is not started at boot "
                    "(`factory settings set commands.stackUp 'pnpm stack:up'`)"))
    return out


def main(argv):
    cmd = argv[0] if argv else "status"
    top = R.main_top()
    os.chdir(top)
    from factory_config import load
    cfg = load()
    if cmd == "status":
        status(cfg, top)
    elif cmd == "install":
        install(argv[1:], cfg, top)
    elif cmd == "uninstall":
        uninstall(top)
    else:
        refuse("unknown-command", f"unknown command {cmd!r}.", "Use status, install [--agents a,b] or uninstall.")


if __name__ == "__main__":
    main(sys.argv[1:])
