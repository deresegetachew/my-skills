#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// `factory nats`: the NATS server the agents send messages through (decision 0004 point 3, #407), and the agents'
// keys (#408). One server per machine, shared by the factory projects on it, in Docker.
//
//   factory nats up [--leaf <hub>] [--hub] [--port N] [--monitor-port N] [--leaf-port N] [--leaf-password-file F]
//       write the compose file and the server's config, then start it with `docker compose`. The hub (the default)
//       runs JetStream on a data volume and takes leaf servers on its leaf port; `--leaf <hub address>` makes a leaf
//       server that connects to the hub. Clients connect on localhost and this machine's Tailscale address (`tailscale
//       ip -4`); without Tailscale, localhost only, and it says so. Nothing listens on 0.0.0.0 of the host. Run it
//       again to change it: with no --leaf or --hub it keeps the mode it has.
//   factory nats down [--purge]   stop it; --purge also removes JetStream's data
//   factory nats status           what runs here, and whether the server answers (its monitoring port, /healthz, /varz)
//   factory nats user add <agent> --role builder|manager|po|owner [--project P]
//       make the agent's nkey: the seed goes to <messaging.creds or ~/.secrets/nats/<project>>/<agent>.nk (mode 600,
//       folder 700), its public key and the role's permissions into the server's config, and a running server reloads.
//       Run it again to change the role; the key is kept.
//
// The files live in <machine settings folder>/nats/ (`factory machine show` prints the folder): compose.yaml,
// conf/nats-server.conf (mode 600: it holds the leaf password; the container runs as root, or as you under rootless
// Docker), users.json and state.json. The hub's leaf password is made once, in leaf.password (mode 600); a leaf
// machine needs a copy of it.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { hostname } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { type Config, load } from "./factory_config.ts";
import { Exit, pyDumps, run, runMain, sleepSync, which } from "./factory_lib.ts";
import { messagingProject, seedFolder } from "./core/compose.ts";
import { configDir } from "./factory_machine.ts";
import { NAME, natsTry, newUserKey, permissions, publicKeyOf, type Role, ROLES, roleOf } from "./factory_nats_keys.ts";

export const IMAGE = "nats:2.15.2-alpine";
export const COMPOSE_PROJECT = "factory-nats";
const PORTS = { client: 4222, tailnet: 4223, monitor: 8222, leaf: 7422 };
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

type Mode = "hub" | "leaf";
interface State {
  mode: Mode;
  hub: string; // a leaf's hub, nats-leaf://<host>:<port>, without the password
  address: string; // this machine's Tailscale address, or "" for localhost only
  ports: { client: number; tailnet: number; monitor: number; leaf: number };
  image: string;
}
interface User { project: string; name: string; role: Role; nkey: string }

export class NatsError extends Error {
  constructor(readonly code: string, message: string, readonly fix: string) {
    super(message);
  }
}

function refuse(code: string, message: string, fix: string): never {
  throw new NatsError(code, message, fix);
}

export function natsDir(): string {
  return join(configDir(), "nats");
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function readState(): State | null {
  return readJson<State>(join(natsDir(), "state.json"));
}

function readUsers(): User[] {
  const u = readJson<User[]>(join(natsDir(), "users.json"));
  return Array.isArray(u) ? u : [];
}

// ---------- files ----------
/** A file write that can be undone: the old content (or none) is kept until `commit`. */
class Writes {
  private before: [string, string | null][] = [];
  changed = false;

  put(path: string, text: string, mode: number): void {
    let old: string | null = null;
    try {
      old = readFileSync(path, "utf8");
    } catch {
      old = null;
    }
    if (old !== text) {
      this.before.push([path, old]);
      const tmp = `${path}.tmp-${process.pid}`;
      writeFileSync(tmp, text, { mode });
      chmodSync(tmp, mode);
      renameSync(tmp, path);
      this.changed = true;
    }
    chmodSync(path, mode);
  }

  undo(): void {
    for (const [path, old] of this.before.reverse()) {
      if (old === null) rmSync(path, { force: true });
      else writeFileSync(path, old);
    }
    this.before = [];
  }
}

function ensureDir(path: string, mode: number): void {
  mkdirSync(path, { recursive: true, mode });
  chmodSync(path, mode);
}

// ---------- rendering ----------
function q(text: string): string {
  return JSON.stringify(text);
}

/** The compose file: the pinned image, the config folder read-only, the data volume, and the host ports on
 * localhost and the Tailscale address only. */
export function composeYaml(s: State): string {
  // This machine's agents on localhost (their network guard keeps them off the tailnet); other machines on the Tailscale
  // address, on a port of its own: Docker 29 refuses the same host port on two addresses ("address already in use").
  const ports = [`127.0.0.1:${s.ports.client}:4222`];
  if (s.address) ports.push(`${s.address}:${s.ports.tailnet ?? PORTS.tailnet}:4222`);
  ports.push(`127.0.0.1:${s.ports.monitor}:8222`);
  // The hub's leaf port is for the other machines: on the Tailscale address only.
  if (s.mode === "hub" && s.address) ports.push(`${s.address}:${s.ports.leaf}:7422`);
  return [
    "# Written by `factory nats up` (decision 0004). Run it again to change this file; edits here are overwritten.",
    `name: ${COMPOSE_PROJECT}`,
    "services:",
    "  nats:",
    `    image: ${s.image}`,
    '    command: ["--config", "/etc/nats/nats-server.conf"]',
    "    restart: unless-stopped",
    "    ports:",
    ...ports.map((p) => `      - "${p}"`),
    "    volumes:",
    "      - ./conf:/etc/nats:ro",
    ...(s.mode === "hub" ? ["      - data:/data"] : []),
    ...(s.mode === "hub" ? ["volumes:", "  data:"] : []),
    "",
  ].join("\n");
}

/** The server's config: JetStream on the hub, the leaf port or the remote, and the agents' keys with their
 * permissions. Without users it takes clients without a key, as a fresh server should. */
export function serverConf(s: State, users: User[], leafPassword: string): string {
  const lines = [
    "# Written by `factory nats up` and `factory nats user add` (decision 0004). Edits here are overwritten.",
    `server_name: ${q(`factory-${s.mode}-${hostname().toLowerCase().replace(/[^a-z0-9-]/g, "-")}`)}`,
    "listen: 0.0.0.0:4222",
    "http: 0.0.0.0:8222",
  ];
  if (s.mode === "hub") {
    lines.push('jetstream { store_dir: "/data" }');
    lines.push(`leafnodes { listen: 0.0.0.0:7422, authorization { user: leaf, password: ${q(leafPassword)} } }`);
  } else {
    const u = new URL(s.hub);
    const url = `nats-leaf://leaf:${encodeURIComponent(leafPassword)}@${u.host}`;
    lines.push(`leafnodes { remotes: [ { url: ${q(url)} } ] }`);
  }
  if (users.length) {
    lines.push("authorization {", "  users: [");
    for (const u of users) {
      lines.push(`    # ${u.project}/${u.name} (${u.role})`);
      lines.push(`    { nkey: ${q(u.nkey)}, permissions: ${JSON.stringify(permissions(u.project, u.name, u.role))} }`);
    }
    lines.push("  ]", "}");
  }
  return lines.join("\n") + "\n";
}

// ---------- the machine ----------
function dockerReady(): void {
  if (!which("docker")) {
    refuse("docker-missing", "Docker isn't installed or isn't on your PATH; the NATS server runs in Docker.",
      "Install Docker (Docker Desktop or Colima on macOS, rootless Docker on a factory machine), then run this again.");
  }
  if (run(["docker", "info"], { timeoutMs: 30_000 }).code !== 0) {
    refuse("docker-down", "Docker isn't running (or this user can't reach it).", "Start Docker, then run this again.");
  }
}

/** This machine's Tailscale IPv4 address, or "" when Tailscale is missing or not up. */
export function tailscaleAddress(): string {
  if (!which("tailscale")) return "";
  const p = run(["tailscale", "ip", "-4"], { timeoutMs: 10_000 });
  const first = (p.stdout.trim().split("\n")[0] ?? "").trim();
  return p.code === 0 && IPV4.test(first) ? first : "";
}

function compose(args: string[]) {
  const dir = natsDir();
  return run(["docker", "compose", "--file", join(dir, "compose.yaml"), "--project-name", COMPOSE_PROJECT, ...args],
    { cwd: dir, timeoutMs: 300_000 });
}

type Answer = { ok: boolean; detail: string; body: string };

function httpGet(url: string, timeoutMs = 2000): Promise<Answer> {
  return new Promise((done) => {
    let settled = false;
    const finish = (a: Answer): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        done(a);
      }
    };
    const timer = setTimeout(() => {
      req.destroy();
      finish({ ok: false, detail: "no answer", body: "" });
    }, timeoutMs);
    const req = httpRequest(url, { method: "GET" }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => finish({ ok: (res.statusCode ?? 0) === 200, detail: `HTTP ${res.statusCode}`, body }));
    });
    req.on("error", (e: NodeJS.ErrnoException) => finish({ ok: false, detail: e.code ?? e.message, body: "" }));
    req.end();
  });
}

function port(text: string | undefined, flag: string): number {
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    refuse("bad-port", `${flag} needs a port number from 1 to 65535, not ${JSON.stringify(text ?? "")}.`,
      `For example: factory nats up ${flag} ${flag === "--port" ? 4222 : flag === "--monitor-port" ? 8222 : 7422}`);
  }
  return n;
}

/** The hub's leaf address from `--leaf`: a host, host:port or nats-leaf://host[:port] (port 7422 by default). */
export function hubAddress(text: string): string {
  const bad = () => refuse("bad-hub", `--leaf needs the hub's address, not ${JSON.stringify(text)}.`,
    "Give the hub machine's Tailscale address: factory nats up --leaf nats-leaf://100.64.0.7:7422 (or just --leaf 100.64.0.7)");
  if (!text || /\s|@/.test(text)) bad();
  let u: URL;
  try {
    u = new URL(text.includes("://") ? text : `nats-leaf://${text}`);
  } catch {
    return bad();
  }
  if (u.protocol !== "nats-leaf:" || !u.hostname || (u.pathname && u.pathname !== "/")) bad();
  if (u.port === "4222") {
    refuse("bad-hub", "4222 is the hub's port for agents; a leaf server connects to its leaf port.",
      `Use the leaf port: factory nats up --leaf nats-leaf://${u.hostname}:7422`);
  }
  return `nats-leaf://${u.hostname}:${u.port || PORTS.leaf}`;
}

function leafPassword(mode: Mode, file: string, w: Writes): string {
  let pw = "";
  try {
    pw = readFileSync(file, "utf8").trim();
  } catch {
    pw = "";
  }
  if (pw) return pw;
  if (mode === "leaf") {
    refuse("leaf-password-missing", `A leaf server needs the hub's leaf password, and ${file} isn't there.`,
      `Copy it from the hub (it is ${join("<machine settings folder>", "nats", "leaf.password")} there, made by its \`factory nats up\`), ` +
      `for example: scp <hub>:.config/software-factory/nats/leaf.password ${file} && chmod 600 ${file}; then run this again.`);
  }
  pw = randomBytes(24).toString("base64url");
  w.put(file, pw + "\n", 0o600);
  return pw;
}

async function waitForHealth(s: State): Promise<Answer> {
  const deadline = Date.now() + Number(process.env.FACTORY_NATS_WAIT ?? "20") * 1000;
  for (;;) {
    const a = await httpGet(`http://127.0.0.1:${s.ports.monitor}/healthz`);
    if (a.ok || Date.now() >= deadline) return a;
    sleepSync(1);
  }
}

// ---------- commands ----------
function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) refuse("missing-value", `${name} needs a value.`, "factory nats help");
  args.splice(i, 2);
  return v;
}

function flag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
}

function leftovers(args: string[], usage: string): void {
  if (args.length) refuse("unknown-option", `${args[0]} isn't an option here.`, `Usage: ${usage}`);
}

const UP_USAGE = "factory nats up [--leaf <hub>] [--hub] [--port N] [--monitor-port N] [--leaf-port N] [--leaf-password-file F]";

async function cmdUp(argv: string[]): Promise<number> {
  const args = [...argv];
  const leaf = option(args, "--leaf");
  const hub = flag(args, "--hub");
  const before = readState();
  const ports = { ...PORTS, ...(before?.ports ?? {}) };
  const p1 = option(args, "--port");
  const p2 = option(args, "--monitor-port");
  const p3 = option(args, "--leaf-port");
  const pwFile = option(args, "--leaf-password-file") ?? join(natsDir(), "leaf.password");
  leftovers(args, UP_USAGE);
  if (leaf !== undefined && hub) refuse("bad-mode", "--leaf and --hub can't go together.", UP_USAGE);
  if (p1 !== undefined) ports.client = port(p1, "--port");
  if (p2 !== undefined) ports.monitor = port(p2, "--monitor-port");
  if (p3 !== undefined) ports.leaf = port(p3, "--leaf-port");
  const mode: Mode = leaf !== undefined ? "leaf" : hub ? "hub" : (before?.mode ?? "hub");
  const hubUrl = leaf !== undefined ? hubAddress(leaf) : mode === "leaf" ? (before?.hub ?? "") : "";
  dockerReady();
  const address = tailscaleAddress();
  const s: State = { mode, hub: hubUrl, address, ports, image: IMAGE };

  const dir = natsDir();
  const fresh = !existsSync(dir);
  ensureDir(dir, 0o700);
  ensureDir(join(dir, "conf"), 0o700);
  const w = new Writes();
  const undo = (): void => {
    w.undo();
    if (fresh) rmSync(dir, { recursive: true, force: true });
  };
  try {
    const pw = leafPassword(mode, pwFile, w);
    w.put(join(dir, "compose.yaml"), composeYaml(s), 0o644);
    w.put(join(dir, "conf", "nats-server.conf"), serverConf(s, readUsers(), pw), 0o600);
    w.put(join(dir, "state.json"), pyDumps(s, { indent: 2 }) + "\n", 0o644);
  } catch (e) {
    undo();
    throw e;
  }
  const r = compose(["up", "-d", ...(w.changed ? ["--force-recreate"] : [])]);
  if (r.code !== 0) {
    undo();
    refuse("compose-failed", `docker compose couldn't start the NATS server: ${(r.stderr || r.stdout).trim().slice(-400)}`,
      "Fix what Docker says, then run `factory nats up` again. Nothing was changed.");
  }
  console.log(w.changed ? `Started the NATS ${mode} (${IMAGE}) from ${dir}.` : `The NATS ${mode} is up to date (${dir}).`);
  console.log(`This machine's agents connect on nats://127.0.0.1:${ports.client}` +
    (address ? `; other machines on nats://${address}:${ports.tailnet}.` : "."));
  if (!address) {
    console.log("note: Tailscale isn't installed or isn't up here, so the server listens on localhost only: other " +
      "machines can't reach it. Start Tailscale (`tailscale up`) and run `factory nats up` again.");
  }
  if (mode === "hub") {
    console.log(`JetStream is on, its data in the Docker volume ${COMPOSE_PROJECT}_data.`);
    if (address) {
      console.log(`Leaf servers connect on nats-leaf://${address}:${ports.leaf}: on another machine, copy ` +
        `${join(dir, "leaf.password")} there, then run \`factory nats up --leaf ${address}\`.`);
    }
  } else console.log(`It connects to the hub at ${hubUrl}; the hub keeps JetStream.`);
  if (address) {
    console.log(`On a sandboxed machine, let agents through the network guard: sudo factory bootstrap machine --apply ` +
      `--allow-host ${address}:${ports.tailnet}`);
  }
  if (address && which("ufw")) {
    console.log(`ufw is installed here and drops forwarded traffic, so the tailnet can't reach the container yet. ` +
      `Run once: sudo ufw route allow in on tailscale0 to any port 4222 proto tcp`);
  }
  const a = await waitForHealth(s);
  console.log(a.ok ? `The server answers (http://127.0.0.1:${ports.monitor}/healthz).`
    : `note: the server doesn't answer yet (${a.detail}). \`factory nats status\` checks again.`);
  if (!readUsers().length) {
    console.log("Next: give each agent a key, `factory nats user add <agent> --role builder|manager|po|owner`. " +
      "Until the first one, the server takes clients without a key.");
  }
  return 0;
}

function cmdDown(argv: string[]): number {
  const args = [...argv];
  const purge = flag(args, "--purge");
  leftovers(args, "factory nats down [--purge]");
  if (!existsSync(join(natsDir(), "compose.yaml"))) {
    console.log("Nothing to stop: `factory nats up` hasn't run on this machine.");
    return 0;
  }
  dockerReady();
  const r = compose(["down", "--remove-orphans", ...(purge ? ["--volumes"] : [])]);
  if (r.code !== 0) {
    refuse("compose-failed", `docker compose couldn't stop the NATS server: ${(r.stderr || r.stdout).trim().slice(-400)}`,
      "Fix what Docker says, then run `factory nats down` again.");
  }
  console.log(purge ? "Stopped the NATS server and removed JetStream's data." : "Stopped the NATS server. JetStream's data is kept (--purge removes it).");
  return 0;
}

async function cmdStatus(argv: string[]): Promise<number> {
  leftovers([...argv], "factory nats status");
  const s = readState();
  if (!s) {
    console.log("No NATS server is set up on this machine. Start one: `factory nats up` (the hub), or " +
      "`factory nats up --leaf <hub address>` on the other machines.");
    return 1;
  }
  console.log(`mode        ${s.mode}` + (s.mode === "leaf" ? ` (hub ${s.hub})` : ""));
  console.log(`listens     127.0.0.1:${s.ports.client}` + (s.address ? `, ${s.address}:${s.ports.tailnet ?? PORTS.tailnet} (Tailscale)` : " (localhost only: no Tailscale)"));
  console.log(`files       ${natsDir()}`);
  console.log(`keys        ${readUsers().length}`);
  const health = await httpGet(`http://127.0.0.1:${s.ports.monitor}/healthz`);
  if (!health.ok) {
    console.log(`server      doesn't answer on its monitoring port ${s.ports.monitor} (${health.detail}). Start it: \`factory nats up\``);
    return 1;
  }
  const varz = await httpGet(`http://127.0.0.1:${s.ports.monitor}/varz`);
  let v: Record<string, unknown> = {};
  try {
    v = JSON.parse(varz.body) as Record<string, unknown>;
  } catch {
    v = {};
  }
  const bits = [`version ${String(v.version ?? "?")}`, `${Number(v.connections ?? 0)} connections`];
  if (s.mode === "hub") bits.push(`${Number(v.leafnodes ?? 0)} leaf servers`, v.jetstream ? "JetStream on" : "JetStream off");
  console.log(`server      answers: ${bits.join(", ")}`);
  return 0;
}

// ---------- keys ----------
/** The project's name as NATS subjects use it: --project, else the name its agents connect under (the composition
 * root's rule: the origin repository's name, the same from every worktree). */
export function projectName(given?: string): string {
  return given || messagingProject();
}

/** The folder of the agents' seeds: messaging.creds, else ~/.secrets/nats/<project>/ (the composition root's rule, so
 * the seed is written where the agent reads it). */
export function credsDir(cfg: Config | null, project: string): string {
  const m = cfg?.messaging;
  const set = m && typeof m === "object" && !Array.isArray(m) ? String((m as Record<string, unknown>).creds ?? "") : "";
  return seedFolder(set, project);
}

function loadConfig(): Config | null {
  try {
    return load();
  } catch {
    return null;
  }
}

const USER_USAGE = "factory nats user add <agent> --role builder|manager|po|owner [--project P]";

function cmdUser(argv: string[]): number {
  const args = [...argv];
  if (args.shift() !== "add") refuse("unknown-command", "factory nats user has one command: add.", `Usage: ${USER_USAGE}`);
  const roleText = option(args, "--role");
  const given = option(args, "--project");
  const name = args.shift() ?? "";
  leftovers(args, USER_USAGE);
  if (!NAME.test(name)) {
    refuse("bad-name", `The agent's name ${JSON.stringify(name)} must be lowercase letters, digits and dashes.`, `Usage: ${USER_USAGE}`);
  }
  const role = roleOf(roleText ?? "");
  if (!role) {
    refuse("bad-role", `--role must be one of ${ROLES.join(", ")}${roleText ? `, not ${JSON.stringify(roleText)}` : ""}.`,
      `For example: factory nats user add ${name} --role builder`);
  }
  const project = projectName(given);
  if (!NAME.test(project)) {
    refuse("bad-project", `The project's name ${JSON.stringify(project)} isn't a NATS subject token.`,
      `Name it: factory nats user add ${name} --role ${role} --project <lowercase-name>`);
  }
  const cfg = loadConfig();
  const creds = credsDir(cfg, project);
  const seedFile = join(creds, `${name}.nk`);
  const dir = natsDir();
  const w = new Writes();
  let made = false;
  try {
    ensureDir(creds, 0o700);
    let seed = "";
    if (existsSync(seedFile)) {
      seed = readFileSync(seedFile, "utf8").trim();
      try {
        publicKeyOf(seed);
      } catch {
        refuse("bad-seed", `${seedFile} is there but holds no NATS user seed.`,
          `Move it away (mv ${seedFile} ${seedFile}.old), then run this again to make a new key.`);
      }
      chmodSync(seedFile, 0o600);
    } else {
      [seed] = newUserKey();
      w.put(seedFile, seed + "\n", 0o600);
      made = true;
    }
    const nkey = publicKeyOf(seed);
    const users = readUsers().filter((u) => !(u.project === project && u.name === name));
    const old = readUsers().find((u) => u.project === project && u.name === name);
    users.push({ project, name, role, nkey });
    users.sort((a, b) => `${a.project}/${a.name}`.localeCompare(`${b.project}/${b.name}`));
    ensureDir(dir, 0o700);
    w.put(join(dir, "users.json"), pyDumps(users, { indent: 2 }) + "\n", 0o644);
    const s = readState();
    if (s) {
      ensureDir(join(dir, "conf"), 0o700);
      let pw = "";
      try {
        pw = readFileSync(join(dir, "leaf.password"), "utf8").trim();
      } catch {
        pw = "";
      }
      w.put(join(dir, "conf", "nats-server.conf"), serverConf(s, users, pw), 0o600);
    }
    const same = old && old.role === role && old.nkey === nkey;
    console.log(same ? `${project}/${name} already has a key as ${role}; nothing changed.`
      : `${made ? "Made" : "Kept"} the key of ${project}/${name} (${role}): the seed is ${seedFile} (mode 600).`);
    if (same) return 0;
    if (!s) {
      console.log("No server runs here yet: `factory nats up` starts one with this key.");
      return 0;
    }
    const r = which("docker") ? compose(["kill", "-s", "SIGHUP", "nats"]) : null;
    console.log(r && r.code === 0 ? "The server reloaded its config." : "The server isn't running: the key takes effect at `factory nats up`.");
    console.log(`Publishes as ${name} only: ${permissions(project, name, role).publish.allow.filter((x) => x.startsWith("factory.")).join(", ")}.`);
    return 0;
  } catch (e) {
    w.undo();
    if (made) rmSync(seedFile, { force: true });
    throw e;
  }
}

// ---------- doctor ----------
export interface DoctorReporter {
  ok(what: string): void;
  fix(what: string, how: string): void;
  note(what: string, how: string): void;
}

/** The doctor's NATS checks when messaging.transport is nats (decision 0004 point 4): the server answers at
 * messaging.url, the seed folder and files have their modes, and for each seed a publish as itself goes through and
 * one as another agent is refused. */
export async function doctor(r: DoctorReporter, cfg: Config): Promise<void> {
  const m = cfg.messaging;
  const ms = m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
  if (ms.transport !== "nats") return;
  const url = String(ms.url ?? "");
  if (!url) {
    r.fix("NATS server answers", "messaging.transport is nats but messaging.url is empty. Set it: `factory settings set " +
      "messaging.url nats://127.0.0.1:4222` (this machine's server), and start it with `factory nats up`");
    return;
  }
  const project = projectName();
  const creds = credsDir(cfg, project);
  const seeds = listSeeds(creds);
  const probe = await natsTry(url, seeds[0]?.[1] ?? "", `factory.${project}.wake.doctor`);
  if (probe.state === "down") {
    r.fix("NATS server answers", `nothing answers at ${url} (${probe.detail}). Start it: \`factory nats up\`; ` +
      "`factory nats status` says more");
    return;
  }
  r.ok(`NATS server answers at ${url}`);
  if (!existsSync(creds)) {
    r.note("NATS keys", `no seed folder ${creds}. Make the agents' keys: \`factory nats user add <agent> --role builder\``);
    return;
  }
  const dirMode = statSync(creds).mode & 0o777;
  if (dirMode & 0o077) r.fix("NATS seed folder", `${creds} is mode ${dirMode.toString(8)}; run \`chmod 700 ${creds}\``);
  for (const [name, seed, mode] of seeds) {
    if (mode & 0o077) {
      r.fix(`NATS seed ${name}`, `${join(creds, `${name}.nk`)} is mode ${mode.toString(8)}; run \`chmod 600 ${join(creds, `${name}.nk`)}\``);
      continue;
    }
    const own = await natsTry(url, seed, `factory.${project}.wake.${name}`);
    const other = await natsTry(url, seed, `factory.${project}.wake.not-${name}`);
    if (own.state !== "accepted") {
      r.fix(`NATS key ${name}`, `the server didn't take a publish as ${name} (${own.state}: ${own.detail || "no detail"}). ` +
        `Run \`factory nats user add ${name} --role <role>\` on this machine`);
    } else if (other.state !== "refused") {
      r.fix(`NATS key ${name}`, `the server let ${name} publish as another agent (${other.state}). Its permissions are ` +
        "missing: run `factory nats up` again on this machine, then `factory doctor`");
    } else r.ok(`NATS key ${name}: publishes as itself, and a publish as another agent is refused`);
  }
}

function listSeeds(creds: string): [string, string, number][] {
  const out: [string, string, number][] = [];
  let names: string[] = [];
  try {
    names = readdirSync(creds);
  } catch {
    return out;
  }
  for (const f of names.sort()) {
    if (!f.endsWith(".nk")) continue;
    const path = join(creds, f);
    try {
      out.push([f.slice(0, -3), readFileSync(path, "utf8").trim(), statSync(path).mode & 0o777]);
    } catch {
      // unreadable: left out
    }
  }
  return out;
}

// ---------- main ----------
const HELP = `factory nats up [--leaf <hub>] [--hub] [--port N] [--monitor-port N] [--leaf-port N]
                         start this machine's NATS server in Docker: the hub (JetStream on a data volume), or with
                         --leaf a leaf server that connects to the hub; on localhost and the Tailscale address
factory nats down [--purge]
factory nats status      whether the server answers
factory nats user add <agent> --role builder|manager|po|owner [--project P]
                         the agent's key: its seed in messaging.creds (mode 600), its permissions on the server`;

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0] ?? "status";
  const rest = argv.slice(1);
  try {
    if (cmd === "up") return await cmdUp(rest);
    if (cmd === "down") return cmdDown(rest);
    if (cmd === "status") return await cmdStatus(rest);
    if (cmd === "user") return cmdUser(rest);
    if (cmd === "help" || cmd === "--help" || cmd === "-h") {
      console.log(HELP);
      return 0;
    }
    refuse("unknown-command", `factory nats has no command ${JSON.stringify(cmd)}.`, "factory nats up | down | status | user add");
  } catch (e) {
    if (e instanceof NatsError) {
      process.stderr.write(pyDumps({ code: e.code, message: e.message, fix: e.fix }) + "\n");
      throw new Exit(1);
    }
    throw e;
  }
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
