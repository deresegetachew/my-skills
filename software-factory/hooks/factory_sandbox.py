#!/usr/bin/env python3
"""`factory doctor --sandbox` (#105): does the sandbox of this machine hold? Run it as the dedicated user.

Read-only: it runs `curl`, `docker run` of a tiny image against the router, `id`, `ss` and friends, and never prints a
token or a file's content. Each line is `ok`, `fix` (with the fix) or `note`. The same checks, listed:

  identity    the dedicated user; no sudo; not in the docker/sudo groups; the admin's home and keys unreadable;
              ~/.secrets is 700
  network     the internet works (GitHub, npm, the Claude API); the router, the tailnet, link-local and the admin's
              local web ports are blocked; FACTORY-BLOCK entries appear in the kernel log
  gap 1       every loopback/wildcard port another user listens on is in the guard (re-run the machine step if not)
  gap 2       a container started by this user cannot reach the router either
  rootless    Docker is rootless with overlayfs; the cpu, memory and pids cgroup controllers are delegated; linger is on
  services    the CI runner units are active; every agent worktree has its submodules checked out
"""
import json, os, re

import factory_bootstrap_machine as M
import factory_netguard as G
from factory_bootstrap_core import probe

INTERNET = ["https://github.com", "https://registry.npmjs.org", "https://api.anthropic.com"]
LINK_LOCAL = "169.254.169.254"
TAILNET = "100.100.100.100"
CONTROLLERS = ("cpu", "memory", "pids")


def settings():
    """The sandbox settings `factory bootstrap machine` saved, or the defaults when it was never run."""
    try:
        with open(M.config_path()) as f:
            cfg = json.load(f)
    except (OSError, ValueError):
        cfg = {}
    return {"user": cfg.get("user", ""), "egress": cfg.get("egress", "internet"),
            "blockLoopbackPorts": cfg.get("blockLoopbackPorts", []), "known": bool(cfg)}


def manifest():
    try:
        with open(M.manifest_path()) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def default_gateway():
    rc, out, _ = probe(["ip", "-4", "route", "show", "default"])
    m = re.search(r"via (\d+\.\d+\.\d+\.\d+)", out) if rc == 0 else None
    return m.group(1) if m else ""


def http_code(url, timeout=5):
    rc, out, _ = probe(["curl", "-s", "-m", str(timeout), "-o", "/dev/null", "-w", "%{http_code}", url], timeout=timeout + 5)
    code = out.strip()
    return code if code.isdigit() else "000"


def reached(url):
    return http_code(url) != "000"


def verdict(r, good, ok_msg, what, how, level="fix"):
    """ok when `good`, else a fix (or a note)."""
    if good:
        r.ok(ok_msg)
    else:
        (r.fix if level == "fix" else r.note)(what, how)


def identity(r, cfg, me):
    if cfg["known"] and cfg["user"] and cfg["user"] != me:
        r.fix("sandbox identity", f"you are {me}, the sandbox user is {cfg['user']}: run `sudo -u {cfg['user']} -i`, then "
              "`factory doctor --sandbox` from the project there")
    else:
        r.ok(f"running as the sandbox user {me}")
    if probe(["sudo", "-n", "true"])[0] == 0:
        r.fix("sudo", f"{me} can run sudo: remove it from the sudo group (`sudo gpasswd -d {me} sudo`) and any sudoers entry")
    else:
        r.ok("no sudo")
    bad = [g for g in probe(["id", "-nG"])[1].split() if g in M.PRIVILEGE_GROUPS]
    if bad:
        r.fix("groups", f"{me} is in {', '.join(bad)}: `sudo gpasswd -d {me} {bad[0]}` (the docker group is root-equivalent)")
    else:
        r.ok("not in the sudo, docker or admin groups")
    adm = manifest().get("steps", {}).get("isolate", {}).get("record", {})
    home = adm.get("adminHome", "")
    if home:
        if probe(["ls", home])[0] == 0 or probe(["ls", os.path.join(home, ".ssh")])[0] == 0:
            r.fix("admin's files", f"{home} is readable: `sudo chmod 750 {home}`")
        else:
            r.ok(f"{home} (the admin's home) is not readable")
    else:
        r.note("admin's files", "the manifest does not name the admin's home; check by hand that /home/<admin> is mode 750")
    secrets = os.path.expanduser("~/.secrets")
    if os.path.isdir(secrets):
        mode = os.stat(secrets).st_mode & 0o777
        verdict(r, mode == 0o700, "~/.secrets is 700", "~/.secrets", f"mode is {mode:o}: `chmod 700 ~/.secrets`")
    else:
        r.note("~/.secrets", "does not exist yet: `factory bootstrap project` makes it")


def network(r, cfg):
    down = [u for u in INTERNET if not reached(u)]
    if cfg["egress"] == "none":
        verdict(r, len(down) == len(INTERNET), "the internet is closed (egress none)", "egress none",
                "the internet is reachable although the sandbox says egress none: `sudo factory bootstrap machine --apply`")
    elif down:
        r.fix("internet", f"{', '.join(down)} not reachable: check the network, then the guard (`sudo systemctl status {G.UNIT_NAME}`)")
    else:
        r.ok("the internet works (GitHub, npm, the Claude API)")
    gw = default_gateway()
    targets = [(f"the router {gw}", f"http://{gw}")] if gw else []
    targets += [("the tailnet", f"http://{TAILNET}"), ("link-local", f"http://{LINK_LOCAL}")]
    targets += [(f"the local service on 127.0.0.1:{p}", f"http://127.0.0.1:{p}") for p in cfg["blockLoopbackPorts"]]
    leaked = []
    for what, url in targets:
        if reached(url):
            leaked.append(what)
    if leaked:
        r.fix("home network", f"{', '.join(leaked)} reachable: the guard is not loaded or does not cover this user "
              f"(`sudo systemctl restart {G.UNIT_NAME}`, or run `sudo factory bootstrap machine --apply`)")
    else:
        r.ok("the router, the tailnet, link-local and the blocked local ports are not reachable")
    if not gw:
        r.note("router", "no default route found, so the router was not tried")
    rc, out, _ = probe(["journalctl", "-k", "--no-pager", "-n", "200", "-g", "FACTORY-BLOCK"])
    if rc != 0:
        r.note("FACTORY-BLOCK log", "the kernel log is not readable by this user; as the admin: "
               "`sudo journalctl -k | grep FACTORY-BLOCK`")
    elif "FACTORY-BLOCK" in out:
        r.ok("blocked attempts appear in the kernel log (FACTORY-BLOCK)")
    else:
        r.note("FACTORY-BLOCK log", "no entry yet; the guard logs blocked attempts, so this is fine until something is blocked")


def gap_one(r, cfg, uid):
    rc, ss, _ = probe(["ss", "-ltnHe"])
    if rc != 0:
        r.note("other users' listening ports", "`ss` is not available, so they were not listed")
        return
    rules = M.read(M.rules_path())
    if not rules:
        r.note("other users' listening ports", "the guard's rules are not readable here; as the admin: "
               "`sudo factory bootstrap status`")
        return
    unblocked = [p for p in G.listening_ports_not_owned(ss, uid) if not re.search(rf"[{{ ,]{p}[ ,}}]", rules)]
    if unblocked:
        r.fix("local services of other users", f"ports {', '.join(map(str, unblocked))} are open to this user: "
              "run `sudo factory bootstrap machine --apply` again so the guard covers them")
    else:
        r.ok("every local service of another user is covered by the guard")


def gap_two(r, gateway):
    if not gateway:
        return
    rc, _, err = probe(["docker", "run", "--rm", "busybox", "wget", "-q", "-T", "3", "-O", "/dev/null", f"http://{gateway}"],
                       timeout=90)
    if rc == 0:
        r.fix("containers", f"a container started by this user reached the router {gateway}: the guard does not cover "
              "container traffic; check that Docker is rootless (`docker info`) and run `sudo factory bootstrap machine --apply`")
    else:
        r.ok("a container started by this user cannot reach the router either")


def rootless(r, uid):
    rc, out, _ = probe(["docker", "info", "--format", "{{json .SecurityOptions}}|{{.Driver}}"])
    if rc != 0:
        r.fix("rootless Docker", "docker is not reachable: `factory bootstrap project` sets it up "
              "(`systemctl --user start docker`, DOCKER_HOST=unix://$XDG_RUNTIME_DIR/docker.sock)")
        return False
    secopts, _, driver = out.strip().partition("|")
    verdict(r, "rootless" in secopts, "Docker is rootless", "rootless Docker",
            "this Docker is not rootless: run `dockerd-rootless-setuptool.sh install` as this user")
    verdict(r, driver == "overlay2", "storage driver overlay2", "storage driver",
            f"{driver or 'unknown'}, not overlay2: builds will be slow", level="note")
    path = M.P(f"/sys/fs/cgroup/user.slice/user-{uid}.slice/user@{uid}.service/cgroup.controllers")
    have = M.read(path).split()
    missing = [c for c in CONTROLLERS if c not in have]
    if not have:
        r.note("cgroup controllers", "could not read the delegated controllers (cgroup v2 expected)")
    elif missing:
        r.fix("cgroup controllers", f"{', '.join(missing)} not delegated: add a /etc/systemd/system/user@.service.d/delegate.conf "
              "with `[Service]` `Delegate=cpu cpuset io memory pids`, then `sudo systemctl daemon-reload` and log in again")
    else:
        r.ok("cgroup controllers cpu, memory and pids are delegated")
    user = os.environ.get("USER") or os.environ.get("LOGNAME") or "factory"
    if probe(["loginctl", "show-user", user, "-p", "Linger", "--value"])[1].strip() == "yes":
        r.ok("linger is on")
    else:
        r.fix("linger", f"off: user services die at logout. `sudo loginctl enable-linger {user}`")
    return True


def services(r, cfg_project):
    try:
        from factory_machine import repo_key
        repo = repo_key()
    except Exception:
        repo = ""
    want = int(((cfg_project.get("ci") or {}).get("runners")) or 0) if cfg_project else 0
    rc, out, _ = probe(["systemctl", "--user", "list-units", "--no-legend", "--state=active", f"{repo}-ci*.service"])
    active = len([l for l in out.splitlines() if ".service" in l]) if rc == 0 else 0
    if rc != 0:
        r.note("CI runners", "could not ask the user's systemd (is XDG_RUNTIME_DIR set? log in with ssh, not su)")
    elif active == 0:
        (r.fix if want else r.note)("CI runners", "no runner unit is active: `factory ci install`")
    elif want and active < want:
        r.fix("CI runners", f"{active} active, ci.runners asks for {want}: `factory ci install`")
    else:
        r.ok(f"{active} CI runner unit(s) active")
    rc, out, _ = probe(["git", "worktree", "list", "--porcelain"])
    bad = []
    for line in out.splitlines() if rc == 0 else []:
        if line.startswith("worktree "):
            path = line[9:]
            if os.path.exists(os.path.join(path, ".gitmodules")) and not os.path.exists(os.path.join(path, ".claude", "settings.json")):
                bad.append(path)
    if bad:
        r.fix("agent worktrees", f"{', '.join(bad)} have no .claude/settings.json (submodules missing): "
              "`git submodule update --init` in each")
    elif rc == 0:
        r.ok("every worktree has its submodules")


def run(r, cfg_project):
    """All the sandbox checks, onto the doctor's report `r`."""
    cfg = settings()
    me = os.environ.get("USER") or os.environ.get("LOGNAME") or (probe(["id", "-un"])[1].strip())
    uid = os.getuid()
    if not cfg["known"]:
        r.note("sandbox", f"{M.config_path()} is missing: `sudo factory bootstrap machine --apply` was not run here; "
               "checking this user as it is")
    identity(r, cfg, me)
    network(r, cfg)
    gap_one(r, cfg, uid)
    gap_two(r, default_gateway())
    rootless(r, uid)
    services(r, cfg_project)
