#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// `factory board <verb>`: factory-message-board's command (decision 0007 point 10). `factory board help` lists the verbs.
// The board's URL comes from MB_URL or <machine settings folder>/message-board/url (mode 600); it is never printed
// with its password.
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { Board, type BoardEvent, BoardError, type ContextEntry, migrationNames, type Task } from "./src/index.ts";
import { PROTOCOL_VERSIONS, serveMcp } from "./src/mcp.ts";
import {
  boardDir, boardUrl, CommandError, compose, COMPOSE_PROJECT, composeYaml, DB_NAME, DB_USER, DEFAULT_PORT, dockerReady, ensureDir, IMAGE, isCommandError,
  masked, readState, sh, type State, tailscaleAddress, urlFor, Writes,
} from "./src/server.ts";
import { GithubError, type ImportSummary, importFromGithub, repoName } from "./src/github/import.ts";

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
  factory board ready [--for <actor>] [--json]
                                     the ready queue, in claim order; tasks handed to an actor show only with --for
  factory board show <id> [--json]   one task: its fields, edges, context and thread
  factory board prime <actor> [--json]
                                     an actor's start: what it holds, what is ready, what is blocked, recent events
  factory board mcp --as <actor> [--session <id>]
                                     serve the board to one agent as an MCP server over stdio (JSON-RPC, one message a
                                     line); every write is recorded as <actor>, and no tool can name another sender
  factory board import github [--closed] [--dry-run] [--repo owner/name]
                                     bring the repo's open issues in as tasks (--closed: the closed ones too, as done),
                                     their comments as threads; safe to run twice. --dry-run says what it would do and
                                     writes nothing. The repo is the git remote origin unless --repo names it
                                     GitHub wins on status unless the task is held on the board (a task done on the
                                     board but open on GitHub is reopened); comments deleted on GitHub stay on the board

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
  const who = option(args, "--for");
  leftovers(args, "factory board ready [--for <actor>] [--json]");
  const list = await withBoard((b) => b.ready({ for: who }));
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
    for (const m of got.thread) print(`  ${m.id} ${m.kind}${m.tag ? `/${m.tag}` : ""} ${m.from}${m.to ? ` -> ${m.to}` : ""} (${m.state}): ${m.body}`);
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

async function mcp(argv: string[]): Promise<number> {
  const args = [...argv];
  const as = option(args, "--as");
  const session = option(args, "--session");
  leftovers(args, "factory board mcp --as <actor> [--session <id>]");
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
  console.error(`factory board mcp: serving the message board to ${as} over stdio (MCP ${PROTOCOL_VERSIONS[0]}).`);
  try {
    await serveMcp({ board: b, version: (migrationNames().at(-1) ?? "none").replace(/\.sql$/, "") }, {
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

// ---------- import ----------
const IMPORT_USAGE = "factory board import github [--closed] [--dry-run] [--repo owner/name]";
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
    r.skipped.length ? plural(r.skipped.length, "item left as it was (below)", "items left as they were (below)") : "",
  ].filter(Boolean);
  print(`skipped    ${skips.length ? skips.join("; ") : "nothing"}`);
  for (const x of r.skipped) print(`  ${x.ref}: ${x.why}`);
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
  const given = option(args, "--repo");
  leftovers(args, IMPORT_USAGE);
  const repo = repoName(given);
  const summary = await withBoard(async (b) => {
    const info = await b.info();
    const missing = migrationNames().filter((m) => !info.migrations.includes(m));
    if (missing.length) {
      fail("schema-old", `The board's schema is behind: ${missing.join(", ")} not applied yet.`, "Run `factory board migrate`, then run this again. Nothing was read or written.");
    }
    return importFromGithub(b, { repo, closed, dryRun });
  }, IMPORTER);
  importReport(summary);
  return 0;
}

const VERBS: Record<string, (args: string[]) => number | Promise<number>> = {
  up, down, status, migrate: migrateVerb, backup, sweep, tasks, ready, show, prime, import: importVerb, mcp,
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
