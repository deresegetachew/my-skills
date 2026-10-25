#!/usr/bin/env python3
"""Where agents run, and how to reach them (#106): the machine's remotes, the ssh calls, and finding sessions by name.

A remote is only "how to reach a machine": a name and an ssh target (`factory@192.168.2.45`, or a Tailscale name), kept in
this machine's own file (`factory machine show` prints where), never in the project and never on GitHub. A cloud agent is
a name with the Remote Control link of its session. There is no role field: an agent is found by its name.

Sessions are tmux sessions on the remote, one per agent. A session belongs to an agent when its name is the agent's name or
`<repo>-<agent>` (what `factory autostart` and `factory agent --detach` start). A one-item sub-manager that the dev manager's
orchestrator starts (#97) is a session called `<manager>-<item>`, for example `dev-manager-pr-42`; it is listed too.

Every ssh call reuses one connection per target (ControlMaster), uses keys only (BatchMode) and talks to the sandbox user:
a target on which `sudo -n true` succeeds is refused. Errors are `{code, message, fix}`.
"""
import json, os, re, shlex, subprocess, sys
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

TARGET_OK = re.compile(r"[A-Za-z0-9._-]+@[A-Za-z0-9.:\[\]_-]+")
NAME_OK = re.compile(r"[a-z][a-z0-9-]*")
URL_OK = re.compile(r"https://claude\.ai/\S+")
RC_URL = re.compile(r"https://claude\.ai/code/[A-Za-z0-9_./?=&%-]+")
MANAGER_ROLES = ("dev-manager", "manager", "product-owner", "po")


class RemoteError(Exception):
    def __init__(self, code, message, fix):
        super().__init__(message)
        self.code, self.message, self.fix = code, message, fix

    def as_json(self):
        return json.dumps({"code": self.code, "message": self.message, "fix": self.fix})


# ---- the remotes (machine scope) -----------------------------------------------------------------------------------

def remotes():
    """{name: {"kind": "ssh", "target": ...} | {"kind": "cloud", "url": ...}} from this machine's file."""
    from factory_machine import machine_settings
    data = machine_settings().get("remotes")
    return {k: v for k, v in data.items() if isinstance(v, dict)} if isinstance(data, dict) else {}


def save_remotes(data):
    from factory_machine import save_machine_settings
    save_machine_settings(remotes=data)


def add_ssh(name, target):
    if not NAME_OK.fullmatch(name):
        raise RemoteError("bad-name", f"{name!r} is not a usable remote name.", "Use lowercase letters, digits and dashes.")
    if not TARGET_OK.fullmatch(target):
        raise RemoteError("bad-target", f"{target!r} is not user@host.", "Give the sandbox user and the address, for example factory@192.168.2.45.")
    if target.split("@")[0] in ("root", "admin"):
        raise RemoteError("admin-target", f"{target} is an admin account.", "Follow through the sandbox user that runs the agents (see factory bootstrap).")
    data = remotes()
    data[name] = {"kind": "ssh", "target": target}
    save_remotes(data)


def add_cloud(agent, url):
    if not NAME_OK.fullmatch(agent):
        raise RemoteError("bad-name", f"{agent!r} is not a usable agent name.", "Use lowercase letters, digits and dashes.")
    if not URL_OK.fullmatch(url):
        raise RemoteError("bad-url", f"{url!r} is not a claude.ai link.", "Copy the session's Remote Control link (https://claude.ai/code/...).")
    data = remotes()
    data[agent] = {"kind": "cloud", "url": url}
    save_remotes(data)


def remove(name):
    data = remotes()
    if name not in data:
        raise RemoteError("no-such-remote", f"There is no remote called {name}.", "factory remote list shows them.")
    del data[name]
    save_remotes(data)


# ---- ssh ---------------------------------------------------------------------------------------------------------------

def control_dir():
    base = os.environ.get("XDG_CACHE_HOME") or os.path.join(os.path.expanduser("~"), ".cache")
    d = os.path.join(base, "software-factory", "ssh")
    os.makedirs(d, mode=0o700, exist_ok=True)
    return d


def ssh_command(tty=False):
    """The ssh program and options: keys only, no prompts, one shared connection per target."""
    base = shlex.split(os.environ.get("FACTORY_SSH", "ssh"))
    opts = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=6", "-o", "ControlMaster=auto",
            "-o", f"ControlPath={os.path.join(control_dir(), '%C')}", "-o", "ControlPersist=120"]
    return base + (["-t"] if tty else []) + opts


def ssh_run(target, script, stdin=None, timeout=30):
    """(returncode, stdout, stderr) of `bash -c script` on the target."""
    argv = ssh_command() + [target, "bash -c " + shlex.quote(script)]
    try:
        p = subprocess.run(argv, input=stdin, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as e:
        return 255, "", str(e)
    return p.returncode, p.stdout, p.stderr


def ensure_sandbox_target(target):
    """Raises unless `target` is reachable and is not an account with sudo."""
    rc, out, err = ssh_run(target, "command -v tmux >/dev/null || echo NOTMUX; sudo -n true >/dev/null 2>&1 && echo SUDO; echo OK", timeout=20)
    if rc != 0 or "OK" not in out:
        raise RemoteError("unreachable", f"Could not reach {target} ({(err.strip().splitlines() or ['no answer'])[-1][:120]}).",
                          "Check the address, that ssh keys work (`ssh " + target + "`), and that the machine is on.")
    if "SUDO" in out.split():
        raise RemoteError("sudo-target", f"{target} can run sudo, so it is not the sandbox user.",
                          "Follow through the unprivileged user that `factory bootstrap` made, never an admin account.")
    if "NOTMUX" in out.split():
        raise RemoteError("no-tmux", f"{target} has no tmux, so no agent session can be there.", "Install tmux on that machine.")


# ---- finding sessions --------------------------------------------------------------------------------------------------

LIST_SCRIPT = r'''
if ! command -v tmux >/dev/null 2>&1; then echo NOTMUX; exit 0; fi
sudo -n true >/dev/null 2>&1 && echo SUDO
tmux list-sessions -F '#{session_name}' 2>/dev/null | while IFS= read -r s; do
  echo "S $s"
  tmux capture-pane -p -t "=$s:" -S -300 2>/dev/null | grep -Eo 'https://claude\.ai/code/[A-Za-z0-9_./?=&%-]+' | tail -n 1 | sed 's/^/U /'
done
echo END
'''


def parse_sessions(text):
    """[{"session": name, "url": link or ""}] and the flags (sudo, notmux) from the list script's output."""
    sessions, flags, current = [], set(), None
    for line in text.splitlines():
        if line.startswith("S "):
            current = {"session": line[2:], "url": ""}
            sessions.append(current)
        elif line.startswith("U ") and current is not None:
            current["url"] = line[2:].strip()
        elif line in ("SUDO", "NOTMUX", "END"):
            flags.add(line)
    return sessions, flags


def known_names(cfg):
    names = list(cfg.get("agents") or [])
    for role in (cfg.get("roles") or {}).values():
        if isinstance(role, dict):
            names += [n for n in role.get("names") or [] if isinstance(n, str)]
    return names


def classify(session, names, repo):
    """(kind, name, item) for a tmux session name, or None when it is not the factory's.
    kind is 'agent' (name is the agent) or 'sub-manager' (name is the manager, item the thing it works on)."""
    for n in names:
        if session in (n, f"{repo}-{n}"):
            return "agent", n, ""
    bare = session[len(repo) + 1:] if session.startswith(repo + "-") else session
    for role in sorted(MANAGER_ROLES, key=len, reverse=True):
        if bare.startswith(role + "-") and len(bare) > len(role) + 1:
            return "sub-manager", role, bare[len(role) + 1:]
    return None


def discover_one(name, remote, cfg, repo):
    """What one ssh remote has: {"remote", "target", "reachable", "error", "entries": [...]}."""
    out = {"remote": name, "target": remote["target"], "reachable": True, "error": "", "entries": []}
    rc, text, err = ssh_run(remote["target"], LIST_SCRIPT, timeout=25)
    if rc != 0 or "END" not in text and "NOTMUX" not in text:
        out.update(reachable=False, error=(err.strip().splitlines() or ["no answer"])[-1][:140])
        return out
    sessions, flags = parse_sessions(text)
    if "SUDO" in flags:
        out.update(reachable=False, error="the account can run sudo: not the sandbox user")
        return out
    names = known_names(cfg)
    for s in sessions:
        found = classify(s["session"], names, repo)
        if found:
            kind, who, item = found
            out["entries"].append({"kind": kind, "name": who, "item": item, "session": s["session"], "url": s["url"]})
    return out


def discover(cfg, repo, only=None):
    """Asks every ssh remote (in parallel) which sessions it has. Returns a list of per-remote results."""
    chosen = {k: v for k, v in remotes().items() if v.get("kind") == "ssh" and (only is None or k == only)}
    if only and not chosen:
        raise RemoteError("no-such-remote", f"There is no ssh remote called {only}.", "factory remote list shows them.")
    if not chosen:
        return []
    with ThreadPoolExecutor(max_workers=min(8, len(chosen))) as pool:
        futures = [pool.submit(discover_one, k, v, cfg, repo) for k, v in chosen.items()]
        return [f.result() for f in futures]


def cloud_entries():
    return [{"kind": "cloud", "name": k, "url": v.get("url", ""), "remote": "cloud"} for k, v in remotes().items()
            if v.get("kind") == "cloud"]


def find(agent, cfg, repo, on=None):
    """Where `agent` runs: ('ssh', remote name, target, session, url) or ('cloud', 'cloud', '', '', url).
    Raises when it is nowhere, or on more than one remote (then --on names the one)."""
    hits = []
    for r in discover(cfg, repo, only=on):
        for e in r["entries"]:
            if (e["kind"] == "agent" and e["name"] == agent) or e["session"] == agent:
                hits.append(("ssh", r["remote"], r["target"], e["session"], e["url"]))
    if not on:
        hits += [("cloud", "cloud", "", "", c["url"]) for c in cloud_entries() if c["name"] == agent]
    if len(hits) > 1:
        raise RemoteError("ambiguous", f"{agent} answers on {', '.join(sorted(h[1] for h in hits))}: agent names must be unique.",
                          f"Say which one: factory follow {agent} --on <remote>. (Two machines running one name is a setup error: "
                          "see factory machine setup.)")
    if not hits:
        names = known_names(cfg)
        reach = [r for r in remotes() if remotes()[r].get("kind") == "ssh"]
        hint = ("`factory remote add <name> <user@host>` tells factory where the machines are." if not reach else
                f"It is not running on {', '.join(reach)}. `factory follow` lists what is.")
        if names and agent not in names:
            hint = f"Known names: {', '.join(names)}. " + hint
        raise RemoteError("no-such-agent", f"No agent called {agent} was found.", hint)
    return hits[0]
