// `factory doctor --sandbox` (#105): does the sandbox of this machine hold? Run it as the dedicated user.
//
// Read-only: it runs `curl`, `docker run` of a tiny image against the router, `id`, `ss` and friends, and never prints a
// token or a file's content. Each line is `ok`, `fix` (with the fix) or `note`. The same checks, listed:
//
//   identity    the dedicated user; no sudo; not in the docker/sudo groups; the admin's home and keys unreadable;
//               ~/.secrets is 700
//   network     the internet works (GitHub, npm, the Claude API); the router, the tailnet, link-local and the admin's
//               local web ports are blocked; FACTORY-BLOCK entries appear in the kernel log
//   gap 1       every loopback/wildcard port another user listens on is in the guard (re-run the machine step if not)
//   gap 2       a container started by this user cannot reach the router either
//   rootless    Docker is rootless with overlayfs; the cpu, memory and pids cgroup controllers are delegated; linger is on
//   services    the CI runner units are active; every agent worktree has its submodules checked out
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as M from "./factory_bootstrap_machine.ts";
import * as G from "./factory_netguard.ts";
import { probe } from "./factory_bootstrap_core.ts";
import { repoKey } from "./factory_machine.ts";
import { pyInt } from "./factory_lib.ts";

export const INTERNET = ["https://github.com", "https://registry.npmjs.org", "https://api.anthropic.com"];
export const LINK_LOCAL = "169.254.169.254";
export const TAILNET = "100.100.100.100";
export const CONTROLLERS = ["cpu", "memory", "pids"];

/** Where the checks report: the doctor's report (`ok`, `fix` with the step, `note`). */
export interface Report {
  ok(what: string): void;
  fix(what: string, how: string): void;
  note(what: string, how: string): void;
}

export interface SandboxSettings {
  user: string;
  egress: string;
  blockLoopbackPorts: (string | number)[];
  known: boolean;
}

type Row = Record<string, unknown>;

function obj(v: unknown): Row {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {};
}

/** The sandbox settings `factory bootstrap machine` saved, or the defaults when it was never run. */
export function settings(): SandboxSettings {
  let cfg: Row = {};
  try {
    cfg = obj(JSON.parse(readFileSync(M.configPath(), "utf8")));
  } catch {
    cfg = {};
  }
  return { user: (cfg.user as string) ?? "", egress: (cfg.egress as string) ?? "internet",
    blockLoopbackPorts: (cfg.blockLoopbackPorts as (string | number)[]) ?? [], known: Object.keys(cfg).length > 0 };
}

export function manifest(): Row {
  try {
    return obj(JSON.parse(readFileSync(M.manifestPath(), "utf8")));
  } catch {
    return {};
  }
}

export function defaultGateway(): string {
  const [rc, out] = probe(["ip", "-4", "route", "show", "default"]);
  const m = rc === 0 ? /via (\d+\.\d+\.\d+\.\d+)/.exec(out) : null;
  return m ? (m[1] as string) : "";
}

export function httpCode(url: string, timeout = 5): string {
  const [, out] = probe(["curl", "-s", "-m", String(timeout), "-o", "/dev/null", "-w", "%{http_code}", url], null, timeout + 5);
  const code = out.trim();
  return /^\d+$/.test(code) ? code : "000";
}

export function reached(url: string): boolean {
  return httpCode(url) !== "000";
}

/** ok when `good`, else a fix (or a note). */
function verdict(r: Report, good: boolean, okMsg: string, what: string, how: string, level = "fix"): void {
  if (good) r.ok(okMsg);
  else if (level === "fix") r.fix(what, how);
  else r.note(what, how);
}

function home(): string {
  return process.env.HOME || homedir();
}

export function identity(r: Report, cfg: SandboxSettings, me: string): void {
  if (cfg.known && cfg.user && cfg.user !== me) {
    r.fix("sandbox identity", `you are ${me}, the sandbox user is ${cfg.user}: run \`sudo -u ${cfg.user} -i\`, then ` +
      "`factory doctor --sandbox` from the project there");
  } else {
    r.ok(`running as the sandbox user ${me}`);
  }
  if (probe(["sudo", "-n", "true"])[0] === 0) {
    r.fix("sudo", `${me} can run sudo: remove it from the sudo group (\`sudo gpasswd -d ${me} sudo\`) and any sudoers entry`);
  } else {
    r.ok("no sudo");
  }
  const bad = probe(["id", "-nG"])[1].split(/\s+/).filter((g) => g && M.PRIVILEGE_GROUPS.includes(g));
  if (bad.length) {
    r.fix("groups", `${me} is in ${bad.join(", ")}: \`sudo gpasswd -d ${me} ${bad[0]}\` (the docker group is root-equivalent)`);
  } else {
    r.ok("not in the sudo, docker or admin groups");
  }
  const adm = obj(obj(obj(obj(manifest().steps).isolate).record));
  const adminHome = (adm.adminHome as string) || "";
  if (adminHome) {
    if (probe(["ls", adminHome])[0] === 0 || probe(["ls", join(adminHome, ".ssh")])[0] === 0) {
      r.fix("admin's files", `${adminHome} is readable: \`sudo chmod 750 ${adminHome}\``);
    } else {
      r.ok(`${adminHome} (the admin's home) is not readable`);
    }
  } else {
    r.note("admin's files", "the manifest does not name the admin's home; check by hand that /home/<admin> is mode 750");
  }
  const secrets = join(home(), ".secrets");
  let st: ReturnType<typeof statSync> | null = null;
  try {
    st = statSync(secrets);
  } catch {
    st = null;
  }
  if (st && st.isDirectory()) {
    const mode = st.mode & 0o777;
    verdict(r, mode === 0o700, "~/.secrets is 700", "~/.secrets", `mode is ${mode.toString(8)}: \`chmod 700 ~/.secrets\``);
  } else {
    r.note("~/.secrets", "does not exist yet: `factory bootstrap project` makes it");
  }
}

export function network(r: Report, cfg: SandboxSettings): void {
  const down = INTERNET.filter((u) => !reached(u));
  if (cfg.egress === "none") {
    verdict(r, down.length === INTERNET.length, "the internet is closed (egress none)", "egress none",
      "the internet is reachable although the sandbox says egress none: `sudo factory bootstrap machine --apply`");
  } else if (down.length) {
    r.fix("internet", `${down.join(", ")} not reachable: check the network, then the guard (\`sudo systemctl status ${G.UNIT_NAME}\`)`);
  } else {
    r.ok("the internet works (GitHub, npm, the Claude API)");
  }
  const gw = defaultGateway();
  const targets: [string, string][] = gw ? [[`the router ${gw}`, `http://${gw}`]] : [];
  targets.push(["the tailnet", `http://${TAILNET}`], ["link-local", `http://${LINK_LOCAL}`]);
  for (const p of cfg.blockLoopbackPorts) targets.push([`the local service on 127.0.0.1:${p}`, `http://127.0.0.1:${p}`]);
  const leaked = targets.filter(([, url]) => reached(url)).map(([what]) => what);
  if (leaked.length) {
    r.fix("home network", `${leaked.join(", ")} reachable: the guard is not loaded or does not cover this user ` +
      `(\`sudo systemctl restart ${G.UNIT_NAME}\`, or run \`sudo factory bootstrap machine --apply\`)`);
  } else {
    r.ok("the router, the tailnet, link-local and the blocked local ports are not reachable");
  }
  if (!gw) r.note("router", "no default route found, so the router was not tried");
  const [rc, out] = probe(["journalctl", "-k", "--no-pager", "-n", "200", "-g", "FACTORY-BLOCK"]);
  if (rc !== 0) {
    r.note("FACTORY-BLOCK log", "the kernel log is not readable by this user; as the admin: " +
      "`sudo journalctl -k | grep FACTORY-BLOCK`");
  } else if (out.includes("FACTORY-BLOCK")) {
    r.ok("blocked attempts appear in the kernel log (FACTORY-BLOCK)");
  } else {
    r.note("FACTORY-BLOCK log", "no entry yet; the guard logs blocked attempts, so this is fine until something is blocked");
  }
}

export function gapOne(r: Report, _cfg: SandboxSettings, uid: number): void {
  const [rc, ss] = probe(["ss", "-ltnHe"]);
  if (rc !== 0) {
    r.note("other users' listening ports", "`ss` is not available, so they were not listed");
    return;
  }
  const rules = M.read(M.rulesPath());
  if (!rules) {
    r.note("other users' listening ports", "the guard's rules are not readable here; as the admin: " +
      "`sudo factory bootstrap status`");
    return;
  }
  const unblocked = G.listeningPortsNotOwned(ss, uid).filter((p) => !new RegExp(`[{ ,]${p}[ ,}]`).test(rules));
  if (unblocked.length) {
    r.fix("local services of other users", `ports ${unblocked.join(", ")} are open to this user: ` +
      "run `sudo factory bootstrap machine --apply` again so the guard covers them");
  } else {
    r.ok("every local service of another user is covered by the guard");
  }
}

export function gapTwo(r: Report, gateway: string): void {
  if (!gateway) return;
  const [rc] = probe(["docker", "run", "--rm", "busybox", "wget", "-q", "-T", "3", "-O", "/dev/null", `http://${gateway}`], null, 90);
  if (rc === 0) {
    r.fix("containers", `a container started by this user reached the router ${gateway}: the guard does not cover ` +
      "container traffic; check that Docker is rootless (`docker info`) and run `sudo factory bootstrap machine --apply`");
  } else {
    r.ok("a container started by this user cannot reach the router either");
  }
}

export function rootless(r: Report, uid: number): boolean {
  const [rc, out] = probe(["docker", "info", "--format", "{{json .SecurityOptions}}|{{.Driver}}"]);
  if (rc !== 0) {
    r.fix("rootless Docker", "docker is not reachable: `factory bootstrap project` sets it up " +
      "(`systemctl --user start docker`, DOCKER_HOST=unix://$XDG_RUNTIME_DIR/docker.sock)");
    return false;
  }
  const text = out.trim();
  const bar = text.indexOf("|");
  const secopts = bar >= 0 ? text.slice(0, bar) : text;
  const driver = bar >= 0 ? text.slice(bar + 1) : "";
  verdict(r, secopts.includes("rootless"), "Docker is rootless", "rootless Docker",
    "this Docker is not rootless: run `dockerd-rootless-setuptool.sh install` as this user");
  verdict(r, driver === "overlay2", "storage driver overlay2", "storage driver",
    `${driver || "unknown"}, not overlay2: builds will be slow`, "note");
  const path = M.P(`/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/cgroup.controllers`);
  const have = M.read(path).split(/\s+/).filter(Boolean);
  const missing = CONTROLLERS.filter((c) => !have.includes(c));
  if (!have.length) {
    r.note("cgroup controllers", "could not read the delegated controllers (cgroup v2 expected)");
  } else if (missing.length) {
    r.fix("cgroup controllers", `${missing.join(", ")} not delegated: add a /etc/systemd/system/user@.service.d/delegate.conf ` +
      "with `[Service]` `Delegate=cpu cpuset io memory pids`, then `sudo systemctl daemon-reload` and log in again");
  } else {
    r.ok("cgroup controllers cpu, memory and pids are delegated");
  }
  const user = process.env.USER || process.env.LOGNAME || "factory";
  if (probe(["loginctl", "show-user", user, "-p", "Linger", "--value"])[1].trim() === "yes") {
    r.ok("linger is on");
  } else {
    r.fix("linger", `off: user services die at logout. \`sudo loginctl enable-linger ${user}\``);
  }
  return true;
}

export function services(r: Report, cfgProject: Record<string, unknown> | null): void {
  let repo = "";
  try {
    repo = repoKey();
  } catch {
    repo = "";
  }
  const want = cfgProject ? (pyInt(obj(cfgProject.ci).runners || 0) ?? 0) : 0;
  const [rc, out] = probe(["systemctl", "--user", "list-units", "--no-legend", "--state=active", `${repo}-ci*.service`]);
  const active = rc === 0 ? out.split(/\r\n|\r|\n/).filter((l) => l.includes(".service")).length : 0;
  if (rc !== 0) {
    r.note("CI runners", "could not ask the user's systemd (is XDG_RUNTIME_DIR set? log in with ssh, not su)");
  } else if (active === 0) {
    if (want) r.fix("CI runners", "no runner unit is active: `factory ci install`");
    else r.note("CI runners", "no runner unit is active: `factory ci install`");
  } else if (want && active < want) {
    r.fix("CI runners", `${active} active, ci.runners asks for ${want}: \`factory ci install\``);
  } else {
    r.ok(`${active} CI runner unit(s) active`);
  }
  const [wrc, wout] = probe(["git", "worktree", "list", "--porcelain"]);
  const bad: string[] = [];
  for (const line of wrc === 0 ? wout.split(/\r\n|\r|\n/) : []) {
    if (line.startsWith("worktree ")) {
      const path = line.slice(9);
      if (existsSync(join(path, ".gitmodules")) && !existsSync(join(path, ".claude", "factory", "settings.json"))) bad.push(path);
    }
  }
  if (bad.length) {
    r.fix("agent worktrees", `${bad.join(", ")} have no .claude/factory/settings.json (submodules missing): ` +
      "`git submodule update --init` in each");
  } else if (wrc === 0) {
    r.ok("every worktree has its submodules");
  }
}

/** All the sandbox checks, onto the doctor's report `r`. */
export function run(r: Report, cfgProject: Record<string, unknown> | null): void {
  const cfg = settings();
  const me = process.env.USER || process.env.LOGNAME || probe(["id", "-un"])[1].trim();
  const uid = process.getuid ? process.getuid() : 0;
  if (!cfg.known) {
    r.note("sandbox", `${M.configPath()} is missing: \`sudo factory bootstrap machine --apply\` was not run here; ` +
      "checking this user as it is");
  }
  identity(r, cfg, me);
  network(r, cfg);
  gapOne(r, cfg, uid);
  gapTwo(r, defaultGateway());
  rootless(r, uid);
  services(r, cfgProject);
}
