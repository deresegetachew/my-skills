#!/usr/bin/env python3
"""Keeps the heartbeat daemon (factory_heartbeat.py, #108) running: a systemd user service on Linux, a LaunchAgent on
macOS. It is the long-running sibling of the boot job `factory autostart` installs (factory_autostart.py): that one
runs `factory resume` once per boot, this one runs `factory heartbeat run` for as long as the machine is up and
restarts it if it stops.

  factory heartbeat install      write the service and start it now (Linux: enable --now, linger on; macOS: bootstrap)
  factory heartbeat uninstall    stop it and remove the service; agents keep running, they just stop being watched
  factory heartbeat restart      restart the installed service so it runs the files now on disk (`factory update` does this);
                                 says nothing and does nothing when no service is installed

`factory autostart install` calls install too (unless --no-heartbeat), and `factory autostart uninstall` removes it.
Names: <repo>-factory-heartbeat.service (Linux) and dev.software-factory.<repo>-heartbeat (macOS), where <repo> is
the folder name of the main clone. Errors are `{code, message, fix}` on stderr.
"""
import getpass, os, plistlib, shutil, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import factory_autostart as AS  # noqa: E402
from factory_machine import refuse, repo_key, state_dir  # noqa: E402


def unit_name():
    return f"{repo_key()}-factory-heartbeat.service"


def agent_label():
    return f"dev.software-factory.{repo_key()}-heartbeat"


def unit_file():
    return os.path.join(os.path.dirname(AS.unit_file()), unit_name())


def plist_file():
    return os.path.join(os.path.expanduser("~"), "Library", "LaunchAgents", agent_label() + ".plist")


def service_state():
    """'enabled' | 'not installed' | 'unknown' (can't ask: no systemctl or launchctl)."""
    if AS.platform() == "mac":
        if not shutil.which("launchctl"):
            return "unknown"
        return "enabled" if AS.run("launchctl", "print", f"{AS.domain()}/{agent_label()}")[0] == 0 else "not installed"
    if not AS.user_manager_ok():
        return "unknown"
    return "enabled" if AS.run("systemctl", "--user", "is-enabled", "--quiet", unit_name())[0] == 0 else "not installed"


def service_text():
    name = ("LaunchAgent " + agent_label()) if AS.platform() == "mac" else ("systemd user unit " + unit_name())
    return {"enabled": f"installed ({name}, enabled)",
            "not installed": f"not installed ({name}); `factory heartbeat install` adds it",
            "unknown": f"cannot tell ({name}): no usable "
                       + ("launchctl" if AS.platform() == "mac" else "systemctl --user")}[service_state()]


def write_unit(top):
    path = unit_file()
    lines = ["[Unit]", f"Description={repo_key()}: software factory heartbeat (what each agent is really doing)",
             "After=network-online.target", "",
             "[Service]", "Type=simple",
             f"WorkingDirectory={top.replace('%', '%%')}",
             f"ExecStart=/bin/bash {AS.sd_quote(os.path.join(top, 'factory'))} heartbeat run",
             "Restart=always", "RestartSec=10",
             AS.sd_env("PATH", AS.service_path()), "",
             "[Install]", "WantedBy=default.target", ""]
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".tmp", "w") as f:
        f.write("\n".join(lines))
    os.replace(path + ".tmp", path)
    return path


def write_plist(top):
    path = plist_file()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    os.makedirs(state_dir(), exist_ok=True)
    log = os.path.join(state_dir(), "heartbeat.log")
    data = {"Label": agent_label(), "ProgramArguments": [os.path.join(top, "factory"), "heartbeat", "run"],
            "WorkingDirectory": top, "EnvironmentVariables": {"PATH": AS.service_path()}, "RunAtLoad": True,
            "KeepAlive": True, "StandardOutPath": log, "StandardErrorPath": log}
    with open(path + ".tmp", "wb") as f:
        plistlib.dump(data, f)
    if AS.run("plutil", "-lint", path + ".tmp")[0] != 0:
        os.remove(path + ".tmp")
        raise ValueError(("bad-plist", "The LaunchAgent file did not pass plutil -lint.",
                          "Report this as a bug; nothing was installed."))
    os.replace(path + ".tmp", path)
    return path


def check_tools():
    """Raises ValueError((code, message, fix)) when the service cannot be installed here."""
    if AS.platform() == "mac":
        for tool in ("launchctl", "plutil"):
            if not shutil.which(tool):
                raise ValueError(("no-launchctl", f"{tool} was not found, so the LaunchAgent cannot be installed.",
                                  "Run this on the Mac itself, or set FACTORY_AUTOSTART_PLATFORM=linux for a systemd machine."))
    elif not shutil.which("systemctl"):
        raise ValueError(("no-systemd", "systemctl was not found, so the service cannot be installed.",
                          "This needs systemd. On another init system, run `factory heartbeat run` from your own "
                          "service manager."))
    elif not AS.user_manager_ok():
        user = getpass.getuser()
        raise ValueError(("no-user-manager", f"systemd's user manager for {user} is not reachable (`systemctl --user` "
                          "cannot connect to its bus), so the service cannot be installed. Nothing was changed.",
                          f"Log in as {user} directly (ssh {user}@<host>, or `machinectl shell {user}@`), or run "
                          f"`sudo loginctl enable-linger {user}` and `export XDG_RUNTIME_DIR=/run/user/{os.getuid()}` "
                          "here, and try again."))


def install(top):
    """Installs and starts the service. Returns the lines to tell the person; raises ValueError((code, message, fix))."""
    check_tools()
    out = []
    if AS.platform() == "mac":
        path = write_plist(top)
        AS.run("launchctl", "bootout", f"{AS.domain()}/{agent_label()}")
        rc, _, err = AS.run("launchctl", "bootstrap", AS.domain(), path)
        if rc != 0:
            raise ValueError(("launchctl-failed", f"launchctl could not load {path}: {err[:200]}",
                              "Log in to the Mac's desktop session as this user, then run `factory heartbeat install` again."))
        out.append(f"Installed {path}: the heartbeat daemon runs while you are logged in, and launchd restarts it if it stops.")
    else:
        path = write_unit(top)
        AS.run("systemctl", "--user", "daemon-reload")
        rc, _, err = AS.run("systemctl", "--user", "enable", "--now", unit_name())
        if rc != 0:
            raise ValueError(("systemctl-failed", f"systemctl could not start {unit_name()}: {err[:200]}",
                              "Check `systemctl --user status " + unit_name() + "`, then run `factory heartbeat install` again."))
        out.append(f"Installed {path} and started {unit_name()}: it runs from boot and restarts if it stops.")
        user = getpass.getuser()
        if not AS.linger_on():
            AS.run("loginctl", "enable-linger", user)
        if not AS.linger_on():
            out.append(f"Note: linger is off for {user}, so the service does not start at boot (only after you log in).\n"
                       f"  Turn it on once: sudo loginctl enable-linger {user}")
    out.append("Check it with `factory heartbeat status`; `factory agents ls` shows what it sees.")
    return out


def restart():
    """Restarts the installed service so a daemon started before an update runs the new code. Returns the lines to
    tell the person: none when no service is installed here. Raises ValueError((code, message, fix))."""
    if service_state() != "enabled":
        return []
    if AS.platform() == "mac":
        rc, _, err = AS.run("launchctl", "kickstart", "-k", f"{AS.domain()}/{agent_label()}")
        name = agent_label()
    else:
        rc, _, err = AS.run("systemctl", "--user", "restart", unit_name())
        name = unit_name()
    if rc != 0:
        raise ValueError(("restart-failed", f"could not restart {name}: {err[:200]}",
                          "Run `factory heartbeat install` to write the service again and start it."))
    return [f"Restarted {name}: it runs the files now on disk."]


def uninstall():
    """Stops and removes the service (a no-op when it is not installed). Raises ValueError((code, message, fix))."""
    if AS.platform() == "mac":
        if os.path.exists(plist_file()) or service_state() == "enabled":
            AS.run("launchctl", "bootout", f"{AS.domain()}/{agent_label()}")
        if os.path.exists(plist_file()):
            os.remove(plist_file())
    elif os.path.exists(unit_file()) or service_state() == "enabled":
        if not AS.user_manager_ok():
            raise ValueError(("no-user-manager", "systemd's user manager is not reachable, so the service cannot be removed.",
                              f"Log in as {getpass.getuser()} directly, then run `factory heartbeat uninstall` again."))
        AS.run("systemctl", "--user", "disable", "--now", unit_name())
        if os.path.exists(unit_file()):
            os.remove(unit_file())
        AS.run("systemctl", "--user", "daemon-reload")


def top_of_project():
    import factory_resume
    top = factory_resume.main_top()
    os.chdir(top)
    return top


def install_cli():
    top = top_of_project()
    try:
        for line in install(top):
            print(line)
    except ValueError as e:
        refuse(*e.args[0])


def restart_cli():
    try:
        for line in restart():
            print(line)
    except ValueError as e:
        refuse(*e.args[0])


def uninstall_cli():
    top_of_project()
    try:
        uninstall()
    except ValueError as e:
        refuse(*e.args[0])
    print("The heartbeat service is removed. Running agents were not stopped; they are just not watched any more, so "
          "pings and `silent` work as before.")


def doctor(cfg):
    """[(level, what, how)] for `factory doctor`. Only in issues mode, where agents report to GitHub."""
    from factory_config import task_source
    if task_source(cfg) != "issues":
        return []
    state = service_state()
    if state == "enabled":
        return [("ok", "heartbeat daemon", "installed")]
    why = ("can't tell whether it is installed here (no usable systemctl --user or launchctl)"
           if state == "unknown" else "not installed")
    return [("note", "heartbeat daemon", f"{why}: an agent waiting in `factory wait` then looks silent, and a crashed one "
             "keeps saying working for 30 minutes. Run `factory heartbeat install` (or `factory autostart install`).")]


if __name__ == "__main__":
    {"install": install_cli, "uninstall": uninstall_cli, "restart": restart_cli}.get(sys.argv[1] if len(sys.argv) > 1 else "", lambda: refuse(
        "unknown-command", "unknown command.", "Use install, uninstall or restart (or `factory heartbeat ...`)."))()
