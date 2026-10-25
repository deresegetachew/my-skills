#!/usr/bin/env python3
"""What belongs to this machine and not to the project (#45): its id, and the agent names it runs.

Two machines on one project must never share an agent name. Both live outside the repo, in the config folder
(`$FACTORY_CONFIG_DIR`, else `$XDG_CONFIG_HOME/software-factory`, else `~/.config/software-factory`):

  machine-id        a random id made the first time it is needed (never the hostname). It goes into claims and agent
                    pings, so two machines that use the same name can still be told apart. `FACTORY_MACHINE_ID` overrides it.
  <repo>.json       {"agents": ["haile", "tewodros"]}: the names this machine runs for that project (<repo> is the
                    folder name of the main clone). `FACTORY_AGENTS` (comma-separated) overrides it. With neither,
                    every name in `agents` in .claude/factory.json is used, as before. The same file holds what
                    `factory autostart` needs (#88): "autostart" (true/false), "autostartAgents" (names; default:
                    the names above) and "autostartReport" (false: no boot report on the agent's issue), and
                    "remoteControl" (false: sessions start without Remote Control; FACTORY_REMOTE_CONTROL wins).
                    `factory settings --local` shows and changes all of them.
  <repo>.env        KEY=value lines `factory resume` loads for the agents it starts at boot (SOPS_AGE_KEY_FILE ...).

  python3 .claude/hooks/factory_machine.py id                       print this machine's id
  python3 .claude/hooks/factory_machine.py show                     the id and the names this machine runs
  python3 .claude/hooks/factory_machine.py setup haile,tewodros     write the names file (issues mode: refuses a name
                                                                    another machine has live)
  python3 .claude/hooks/factory_machine.py remote                   1 or 0: whether sessions start with Remote Control
Errors are `{code, message, fix}` on stderr.
"""
import json, os, re, subprocess, sys, uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

ID_OK = re.compile(r"[A-Za-z0-9][A-Za-z0-9-]{3,39}")


def refuse(code, message, fix, exit_code=1):
    print(json.dumps({"code": code, "message": message, "fix": fix}), file=sys.stderr)
    sys.exit(exit_code)


def config_dir():
    d = os.environ.get("FACTORY_CONFIG_DIR")
    if not d:
        base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
        d = os.path.join(base, "software-factory")
    return d


def machine_id():
    """This machine's id; made and saved on first use. '' when it can't be saved (a read-only home): claims then
    carry no machine, exactly as before."""
    given = os.environ.get("FACTORY_MACHINE_ID", "").strip()
    if given:
        return given if ID_OK.fullmatch(given) else refuse(
            "bad-machine-id", f"FACTORY_MACHINE_ID {given!r} isn't a valid id.",
            "Use 4 to 40 letters, digits or dashes, or unset it.")
    path = os.path.join(config_dir(), "machine-id")
    try:
        found = open(path).read().strip()
        if ID_OK.fullmatch(found):
            return found
    except OSError:
        pass
    new = uuid.uuid4().hex[:12]
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "x") as f:
            f.write(new + "\n")
        return new
    except FileExistsError:  # another process made it a moment ago
        try:
            found = open(path).read().strip()
            return found if ID_OK.fullmatch(found) else ""
        except OSError:
            return ""
    except OSError:
        return ""


def repo_key():
    """The folder name of the project's main clone (the same for every worktree of it)."""
    p = subprocess.run(["git", "rev-parse", "--git-common-dir"], capture_output=True, text=True)
    common = os.path.abspath(p.stdout.strip() if p.returncode == 0 and p.stdout.strip() else ".git")
    return os.path.basename(os.path.dirname(common))


def state_dir():
    """Where this machine keeps what it writes about the project (the boot log, the backups):
    `$XDG_STATE_HOME/<repo>-factory`, else `~/.local/state/<repo>-factory`."""
    base = os.environ.get("XDG_STATE_HOME") or os.path.join(os.path.expanduser("~"), ".local", "state")
    return os.path.join(base, f"{repo_key()}-factory")


def names_file():
    return os.path.join(config_dir(), f"{repo_key()}.json")


def machine_settings():
    """Everything in this machine's file for the project (a dict; {} when there is none or it can't be read)."""
    try:
        data = json.load(open(names_file()))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def write_machine_settings(data):
    """Replaces the machine's file with `data` (atomically). Returns the file's path."""
    path = names_file()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)
    return path


def save_machine_settings(**updates):
    """Writes `updates` into the machine's file, keeping every other key. Returns the file's path."""
    data = machine_settings()
    data.update(updates)
    return write_machine_settings(data)


def remote_control():
    """True when sessions should start with Remote Control: FACTORY_REMOTE_CONTROL (1 or 0) wins, else this machine's
    `remoteControl` setting (`factory settings --local set remoteControl off`), else on."""
    given = os.environ.get("FACTORY_REMOTE_CONTROL", "")
    if given:
        return given == "1"
    return machine_settings().get("remoteControl") is not False


def autostart_settings():
    """(on, agent names, post the boot report) for `factory autostart`. The names are `autostartAgents`, else the
    names this machine runs."""
    data = machine_settings()
    listed = data.get("autostartAgents")
    names = [str(n).strip() for n in listed if str(n).strip()] if isinstance(listed, list) else machine_names()
    return data.get("autostart") is True, names, data.get("autostartReport") is not False


def machine_names():
    """The names this machine runs: FACTORY_AGENTS, else the names file; [] when neither is set."""
    env = [n.strip() for n in os.environ.get("FACTORY_AGENTS", "").split(",") if n.strip()]
    if env:
        return env
    try:
        listed = json.load(open(names_file())).get("agents") or []
    except (OSError, ValueError, AttributeError):
        return []
    return [str(n).strip() for n in listed if str(n).strip()] if isinstance(listed, list) else []


def checked_names(cfg, names, example):
    """`names` (comma-separated) as a list, each one an agent in factory.json and, in issues mode, not live on another
    machine. Anything else stops with a `{code, message, fix}`."""
    from factory_config import safe_agent, task_source
    known = cfg.get("agents") or []
    mine = [safe_agent(n.strip()) for n in names.split(",") if n.strip()]
    if not mine:
        refuse("no-names", "No agent names were given.", "Pass names from `agents` in .claude/factory.json, "
               "for example: " + example + " " + ",".join(known[:2]))
    unknown = [n for n in mine if n not in known]
    if unknown:
        refuse("unknown-agent", f"{', '.join(unknown)} aren't agents in .claude/factory.json ({', '.join(known)}).",
               "Choose from that list, or add the names to `agents` there in a pull request first.")
    if task_source(cfg) == "issues":
        import factory_agents
        me = machine_id()
        for n in mine:
            if factory_agents.held_elsewhere(cfg, n, me):
                refuse("agent-name-in-use", f"{n} is live on another machine right now.",
                       "Choose a name no other machine uses, or stop that agent first.")
    return mine


def setup(names):
    from factory_config import load
    mine = checked_names(load(), names, "factory machine setup")
    path = save_machine_settings(agents=mine)  # keeps the autostart settings in the same file
    print(f"{path}: {', '.join(mine)}")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "show"
    if cmd == "id":
        print(machine_id())
    elif cmd == "show":
        print(f"machine id: {machine_id() or '(could not be saved)'}")
        print(f"agents on this machine: {', '.join(machine_names()) or 'every name in factory.json'}")
        print(f"names file: {names_file()}")
        on, auto, _ = autostart_settings()
        print(f"autostart: {'on' if on else 'off'}" + (f" ({', '.join(auto)})" if on and auto else "")
              + "  (factory autostart status)")
    elif cmd == "remote":
        print("1" if remote_control() else "0")
    elif cmd == "setup":
        if len(sys.argv) < 3:
            refuse("no-names", "No agent names were given.", "factory machine setup haile,tewodros")
        setup(sys.argv[2])
    else:
        refuse("unknown-command", f"unknown command {cmd!r}.", "Use id, show or setup <names>.")


if __name__ == "__main__":
    main()
