// The web UI reads tasks from the message board, live (#498, decision 0007 points 6 and 10, step 3a): with a board,
// the Board page's tasks and epics come from it (status to column, blocked and ready worked out by the board, lanes by
// epic from parents and by agent from holders, each card's blockers), a write on the board reaches an open page within
// a second, and the tasks aren't read from GitHub. A task's thread and context come from the board. Without a board the
// GitHub path is as before; a board that can't be reached shows a notice and that project falls back to GitHub.
// A real Postgres (board_pg.ts), the real server (startUi), a fake gh and a fake `factory` that logs what it was asked.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { copyFileSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Board } from "../message-board/src/index.ts";
import { freshDb, migrateUpTo, type Pg, startPg } from "./board_pg.ts";
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

// Each test's servers and connections end with it: CI runs many files at once against one Postgres (max_connections 100).
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop().catch(() => {});
  for (const b of boards.splice(0)) await b.end().catch(() => {});
}, 120_000);

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
  const board = await Board.open(url, { as: "system", max: 1 });
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
  const menelik = await Board.open(url, { as: "menelik", max: 1 });
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

test("when an epic's last task is done on the board, the Epics page shows its stage as done", async () => {
  const url = await boardUrl();
  const { board, id } = await seeded(url);
  await board.move(id[7] as number, { to: "done", reason: "its pull request merged" });
  await board.close(id[9] as number, { outcome: "done" });
  expect((await board.get(id[1] as number)).status).toBe("done");
  const ui = await started(workProject(), url);
  await tasksUntil(ui, (j) => j.from === "board", 15_000);
  const epics = (await api(ui, "/api/projects/work/epics")).json;
  const e = (epics.epics as Row[]).find((x) => x.id === "1") as Row;
  expect(e).toMatchObject({ stage: "done", done: 3, all: 3 });
}, T);

test("a task that waits for its PRD change's card shows as waiting, with a link to the PRD pull request, not as blocked by the card (#578)", async () => {
  const url = await boardUrl();
  const { board, id } = await seeded(url);
  const card = await board.create({ title: "PRD change: #62 (Shelf v1.1)", kind: "note", body: "PRD change: #62", ref: `factory:${REPO}/prd-62` });
  await board.link(id[12] as number, card.id, "waits_for");
  const ui = await started(workProject(), url);
  const json = await tasksUntil(ui, (j) => j.from === "board", 15_000);
  const t = byId(json);
  expect(Object.keys(t).sort()).toEqual(["11", "12", "7", "9"]); // the card is not a task
  expect(t["12"]).toMatchObject({ state: "blocked", stateText: "waits for its PRD", blockedBy: [], next: false,
    prd: { number: 62, url: `https://github.com/${REPO}/pull/62` } });
  expect(t["11"]?.prd).toBeNull();
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

test("with nothing changing, an open WebSocket gets no second views over a few polls; a board write sends one (#529)", async () => {
  const url = await boardUrl();
  const { board } = await seeded(url);
  const ui = await started(workProject(), url);
  const { ws, next } = socket(ui);
  const views: string[] = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(String(e.data)) as Row;
    if (m.type === "views" && m.project === "work") views.push(String(e.data));
  });
  try {
    expect(await next(fromBoardViews, 15_000), "the first views from the board").not.toBeNull();
    await Bun.sleep(1_500); // let the reads the start began settle
    const settled = views.length;
    await Bun.sleep(4_500); // four of the server's reads at ui.pollSeconds (1 s)
    expect(views.slice(settled), "nothing changed, so nothing is sent again").toEqual([]);
    await board.create({ title: "Reset the password", ref: ref(20), priority: 9 });
    expect(await next((x) => fromBoardViews(x) && rowsOf(x.tasks as Row).some((t) => t.id === "20"), 3_000), "the write is sent").not.toBeNull();
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

/** Stops the server and closes the test's board connections, so the tests after it have connections to spare. */
async function finish(ui: Running): Promise<void> {
  await ui.stop();
  for (const b of boards.splice(0)) await b.end().catch(() => {});
}

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
  await finish(ui);
}, T);

test("a task made on the board for this project (ref factory:<repo>/...) is on the Board page as b<id>, and Release works on it (#528)", async () => {
  const url = await boardUrl();
  const { board } = await seeded(url);
  const mine = await board.create({ title: "Made on the board", ref: `factory:${REPO}/0f3c`, priority: 0 });
  await board.create({ title: "Another repo's board task", ref: "factory:x/other/9a1b", priority: 0 });
  const menelik = await Board.open(url, { as: "menelik", max: 1 });
  boards.push(menelik);
  await menelik.claim(mine.id);
  const p = workProject(0, BOARD_CONFIG);
  const ui = await started(p, url);
  const json = await tasksUntil(ui, (j) => j.from === "board", 15_000);
  const t = byId(json);
  expect(Object.keys(t).sort()).toEqual(["11", "12", "7", "9", `b${mine.id}`]);
  expect(t[`b${mine.id}`]).toMatchObject({ title: "Made on the board", state: "in-progress", holders: ["menelik"], url: null });
  const r = await api(ui, `/api/projects/work/tasks/b${mine.id}/actions/release`, { method: "POST", body: { confirm: true, reason: "try again" } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(await board.get(mine.id)).toMatchObject({ status: "open", holder: null });
  expect(factoryRan(p)).toEqual([]);
  await finish(ui);
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
  await finish(ui);
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
  await finish(ui);
}, T);

// --- #543, #545, #546: what a person sees on a card and its page ---------------------------------------------------------

test("Reassign to an agent that isn't running: the board hands the task over and the answer says it is taken at the agent's start", async () => {
  const url = await boardUrl();
  const { board, id } = await seeded(url);
  const p = workProject(0, BOARD_CONFIG);
  // the fake factory refuses `say` as the real one does for an agent with no session here
  writeExe(join(p.d, "factory"), FAKE_FACTORY.replace('echo "$*" >> "$FAKE_FACTORY_LOG"',
    'echo "$*" >> "$FAKE_FACTORY_LOG"\nif [ "$1" = say ]; then echo \'{"code": "no-such-agent", "message": "No agent called taytu was found.", "fix": "x"}\' >&2; exit 1; fi'));
  const ui = await started(p, url);
  await tasksUntil(ui, (j) => j.from === "board", 15_000);
  const r = await api(ui, "/api/projects/work/tasks/12/actions/reassign", { method: "POST", body: { confirm: true, agent: "taytu" } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.ok).toBe(true);
  expect(String(r.json.output)).toBe("#12 is handed to taytu on the message board. taytu isn't running on this machine now, so it takes #12 when it starts.");
  expect(await board.get(id[12] as number)).toMatchObject({ assignee: "taytu", holder: null });
  // the card says who it is for: the tasks API carries it
  const json = await tasksUntil(ui, (j) => byId(j)["12"]?.assignee === "taytu", 15_000);
  expect(byId(json)["12"]).toMatchObject({ assignee: "taytu", holders: [] });
  await finish(ui);
}, T);

test("a task's page has its own words from the board, and when it was made and changed", async () => {
  const url = await boardUrl();
  const { board } = await seeded(url);
  const made = await board.create({ title: "Export the list", ref: `factory:${REPO}/e1`, priority: 0, body: "Export the reading list as CSV.\n\nWith a header row." });
  const ui = await started(workProject(), url);
  await tasksUntil(ui, (j) => byId(j)[`b${made.id}`] !== undefined, 15_000);
  const r = await api(ui, `/api/projects/work/tasks/b${made.id}`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.body).toBe("Export the reading list as CSV.\n\nWith a header row.");
  expect(Number.isNaN(Date.parse(String(r.json.createdAt)))).toBe(false);
  expect(Number.isNaN(Date.parse(String(r.json.updatedAt)))).toBe(false);
  await finish(ui);
}, T);

test("a pull request names the board task it is for by its branch (task/b3-...) or its title (b3: ...), and the card links it", async () => {
  const url = await boardUrl();
  const { board } = await seeded(url);
  const a = await board.create({ title: "Slugify", ref: `factory:${REPO}/s1`, priority: 0 });
  const b = await board.create({ title: "Word count", ref: `factory:${REPO}/w1`, priority: 0 });
  const p = workProject();
  const c = JSON.parse(readFileSync(join(p.state, "snapshot.json"), "utf8")) as Row;
  const pr = (n: number, branch: string, title: string): Row => ({ number: n, title, url: `https://github.com/${REPO}/pull/${n}`, branch, draft: false,
    ci: "green", next: "none", nextText: "none", agent: "taytu", review: null, gate: null, notGreen: [], protected: null, claim: null });
  c.pulls = [...(c.pulls as Row[]), pr(39, `task/b${a.id}-slugify`, "Slugify"), pr(41, "taytu/word-count", `b${b.id}: textkit: wordCount(text)`)];
  write(join(p.state, "snapshot.json"), JSON.stringify(c));
  const ui = await started(p, url);
  const json = await tasksUntil(ui, (j) => byId(j)[`b${b.id}`] !== undefined, 15_000);
  expect((byId(json)[`b${a.id}`]?.pr as Row | null)?.number).toBe(39);
  expect((byId(json)[`b${b.id}`]?.pr as Row | null)?.number).toBe(41);
  await finish(ui);
}, T);

test("with tasks.source board and the board down, an action is refused with the fix and nothing runs on GitHub", async () => {
  const p = workProject(0, BOARD_CONFIG);
  const ui = await started(p, "postgres://nobody:pw@127.0.0.1:1/none");
  const r = await api(ui, "/api/projects/work/tasks/99/actions/release", { method: "POST", body: { confirm: true } });
  expect(r.status, JSON.stringify(r.json)).toBe(503);
  expect(r.json.code).toBe("ui_board_unreachable");
  expect(factoryRan(p)).toEqual([]);
  await finish(ui);
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

test("a board older than this machine's code: the Board page warns, with the fix, until the hub migrates it (#570)", async () => {
  const url = await boardUrl();
  migrateUpTo(url, "003_leases_values.sql"); // an older release's board: 004_waits_for not applied
  const b = await Board.open(url, { as: "system", max: 1 });
  boards.push(b);
  await b.create({ title: "Import the users", ref: ref(17) });
  const ui = await started(workProject(), url);
  const json = await tasksUntil(ui, (j) => problemsOf(j).includes("ui_board_schema_behind"), 20_000);
  expect(json.from, JSON.stringify(json)).toBe("board"); // the tasks still come from the board
  expect(Object.keys(byId(json))).toEqual(["17"]);
  const notice = (json.problems as Row[]).find((x) => x.code === "ui_board_schema_behind") as Row;
  expect(String(notice.message)).toContain("1 migration pending (004_waits_for.sql)");
  expect(String(notice.message)).toContain("blocked or ready may be wrong");
  expect(String(notice.fix)).toContain("On the hub");
  expect(String(notice.fix)).toContain("factory board migrate");
  await b.migrate();
  const after = await tasksUntil(ui, (j) => !problemsOf(j).includes("ui_board_schema_behind"), 20_000);
  expect(problemsOf(after)).toEqual([]);
  expect(after.from).toBe("board");
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

// --- the board as the record and down; the snapshot banner (#515) --------------------------------------------------------

test("with tasks.source board and the board down, the tasks are unknown: one notice, no GitHub tasks, no empty board", async () => {
  const p = workProject(0, BOARD_CONFIG);
  const ui = await started(p, "postgres://nobody:secret-pw@127.0.0.1:9/board"); // nothing listens on port 9
  const json = await tasksUntil(ui, (j) => problemsOf(j).includes("ui_board_down"), 20_000);
  expect(json.from).toBe("unknown");
  expect(rowsOf(json)).toEqual([]); // not #99 from GitHub's snapshot
  expect(problemsOf(json)).toEqual(["ui_board_down"]); // one notice: not "tasks come from GitHub for now" as well
  const notice = (json.problems as Row[])[0] as Row;
  expect(notice.message).toBe("The message board can't be reached, so tasks are unknown until it's back.");
  expect(notice.fix).toBe("On the hub, start it again.");
  const epics = (await api(ui, "/api/projects/work/epics")).json;
  expect(epics.from).toBe("unknown");
  expect(problemsOf(epics)).toEqual(["ui_board_down"]);
  expect(JSON.stringify(json)).not.toContain("secret-pw");
  await finish(ui);
}, T);

test("with tasks.source board and a board with none of the project's tasks yet, the board is empty, from the board", async () => {
  const url = await boardUrl();
  const b = await Board.open(url, { as: "system", max: 1 });
  boards.push(b);
  await b.migrate();
  const ui = await started(workProject(0, BOARD_CONFIG), url);
  const json = await tasksUntil(ui, (j) => j.from === "board", 15_000);
  expect(json.from).toBe("board");
  expect(rowsOf(json)).toEqual([]);
  expect(problemsOf(json)).toEqual([]);
  await finish(ui);
}, T);

// #523: the board answered but its tasks weren't read yet (slow under load), and the page said "from the board" with an
// empty board, so an action sent then was refused with 503. Here the first read is held back by a lock on the tasks table.
test("with tasks.source board, the board isn't shown as live until its tasks are read; then an action is taken", async () => {
  const url = await boardUrl();
  await seeded(url);
  const locker = new SQL(url, { max: 1 });
  let unlock = (): void => {};
  const held = new Promise<void>((resolve) => (unlock = resolve));
  let locked = (): void => {};
  const lockTaken = new Promise<void>((resolve) => (locked = resolve));
  const tx = locker.begin(async (t) => {
    await t`LOCK TABLE tasks IN ACCESS EXCLUSIVE MODE`;
    locked();
    await held;
  });
  try {
    await Promise.race([lockTaken, tx.then(() => { throw new Error("the lock transaction ended before it took the lock"); })]);
    const ui = await started(workProject(0, BOARD_CONFIG), url);
    await Bun.sleep(1_500); // the server has opened the board and waits on the tasks table
    const opening = (await api(ui, "/api/projects/work/tasks")).json;
    expect(opening.from).toBe("unknown"); // not "board" with no tasks: they aren't read yet
    expect(rowsOf(opening)).toEqual([]);
    expect(problemsOf(opening)).toEqual([]); // opening, not down
    unlock();
    await tx;
    await tasksUntil(ui, (j) => j.from === "board", 15_000);
    const r = await api(ui, "/api/projects/work/tasks/7/actions/release", { method: "POST", body: { confirm: true, reason: "try again" } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    await finish(ui);
  } finally {
    unlock();
    await tx.catch(() => {});
    await locker.close();
  }
}, T);

test("tasks from a healthy board show no 'no snapshot yet' banner; the pull requests, still from the snapshot, do", async () => {
  const url = await boardUrl();
  await seeded(url);
  const p = workProject();
  rmSync(join(p.state, "snapshot.json")); // no snapshot: the repo comes from the git remote
  Bun.spawnSync(["git", "-C", p.d, "remote", "add", "origin", `https://github.com/${REPO}.git`]);
  const ui = await started(p, url);
  const json = await tasksUntil(ui, (j) => j.from === "board", 15_000);
  expect(problemsOf(json)).not.toContain("ui_no_snapshot");
  expect(problemsOf((await api(ui, "/api/projects/work/epics")).json)).not.toContain("ui_no_snapshot");
  expect(problemsOf((await api(ui, "/api/projects/work/pull-requests")).json)).toContain("ui_no_snapshot");
  await finish(ui);
}, T);

test("the server logs that the board can't be read, and that it reconnected once it answers again", async () => {
  const db = await freshDb(pg);
  drops.push(db.drop);
  const name = new URL(db.url).pathname.slice(1);
  await db.drop(); // the board isn't there when the server starts
  const ui = await started(workProject(), db.url);
  const reader = (ui.proc.stdout as ReadableStream<Uint8Array>).getReader();
  let out = "";
  const until = async (word: string, ms: number): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (!out.includes(word) && Date.now() < deadline) {
      const next = await Promise.race([reader.read(), Bun.sleep(Math.max(deadline - Date.now(), 1)).then(() => null)]);
      if (next === null || next.done) break;
      out += new TextDecoder().decode(next.value);
    }
    return out.includes(word);
  };
  try {
    expect(await until("can't be read", 15_000), out).toBe(true);
    const admin = new SQL(pg.url, { max: 1 });
    try {
      await admin.unsafe(`create database ${name}`);
    } finally {
      await admin.close();
    }
    await seeded(db.url);
    expect(await until("reconnected", 30_000), out).toBe(true);
    expect(out).toContain("message board");
    expect(out).not.toContain(new URL(pg.url).password);
  } finally {
    reader.releaseLock();
    await finish(ui);
  }
}, T);

test("the tasks done this week come apart from the open ones, newest first, for the board's Done column (#545)", async () => {
  const url = await boardUrl();
  const { board } = await seeded(url);
  const later = await board.create({ title: "Remember the theme", ref: ref(13), priority: 6 });
  await board.close(later.id, { outcome: "done" });
  const ui = await started(workProject(), url);
  const json = await tasksUntil(ui, (j) => j.from === "board", 15_000);
  expect(Object.keys(byId(json)).sort()).toEqual(["11", "12", "7", "9"]); // the open tasks, as before
  const done = json.done as Row[];
  expect(done.map((t) => t.id)).toEqual(["13", "10"]); // newest first
  expect(done[0]).toMatchObject({ state: "done", holders: [], blockedBy: [], actions: [], title: "Remember the theme" });
  await finish(ui);
}, T);

test("an answer about a task made on the board names it b3, not #b3 (#546)", async () => {
  const url = await boardUrl();
  const { board } = await seeded(url);
  const mine = await board.create({ title: "Made on the board", ref: `factory:${REPO}/n1`, priority: 0 });
  await board.close(mine.id, { outcome: "done" });
  const p = workProject(0, BOARD_CONFIG);
  const ui = await started(p, url);
  await tasksUntil(ui, (j) => j.from === "board", 15_000);
  const gone = await api(ui, "/api/projects/work/tasks/b99999/actions/release", { method: "POST", body: { confirm: true } });
  expect(gone.status).toBe(404);
  expect(String(gone.json.message)).toStartWith("b99999 isn't one of");
  const page = await api(ui, "/api/projects/work/tasks/b99999");
  expect(String(page.json.message)).toStartWith("b99999 isn't one of");
  await finish(ui);
}, T);
