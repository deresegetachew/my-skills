// `factory machine add|join|ls|remove` (#445, #504, epic #420): a machine joins the factory's message board without
// copying a password by hand.
//
//   factory machine add <name> --agent <agent>[:role] ... [--ttl minutes] [--json]    (on the machine that runs the board)
//       makes the machine's own board login (`factory board login add <name>`: a Postgres role with only the board's
//       rights) and prints one join code. The code carries the board's URL for that login (the board's Tailscale
//       address and port) and the agents' names; it works once and expires (15 minutes by default): a machine that hasn't
//       joined by then has its login dropped.
//   factory machine join <code> [--no-tailscale] [--no-doctor]                         (on the new machine)
//       checks Tailscale, redeems the code on the board (its login gets a new password, which only this machine has),
//       writes the board's URL with it to this machine's settings folder (message-board/url: folder 700, file 600), and
//       runs `factory doctor`. With a board set up, messaging.transport is board by default.
//   factory machine leave             (on a machine that joined) stop using the board here: its URL file goes, and the
//       agent names the join added to this machine's names
//   factory machine ls [--json]       the machines added: joined, waiting for join, or code expired (login dropped)
//   factory machine remove <name>     forget the machine and drop its board login (its connections are ended)
//
// The hub keeps the records in <machine settings folder>/machines.json (mode 600). The code is the secret: whoever holds
// a live one can join, so it is shown once, and the board enforces both its expiry and its one use (#514). Its login
// is made with VALID UNTIL the code's expiry (`factory board login add --valid-for`), so Postgres itself refuses the
// code's password after that. `join` redeems it (mb_redeem_login on the board): the login's expiry is lifted and it gets
// a new random password, written only here; the code's own password stops working there, so a second machine with a
// copy of the code is refused. The redeem is committed only once this machine has written what it keeps, so a join that
// fails here spends nothing. `add` and `ls` ask the board which logins were redeemed (`factory board login ls`): a
// machine whose login was redeemed is marked joined; one whose code expired unredeemed has its login dropped (`login
// remove --unredeemed`; marked revoked, kept so `ls` can say so). When the board doesn't answer nothing is changed.
// Errors are `{code, message, fix}` on stderr.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Board, BoardError, boardDir, LOGIN_NAME } from "../message-board/src/index.ts";
import { now } from "./factory_clock.ts";
import { Exit, pyDumps, run, which } from "./factory_lib.ts";
import { configDir, machineSettings, refuse, saveMachineSettings, writeMachineSettings } from "./factory_machine.ts";

const PREFIX = "FM1-";
const VERSION = 2; // 1 carried NATS keys (#445); 2 carries a board login (#504)
const DEFAULT_TTL_MINUTES = 15;
const ADD_USAGE = "factory machine add <name> --agent <agent>[:role] [--agent ...] [--ttl minutes] [--json]";
const BOARD_BIN = join(import.meta.dir, "..", "message-board", "bin.ts");
const AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ROLES = ["builder", "manager", "po", "owner"] as const;
type Role = (typeof ROLES)[number];
const ROLE_ALIASES: Record<string, Role> = { "coding-agent": "builder", "dev-manager": "manager", "product-owner": "po" };

interface AgentName { name: string; role: Role }
interface Payload {
  v: typeof VERSION;
  id: string;
  name: string;
  exp: number;
  url: string; // the board for this machine's login, password included
  agents: AgentName[];
}
interface Record_ {
  name: string; id: string; createdAt: number; expiresAt: number; agents: AgentName[];
  joinedAt?: number; // the board says its code was redeemed (machine join)
  revokedAt?: number; // its code expired before it joined: its login was dropped
}
interface BoardLogin { name: string; redeemedAt: string | null }
/** What a join wrote here, so `leave` takes back only that (<board folder>/joined.json). */
interface Joined { name: string; agents: string[] }
type Problem = { code: string; message: string; fix: string };

function roleOf(text: string): Role | null {
  if ((ROLES as readonly string[]).includes(text)) return text as Role;
  return ROLE_ALIASES[text] ?? null;
}

// ---------- the code ----------
export function encodeCode(p: Payload): string {
  return PREFIX + Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
}

function boardUrlOk(text: unknown): boolean {
  try {
    const u = new URL(String(text));
    return (u.protocol === "postgres:" || u.protocol === "postgresql:") && Boolean(u.hostname && u.username && u.password);
  } catch {
    return false;
  }
}

/** The code's content, or a `bad-code` refusal for anything that isn't one (a code from before #504 included). */
export function decodeCode(text: string): Payload {
  const bad = (): never => refuse("bad-code", "That isn't a join code.",
    "Copy the whole code that `factory machine add <name>` printed on the machine that runs the board (it starts with FM1-).");
  const t = text.trim();
  if (!t.startsWith(PREFIX)) return bad();
  let p: Payload;
  try {
    p = JSON.parse(Buffer.from(t.slice(PREFIX.length), "base64url").toString("utf8")) as Payload;
  } catch {
    return bad();
  }
  const ok = p && p.v === VERSION && typeof p.id === "string" && LOGIN_NAME.test(String(p.name)) && typeof p.exp === "number" &&
    boardUrlOk(p.url) && Array.isArray(p.agents) && p.agents.length > 0 &&
    p.agents.every((a) => AGENT_NAME.test(String(a.name)) && roleOf(String(a.role)));
  return ok ? p : bad();
}

// ---------- small helpers ----------
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
  return join(configDir(), "machines.json");
}

function readRecords(): Record_[] {
  const r = readJson<Record_[]>(machinesFile(), []);
  return Array.isArray(r) ? r : [];
}

function saveRecords(rs: Record_[]): void {
  writeAtomic(machinesFile(), pyDumps(rs, { indent: 2 }) + "\n", 0o600);
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

/** `factory board <args>` (the board's own command): its stdout, or the {code, message, fix} it refused with. */
function board(args: string[]): { ok: true; stdout: string } | { ok: false; problem: Problem } {
  const r = run([process.execPath, "--no-env-file", "--config=/dev/null", BOARD_BIN, ...args], { timeoutMs: 60_000 });
  if (r.code === 0) return { ok: true, stdout: r.stdout };
  try {
    const e = JSON.parse(r.stderr.trim().split("\n").at(-1) ?? "") as Partial<Problem>;
    if (typeof e.code === "string" && typeof e.message === "string" && typeof e.fix === "string") return { ok: false, problem: e as Problem };
  } catch {
    // not one of the board's errors
  }
  return { ok: false, problem: { code: "board-failed", message: `\`factory board ${args[0]} ${args[1] ?? ""}\` failed: ${(r.stderr || r.stdout).trim().slice(-300)}`,
    fix: "Run `factory board status` to see whether the board answers, then run this again." } };
}

function refuseWith(p: Problem): never {
  return refuse(p.code, p.message, p.fix);
}

// ---------- the hub enforces the code (sweep) ----------
/** Marks the machines whose code the board saw redeemed as joined, and drops the login of those whose code expired
 * unredeemed. `checked` is false when the board didn't answer; then nothing changes. */
function sweep(): { records: Record_[]; checked: boolean } {
  const records = readRecords();
  const open = records.filter((r) => r.joinedAt === undefined && r.revokedAt === undefined);
  if (!open.length) return { records, checked: true };
  const listed = board(["login", "ls", "--json"]);
  if (!listed.ok) return { records, checked: false };
  const logins = new Map((JSON.parse(listed.stdout) as BoardLogin[]).map((l) => [l.name, l]));
  const t = Math.floor(now());
  let changed = false;
  for (const r of open) {
    const l = logins.get(r.name);
    if (l?.redeemedAt) {
      r.joinedAt = t;
      changed = true;
    } else if (t >= r.expiresAt) {
      const gone = l ? board(["login", "remove", r.name, "--unredeemed"]) : { ok: true as const, stdout: "" };
      if (gone.ok || gone.problem.code === "not-found") r.revokedAt = t;
      else if (gone.problem.code === "login-redeemed") r.joinedAt = t; // it joined a moment ago
      else continue; // the board stopped answering: try again next time
      changed = true;
    }
  }
  if (changed) saveRecords(records);
  return { records, checked: true };
}

// ---------- add ----------
function parseAgent(text: string): AgentName {
  const [name = "", roleText = "builder"] = text.split(":");
  const role = roleOf(roleText);
  if (!AGENT_NAME.test(name)) refuse("bad-name", `The agent name ${JSON.stringify(name)} must be lowercase letters, digits and dashes.`, `Usage: ${ADD_USAGE}`);
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
  if (!LOGIN_NAME.test(name)) {
    refuse("bad-name", `The machine's name ${JSON.stringify(name)} must be lowercase letters, digits and dashes (up to 40), starting with a letter.`, `Usage: ${ADD_USAGE}`);
  }
  if (!agents.length) refuse("no-agents", "No agents were named: the code carries the names of the agents that machine runs.", `Usage: ${ADD_USAGE}`);
  const ttl = ttlText === undefined ? DEFAULT_TTL_MINUTES : Number(ttlText);
  if (!Number.isFinite(ttl) || ttl <= 0) refuse("bad-ttl", `--ttl needs minutes above 0, not ${JSON.stringify(ttlText)}.`, `Usage: ${ADD_USAGE}`);

  sweep(); // expired codes that never joined lose their logins first
  const records = readRecords();
  if (records.some((r) => r.name === name)) {
    refuse("machine-exists", `A machine called ${name} is already added.`, `Remove it first with \`factory machine remove ${name}\`, or choose another name.`);
  }
  const taken = new Set(records.flatMap((r) => r.agents.map((a) => a.name)));
  const dup = agents.find((a, i) => taken.has(a.name) || agents.findIndex((b) => b.name === a.name) !== i);
  if (dup) {
    refuse("agent-taken", `${dup.name} is already named for another machine (or twice here), and one name is one agent.`,
      "Choose a name no other agent uses; `factory machine ls` shows the names machines hold.");
  }
  const made = board(["login", "add", name, "--valid-for", String(Math.max(1, Math.ceil(ttl * 60))), "--json"]);
  if (!made.ok) refuseWith(made.problem);
  const { url } = JSON.parse(made.stdout) as { url: string };
  const t = now();
  const expiresAt = Math.floor(t + ttl * 60);
  const id = randomBytes(6).toString("hex");
  try {
    saveRecords([...readRecords(), { name, id, createdAt: Math.floor(t), expiresAt, agents }]);
  } catch (e) {
    board(["login", "remove", name]); // nothing half done: without its record the hub would never take it away
    refuse("record-failed", `Couldn't save the machine's record (${machinesFile()}): ${e instanceof Error ? e.message : String(e)}. Its board login was dropped again.`,
      `Make ${configDir()} writable for this user, then run this again.`);
  }
  const code = encodeCode({ v: VERSION, id, name, exp: expiresAt, url, agents });
  const command = `factory machine join ${code}`;
  if (json) {
    console.log(pyDumps({ name, code, expiresAt, agents, command }));
    return 0;
  }
  console.log(`Join code for ${name} (works once, expires in ${Math.round(ttl)} min: if ${name} hasn't joined by then, its board login is removed). ` +
    `It holds ${name}'s own login to the message board, for ${agents.map((a) => a.name).join(", ")}: send it over a private channel.`);
  console.log(code);
  console.log(`On ${name}, in the project's folder, run:`);
  console.log(command);
  return 0;
}

// ---------- join ----------
function tailscaleUp(): boolean {
  return Boolean(which("tailscale")) && run(["tailscale", "ip", "-4"], { timeoutMs: 10_000 }).code === 0;
}

/** An error's text with any URL's password masked. */
function masked(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).replace(/\/\/[^@\s]*@/g, "//***@");
}

/** `url` with `password` in place of its own. */
function withPassword(url: string, password: string): string {
  const u = new URL(url);
  u.password = encodeURIComponent(password);
  return u.toString();
}

async function cmdJoin(argv: string[]): Promise<number> {
  const args = [...argv];
  const skipTailscale = takeFlag(args, "--no-tailscale");
  const skipDoctor = takeFlag(args, "--no-doctor");
  const text = args.shift() ?? "";
  noMore(args, "factory machine join <code> [--no-tailscale] [--no-doctor]");
  if (!text) refuse("bad-code", "No join code was given.", "factory machine join <code>  (the code `factory machine add <name>` printed on the machine that runs the board)");
  const p = decodeCode(text);
  if (now() >= p.exp) {
    refuse("code-expired", `The join code for ${p.name} has expired.`,
      `Ask for a new one: run \`factory machine remove ${p.name}\` and \`factory machine add ${p.name} --agent ...\` on the machine that runs the board.`);
  }
  const usedFile = join(configDir(), "machine-joins.json");
  const used = readJson<string[]>(usedFile, []);
  if (used.includes(p.id)) {
    refuse("code-used", "This join code was already used on this machine.", `Make a new one on the board's machine: factory machine remove ${p.name}, then factory machine add ${p.name} --agent ...`);
  }
  const dir = boardDir();
  if (existsSync(join(dir, "state.json"))) {
    refuse("is-hub", "This machine runs the message board, so it can't join another.", "Run `factory machine join` on the new machine instead.");
  }
  const where = new URL(p.url);
  const address = `${where.hostname}:${where.port || "5432"}`;
  if (!skipTailscale && !tailscaleUp()) {
    refuse("tailscale-missing", `Tailscale isn't installed or isn't up here, and the board is at ${address}.`,
      "Install and start Tailscale (tailscale up) and run this again; with another route to the board (a tunnel) add --no-tailscale.");
  }

  // Redeem the code on the board and, inside that transaction, write what this machine keeps: the URL with the login's
  // new password, the code as used, the agents' names. Anything that fails puts back what was there, and the board
  // undoes the redeem, so the code still works.
  const file = join(dir, "url");
  const joinedFile = join(dir, "joined.json");
  const freshDir = !existsSync(dir);
  const before = existsSync(file) ? readFileSync(file, "utf8") : null;
  const joinedBefore = existsSync(joinedFile) ? readFileSync(joinedFile, "utf8") : null;
  const usedBefore = existsSync(usedFile) && statSync(usedFile).isFile() ? readFileSync(usedFile, "utf8") : null;
  let wroteUsed = false;
  const settingsBefore = machineSettings();
  let wroteSettings = false;
  const undo = (): void => {
    if (before === null) rmSync(file, { force: true });
    else writeAtomic(file, before, 0o600);
    if (joinedBefore === null) rmSync(joinedFile, { force: true });
    else writeAtomic(joinedFile, joinedBefore, 0o600);
    if (freshDir) rmSync(dir, { recursive: true, force: true });
    if (wroteUsed) {
      if (usedBefore === null) rmSync(usedFile, { force: true });
      else writeAtomic(usedFile, usedBefore, 0o600);
    }
    if (wroteSettings) {
      try {
        writeMachineSettings(settingsBefore);
      } catch {
        // it was never written
      }
    }
  };
  const newCode = `Ask the hub for a new code: on the hub run \`factory machine remove ${p.name}\` and ` +
    `\`factory machine add ${p.name} --agent ...\`, then \`factory machine join <code>\` here. Nothing was changed here.`;
  let b: Board;
  try {
    b = await Board.open(p.url, { max: 1 });
  } catch (e) {
    if (e instanceof BoardError && e.code === "login-refused") {
      refuse("code-refused", `The board at ${address} refused ${p.name}'s join code: it was used to join already, it expired, or the machine was removed on the hub.`, newCode);
    }
    refuse("board-unreachable", `${p.name}'s login doesn't reach the board at ${address}: ${masked(e).slice(0, 300)}`,
      "Check that Tailscale is up on both machines and that the board runs (`factory board status` on its machine). Nothing was kept.");
  }
  let saving = false;
  try {
    await b.redeemLogin((password) => {
      saving = true;
      const mine = settingsBefore.agents;
      const had = Array.isArray(mine) ? mine.map(String) : [];
      const added = p.agents.map((a) => a.name).filter((n) => !had.includes(n));
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      writeAtomic(file, withPassword(p.url, password) + "\n", 0o600);
      writeAtomic(joinedFile, pyDumps({ name: p.name, agents: added } satisfies Joined) + "\n", 0o600);
      writeAtomic(usedFile, pyDumps([...used, p.id]) + "\n", 0o600);
      wroteUsed = true; // only once it is written: a failed write changed nothing
      wroteSettings = true;
      saveMachineSettings({ agents: [...had, ...added] });
      saving = false;
    });
  } catch (e) {
    undo();
    if (e instanceof BoardError && e.code === "login-compromised") {
      refuse("code-compromised", `${p.name}'s join was redeemed on the board, but its new login didn't hold: this code may have been copied. Nothing was kept here.`,
        `Run \`factory machine remove ${p.name}\` on the hub and make a new code (\`factory machine add ${p.name} --agent ...\`), then join with it.`);
    }
    if (e instanceof BoardError && (e.code === "login-redeemed" || e.code === "login-expired")) {
      refuse(e.code === "login-redeemed" ? "code-used" : "code-expired", `The board refused ${p.name}'s join code: ${masked(e)}`, newCode);
    }
    if (saving) {
      refuse("join-not-saved", `Couldn't record the join in ${configDir()}: ${masked(e)}. Nothing was kept, and the code wasn't used.`,
        `Make ${configDir()} writable for this user (machine-joins.json must be a file), then run this again; the code still works.`);
    }
    if (e instanceof BoardError) refuse(e.code, `${p.name}'s join wasn't finished: ${masked(e)} Nothing was kept.`, e.fix);
    throw e;
  } finally {
    await b.end().catch(() => {});
  }

  console.log(`Joined the message board at ${address} as ${p.name}, with ${p.agents.map((a) => `${a.name} (${a.role})`).join(", ")}.`);
  console.log(`The board's URL, with ${p.name}'s own login and a password only this machine has: ${file} (folder 700, file 600). ` +
    "With it, messaging.transport is board by default. The code is used up: it joins no other machine.");
  if (skipDoctor) return 0;
  const d = run([process.execPath, "--no-env-file", "--config=/dev/null", join(import.meta.dir, "factory_doctor.ts")], { timeoutMs: 120_000 });
  const out = (d.stdout + d.stderr).trim();
  if (out) console.log(out);
  console.log(`doctor: ${d.code === 0 ? "ok" : `found things to fix (exit ${d.code}); the lines above say what to do`}`);
  return 0;
}

// ---------- ls and remove ----------
type State = "joined" | "waiting" | "revoked" | "expired-unchecked";

function stateOf(r: Record_, t: number): { state: State; minutes: number } {
  if (r.revokedAt !== undefined) return { state: "revoked", minutes: 0 };
  if (r.joinedAt !== undefined) return { state: "joined", minutes: 0 };
  const left = r.expiresAt - t;
  return left > 0 ? { state: "waiting", minutes: Math.ceil(left / 60) } : { state: "expired-unchecked", minutes: 0 };
}

function stateText(r: Record_, s: { state: State; minutes: number }): string {
  if (s.state === "joined") return "joined";
  if (s.state === "waiting") return `waiting for join (expires in ${s.minutes} min)`;
  if (s.state === "revoked") {
    return `code expired; its board login was removed (add it again: factory machine remove ${r.name}, then factory machine add ${r.name} --agent ...)`;
  }
  return "code expired; not checked: the board doesn't answer (factory board status)";
}

function cmdLs(argv: string[]): number {
  const args = [...argv];
  const json = takeFlag(args, "--json");
  noMore(args, "factory machine ls [--json]");
  const { records: rows } = sweep();
  const t = now();
  if (json) {
    console.log(pyDumps(rows.map((r) => ({ name: r.name, agents: r.agents, state: stateOf(r, t).state, expiresAt: r.expiresAt,
      joinedAt: r.joinedAt ?? null, revokedAt: r.revokedAt ?? null }))));
    return 0;
  }
  if (!rows.length) {
    console.log("No machines added yet. Add one: factory machine add <name> --agent <agent>");
    return 0;
  }
  for (const r of rows) console.log(`${r.name}  ${r.agents.map((a) => a.name).join(", ")}  ${stateText(r, stateOf(r, t))}`);
  return 0;
}

function cmdRemove(argv: string[]): number {
  const args = [...argv];
  const name = args.shift() ?? "";
  noMore(args, "factory machine remove <name>");
  const all = readRecords();
  const r = all.find((x) => x.name === name);
  if (!r) refuse("unknown-machine", `There is no machine called ${JSON.stringify(name)}.`, "factory machine ls lists them.");
  const gone = board(["login", "remove", name]);
  if (!gone.ok && gone.problem.code !== "not-found") { // not-found: its login was already dropped (its code expired)
    refuse(gone.problem.code, `${name} was kept: its board login couldn't be dropped. ${gone.problem.message}`, gone.problem.fix);
  }
  saveRecords(all.filter((x) => x !== r));
  console.log(`Removed ${name} and its board login; its connections to the board were ended.`);
  return 0;
}

// ---------- leave ----------
function cmdLeave(argv: string[]): number {
  noMore([...argv], "factory machine leave");
  const dir = boardDir();
  if (existsSync(join(dir, "state.json"))) {
    refuse("is-hub", "This machine runs the message board, so it can't leave it.",
      "To stop the board here run `factory board down`; to stop another machine using it run `factory machine remove <name>` here.");
  }
  const file = join(dir, "url");
  const joinedFile = join(dir, "joined.json");
  if (!existsSync(file) && !existsSync(joinedFile)) {
    console.log(`This machine doesn't use a message board (there is no ${file}): nothing to do.`);
    if (process.env.MB_URL) console.log("MB_URL is set in this shell: unset it too to stop using that board.");
    return 0;
  }
  const joined = readJson<Partial<Joined>>(joinedFile, {});
  const added = Array.isArray(joined.agents) ? joined.agents.map(String) : [];
  const mine = machineSettings().agents;
  if (added.length && Array.isArray(mine)) {
    const kept = mine.map(String).filter((n) => !added.includes(n));
    saveMachineSettings({ agents: kept }); // first: should it fail, the URL is still there and leave can run again
  }
  rmSync(file, { force: true });
  rmSync(joinedFile, { force: true });
  try {
    rmdirSync(dir); // only when nothing else is in it
  } catch {
    // other files stay
  }
  const name = typeof joined.name === "string" ? joined.name : "<name>";
  console.log(`This machine no longer uses the message board: removed ${file}` +
    (added.length ? ` and the agent names its join added (${added.join(", ")})` : "") + ".");
  console.log(`Its login is still on the board until the hub drops it: on the hub run \`factory machine remove ${name}\`.`);
  if (process.env.MB_URL) console.log("MB_URL is set in this shell: unset it too to stop using that board.");
  return 0;
}

export async function machineMain(cmd: string, rest: string[]): Promise<number> {
  if (cmd === "add") return cmdAdd(rest);
  if (cmd === "join") return await cmdJoin(rest);
  if (cmd === "leave") return cmdLeave(rest);
  if (cmd === "ls") return cmdLs(rest);
  if (cmd === "remove") return cmdRemove(rest);
  throw new Exit(1);
}
