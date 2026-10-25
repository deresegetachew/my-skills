#!/usr/bin/env python3
"""The network guard of a sandboxed factory machine (#105): renders the nftables rules and the systemd unit that
keep the dedicated user (default `factory`) away from the home network, and reads the facts the rules need.

Policy (the default): the internet is open (GitHub, npm, the Claude API); the home network is not (RFC1918, the
Tailscale range 100.64.0.0/10, link-local, IPv6 ULA and tailnet); the user's DNS goes to the resolver only; loopback
services of other users are not reachable. Everything here only builds text. Nothing runs until
`factory bootstrap machine --apply` installs it as root.

  python3 factory_netguard.py render --uid 1001 [--resolver ADDR] [--allow-host ADDR[:PORT]] ...   print the rules

Rendering is deterministic (same inputs, same text), so a re-run of bootstrap can tell whether anything changed.
"""
import ipaddress, os, re, sys

TABLE = "factory_guard"
PREFIX_BLOCK = "FACTORY-BLOCK "
PREFIX_INBOUND = "FACTORY-INBOUND "
UNIT_NAME = "factory-net-guard.service"
PRIVATE_V4 = ["192.168.0.0/16", "10.0.0.0/8", "172.16.0.0/12", "100.64.0.0/10", "169.254.0.0/16"]
PRIVATE_V6 = ["fd7a:115c:a1e0::/48", "fe80::/10", "fc00::/7"]


class GuardError(ValueError):
    pass


def parse_port(text):
    """'5432' or '4100-4199' as a normalised string; GuardError when it is neither."""
    text = str(text).strip()
    m = re.fullmatch(r"(\d{1,5})(?:-(\d{1,5}))?", text)
    if not m:
        raise GuardError(f"{text!r} is not a port or a port range")
    lo, hi = int(m.group(1)), int(m.group(2) or m.group(1))
    if not (1 <= lo <= hi <= 65535):
        raise GuardError(f"{text!r} is outside 1-65535")
    return str(lo) if lo == hi else f"{lo}-{hi}"


def parse_allow_host(text):
    """'192.168.2.10' or '192.168.2.10:5432' (a host that stays reachable although it is on the home network, such as
    a Postgres or a build cache) as (address, port or None)."""
    text = str(text).strip()
    host, _, port = text.partition(":") if text.count(":") == 1 else (text, "", "")
    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        raise GuardError(f"{text!r} is not an IP address (with an optional :port); use the address, not a name")
    if addr.version != 4:
        raise GuardError(f"{text!r}: only IPv4 hosts can be allowed for now")
    return str(addr), (parse_port(port) if port else None)


def resolvers_from(resolv_conf, resolvectl_text=""):
    """The DNS server addresses to allow. A systemd-resolved stub (127.0.0.53) is on loopback and needs no rule; the
    real servers behind it come from `resolvectl dns`. Returns IPv4 strings, in order, without duplicates."""
    found = []
    for text in (resolv_conf or "", resolvectl_text or ""):
        for m in re.finditer(r"(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])", text):
            try:
                a = ipaddress.ip_address(m.group(1))
            except ValueError:
                continue
            if a.is_loopback or str(a) in found:
                continue
            found.append(str(a))
    return found


def listening_ports_not_owned(ss_output, uid):
    """Loopback or wildcard TCP ports with a listener owned by someone other than `uid`, from `ss -ltnHe` output (gap 1
    of #105: the loopback ports of the admin's other services). Returns a sorted list of ports."""
    ports = set()
    for line in (ss_output or "").splitlines():
        cols = line.split()
        if len(cols) < 5:
            continue
        addr, _, port = cols[3].rpartition(":")
        addr = addr.strip("[]")
        if not port.isdigit() or not (addr.startswith("127.") or addr in ("0.0.0.0", "*", "::", "::1")):
            continue
        if addr in ("127.0.0.53", "127.0.0.54"):
            continue  # the resolver stub: the factory user's own DNS needs it
        owner = re.search(r"\buid:(\d+)", line)
        if owner and int(owner.group(1)) == int(uid):
            continue
        ports.add(int(port))
    return sorted(ports)


def _set(items):
    return "{ " + ", ".join(items) + " }"


def render_rules(uid, resolvers=(), allow_hosts=(), block_loopback_ports=(), block_inbound_ports=(), egress="internet"):
    """The nftables ruleset text. `uid` is the dedicated user's uid; `egress` is 'internet' (default) or 'none'."""
    if re.fullmatch(r"\$[A-Z_]+", str(uid)):
        pass  # a shell variable, while only planning or writing a script: the script sets it with `id -u`
    elif not str(uid).isdigit() or int(uid) < 1:
        raise GuardError(f"the user's uid must be a positive number, got {uid!r}")
    if egress not in ("internet", "none"):
        raise GuardError(f"egress must be 'internet' or 'none', got {egress!r}")
    uid = str(uid) if str(uid).startswith("$") else int(uid)
    hosts = [parse_allow_host(h) for h in allow_hosts]
    loop_ports = sorted({parse_port(p) for p in block_loopback_ports}, key=lambda p: int(p.split("-")[0]))
    in_ports = sorted({parse_port(p) for p in block_inbound_ports}, key=lambda p: int(p.split("-")[0]))
    out = [f"# Written by `factory bootstrap machine`. Edit the settings and run it again, not this file.",
           f"# The sandbox for uid {uid}: internet {'open' if egress == 'internet' else 'closed'}, home network closed.",
           f"add table inet {TABLE}", f"delete table inet {TABLE}", f"table inet {TABLE} {{",
           "  chain output {", "    type filter hook output priority 0; policy accept;"]
    for r in resolvers:
        a = ipaddress.ip_address(r)
        if a.version == 4:
            out.append(f"    meta skuid {uid} ip daddr {a} meta l4proto {{ tcp, udp }} th dport 53 accept")
    for addr, port in hosts:
        dport = f" tcp dport {port}" if port else ""
        out.append(f"    meta skuid {uid} ip daddr {addr}{dport} accept")
    if egress == "none":
        out.append(f"    meta skuid {uid} oifname != \"lo\" log prefix \"{PREFIX_BLOCK}\" drop")
    else:
        out.append(f"    meta skuid {uid} ip daddr {_set(PRIVATE_V4)} log prefix \"{PREFIX_BLOCK}\" drop")
        out.append(f"    meta skuid {uid} ip6 daddr {_set(PRIVATE_V6)} log prefix \"{PREFIX_BLOCK}\" drop")
    if loop_ports:
        out.append(f"    meta skuid {uid} ip daddr 127.0.0.0/8 tcp dport {_set(loop_ports)} "
                   f"log prefix \"{PREFIX_BLOCK}\" drop")
    out += ["  }", "  chain input {", "    type filter hook input priority 0; policy accept;", "    iif lo accept"]
    if in_ports:
        out.append(f"    tcp dport {_set(in_ports)} log prefix \"{PREFIX_INBOUND}\" drop")
    out += ["  }", "}", ""]
    return "\n".join(out)


def render_unit(rules_path, nft="/usr/sbin/nft"):
    """The systemd unit that loads the rules at boot (and reloads them on restart)."""
    return "\n".join([
        "[Unit]", "Description=Network sandbox rules for the software-factory user",
        "After=network-online.target", "Wants=network-online.target", "",
        "[Service]", "Type=oneshot", "RemainAfterExit=yes",
        f"ExecStart={nft} -f {rules_path}", f"ExecStop=-{nft} delete table inet {TABLE}", "",
        "[Install]", "WantedBy=multi-user.target", ""])


def main(argv):
    if not argv or argv[0] != "render":
        print(__doc__)
        return 0
    import argparse
    ap = argparse.ArgumentParser(prog="factory_netguard.py render")
    ap.add_argument("--uid", required=True)
    ap.add_argument("--resolver", action="append", default=[])
    ap.add_argument("--allow-host", action="append", default=[])
    ap.add_argument("--block-loopback-port", action="append", default=[])
    ap.add_argument("--block-inbound-port", action="append", default=[])
    ap.add_argument("--egress", default="internet")
    a = ap.parse_args(argv[1:])
    try:
        print(render_rules(a.uid, a.resolver, a.allow_host, a.block_loopback_port, a.block_inbound_port, a.egress), end="")
    except GuardError as e:
        print(f"factory: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
