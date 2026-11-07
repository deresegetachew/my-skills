// The message board as the record, mirrored one way to GitHub (#502, decision 0007 points 5 and 9):
// - `factory board mirror` carries a task's state change on the board to its issue: one label call and one short line
//   per change, nothing for a state that didn't change, nothing on a second run; a GitHub failure leaves its place on
//   the board so the next run sends the change once; `board.mirror` false turns it off;
// - `factory board ask` writes an owner ask to the board and mirrors it once to the owner-queue issue; an answer the
//   owner gives there is read back once; `factory owner answer` writes to the board first, then mirrors it;
// - `factory board import github` keeps a status the board changed since the last import when tasks.source is board.
// A real Postgres (board_pg.ts) and the stateful fake gh (fakegh.ts), whose file says what was written to GitHub.
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../hooks/factory_config.ts";
import { Board, type Message, type Task } from "../message-board/src/index.ts";
import { freshDb, type Pg, startPg } from "./board_pg.ts";
import { installFakeGh } from "./fakegh.ts";
import { gitRepo, HOOKS, type Proc, runBun, SF, sh, tmp, write, writeExe } from "./support.ts";

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

// Each test's connections end with it: CI runs many files at once against one Postgres (max_connections 100).
afterEach(async () => {
  for (const b of boards.splice(0)) await b.end().catch(() => {});
  for (const d of drops.splice(0)) await d().catch(() => {});
}, 120_000);

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
  const board = await Board.open(db.url, { as: "system", max: 1 });
  boards.push(board);
  await board.migrate();
  const as = async (actor: string): Promise<Board> => {
    const b = await Board.open(db.url, { as: actor, max: 1 });
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

/** The id the fake gave a posted comment: the one its listing gives it (1000 x issue + its place). */
function idOf(w: World, c: Row | undefined): number {
  const list = ((gh(w).comments as Record<string, unknown[]>)[String(c?.issue)] ?? []);
  return 1000 * Number(c?.issue) + list.findIndex((b) => b === c?.body) + 1;
}

/** Run TypeScript `code` in the project, as a hook would run. */
function runCodeIn(w: World, code: string, extra: Record<string, string> = {}): Proc {
  return sh([process.execPath, "--no-env-file", "-e", code], { cwd: w.d, env: { ...w.env, ...extra }, timeoutMs: 120_000 });
}

function err(p: Proc): { code: string; message: string; fix: string } {
  return JSON.parse(p.stderr.trim().split("\n").at(-1) as string) as { code: string; message: string; fix: string };
}

async function task(w: World, n: number): Promise<Task> {
  return (await w.board.tasks({ all: true })).find((t) => t.ref === ref(n)) as Task;
}

// --- the task mirror -----------------------------------------------------------------------------------------------------

test("a state change on the board is mirrored with one read of the issue, one label call and one short line; a second run sends nothing", async () => {
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

test("--watch sends a change soon after it lands on the board, without being run again", async () => {
  const w = await world();
  const t = await w.board.create({ title: "Add login", ref: ref(101) });
  const p = Bun.spawn([process.execPath, "--no-env-file", join(HOOKS, "factory_board.ts"), "mirror", "--watch", "--every", "60"],
    { cwd: w.d, env: w.env, stdout: "pipe", stderr: "pipe" });
  try {
    await Bun.sleep(1500); // it is listening
    await (await w.as("haile")).claim(t.id);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && posted(w).length < 2) await Bun.sleep(200);
    expect(posted(w).map((x) => [x.kind, x.issue])).toEqual([["patch", 101], ["comment", 101]]);
    await Bun.sleep(1500); // its own writes don't make it send again
    expect(posted(w)).toHaveLength(2);
  } finally {
    p.kill();
    await p.exited;
  }
});

test("--max-seconds stops a pass whose gh hangs, with the gh it started; a pass within the limit runs as before", async () => {
  const w = await world();
  const t = await w.board.create({ title: "Add login", ref: ref(101) });
  await (await w.as("haile")).claim(t.id);

  // a gh that never answers, first on the PATH; it writes its pid so the test can see it was stopped too
  const hung = tmp("factory-hung-gh-");
  const pids = join(hung, "pids");
  writeExe(join(hung, "gh"), `#!/bin/bash\necho $$ >> "${pids}"\nexec sleep 600\n`);
  const started = Date.now();
  const r = hook(w, "factory_board", ["mirror", "--max-seconds", "3"], { PATH: `${hung}:${w.env.PATH}` });
  expect(Date.now() - started).toBeLessThan(30_000);
  expect(r.code).toBe(1);
  const e = err(r);
  expect(e.code).toBe("mirror_timeout");
  expect(e.message).toContain("3 seconds");
  expect(e.fix).toContain("factory board mirror");
  expect(posted(w)).toEqual([]);
  for (const pid of readFileSync(pids, "utf8").trim().split("\n")) expect(sh(["kill", "-0", pid]).code).not.toBe(0);

  // the next pass, with GitHub answering, sends the change once
  const ok = hook(w, "factory_board", ["mirror", "--max-seconds", "60"]);
  expect(ok.code, ok.stderr).toBe(0);
  expect(ok.stdout).toContain("Mirrored the message board");
  expect(posted(w).map((p) => [p.kind, p.issue])).toEqual([["patch", 101], ["comment", 101]]);

  const both = hook(w, "factory_board", ["mirror", "--watch", "--max-seconds", "60"]);
  expect(both.code).toBe(1);
  expect(err(both).code).toBe("bad_args");
});

test("the first pass sends only to issues whose labels differ from the board; the rest are taken as they are", async () => {
  const w = await world({ tasks: { source: "board" } }, [issue(101, "Add login", ["factory:ready"]), issue(102, "Pay by card", ["factory:ready"]),
    issue(105, "Sign out", ["factory:in-review"])]);
  await w.board.create({ title: "Add login", ref: ref(101) }); // ready on both
  const t102 = await w.board.create({ title: "Pay by card", ref: ref(102) });
  await w.board.move(t102.id, { to: "blocked", reason: "needs the Stripe keys" }); // differs
  const t105 = await w.board.create({ title: "Sign out", ref: ref(105) });
  await w.board.move(t105.id, { to: "in_review" }); // the same on both

  const r = mirror(w);
  expect(r.code, r.stderr).toBe(0);
  expect(posted(w).map((p) => [p.kind, p.issue])).toEqual([["patch", 102], ["comment", 102]]);
  expect(String(posted(w)[1]?.body)).toContain("**Blocked:** needs the Stripe keys");
  clearLog(w);
  expect(mirror(w).code).toBe(0);
  expect(calls(w).writes).toEqual([]);
});

test("two passes started at the same moment send an ask once", async () => {
  const w = await world({ tasks: { source: "board" } }, [issue(103, QUEUE, [])]);
  const q = await w.board.create({ title: QUEUE, kind: "note", ref: ref(103) });
  await w.board.post({ task: q.id, kind: "ask", tag: "owner-ask", to: "owner", body: "<!-- factory-owner-ask id=palette -->\nWhich colour?" });
  const start = (): ReturnType<typeof Bun.spawn> => Bun.spawn([process.execPath, "--no-env-file", join(HOOKS, "factory_board.ts"), "mirror"],
    { cwd: w.d, env: w.env, stdout: "pipe", stderr: "pipe" });
  const [a, b] = [start(), start()];
  const codes = await Promise.all([a.exited, b.exited]);
  expect(codes).toEqual([0, 0]);
  expect(posted(w).filter((p) => p.kind === "comment")).toHaveLength(1);
  expect((await asks(w))[0]?.ref).toMatch(new RegExp(`^github:${REPO}/comments/\\d+$`));
});

test("a pass that dies after posting a comment and before linking it: the next pass links that comment and posts none", async () => {
  const w = await world({ tasks: { source: "board" } }, [issue(103, QUEUE, []), issue(101, "Add login", ["factory:ready"])]);
  const q = await w.board.create({ title: QUEUE, kind: "note", ref: ref(103) });
  const other = await w.board.create({ title: "Add login", ref: ref(101) });
  const ask = await w.board.post({ task: q.id, kind: "ask", tag: "owner-ask", to: "owner", body: "<!-- factory-owner-ask id=palette -->\nWhich colour?" });
  // the first comment on #103 will be 103001: a message already holding that ref makes the link fail once, after the post
  const blocker = await w.board.post({ task: other.id, kind: "note", body: "in the way" });
  await w.board.linkMessage(blocker.id, `github:${REPO}/comments/103001`);
  const failed = mirror(w);
  expect(failed.code).toBe(1);
  expect(posted(w).filter((p) => p.kind === "comment")).toHaveLength(1);
  const { SQL } = await import("bun");
  const sql = new SQL(w.url, { max: 1 });
  await sql`UPDATE messages SET external_ref = NULL WHERE id = ${blocker.id}`;
  await sql.close();

  const r = mirror(w);
  expect(r.code, r.stderr).toBe(0);
  expect(posted(w).filter((p) => p.kind === "comment")).toHaveLength(1);
  expect((await w.board.message(ask.id)).ref).toBe(`github:${REPO}/comments/103001`);
});

test("an ask whose mirror fails after it is on the board is never posted twice: only a board that can't take it falls back", async () => {
  const w = await world({ tasks: { source: "board" } }, [issue(101, "Add login", ["factory:ready"]), issue(103, QUEUE, [])]);
  const code = (extra: Record<string, string>): Proc => runCodeIn(w, `
    const { askOnBoard } = await import(${JSON.stringify(join(HOOKS, "factory_orchestrator.ts"))});
    console.log("result=" + askOnBoard("palette", "<!-- factory-owner-ask id=palette -->\\nWhich colour?"));`, extra);
  const down = code({ MB_URL: "postgres://nobody:pw@127.0.0.1:1/none" });
  expect(down.stdout, down.stderr).toContain("result=unavailable");

  const writesFail = code({ FAKE_GH_FAIL_WRITES: "1" });
  expect(writesFail.stdout, writesFail.stderr).toContain("result=board");
  expect(posted(w).filter((p) => p.kind === "comment")).toEqual([]); // the mirror failed; it waits on the board
  expect(await asks(w)).toHaveLength(1);
  expect(mirror(w).code).toBe(0);
  expect(posted(w).filter((p) => p.kind === "comment")).toHaveLength(1);
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
  expect(ask?.ref).toBe(`github:${REPO}/comments/${idOf(w, comments[0])}`);

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
  expect(answer?.ref).toBe(`github:${REPO}/comments/${idOf(w, sent[0])}`);

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

// --- a pass killed between a task's line and its place (#513) -------------------------------------------------------------

test("a pass killed after posting a task's line and before saving its place: the next pass finds that line and doesn't post it again", async () => {
  const w = await world();
  const t = await w.board.create({ title: "Add login", ref: ref(101) });
  expect(mirror(w).code).toBe(0); // the first pass takes the board as it is
  const haile = await w.as("haile");
  await haile.claim(t.id);
  // a gh in front of the fake one that kills its caller right after the first comment it posts
  const fake = (w.env.PATH as string).split(":")[0] as string;
  const killer = join(w.d, "..", "killer");
  const once = join(w.d, "..", "die-once");
  writeFileSync(once, "");
  writeExe(join(killer, "gh"), `#!/usr/bin/env bash\n"${fake}/gh" "$@"\nrc=$?\n` +
    `if [ -f "$DIE_ONCE" ] && [[ " $* " == *" POST "* ]] && [[ "$*" == */comments* ]]; then rm -f "$DIE_ONCE"; kill -9 $PPID; fi\nexit $rc\n`);
  const killed = mirror(w, { PATH: `${killer}:${w.env.PATH}`, DIE_ONCE: once });
  expect(killed.code).not.toBe(0);
  const lines = (): Row[] => posted(w).filter((p) => p.kind === "comment" && p.issue === 101);
  expect(lines()).toHaveLength(1);

  const again = mirror(w);
  expect(again.code, again.stderr).toBe(0);
  expect(lines()).toHaveLength(1);
  // the next change still sends its own line
  await w.board.move(t.id, { to: "ready", reason: "handed back" });
  expect(mirror(w).code).toBe(0);
  expect(lines()).toHaveLength(2);
  expect(String(lines()[1]?.body)).toContain("Ready (on the board)");
});

test("a line recorded but not posted, then a state back where the last posted line left it: that line isn't posted twice (#515)", async () => {
  const w = await world();
  const t = await w.board.create({ title: "Add login", ref: ref(101) });
  expect(mirror(w).code).toBe(0); // the first pass takes the board as it is
  const haile = await w.as("haile");
  const fake = (w.env.PATH as string).split(":")[0] as string;
  const killer = join(w.d, "..", "killer");
  // DIE_AFTER: the pass dies right after its line is posted; DIE_BEFORE: right before (its line recorded, not posted)
  writeExe(join(killer, "gh"), `#!/usr/bin/env bash\nif [ -n "\$DIE_BEFORE" ] && [[ " \$* " == *" POST "* ]] && [[ "\$*" == */comments* ]]; then kill -9 \$PPID; exit 1; fi\n` +
    `"${fake}/gh" "\$@"\nrc=\$?\nif [ -n "\$DIE_AFTER" ] && [[ " \$* " == *" POST "* ]] && [[ "\$*" == */comments* ]]; then kill -9 \$PPID; fi\nexit \$rc\n`);
  const PATH = `${killer}:${w.env.PATH}`;
  const lines = (): string[] => posted(w).filter((p) => p.kind === "comment" && p.issue === 101).map((p) => String(p.body));

  let claim = await haile.claim(t.id);
  expect(mirror(w, { PATH, DIE_AFTER: "1" }).code).not.toBe(0); // "haile is working on this" is posted, not saved
  expect(lines()).toHaveLength(1);
  await haile.release(t.id, claim?.token as string, { next: "review", reason: "ready for review" });
  expect(mirror(w, { PATH, DIE_BEFORE: "1" }).code).not.toBe(0); // "In review" is recorded, never posted
  expect(lines()).toHaveLength(1);
  await w.board.move(t.id, { to: "ready", reason: "not yet" });
  claim = await haile.claim(t.id); // back to what the last posted line says
  const r = mirror(w);
  expect(r.code, r.stderr).toBe(0);
  expect(lines()).toHaveLength(1);
  expect(lines()[0]).toContain("**haile** is working on this");
  expect(labelsOf(w, 101)).toEqual(["agent:haile", "bug", "factory:in-progress"]);
  // and a later change sends its own line, once
  await haile.release(t.id, claim?.token as string, { next: "ready", reason: "done for today" });
  expect(mirror(w).code).toBe(0);
  expect(mirror(w).code).toBe(0);
  expect(lines()).toHaveLength(2);
  expect(lines()[1]).toContain("Ready (on the board)");
});

test("an open issue without a factory label is imported as a note, and the mirror never labels it (#515)", async () => {
  const w = await world({ tasks: { source: "board" } }, [issue(101, "Add login", ["factory:ready"]), issue(110, "Channel", [])]);
  const imp = hook(w, "factory_board", ["import", "github"]);
  expect(imp.code, imp.stderr + imp.stdout).toBe(0);
  expect(await task(w, 110)).toMatchObject({ kind: "note", status: "open" });
  expect((await w.board.ready()).map((x) => x.ref)).toEqual([ref(101)]);
  const r = mirror(w);
  expect(r.code, r.stderr).toBe(0);
  expect(labelsOf(w, 110)).toEqual([]);
  // a move of the note on the board sends nothing either
  await w.board.move((await task(w, 110)).id, { to: "in_review" });
  expect(mirror(w).code).toBe(0);
  expect(labelsOf(w, 110)).toEqual([]);
  expect(posted(w).filter((p) => p.issue === 110)).toEqual([]);
});

// --- the owner queue read from the board (#513) --------------------------------------------------------------------------

/** An owner-queue task on the board with an ask the owner answered (palette, with options) and one still open (deploy). */
async function boardQueue(w: World): Promise<void> {
  const q = await w.board.create({ title: QUEUE, kind: "note", ref: ref(103) });
  const fasil = await w.as("fasil");
  const ask = await fasil.post({ task: q.id, kind: "ask", tag: "owner-ask", to: "owner", body: "<!-- factory-owner-ask id=palette -->\nWhich colour?\n- Blue\n- Green" });
  const owner = await w.as("owner");
  await owner.post({ task: q.id, kind: "answer", tag: "owner-answer", to: "fasil", inReplyTo: ask.id, body: "<!-- factory-owner-answer id=palette -->\n\nBlue" });
  await fasil.post({ task: q.id, kind: "ask", tag: "owner-ask", to: "owner", body: "<!-- factory-owner-ask id=deploy -->\nDeploy on Friday?" });
}

/** Run `fn` with this process's environment set to the world's (the web UI's reads take the server's environment). */
async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const before = { ...process.env };
  for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k];
    Object.assign(process.env, before);
  }
}

const UNREACHABLE = "postgres://nobody:pw@127.0.0.1:1/none";

test("factory board queue lists the owner queue from the board, oldest first, without asking GitHub", async () => {
  const w = await world({ tasks: { source: "board" } }, [issue(103, QUEUE, [])]);
  await boardQueue(w);
  const p = hook(w, "factory_board", ["queue", "--json"]);
  expect(p.code, p.stderr).toBe(0);
  const q = JSON.parse(p.stdout) as { issue: number; url: string; comments: { body: string; user: { login: string } }[] };
  expect(q.issue).toBe(103);
  expect(q.url).toBe(`https://github.com/${REPO}/issues/103`);
  expect(q.comments.map((c) => [c.user.login, c.body.split("\n")[0]])).toEqual([["fasil", "<!-- factory-owner-ask id=palette -->"],
    ["owner", "<!-- factory-owner-answer id=palette -->"], ["fasil", "<!-- factory-owner-ask id=deploy -->"]]);
  expect(calls(w).all).toEqual([]);
  const off = hook(w, "factory_board", ["queue", "--json"], { MB_URL: UNREACHABLE });
  expect(off.code).toBe(3); // the board can't be had: a caller falls back to GitHub
});

test("the web UI's Inbox reads the owner queue from the board when it is on, and from GitHub when it can't be reached", async () => {
  const w = await world({ tasks: { source: "board" } }, [issue(103, QUEUE, [])]);
  await boardQueue(w);
  const db = gh(w);
  (db.comments as Record<string, unknown[]>)["103"] = ["<!-- factory-owner-ask id=old -->\nFrom GitHub"];
  writeFileSync(w.dbFile, JSON.stringify(db));
  const { readQueue } = await import("../hooks/factory_ui_chat.ts");
  const project = { id: "shop", name: "shop", path: w.d, current: false, problem: null, config: { tasks: { source: "board" } } as unknown as Config };
  const q = await withEnv(w.env, () => readQueue(project));
  expect(q.problem).toBeNull();
  expect(q.issue).toBe(103);
  expect(q.asks.map((a) => [a.id, a.state, a.answer, a.options])).toEqual([["palette", "answered", "Blue", ["Blue", "Green"]], ["deploy", "open", null, []]]);
  expect(calls(w).all).toEqual([]);

  const back = await withEnv({ ...w.env, MB_URL: UNREACHABLE }, () => readQueue(project));
  expect(back.asks.map((a) => [a.id, a.state])).toEqual([["old", "open"]]);
});

test("factory prd --stage reads the owner's approvals from the board when it is on, and from GitHub when it can't be reached", async () => {
  const w = await world({ tasks: { source: "board" } }, [issue(103, QUEUE, [])]);
  write(join(w.d, "docs", "PRD.md"), "# PRD\n\n- US-1: Sign in\n");
  const q = await w.board.create({ title: QUEUE, kind: "note", ref: ref(103) });
  const pia = await w.as("pia");
  const ask = await pia.post({ task: q.id, kind: "ask", tag: "owner-ask", to: "owner", body: "<!-- factory-owner-ask id=stage-vision -->\nPlease approve the vision." });
  await (await w.as("owner")).post({ task: q.id, kind: "answer", tag: "owner-answer", to: "pia", inReplyTo: ask.id,
    body: "<!-- factory-owner-answer id=stage-vision -->\n\nyes" });
  const stages = (extra: Record<string, string> = {}): Row[] => {
    const p = hook(w, "factory_prd", ["--stage", "--json"], extra);
    expect(p.code, p.stderr).toBe(0);
    return JSON.parse(p.stdout) as Row[];
  };
  expect(stages()[0]).toMatchObject({ stage: "vision", done: true, approval: "approved" });
  expect(calls(w).all.filter((l) => l.includes("issues/103/comments"))).toEqual([]);

  // GitHub has the ask with no answer yet: with the board out of reach, that is what counts
  const db = gh(w);
  (db.comments as Record<string, unknown[]>)["103"] = ["<!-- factory-owner-ask id=stage-vision -->\nPlease approve the vision."];
  writeFileSync(w.dbFile, JSON.stringify(db));
  expect(stages({ MB_URL: UNREACHABLE })[0]).toMatchObject({ stage: "vision", approval: "asked" });
  expect(calls(w).all.filter((l) => l.includes("issues/103/comments")).length).toBeGreaterThan(0);
});

test("factory help lists board mirror and board ask", () => {
  const p = sh(["bash", join(SF, "factory"), "help"], { cwd: SF });
  expect(p.code).toBe(0);
  expect(p.stdout).toMatch(/^ {2}board mirror \[--watch\]/m);
  expect(p.stdout).toContain("--max-seconds");
  expect(p.stdout).toMatch(/^ {2}board ask <id> <text>/m);
  expect(p.stdout).toMatch(/^ {2}board queue \[--json\]/m);
  expect(p.stdout).toMatch(/^ {2}board sweep \[--quiet-minutes N\] \[--max-seconds N\]/m);
});
