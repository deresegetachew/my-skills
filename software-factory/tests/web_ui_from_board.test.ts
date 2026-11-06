// The web UI reads tasks from the message board, live (#498, decision 0007 points 6 and 10, step 3a): with a board,
// the Board page's tasks and epics come from it (status to column, blocked and ready worked out by the board, lanes by
// epic from parents and by agent from holders, each card's blockers), a write on the board reaches an open page within
// a second, and the tasks aren't read from GitHub. A task's thread and context come from the board. Without a board the
// GitHub path is as before; a board that can't be reached shows a notice and that project falls back to GitHub.
// A real Postgres (board_pg.ts), the real server (startUi), a fake gh and a fake `factory` that logs what it was asked.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFileSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Board } from "../message-board/src/index.ts";
import { freshDb, type Pg, startPg } from "./board_pg.ts";
import { api, CONFIG, project, type Project, type Row, startUi, type Running } from "./web_ui_support.ts";
import { CI, copyHookFolders, HOOKS, SF, write, writeExe } from "./support.ts";

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

afterAll(async () => {
  for (const r of running) await r.stop();
  for (const b of boards) await b.end().catch(() => {});
  for (const d of drops) await d().catch(() => {});
  for (const d of roots) rmSync(d, { recursive: true, force: true });
  pg?.stop();
}, 120_000);

/** The fake `factory`: logs its arguments and, for a snapshot, which tasks the server asked it to read. */
const FAKE_FACTORY = `#!/usr/bin/env bash
if [ "$1" = snapshot ]; then echo "snapshot tasks=\${FACTORY_SNAPSHOT_TASKS:-}" >> "$FAKE_FACTORY_LOG"; exit 0; fi
echo "$*" >> "$FAKE_FACTORY_LOG"
echo "fake factory: $*"
`;

/** The snapshot cache as `factory snapshot` left it: GitHub's tasks (#99 only), one pull request for #7, CI's repo. */
function cache(p: Project, ageSeconds = 0): void {
  write(join(p.state, "snapshot.json"), JSON.stringify({ generatedAt: new Date(Date.now() - ageSeconds * 1000).toISOString(), sessions: [], needsYou: [],
    missing: [], tasks: { source: "issues", tasks: [{ id: "99", title: "From GitHub", state: "ready", holders: [], group: "", todos: [], dependsOn: [] }],
      epics: [] },
    pulls: [{ number: 21, title: "Login", url: `https://github.com/${REPO}/pull/21`, branch: "task/7-login", draft: false, ci: "green", next: "none",
      nextText: "none", agent: "menelik", review: null, gate: null, notGreen: [], protected: null, claim: null }],
    ci: { mode: "github", repo: REPO, runners: [], runs: [], errors: [] } }));
}

function workProject(ageSeconds = 0, cfg: Row = CONFIG): Project {
  const p = project(cfg);
  roots.push(p.root);
  writeExe(join(p.d, "factory"), FAKE_FACTORY);
  cache(p, ageSeconds);
  return p;
}

const ref = (n: number) => `github:${REPO}#${n}`;

/** A board with: epic #1 (tasks #7, #9, #10 under it), #7 held by menelik, #11 blocks #9, #10 done, #12 in no epic, and a
 *  thread and a context entry on #7. Returns the board (as system) and the ids by issue number. */
async function seeded(url: string): Promise<{ board: Board; id: Record<number, number> }> {
  const board = await Board.open(url, { as: "system" });
  boards.push(board);
  await board.migrate();
  const epic = await board.create({ title: "Sign in", kind: "epic", ref: ref(1), body: "Let people sign in.\n\nPRD: docs/PRD.md\n- [ ] #7\n- [ ] #9" });
  const t7 = await board.create({ title: "Add the login page", ref: ref(7), parentId: epic.id, priority: 1 });
  const t9 = await board.create({ title: "Remember me", ref: ref(9), parentId: epic.id, priority: 2 });
  const t10 = await board.create({ title: "Sign out", ref: ref(10), parentId: epic.id, priority: 3 });
  const t11 = await board.create({ title: "Index the users", ref: ref(11), priority: 4, body: "Milestone: Phase 2" });
  const t12 = await board.create({ title: "Pay by card", ref: ref(12), priority: 5 });
  await board.create({ title: "Another repo's task", ref: "github:x/other#3", priority: 0 });
  await board.link(t11.id, t9.id, "blocks");
  await board.close(t10.id, { outcome: "done" });
  const menelik = await Board.open(url, { as: "menelik" });
  boards.push(menelik);
  await menelik.claim(t7.id);
  await menelik.post({ task: t7.id, kind: "question", to: "fasil", body: "Which provider do we use for sign in?" });
  await menelik.note(t7.id, { kind: "decision", body: "Sessions live in a cookie." });
  return { board, id: { 1: epic.id, 7: t7.id, 9: t9.id, 10: t10.id, 11: t11.id, 12: t12.id } };
}

async function boardUrl(): Promise<string> {
  const db = await freshDb(pg);
  drops.push(db.drop);
  return db.url;
}

async function started(p: Project, url: string): Promise<Running> {
  const ui = await startUi(p, ["--port", "0"], null, { MB_URL: url });
  running.push(ui);
  return ui;
}

function rowsOf(json: Row): Row[] {
  return json.tasks as Row[];
}

function byId(json: Row): Record<string, Row> {
  return Object.fromEntries(rowsOf(json).map((t) => [String(t.id), t]));
}

/** GET tasks until `ok` says so or `ms` pass; the last answer. */
async function tasksUntil(ui: Running, ok: (json: Row) => boolean, ms: number): Promise<Row> {
  const deadline = Date.now() + ms;
  let last: Row = {};
  while (Date.now() < deadline) {
    last = (await api(ui, "/api/projects/work/tasks")).json;
    if (ok(last)) return last;
    await Bun.sleep(150);
  }
  return last;
}

function socket(ui: Running): { ws: WebSocket; next: (want: (m: Row) => boolean, ms: number) => Promise<Row | null> } {
  const ws = new WebSocket(ui.url.replace("http", "ws") + `/api/ws?token=${ui.token}`);
  const seen: Row[] = [];
  const waiting: { want: (m: Row) => boolean; done: (m: Row) => void }[] = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as Row;
    const w = waiting.findIndex((x) => x.want(m));
    if (w >= 0) waiting.splice(w, 1)[0]?.done(m);
    else seen.push(m);
  };
  const next = (want: (m: Row) => boolean, ms: number): Promise<Row | null> => {
    const i = seen.findIndex(want);
    if (i >= 0) return Promise.resolve(seen.splice(i, 1)[0] as Row);
    return new Promise((resolve) => {
      const entry = { want, done: (m: Row) => resolve(m) };
      waiting.push(entry);
      setTimeout(() => {
        const at = waiting.indexOf(entry);
        if (at >= 0) {
          waiting.splice(at, 1);
          resolve(null);
        }
      }, ms);
    });
  };
  return { ws, next };
}

const fromBoardViews = (m: Row) => m.type === "views" && m.project === "work" && (m.tasks as Row | undefined)?.from === "board";

// --- reading from the board ----------------------------------------------------------------------------------------------

test("the tasks API answers from the board: columns from its status, blocked and ready, holders, epics and blockers", async () => {
  const url = await boardUrl();
  await seeded(url);
  const ui = await started(workProject(), url);
  const json = await tasksUntil(ui, (j) => j.from === "board", 15_000);
  expect(json.from, JSON.stringify(json)).toBe("board");
  const t = byId(json);
  expect(Object.keys(t).sort()).toEqual(["11", "12", "7", "9"]); // open tasks of this repo only; no #99 from GitHub, no epic, no other repo
  expect(t["7"]).toMatchObject({ state: "in-progress", holders: ["menelik"], epic: "1", url: `https://github.com/${REPO}/issues/7` });
  expect(t["9"]).toMatchObject({ state: "blocked", holders: [], epic: "1", blockedBy: ["11"] });
  expect(t["11"]).toMatchObject({ state: "ready", group: "Phase 2", epic: null, blockedBy: [] });
  expect(t["12"]?.state).toBe("ready");
  expect(json.next).toBe("11"); // the board's ready queue: #9 is blocked, #7 is held
  expect((t["7"]?.pr as Row).number).toBe(21); // pull requests still come from the snapshot
  expect(t["7"]?.actions).toEqual(["release", "block", "reassign"]); // they act through the GitHub path (0007 point 9)
  const epics = (await api(ui, "/api/projects/work/epics")).json;
  expect(epics.from).toBe("board");
  const e = (epics.epics as Row[]).find((x) => x.id === "1") as Row;
  expect(e).toMatchObject({ title: "Sign in", done: 1, all: 3, prd: "docs/PRD.md", summary: "Let people sign in." });
  expect(problemsOf(json)).toEqual([]);
}, T);

function problemsOf(json: Row): string[] {
  return ((json.problems as Row[] | undefined) ?? []).map((p) => String(p.code));
}

test("a task's thread and context come from the board", async () => {
  const url = await boardUrl();
  await seeded(url);
  const ui = await started(workProject(), url);
  await tasksUntil(ui, (j) => j.from === "board", 15_000);
  const r = await api(ui, "/api/projects/work/tasks/7");
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect((r.json.task as Row).title).toBe("Add the login page");
  const thread = r.json.thread as Row[];
  expect(thread.map((m) => [m.from, m.kind, m.to, m.body])).toEqual([["menelik", "question", "fasil", "Which provider do we use for sign in?"]]);
  expect((r.json.context as Row[]).map((c) => [c.kind, c.body, c.author])).toEqual([["decision", "Sessions live in a cookie.", "menelik"]]);
  const none = await api(ui, "/api/projects/work/tasks/404");
  expect(none.status).toBe(404);
  expect(Object.keys(none.json).sort()).toEqual(["code", "fix", "message"]);
}, T);

test("a write on the board reaches an open WebSocket within a second", async () => {
  const url = await boardUrl();
  const { board } = await seeded(url);
  const ui = await started(workProject(), url);
  const { ws, next } = socket(ui);
  try {
    expect(await next(fromBoardViews, 15_000), "the first views from the board").not.toBeNull();
    const at = Date.now();
    await board.create({ title: "Reset the password", ref: ref(20), priority: 9 });
    const m = await next((x) => fromBoardViews(x) && rowsOf(x.tasks as Row).some((t) => t.id === "20"), 3_000);
    const took = Date.now() - at;
    expect(m, "the new task reached the page").not.toBeNull();
    expect(took).toBeLessThan(1_000);
  } finally {
    ws.close();
  }
}, T);

test("with a board, the server asks the snapshot not to read tasks from GitHub, and no GitHub call reads them", async () => {
  const url = await boardUrl();
  await seeded(url);
  const p = workProject(3_600); // an old cache: the server reads the snapshot again
  const ui = await started(p, url);
  const { ws, next } = socket(ui);
  try {
    expect(await next(fromBoardViews, 15_000)).not.toBeNull();
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !readFileSync(p.factoryLog, "utf8").includes("snapshot")) await Bun.sleep(200);
    await Bun.sleep(2_500); // a few of the server's reads at ui.pollSeconds (1 s)
  } finally {
    ws.close();
  }
  const snapshots = readFileSync(p.factoryLog, "utf8").split("\n").filter((l) => l.startsWith("snapshot"));
  expect(snapshots.length).toBeGreaterThan(0);
  for (const s of snapshots) expect(s).toBe("snapshot tasks=board");
  const gh = readFileSync(p.ghLog, "utf8").split("\n").filter(Boolean);
  // the agents' own issues (factory:agent) are read as today; no task or issue list is
  expect(gh.filter((l) => /issues/.test(l) && !/factory(:|%3A)agent/.test(l))).toEqual([]);
}, T);

test("Release on a board task still runs through the GitHub path", async () => {
  const url = await boardUrl();
  await seeded(url);
  const p = workProject();
  const ui = await started(p, url);
  await tasksUntil(ui, (j) => j.from === "board", 15_000);
  const r = await api(ui, "/api/projects/work/tasks/7/actions/release", { method: "POST", body: { confirm: true, reason: "try again" } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(readFileSync(p.factoryLog, "utf8")).toContain("issues release 7 try again");
}, T);

// --- the board is the record (#502): with tasks.source board the card's actions write to the board ----------------------

const BOARD_CONFIG = { ...CONFIG, tasks: { source: "board" } };

/** The project's factory commands the server ran, without the snapshots. */
function factoryRan(p: Project): string[] {
  return readFileSync(p.factoryLog, "utf8").split("\n").filter((l) => l && !l.startsWith("snapshot"));
}

test("with tasks.source board, Release takes the task back on the board, with its reason, and runs no factory issues", async () => {
  const url = await boardUrl();
  const { board, id } = await seeded(url);
  const p = workProject(0, BOARD_CONFIG);
  const ui = await started(p, url);
  await tasksUntil(ui, (j) => j.from === "board", 15_000);
  const r = await api(ui, "/api/projects/work/tasks/7/actions/release", { method: "POST", body: { confirm: true, reason: "try again" } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(await board.get(id[7] as number)).toMatchObject({ status: "open", holder: null });
  const back = (await board.events(0, 500, { kind: "task.taken_back" })).find((e) => e.subject === `task:${id[7]}`);
  expect(back?.payload.reason).toBe("try again");
  expect(factoryRan(p)).toEqual([]);
  const json = await tasksUntil(ui, (j) => byId(j)["7"]?.state === "ready", 15_000);
  expect(byId(json)["7"]?.holders).toEqual([]);
}, T);

test("with tasks.source board, Block moves the task to blocked with a blocker note; the board and the tracker both call it blocked", async () => {
  const url = await boardUrl();
  const { board, id } = await seeded(url);
  const p = workProject(0, BOARD_CONFIG);
  const ui = await started(p, url);
  await tasksUntil(ui, (j) => j.from === "board", 15_000);
  const r = await api(ui, "/api/projects/work/tasks/12/actions/block", { method: "POST", body: { confirm: true, reason: "needs the card keys" } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect((await board.get(id[12] as number)).status).toBe("deferred");
  expect((await board.contextFor(id[12] as number)).map((c) => [c.kind, c.body])).toContainEqual(["blocker", "needs the card keys"]);
  expect(factoryRan(p)).toEqual([]);
  const json = await tasksUntil(ui, (j) => byId(j)["12"]?.state === "blocked", 15_000);
  expect(byId(json)["12"]?.state).toBe("blocked"); // deferred is blocked, as the task tracker says (not "not ready")
  expect(byId(json)["12"]?.actions).toEqual(["release"]);
}, T);

test("with tasks.source board, Reassign hands the task to the agent on the board, then tells that agent; no factory issues", async () => {
  const url = await boardUrl();
  const { board, id } = await seeded(url);
  const p = workProject(0, BOARD_CONFIG);
  const ui = await started(p, url);
  await tasksUntil(ui, (j) => j.from === "board", 15_000);
  const r = await api(ui, "/api/projects/work/tasks/7/actions/reassign", { method: "POST", body: { confirm: true, agent: "taytu" } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(await board.get(id[7] as number)).toMatchObject({ assignee: "taytu", holder: null, status: "open" });
  expect(factoryRan(p)).toEqual(["say taytu /next-task issue-7"]);
}, T);

test("with tasks.source board and the board down, an action is refused with the fix and nothing runs on GitHub", async () => {
  const p = workProject(0, BOARD_CONFIG);
  const ui = await started(p, "postgres://nobody:pw@127.0.0.1:1/none");
  const r = await api(ui, "/api/projects/work/tasks/99/actions/release", { method: "POST", body: { confirm: true } });
  expect(r.status, JSON.stringify(r.json)).toBe(503);
  expect(r.json.code).toBe("ui_board_unreachable");
  expect(factoryRan(p)).toEqual([]);
}, T);

// --- falling back ------------------------------------------------------------------------------------------------------

test("without a board the tasks come from GitHub's snapshot as before, with no notice", async () => {
  const p = workProject();
  const ui = await startUi(p, ["--port", "0"]);
  running.push(ui);
  const json = (await api(ui, "/api/projects/work/tasks")).json;
  expect(json.from).toBe("github");
  expect(typeof json.every).toBe("number");
  expect(Object.keys(byId(json))).toEqual(["99"]);
  expect(problemsOf(json)).toEqual([]);
}, T);

test("a board that can't be reached: a notice with the fix in plain words, and the tasks from GitHub", async () => {
  const p = workProject();
  const dead = "postgres://factory:secret-pw@127.0.0.1:9/board"; // nothing listens on port 9
  const ui = await started(p, dead);
  const json = await tasksUntil(ui, (j) => problemsOf(j).includes("ui_board_unreachable"), 20_000);
  expect(json.from).toBe("github");
  expect(Object.keys(byId(json))).toEqual(["99"]);
  const notice = ((json.problems as Row[]).find((x) => x.code === "ui_board_unreachable")) as Row;
  expect(String(notice.message)).toContain("message board");
  expect(String(notice.fix)).not.toMatch(/`|factory board/); // no command on screen
  expect(JSON.stringify(json)).not.toContain("secret-pw");
}, T);

test("a board that goes down: the page gets the notice and falls back to GitHub, and the snapshot reads tasks again", async () => {
  const db = await freshDb(pg);
  await seeded(db.url);
  const p = workProject();
  const ui = await started(p, db.url);
  const { ws, next } = socket(ui);
  try {
    expect(await next(fromBoardViews, 15_000)).not.toBeNull();
    for (const b of boards.splice(0)) await b.end().catch(() => {});
    await db.drop();
    const m = await next((x) => x.type === "views" && x.project === "work" && (x.tasks as Row).from === "github" &&
      problemsOf(x.tasks as Row).includes("ui_board_unreachable"), 30_000);
    expect(m, "the fallback reached the page").not.toBeNull();
    expect(Object.keys(byId(m?.tasks as Row))).toEqual(["99"]);
  } finally {
    ws.close();
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !readFileSync(p.factoryLog, "utf8").includes("snapshot tasks=\n")) await Bun.sleep(200);
  expect(readFileSync(p.factoryLog, "utf8").split("\n")).toContain("snapshot tasks=");
}, T);

test("a project with no task on the board keeps the GitHub path, with no notice", async () => {
  const url = await boardUrl();
  const b = await Board.open(url);
  boards.push(b);
  await b.migrate();
  await b.create({ title: "Someone else's", ref: "github:x/other#1" });
  const ui = await started(workProject(), url);
  await Bun.sleep(1_500);
  const json = (await api(ui, "/api/projects/work/tasks")).json;
  expect(json.from).toBe("github");
  expect(Object.keys(byId(json))).toEqual(["99"]);
  expect(problemsOf(json)).toEqual([]);
}, T);

test("an install without the board's code (a release, for now) keeps the GitHub path even with a board set up", async () => {
  const url = await boardUrl();
  await seeded(url);
  const p = workProject();
  const hooks = join(p.d, ".claude", "hooks");
  mkdirSync(hooks, { recursive: true });
  for (const f of readdirSync(HOOKS)) if (f.endsWith(".ts")) copyFileSync(join(HOOKS, f), join(hooks, f));
  copyHookFolders(hooks);
  cpSync(CI, join(p.d, ".claude", "ci"), { recursive: true });
  const ui = await startUi(p, ["ui", "--port", "0"], ["bash", join(SF, "factory")], { MB_URL: url });
  running.push(ui);
  await Bun.sleep(1_500);
  const json = (await api(ui, "/api/projects/work/tasks")).json;
  expect(json.from).toBe("github");
  expect(Object.keys(byId(json))).toEqual(["99"]);
  expect(problemsOf(json)).toEqual([]);
}, T);

test("with a board, the read after a release starts at once (leaving tasks out), every time", async () => {
  const url = await boardUrl();
  await seeded(url);
  for (let i = 0; i < 5; i++) {
    const p = workProject();
    const ui = await started(p, url);
    await tasksUntil(ui, (j) => j.from === "board", 15_000); // the card is the board's
    const r = await api(ui, "/api/projects/work/tasks/7/actions/release", { method: "POST", body: { confirm: true } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(readFileSync(p.factoryLog, "utf8").split("\n"), `run ${i + 1}`).toContain("snapshot tasks=board");
    await ui.stop();
  }
}, T);

/** A fake `factory` whose snapshot takes `seconds`, logging when each starts (with its tasks setting) and ends. */
const SLOW_FACTORY = (seconds: number) => `#!/usr/bin/env bash
if [ "$1" = snapshot ]; then
  echo "snapshot start tasks=\${FACTORY_SNAPSHOT_TASKS:-}" >> "$FAKE_FACTORY_LOG"; sleep ${seconds}; echo "snapshot end" >> "$FAKE_FACTORY_LOG"; exit 0
fi
echo "$*" >> "$FAKE_FACTORY_LOG"
`;

test("a board that drops while a snapshot without tasks runs: a full snapshot runs as soon as that one ends", async () => {
  const db = await freshDb(pg);
  await seeded(db.url);
  const p = workProject(3_600); // old: a snapshot starts at once
  writeExe(join(p.d, "factory"), SLOW_FACTORY(8));
  const ui = await started(p, db.url);
  const { ws, next } = socket(ui);
  const lines = () => readFileSync(p.factoryLog, "utf8").split("\n").filter(Boolean);
  try {
    expect(await next(fromBoardViews, 15_000)).not.toBeNull();
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !lines().includes("snapshot start tasks=board")) await Bun.sleep(100);
    expect(lines()).toContain("snapshot start tasks=board");
    for (const b of boards.splice(0)) await b.end().catch(() => {});
    await db.drop(); // while that snapshot runs
    expect(await next((x) => x.type === "views" && x.project === "work" && (x.tasks as Row).from === "github", 15_000)).not.toBeNull();
    const until = Date.now() + 20_000;
    while (Date.now() < until && !lines().includes("snapshot start tasks=")) await Bun.sleep(200);
  } finally {
    ws.close();
  }
  const l = lines();
  const full = l.indexOf("snapshot start tasks=");
  expect(full, l.join("\n")).toBeGreaterThan(l.indexOf("snapshot end")); // queued behind the busy one, not dropped
  expect(l.indexOf("snapshot end")).toBeGreaterThan(l.indexOf("snapshot start tasks=board"));
}, T);
