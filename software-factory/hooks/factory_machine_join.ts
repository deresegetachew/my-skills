#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// `factory machine add|join|ls|remove` (#445): put another computer on the hub without copying passwords by hand.
//
//   factory machine add <name> [--agents haile,tewodros:manager] [--project P] [--minutes N] [--json]
//       on the hub: make the keys of the agents that machine will run (`factory nats user add`, a role after a colon,
//       builder by default), and print one join code (15 minutes by default) that carries the hub's Tailscale address,
//       the leaf password and those agents' seeds. The code is a secret: send it to that machine only.
//   factory machine join <code> [--no-doctor]
//       on the new machine: check the code, check Docker and Tailscale, write the seeds (mode 600, folder 700) and the
//       leaf password (mode 600), start the leaf (`factory nats up --leaf` underneath) and run `factory doctor`. Without
//       Docker the agents connect straight to the hub; it says which way it chose.
//   factory machine ls [--json]       the codes this hub made and whether each one still waits
//   factory machine remove <name>     forget the machine (a code already given out works until it expires; says how to cut a machine off)
//
// The hub keeps who it made codes for in <config folder>/machines.json (mode 600, no secrets in it). A code works once on
// the machine that joins: that machine records the code's id in used-codes.json and refuses it the second time. The hub
// can't see a join, so `ls` shows a code as waiting until it expires or is removed.
// Errors are `{code, message, fix}` on stderr.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { load } from "./factory_config.ts";
import { Exit, pyDumps, run, runMain, which } from "./factory_lib.ts";
import { configDir, refuse } from "./factory_machine.ts";
import { cmdUp, cmdUser, credsDir, NatsError, natsDir, projectName, readState, readUsers, tailscaleAddress } from "./factory_nats.ts";
import { NAME, ROLES, type Role, roleOf } from "./factory_nats_keys.ts";

const PREFIX = "FJ1-";
const DEFAULT_MINUTES = 15;

interface Agent { name: string; role: Role; seed: string }
interface Code {
  v: 1;
  id: string;
  machine: string;
  project: string;
  /** The hub's Tailscale address and ports. */
  hub: { address: string; leaf: number; client: number };
  leafPassword: string;
  agents: Agent[];
  /** When it stops working, in milliseconds since 1970. */
  expires: number;
}
interface Entry { name: string; id: string; project: string; agents: string[]; made: number; expires: number }

// ---------- the code ----------
export function encodeCode(c: Code): string {
  return PREFIX + Buffer.from(JSON.stringify(c)).toString("base64url");
}

function bad(why: string): never {
  return refuse("bad-code", `That isn't a join code (${why}).`, "Copy the whole code that `factory machine add <name>` printed on the hub, or make a new one there.");
}

export function decodeCode(text: string): Code {
  const t = text.trim();
  if (!t.startsWith(PREFIX)) bad("it should start with FJ1-");
  let c: Partial<Code>;
  try {
    c = JSON.parse(Buffer.from(t.slice(PREFIX.length), "base64url").toString("utf8")) as Partial<Code>;
  } catch {
    return bad("it can't be read; a part may be missing");
  }
  const h = c.hub;
  if (c.v !== 1 || typeof c.id !== "string" || typeof c.machine !== "string" || typeof c.project !== "string" ||
    typeof c.leafPassword !== "string" || typeof c.expires !== "number" || !h || typeof h.address !== "string" ||
    typeof h.leaf !== "number" || typeof h.client !== "number" || !Array.isArray(c.agents)) bad("it is missing parts");
  return c as Code;
}

// ---------- files ----------
function writeAtomic(path: string, text: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

function readJson<T>(path: string, empty: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return empty;
  }
}

const machinesFile = (): string => join(configDir(), "machines.json");
const usedFile = (): string => join(configDir(), "used-codes.json");
const readEntries = (): Entry[] => {
  const e = readJson<Entry[]>(machinesFile(), []);
  return Array.isArray(e) ? e : [];
};
const writeEntries = (e: Entry[]): void => writeAtomic(machinesFile(), pyDumps(e, { indent: 2 }) + "\n", 0o600);

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) refuse("missing-value", `${name} needs a value.`, "factory help");
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

/** Runs `fn` with its console output thrown away (the commands we call print for a person at a terminal). */
async function quiet<T>(fn: () => T | Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => undefined;
  try {
    return await fn();
  } finally {
    console.log = log;
  }
}

// ---------- add ----------
const ADD_USAGE = "factory machine add <name> [--agents haile,tewodros:manager] [--project P] [--minutes N] [--json]";

function parseAgents(text: string | undefined, project: string): { name: string; role: Role }[] {
  const known = readUsers().filter((u) => u.project === project);
  return (text ?? "").split(",").map((s) => s.trim()).filter((s) => s).map((item) => {
    const [name = "", roleText] = item.split(":");
    if (!NAME.test(name)) refuse("bad-name", `The agent's name ${JSON.stringify(name)} must be lowercase letters, digits and dashes.`, `Usage: ${ADD_USAGE}`);
    const role = roleText === undefined ? (known.find((u) => u.name === name)?.role ?? "builder") : roleOf(roleText);
    if (!role) refuse("bad-role", `The role ${JSON.stringify(roleText)} of ${name} must be one of ${ROLES.join(", ")}.`, `For example: --agents ${name}:builder`);
    return { name, role };
  });
}

async function cmdAdd(argv: string[]): Promise<number> {
  const args = [...argv];
  const agentsText = option(args, "--agents");
  const given = option(args, "--project");
  const minutesText = option(args, "--minutes");
  const json = flag(args, "--json");
  const name = args.shift() ?? "";
  leftovers(args, ADD_USAGE);
  if (!NAME.test(name)) {
    refuse("bad-name", `The machine's name ${JSON.stringify(name)} must be lowercase letters, digits and dashes.`, `Usage: ${ADD_USAGE}`);
  }
  const minutes = minutesText === undefined ? DEFAULT_MINUTES : Number(minutesText);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
    refuse("bad-minutes", `--minutes needs a whole number from 1 to 1440, not ${JSON.stringify(minutesText)}.`, `For example: factory machine add ${name} --minutes 15`);
  }
  const project = projectName(given);
  const s = readState();
  const pwFile = join(natsDir(), "leaf.password");
  if (!s || s.mode !== "hub") {
    refuse("no-hub", "This machine isn't running the NATS hub, so there is nothing for another machine to join.",
      "Start the hub here first: `factory nats up --hub`, then run this again.");
  }
  if (!s.address) {
    refuse("no-tailscale", "The hub listens on localhost only (Tailscale isn't up here), so another machine can't reach it.",
      "Start Tailscale (`tailscale up`), run `factory nats up`, then run this again.");
  }
  let password = "";
  try {
    password = readFileSync(pwFile, "utf8").trim();
  } catch {
    password = "";
  }
  if (!password) {
    refuse("no-leaf-password", `The hub's leaf password isn't in ${pwFile}.`, "Run `factory nats up --hub` on this machine to make it, then run this again.");
  }
  const now = Date.now();
  const entries = readEntries();
  const old = entries.find((e) => e.name === name);
  if (old && old.expires > now) {
    refuse("machine-exists", `There is already a code for ${name} that has not expired.`,
      `Void it first: factory machine remove ${name}; then run this again.`);
  }
  const wanted = parseAgents(agentsText, project);
  const agents: Agent[] = [];
  const creds = credsDir(loadConfig(), project);
  for (const a of wanted) {
    await quiet(() => cmdUser(["add", a.name, "--role", a.role, "--project", project]));
    const seed = readFileSync(join(creds, `${a.name}.nk`), "utf8").trim();
    agents.push({ name: a.name, role: readUsers().find((u) => u.project === project && u.name === a.name)?.role ?? a.role, seed });
  }
  const code: Code = { v: 1, id: randomBytes(9).toString("base64url"), machine: name, project,
    hub: { address: s.address, leaf: s.ports.leaf, client: s.ports.tailnet }, leafPassword: password, agents, expires: now + minutes * 60_000 };
  writeEntries([...entries.filter((e) => e.name !== name), { name, id: code.id, project, agents: agents.map((a) => a.name), made: now, expires: code.expires }]);
  const text = encodeCode(code);
  if (json) {
    console.log(JSON.stringify({ machine: name, code: text, expires: code.expires, minutes, agents: agents.map((a) => a.name),
      command: `factory machine join ${text}` }));
    return 0;
  }
  console.log(`Join code for ${name} (works once, expires in ${minutes} minutes):`);
  console.log("");
  console.log(text);
  console.log("");
  console.log(`On ${name}, run: factory machine join <the code>`);
  console.log(agents.length ? `It carries the keys of ${agents.map((a) => a.name).join(", ")}.`
    : "It carries no agent keys. Make a new code with --agents haile,tewodros to send some.");
  console.log("The code is a secret: send it to that machine only, and don't paste it in a chat or an issue.");
  return 0;
}

function loadConfig(): ReturnType<typeof load> | null {
  try {
    return load();
  } catch {
    return null;
  }
}

// ---------- join ----------
const JOIN_USAGE = "factory machine join <code> [--no-doctor]";

function dockerOk(): boolean {
  return which("docker") !== null && run(["docker", "info"], { timeoutMs: 30_000 }).code === 0;
}

async function cmdJoin(argv: string[]): Promise<number> {
  const args = [...argv];
  const noDoctor = flag(args, "--no-doctor");
  const text = args.shift() ?? "";
  leftovers(args, JOIN_USAGE);
  if (!text) refuse("no-code", "No join code was given.", `Run it with the code the hub printed: ${JOIN_USAGE}`);
  const code = decodeCode(text);
  if (Date.now() > code.expires) {
    refuse("code-expired", `The code for ${code.machine} has expired.`, "On the hub, make a new one: `factory machine add " + code.machine + "`.");
  }
  const used = readJson<string[]>(usedFile(), []);
  if (used.includes(code.id)) {
    refuse("code-used", "That code was already used on this machine.", `A code works once. On the hub, make a new one: \`factory machine add ${code.machine}\`.`);
  }
  const before = readState();
  if (before?.mode === "hub") {
    refuse("is-hub", "This machine runs the hub, so it can't join one.", "Join from another machine. To make this one a leaf instead: `factory nats down`, then join.");
  }
  const cfg = loadConfig();
  const creds = credsDir(cfg, code.project);
  for (const a of code.agents) {
    if (!NAME.test(a.name) || !NAME.test(code.project)) bad("an agent name is not valid");
    const have = existsSync(join(creds, `${a.name}.nk`)) ? readFileSync(join(creds, `${a.name}.nk`), "utf8").trim() : null;
    if (have !== null && have !== a.seed) {
      refuse("seed-differs", `${join(creds, `${a.name}.nk`)} already holds a different key for ${a.name}.`,
        `Move it away (mv ${join(creds, `${a.name}.nk`)} ${join(creds, `${a.name}.nk`)}.old), then join again. Nothing was changed.`);
    }
  }
  const docker = dockerOk();
  const address = tailscaleAddress();
  console.log(`Docker: ${docker ? "running" : "not available"}. Tailscale: ${address ? `up (${address})` : "not up"}.`);
  if (!address) {
    console.log(`note: Tailscale isn't up here. The hub at ${code.hub.address} must be reachable some other way (a tunnel, or the same network).`);
  }

  // Write everything, and undo it all if the leaf won't start.
  const written: string[] = [];
  const created: string[] = [];
  const undo = (): void => {
    for (const p of written) rmSync(p, { force: true });
    for (const d of created.reverse()) rmSync(d, { recursive: true, force: true });
  };
  const put = (path: string, body: string): void => {
    if (!existsSync(path)) written.push(path);
    writeAtomic(path, body, 0o600);
  };
  try {
    if (code.agents.length) {
      if (!existsSync(creds)) created.push(creds);
      mkdirSync(creds, { recursive: true, mode: 0o700 });
      chmodSync(creds, 0o700);
      for (const a of code.agents) put(join(creds, `${a.name}.nk`), a.seed + "\n");
    }
    if (docker) {
      const dir = natsDir();
      if (!existsSync(dir)) created.push(dir);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      put(join(dir, "leaf.password"), code.leafPassword + "\n");
      await quiet(() => cmdUp(["--leaf", `${code.hub.address}:${code.hub.leaf}`]));
    }
  } catch (e) {
    undo();
    throw e;
  }
  writeAtomic(usedFile(), JSON.stringify([...used, code.id]) + "\n", 0o600);

  const url = docker ? `nats://127.0.0.1:${readState()?.ports.client ?? 4222}` : `nats://${code.hub.address}:${code.hub.client}`;
  console.log(docker
    ? `Started a leaf server that connects to the hub at ${code.hub.address}:${code.hub.leaf}. The agents here talk to it on ${url}.`
    : `Docker isn't available, so no leaf server was started. The agents here connect straight to the hub on ${url}.`);
  console.log(`Keys written for ${code.agents.length ? code.agents.map((a) => a.name).join(", ") : "no agents"} in ${creds} (mode 600).`);
  console.log(`Set the server address the agents use: factory settings set messaging.url ${url}`);
  if (noDoctor) console.log("Skipped `factory doctor` (--no-doctor). Run it yourself: factory doctor");
  else {
    const r = run(["bun", "--no-env-file", "--config=/dev/null", join(import.meta.dir, "factory_doctor.ts")], { inherit: true, timeoutMs: 300_000 });
    console.log(r.code === 0 ? "factory doctor passed." : "factory doctor listed things to fix (above). Fix them, then run `factory doctor` again.");
  }
  console.log(`${code.machine} is on the hub. Give it agents: factory machine setup <names>`);
  return 0;
}

// ---------- ls and remove ----------
function cmdLs(argv: string[]): number {
  const args = [...argv];
  const json = flag(args, "--json");
  leftovers(args, "factory machine ls [--json]");
  const now = Date.now();
  const rows = readEntries().map((e) => ({ ...e, state: e.expires > now ? "waiting" : "expired",
    minutesLeft: e.expires > now ? Math.ceil((e.expires - now) / 60_000) : 0 }));
  if (json) {
    console.log(JSON.stringify(rows));
    return 0;
  }
  if (!rows.length) {
    console.log("No join codes were made on this machine. Make one: factory machine add <name>");
    return 0;
  }
  for (const r of rows) {
    console.log(`${r.name.padEnd(16)} ${r.state === "waiting" ? `code waiting, ${r.minutesLeft} min left` : "code expired"}  agents: ${r.agents.join(", ") || "none"}`);
  }
  return 0;
}

function cmdRemove(argv: string[]): number {
  const args = [...argv];
  const name = args.shift() ?? "";
  leftovers(args, "factory machine remove <name>");
  const entries = readEntries();
  if (!entries.some((e) => e.name === name)) {
    refuse("unknown-machine", `This hub has no machine called ${JSON.stringify(name)}.`, "factory machine ls lists them.");
  }
  writeEntries(entries.filter((e) => e.name !== name));
  console.log(`Forgot ${name}. The hub can't recall a code it already gave out: it stops working when it expires, and a machine that ` +
    `already joined keeps working until the hub's leaf password changes. To cut it off now, delete ${join(natsDir(), "leaf.password")} ` +
    "and run `factory nats up --hub` to make a new password (the other machines then need a new code).");
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0] ?? "";
  const rest = argv.slice(1);
  try {
    if (cmd === "add") return await cmdAdd(rest);
    if (cmd === "join") return await cmdJoin(rest);
    if (cmd === "ls") return cmdLs(rest);
    if (cmd === "remove") return cmdRemove(rest);
    return refuse("unknown-command", `factory machine has no command ${JSON.stringify(cmd)} here.`, "factory machine add | join | ls | remove");
  } catch (e) {
    if (e instanceof NatsError) {
      process.stderr.write(pyDumps({ code: e.code, message: e.message, fix: e.fix }) + "\n");
      throw new Exit(1);
    }
    throw e;
  }
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
