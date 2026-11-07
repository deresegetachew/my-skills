// Agents on the message board (#513): with `tasks.source` board, an agent's liveness (working, idle, down, and its task)
// is a value on the board that its loop, its hooks and the claim's keeper write, with an event each; `factory agents
// list`, `factory agents sweep` and the agents part of `factory status` read it, and the claims of an agent that went
// quiet are freed by the board's sweep rules. While a builder's session runs, the loop keeps its claim alive
// (`factory_agents.ts keep`), so a build quiet for longer than the claim time keeps its task; once the session is gone,
// the claim runs out and the sweep frees it. A real Postgres (board_pg.ts) and the fake gh (it must not be asked).
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Board, type Task } from "../message-board/src/index.ts";
import { freshDb, type Pg, startPg } from "./board_pg.ts";
import { installFakeGh } from "./fakegh.ts";
import { gitRepo, HOOKS, type Proc, runBun, SF, tmp, write } from "./support.ts";

setDefaultTimeout(120_000);

const REPO = "acme/shop";
const BIN = join(SF, "message-board", "bin.ts");
type Row = Record<string, unknown>;

let pg: Pg;
const drops: (() => Promise<void>)[] = [];
const boards: Board[] = [];
const procs: ReturnType<typeof Bun.spawn>[] = [];

beforeAll(async () => {
  pg = await startPg();
}, 600_000);

// Each test's connections and processes end with it: CI runs many files at once against one Postgres.
afterEach(async () => {
  for (const p of procs.splice(0)) {
    p.kill(9);
    await p.exited;
  }
  for (const b of boards.splice(0)) await b.end().catch(() => {});
  for (const d of drops.splice(0)) await d().catch(() => {});
}, 120_000);

afterAll(async () => {
  pg?.stop();
}, 120_000);

interface World {
  d: string;
  log: string;
  env: Record<string, string>;
  board: Board;
  as(actor: string): Promise<Board>;
}

async function world(cfg: Row = { tasks: { source: "board" } }): Promise<World> {
  const db = await freshDb(pg);
  drops.push(db.drop);
  const root = tmp("factory-agents-board-");
  const d = join(root, "shop");
  write(join(d, ".claude", "factory.json"), JSON.stringify(cfg));
  gitRepo(d);
  const bin = installFakeGh(root);
  const dbFile = join(root, "db.json");
  writeFileSync(dbFile, JSON.stringify({ repo: REPO, issues: [], comments: {} }));
  const log = join(root, "gh.log");
  writeFileSync(log, "");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("FACTORY_") && !k.startsWith("MB_") && !k.startsWith("GH_") && k !== "CLAUDE_PROJECT_DIR") env[k] = v;
  }
  Object.assign(env, { PATH: `${bin}:${process.env.PATH}`, FAKE_DB: dbFile, LOOP_LOG: log, MB_URL: db.url, GH_REPO: REPO,
    FACTORY_CONFIG_DIR: join(root, "cfg"), HOME: root });
  const board = await Board.open(db.url, { as: "system", max: 1 });
  boards.push(board);
  await board.migrate();
  const as = async (actor: string): Promise<Board> => {
    const b = await Board.open(db.url, { as: actor, max: 1 });
    boards.push(b);
    return b;
  };
  return { d, log, env, board, as };
}

function hook(w: World, name: string, args: string[], extra: Record<string, string> = {}): Proc {
  return runBun(join(HOOKS, `${name}.ts`), args, { cwd: w.d, env: { ...w.env, ...extra }, timeoutMs: 120_000 });
}

const agents = (w: World, extra: Record<string, string> = {}): Proc => hook(w, "factory_agents", ["list", "--json"], extra);

function cards(w: World, extra: Record<string, string> = {}): Row[] {
  const p = agents(w, extra);
  expect(p.code, p.stderr).toBe(0);
  return JSON.parse(p.stdout) as Row[];
}

const ghCalls = (w: World): string[] => readFileSync(w.log, "utf8").split("\n").filter((l) => l.startsWith("gh api"));

async function task(w: World, id: number): Promise<Task> {
  return w.board.get(id);
}

// --- liveness ------------------------------------------------------------------------------------------------------------

test("with tasks on the board, an agent's register, pings and down are its value on the board, each with an event; GitHub isn't asked", async () => {
  const w = await world();
  for (const args of [["register", "--agent", "haile"], ["ping", "--agent", "haile", "--status", "working on #101"]]) {
    const p = hook(w, "factory_agents", args);
    expect(p.code, p.stderr).toBe(0);
  }
  expect(cards(w).map((c) => [c.name, c.state, c.kind])).toEqual([["haile", "working", "coding-agent"]]);
  const said = (await w.board.events(0, 500, { kind: "signal.agent" })).map((e) => [e.actor, e.payload.name, e.payload.status]);
  expect(said).toEqual([["haile", "haile", "idle"], ["haile", "haile", "working"]]);

  expect(hook(w, "factory_agents", ["register", "--agent", "fasil", "--role", "dev-manager"]).code).toBe(0);
  expect(hook(w, "factory_agents", ["down", "--agent", "haile"]).code).toBe(0);
  expect(cards(w).map((c) => [c.name, c.state, c.role])).toEqual([["fasil", "idle", "dev-manager"], ["haile", "down", "coding-agent"]]);
  expect(ghCalls(w)).toEqual([]);
});

test("factory status shows the agents from the board", async () => {
  const w = await world();
  expect(hook(w, "factory_agents", ["register", "--agent", "haile"]).code).toBe(0);
  expect(hook(w, "factory_agents", ["ping", "--agent", "haile", "--status", "working on #101"]).code).toBe(0);
  const p = hook(w, "factory_status", ["--json"]);
  expect(p.code, p.stderr).toBe(0);
  const s = JSON.parse(p.stdout) as { agents: { agents: Row[] } };
  expect(s.agents.agents.map((a) => [a.name, a.status])).toEqual([["haile", "working"]]);
});

test("another machine's live agent of the same name is refused at register (exit 3), as in issues mode", async () => {
  const w = await world();
  expect(hook(w, "factory_agents", ["register", "--agent", "haile"], { FACTORY_MACHINE_ID: "aaaaaaaaaaaa" }).code).toBe(0);
  const p = hook(w, "factory_agents", ["register", "--agent", "haile"], { FACTORY_MACHINE_ID: "bbbbbbbbbbbb" });
  expect(p.code).toBe(3);
  expect(JSON.parse(p.stderr.trim().split("\n").at(-1) as string).code).toBe("agent-name-in-use");
});

test("factory agents sweep marks a silent agent down, and the board's sweep frees its stale claim; a live agent keeps its task", async () => {
  const w = await world();
  const later = String(Math.floor(Date.now() / 1000) + 31 * 60); // past tasks.downMinutes (30)
  expect(hook(w, "factory_agents", ["register", "--agent", "haile"]).code).toBe(0);
  expect(hook(w, "factory_agents", ["register", "--agent", "taytu"]).code).toBe(0);
  expect(hook(w, "factory_agents", ["ping", "--agent", "taytu", "--status", "working on #102"], { FACTORY_NOW: later }).code).toBe(0);
  const a = await w.board.create({ title: "Add login", ref: `github:${REPO}#101` });
  const b = await w.board.create({ title: "Pay by card", ref: `github:${REPO}#102` });
  await (await w.as("haile")).claim(a.id, { ttlSeconds: 1 });
  await (await w.as("taytu")).claim(b.id, { ttlSeconds: 1 });
  // haile hasn't been heard from on the board for an hour; taytu just claimed
  const { SQL } = await import("bun");
  const sql = new SQL(w.env.MB_URL as string, { max: 1 });
  await sql`UPDATE actors SET seen_at = now() - interval '1 hour' WHERE id = 'haile'`;
  await sql.close();
  await Bun.sleep(1500); // both claims' time has passed

  const p = hook(w, "factory_agents", ["sweep"], { FACTORY_NOW: later });
  expect(p.code, p.stderr).toBe(0);
  expect(p.stdout).toMatch(/^haile: down \(silent 0\.5 h\)$/m);
  expect(p.stdout).toContain(`released board task #${a.id} (held by haile)`);
  expect(p.stdout).not.toContain("taytu");
  expect(cards(w, { FACTORY_NOW: later }).map((c) => [c.name, c.state])).toEqual([["haile", "down"], ["taytu", "working"]]);
  expect(await task(w, a.id)).toMatchObject({ holder: null, status: "open" });
  expect(await task(w, b.id)).toMatchObject({ holder: "taytu", status: "in_progress" });
  expect(ghCalls(w)).toEqual([]);
});

test("in plan mode agent tracking is still off and says so", async () => {
  const w = await world({ tasks: { source: "plan" } });
  const p = hook(w, "factory_agents", ["sweep"]);
  expect(p.code).toBe(0);
  expect(p.stdout).toContain("Agent tracking needs");
});

// --- the claim's keeper ------------------------------------------------------------------------------------------------

/** Claim board task `id` for haile from the project's folder, as `factory next` does, with the token kept in its git folder. */
function claimAsHaile(w: World, n: number, extra: Record<string, string>): void {
  const p = hook(w, "next_task", ["--claim", "haile", "--issue", String(n), "--no-rework"], extra);
  expect(p.code, p.out).toBe(0);
  expect(existsSync(join(w.d, ".git", "factory", "board-claims.json"))).toBe(true);
}

const sweep = (w: World): Proc => runBun(BIN, ["sweep", "--quiet-minutes", "0"], { cwd: w.d, env: w.env });

test("a builder quiet for longer than the claim time keeps its task while its session runs, and loses it once the session is gone", async () => {
  const w = await world();
  const t = await w.board.create({ title: "Add login", ref: `github:${REPO}#101` });
  const times = { FACTORY_BOARD_CLAIM_SECONDS: "4", FACTORY_BOARD_HEARTBEAT_SECONDS: "1" };
  claimAsHaile(w, 101, times);
  const session = Bun.spawn(["sleep", "120"], { stdout: "ignore", stderr: "ignore" });
  procs.push(session);
  const clean: Record<string, string> = { ...w.env, ...times };
  const keeper = Bun.spawn([process.execPath, "--no-env-file", join(HOOKS, "factory_agents.ts"), "keep", "--agent", "haile", "--task", "101",
    "--pid", String(session.pid)], { cwd: w.d, env: clean, stdout: "pipe", stderr: "pipe" });
  procs.push(keeper);

  await Bun.sleep(7000); // longer than the claim's 4 seconds, with nothing else said
  const kept = sweep(w);
  expect(kept.code, kept.stderr).toBe(0);
  expect(kept.stdout).toContain("No stale claims.");
  expect(await task(w, t.id)).toMatchObject({ holder: "haile", status: "in_progress" });
  expect(cards(w).map((c) => [c.name, c.state])).toEqual([["haile", "working"]]); // the keeper says it is alive

  session.kill(9);
  const gone = await Promise.race([keeper.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
  expect(gone).toBe(true); // the keeper stops with the session
  await Bun.sleep(5000); // the claim's time passes
  const freed = sweep(w);
  expect(freed.stdout).toContain(`released #${t.id} (held by haile)`);
  expect(await task(w, t.id)).toMatchObject({ holder: null, status: "open" });
}, 180_000);

test("the keeper does nothing outside board mode, and stops when the task is no longer held here", async () => {
  const plan = await world({ tasks: { source: "issues" } });
  const p = hook(plan, "factory_agents", ["keep", "--agent", "haile", "--task", "101", "--pid", String(process.pid)]);
  expect(p.code).toBe(0);
  expect(ghCalls(plan)).toEqual([]);

  const w = await world();
  await w.board.create({ title: "Add login", ref: `github:${REPO}#101` });
  const q = hook(w, "factory_agents", ["keep", "--agent", "haile", "--task", "101", "--pid", String(process.pid)],
    { FACTORY_BOARD_HEARTBEAT_SECONDS: "1" });
  expect(q.code, q.stderr).toBe(0); // nobody holds 101 here: nothing to keep, so it ends at once
});
