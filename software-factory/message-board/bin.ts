#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// `factory board <verb>`: factory-message-board's command (decision 0007 point 10). `factory board help` lists the verbs.
// The board's URL comes from MB_URL or <machine settings folder>/message-board/url (mode 600); it is never printed
// with its password.
import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { Board, type BoardEvent, BoardError, type ContextEntry, migrationNames, type Task } from "./src/index.ts";
import { PROTOCOL_VERSIONS, type Role, ROLES, serveMcp } from "./src/mcp.ts";
import { Numbers } from "./src/numbers.ts";
import {
  boardDir, boardUrl, CommandError, compose, COMPOSE_PROJECT, composeYaml, DB_NAME, DB_USER, DEFAULT_PORT, dockerReady, ensureDir, IMAGE, isCommandError,
  masked, readState, sh, type State, tailscaleAddress, urlFor, Writes,
} from "./src/server.ts";
import { ghCli, GithubError, type ImportSummary, importFromGithub, repoName } from "./src/github/import.ts";

const USAGE = `factory board <verb>: the message board (factory-message-board, decision 0007): tasks, claims, threads and
events on Postgres.

  factory board up [--port N]        start the board's Postgres in Docker on this machine (${IMAGE}), on 127.0.0.1:N
                                     (default ${DEFAULT_PORT}) and the Tailscale address (port N+1), then migrate it
  factory board down [--purge]       stop it; --purge also removes its data
  factory board status               whether the board answers, its schema and its counts
  factory board migrate              apply the schema migrations not applied yet (safe to run twice)
  factory board backup [--out FILE]  a pg_dump from inside the container (no owner, no grants), mode 600; its default
                                     name, backups/board-<date>-<time>-utc.sql, is in UTC
  factory board restore <file> --yes replace the board's data with a backup's, in one transaction, then migrate it;
                                     refused without --yes. Machine logins aren't in a backup: machines join again
  factory board sweep [--quiet-minutes N]
                                     release the claims whose time is up and whose holder has been quiet N minutes (30);
                                     on the board's machine, also drop the join codes' logins that expired unredeemed
  factory board tasks [--all] [--json]
                                     the tasks not done (--all: every task)
  factory board ready [--for <actor>] [--json]
                                     the ready queue, in claim order; tasks handed to an actor show only with --for
  factory board show <number> [--json]
                                     one task: its fields, edges, context and thread
  factory board prime <actor> [--json]
                                     an actor's start: what it holds, what is ready, what is blocked, recent events

  A task is named by its number: #3 (or 3) for issue 3 of the project, b17 for a task made on the board. The project's
  repo is --repo owner/name (tasks, ready, show, prime, sweep, mcp), else GH_REPO or the folder's git remote origin.
  factory board mcp --as <actor> [--session <id>] [--role owner|manager|builder]
                                     serve the board to one agent as an MCP server over stdio (JSON-RPC, one message a
                                     line); every write is recorded as <actor>, and no tool can name another sender.
                                     --role owner or manager adds the tools that move, create, assign and link cards
                                     (default builder); \`factory board mcp --help\` shows how to add it to Claude Code
  factory board import github [--closed] [--dry-run] [--repo owner/name] [--board-is-record]
                                     bring the repo's open issues in as tasks (--closed: the closed ones too, as done),
                                     their comments as threads; safe to run twice. --dry-run says what it would do and
                                     writes nothing. The repo is the git remote origin unless --repo names it
                                     GitHub wins on status unless the task is held on the board (a task done on the
                                     board but open on GitHub is reopened); comments deleted on GitHub stay on the board.
                                     --board-is-record: a status the board changed since the last import is kept too
                                     (the factory passes it when tasks.source is board). Comments the board's mirror
                                     wrote are never brought back
  factory board login add <name> [--valid-for SECONDS] [--json]
                                     on the machine that runs the board: a login of its own for another machine, with
                                     only the board's rights (connect, read and write the board's tables). Prints its URL
                                     (the board's Tailscale address, and the login's password) once. --valid-for: a join
                                     code's login, refused by Postgres after that unless redeemed (factory machine join)
  factory board login ls [--json]    each login: when it was first used, or never used, whether it is connected now, and
                                     whether its join code was redeemed
  factory board login remove <name> [--unused|--unredeemed]
                                     drop the login and end its connections; --unused: only if it was never used;
                                     --unredeemed: only if its join code wasn't redeemed

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
/** A task's state word; an open note (an issue that isn't work: a channel, an untriaged report) is `note` (#520). */
const state = (t: Task): string => (t.kind === "note" && t.status === "open" ? "note" : t.blocked && t.status === "open" ? "blocked" : t.status);

/** How tasks are named here (#515): --repo, else GH_REPO or the folder's git remote origin; with neither, no repo (any
 * GitHub issue's task is "#n"). A --repo that isn't a repo name is refused. */
function numbersFor(args: string[]): Numbers {
  const given = option(args, "--repo");
  if (given !== undefined) return new Numbers(repoName(given));
  try {
    return new Numbers(repoName(undefined));
  } catch {
    return new Numbers(null);
  }
}

/** The numbers ("#3", "b17") of the tasks with these board ids: from `known`, else read from the board. */
async function labelsOf(b: Board, n: Numbers, ids: number[], known: Task[] = []): Promise<Map<number, string>> {
  const out = new Map(known.map((t) => [t.id, n.label(t)]));
  for (const id of ids) {
    if (out.has(id)) continue;
    try {
      out.set(id, n.label(await b.get(id)));
    } catch {
      out.set(id, `b${id}`); // gone from the board: its board id is all there is
    }
  }
  return out;
}

/** A task with its number beside its board id, for --json (a program may still want the id). */
const numbered = (n: Numbers, t: Task): Task & { number: string } => ({ ...t, number: n.label(t) });

const named = (labels: Map<number, string>, id: number): string => labels.get(id) ?? `b${id}`;

function taskLine(t: Task, n: Numbers): string {
  return `${n.label(t).padEnd(6)} ${state(t).padEnd(11)} ${(t.holder ?? t.assignee ?? "").padEnd(12)} ${t.title}`;
}

function contextLine(c: ContextEntry, labels: Map<number, string>): string {
  return `${c.kind.padEnd(9)} ${named(labels, c.taskId)} ${c.author}: ${c.body}`;
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
  refuseLostPassword(dir);
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
  // a container that is stopped (not changed, not running) is started by this run: say so, not "up to date" (#515)
  const wasRunning = !fresh && compose(["ps", "--status", "running", "--quiet", "db"], { timeoutMs: 60_000 }).stdout.trim() !== "";
  const r = compose(["up", "-d", ...(w.changed ? ["--force-recreate"] : [])]);
  if (r.code !== 0) {
    undo();
    fail("compose-failed", `docker compose couldn't start the board's Postgres: ${(r.stderr || r.stdout).trim().slice(-400)}`,
      "Fix what Docker says, then run `factory board up` again. Nothing was changed.");
  }
  print(w.changed || !wasRunning ? `Started the message board (${IMAGE}) from ${dir}.` : `The message board is up to date (${dir}).`);
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

/** The data volume keeps the password Postgres was first started with: a new one would never authenticate. */
function refuseLostPassword(dir: string): void {
  const file = join(dir, "password");
  if (existsSync(file) && readFileSync(file, "utf8").trim()) return;
  const volume = `${COMPOSE_PROJECT}_data`;
  if (sh(["docker", "volume", "inspect", volume], { timeoutMs: 30_000 }).code !== 0) return;
  fail("password-missing", `${file} is gone, but the board's data (the Docker volume ${volume}) is still there; a new password wouldn't open it.`,
    `Put the old password back in ${file} (mode 600), or start over with \`factory board down --purge\` (it deletes the board's data) and then \`factory board up\`.`);
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
    path = join(dir, "backups", `board-${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}-utc.sql`);
  }
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, "w", 0o600);
  let r: { code: number; stderr: string };
  try {
    r = compose(["exec", "-T", "db", "pg_dump", "-U", DB_USER, "-d", DB_NAME, "--no-owner", "--no-privileges"], { stdout: fd, timeoutMs: 3_600_000 });
  } finally {
    closeSync(fd);
  }
  if (r.code !== 0) {
    rmSync(tmp, { force: true });
    fail("backup-failed", `pg_dump failed: ${r.stderr.trim().slice(-400)}`, "Check that the board runs (`factory board status`), then run this again.");
  }
  renameSync(tmp, path);
  print(`Wrote a backup of the board to ${path} (${statSync(path).size} bytes, mode 600)` + (out ? "." : "; the time in its name is UTC."));
  return 0;
}

const RESTORE_USAGE = "factory board restore <file> --yes";

/** `factory board restore <file> --yes` (#515): the board's data replaced with a backup's, in one transaction inside the
 * running container (psql --single-transaction: a failure changes nothing), then migrated. Refused without --yes. */
async function restore(argv: string[]): Promise<number> {
  const args = [...argv];
  const yes = flag(args, "--yes");
  const file = args.shift();
  leftovers(args, RESTORE_USAGE);
  const dir = boardDir();
  if (!file) fail("bad-input", "restore needs the backup file.", `For example: factory board restore ${join(dir, "backups", "board-20261107-101500-utc.sql")} --yes`);
  if (!existsSync(file) || !statSync(file).isFile()) {
    fail("no-file", `There is no backup file at ${file}.`, `Check the path: \`factory board backup\` says where it wrote each one (${join(dir, "backups")} unless --out named another).`);
  }
  if (!existsSync(join(dir, "compose.yaml"))) {
    fail("no-board", "There is no board container on this machine to restore into.", "Run it on the machine that runs the board, after `factory board up`.");
  }
  if (!yes) {
    fail("needs-yes", `A restore replaces everything on the board with what ${file} holds: what was written since that backup is lost.`,
      `Take a backup of the board as it is now if you may want it (factory board backup), then run factory board restore ${file} --yes.`);
  }
  dockerReady();
  const fd = openSync(file, "r");
  let r: { code: number; stderr: string };
  try {
    r = compose(["exec", "-T", "db", "psql", "-U", DB_USER, "-d", DB_NAME, "-q", "-v", "ON_ERROR_STOP=1", "--single-transaction",
      "-c", "SET lock_timeout = '60s'", "-c", "DROP SCHEMA public CASCADE", "-c", "CREATE SCHEMA public", "-f", "-"], { stdin: fd, timeoutMs: 3_600_000 });
  } finally {
    closeSync(fd);
  }
  if (r.code !== 0) {
    fail("restore-failed", `psql couldn't restore ${file}: ${r.stderr.trim().slice(-400) || `exit ${r.code}`}`,
      "Nothing was changed: the restore runs in one transaction. Check that the board runs (`factory board status`, `factory board up`) and that the file " +
      "is one `factory board backup` wrote, then run this again.");
  }
  print(`Restored the message board from ${file}.`);
  const applied = await withBoard((b) => b.migrate());
  print(applied.length ? `Applied ${applied.join(", ")}.` : "The schema is up to date.");
  print("Machine logins aren't in a backup: each other machine joins again. On this machine run `factory machine remove <name>` and " +
    "`factory machine add <name> --agent <agent>`; on that machine, `factory machine join <code>`.");
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
    if (e instanceof BoardError && e.code === "login-refused") {
      if (s) print(`server    answers, but refused the board's own user. Put the password \`factory board up\` wrote back in ${join(boardDir(), "url")} (mode 600).`);
      else print(`server    answers, but ${e.message} ${e.fix}`);
      return 1;
    }
    const code = e instanceof BoardError ? e.code : "error";
    if (s) print(`server    doesn't answer (${code}). Start it: \`factory board up\``);
    else {
      print(`server    doesn't answer (${code}). The board runs on another machine (the hub): check that Tailscale is up here and ` +
        "there, and that the board runs (`factory board status` on the hub).");
    }
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
  const n = numbersFor(args);
  leftovers(args, "factory board sweep [--quiet-minutes N] [--repo owner/name]");
  const quietSeconds = q === undefined ? undefined : wholeNumber(q, "--quiet-minutes", 0, 100_000) * 60;
  const { swept, labels, logins } = await withBoard(async (b) => {
    const s = await b.sweep({ quietSeconds });
    return { swept: s, labels: await labelsOf(b, n, s.map((x) => x.id)), logins: await b.dropExpiredLogins() };
  });
  const { dropped, warnings } = logins;
  if (!swept.length) print("No stale claims.");
  for (const s of swept) print(`released ${named(labels, s.id)} (held by ${s.holder})`);
  for (const name of dropped) print(`dropped the login ${name}: its join code expired unredeemed (its sessions were ended)`);
  for (const w of warnings) console.error(`warning: ${w}`);
  return 0;
}

async function tasks(argv: string[]): Promise<number> {
  const args = [...argv];
  const all = flag(args, "--all");
  const asJson = flag(args, "--json");
  const n = numbersFor(args);
  leftovers(args, "factory board tasks [--all] [--json] [--repo owner/name]");
  const list = await withBoard((b) => b.tasks({ all }));
  if (asJson) json(list.map((t) => numbered(n, t)));
  else if (!list.length) print(all ? "No tasks on the board." : "No open tasks on the board.");
  else for (const t of list) print(taskLine(t, n));
  return 0;
}

async function ready(argv: string[]): Promise<number> {
  const args = [...argv];
  const asJson = flag(args, "--json");
  const who = option(args, "--for");
  const n = numbersFor(args);
  leftovers(args, "factory board ready [--for <actor>] [--json] [--repo owner/name]");
  const list = await withBoard((b) => b.ready({ for: who }));
  if (asJson) json(list.map((t) => numbered(n, t)));
  else if (!list.length) print("Nothing is ready.");
  else for (const t of list) print(taskLine(t, n));
  return 0;
}

async function show(argv: string[]): Promise<number> {
  const args = [...argv];
  const asJson = flag(args, "--json");
  const n = numbersFor(args);
  const idText = args.shift();
  leftovers(args, "factory board show <number> [--json] [--repo owner/name]");
  if (idText === undefined) fail("bad-input", "show needs a task's number.", "For example: factory board show 12 (issue 12), or factory board show b3 (a task made on the board)");
  const got = await withBoard(async (b) => {
    const { id, label } = await n.resolve(b, idText);
    let task: Task;
    try {
      task = await b.get(id);
    } catch (e) {
      if (e instanceof BoardError && e.code === "not-found") fail("not-found", `There is no task ${label} on the board.`, "Check the number (`factory board tasks` lists them).");
      throw e;
    }
    const edges = await b.edges(id);
    const context = await b.contextFor(id);
    const labels = await labelsOf(b, n, [...edges.flatMap((e) => [e.from, e.to]), ...context.map((c) => c.taskId), ...task.blockedBy,
      ...(task.parentId ? [task.parentId] : [])], [task]);
    return { task, edges, context, thread: await b.thread({ task: id }), labels };
  });
  const { labels, ...rest } = got;
  if (asJson) {
    json({ ...rest, task: numbered(n, got.task) });
    return 0;
  }
  const t = got.task;
  const id = t.id;
  print(`${n.label(t)} ${t.title}`);
  print(`status    ${t.status}${t.outcome ? ` (${t.outcome})` : ""}`);
  if (t.holder) print(`holder    ${t.holder}${t.claimUntil ? ` (claim until ${t.claimUntil.toISOString()})` : ""}`);
  if (t.assignee) print(`handed to ${t.assignee}`);
  print(`kind      ${t.kind}, priority ${t.priority}, version ${t.version}`);
  if (t.ref) print(`ref       ${t.ref}`);
  if (t.parentId) print(`parent    ${named(labels, t.parentId)}`);
  if (t.blocked) print(`blocked   by ${t.blockedBy.map((x) => named(labels, x)).join(", ")}`);
  for (const e of got.edges) print(e.from === id ? `edge      ${e.kind} ${named(labels, e.to)}` : `edge      ${named(labels, e.from)} ${e.kind} this`);
  if (t.body) print(`\n${t.body}`);
  if (got.context.length) {
    print("\nContext");
    for (const c of got.context) print(`  ${contextLine(c, labels)}`);
  }
  if (got.thread.length) {
    print("\nThread");
    for (const m of got.thread) print(`  ${m.id} ${m.kind}${m.tag ? `/${m.tag}` : ""} ${m.from}${m.to ? ` -> ${m.to}` : ""} (${m.state}): ${m.body}`);
  }
  return 0;
}

async function prime(argv: string[]): Promise<number> {
  const args = [...argv];
  const asJson = flag(args, "--json");
  const n = numbersFor(args);
  const actor = args.shift();
  leftovers(args, "factory board prime <actor> [--json] [--repo owner/name]");
  if (!actor) fail("bad-input", "prime needs an actor's name.", "For example: factory board prime haile");
  const { p, labels } = await withBoard(async (b) => {
    const got = await b.prime(actor);
    const known = [...got.holding.map((h) => h.task), ...got.ready, ...got.blocked];
    const ids = [...got.holding.flatMap((h) => h.context.map((c) => c.taskId)), ...got.blocked.flatMap((t) => t.blockedBy)];
    return { p: got, labels: await labelsOf(b, n, ids, known) };
  });
  if (asJson) {
    json({ ...p, holding: p.holding.map((h) => ({ ...h, task: numbered(n, h.task) })), ready: p.ready.map((t) => numbered(n, t)),
      blocked: p.blocked.map((t) => numbered(n, t)) });
    return 0;
  }
  print(`Start for ${actor}`);
  print("\nHolding");
  if (!p.holding.length) print("  nothing");
  for (const h of p.holding) {
    print(`  ${taskLine(h.task, n)}`);
    for (const c of h.context) print(`      ${contextLine(c, labels)}`);
  }
  print("\nReady");
  if (!p.ready.length) print("  nothing");
  for (const t of p.ready) print(`  ${taskLine(t, n)}`);
  print("\nBlocked");
  if (!p.blocked.length) print("  nothing");
  for (const t of p.blocked) print(`  ${taskLine(t, n)} (by ${t.blockedBy.map((x) => named(labels, x)).join(", ")})`);
  print("\nRecent");
  if (!p.recent.length) print("  nothing");
  for (const e of p.recent) print(`  ${eventLine(e)}`);
  return 0;
}

const MCP_USAGE = "factory board mcp --as <actor> [--session <id>] [--role owner|manager|builder] [--repo owner/name]";

const MCP_HELP = `${MCP_USAGE}

Serves the message board to one actor as an MCP server over stdio (JSON-RPC 2.0, one message a line). Every write is
recorded as --as, with --session on its events; no tool takes a sender.

  --role builder (the default)  an agent's tools: board_prime, board_ready, board_claim, board_heartbeat,
                                board_release, board_close, board_show, board_post, board_thread, board_note,
                                board_on_me, board_delegated
  --role owner | manager        those, and the tools that run the board without the web UI:
                                board_move     a task to ready, in_review, deferred, done or blocked
                                               (a held task is taken back from its holder, with a reason)
                                board_create   a task, bug, epic or note, under a parent
                                board_assign   hand a task to one actor: only they may claim it
                                board_link     link two tasks (blocks, waits_for, related ...)
                                               blocks: from must be done before to can start
                                               waits_for: from can't start until to is done
                                board_unlink   remove a link
                                board_comment  a note on a task's thread

Tasks are named by their number, as people see them: 3 or #3 for issue 3 of the project (its repo: --repo, else
GH_REPO or the folder's git remote origin), b17 for a task made on the board. Results name tasks the same way.

Add it to your own Claude Code session, from the project's folder:

  claude mcp add board -- ./factory board mcp --as owner --role owner

or with this file's path, which needs no factory script:

  claude mcp add board -- bun ${join(import.meta.dir, "bin.ts")} mcp --as owner --role owner

Use your own name for --as (it is who the board says moved each card), and --role manager for the dev manager.
The board's URL comes from MB_URL or the machine's url file, as for the other verbs.`;

async function mcp(argv: string[]): Promise<number> {
  const args = [...argv];
  if (args.includes("--help") || args.includes("-h")) {
    print(MCP_HELP);
    return 0;
  }
  const as = option(args, "--as");
  const session = option(args, "--session");
  const roleText = option(args, "--role") ?? "builder";
  const numbers = numbersFor(args);
  leftovers(args, MCP_USAGE);
  if (!(ROLES as readonly string[]).includes(roleText)) {
    fail("bad-input", `--role must be owner, manager or builder, not ${JSON.stringify(roleText)}.`, `Use --role owner, --role manager or --role builder (the default). Usage: ${MCP_USAGE}`);
  }
  const role = roleText as Role;
  if (as === undefined || !as.trim()) fail("bad-input", "mcp needs the actor it serves: --as <actor>.", "For example: factory board mcp --as haile");
  const url = boardUrl();
  if (!url) noBoard();
  const b = await Board.open(url, { as, session, max: 2 });
  // A signal, or a client that stopped reading stdout (EPIPE), ends the server: the board's connections are closed
  // first, and nothing more is written to stdout.
  let stopping = false;
  const shutdown = (code: number, why?: string): void => {
    if (stopping) return;
    stopping = true;
    if (why) console.error(`factory board mcp: ${why}`);
    void b.end().catch(() => {}).finally(() => process.exit(code));
  };
  const gone = "the client stopped reading stdout; closed the board and stopped.";
  process.on("SIGTERM", () => shutdown(143));
  process.on("SIGINT", () => shutdown(130));
  process.stdout.on("error", () => shutdown(0, gone));
  console.error(`factory board mcp: serving the message board to ${as} (${role}) over stdio (MCP ${PROTOCOL_VERSIONS[0]}).`);
  try {
    await serveMcp({ board: b, role, numbers, version: (migrationNames().at(-1) ?? "none").replace(/\.sql$/, "") }, {
      input: process.stdin,
      // A failed write never resolves: the shutdown under way exits the process.
      write: (line) => new Promise<void>((done) => {
        if (stopping) return;
        process.stdout.write(line + "\n", (e) => (e ? shutdown(0, gone) : done()));
      }),
      log: (line) => console.error(line),
    });
  } finally {
    await b.end().catch(() => {});
  }
  return 0;
}

// ---------- logins ----------
const LOGIN_USAGE = "factory board login add <name> [--valid-for SECONDS] [--json] | ls [--json] | remove <name> [--unused|--unredeemed]";

/** A login's URL: the board's address for other machines (its Tailscale address and port), its database, its role. */
function loginUrl(base: string, s: State, role: string, password: string): string {
  const u = new URL(base);
  u.username = encodeURIComponent(role);
  u.password = encodeURIComponent(password);
  u.hostname = s.address;
  u.port = String(s.tailnetPort);
  return u.toString();
}

async function loginAdd(args: string[]): Promise<number> {
  const asJson = flag(args, "--json");
  const validText = option(args, "--valid-for");
  const name = args.shift();
  leftovers(args, "factory board login add <name> [--valid-for SECONDS] [--json]");
  const validFor = validText === undefined ? undefined : wholeNumber(validText, "--valid-for", 1, 31_536_000);
  if (!name) fail("bad-input", "login add needs a name.", "For example: factory board login add laptop");
  const url = boardUrl();
  if (!url) noBoard();
  const s = readState();
  if (!s) {
    fail("not-board-host", "This machine doesn't run the board's Postgres, so it can't make logins for it.",
      "Run it on the machine that ran `factory board up`.");
  }
  if (!s.address) {
    fail("no-tailscale", "The board listens on localhost only (Tailscale wasn't up when it started), so other machines can't reach it.",
      "Start Tailscale (`tailscale up`), then run `factory board up` again, and this.");
  }
  const password = randomBytes(24).toString("base64url");
  const made = await withBoard((b) => b.addLogin(name, password, { validFor }));
  const link = loginUrl(url, s, made.role, password);
  if (asJson) {
    json({ name: made.name, role: made.role, url: link });
    return 0;
  }
  print(`Made the login ${made.name} (role ${made.role}): it may read and write the board's tables, nothing more.`);
  print("Its URL, shown once (it holds the password; send it over a private channel):");
  print(link);
  return 0;
}

async function loginLs(args: string[]): Promise<number> {
  const asJson = flag(args, "--json");
  leftovers(args, "factory board login ls [--json]");
  const { list, warnings } = await withBoard(async (b) => ({ warnings: await b.tidyLogins(), list: await b.logins() }));
  for (const w of warnings) console.error(`warning: ${w}`);
  if (asJson) {
    json(list.map((l) => ({ name: l.name, role: l.role, createdAt: l.createdAt.toISOString(), firstSeen: l.firstSeen?.toISOString() ?? null,
      lastSeen: l.lastSeen?.toISOString() ?? null, connected: l.connected, redeemedAt: l.redeemedAt?.toISOString() ?? null })));
    return 0;
  }
  if (!list.length) print("No logins. Make one for another machine: factory board login add <name>");
  const at = (d: Date): string => d.toISOString().slice(0, 16).replace("T", " ");
  for (const l of list) {
    const used = l.firstSeen ? `used (first ${at(l.firstSeen)}, last ${at(l.lastSeen ?? l.firstSeen)})` : "never used";
    print(`${l.name.padEnd(16)} ${used}${l.connected ? ", connected now" : ""}${l.redeemedAt ? `, joined ${at(l.redeemedAt)}` : ""}`);
  }
  return 0;
}

async function loginRemove(args: string[]): Promise<number> {
  const unused = flag(args, "--unused");
  const unredeemed = flag(args, "--unredeemed");
  const name = args.shift();
  leftovers(args, "factory board login remove <name> [--unused|--unredeemed]");
  if (!name) fail("bad-input", "login remove needs a name.", "For example: factory board login remove laptop");
  await withBoard((b) => b.removeLogin(name, { unused, unredeemed }));
  print(`Removed the login ${name}; its connections were ended.`);
  return 0;
}

async function login(argv: string[]): Promise<number> {
  const [what, ...rest] = argv;
  if (what === "add") return loginAdd(rest);
  if (what === "ls") return loginLs(rest);
  if (what === "remove") return loginRemove(rest);
  return fail("bad-input", what ? `\`login ${what}\` isn't a login verb.` : "login needs a verb.", `Usage: ${LOGIN_USAGE}`);
}

// ---------- import ----------
const IMPORT_USAGE = "factory board import github [--closed] [--dry-run] [--repo owner/name] [--board-is-record]";
const IMPORTER = "github-import"; // the actor an import writes as: its tasks and edges are created_by it

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function importReport(s: ImportSummary): void {
  const r = s.result;
  const what = `the ${s.closed ? "open and closed" : "open"} issues of ${s.repo}`;
  print(r.dryRun ? `Dry run: nothing was written. An import of ${what} would bring:` : `Imported ${what} into the message board.`);
  print(`tasks      ${r.tasks.created} new, ${r.tasks.updated} updated, ${r.tasks.unchanged} unchanged`);
  print(`edges      ${r.edges.added} added, ${r.edges.removed} removed (from "Depends on #n" lines)`);
  print(`parents    ${r.parents} set (from epics' "- [ ] #n" lines)`);
  print(`messages   ${r.messages.created} new, ${r.messages.updated} updated, ${r.messages.unchanged} unchanged`);
  print(`context    ${r.notes.created} new, ${r.notes.updated} updated, ${r.notes.removed} removed (in progress and blocked on GitHub)`);
  const k = s.skipped;
  const skips = [
    k.prComments ? plural(k.prComments, "comment on a pull request", "comments on pull requests") : "",
    k.notImported ? plural(k.notImported, "comment on an issue not imported", "comments on issues not imported") : "",
    k.deps ? plural(k.deps, "dependency on an issue not on the board", "dependencies on issues not on the board") : "",
    k.gone ? plural(k.gone, "task whose issue GitHub no longer has", "tasks whose issues GitHub no longer has") : "",
    k.mirrored ? plural(k.mirrored, "comment the board mirrored", "comments the board mirrored") : "",
    r.skipped.length ? plural(r.skipped.length, "item left as it was (below)", "items left as they were (below)") : "",
  ].filter(Boolean);
  print(`skipped    ${skips.length ? skips.join("; ") : "nothing"}`);
  for (const x of r.skipped) print(`  ${x.ref}: ${x.why}`);
  if (s.boardIsRecord) print("status     kept for the tasks the board moved since the last import: the board is the record");
  print(`comments   ${s.since ? `changed since ${s.since} (the last import, less 10 minutes)` : "all of them"}`);
  print(`GitHub calls: ${s.calls}`);
}

async function importVerb(argv: string[]): Promise<number> {
  const args = [...argv];
  const from = args.shift();
  if (from !== "github") {
    fail("bad-input", from ? `The board can't import from ${JSON.stringify(from)}; it imports from GitHub.` : "import needs a source.", `Run \`${IMPORT_USAGE}\`.`);
  }
  const closed = flag(args, "--closed");
  const dryRun = flag(args, "--dry-run");
  const boardIsRecord = flag(args, "--board-is-record");
  const given = option(args, "--repo");
  leftovers(args, IMPORT_USAGE);
  const repo = repoName(given);
  const summary = await withBoard(async (b) => {
    const info = await b.info();
    const missing = migrationNames().filter((m) => !info.migrations.includes(m));
    if (missing.length) {
      fail("schema-old", `The board's schema is behind: ${missing.join(", ")} not applied yet.`, "Run `factory board migrate`, then run this again. Nothing was read or written.");
    }
    // MB_GH_CALLS_FILE: each `gh` call's arguments, one JSON list a line, for a caller that counts GitHub calls (the
    // factory's hourly call log, #520); the board itself keeps no log
    const file = process.env.MB_GH_CALLS_FILE;
    const gh = file ? ghCli({ onCall: (a) => appendFileSync(file, JSON.stringify(a) + "\n", { mode: 0o600 }) }) : undefined;
    return importFromGithub(b, { repo, closed, dryRun, boardIsRecord, gh });
  }, IMPORTER);
  importReport(summary);
  return 0;
}

const VERBS: Record<string, (args: string[]) => number | Promise<number>> = {
  up, down, status, migrate: migrateVerb, backup, restore, sweep, tasks, ready, show, prime, import: importVerb, mcp, login,
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
  if (isCommandError(e) || e instanceof GithubError) {
    console.error(errorLine({ code: e.code, message: e.message, fix: e.fix }));
    process.exitCode = 1;
  } else {
    console.error(errorLine({ code: "unexpected", message: masked(e instanceof Error ? e.message : String(e)), fix: "Run it again; if it keeps failing, report this message." }));
    process.exitCode = 1;
  }
}
