// An epic is done when all its tasks are done: closing the last open child closes the epic in the same transaction
// (event `epic.done` by system), reopening a child reopens it (`epic.reopened`), and an epic with no children is never
// closed this way. `factory board sweep`, in the dev manager's pass, closes the epics whose tasks were all done before
// this (b7-b10 and b26 on factory-sandbox), unless someone moved the epic after its last task was done.
// A real Postgres (board_pg.ts); the fake gh is on the PATH and is only asked for pull requests.
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { SQL } from "bun";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Board, type BoardEvent } from "../message-board/src/index.ts";
import { freshDb, type Pg, startPg } from "./board_pg.ts";
import { installFakeGh } from "./fakegh.ts";
import { gitRepo, HOOKS, type Proc, runBun, tmp, write } from "./support.ts";

setDefaultTimeout(120_000);

const REPO = "acme/shop";

let pg: Pg;
const drops: (() => Promise<void>)[] = [];
const boards: Board[] = [];

beforeAll(async () => {
  pg = await startPg();
}, 600_000);

afterEach(async () => {
  for (const b of boards.splice(0)) await b.end().catch(() => {});
  for (const d of drops.splice(0)) await d().catch(() => {});
}, 120_000);

afterAll(async () => {
  for (const b of boards) await b.end().catch(() => {});
  for (const d of drops) await d().catch(() => {});
  pg?.stop();
}, 120_000);

async function fresh(): Promise<{ url: string; board: Board }> {
  const db = await freshDb(pg);
  drops.push(db.drop);
  const board = await Board.open(db.url, { as: "fasil", max: 1 });
  boards.push(board);
  await board.migrate();
  return { url: db.url, board };
}

/** An epic and its `n` tasks, all open. */
async function epicWith(board: Board, n: number): Promise<{ epic: number; tasks: number[] }> {
  const e = await board.create({ title: "Sign in", kind: "epic", ref: `factory:${REPO}/epic` });
  const tasks: number[] = [];
  for (let i = 0; i < n; i++) tasks.push((await board.create({ title: `Task ${i}`, parentId: e.id, ref: `factory:${REPO}/t${i}` })).id);
  return { epic: e.id, tasks };
}

async function epicEvents(board: Board, id: number): Promise<BoardEvent[]> {
  return (await board.events(0, 1000)).filter((e) => e.subject === `task:${id}` && e.kind.startsWith("epic."));
}

test("closing the last open task closes its epic, with epic.done by system; an earlier close doesn't", async () => {
  const { board } = await fresh();
  const { epic, tasks } = await epicWith(board, 2);
  await board.close(tasks[0] as number, { outcome: "done" });
  expect((await board.get(epic)).status).toBe("open");
  await board.close(tasks[1] as number, { outcome: "done" });
  expect(await board.get(epic)).toMatchObject({ status: "done", outcome: "done" });
  const events = await epicEvents(board, epic);
  expect(events.map((e) => [e.kind, e.actor])).toEqual([["epic.done", "system"]]);
});

test("a held task closed by its holder, or moved to done, closes the epic too", async () => {
  const { url, board } = await fresh();
  const { epic, tasks } = await epicWith(board, 2);
  const taytu = await Board.open(url, { as: "taytu", max: 1 });
  boards.push(taytu);
  const c = await taytu.claim(tasks[0] as number);
  await taytu.close(tasks[0] as number, { outcome: "done", token: c?.token as string });
  await board.move(tasks[1] as number, { to: "done" });
  expect((await board.get(epic)).status).toBe("done");
});

test("reopening a task of a done epic reopens the epic, with epic.reopened", async () => {
  const { board } = await fresh();
  const { epic, tasks } = await epicWith(board, 1);
  await board.close(tasks[0] as number, { outcome: "done" });
  expect((await board.get(epic)).status).toBe("done");
  await board.move(tasks[0] as number, { to: "ready", reason: "it needs more work" });
  expect(await board.get(epic)).toMatchObject({ status: "open", outcome: null });
  expect((await epicEvents(board, epic)).map((e) => e.kind)).toEqual(["epic.done", "epic.reopened"]);
});

test("a new open task under a done epic reopens it", async () => {
  const { board } = await fresh();
  const { epic, tasks } = await epicWith(board, 1);
  await board.close(tasks[0] as number, { outcome: "done" });
  await board.create({ title: "One more", parentId: epic });
  expect((await board.get(epic)).status).toBe("open");
});

test("an epic with no tasks is never closed this way, and an epic closed as won't do stays closed when a task reopens", async () => {
  const { board } = await fresh();
  const empty = await board.create({ title: "Later", kind: "epic" });
  const other = await board.create({ title: "Unrelated" });
  await board.close(other.id, { outcome: "done" });
  expect((await board.get(empty.id)).status).toBe("open");
  const { epic, tasks } = await epicWith(board, 1);
  await board.move(epic, { to: "done", outcome: "wont_do" });
  await board.close(tasks[0] as number, { outcome: "done" });
  await board.move(tasks[0] as number, { to: "ready" });
  expect(await board.get(epic)).toMatchObject({ status: "done", outcome: "wont_do" });
});

// --- the pass: epics that were all done before this ----------------------------------------------------------------------

function sweepIn(url: string): Proc {
  const root = tmp("factory-epics-");
  const d = join(root, "work");
  write(join(d, ".claude", "factory.json"), JSON.stringify({ tasks: { source: "board" } }));
  gitRepo(d);
  const bin = installFakeGh(root);
  const dbFile = join(root, "db.json");
  writeFileSync(dbFile, JSON.stringify({ repo: REPO, issues: [], comments: {}, pulls: [] }));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("FACTORY_") && !k.startsWith("MB_") && !k.startsWith("GH_") && k !== "CLAUDE_PROJECT_DIR") env[k] = v;
  }
  Object.assign(env, { PATH: `${bin}:${process.env.PATH}`, FAKE_DB: dbFile, MB_URL: url, GH_REPO: REPO, FACTORY_CONFIG_DIR: join(root, "cfg"), HOME: root });
  return runBun(join(HOOKS, "factory_board.ts"), ["sweep", "--max-seconds", "60"], { cwd: d, env, timeoutMs: 120_000 });
}

/** Puts epic `id` back to open behind the board's back, as the board had it before this change. */
async function reopenRaw(url: string, id: number): Promise<void> {
  const sql = new SQL(url, { max: 1 });
  try {
    await sql`UPDATE tasks SET status = 'open', outcome = NULL WHERE id = ${id}`;
  } finally {
    await sql.close();
  }
}

test("the pass closes an epic whose tasks were all done before this, and leaves an epic with no tasks", async () => {
  const { url, board } = await fresh();
  const { epic, tasks } = await epicWith(board, 2);
  for (const t of tasks) await board.close(t, { outcome: "done" });
  await reopenRaw(url, epic);
  const empty = await board.create({ title: "Later", kind: "epic" });
  const p = sweepIn(url);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain(`closed the epic b${epic}: all its tasks are done`);
  expect((await board.get(epic)).status).toBe("done");
  expect((await board.get(empty.id)).status).toBe("open");
  expect(sweepIn(url).stdout).not.toContain("closed the epic"); // nothing left to do
});

test("the pass leaves an epic someone moved back to open after its last task was done", async () => {
  const { url, board } = await fresh();
  const { epic, tasks } = await epicWith(board, 1);
  await board.close(tasks[0] as number, { outcome: "done" });
  await Bun.sleep(20);
  await board.move(epic, { to: "ready", reason: "more to come" });
  const p = sweepIn(url);
  expect(p.code, p.out).toBe(0);
  expect((await board.get(epic)).status).toBe("open");
});
