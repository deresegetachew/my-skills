// Activity and Home from the message board (#455, #451): with the board as the project's record of tasks, Activity
// reads its events table (claims, moves, comments, notes, closes) for the project's tasks only, newest first, beside the
// pull requests the snapshot knows; a write on the board reaches an open page over the WebSocket; Home's blocked task
// carries the reason it was blocked with. A real Postgres (board_pg.ts), the real server, a fake gh and a fake `factory`.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Board } from "../message-board/src/index.ts";
import { freshDb, type Pg, startPg } from "./board_pg.ts";
import { api, CONFIG, project, type Project, type Row, startUi, type Running } from "./web_ui_support.ts";
import { write, writeExe } from "./support.ts";

const T = 90_000;
const REPO = "o/work";
let pg: Pg;
const running: Running[] = [];
const roots: string[] = [];
const drops: (() => Promise<void>)[] = [];
const boards: Board[] = [];

beforeAll(async () => {
  pg = await startPg();
}, 600_000);

afterEach(async () => {
  for (const r of running.splice(0)) await r.stop().catch(() => {});
  for (const b of boards.splice(0)) await b.end().catch(() => {});
}, 120_000);

afterAll(async () => {
  for (const d of drops) await d().catch(() => {});
  for (const d of roots) rmSync(d, { recursive: true, force: true });
  pg?.stop();
}, 120_000);

const FAKE_FACTORY = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_FACTORY_LOG"
exit 0
`;

function workProject(): Project {
  const p = project(CONFIG);
  roots.push(p.root);
  writeExe(join(p.d, "factory"), FAKE_FACTORY);
  write(join(p.state, "snapshot.json"), JSON.stringify({ generatedAt: new Date().toISOString(), sessions: [], needsYou: [], missing: [],
    tasks: { source: "issues", tasks: [], epics: [] },
    pulls: [{ number: 21, title: "Login", url: `https://github.com/${REPO}/pull/21`, branch: "task/7-login", draft: false, ci: "green", next: "none",
      nextText: "none", agent: "menelik", review: null, gate: null, notGreen: [], protected: null, claim: null, createdAt: "2000-01-01T00:00:00Z" }],
    ci: { mode: "github", repo: REPO, runners: [], runs: [], errors: [] } }));
  return p;
}

const ref = (n: number) => `github:${REPO}#${n}`;

async function seeded(url: string): Promise<{ board: Board; id: Record<number, number> }> {
  const board = await Board.open(url, { as: "system", max: 1 });
  boards.push(board);
  await board.migrate();
  const t7 = await board.create({ title: "Add the login page", ref: ref(7), priority: 1 });
  const t10 = await board.create({ title: "Sign out", ref: ref(10), priority: 2 });
  const t12 = await board.create({ title: "Pay by card", ref: ref(12), priority: 3 });
  const other = await board.create({ title: "Another repo's task", ref: "github:x/other#3", priority: 0 });
  await board.close(t10.id, { outcome: "done" });
  const menelik = await Board.open(url, { as: "menelik", max: 1 });
  boards.push(menelik);
  await menelik.claim(t7.id);
  await menelik.post({ task: t7.id, kind: "question", to: "fasil", body: "Which provider do we use for sign in?" });
  await menelik.note(t7.id, { kind: "decision", body: "Sessions live in a cookie." });
  const taytu = await Board.open(url, { as: "taytu", max: 1 });
  boards.push(taytu);
  await taytu.claim(other.id);
  return { board, id: { 7: t7.id, 10: t10.id, 12: t12.id } };
}

async function boardUrl(): Promise<string> {
  const db = await freshDb(pg);
  drops.push(db.drop);
  return db.url;
}

async function activityUntil(ui: Running, ok: (j: Row) => boolean, query = ""): Promise<Row> {
  const deadline = Date.now() + 15_000;
  let last: Row = {};
  while (Date.now() < deadline) {
    last = (await api(ui, `/api/projects/work/activity${query}`)).json;
    if (ok(last)) return last;
    await Bun.sleep(150);
  }
  return last;
}

test("activity reads the board's events for the project's tasks, newest first, beside the snapshot's pull requests", async () => {
  const url = await boardUrl();
  await seeded(url);
  const ui = await startUi(workProject(), ["--port", "0"], null, { MB_URL: url });
  running.push(ui);
  const j = await activityUntil(ui, (x) => x.from === "board");
  expect(j.from, JSON.stringify(j)).toBe("board");
  expect(j.problems).toEqual([]);
  const items = j.items as Row[];
  const board = items.filter((x) => String(x.id).startsWith("board-"));
  expect(board.map((x) => [x.agent, x.kind, x.text])).toEqual([
    ["menelik", "note", "noted a decision on #7"],
    ["menelik", "comment", "asked fasil on #7"],
    ["menelik", "claim", "claimed #7 Add the login page"],
    ["system", "close", "closed #10 (done)"],
    ["system", "new", "filed #12: Pay by card"],
    ["system", "new", "filed #10: Sign out"],
    ["system", "new", "filed #7: Add the login page"],
  ]); // the other repo's task, and taytu's claim of it, aren't this project's
  expect(board[0]).toMatchObject({ task: "7", link: "view:tasks", find: "#7" });
  expect(items.at(-1)?.text).toBe("opened PR #21: Login"); // the snapshot's, at its own (older) time
  const claims = (await api(ui, "/api/projects/work/activity?kind=claim")).json.items as Row[];
  expect(claims.map((x) => x.text)).toEqual(["claimed #7 Add the login page"]);
  const onTen = (await api(ui, "/api/projects/work/activity?task=10")).json.items as Row[];
  expect(onTen.map((x) => x.text)).toEqual(["closed #10 (done)", "filed #10: Sign out"]);
}, T);

test("a move on the board reaches an open page over the WebSocket, and Home gives the blocked task its reason", async () => {
  const url = await boardUrl();
  const { board, id } = await seeded(url);
  const ui = await startUi(workProject(), ["--port", "0"], null, { MB_URL: url });
  running.push(ui);
  await activityUntil(ui, (x) => x.from === "board");
  const ws = new WebSocket(ui.url.replace("http", "ws") + `/api/ws?token=${ui.token}`);
  const got = new Promise<Row | null>((resolve) => {
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as Row;
      if (m.type === "activity" && m.project === "work") resolve(m);
    };
    setTimeout(() => resolve(null), 10_000);
  });
  await new Promise((r) => { ws.onopen = r; });
  await board.move(id[12] as number, { to: "blocked", reason: "needs the card provider's keys" });
  expect(await got).toMatchObject({ type: "activity", project: "work" });
  ws.close();
  const j = await activityUntil(ui, (x) => (x.items as Row[]).some((i) => i.kind === "move"));
  expect((j.items as Row[])[0]).toMatchObject({ kind: "move", agent: "system", text: "moved #12 to blocked: needs the card provider's keys" });
  const deadline = Date.now() + 10_000;
  let needs: Row[] = [];
  while (Date.now() < deadline) {
    needs = (await api(ui, "/api/projects/work/home")).json.needs as Row[];
    if (needs.some((n) => n.kind === "blocked")) break;
    await Bun.sleep(150);
  }
  expect(needs.find((n) => n.kind === "blocked")).toMatchObject({ title: "#12 Pay by card", sub: "needs the card provider's keys", link: "view:tasks" });
}, T);
