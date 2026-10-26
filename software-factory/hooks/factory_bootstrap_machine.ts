// The machine part of `factory bootstrap` (#105): the steps that need root, built as data (see factory_bootstrap_core).
//
// Packages, the dedicated user, its subuid/subgid ranges, linger, the network guard, and (opt in) key-only SSH and a
// machine that stays awake. Ubuntu and Debian with systemd. Nothing runs from here: `steps()` only reads the machine
// (`id`, `ss`, `resolvectl`, the os-release file) and returns the list.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir, machine as cpu, type as osType } from "node:os";
import { dirname, join } from "node:path";
import { BootstrapError, Call, getpwnam, Mkdir, probe, Run, Step, Write } from "./factory_bootstrap_core.ts";
import * as G from "./factory_netguard.ts";
import { pyDumps, splitLines } from "./factory_lib.ts";

/** Where the system paths live: FACTORY_BOOTSTRAP_ROOT when set (tests), else the real root. */
export let ROOT = process.env.FACTORY_BOOTSTRAP_ROOT ?? "";
/** Point the system paths somewhere else (tests; Python's `M.ROOT = ...`). */
export function setRoot(root: string): void {
  ROOT = root;
}
export const PACKAGES = ["uidmap", "slirp4netns", "dbus-user-session", "git", "python3", "gh", "age", "tmux", "curl",
  "ca-certificates", "nftables"];
export const PRIVILEGE_GROUPS = ["sudo", "docker", "wheel", "admin", "lxd"];
export const SUBID_COUNT = 65536;

/** A system path, under FACTORY_BOOTSTRAP_ROOT when that is set (tests). */
export function P(path: string): string {
  return ROOT + path;
}

export function manifestPath(): string {
  return P("/var/lib/software-factory/bootstrap.json");
}

export function configPath(): string {
  return P("/etc/software-factory/sandbox.json");
}

export function rulesPath(): string {
  return P("/etc/software-factory/net-guard.nft");
}

export function unitPath(): string {
  return P("/etc/systemd/system/" + G.UNIT_NAME);
}

export function read(path: string, dflt = ""): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return dflt;
  }
}

export function osRelease(): Record<string, string> {
  const d: Record<string, string> = {};
  for (const line of splitLines(read(P("/etc/os-release")))) {
    const i = line.indexOf("=");
    const k = i >= 0 ? line.slice(0, i) : line;
    const v = i >= 0 ? line.slice(i + 1) : "";
    d[k] = v.replace(/^"+|"+$/g, "");
  }
  return d;
}

/** Python's platform.system(): Linux, Darwin, Windows. */
export function systemName(): string {
  const t = osType();
  return t === "Windows_NT" ? "Windows" : t;
}

export function checkPlatform(): void {
  const rel = osRelease();
  const ids = new Set([rel.ID ?? "", ...(rel.ID_LIKE ?? "").split(/\s+/).filter(Boolean)]);
  if (systemName() !== "Linux" && !ROOT) {
    throw new BootstrapError("unsupported-os", `\`factory bootstrap\` supports Linux for now, not ${systemName()}.`,
      "Set the machine up by hand (docs/wiki/sandboxed-machine.md, 'Security notes'); macOS comes later.");
  }
  if (!ids.has("ubuntu") && !ids.has("debian")) {
    throw new BootstrapError("unsupported-os", `This is ${rel.PRETTY_NAME || "an unknown system"}; bootstrap supports ` +
      "Ubuntu and Debian with systemd first.", "Follow the same steps by hand with your package manager.");
  }
}

export function userExists(user: string): boolean {
  if (getpwnam(user)) return true;
  return probe(["id", "-u", user])[0] === 0;
}

export function userUid(user: string): number | null {
  const pw = getpwnam(user);
  if (pw) return pw.uid;
  const [rc, out] = probe(["id", "-u", user]);
  return rc === 0 && /^\d+$/.test(out.trim()) ? Number(out.trim()) : null;
}

export function userGroups(user: string): string[] {
  const [rc, out] = probe(["id", "-nG", user]);
  return rc === 0 ? out.split(/\s+/).filter(Boolean) : [];
}

/** [name, home] of whoever ran sudo; ["", ""] when it cannot be told. */
export function adminAccount(): [string, string] {
  const name = process.env.SUDO_USER ?? "";
  if (!name || name === "root") return ["", ""];
  const pw = getpwnam(name);
  return [name, pw ? pw.dir : ""];
}

export function subidFreeStart(path: string): number {
  let top = 100000;
  for (const line of read(path).split(/\r\n|\r|\n/)) {
    const parts = line.split(":");
    if (parts.length === 3 && /^\d+$/.test(parts[1] as string) && /^\d+$/.test(parts[2] as string)) {
      top = Math.max(top, Number(parts[1]) + Number(parts[2]));
    }
  }
  return top;
}

export function hasSubid(path: string, user: string, uid: number | null): boolean {
  return read(path).split(/\r\n|\r|\n/).some((l) => l && [user, String(uid ?? "None")].includes(l.split(":")[0] as string));
}

export function onBattery(): boolean {
  try {
    return readdirSync(P("/sys/class/power_supply")).some((n) => n.startsWith("BAT"));
  } catch {
    return false;
  }
}

/** How install_sops downloads: the bytes at a URL. Tests replace it (Python patched urllib.request.urlopen). */
export type Fetcher = (url: string) => Promise<Uint8Array>;

async function realFetch(url: string): Promise<Uint8Array> {
  const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`HTTP Error ${r.status}: ${r.statusText}`);
  return new Uint8Array(await r.arrayBuffer());
}

let fetcher: Fetcher = realFetch;
/** Replace the downloader (tests); call with no argument to restore the real one. */
export function setFetcher(f?: Fetcher): void {
  fetcher = f ?? realFetch;
}

/** The CPU name as Python's platform.machine() says it (x86_64, aarch64). Tests may override it. */
let machineName: () => string = () => cpu();
export function setMachine(f?: () => string): void {
  machineName = f ?? (() => cpu());
}

/** The sops release binary for this CPU, its checksum checked against the release's own checksums file (sops is not
 * in the Ubuntu repositories). Nothing is installed when the checksum differs. */
export async function installSops(): Promise<void> {
  const arch = ({ x86_64: "amd64", aarch64: "arm64" } as Record<string, string>)[machineName()];
  if (!arch) throw new BootstrapError("unsupported-cpu", `No sops release for ${machineName()}.`, "Install sops by hand.");

  const get = async (url: string): Promise<Uint8Array> => {
    try {
      return await fetcher(url);
    } catch (e) {
      throw new BootstrapError("download", `Could not download ${url} (${e instanceof Error ? e.message : String(e)}).`,
        "Check the internet connection, then run the command again.");
    }
  };
  const latest: unknown = JSON.parse(new TextDecoder().decode(await get("https://api.github.com/repos/getsops/sops/releases/latest")));
  const tag = String((latest as { tag_name?: unknown }).tag_name);
  const base = `https://github.com/getsops/sops/releases/download/${tag}`;
  const name = `sops-${tag}.linux.${arch}`;
  const blob = await get(`${base}/${name}`);
  const sums = new TextDecoder().decode(await get(`${base}/sops-${tag}.checksums.txt`));
  let want = "";
  for (const l of sums.split(/\r\n|\r|\n/)) {
    const w = l.split(/\s+/).filter(Boolean);
    if (w.length && w[w.length - 1] === name) {
      want = w[0] as string;
      break;
    }
  }
  if (!want || createHash("sha256").update(blob).digest("hex") !== want) {
    throw new BootstrapError("checksum", `The sops download does not match its published checksum (${name}).`,
      "Nothing was installed. Try again later, or install sops by hand.");
  }
  const dest = P("/usr/local/bin/sops");
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest + ".tmp", blob);
  chmodSync(dest + ".tmp", 0o755);
  renameSync(dest + ".tmp", dest);
}

/** The lines of a public-key file; a private key is refused. */
export function pubkeys(path: string): string {
  const text = read(path);
  if (!text) throw new BootstrapError("no-keys", `${path} is empty or unreadable.`, "Give --authorized-keys a file of public keys.");
  if (text.includes("PRIVATE KEY")) throw new BootstrapError("private-key", `${path} holds a private key.`, "Give a public key file (ends in .pub).");
  const keys = text.split(/\r\n|\r|\n/).filter((l) => l.trim() && !l.startsWith("#"));
  if (!keys.length || !keys.every((k) => /^(ssh-|ecdsa-|sk-)/.test(k))) {
    throw new BootstrapError("bad-keys", `${path} does not hold only public keys.`, "Use lines such as `ssh-ed25519 AAAA... name`.");
  }
  return keys.join("\n") + "\n";
}

/** The options of `factory bootstrap machine`. */
export interface MachineOptions {
  user: string;
  egress: string;
  allow_hosts: string[];
  block_loopback_ports: string[];
  block_inbound_ports: string[];
  authorized_keys?: string | null;
  harden_ssh?: boolean;
  keep_awake?: boolean | null;
}

export function sandboxConfig(opts: MachineOptions): Record<string, unknown> {
  return { user: opts.user, egress: opts.egress, allowHosts: opts.allow_hosts,
    blockLoopbackPorts: opts.block_loopback_ports, blockInboundPorts: opts.block_inbound_ports };
}

/** The rules for the options: the configured loopback ports plus the ones other users' services listen on now. */
export function guardText(opts: MachineOptions, uidToken: () => number | string): string {
  const [rc, ss] = probe(["ss", "-ltnHe"]);
  const uid = userUid(opts.user);
  const found = rc === 0 ? G.listeningPortsNotOwned(ss, uid ? uid : -1) : [];
  const lo = (p: string): number => Number(p.split("-")[0]);
  const ports = [...new Set([...found.map(String), ...opts.block_loopback_ports])].sort((a, b) => lo(a) - lo(b) || (a < b ? -1 : a > b ? 1 : 0));
  const [rc2, rl] = probe(["resolvectl", "dns"]);
  const resolvers = G.resolversFrom(read(P("/etc/resolv.conf")), rc2 === 0 ? rl : "");
  return G.renderRules(uidToken(), resolvers, opts.allow_hosts, ports, opts.block_inbound_ports, opts.egress);
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Python's os.path.expanduser("~user"): that user's home, or the text unchanged when there is no such user. */
function homeOf(user: string): string {
  const pw = getpwnam(user);
  if (pw) return pw.dir.replace(/\/+$/, "") || "/";
  return user === "" ? homedir() : `~${user}`;
}

/** The machine steps for `opts` (user, egress, allow_hosts, block_loopback_ports, block_inbound_ports,
 * authorized_keys, harden_ssh, keep_awake). */
export function steps(opts: MachineOptions): Step[] {
  checkPlatform();
  const user = opts.user;
  const [admin, adminHome] = adminAccount();
  const out: Step[] = [];

  const packagesMissing = (): string[] =>
    PACKAGES.filter((p) => !probe(["dpkg-query", "-W", "-f=${Status}", p])[1].includes("install ok installed"));
  const missing = packagesMissing();
  const apt = { DEBIAN_FRONTEND: "noninteractive" };
  out.push(missing.length
    ? new Step("packages", "Install the packages rootless Docker and the factory need",
      [new Run(["apt-get", "update", "-q"], { env: apt }), new Run(["apt-get", "install", "-y", "-q", ...missing], { env: apt })],
      { done: () => !packagesMissing().length, privileged: true, record: { packages: missing } })
    : new Step("packages", "Packages are installed", [], { done: () => true, privileged: true }));
  out.push(new Step("sops", "Install sops (release binary, checksum checked)", [new Call(installSops, "download sops")],
    { done: () => existsSync(P("/usr/local/bin/sops")) || probe(["sops", "--version"])[0] === 0,
      privileged: true, record: { files: [P("/usr/local/bin/sops")] } }));
  const existed = userExists(user);
  out.push(new Step("user", `Create the user ${user} (no sudo, no docker group, no password)`,
    [new Run(["adduser", "--disabled-password", "--gecos", "Software factory", user])],
    { done: () => userExists(user), privileged: true, record: { user, created: !existed } }));
  const bad = userGroups(user).filter((g) => PRIVILEGE_GROUPS.includes(g));

  const hardened = (): boolean => {
    if (userGroups(user).some((g) => PRIVILEGE_GROUPS.includes(g))) return false;
    const homes = [adminHome, homeOf(user)].filter((h) => h && isDir(h));
    return homes.every((h) => (statSync(h).mode & 0o007) === 0);
  };
  const actions = bad.map((g) => new Run(["gpasswd", "-d", user, g]));
  if (adminHome) actions.push(new Run(["chmod", "750", adminHome]));
  actions.push(new Run(["chmod", "750", `/home/${user}`]));
  out.push(new Step("isolate", `Keep ${user} out of sudo/docker groups and the admin's home unreadable`, actions,
    { done: hardened, privileged: true, record: { adminHome, admin } }));
  if (opts.authorized_keys) {
    const keys = pubkeys(opts.authorized_keys);
    const sshDir = P(`/home/${user}/.ssh`);
    const target = join(sshDir, "authorized_keys");
    out.push(new Step("ssh-keys", `Let the given public keys log in as ${user}`,
      [new Mkdir(sshDir, 0o700, user), new Write(target, keys, 0o600, user)],
      { done: () => read(target) === keys, privileged: true, record: { files: [target] } }));
  }
  const uid = userUid(user);
  const su = subidFreeStart(P("/etc/subuid"));
  const sg = subidFreeStart(P("/etc/subgid"));
  const subs = [new Run(["usermod", "--add-subuids", `${su}-${su + SUBID_COUNT - 1}`,
    "--add-subgids", `${sg}-${sg + SUBID_COUNT - 1}`, user])];
  out.push(new Step("subids", "Give the user subuid/subgid ranges (rootless containers)", subs,
    { done: () => hasSubid(P("/etc/subuid"), user, uid) && hasSubid(P("/etc/subgid"), user, uid), privileged: true }));
  out.push(new Step("linger", "Let the user's services run without a login (loginctl enable-linger)",
    [new Run(["loginctl", "enable-linger", user])],
    { done: () => probe(["loginctl", "show-user", user, "-p", "Linger", "--value"])[1].trim() === "yes", privileged: true }));
  const keep = opts.keep_awake;
  if (keep || ((keep === null || keep === undefined) && onBattery())) {
    const drop = P("/etc/systemd/logind.conf.d/50-factory.conf");
    const awakeText = "[Login]\nHandleLidSwitch=ignore\nHandleLidSwitchExternalPower=ignore\nHandleLidSwitchDocked=ignore\n";
    const targets = ["sleep.target", "suspend.target", "hibernate.target", "hybrid-sleep.target"];
    out.push(new Step("keep-awake", "Keep the machine awake: no sleep or suspend, lid ignored",
      [new Run(["systemctl", "mask", ...targets]), new Write(drop, awakeText), new Run(["systemctl", "restart", "systemd-logind"])],
      { done: () => read(drop) === awakeText, privileged: true, record: { files: [drop], masked: targets } }));
  }
  const cfgText = pyDumps(sandboxConfig(opts), { indent: 2, sortKeys: true }) + "\n";
  out.push(new Step("sandbox-config", "Write the sandbox settings (/etc/software-factory/sandbox.json)",
    [new Write(configPath(), cfgText)], { done: () => read(configPath()) === cfgText, privileged: true, record: { files: [configPath()] } }));
  const unit = G.renderUnit("/etc/software-factory/net-guard.nft");

  const guardCurrent = (): boolean => {
    if (!userUid(user)) return false;
    const want = guardText(opts, () => userUid(user) || "$UID_F");
    return read(rulesPath()) === want && read(unitPath()) === unit &&
      probe(["systemctl", "is-active", "--quiet", G.UNIT_NAME])[0] === 0;
  };
  out.push(new Step("net-guard", "Install the network guard: the internet is open, the home network and other users' " +
    "local services are not", [
    new Write(rulesPath(), (ctx) => guardText(opts, () => ctx.uid())),
    new Write(unitPath(), unit),
    new Run(["systemctl", "daemon-reload"]), new Run(["systemctl", "enable", G.UNIT_NAME]),
    new Run(["systemctl", "restart", G.UNIT_NAME])],
  { done: guardCurrent, privileged: true, record: { files: [rulesPath(), unitPath()], units: [G.UNIT_NAME], table: G.TABLE } }));
  if (opts.harden_ssh) {
    const conf = P("/etc/ssh/sshd_config.d/50-factory.conf");
    const sshText = "PasswordAuthentication no\nPermitRootLogin no\nKbdInteractiveAuthentication no\n";
    out.push(new Step("ssh-hardening", "Key-only SSH, no root login (you asked for it with --harden-ssh)",
      [new Write(conf, sshText), new Run(["sshd", "-t"]), new Run(["systemctl", "reload", "ssh"])],
      { done: () => read(conf) === sshText, privileged: true, record: { files: [conf] } }));
  }
  return out;
}
