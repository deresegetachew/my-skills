#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// `factory board <verb>`: factory-message-board's command (decision 0007 point 10). `factory board help` lists the verbs.
// The board's URL comes from MB_URL or <machine settings folder>/message-board/url (mode 600); it is never printed
// with its password.
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { Board, type BoardEvent, BoardError, type ContextEntry, migrationNames, type Task } from "./src/index.ts";
import {
  boardDir, boardUrl, CommandError, compose, composeYaml, DB_NAME, DB_USER, DEFAULT_PORT, dockerReady, ensureDir, IMAGE, isCommandError,
  masked, readState, type State, tailscaleAddress, urlFor, Writes,
} from "./src/server.ts";

const USAGE = `factory board <verb>: the message board (factory-message-board, decision 0007): tasks, claims, threads and
events on Postgres.

  factory board up [--port N]        start the board's Postgres in Docker on this machine (${IMAGE}), on 127.0.0.1:N
                                     (default ${DEFAULT_PORT}) and the Tailscale address (port N+1), then migrate it
  factory board down [--purge]       stop it; --purge also removes its data
  factory board status               whether the board answers, its schema and its counts
  factory board migrate              apply the schema migrations not applied yet (safe to run twice)
  factory board backup [--out FILE]  a pg_dump from inside the container, mode 600
  factory board sweep [--quiet-minutes N]
                                     release the claims whose time is up and whose holder has been quiet N minutes (30)
  factory board tasks [--all] [--json]
                                     the tasks not done (--all: every task)
  factory board ready [--json]       the ready queue, in claim order
  factory board show <id> [--json]   one task: its fields, edges, context and thread
  factory board prime <actor> [--json]
                                     an actor's start: what it holds, what is ready, what is blocked, recent events

The URL lives in ${join("<machine settings folder>", "message-board", "url")} (MB_URL overrides it).`;

// ---------- small helpers ----------
function fail(code: string, message: string, fix: string): never {
  throw new CommandError(code, message, fix);
}

function errorLine(e: { code: string; message: string; fix: string }): string {
  return `{${(["code", "message", "fix"] as const).map((k) => `${JSON.stringify(k)}: ${JSON.stringify(e[k])}`).join(", ")}}`;
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) fail("bad-input", `${name} needs a value.`, "factory board help");
  args.splice(i, 2);
  return v;
}

function flag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
}

function leftovers(args: string[], usage: string): void {
  if (args.length) fail("bad-input", `${args[0]} isn't an option here.`, `Usage: ${usage}`);
}

function wholeNumber(text: string | undefined, what: string, min: number, max: number): number {
  const n = Number(text);
  if (!Number.isInteger(n) || n < min || n > max) fail("bad-input", `${what} must be a whole number from ${min} to ${max}, not ${JSON.stringify(text ?? "")}.`, "factory board help");
  return n;
}

function noBoard(): never {
  return fail("no-board", "No message board is set up on this machine.",
    `Start one here with \`factory board up\`, or write its URL to ${join(boardDir(), "url")} (mode 600).`);
}

async function openBoard(as = "system"): Promise<Board> {
  const url = boardUrl();
  if (!url) noBoard();
  return Board.open(url, { as, max: 2 });
}

async function withBoard<T>(fn: (b: Board) => Promise<T>, as?: string): Promise<T> {
  const b = await openBoard(as);
  try {
    return await fn(b);
  } finally {
    await b.end().catch(() => {});
  }
}

const print = (s = ""): void => console.log(s);
const json = (v: unknown): void => console.log(JSON.stringify(v, null, 2));
const state = (t: Task): string => (t.blocked && t.status === "open" ? "blocked" : t.status);

function taskLine(t: Task): string {
  return `#${String(t.id).padEnd(5)} ${state(t).padEnd(11)} ${(t.holder ?? t.assignee ?? "").padEnd(12)} ${t.title}`;
}

function contextLine(c: ContextEntry): string {
  return `${c.kind.padEnd(9)} #${c.taskId} ${c.author}: ${c.body}`;
}

function eventLine(e: BoardEvent): string {
  return `${String(e.seq).padStart(6)}  ${e.at.toISOString().slice(0, 19).replace("T", " ")}  ${e.kind.padEnd(15)} ${e.subject.padEnd(14)} ${e.actor}`;
}

// ---------- server verbs ----------
async function up(argv: string[]): Promise<number> {
  const args = [...argv];
  const before = readState();
  const portText = option(args, "--port");
  leftovers(args, "factory board up [--port N]");
  const port = portText === undefined ? (before?.port ?? DEFAULT_PORT) : wholeNumber(portText, "--port", 1, 65534);
  dockerReady();
  const address = tailscaleAddress();
  const s: State = { port, tailnetPort: port + 1, address, image: IMAGE };
  const dir = boardDir();
  const fresh = !existsSync(dir);
  ensureDir(dir, 0o700);
  const w = new Writes();
  const undo = (): void => {
    w.undo();
    if (fresh) rmSync(dir, { recursive: true, force: true });
  };
  let password: string;
  try {
    const pwFile = join(dir, "password");
    password = existsSync(pwFile) ? readFileSync(pwFile, "utf8").trim() : "";
    if (!password) password = randomBytes(24).toString("base64url");
    w.put(pwFile, password + "\n", 0o600);
    w.put(join(dir, "db.env"), `POSTGRES_USER=${DB_USER}\nPOSTGRES_DB=${DB_NAME}\nPOSTGRES_PASSWORD=${password}\n`, 0o600);
    w.put(join(dir, "compose.yaml"), composeYaml(s), 0o644);
    w.put(join(dir, "url"), urlFor(password, port) + "\n", 0o600);
    w.put(join(dir, "state.json"), JSON.stringify(s, null, 2) + "\n", 0o644);
  } catch (e) {
    undo();
    throw e;
  }
  const r = compose(["up", "-d", ...(w.changed ? ["--force-recreate"] : [])]);
  if (r.code !== 0) {
    undo();
    fail("compose-failed", `docker compose couldn't start the board's Postgres: ${(r.stderr || r.stdout).trim().slice(-400)}`,
      "Fix what Docker says, then run `factory board up` again. Nothing was changed.");
  }
  print(w.changed ? `Started the message board (${IMAGE}) from ${dir}.` : `The message board is up to date (${dir}).`);
  print(`This machine connects on 127.0.0.1:${port}` + (address ? `; other machines on ${address}:${s.tailnetPort}.` : "."));
  if (!address) {
    print("note: Tailscale isn't installed or isn't up here, so the board listens on localhost only: other machines can't " +
      "reach it. Start Tailscale (`tailscale up`) and run `factory board up` again.");
  }
  print(`The URL, with its password, is in ${join(dir, "url")} (mode 600).`);
  const wait = Number(process.env.MB_WAIT_SECONDS ?? "60");
  const deadline = Date.now() + (Number.isFinite(wait) ? wait : 60) * 1000;
  for (;;) {
    if (compose(["exec", "-T", "db", "pg_isready", "-U", DB_USER, "-d", DB_NAME], { timeoutMs: 15_000 }).code === 0 || Date.now() >= deadline) break;
    await Bun.sleep(1000);
  }
  let applied: string[];
  try {
    applied = await withBoard((b) => b.migrate());
  } catch (e) {
    if (e instanceof BoardError && e.code === "no-answer") {
      fail("no-answer", `The board's Postgres started but doesn't answer on 127.0.0.1:${port} yet.`,
        "Wait a moment, then run `factory board migrate`; `factory board status` says whether it answers.");
    }
    throw e;
  }
  print(applied.length ? `Applied ${applied.join(", ")}.` : "The schema is up to date.");
  return 0;
}

function down(argv: string[]): number {
  const args = [...argv];
  const purge = flag(args, "--purge");
  leftovers(args, "factory board down [--purge]");
  if (!existsSync(join(boardDir(), "compose.yaml"))) {
    print("Nothing to stop: `factory board up` hasn't run on this machine.");
    return 0;
  }
  dockerReady();
  const r = compose(["down", "--remove-orphans", ...(purge ? ["--volumes"] : [])]);
  if (r.code !== 0) {
    fail("compose-failed", `docker compose couldn't stop the board's Postgres: ${(r.stderr || r.stdout).trim().slice(-400)}`,
      "Fix what Docker says, then run `factory board down` again.");
  }
  print(purge ? "Stopped the message board and removed its data." : "Stopped the message board. Its data is kept (--purge removes it).");
  return 0;
}

function backup(argv: string[]): number {
  const args = [...argv];
  const out = option(args, "--out");
  leftovers(args, "factory board backup [--out FILE]");
  const dir = boardDir();
  if (!existsSync(join(dir, "compose.yaml"))) {
    fail("no-board", "There is no board container on this machine to back up.", "Run `factory board up` first, or run the backup on the machine that runs the board.");
  }
  dockerReady();
  let path = out;
  if (!path) {
    ensureDir(join(dir, "backups"), 0o700);
    path = join(dir, "backups", `board-${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}.sql`);
  }
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, "w", 0o600);
  let r: { code: number; stderr: string };
  try {
    r = compose(["exec", "-T", "db", "pg_dump", "-U", DB_USER, "-d", DB_NAME], { stdout: fd, timeoutMs: 3_600_000 });
  } finally {
    closeSync(fd);
  }
  if (r.code !== 0) {
    rmSync(tmp, { force: true });
    fail("backup-failed", `pg_dump failed: ${r.stderr.trim().slice(-400)}`, "Check that the board runs (`factory board status`), then run this again.");
  }
  renameSync(tmp, path);
  print(`Wrote a backup of the board to ${path} (${statSync(path).size} bytes, mode 600).`);
  return 0;
}

async function status(argv: string[]): Promise<number> {
  leftovers([...argv], "factory board status");
  const url = boardUrl();
  if (!url) {
    print(`No message board is set up on this machine. Start one: \`factory board up\`, or write its URL to ${join(boardDir(), "url")}.`);
    return 1;
  }
  print(`url       ${masked(url)}`);
  const s = readState();
  if (s) print(`listens   127.0.0.1:${s.port}` + (s.address ? `, ${s.address}:${s.tailnetPort} (Tailscale)` : " (localhost only: no Tailscale)"));
  let b: Board;
  try {
    b = await Board.open(url, { max: 1 });
  } catch (e) {
    print(`server    doesn't answer (${e instanceof BoardError ? e.code : "error"}). Start it: \`factory board up\``);
    return 1;
  }
  try {
    const info = await b.info();
    print(`answers   ${info.server}`);
    const want = migrationNames();
    const missing = want.filter((m) => !info.migrations.includes(m));
    print(`schema    ${info.migrations.at(-1) ?? "none"}` + (missing.length ? ` (${missing.length} to apply: \`factory board migrate\`)` : ""));
    if (info.counts) print(`tasks     ${Object.entries(info.counts).map(([k, v]) => `${v} ${k}`).join(", ") || "none"}`);
    return missing.length ? 1 : 0;
  } finally {
    await b.end().catch(() => {});
  }
}

// ---------- board verbs ----------
async function migrateVerb(argv: string[]): Promise<number> {
  leftovers([...argv], "factory board migrate");
  const applied = await withBoard((b) => b.migrate());
  print(applied.length ? `Applied ${applied.join(", ")}.` : `The schema is up to date (${migrationNames().at(-1)}).`);
  return 0;
}

async function sweep(argv: string[]): Promise<number> {
  const args = [...argv];
  const q = option(args, "--quiet-minutes");
  leftovers(args, "factory board sweep [--quiet-minutes N]");
  const quietSeconds = q === undefined ? undefined : wholeNumber(q, "--quiet-minutes", 0, 100_000) * 60;
  const swept = await withBoard((b) => b.sweep({ quietSeconds }));
  if (!swept.length) print("No stale claims.");
  for (const s of swept) print(`released #${s.id} (held by ${s.holder})`);
  return 0;
}

async function tasks(argv: string[]): Promise<number> {
  const args = [...argv];
  const all = flag(args, "--all");
  const asJson = flag(args, "--json");
  leftovers(args, "factory board tasks [--all] [--json]");
  const list = await withBoard((b) => b.tasks({ all }));
  if (asJson) json(list);
  else if (!list.length) print(all ? "No tasks on the board." : "No open tasks on the board.");
  else for (const t of list) print(taskLine(t));
  return 0;
}

async function ready(argv: string[]): Promise<number> {
  const args = [...argv];
  const asJson = flag(args, "--json");
  leftovers(args, "factory board ready [--json]");
  const list = await withBoard((b) => b.ready());
  if (asJson) json(list);
  else if (!list.length) print("Nothing is ready.");
  else for (const t of list) print(taskLine(t));
  return 0;
}

async function show(argv: string[]): Promise<number> {
  const args = [...argv];
  const asJson = flag(args, "--json");
  const idText = args.shift();
  leftovers(args, "factory board show <id> [--json]");
  if (idText === undefined) fail("bad-input", "show needs a task id.", "For example: factory board show 12");
  const id = wholeNumber(idText.replace(/^#/, ""), "A task id", 1, Number.MAX_SAFE_INTEGER);
  const got = await withBoard(async (b) => {
    const task = await b.get(id);
    return { task, edges: await b.edges(id), context: await b.contextFor(id), thread: await b.thread({ task: id }) };
  });
  if (asJson) {
    json(got);
    return 0;
  }
  const t = got.task;
  print(`#${t.id} ${t.title}`);
  print(`status    ${t.status}${t.outcome ? ` (${t.outcome})` : ""}`);
  if (t.holder) print(`holder    ${t.holder}${t.claimUntil ? ` (claim until ${t.claimUntil.toISOString()})` : ""}`);
  if (t.assignee) print(`handed to ${t.assignee}`);
  print(`kind      ${t.kind}, priority ${t.priority}, version ${t.version}`);
  if (t.ref) print(`ref       ${t.ref}`);
  if (t.parentId) print(`parent    #${t.parentId}`);
  if (t.blocked) print(`blocked   by ${t.blockedBy.map((x) => `#${x}`).join(", ")}`);
  for (const e of got.edges) print(e.from === id ? `edge      ${e.kind} #${e.to}` : `edge      #${e.from} ${e.kind} this`);
  if (t.body) print(`\n${t.body}`);
  if (got.context.length) {
    print("\nContext");
    for (const c of got.context) print(`  ${contextLine(c)}`);
  }
  if (got.thread.length) {
    print("\nThread");
    for (const m of got.thread) print(`  ${m.id} ${m.kind} ${m.from}${m.to ? ` -> ${m.to}` : ""} (${m.state}): ${m.body}`);
  }
  return 0;
}

async function prime(argv: string[]): Promise<number> {
  const args = [...argv];
  const asJson = flag(args, "--json");
  const actor = args.shift();
  leftovers(args, "factory board prime <actor> [--json]");
  if (!actor) fail("bad-input", "prime needs an actor's name.", "For example: factory board prime haile");
  const p = await withBoard((b) => b.prime(actor));
  if (asJson) {
    json(p);
    return 0;
  }
  print(`Start for ${actor}`);
  print("\nHolding");
  if (!p.holding.length) print("  nothing");
  for (const h of p.holding) {
    print(`  ${taskLine(h.task)}`);
    for (const c of h.context) print(`      ${contextLine(c)}`);
  }
  print("\nReady");
  if (!p.ready.length) print("  nothing");
  for (const t of p.ready) print(`  ${taskLine(t)}`);
  print("\nBlocked");
  if (!p.blocked.length) print("  nothing");
  for (const t of p.blocked) print(`  ${taskLine(t)} (by ${t.blockedBy.map((x) => `#${x}`).join(", ")})`);
  print("\nRecent");
  if (!p.recent.length) print("  nothing");
  for (const e of p.recent) print(`  ${eventLine(e)}`);
  return 0;
}

const VERBS: Record<string, (args: string[]) => number | Promise<number>> = {
  up, down, status, migrate: migrateVerb, backup, sweep, tasks, ready, show, prime,
};

async function main(argv: string[]): Promise<number> {
  const [verb = "help", ...rest] = argv;
  if (verb === "help" || verb === "-h" || verb === "--help") {
    print(USAGE);
    return 0;
  }
  const run = VERBS[verb];
  if (!run) fail("unknown-verb", `\`${verb}\` isn't a board verb.`, "Run `factory board help` to see the verbs.");
  return run(rest);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  if (isCommandError(e)) {
    console.error(errorLine({ code: e.code, message: e.message, fix: e.fix }));
    process.exitCode = 1;
  } else {
    console.error(errorLine({ code: "unexpected", message: masked(e instanceof Error ? e.message : String(e)), fix: "Run it again; if it keeps failing, report this message." }));
    process.exitCode = 1;
  }
}
