// Needs attention on the message board (#579): a task in progress that nothing has moved on the board for
// attention.taskQuietMinutes, while its holder isn't working on it, shows with Release; with tasks.source board, Close
// moves a task (or an epic) to done on the board, after the confirm, and the item clears. A real Postgres (board_pg.ts),
// the real server (startUi), a fake `gh` and a fake `factory`.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Board } from "../message-board/src/index.ts";
import { freshDb, type Pg, startPg } from "./board_pg.ts";
import { api, CONFIG, heartbeat, hbRow, project, type Project, type Row, startUi, type Running } from "./web_ui_support.ts";
import { write, writeExe } from "./support.ts";

const T = 90_000;
const REPO = "o/work";
let pg: Pg;
const running: Running[] = [];
const roots: string[] = [];
const drops: (() => Promise<void>)[] = [];
const boards: Board[] = [];
const sqls: SQL[] = [];

beforeAll(async () => {
  pg = await startPg();
}, 600_000);

afterEach(async () => {
  for (const r of running.splice(0)) await r.stop().catch(() => {});
  for (const b of boards.splice(0)) await b.end().catch(() => {});
  for (const s of sqls.splice(0)) await s.close().catch(() => {});
}, 120_000);

afterAll(async () => {
  for (const d of drops) await d().catch(() => {});
  for (const d of roots) rmSync(d, { recursive: true, force: true });
  pg?.stop();
}, 120_000);

const FAKE_FACTORY = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_FACTORY_LOG"
echo "fake factory: $*"
`;

const ref = (n: number) => `github:${REPO}#${n}`;

function workProject(cfg: Row): Project {
  const p = project(cfg);
  roots.push(p.root);
  writeExe(join(p.d, "factory"), FAKE_FACTORY);
  write(join(p.state, "snapshot.json"), JSON.stringify({ generatedAt: new Date().toISOString(), sessions: [], needsYou: [], missing: [],
    tasks: { source: "issues", tasks: [], epics: [] }, pulls: [], ci: { mode: "github", repo: REPO, runners: [], runs: [], errors: [] } }));
  // menelik runs but isn't working on #7: only the board's own changes keep #7 moving
  heartbeat(p, [hbRow("menelik"), hbRow("taytu"), hbRow("fasil", { kind: "dev-manager" }), hbRow("mentewab", { kind: "product-owner" })]);
  return p;
}

/** Epic #1 with #7 under it, #7 held by menelik and last changed `minutes` ago. */
async function seeded(url: string, minutes: number): Promise<{ board: Board; epic: number; t7: number }> {
  const board = await Board.open(url, { as: "system", max: 1 });
  boards.push(board);
  await board.migrate();
  const epic = await board.create({ title: "Sign in", kind: "epic", ref: ref(1), body: "Let people sign in.\n\n- [ ] #7" });
  const t7 = await board.create({ title: "Add the login page", ref: ref(7), parentId: epic.id, priority: 1 });
  const menelik = await Board.open(url, { as: "menelik", max: 1 });
  boards.push(menelik);
  await menelik.claim(t7.id);
  const sql = new SQL(url, { max: 1 });
  sqls.push(sql);
  await sql`UPDATE tasks SET updated_at = now() - make_interval(mins => ${minutes}) WHERE id = ${t7.id}`;
  return { board, epic: epic.id, t7: t7.id };
}

type Item = { id: string; reason: string; action: Row };

async function until(ui: Running, ok: (x: Item[]) => boolean, ms = 20_000): Promise<Item[]> {
  const deadline = Date.now() + ms;
  let last: Item[] = [];
  while (Date.now() < deadline) {
    const r = await api(ui, "/api/projects/work/attention");
    last = (r.json.items ?? []) as Item[];
    if (ok(last)) return last;
    await Bun.sleep(200);
  }
  return last;
}

test("a task nothing moved on the board for longer than attention.taskQuietMinutes shows with Release; a fresh one doesn't", async () => {
  const db = await freshDb(pg);
  drops.push(db.drop);
  await seeded(db.url, 120);
  const ui = await startUi(workProject(CONFIG), ["--port", "0"], null, { MB_URL: db.url });
  running.push(ui);
  const x = await until(ui, (l) => l.some((i) => i.id === "task-quiet:7"));
  const item = x.find((i) => i.id === "task-quiet:7") as Item;
  expect(item, JSON.stringify(x)).toBeTruthy();
  expect(item.reason).toMatch(/^Held by menelik, but nothing has moved on it for 1(19|20|21) minutes\.$/);
  expect(item.action).toMatchObject({ kind: "release", task: "7" });

  const db2 = await freshDb(pg);
  drops.push(db2.drop);
  await seeded(db2.url, 10);
  const fresh = await startUi(workProject(CONFIG), ["--port", "0"], null, { MB_URL: db2.url });
  running.push(fresh);
  await until(fresh, () => false, 3_000);
  expect((await api(fresh, "/api/projects/work/tasks")).json.from).toBe("board");
  expect(await until(fresh, () => true)).toEqual([]);
}, T);

test("with tasks.source board, Close moves the task to done on the board and the item clears; Close the epic does the same", async () => {
  const db = await freshDb(pg);
  drops.push(db.drop);
  const { board, epic, t7 } = await seeded(db.url, 120);
  const ui = await startUi(workProject({ ...CONFIG, tasks: { source: "board" } }), ["--port", "0"], null, { MB_URL: db.url });
  running.push(ui);
  await until(ui, (l) => l.some((i) => i.id === "task-quiet:7"));
  const r = await api(ui, "/api/projects/work/tasks/7/actions/close", { method: "POST", body: { confirm: true } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(await board.get(t7)).toMatchObject({ status: "done", holder: null });
  const x = await until(ui, (l) => l.some((i) => i.id === "epic-done:1") && !l.some((i) => i.id === "task-quiet:7"));
  expect(x.map((i) => i.id)).toEqual(["epic-done:1"]); // every task of the epic is done now
  const e = await api(ui, "/api/projects/work/tasks/1/actions/close", { method: "POST", body: { confirm: true } });
  expect(e.status, JSON.stringify(e.json)).toBe(200);
  expect(await board.get(epic)).toMatchObject({ status: "done" });
  expect(await until(ui, (l) => l.length === 0)).toEqual([]);
}, T);
