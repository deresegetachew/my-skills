// The message board as the record, mirrored one way to GitHub (#502, decision 0007 points 5 and 9):
// - `factory board mirror` carries a task's state change on the board to its issue: one label call and one short line
//   per change, nothing for a state that didn't change, nothing on a second run; a GitHub failure leaves its place on
//   the board so the next run sends the change once; `board.mirror` false turns it off;
// - `factory board ask` writes an owner ask to the board and mirrors it once to the owner-queue issue; an answer the
//   owner gives there is read back once; `factory owner answer` writes to the board first, then mirrors it;
// - `factory board import github` keeps a status the board changed since the last import when tasks.source is board.
// A real Postgres (board_pg.ts) and the stateful fake gh (fakegh.ts), whose file says what was written to GitHub.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Board, type Message, type Task } from "../message-board/src/index.ts";
import { freshDb, type Pg, startPg } from "./board_pg.ts";
import { installFakeGh } from "./fakegh.ts";
import { gitRepo, HOOKS, type Proc, runBun, SF, sh, tmp, write } from "./support.ts";

setDefaultTimeout(120_000);

const REPO = "acme/shop";
const QUEUE = "Dev manager: needs the owner";
const ref = (n: number): string => `github:${REPO}#${n}`;
type Row = Record<string, unknown>;

let pg: Pg;
const drops: (() => Promise<void>)[] = [];
const boards: Board[] = [];

beforeAll(async () => {
  pg = await startPg();
}, 600_000);

afterAll(async () => {
  for (const b of boards) await b.end().catch(() => {});
  for (const d of drops) await d().catch(() => {});
  pg?.stop();
}, 120_000);

interface World {
  d: string;
  url: string;
  dbFile: string;
  log: string;
  env: Record<string, string>;
  board: Board;
  as(actor: string): Promise<Board>;
}

function issue(number: number, title: string, labels: string[]): Row {
  return { number, title, body: "", state: "open", labels: labels.map((name) => ({ name })), created_at: "2026-10-01T09:00:00Z",
    updated_at: "2026-10-01T09:00:00Z", html_url: `https://github.com/${REPO}/issues/${number}` };
}

async function world(cfg: Row = { tasks: { source: "board" } }, issues: Row[] = [issue(101, "Add login", ["factory:ready", "bug"]),
  issue(102, "Pay by card", ["factory:ready"])]): Promise<World> {
  const db = await freshDb(pg);
  drops.push(db.drop);
  const root = tmp("factory-mirror-");
  const d = join(root, "work");
  write(join(d, ".claude", "factory.json"), JSON.stringify(cfg));
  gitRepo(d);
  const bin = installFakeGh(root);
  const dbFile = join(root, "db.json");
  writeFileSync(dbFile, JSON.stringify({ repo: REPO, issues, comments: {} }));
  const log = join(root, "gh.log");
  writeFileSync(log, "");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("FACTORY_") && !k.startsWith("MB_") && !k.startsWith("GH_") && k !== "CLAUDE_PROJECT_DIR") env[k] = v;
  }
  Object.assign(env, { PATH: `${bin}:${process.env.PATH}`, FAKE_DB: dbFile, LOOP_LOG: log, MB_URL: db.url, GH_REPO: REPO,
    FACTORY_CONFIG_DIR: join(root, "cfg"), HOME: root });
  const board = await Board.open(db.url, { as: "system" });
  boards.push(board);
  await board.migrate();
  const as = async (actor: string): Promise<Board> => {
    const b = await Board.open(db.url, { as: actor });
    boards.push(b);
    return b;
  };
  return { d, url: db.url, dbFile, log, env, board, as };
}

function hook(w: World, name: string, args: string[], extra: Record<string, string> = {}): Proc {
  return runBun(join(HOOKS, `${name}.ts`), args, { cwd: w.d, env: { ...w.env, ...extra }, timeoutMs: 120_000 });
}

const mirror = (w: World, extra: Record<string, string> = {}): Proc => hook(w, "factory_board", ["mirror"], extra);

function gh(w: World): Row {
  return JSON.parse(readFileSync(w.dbFile, "utf8")) as Row;
}

function posted(w: World): Row[] {
  return (gh(w).posted as Row[] | undefined) ?? [];
}

/** The `gh api` calls since the log was last cleared, and the ones that wrote. */
function calls(w: World): { all: string[]; writes: string[] } {
  const all = readFileSync(w.log, "utf8").split("\n").filter((l) => l.startsWith("gh api"));
  return { all, writes: all.filter((l) => /-X (PATCH|POST|PUT|DELETE)\b|--method (PATCH|POST|PUT|DELETE)\b/.test(l)) };
}

function clearLog(w: World): void {
  writeFileSync(w.log, "");
}

function labelsOf(w: World, n: number): string[] {
  const i = (gh(w).issues as Row[]).find((x) => x.number === n) as Row;
  return ((i.labels as Row[]) ?? []).map((l) => String(l.name)).sort();
}

function err(p: Proc): { code: string; message: string; fix: string } {
  return JSON.parse(p.stderr.trim().split("\n").at(-1) as string) as { code: string; message: string; fix: string };
}

async function task(w: World, n: number): Promise<Task> {
  return (await w.board.tasks({ all: true })).find((t) => t.ref === ref(n)) as Task;
}

// --- the task mirror -----------------------------------------------------------------------------------------------------

test("a state change on the board is mirrored with one label call and one short line; a second run sends nothing", async () => {
  const w = await world();
  const t = await w.board.create({ title: "Add login", ref: ref(101) });
  await w.board.create({ title: "Pay by card", ref: ref(102) });
  const haile = await w.as("haile");
  const claim = await haile.claim(t.id);

  const r = mirror(w);
  expect(r.code, r.stderr).toBe(0);
  const out = posted(w);
  expect(out.map((p) => [p.kind, p.issue])).toEqual([["patch", 101], ["comment", 101]]);
  expect(labelsOf(w, 101)).toEqual(["agent:haile", "bug", "factory:in-progress"]);
  expect(String(out[1]?.body)).toContain("<!-- factory-mirror");
  expect(String(out[1]?.body)).toContain("haile");
  expect(String(out[1]?.body).split("\n").length).toBeLessThanOrEqual(3); // one short line under the marker
  expect(calls(w).writes).toHaveLength(2);
  expect(r.stdout).toMatch(/GitHub calls: \d+/);

  // nothing changed: nothing is sent, and a heartbeat is no change
  clearLog(w);
  await haile.heartbeat(t.id, claim?.token as string);
  const again = mirror(w);
  expect(again.code, again.stderr).toBe(0);
  expect(posted(w)).toHaveLength(2);
  expect(calls(w).writes).toEqual([]);

  // the next change: one more label call and one more line
  await haile.release(t.id, claim?.token as string, { next: "review", reason: "its pull request is open" });
  expect(mirror(w).code).toBe(0);
  expect(posted(w).slice(2).map((p) => [p.kind, p.issue])).toEqual([["patch", 101], ["comment", 101]]);
  expect(labelsOf(w, 101)).toEqual(["bug", "factory:in-review"]);
});

test("a task that ends where it was last mirrored sends nothing; a block carries its reason", async () => {
  const w = await world();
  const t = await w.board.create({ title: "Pay by card", ref: ref(102) });
  await w.board.move(t.id, { to: "blocked", reason: "needs the Stripe keys" });
  expect(mirror(w).code).toBe(0);
  expect(labelsOf(w, 102)).toEqual(["factory:blocked"]);
  expect(String(posted(w)[1]?.body)).toContain("**Blocked:** needs the Stripe keys");

  await w.board.move(t.id, { to: "ready" });
  await w.board.move(t.id, { to: "blocked", reason: "still needs the keys" });
  clearLog(w);
  const r = mirror(w);
  expect(r.code, r.stderr).toBe(0);
  expect(posted(w)).toHaveLength(2);
  expect(calls(w).writes).toEqual([]);
});

test("done on the board closes the issue; a task with no GitHub issue is left alone", async () => {
  const w = await world();
  const t = await w.board.create({ title: "Add login", ref: ref(101) });
  const local = await w.board.create({ title: "Only on the board", ref: "factory:acme/shop/0d0a" });
  await w.board.close(t.id, { outcome: "done" });
  await w.board.close(local.id, { outcome: "done" });
  expect(mirror(w).code).toBe(0);
  const i = (gh(w).issues as Row[]).find((x) => x.number === 101) as Row;
  expect(i.state).toBe("closed");
  expect(labelsOf(w, 101)).toEqual(["bug"]);
  expect(posted(w).map((p) => p.issue)).toEqual([101, 101]);
});

test("a GitHub failure leaves the mirror's place: the next run sends the change once", async () => {
  const w = await world();
  const t = await w.board.create({ title: "Add login", ref: ref(101) });
  await (await w.as("haile")).claim(t.id);

  const failed = mirror(w, { FAKE_GH_FAIL: "1" });
  expect(failed.code).toBe(1);
  const e = err(failed);
  expect(e.code).toBe("gh-failed");
  expect(e.fix).toContain("factory board mirror");
  expect(posted(w)).toEqual([]);

  const r = mirror(w);
  expect(r.code, r.stderr).toBe(0);
  expect(posted(w).map((p) => [p.kind, p.issue])).toEqual([["patch", 101], ["comment", 101]]);
  expect(mirror(w).code).toBe(0);
  expect(posted(w)).toHaveLength(2);
});

test("board.mirror false turns the mirror off: no call to GitHub", async () => {
  const w = await world({ tasks: { source: "board" }, board: { mirror: false } });
  const t = await w.board.create({ title: "Add login", ref: ref(101) });
  await (await w.as("haile")).claim(t.id);
  const r = mirror(w);
  expect(r.code, r.stderr).toBe(0);
  expect(r.stdout).toContain("board.mirror");
  expect(calls(w).all).toEqual([]);
  expect(posted(w)).toEqual([]);
});

// --- the owner queue -----------------------------------------------------------------------------------------------------

async function asks(w: World): Promise<Message[]> {
  const q = await task(w, 103);
  return q ? (await w.board.thread({ task: q.id })).filter((m) => m.kind === "ask") : [];
}

async function answersTo(w: World, ask: Message): Promise<Message[]> {
  return (await w.board.thread({ thread: ask.threadId })).filter((m) => m.kind === "answer" && m.inReplyTo === ask.id);
}

test("an owner ask is written to the board and mirrored once to the owner-queue issue", async () => {
  const w = await world();
  const r = hook(w, "factory_board", ["ask", "palette", "Which colour for the buttons?"]);
  expect(r.code, r.stderr).toBe(0);
  const issues = gh(w).issues as Row[];
  const queue = issues.find((i) => i.title === QUEUE) as Row;
  expect(queue?.number).toBe(103); // made on demand, as the dev manager's pass does

  const [ask] = await asks(w);
  expect(ask).toMatchObject({ kind: "ask", to: "owner", tag: "owner-ask", state: "open" });
  expect(ask?.body).toContain("<!-- factory-owner-ask id=palette -->");
  expect(ask?.body).toContain("Which colour for the buttons?");
  const comments = posted(w).filter((p) => p.kind === "comment");
  expect(comments).toHaveLength(1);
  expect(comments[0]?.issue).toBe(103);
  expect(String(comments[0]?.body).startsWith("<!-- factory-owner-ask id=palette -->")).toBe(true); // today's readers still find it
  expect(String(comments[0]?.body)).toContain("<!-- factory-mirror");
  expect(ask?.ref).toBe(`github:${REPO}/comments/${comments[0]?.id}`);

  // the same ask again, and the mirror again: nothing new on either side
  const twice = hook(w, "factory_board", ["ask", "palette", "Which colour for the buttons?"]);
  expect(twice.code, twice.stderr).toBe(0);
  expect(twice.stdout).toContain("already");
  expect(mirror(w).code).toBe(0);
  expect(await asks(w)).toHaveLength(1);
  expect(posted(w).filter((p) => p.kind === "comment")).toHaveLength(1);
});

test("an answer the owner gives on GitHub under an ask is read back into the board once", async () => {
  const w = await world();
  expect(hook(w, "factory_board", ["ask", "palette", "Which colour?"]).code).toBe(0);
  expect(hook(w, "factory_board", ["ask", "size", "Which size?"]).code).toBe(0);
  const db = gh(w);
  const now = new Date().toISOString();
  const comments = db.comments as Record<string, unknown[]>;
  comments["103"]?.push({ body: "<!-- factory-owner-answer id=palette -->\nBlue.", user: { login: "boss" }, created_at: now },
    { body: "Large, please.", user: { login: "boss" }, created_at: now });
  writeFileSync(w.dbFile, JSON.stringify(db));

  const r = mirror(w);
  expect(r.code, r.stderr).toBe(0);
  const [palette, size] = await asks(w);
  const a1 = await answersTo(w, palette as Message);
  const a2 = await answersTo(w, size as Message);
  expect(a1.map((m) => [m.from, m.body])).toEqual([["owner", "<!-- factory-owner-answer id=palette -->\nBlue."]]);
  expect(a2.map((m) => [m.from, m.body])).toEqual([["owner", "Large, please."]]);
  expect(a1[0]?.ref).toMatch(new RegExp(`^github:${REPO}/comments/\\d+$`));
  expect((await asks(w)).map((m) => m.state)).toEqual(["answered", "answered"]);

  // read once: a second run adds nothing, and nothing read back is posted to GitHub again
  const before = posted(w).length;
  expect(mirror(w).code).toBe(0);
  expect(await answersTo(w, palette as Message)).toHaveLength(1);
  expect(await answersTo(w, size as Message)).toHaveLength(1);
  expect(posted(w)).toHaveLength(before);
});

test("`factory owner answer` writes the answer to the board first, then mirrors it to the owner queue once", async () => {
  const w = await world();
  expect(hook(w, "factory_board", ["ask", "palette", "Which colour?"]).code).toBe(0);
  const before = posted(w).length;

  const r = hook(w, "factory_owner", ["answer", "palette", "Blue,", "please"]);
  expect(r.code, r.stderr).toBe(0);
  const [ask] = await asks(w);
  expect(ask?.state).toBe("answered");
  const [answer] = await answersTo(w, ask as Message);
  expect(answer?.from).toBe("owner");
  expect(answer?.body).toContain("<!-- factory-owner-answer id=palette -->");
  expect(answer?.body).toContain("Blue, please");
  const sent = posted(w).slice(before);
  expect(sent.map((p) => [p.kind, p.issue])).toEqual([["comment", 103]]);
  expect(String(sent[0]?.body).startsWith("<!-- factory-owner-answer id=palette -->")).toBe(true);
  expect(answer?.ref).toBe(`github:${REPO}/comments/${sent[0]?.id}`);

  // the mirror and a second answer add nothing
  expect(mirror(w).code).toBe(0);
  const again = hook(w, "factory_owner", ["answer", "palette", "Red"]);
  expect(again.code, again.stderr).toBe(0);
  expect(again.stdout).toContain("already answered");
  expect(posted(w).slice(before)).toHaveLength(1);
  expect(await answersTo(w, ask as Message)).toHaveLength(1);
});

// --- the import, once the board is the record ----------------------------------------------------------------------------

test("with tasks.source board, a move on the board survives a re-import; new issues and edited titles still come in", async () => {
  const w = await world();
  const first = hook(w, "factory_board", ["import", "github"]);
  expect(first.code, first.stderr + first.stdout).toBe(0);
  const t = await task(w, 101);
  expect(t.status).toBe("open");
  await w.board.move(t.id, { to: "blocked", reason: "waits for the owner" });

  const db = gh(w);
  const issues = db.issues as Row[];
  const i101 = issues.find((i) => i.number === 101) as Row;
  i101.title = "Add the login page";
  i101.labels = [{ name: "factory:in-review" }];
  i101.updated_at = new Date().toISOString();
  issues.push(issue(104, "Remember me", ["factory:ready"]));
  writeFileSync(w.dbFile, JSON.stringify(db));

  const r = hook(w, "factory_board", ["import", "github"]);
  expect(r.code, r.stderr + r.stdout).toBe(0);
  expect(r.stdout).toContain("the board is the record");
  expect(await task(w, 101)).toMatchObject({ status: "deferred", title: "Add the login page" });
  expect((await task(w, 104))?.status).toBe("open");
});

test("a comment the mirror wrote is not imported back as a message", async () => {
  const w = await world();
  expect(hook(w, "factory_board", ["import", "github"]).code).toBe(0);
  const t = await task(w, 101);
  await (await w.as("haile")).claim(t.id);
  expect(mirror(w).code).toBe(0);
  const r = hook(w, "factory_board", ["import", "github"]);
  expect(r.code, r.stderr + r.stdout).toBe(0);
  expect((await w.board.thread({ task: t.id })).filter((m) => m.body.includes("factory-mirror"))).toEqual([]);
  expect((await task(w, 101))?.status).toBe("in_progress");
});

test("factory help lists board mirror and board ask", () => {
  const p = sh(["bash", join(SF, "factory"), "help"], { cwd: SF });
  expect(p.code).toBe(0);
  expect(p.stdout).toMatch(/^ {2}board mirror \[--watch\]/m);
  expect(p.stdout).toMatch(/^ {2}board ask <id> <text>/m);
});
