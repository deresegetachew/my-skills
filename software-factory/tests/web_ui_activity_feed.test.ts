// Activity as a live feed across agents (#583): with the message board as the project's record, every kind of board
// event (claim, release, block, comment, ask and answer, an agent up or down, a pull request's CI and merge from the
// pull request feed) is one line with who, what, when and the page it opens, newest first; the filters narrow it by
// agent, task, epic and kind; and a new event reaches an open page over the WebSocket as the entry itself. A real
// Postgres (board_pg.ts), the real server, a fake gh and a fake `factory`; no GitHub call is made for it.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
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

async function as(url: string, who: string): Promise<Board> {
  const b = await Board.open(url, { as: who, max: 1 });
  boards.push(b);
  return b;
}

/** An agent's liveness as factory_agents.ts writes it on the board (core/adapters/board/agents.ts): a value and a
 *  `signal.agent` event. The project is the folder's name here (compose.ts messagingProject: no origin). */
async function agentIs(b: Board, name: string, status: string, projectName = "work"): Promise<void> {
  await b.setValue(`${projectName}:agent:${name}`, { v: 1, name, status, detail: "", ping: new Date().toISOString(), started: "", machine: "m" },
    [{ name: "agent", payload: { project: projectName, name, status, detail: "" } }]);
}

/** A pull request change as the pull request feed publishes it (factory_pr_feed.ts, core/adapters/board/bus.ts). */
async function prChange(b: Board, pr: number, change: string, checks = "green", projectName = "work"): Promise<void> {
  await b.signal("pr", { project: projectName, pr, change, from: "fasil", head: "abc1234", checks, labels: [], at: new Date().toISOString() });
}

async function seeded(url: string): Promise<{ board: Board; id: Record<number, number> }> {
  const board = await as(url, "system");
  await board.migrate();
  const epic = await board.create({ title: "Sign in", kind: "epic", ref: ref(1) });
  const t7 = await board.create({ title: "Add the login page", ref: ref(7), parentId: epic.id, priority: 1 });
  const t12 = await board.create({ title: "Pay by card", ref: ref(12), priority: 3 });
  const menelik = await as(url, "menelik");
  const fasil = await as(url, "fasil");
  const claim = await menelik.claim(t7.id);
  const q = await menelik.post({ task: t7.id, kind: "question", to: "fasil", body: "Which provider do we use for sign in?" });
  await fasil.post({ task: t7.id, kind: "answer", to: "menelik", body: "GitHub.", inReplyTo: q.id });
  await menelik.release(t7.id, claim?.token ?? "", { next: "ready", reason: "waiting for the provider's keys" });
  await board.move(t12.id, { to: "blocked", reason: "needs the card provider's keys" });
  await agentIs(menelik, "menelik", "down");
  await agentIs(menelik, "menelik", "working");
  await agentIs(menelik, "menelik", "working"); // a ping that changes nothing isn't news
  await agentIs(fasil, "fasil", "down", "other"); // another project's agent
  await prChange(fasil, 21, "checks", "green");
  await prChange(fasil, 21, "merged");
  await prChange(fasil, 30, "merged", "green", "other"); // another project's pull request
  return { board, id: { 1: epic.id, 7: t7.id, 12: t12.id } };
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

const boardItems = (j: Row): Row[] => (j.items as Row[]).filter((x) => String(x.id).startsWith("board-"));

test("every kind of board event is one line with who, what, when and the page it opens, newest first", async () => {
  const url = await boardUrl();
  await seeded(url);
  const p = workProject();
  const ui = await startUi(p, ["--port", "0"], null, { MB_URL: url });
  running.push(ui);
  const ghBefore = readFileSync(p.ghLog, "utf8");
  const j = await activityUntil(ui, (x) => x.from === "board");
  expect(j.from, JSON.stringify(j)).toBe("board");
  expect(j.problems).toEqual([]);
  const items = boardItems(j).filter((x) => x.kind !== "new");
  expect(items.map((x) => [x.agent, x.kind, x.text, x.link])).toEqual([
    ["menelik", "pr", "merged PR #21", "pr:21"],
    ["menelik", "ci", "CI passed on PR #21", "pr:21"],
    ["menelik", "agent", "started", "agent:menelik"],
    ["menelik", "agent", "went down", "agent:menelik"],
    ["system", "move", "moved #12 to blocked: needs the card provider's keys", "view:tasks"],
    ["system", "note", "noted a blocker on #12", "view:tasks"], // the board keeps a block's reason as a blocker note, in the same write
    ["menelik", "handoff", "released #7: waiting for the provider's keys", "view:tasks"],
    ["fasil", "comment", "answered menelik on #7", "view:tasks"],
    ["menelik", "comment", "asked fasil on #7", "view:tasks"],
    ["menelik", "claim", "claimed #7 Add the login page", "view:tasks"],
  ]); // another project's agent and pull request aren't this one's
  for (const x of items) expect(typeof x.at === "string" && !Number.isNaN(Date.parse(x.at as string))).toBe(true);
  // the pull request's entries carry its task and epic, from the snapshot's pull request (no GitHub call)
  expect(items[0]).toMatchObject({ pr: 21, task: "7", epic: "1", find: "" });
  expect(items.find((x) => x.kind === "claim")).toMatchObject({ task: "7", epic: "1", find: "#7" });
  expect(items.find((x) => x.kind === "move")).toMatchObject({ task: "12", epic: null });
  expect(j.kinds).toEqual(expect.arrayContaining(["agent", "ci", "pr", "move", "claim", "comment", "handoff"]));
  expect(j.epics).toEqual([{ id: "1", title: "Sign in" }]);

  const agents = (await api(ui, "/api/projects/work/activity?kind=agent")).json.items as Row[];
  expect(agents.map((x) => x.text)).toEqual(["started", "went down"]);
  const epic = (await api(ui, "/api/projects/work/activity?epic=1")).json;
  expect(epic.filter).toEqual({ agent: "", task: "", epic: "1", kind: "" });
  expect((epic.items as Row[]).length).toBeGreaterThan(0);
  expect((epic.items as Row[]).every((x) => x.epic === "1")).toBe(true);
  expect((epic.items as Row[]).map((x) => x.text)).toContain("merged PR #21");
  expect((epic.items as Row[]).map((x) => x.text)).not.toContain("moved #12 to blocked: needs the card provider's keys");
  const fasil = (await api(ui, "/api/projects/work/activity?agent=fasil&kind=comment")).json.items as Row[];
  expect(fasil.map((x) => x.text)).toEqual(["answered menelik on #7"]);
  expect(readFileSync(p.ghLog, "utf8")).toBe(ghBefore); // Activity asks GitHub nothing
}, T);

test("a new board event reaches an open page over the WebSocket as the entry itself", async () => {
  const url = await boardUrl();
  const { board, id } = await seeded(url);
  const ui = await startUi(workProject(), ["--port", "0"], null, { MB_URL: url });
  running.push(ui);
  await activityUntil(ui, (x) => x.from === "board");
  const ws = new WebSocket(ui.url.replace("http", "ws") + `/api/ws?token=${ui.token}`);
  const pushed: Row[] = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as Row;
    if (m.type === "activity" && m.project === "work") pushed.push(m);
  };
  await new Promise((r) => { ws.onopen = r; });
  const seen = async (ok: (x: Row) => boolean): Promise<Row | undefined> => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const hit = pushed.flatMap((m) => (Array.isArray(m.items) ? (m.items as Row[]) : [])).find(ok);
      if (hit) return hit;
      await Bun.sleep(50);
    }
    return undefined;
  };
  await board.move(id[7] as number, { to: "blocked", reason: "the provider is down" });
  expect(await seen((x) => x.kind === "move" && x.task === "7")).toMatchObject({ agent: "system", text: "moved #7 to blocked: the provider is down",
    task: "7", epic: "1", link: "view:tasks", find: "#7" });
  const menelik = await as(url, "menelik");
  await agentIs(menelik, "menelik", "down"); // it was working (seeded): this is news
  expect(await seen((x) => x.kind === "agent")).toMatchObject({ agent: "menelik", text: "went down", link: "agent:menelik", task: null });
  const fasil = await as(url, "fasil");
  await prChange(fasil, 21, "head");
  expect(await seen((x) => x.kind === "pr")).toMatchObject({ agent: "menelik", text: "pushed to PR #21", pr: 21, task: "7", link: "pr:21" });
  ws.close();
  // what was pushed is what the page reads next
  const j = await activityUntil(ui, (x) => (x.items as Row[])[0]?.text === "pushed to PR #21");
  expect(((j.items as Row[]).slice(0, 3)).map((x) => x.text)).toEqual(["pushed to PR #21", "went down", "moved #7 to blocked: the provider is down"]);
}, T);
