#!/usr/bin/env python3
"""The machine part of `factory bootstrap` (#105): the steps that need root, built as data (see factory_bootstrap_core).

Packages, the dedicated user, its subuid/subgid ranges, linger, the network guard, and (opt in) key-only SSH and a
machine that stays awake. Ubuntu and Debian with systemd. Nothing runs from here: `steps()` only reads the machine
(`id`, `ss`, `resolvectl`, the os-release file) and returns the list.
"""
import grp, hashlib, json, os, platform, pwd, re, urllib.request

import factory_netguard as G
from factory_bootstrap_core import BootstrapError, Call, Mkdir, Run, Step, Write, probe

ROOT = os.environ.get("FACTORY_BOOTSTRAP_ROOT", "")
PACKAGES = ["uidmap", "slirp4netns", "dbus-user-session", "git", "python3", "gh", "age", "tmux", "curl",
            "ca-certificates", "nftables"]
PRIVILEGE_GROUPS = ["sudo", "docker", "wheel", "admin", "lxd"]
SUBID_COUNT = 65536


def P(path):
    """A system path, under FACTORY_BOOTSTRAP_ROOT when that is set (tests)."""
    return ROOT + path


def manifest_path():
    return P("/var/lib/software-factory/bootstrap.json")


def config_path():
    return P("/etc/software-factory/sandbox.json")


def rules_path():
    return P("/etc/software-factory/net-guard.nft")


def unit_path():
    return P("/etc/systemd/system/" + G.UNIT_NAME)


def read(path, default=""):
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return default


def os_release():
    d = {}
    for line in read(P("/etc/os-release")).splitlines():
        k, _, v = line.partition("=")
        d[k] = v.strip('"')
    return d


def check_platform():
    rel = os_release()
    ids = {rel.get("ID", ""), *rel.get("ID_LIKE", "").split()}
    if platform.system() != "Linux" and not ROOT:
        raise BootstrapError("unsupported-os", f"`factory bootstrap` supports Linux for now, not {platform.system()}.",
                             "Set the machine up by hand (docs/wiki/sandboxed-machine.md, 'Security notes'); macOS comes later.")
    if not ids & {"ubuntu", "debian"}:
        raise BootstrapError("unsupported-os", f"This is {rel.get('PRETTY_NAME') or 'an unknown system'}; bootstrap supports "
                             "Ubuntu and Debian with systemd first.", "Follow the same steps by hand with your package manager.")


def user_exists(user):
    try:
        pwd.getpwnam(user)
        return True
    except KeyError:
        return probe(["id", "-u", user])[0] == 0


def user_uid(user):
    try:
        return pwd.getpwnam(user).pw_uid
    except KeyError:
        rc, out, _ = probe(["id", "-u", user])
        return int(out.strip()) if rc == 0 and out.strip().isdigit() else None


def user_groups(user):
    rc, out, _ = probe(["id", "-nG", user])
    return out.split() if rc == 0 else []


def admin_account():
    """(name, home) of whoever ran sudo; ('', '') when it cannot be told."""
    name = os.environ.get("SUDO_USER", "")
    if not name or name == "root":
        return "", ""
    try:
        return name, pwd.getpwnam(name).pw_dir
    except KeyError:
        return name, ""


def subid_free_start(path):
    top = 100000
    for line in read(path).splitlines():
        parts = line.split(":")
        if len(parts) == 3 and parts[1].isdigit() and parts[2].isdigit():
            top = max(top, int(parts[1]) + int(parts[2]))
    return top


def has_subid(path, user, uid):
    return any(l.split(":")[0] in (user, str(uid)) for l in read(path).splitlines() if l)


def on_battery():
    base = P("/sys/class/power_supply")
    try:
        return any(n.startswith("BAT") for n in os.listdir(base))
    except OSError:
        return False


def install_sops():
    """The sops release binary for this CPU, its checksum checked against the release's own checksums file (sops is not
    in the Ubuntu repositories). Nothing is installed when the checksum differs."""
    arch = {"x86_64": "amd64", "aarch64": "arm64"}.get(platform.machine())
    if not arch:
        raise BootstrapError("unsupported-cpu", f"No sops release for {platform.machine()}.", "Install sops by hand.")

    def get(url):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                return r.read()
        except OSError as e:  # URLError is an OSError
            raise BootstrapError("download", f"Could not download {url} ({e}).",
                                 "Check the internet connection, then run the command again.")
    tag = json.loads(get("https://api.github.com/repos/getsops/sops/releases/latest"))["tag_name"]
    base = f"https://github.com/getsops/sops/releases/download/{tag}"
    name = f"sops-{tag}.linux.{arch}"
    blob = get(f"{base}/{name}")
    sums = get(f"{base}/sops-{tag}.checksums.txt").decode()
    want = next((l.split()[0] for l in sums.splitlines() if l.split()[-1:] == [name]), "")
    if not want or hashlib.sha256(blob).hexdigest() != want:
        raise BootstrapError("checksum", f"The sops download does not match its published checksum ({name}).",
                             "Nothing was installed. Try again later, or install sops by hand.")
    dest = P("/usr/local/bin/sops")
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest + ".tmp", "wb") as f:
        f.write(blob)
    os.chmod(dest + ".tmp", 0o755)
    os.replace(dest + ".tmp", dest)


def pubkeys(path):
    """The lines of a public-key file; a private key is refused."""
    text = read(path)
    if not text:
        raise BootstrapError("no-keys", f"{path} is empty or unreadable.", "Give --authorized-keys a file of public keys.")
    if "PRIVATE KEY" in text:
        raise BootstrapError("private-key", f"{path} holds a private key.", "Give a public key file (ends in .pub).")
    keys = [l for l in text.splitlines() if l.strip() and not l.startswith("#")]
    if not keys or not all(re.match(r"(ssh-|ecdsa-|sk-)", k) for k in keys):
        raise BootstrapError("bad-keys", f"{path} does not hold only public keys.", "Use lines such as `ssh-ed25519 AAAA... name`.")
    return "\n".join(keys) + "\n"


def sandbox_config(opts):
    return {"user": opts["user"], "egress": opts["egress"], "allowHosts": opts["allow_hosts"],
            "blockLoopbackPorts": opts["block_loopback_ports"], "blockInboundPorts": opts["block_inbound_ports"]}


def guard_text(opts, uid_token_fn):
    """The rules for the options: the configured loopback ports plus the ones other users' services listen on now."""
    rc, ss, _ = probe(["ss", "-ltnHe"])
    uid = user_uid(opts["user"])
    found = G.listening_ports_not_owned(ss, uid if uid else -1) if rc == 0 else []
    ports = sorted({*map(str, found), *opts["block_loopback_ports"]}, key=lambda p: int(p.split("-")[0]))
    rc, rl, _ = probe(["resolvectl", "dns"])
    resolvers = G.resolvers_from(read(P("/etc/resolv.conf")), rl if rc == 0 else "")
    return G.render_rules(uid_token_fn(), resolvers, opts["allow_hosts"], ports, opts["block_inbound_ports"], opts["egress"])


def steps(opts):
    """The machine steps for `opts` (user, egress, allow_hosts, block_loopback_ports, block_inbound_ports,
    authorized_keys, harden_ssh, keep_awake)."""
    check_platform()
    user = opts["user"]
    admin, admin_home = admin_account()
    out = []

    def packages_missing():
        return [p for p in PACKAGES
                if "install ok installed" not in probe(["dpkg-query", "-W", "-f=${Status}", p])[1]]
    missing = packages_missing()
    out.append(Step("packages", "Install the packages rootless Docker and the factory need",
                    [Run(["apt-get", "update", "-q"], env={"DEBIAN_FRONTEND": "noninteractive"}),
                     Run(["apt-get", "install", "-y", "-q", *missing], env={"DEBIAN_FRONTEND": "noninteractive"})],
                    done=lambda: not packages_missing(), privileged=True,
                    record={"packages": missing}) if missing else
               Step("packages", "Packages are installed", [], done=lambda: True, privileged=True))
    out.append(Step("sops", "Install sops (release binary, checksum checked)", [Call(install_sops, "download sops")],
                    done=lambda: os.path.exists(P("/usr/local/bin/sops")) or probe(["sops", "--version"])[0] == 0,
                    privileged=True, record={"files": [P("/usr/local/bin/sops")]}))
    existed = user_exists(user)
    out.append(Step("user", f"Create the user {user} (no sudo, no docker group, no password)",
                    [Run(["adduser", "--disabled-password", "--gecos", "Software factory", user])],
                    done=lambda: user_exists(user), privileged=True, record={"user": user, "created": not existed}))
    bad = [g for g in user_groups(user) if g in PRIVILEGE_GROUPS]

    def hardened():
        if [g for g in user_groups(user) if g in PRIVILEGE_GROUPS]:
            return False
        homes = [h for h in (admin_home, os.path.expanduser(f"~{user}")) if h and os.path.isdir(h)]
        return all((os.stat(h).st_mode & 0o007) == 0 for h in homes)
    actions = [Run(["gpasswd", "-d", user, g]) for g in bad]
    if admin_home:
        actions.append(Run(["chmod", "750", admin_home]))
    actions.append(Run(["chmod", "750", f"/home/{user}"]))
    out.append(Step("isolate", f"Keep {user} out of sudo/docker groups and the admin's home unreadable", actions,
                    done=hardened, privileged=True, record={"adminHome": admin_home, "admin": admin}))
    if opts.get("authorized_keys"):
        keys = pubkeys(opts["authorized_keys"])
        ssh_dir = P(f"/home/{user}/.ssh")
        target = os.path.join(ssh_dir, "authorized_keys")
        out.append(Step("ssh-keys", f"Let the given public keys log in as {user}",
                        [Mkdir(ssh_dir, 0o700, user), Write(target, keys, 0o600, user)],
                        done=lambda: read(target) == keys, privileged=True, record={"files": [target]}))
    uid = user_uid(user)
    subs = [Run(["usermod", "--add-subuids", f"{subid_free_start(P('/etc/subuid'))}-{subid_free_start(P('/etc/subuid')) + SUBID_COUNT - 1}",
                 "--add-subgids", f"{subid_free_start(P('/etc/subgid'))}-{subid_free_start(P('/etc/subgid')) + SUBID_COUNT - 1}", user])]
    out.append(Step("subids", "Give the user subuid/subgid ranges (rootless containers)", subs,
                    done=lambda: has_subid(P("/etc/subuid"), user, uid) and has_subid(P("/etc/subgid"), user, uid),
                    privileged=True))
    out.append(Step("linger", "Let the user's services run without a login (loginctl enable-linger)",
                    [Run(["loginctl", "enable-linger", user])],
                    done=lambda: probe(["loginctl", "show-user", user, "-p", "Linger", "--value"])[1].strip() == "yes",
                    privileged=True))
    keep = opts.get("keep_awake")
    if keep or (keep is None and on_battery()):
        drop = P("/etc/systemd/logind.conf.d/50-factory.conf")
        awake_text = "[Login]\nHandleLidSwitch=ignore\nHandleLidSwitchExternalPower=ignore\nHandleLidSwitchDocked=ignore\n"
        targets = ["sleep.target", "suspend.target", "hibernate.target", "hybrid-sleep.target"]
        out.append(Step("keep-awake", "Keep the machine awake: no sleep or suspend, lid ignored",
                        [Run(["systemctl", "mask", *targets]), Write(drop, awake_text), Run(["systemctl", "restart", "systemd-logind"])],
                        done=lambda: read(drop) == awake_text, privileged=True,
                        record={"files": [drop], "masked": targets}))
    cfg = sandbox_config(opts)
    cfg_text = json.dumps(cfg, indent=2, sort_keys=True) + "\n"
    out.append(Step("sandbox-config", "Write the sandbox settings (/etc/software-factory/sandbox.json)",
                    [Write(config_path(), cfg_text)], done=lambda: read(config_path()) == cfg_text,
                    privileged=True, record={"files": [config_path()]}))
    unit = G.render_unit("/etc/software-factory/net-guard.nft")

    def guard_current():
        if not user_uid(user):
            return False
        want = guard_text(opts, lambda: user_uid(user) or "$UID_F")
        return read(rules_path()) == want and read(unit_path()) == unit and \
            probe(["systemctl", "is-active", "--quiet", G.UNIT_NAME])[0] == 0
    out.append(Step("net-guard", "Install the network guard: the internet is open, the home network and other users' "
                    "local services are not", [
                        Write(rules_path(), lambda ctx: guard_text(opts, ctx.uid)),
                        Write(unit_path(), unit),
                        Run(["systemctl", "daemon-reload"]), Run(["systemctl", "enable", G.UNIT_NAME]),
                        Run(["systemctl", "restart", G.UNIT_NAME])],
                    done=guard_current, privileged=True,
                    record={"files": [rules_path(), unit_path()], "units": [G.UNIT_NAME], "table": G.TABLE}))
    if opts.get("harden_ssh"):
        conf = P("/etc/ssh/sshd_config.d/50-factory.conf")
        ssh_text = "PasswordAuthentication no\nPermitRootLogin no\nKbdInteractiveAuthentication no\n"
        out.append(Step("ssh-hardening", "Key-only SSH, no root login (you asked for it with --harden-ssh)",
                        [Write(conf, ssh_text), Run(["sshd", "-t"]), Run(["systemctl", "reload", "ssh"])],
                        done=lambda: read(conf) == ssh_text, privileged=True, record={"files": [conf]}))
    return out
