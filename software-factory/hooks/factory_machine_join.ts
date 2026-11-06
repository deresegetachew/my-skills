// `factory machine add|join|ls|remove` (#445, epic #420): a machine joins the hub without copying a password by hand.
//
//   factory machine add <name> --agent <agent>[:role] ... [--ttl minutes] [--json]    (on the hub)
//       makes the keys of the agents that machine will run, and prints one join code. The code carries the hub's
//       Tailscale address, the leaf password and those keys; it works once and expires (15 minutes by default).
//   factory machine join <code> [--no-tailscale] [--no-doctor]                         (on the new machine)
//       checks Tailscale and Docker, starts the leaf (`factory nats up --leaf`) or, without Docker, connects the
//       agents straight to the hub, writes the seeds (folder 700, files 600) and runs `factory doctor`.
//   factory machine ls [--json]       the machines added and whether their code is still waiting
//   factory machine remove <name>     forget the machine and take its agents' keys off the hub
//
// The hub keeps the records in <machine settings folder>/nats/machines.json. The code is the secret: whoever holds a
// live one can join, so it is shown once and expires. "Works once" is kept where it is redeemed (the machine records
// the codes it used in machine-joins.json); `machine remove` is what takes a machine's keys away from the hub.
// Errors are `{code, message, fix}` on stderr.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { now } from "./factory_clock.ts";
import { type Config, load } from "./factory_config.ts";
import { Exit, pyDumps, run, which } from "./factory_lib.ts";
import { configDir, machineSettings, refuse, saveMachineSettings } from "./factory_machine.ts";
import { credsDir, dockerUsable, hubLeafPassword, natsDir, natsState, projectName, removeUsers } from "./factory_nats.ts";
import { NAME, publicKeyOf, type Role, roleOf } from "./factory_nats_keys.ts";

const PREFIX = "FM1-";
const DEFAULT_TTL_MINUTES = 15;
const ADD_USAGE = "factory machine add <name> --agent <agent>[:role] [--agent ...] [--ttl minutes] [--json]";
const HERE = dirname(new URL(import.meta.url).pathname);

interface AgentKey { name: string; role: Role }
interface Payload {
  v: 1;
  id: string;
  name: string;
  exp: number;
  project: string;
  hub: { address: string; leaf: number; client: number };
  leafPassword: string;
  agents: (AgentKey & { seed: string })[];
}
interface Record_ { name: string; id: string; project: string; createdAt: number; expiresAt: number; agents: AgentKey[] }

// ---------- the code ----------
export function encodeCode(p: Payload): string {
  return PREFIX + Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
}

/** The code's content, or a `bad-code` refusal for anything that isn't one. */
export function decodeCode(text: string): Payload {
  const bad = (): never => refuse("bad-code", "That isn't a join code.",
    "Copy the whole code that `factory machine add <name>` printed on the hub (it starts with FM1-).");
  const t = text.trim();
  if (!t.startsWith(PREFIX)) return bad();
  let p: Payload;
  try {
    p = JSON.parse(Buffer.from(t.slice(PREFIX.length), "base64url").toString("utf8")) as Payload;
  } catch {
    return bad();
  }
  const ok = p && p.v === 1 && typeof p.id === "string" && NAME.test(String(p.name)) && typeof p.exp === "number" &&
    typeof p.project === "string" && NAME.test(p.project) && typeof p.leafPassword === "string" &&
    typeof p.hub?.address === "string" && Number.isInteger(p.hub.leaf) && Number.isInteger(p.hub.client) &&
    Array.isArray(p.agents) && p.agents.length > 0 &&
    p.agents.every((a) => NAME.test(String(a.name)) && roleOf(String(a.role)) && typeof a.seed === "string");
  if (!ok) return bad();
  for (const a of p.agents) {
    try {
      publicKeyOf(a.seed);
    } catch {
      return bad();
    }
  }
  return p;
}

// ---------- small file helpers ----------
function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeAtomic(path: string, text: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

function machinesFile(): string {
  return join(natsDir(), "machines.json");
}

function readRecords(): Record_[] {
  const r = readJson<Record_[]>(machinesFile(), []);
  return Array.isArray(r) ? r : [];
}

function saveRecords(rs: Record_[]): void {
  writeAtomic(machinesFile(), pyDumps(rs, { indent: 2 }) + "\n", 0o600);
}

function loadConfig(): Config | null {
  try {
    return load();
  } catch {
    return null;
  }
}

function takeFlag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
}

function takeOptions(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = args.indexOf(name); i >= 0; i = args.indexOf(name)) {
    const v = args[i + 1];
    if (v === undefined || v.startsWith("--")) refuse("missing-value", `${name} needs a value.`, `Usage: ${ADD_USAGE}`);
    out.push(v);
    args.splice(i, 2);
  }
  return out;
}

function noMore(args: string[], usage: string): void {
  if (args.length) refuse("unknown-option", `${args[0]} isn't an option here.`, `Usage: ${usage}`);
}

function natsCli(args: string[]) {
  return run([process.execPath, "--no-env-file", "--config=/dev/null", join(HERE, "factory_nats.ts"), ...args], { timeoutMs: 330_000 });
}

function lastError(stderr: string): { message: string; fix: string } | null {
  try {
    const e = JSON.parse(stderr.trim().split("\n").at(-1) ?? "") as { message?: unknown; fix?: unknown };
    return typeof e.message === "string" && typeof e.fix === "string" ? { message: e.message, fix: e.fix } : null;
  } catch {
    return null;
  }
}

// ---------- add ----------
function parseAgent(text: string): AgentKey {
  const [name = "", roleText = "builder"] = text.split(":");
  const role = roleOf(roleText);
  if (!NAME.test(name)) refuse("bad-name", `The agent name ${JSON.stringify(name)} must be lowercase letters, digits and dashes.`, `Usage: ${ADD_USAGE}`);
  if (!role) refuse("bad-role", `${JSON.stringify(roleText)} isn't a role.`, `Use builder, manager, po or owner: --agent ${name}:builder`);
  return { name, role };
}

function cmdAdd(argv: string[]): number {
  const args = [...argv];
  const json = takeFlag(args, "--json");
  const agents = takeOptions(args, "--agent").map(parseAgent);
  const ttlText = takeOptions(args, "--ttl")[0];
  const name = args.shift() ?? "";
  noMore(args, ADD_USAGE);
  if (!NAME.test(name)) refuse("bad-name", `The machine's name ${JSON.stringify(name)} must be lowercase letters, digits and dashes.`, `Usage: ${ADD_USAGE}`);
  if (!agents.length) refuse("no-agents", "No agents were named: the code carries the keys of the agents that machine runs.", `Usage: ${ADD_USAGE}`);
  const ttl = ttlText === undefined ? DEFAULT_TTL_MINUTES : Number(ttlText);
  if (!Number.isFinite(ttl) || ttl <= 0) refuse("bad-ttl", `--ttl needs minutes above 0, not ${JSON.stringify(ttlText)}.`, `Usage: ${ADD_USAGE}`);

  const hub = natsState();
  const password = hubLeafPassword();
  if (!hub || hub.mode !== "hub" || !password) {
    refuse("hub-not-ready", "This machine isn't running the NATS hub, so there is nothing for another machine to join.",
      "Start the hub here first: factory nats up");
  }
  if (!hub.address) {
    refuse("hub-no-tailscale", "The hub has no Tailscale address, so another machine can't reach it.",
      "Start Tailscale (tailscale up), then run `factory nats up` again.");
  }
  if (readRecords().some((r) => r.name === name)) {
    refuse("machine-exists", `A machine called ${name} is already added.`, `Remove it first with \`factory machine remove ${name}\`, or choose another name.`);
  }
  const project = projectName();
  const cfg = loadConfig();
  const made: Payload["agents"] = [];
  for (const a of agents) {
    const r = natsCli(["user", "add", a.name, "--role", a.role, "--project", project]);
    if (r.code !== 0) {
      removeUsers(project, made.map((m) => m.name)); // nothing half done: the keys made so far go again
      const e = lastError(r.stderr);
      refuse("key-failed", `Couldn't make the key of ${a.name}: ${e?.message ?? (r.stderr || r.stdout).trim().slice(-300)}`, e?.fix ?? "Fix that, then run this again.");
    }
    const seed = readFileSync(join(credsDir(cfg, project), `${a.name}.nk`), "utf8").trim();
    made.push({ ...a, seed });
  }
  const t = now();
  const expiresAt = Math.floor(t + ttl * 60);
  const id = randomBytes(6).toString("hex");
  const code = encodeCode({ v: 1, id, name, exp: expiresAt, project, hub: { address: hub.address, leaf: hub.ports.leaf, client: hub.ports.tailnet },
    leafPassword: password, agents: made });
  saveRecords([...readRecords(), { name, id, project, createdAt: Math.floor(t), expiresAt, agents }]);
  const command = `factory machine join ${code}`;
  if (json) {
    console.log(pyDumps({ name, code, expiresAt, agents, command }));
    return 0;
  }
  console.log(`Join code for ${name} (works once, expires in ${Math.round(ttl)} min). It holds the keys of ${agents.map((a) => a.name).join(", ")}: send it over a private channel.`);
  console.log(code);
  console.log(`On ${name}, in the project's folder, run:`);
  console.log(command);
  return 0;
}

// ---------- join ----------
interface Made { files: string[]; dirs: string[]; restore: [string, string][] }

function undoAll(m: Made): void {
  for (const f of m.files) rmSync(f, { force: true });
  for (const [f, text] of m.restore) writeFileSync(f, text);
  for (const d of m.dirs.reverse()) rmSync(d, { recursive: true, force: true });
}

function tailscaleUp(): boolean {
  return Boolean(which("tailscale")) && run(["tailscale", "ip", "-4"], { timeoutMs: 10_000 }).code === 0;
}

function cmdJoin(argv: string[]): number {
  const args = [...argv];
  const skipTailscale = takeFlag(args, "--no-tailscale");
  const skipDoctor = takeFlag(args, "--no-doctor");
  const text = args.shift() ?? "";
  noMore(args, "factory machine join <code> [--no-tailscale] [--no-doctor]");
  if (!text) refuse("bad-code", "No join code was given.", "factory machine join <code>  (the code `factory machine add <name>` printed on the hub)");
  const p = decodeCode(text);
  if (now() >= p.exp) {
    refuse("code-expired", `The join code for ${p.name} has expired.`, "Ask for a new one: run `factory machine remove " + p.name + "` and `factory machine add " + p.name + " --agent ...` on the hub.");
  }
  const usedFile = join(configDir(), "machine-joins.json");
  const used = readJson<string[]>(usedFile, []);
  if (used.includes(p.id)) {
    refuse("code-used", "This join code was already used on this machine.", `Make a new one on the hub: factory machine remove ${p.name}, then factory machine add ${p.name} --agent ...`);
  }
  if (natsState()?.mode === "hub") {
    refuse("is-hub", "This machine runs the hub, so it can't join another.", "Run `factory machine join` on the new machine instead.");
  }
  if (!skipTailscale && !tailscaleUp()) {
    refuse("tailscale-missing", `Tailscale isn't installed or isn't up here, and the hub is at ${p.hub.address}.`,
      "Install and start Tailscale (tailscale up) and run this again; with another route to the hub (a tunnel) add --no-tailscale.");
  }
  const docker = dockerUsable();

  const m: Made = { files: [], dirs: [], restore: [] };
  const project = p.project;
  const creds = credsDir(loadConfig(), project);
  try {
    if (!existsSync(creds)) {
      mkdirSync(creds, { recursive: true, mode: 0o700 });
      m.dirs.push(creds);
    }
    chmodSync(creds, 0o700);
    for (const a of p.agents) {
      const file = join(creds, `${a.name}.nk`);
      if (existsSync(file)) m.restore.push([file, readFileSync(file, "utf8")]);
      else m.files.push(file);
      writeAtomic(file, a.seed + "\n", 0o600);
    }
    if (docker) {
      const dir = natsDir();
      const pwFile = join(dir, "leaf.password");
      if (!existsSync(dir)) m.dirs.push(dir);
      else if (existsSync(pwFile)) m.restore.push([pwFile, readFileSync(pwFile, "utf8")]);
      else m.files.push(pwFile);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeAtomic(pwFile, p.leafPassword + "\n", 0o600);
      const r = natsCli(["up", "--leaf", `${p.hub.address}:${p.hub.leaf}`]);
      if (r.code !== 0) {
        const e = lastError(r.stderr);
        refuse("leaf-failed", `The leaf server didn't start: ${e?.message ?? (r.stderr || r.stdout).trim().slice(-300)}`,
          (e?.fix ?? "Fix that") + ". Nothing was kept; the join code still works.");
      }
    }
  } catch (e) {
    undoAll(m);
    throw e;
  }
  writeAtomic(usedFile, pyDumps([...used, p.id]) + "\n", 0o600);
  const names = [...new Set([...(Array.isArray(machineSettings().agents) ? (machineSettings().agents as unknown[]).map(String) : []), ...p.agents.map((a) => a.name)])];
  saveMachineSettings({ agents: names });

  const url = docker ? "nats://127.0.0.1:4222" : `nats://${p.hub.address}:${p.hub.client}`;
  console.log(`Joined the hub at ${p.hub.address} as ${p.name}, with ${p.agents.map((a) => `${a.name} (${a.role})`).join(", ")}.`);
  console.log(docker ? "Docker is running here, so a Docker leaf (factory nats up --leaf) runs a NATS server and the agents talk to it."
    : "Docker isn't available here, so the agents connect directly to the hub (no leaf server).");
  console.log(`Keys: ${creds} (folder 700, files 600).`);
  console.log(`Point the agents at it: factory settings set messaging.transport nats; factory settings set messaging.url ${url}`);
  if (skipDoctor) return 0;
  const d = run([process.execPath, "--no-env-file", "--config=/dev/null", join(HERE, "factory_doctor.ts")], { timeoutMs: 120_000 });
  const out = (d.stdout + d.stderr).trim();
  if (out) console.log(out);
  console.log(`doctor: ${d.code === 0 ? "ok" : `found things to fix (exit ${d.code}); the lines above say what to do`}`);
  return 0;
}

// ---------- ls and remove ----------
function stateOf(r: Record_, t: number): { state: "waiting" | "expired"; minutes: number } {
  const left = r.expiresAt - t;
  return left > 0 ? { state: "waiting", minutes: Math.ceil(left / 60) } : { state: "expired", minutes: 0 };
}

function cmdLs(argv: string[]): number {
  const args = [...argv];
  const json = takeFlag(args, "--json");
  noMore(args, "factory machine ls [--json]");
  const t = now();
  const rows = readRecords();
  if (json) {
    console.log(pyDumps(rows.map((r) => ({ name: r.name, agents: r.agents, state: stateOf(r, t).state, expiresAt: r.expiresAt }))));
    return 0;
  }
  if (!rows.length) {
    console.log("No machines added yet. Add one: factory machine add <name> --agent <agent>");
    return 0;
  }
  for (const r of rows) {
    const s = stateOf(r, t);
    console.log(`${r.name}  ${r.agents.map((a) => a.name).join(", ")}  ${s.state === "waiting" ? `waiting for join (expires in ${s.minutes} min)` : "code expired"}`);
  }
  return 0;
}

function cmdRemove(argv: string[]): number {
  const args = [...argv];
  const name = args.shift() ?? "";
  noMore(args, "factory machine remove <name>");
  const all = readRecords();
  const r = all.find((x) => x.name === name);
  if (!r) refuse("unknown-machine", `There is no machine called ${JSON.stringify(name)}.`, "factory machine ls lists them.");
  const { removed, reloaded } = removeUsers(r.project, r.agents.map((a) => a.name));
  saveRecords(all.filter((x) => x !== r));
  console.log(`Removed ${name}. Took the keys of ${removed.join(", ") || "no agent"} off the hub` +
    (reloaded ? " and reloaded the server." : "; the server isn't running, so it takes effect at `factory nats up`."));
  return 0;
}

export function machineMain(cmd: string, rest: string[]): number {
  if (cmd === "add") return cmdAdd(rest);
  if (cmd === "join") return cmdJoin(rest);
  if (cmd === "ls") return cmdLs(rest);
  if (cmd === "remove") return cmdRemove(rest);
  throw new Exit(1);
}
