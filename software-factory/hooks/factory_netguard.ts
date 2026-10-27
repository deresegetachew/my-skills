#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// The network guard of a sandboxed factory machine (#105): renders the nftables rules and the systemd unit that
// keep the dedicated user (default `factory`) away from the home network, and reads the facts the rules need.
//
// Policy (the default): the internet is open (GitHub, npm, the Claude API); the home network is not (RFC1918, the
// Tailscale range 100.64.0.0/10, link-local, IPv6 ULA and tailnet); the user's DNS goes to the resolver only; loopback
// services of other users are not reachable. Everything here only builds text. Nothing runs until
// `factory bootstrap machine --apply` installs it as root.
//
//   bun --no-env-file --config=/dev/null factory_netguard.ts render --uid 1001 [--resolver ADDR] [--allow-host ADDR[:PORT]] ...   print the rules
//
// Rendering is deterministic (same inputs, same text), so a re-run of bootstrap can tell whether anything changed.
import { isIP } from "node:net";
import { die, pyRepr, runMain } from "./factory_lib.ts";

const DOC = `The network guard of a sandboxed factory machine (#105): renders the nftables rules and the systemd unit that
keep the dedicated user (default \`factory\`) away from the home network, and reads the facts the rules need.

Policy (the default): the internet is open (GitHub, npm, the Claude API); the home network is not (RFC1918, the
Tailscale range 100.64.0.0/10, link-local, IPv6 ULA and tailnet); the user's DNS goes to the resolver only; loopback
services of other users are not reachable. Everything here only builds text. Nothing runs until
\`factory bootstrap machine --apply\` installs it as root.

  bun --no-env-file --config=/dev/null factory_netguard.ts render --uid 1001 [--resolver ADDR] [--allow-host ADDR[:PORT]] ...   print the rules

Rendering is deterministic (same inputs, same text), so a re-run of bootstrap can tell whether anything changed.
`;

export const TABLE = "factory_guard";
export const PREFIX_BLOCK = "FACTORY-BLOCK ";
export const PREFIX_INBOUND = "FACTORY-INBOUND ";
export const UNIT_NAME = "factory-net-guard.service";
export const PRIVATE_V4 = ["192.168.0.0/16", "10.0.0.0/8", "172.16.0.0/12", "100.64.0.0/10", "169.254.0.0/16"];
export const PRIVATE_V6 = ["fd7a:115c:a1e0::/48", "fe80::/10", "fc00::/7"];

/** A bad input to the guard (Python's GuardError, a ValueError). */
export class GuardError extends Error {}

/** Python's repr of a value given as a str or an int. */
function shown(v: unknown): string {
  return typeof v === "string" ? pyRepr(v) : String(v);
}

/** '5432' or '4100-4199' as a normalised string; GuardError when it is neither. */
export function parsePort(text: string | number): string {
  const t = String(text).trim();
  const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(t);
  if (!m) throw new GuardError(`${pyRepr(t)} is not a port or a port range`);
  const lo = Number(m[1]);
  const hi = Number(m[2] ?? m[1]);
  if (!(1 <= lo && lo <= hi && hi <= 65535)) throw new GuardError(`${pyRepr(t)} is outside 1-65535`);
  return lo === hi ? String(lo) : `${lo}-${hi}`;
}

/** '192.168.2.10' or '192.168.2.10:5432' (a host that stays reachable although it is on the home network, such as
 * a Postgres or a build cache) as [address, port or null]. */
export function parseAllowHost(text: string): [string, string | null] {
  const t = String(text).trim();
  let host = t;
  let port = "";
  if (t.split(":").length - 1 === 1) [host, port] = t.split(":") as [string, string];
  const version = isIP(host);
  if (!version) throw new GuardError(`${pyRepr(t)} is not an IP address (with an optional :port); use the address, not a name`);
  if (version !== 4) throw new GuardError(`${pyRepr(t)}: only IPv4 hosts can be allowed for now`);
  return [host, port ? parsePort(port) : null];
}

function isLoopback4(a: string): boolean {
  return a.startsWith("127.");
}

/** The DNS server addresses to allow. A systemd-resolved stub (127.0.0.53) is on loopback and needs no rule; the
 * real servers behind it come from `resolvectl dns`. Returns IPv4 strings, in order, without duplicates. */
export function resolversFrom(resolvConf: string | null | undefined, resolvectlText = ""): string[] {
  const found: string[] = [];
  for (const text of [resolvConf || "", resolvectlText || ""]) {
    for (const m of text.matchAll(/(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])/g)) {
      const a = m[1] as string;
      if (isIP(a) !== 4 || isLoopback4(a) || found.includes(a)) continue;
      found.push(a);
    }
  }
  return found;
}

/** Loopback or wildcard TCP ports with a listener owned by someone other than `uid`, from `ss -ltnHe` output (gap 1
 * of #105: the loopback ports of the admin's other services). Returns a sorted list of ports. */
export function listeningPortsNotOwned(ssOutput: string | null | undefined, uid: number | string): number[] {
  const ports = new Set<number>();
  for (const line of (ssOutput || "").split(/\r\n|\r|\n/)) {
    const cols = line.split(/\s+/).filter(Boolean);
    if (cols.length < 5) continue;
    const col = cols[3] as string;
    const i = col.lastIndexOf(":");
    const port = i >= 0 ? col.slice(i + 1) : col;
    const addr = (i >= 0 ? col.slice(0, i) : "").replace(/^[[\]]+|[[\]]+$/g, "");
    if (!/^\d+$/.test(port) || !(addr.startsWith("127.") || ["0.0.0.0", "*", "::", "::1"].includes(addr))) continue;
    if (addr === "127.0.0.53" || addr === "127.0.0.54") continue; // the resolver stub: the factory user's own DNS needs it
    const owner = /\buid:(\d+)/.exec(line);
    if (owner && Number(owner[1]) === Number(uid)) continue;
    ports.add(Number(port));
  }
  return [...ports].sort((a, b) => a - b);
}

function set(items: readonly string[]): string {
  return "{ " + items.join(", ") + " }";
}

function sortedPorts(items: readonly (string | number)[]): string[] {
  const lo = (p: string): number => Number(p.split("-")[0]);
  return [...new Set(items.map(parsePort))].sort((a, b) => lo(a) - lo(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/** The nftables ruleset text. `uid` is the dedicated user's uid (or a shell variable such as $UID_F while only
 * planning); `egress` is 'internet' (default) or 'none'. */
export function renderRules(uid: number | string, resolvers: readonly string[] = [], allowHosts: readonly string[] = [],
  blockLoopbackPorts: readonly (string | number)[] = [], blockInboundPorts: readonly (string | number)[] = [],
  egress = "internet"): string {
  const u = String(uid);
  if (/^\$[A-Z_]+$/.test(u)) {
    // a shell variable, while only planning or writing a script: the script sets it with `id -u`
  } else if (!/^\d+$/.test(u) || Number(u) < 1) {
    throw new GuardError(`the user's uid must be a positive number, got ${shown(uid)}`);
  }
  if (egress !== "internet" && egress !== "none") throw new GuardError(`egress must be 'internet' or 'none', got ${shown(egress)}`);
  const who = u.startsWith("$") ? u : String(Number(u));
  const hosts = allowHosts.map(parseAllowHost);
  const loopPorts = sortedPorts(blockLoopbackPorts);
  const inPorts = sortedPorts(blockInboundPorts);
  const out = ["# Written by `factory bootstrap machine`. Edit the settings and run it again, not this file.",
    `# The sandbox for uid ${who}: internet ${egress === "internet" ? "open" : "closed"}, home network closed.`,
    `add table inet ${TABLE}`, `delete table inet ${TABLE}`, `table inet ${TABLE} {`,
    "  chain output {", "    type filter hook output priority 0; policy accept;"];
  for (const r of resolvers) {
    const v = isIP(r);
    if (!v) throw new Error(`${pyRepr(r)} does not appear to be an IPv4 or IPv6 address`);
    if (v === 4) out.push(`    meta skuid ${who} ip daddr ${r} meta l4proto { tcp, udp } th dport 53 accept`);
  }
  for (const [addr, port] of hosts) {
    const dport = port ? ` tcp dport ${port}` : "";
    out.push(`    meta skuid ${who} ip daddr ${addr}${dport} accept`);
  }
  if (egress === "none") out.push(`    meta skuid ${who} oifname != "lo" log prefix "${PREFIX_BLOCK}" drop`);
  else {
    out.push(`    meta skuid ${who} ip daddr ${set(PRIVATE_V4)} log prefix "${PREFIX_BLOCK}" drop`);
    out.push(`    meta skuid ${who} ip6 daddr ${set(PRIVATE_V6)} log prefix "${PREFIX_BLOCK}" drop`);
  }
  if (loopPorts.length) {
    out.push(`    meta skuid ${who} ip daddr 127.0.0.0/8 tcp dport ${set(loopPorts)} log prefix "${PREFIX_BLOCK}" drop`);
  }
  out.push("  }", "  chain input {", "    type filter hook input priority 0; policy accept;", "    iif lo accept");
  if (inPorts.length) out.push(`    tcp dport ${set(inPorts)} log prefix "${PREFIX_INBOUND}" drop`);
  out.push("  }", "}", "");
  return out.join("\n");
}

/** The systemd unit that loads the rules at boot (and reloads them on restart). */
export function renderUnit(rulesPath: string, nft = "/usr/sbin/nft"): string {
  return [
    "[Unit]", "Description=Network sandbox rules for the software-factory user",
    "After=network-online.target", "Wants=network-online.target", "",
    "[Service]", "Type=oneshot", "RemainAfterExit=yes",
    `ExecStart=${nft} -f ${rulesPath}`, `ExecStop=-${nft} delete table inet ${TABLE}`, "",
    "[Install]", "WantedBy=multi-user.target", ""].join("\n");
}

const PROG = "factory_netguard.ts render";
const USAGE = `usage: ${PROG} [-h] --uid UID [--resolver RESOLVER]
                                  [--allow-host ALLOW_HOST]
                                  [--block-loopback-port BLOCK_LOOPBACK_PORT]
                                  [--block-inbound-port BLOCK_INBOUND_PORT]
                                  [--egress EGRESS]
`;
const HELP = `${USAGE}
options:
  -h, --help            show this help message and exit
  --uid UID
  --resolver RESOLVER
  --allow-host ALLOW_HOST
  --block-loopback-port BLOCK_LOOPBACK_PORT
  --block-inbound-port BLOCK_INBOUND_PORT
  --egress EGRESS
`;

function argError(message: string): never {
  process.stderr.write(USAGE + `${PROG}: error: ${message}\n`);
  die(2);
}

interface RenderArgs {
  uid: string | null;
  resolver: string[];
  allowHost: string[];
  blockLoopbackPort: string[];
  blockInboundPort: string[];
  egress: string;
}

const OPTIONS = ["--help", "--uid", "--resolver", "--allow-host", "--block-loopback-port", "--block-inbound-port", "--egress"];

/** argparse for `render`, by hand: the same options (unique prefixes too), errors (exit 2) and help. */
function parseRender(argv: string[]): RenderArgs {
  const a: RenderArgs = { uid: null, resolver: [], allowHost: [], blockLoopbackPort: [], blockInboundPort: [], egress: "internet" };
  const extra: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i] as string;
    if (arg === "-h") arg = "--help";
    if (!arg.startsWith("--") || arg === "--") {
      extra.push(arg);
      continue;
    }
    let value: string | undefined;
    const eq = arg.indexOf("=");
    if (eq > 0) {
      value = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    const hits = OPTIONS.includes(arg) ? [arg] : OPTIONS.filter((o) => o.startsWith(arg));
    if (hits.length > 1) argError(`ambiguous option: ${arg} could match ${hits.join(", ")}`);
    const opt = hits[0];
    if (!opt) {
      extra.push(argv[i] as string);
      continue;
    }
    if (opt === "--help") {
      process.stdout.write(HELP);
      die(0);
    }
    if (value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith("-") && next !== "-")) {
        argError(`argument ${opt}: expected one argument`);
      }
      value = next;
      i++;
    }
    if (opt === "--uid") a.uid = value;
    else if (opt === "--resolver") a.resolver.push(value);
    else if (opt === "--allow-host") a.allowHost.push(value);
    else if (opt === "--block-loopback-port") a.blockLoopbackPort.push(value);
    else if (opt === "--block-inbound-port") a.blockInboundPort.push(value);
    else a.egress = value;
  }
  if (a.uid === null) argError("the following arguments are required: --uid");
  if (extra.length) argError(`unrecognized arguments: ${extra.join(" ")}`);
  return a;
}

export function main(argv: string[]): number {
  if (!argv.length || argv[0] !== "render") {
    process.stdout.write(DOC + "\n");
    return 0;
  }
  const a = parseRender(argv.slice(1));
  try {
    process.stdout.write(renderRules(a.uid as string, a.resolver, a.allowHost, a.blockLoopbackPort, a.blockInboundPort, a.egress));
  } catch (e) {
    if (!(e instanceof GuardError)) throw e;
    process.stderr.write(`factory: ${e.message}\n`);
    return 1;
  }
  return 0;
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
