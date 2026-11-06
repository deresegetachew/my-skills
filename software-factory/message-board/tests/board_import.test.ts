// `factory board import github [--closed] [--dry-run]` (#494, decision 0007 points 4 and 10): the repo's GitHub issues
// read into the board. GitHub is a fake `gh` on PATH that serves JSON fixtures from a file and logs every call, so what
// is checked is what the command prints, the calls it made, and what is on a real Postgres afterwards.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, type Message, type Task } from "../src/index.ts";
import { freshDatabase, type Server, startServer } from "./pg.ts";

setDefaultTimeout(120_000);

const BIN = join(import.meta.dir, "..", "bin.ts");
const REPO = "acme/widgets";
const ref = (n: number): string => `github:${REPO}#${n}`;
let server: Server | null = null;
const dbs: { drop(): Promise<void> }[] = [];

beforeAll(async () => {
  server = await startServer();
}, 600_000);

afterAll(async () => {
  for (const d of dbs) await d.drop().catch(() => {});
  server?.stop();
});

async function database(): Promise<string> {
  const d = await freshDatabase(server as Server);
  dbs.push(d);
  return d.url;
}

// A fake `gh`: `gh auth token` says whether it is signed in; `gh api <path>` answers from FAKE_GH_DB. It honours
// state, since, per_page and page, as GitHub's REST API does, and logs each call to FAKE_GH_LOG.
const FAKE_GH = String.raw`#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
type Row = Record<string, any>;
const a = process.argv.slice(2);
appendFileSync(process.env.FAKE_GH_LOG as string, "gh " + a.join(" ") + "\n");
if (a[0] === "auth" && a[1] === "token") {
  if (process.env.FAKE_GH_SIGNED_OUT === "1") { console.error("You are not logged into any GitHub hosts. To log in, run: gh auth login"); process.exit(1); }
  console.log("gho_fake"); process.exit(0);
}
if (a[0] !== "api") process.exit(2);
const db: Row = JSON.parse(readFileSync(process.env.FAKE_GH_DB as string, "utf8"));
const u = new URL(a.slice(1).find((x) => !x.startsWith("-")) as string, "http://x/");
const q = u.searchParams;
const per = Number(q.get("per_page") || "30"); const page = Number(q.get("page") || "1");
const since = q.get("since");
function out(rows: Row[] | Row): never {
  const list = Array.isArray(rows) ? rows.slice((page - 1) * per, page * per) : rows;
  process.stdout.write(JSON.stringify(list) + "\n"); process.exit(0);
}
const base = "/repos/acme/widgets/";
if (!u.pathname.startsWith(base)) { console.error("gh: Not Found (HTTP 404)"); process.exit(1); }
const p = u.pathname.slice(base.length);
if (p === "issues") {
  const st = q.get("state") || "open";
  const list = (db.issues as Row[]).filter((i) => st === "all" || (i.state || "open") === st).filter((i) => !since || i.updated_at >= since);
  if (process.env.FAKE_GH_DUP === "1" && list[0]) list.push(list[0]); // a page that shifted under a live repo
  out(list);
}
const one = /^issues\/(\d+)$/.exec(p);
if (one && process.env.FAKE_GH_FAIL_ISSUE === one[1]) { console.error("gh: Bad Gateway (HTTP 502)"); process.exit(1); }
if (one) { const i = (db.issues as Row[]).find((x) => x.number === Number(one[1])); if (!i) { console.error("gh: Not Found (HTTP 404)"); process.exit(1); } out(i); }
if (p === "issues/comments") out((db.comments as Row[]).filter((c) => !since || (c.updated_at || c.created_at) >= since));
console.error("gh: Not Found (HTTP 404)"); process.exit(1);
`;

const OLD = "2026-10-25T10:00:00Z";
interface Fixture { issues: Record<string, unknown>[]; comments: Record<string, unknown>[] }

function issue(number: number, title: string, labels: string[], body = "", extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { number, title, body, state: "open", labels: labels.map((name) => ({ name })), milestone: null, created_at: `2026-10-0${number % 9 + 1}T09:00:00Z`,
    updated_at: OLD, html_url: `https://github.com/${REPO}/issues/${number}`, user: { login: "boss" }, ...extra };
}

let nextComment = 9000;
function comment(n: number, body: string, login = "boss", at = OLD): Record<string, unknown> {
  nextComment += 1;
  return { id: nextComment, issue_url: `https://api.github.com/repos/${REPO}/issues/${n}`, body, user: { login }, created_at: at, updated_at: at };
}

function fixture(): Fixture {
  return {
    issues: [
      issue(1, "Epic: the board", ["epic", "epic:building"], "The board, step by step.\n\n- [ ] #2\n- [x] #3\n- [ ] #4\n"),
      issue(2, "Write the importer", ["factory:ready"], "Read the issues.\n\nPRD: US-40\nBudget: 200k\n\nDepends on #3", { milestone: { number: 1, title: "Phase 2" } }),
      issue(3, "The schema", ["factory:in-review"], "Tables."),
      issue(4, "Show the board", ["factory:in-progress", "agent:haile"], "Depends on #2, #3"),
      issue(5, "Take payments", ["factory:blocked"], "Stripe."),
      issue(6, "Fix the crash", ["bug"], ""),
      issue(7, "An old task", ["factory:ready"], "Done long ago.", { state: "closed", state_reason: "completed" }),
      issue(8, "A pull request", [], "", { pull_request: { url: "x" } }),
      issue(9, "Dev manager: needs the owner", [], "One comment per thing."),
    ],
    comments: [
      comment(4, "<!-- factory-claim agent=haile machine=m1 -->\nClaimed by haile."),
      comment(4, "<!-- factory-question -->\nShould the ref carry the owner?"),
      comment(4, "<!-- factory-answer -->\nYes, owner/repo#n."),
      comment(4, "Looks good to me.", "someone"),
      comment(4, "<!-- factory-manager-note thread=4 status=open -->\nWatch the size of the diff."),
      comment(5, "<!-- factory-release agent=none -->\n**Blocked:** needs the Stripe keys"),
      comment(8, "<!-- pr-watch sha=abc1234 -->\nWatching."),
      comment(9, "<!-- factory-owner-ask id=web-ui -->\nShip the web UI?"),
      comment(9, "<!-- factory-po-reply ask=web-ui -->\nProposal: yes, behind a setting."),
      comment(9, "<!-- factory-owner-answer id=web-ui -->\nYes."),
      comment(3, "<!-- factory-msg v=1 id=q-1 kind=question from=haile to=po state=submitted ref=issue#3 -->\nWhich schema?"),
      comment(3, "<!-- factory-msg v=1 id=a-1 kind=answer from=po to=haile state=completed in-reply-to=q-1 -->\nThe one in 0007."),
      comment(7, "Closed it."),
    ],
  };
}

interface World { root: string; dbFile: string; log: string; env: Record<string, string> }
interface Run { code: number; stdout: string; stderr: string }

function world(url: string | null, fx: Fixture = fixture()): World {
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "mb-import-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), FAKE_GH, { mode: 0o755 });
  const cfg = join(root, "cfg");
  if (url) {
    mkdirSync(join(cfg, "message-board"), { recursive: true });
    writeFileSync(join(cfg, "message-board", "url"), url + "\n", { mode: 0o600 });
  }
  const dbFile = join(root, "gh.json");
  writeFileSync(dbFile, JSON.stringify(fx));
  const log = join(root, "gh.log");
  writeFileSync(log, "");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("MB_") && !k.startsWith("FACTORY_") && !k.startsWith("GH_")) env[k] = v;
  Object.assign(env, { PATH: `${bin}:${process.env.PATH}`, HOME: root, FACTORY_CONFIG_DIR: cfg, FAKE_GH_DB: dbFile, FAKE_GH_LOG: log });
  return { root, dbFile, log, env };
}

function run(w: World, args: string[], extra: Record<string, string> = {}, cwd?: string): Run {
  const p = Bun.spawnSync([process.execPath, "--no-env-file", BIN, ...args], { cwd: cwd ?? w.root, env: { ...w.env, ...extra }, stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: 120_000 });
  return { code: p.exitCode ?? 124, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

const importGithub = (w: World, more: string[] = [], extra: Record<string, string> = {}): Run => run(w, ["import", "github", "--repo", REPO, ...more], extra);
const calls = (w: World): string[] => readFileSync(w.log, "utf8").split("\n").filter((l) => l.startsWith("gh api"));
const err = (r: Run): { code: string; message: string; fix: string } =>
  JSON.parse(r.stderr.trim().split("\n").at(-1) as string) as { code: string; message: string; fix: string };

async function look<T>(url: string, fn: (b: Board) => Promise<T>): Promise<T> {
  const b = await Board.open(url, { max: 1 });
  try {
    return await fn(b);
  } finally {
    await b.end();
  }
}

async function byRef(url: string): Promise<Map<string, Task>> {
  return look(url, async (b) => new Map((await b.tasks({ all: true })).map((t) => [t.ref as string, t])));
}

async function counts(url: string): Promise<{ tasks: number; messages: number; events: number; edges: number; context: number }> {
  const { SQL } = await import("bun");
  const sql = new SQL(url, { max: 1 });
  try {
    const n = async (table: string): Promise<number> => Number(((await sql.unsafe(`select count(*)::int as n from ${table}`)) as { n: number }[])[0]?.n);
    return { tasks: await n("tasks"), messages: await n("messages"), events: await n("events"), edges: await n("edges"), context: await n("context") };
  } finally {
    await sql.close();
  }
}

async function migrated(): Promise<string> {
  const url = await database();
  await look(url, (b) => b.migrate());
  return url;
}

test("help lists the import verb", () => {
  const r = run(world(null), ["help"]);
  expect(r.stdout).toContain("factory board import github [--closed] [--dry-run]");
  expect(r.stdout).toContain("GitHub wins on status unless the task is held on the board");
  expect(r.stdout).toContain("comments deleted on GitHub stay on the board");
});

test("a first import brings the open issues as tasks, with states, edges, parents, threads and markers", async () => {
  const url = await migrated();
  const w = world(url);
  const r = importGithub(w);
  expect(r.code, r.stderr).toBe(0);
  expect(r.stdout).toContain(`Imported the open issues of ${REPO}`);
  expect(r.stdout).toMatch(/tasks\s+7 new, 0 updated, 0 unchanged/);
  expect(r.stdout).toMatch(/edges\s+3 added, 0 removed/);
  expect(r.stdout).toMatch(/parents\s+3 set/);
  expect(r.stdout).toMatch(/messages\s+11 new, 0 updated, 0 unchanged/);
  expect(r.stdout).toContain("1 comment on a pull request");
  expect(r.stdout).toContain("1 comment on an issue not imported");
  expect(r.stdout).toContain("GitHub calls: 2");
  const log = calls(w);
  expect(log).toHaveLength(2);
  expect(log[0]).toContain("repos/acme/widgets/issues?state=open&per_page=100&page=1");
  expect(log[1]).toContain("repos/acme/widgets/issues/comments?per_page=100&page=1");

  const t = await byRef(url);
  expect([...t.keys()].sort()).toEqual([1, 2, 3, 4, 5, 6, 9].map(ref).sort());
  expect(t.get(ref(1))).toMatchObject({ kind: "epic", status: "open", title: "Epic: the board" });
  expect(t.get(ref(2))).toMatchObject({ kind: "task", status: "open", title: "Write the importer" });
  expect(t.get(ref(3))).toMatchObject({ status: "in_review" });
  expect(t.get(ref(4))).toMatchObject({ status: "open", holder: null });
  expect(t.get(ref(5))).toMatchObject({ status: "open" });
  expect(t.get(ref(6))).toMatchObject({ kind: "bug", status: "open" });
  expect(t.get(ref(9))).toMatchObject({ kind: "note" });
  const body2 = (t.get(ref(2)) as Task).body;
  for (const s of ["PRD: US-40", "Budget: 200k", "Milestone: Phase 2", "Depends on #3"]) expect(body2).toContain(s);

  const id = (n: number): number => (t.get(ref(n)) as Task).id;
  for (const n of [2, 3, 4]) expect((t.get(ref(n)) as Task).parentId).toBe(id(1));
  expect(t.get(ref(2))?.blockedBy).toEqual([id(3)]);
  expect(t.get(ref(4))?.blockedBy.sort()).toEqual([id(2), id(3)].sort());

  const ctx = await look(url, async (b) => ({ four: await b.contextFor(id(4)), five: await b.contextFor(id(5)) }));
  expect(ctx.four.map((c) => c.body).join("\n")).toContain("claimed by haile");
  const blocker = ctx.five.find((c) => c.kind === "blocker");
  expect(blocker?.body).toContain("needs the Stripe keys");

  const thread = (n: number): Promise<Message[]> => look(url, (b) => b.thread({ task: id(n) }));
  const four = await thread(4);
  expect(four.map((m) => [m.kind, m.tag, m.from])).toEqual([
    ["status", "claim", "haile"],
    ["question", "question", "boss"],
    ["answer", "answer", "boss"],
    ["note", "comment", "someone"],
    ["note", "manager-note", "dev-manager"],
  ]);
  expect(new Set(four.map((m) => m.threadId)).size).toBe(1);
  expect(four[1]?.state).toBe("answered");
  expect(four[2]?.inReplyTo).toBe(four[1]?.id as number);
  expect(four[0]?.ref).toMatch(/^github:acme\/widgets\/comments\/\d+$/);
  const nine = await thread(9);
  expect(nine.map((m) => [m.kind, m.tag])).toEqual([["ask", "owner-ask"], ["note", "po-reply"], ["answer", "owner-answer"]]);
  expect(nine[0]).toMatchObject({ to: "owner", state: "answered" });
  expect(nine[1]?.inReplyTo).toBe(nine[0]?.id as number);
  expect(nine[2]?.inReplyTo).toBe(nine[0]?.id as number);
  const three = await thread(3);
  expect(three.map((m) => [m.kind, m.tag, m.from, m.to])).toEqual([["question", "msg", "haile", "po"], ["answer", "msg", "po", "haile"]]);
  expect(three[0]?.state).toBe("answered");

  // The board's own rules hold on what came in: the ready queue is the open tasks that nothing open blocks.
  const ready = await look(url, (b) => b.ready());
  expect(ready.map((x) => x.ref).sort()).toEqual([ref(5), ref(6)].sort());
});

test("a second import updates what changed, adds new comments, and duplicates nothing", async () => {
  const url = await migrated();
  const fx = fixture();
  const w = world(url, fx);
  expect(importGithub(w).code).toBe(0);
  const before = await counts(url);

  const now = new Date().toISOString();
  const i2 = fx.issues.find((i) => i.number === 2) as Record<string, unknown>;
  i2.title = "Write the GitHub importer";
  i2.updated_at = now;
  const i4 = fx.issues.find((i) => i.number === 4) as Record<string, unknown>;
  i4.body = "Depends on #3";
  i4.updated_at = now;
  const i3 = fx.issues.find((i) => i.number === 3) as Record<string, unknown>;
  i3.labels = [{ name: "factory:ready" }];
  i3.updated_at = now;
  fx.comments.push(comment(2, "One more thing: keep the milestone.", "boss", now));
  writeFileSync(w.dbFile, JSON.stringify(fx));
  writeFileSync(w.log, "");

  const r = importGithub(w);
  expect(r.code, r.stderr).toBe(0);
  expect(r.stdout).toMatch(/tasks\s+0 new, 3 updated, 4 unchanged/);
  expect(r.stdout).toMatch(/edges\s+0 added, 1 removed/);
  expect(r.stdout).toMatch(/messages\s+1 new, 0 updated, 0 unchanged/);
  const log = calls(w);
  expect(log).toHaveLength(2);
  expect(log[1]).toMatch(/issues\/comments\?per_page=100&since=\d{4}-\d\d-\d\dT[\d:.]+Z&page=1/);

  const after = await counts(url);
  expect(after.tasks).toBe(before.tasks);
  expect(after.messages).toBe(before.messages + 1);
  expect(after.edges).toBe(before.edges - 1);
  expect(after.context).toBe(before.context);
  const t = await byRef(url);
  expect(t.get(ref(2))?.title).toBe("Write the GitHub importer");
  expect(t.get(ref(3))?.status).toBe("open");
  expect(t.get(ref(4))?.blockedBy).toEqual([(t.get(ref(3)) as Task).id]);

  // A third run with nothing changed on GitHub changes nothing.
  const again = importGithub(w);
  expect(again.stdout).toMatch(/tasks\s+0 new, 0 updated, 7 unchanged/);
  expect(again.stdout).toMatch(/messages\s+0 new, 0 updated/);
  const last = await counts(url);
  expect({ ...last, events: 0 }).toEqual({ ...after, events: 0 });
});

test("a task held on the board keeps its holder and status when the import runs again", async () => {
  const url = await migrated();
  const w = world(url);
  importGithub(w);
  const t6 = (await byRef(url)).get(ref(6)) as Task;
  await look(url, async () => {
    const haile = await Board.open(url, { as: "haile", max: 1 });
    await haile.claim(t6.id);
    await haile.end();
  });
  const r = importGithub(w);
  expect(r.code, r.stderr).toBe(0);
  expect(r.stdout).toContain("held on the board");
  expect((await byRef(url)).get(ref(6))).toMatchObject({ status: "in_progress", holder: "haile" });
});

test("--dry-run says what it would bring, with counts, and writes nothing", async () => {
  const url = await migrated();
  const w = world(url);
  const before = await counts(url);
  const r = importGithub(w, ["--dry-run"]);
  expect(r.code, r.stderr).toBe(0);
  expect(r.stdout).toContain("Dry run: nothing was written");
  expect(r.stdout).toMatch(/tasks\s+7 new, 0 updated, 0 unchanged/);
  expect(r.stdout).toMatch(/messages\s+11 new/);
  expect(r.stdout).toContain("skipped");
  expect(r.stdout).toContain("GitHub calls: 2");
  expect(await counts(url)).toEqual(before);
  // and a real import afterwards brings the same
  expect(importGithub(w).stdout).toMatch(/tasks\s+7 new/);
});

test("--closed also brings the closed issues, as done, with their comments", async () => {
  const url = await migrated();
  const w = world(url);
  const r = importGithub(w, ["--closed"]);
  expect(r.code, r.stderr).toBe(0);
  expect(r.stdout).toContain(`Imported the open and closed issues of ${REPO}`);
  expect(r.stdout).toMatch(/tasks\s+8 new/);
  expect(calls(w)[0]).toContain("issues?state=all&per_page=100&page=1");
  const t7 = (await byRef(url)).get(ref(7)) as Task;
  expect(t7).toMatchObject({ status: "done", outcome: "done", title: "An old task" });
  const thread = await look(url, (b) => b.thread({ task: t7.id }));
  expect(thread.map((m) => m.body)).toEqual(["Closed it."]);
});

test("an issue closed on GitHub since the last import is closed on the board", async () => {
  const url = await migrated();
  const fx = fixture();
  const w = world(url, fx);
  importGithub(w);
  const i6 = fx.issues.find((i) => i.number === 6) as Record<string, unknown>;
  Object.assign(i6, { state: "closed", state_reason: "not_planned", updated_at: new Date().toISOString() });
  writeFileSync(w.dbFile, JSON.stringify(fx));
  writeFileSync(w.log, "");
  const r = importGithub(w);
  expect(r.code, r.stderr).toBe(0);
  expect(calls(w).some((c) => c.includes("repos/acme/widgets/issues/6"))).toBe(true);
  expect(r.stdout).toContain("GitHub calls: 3");
  expect((await byRef(url)).get(ref(6))).toMatchObject({ status: "done", outcome: "wont_do" });
});

test("comments come in pages of 100, and every page is a call", async () => {
  const url = await migrated();
  const fx = fixture();
  for (let i = 0; i < 120; i++) fx.comments.push(comment(6, `ping ${i}`));
  const w = world(url, fx);
  const r = importGithub(w);
  expect(r.code, r.stderr).toBe(0);
  expect(r.stdout).toContain("GitHub calls: 3");
  expect(r.stdout).toMatch(/messages\s+131 new/);
});

test("the repo comes from the git remote when --repo isn't given", async () => {
  const url = await migrated();
  const w = world(url);
  const repo = join(w.root, "proj");
  mkdirSync(repo);
  for (const args of [["init", "-q"], ["remote", "add", "origin", "git@github.com:acme/widgets.git"]]) {
    Bun.spawnSync(["git", ...args], { cwd: repo });
  }
  const r = run(w, ["import", "github", "--dry-run"], {}, repo);
  expect(r.code, r.stderr).toBe(0);
  expect(r.stdout).toContain(REPO);
});

test("refusals: no board, a board that doesn't answer, gh signed out, an unknown source; none calls GitHub", async () => {
  const none = world(null);
  const a = importGithub(none);
  expect(a.code).toBe(1);
  expect(err(a).code).toBe("no-board");
  expect(err(a).fix).toContain("factory board up");
  expect(calls(none)).toEqual([]);

  const dead = world("postgres://factory:secret-pw@127.0.0.1:1/board");
  const b = importGithub(dead);
  expect(b.code).toBe(1);
  expect(err(b).code).toBe("no-answer");
  expect(err(b).fix).toContain("factory board up");
  expect(b.stdout + b.stderr).not.toContain("secret-pw");
  expect(calls(dead)).toEqual([]);

  const url = await migrated();
  const out = world(url);
  const c = importGithub(out, [], { FAKE_GH_SIGNED_OUT: "1" });
  expect(c.code).toBe(1);
  expect(err(c).code).toBe("gh-signed-out");
  expect(err(c).fix).toContain("gh auth login");
  expect(calls(out)).toEqual([]);
  expect((await counts(url)).tasks).toBe(0);

  const d = run(out, ["import", "gitlab"]);
  expect(d.code).toBe(1);
  expect(err(d).code).toBe("bad-input");
  expect(err(d).fix).toContain("factory board import github");

  const unmigrated = world(await database());
  const e = importGithub(unmigrated);
  expect(e.code).toBe(1);
  expect(err(e).code).toBe("schema-old");
  expect(err(e).fix).toContain("factory board migrate");
});

test("Board.import keeps the board's rules: a loop is left out, a bad batch is refused, and nothing is half done", async () => {
  const url = await migrated();
  const b = await Board.open(url, { as: "importer", max: 1 });
  try {
    const r = await b.import({
      source: "test:x",
      tasks: [
        { ref: "x#1", title: "One", status: "open", blockedBy: ["x#2"] },
        { ref: "x#2", title: "Two", status: "open", blockedBy: ["x#1"] },
        { ref: "x#3", title: "Three", status: "open", parentRef: "x#3" },
      ],
      messages: [{ ref: "x/m1", task: "x#1", kind: "note", tag: "comment", from: "someone", body: "hello" },
        { ref: "x/m2", task: "x#9", kind: "note", from: "someone", body: "on nothing" }],
    });
    expect(r.edges.added).toBe(1);
    expect(r.skipped.map((s) => s.why).join("\n")).toContain("would make a loop");
    expect(r.skipped.map((s) => s.ref)).toContain("x/m2");
    const one = (await b.tasks({ all: true })).find((t) => t.ref === "x#1") as Task;
    expect((await b.thread({ task: one.id }))[0]).toMatchObject({ from: "someone", tag: "comment", ref: "x/m1" });

    const before = await counts(url);
    let code = "";
    try {
      await b.import({ source: "test:x", tasks: [{ ref: "x#4", title: "Four", status: "open" }, { ref: "x#4", title: "Again", status: "open" }], messages: [] });
    } catch (e) {
      code = (e as { code: string }).code;
    }
    expect(code).toBe("bad-input");
    expect(await counts(url)).toEqual(before);

    const posted = await b.post({ task: one.id, kind: "note", tag: "hand-written", body: "a tag on post" });
    expect(posted).toMatchObject({ tag: "hand-written", ref: null });
  } finally {
    await b.end();
  }
});

test("an edited reply whose question is on an issue with no new comments keeps its link", async () => {
  const url = await migrated();
  const fx = fixture();
  fx.comments.push(comment(2, "<!-- factory-msg v=1 id=q-2 kind=question from=haile to=po state=submitted ref=issue#2 -->\nWhich page size?"));
  const answer = comment(3, "<!-- factory-msg v=1 id=a-2 kind=answer from=po to=haile state=completed in-reply-to=q-2 -->\n100.");
  fx.comments.push(answer);
  const w = world(url, fx);
  expect(importGithub(w).code).toBe(0);
  const id = async (n: number): Promise<number> => ((await byRef(url)).get(ref(n)) as Task).id;
  const q = (await look(url, async (b) => b.thread({ task: await id(2) }))).find((m) => m.body.includes("Which page size?")) as Message;
  Object.assign(answer, { body: String(answer.body) + " Edited.", updated_at: new Date().toISOString() });
  writeFileSync(w.dbFile, JSON.stringify(fx));
  const r = importGithub(w);
  expect(r.code, r.stderr).toBe(0);
  expect(r.stdout).toMatch(/messages\s+0 new, 1 updated/);
  const a = (await look(url, async (b) => b.thread({ task: await id(3) }))).find((m) => m.body.includes("Edited.")) as Message;
  expect(a.inReplyTo).toBe(q.id);
});

test("an issue GitHub answers 404 for is gone; any other failure stops the run and writes nothing", async () => {
  const url = await migrated();
  const fx = fixture();
  const w = world(url, fx);
  importGithub(w);
  const i6 = fx.issues.find((i) => i.number === 6) as Record<string, unknown>;
  i6.state = "closed";
  writeFileSync(w.dbFile, JSON.stringify(fx));
  const before = await counts(url);
  const bad = importGithub(w, [], { FAKE_GH_FAIL_ISSUE: "6" });
  expect(bad.code).toBe(1);
  expect(err(bad).code).toBe("gh-failed");
  expect(err(bad).fix).toContain("Nothing was written");
  expect(await counts(url)).toEqual(before);
  fx.issues = fx.issues.filter((i) => i.number !== 6);
  writeFileSync(w.dbFile, JSON.stringify(fx));
  const gone = importGithub(w);
  expect(gone.code, gone.stderr).toBe(0);
  expect(gone.stdout).toContain("1 task whose issue GitHub no longer has");
});

test("repo names: parts of only dots are refused; case doesn't make a second set of tasks", async () => {
  const url = await migrated();
  const w = world(url);
  for (const bad of ["../widgets", "acme/..", "./x"]) {
    const r = run(w, ["import", "github", "--repo", bad]);
    expect(r.code).toBe(1);
    expect(err(r).code).toBe("bad-input");
  }
  expect(calls(w)).toEqual([]);
  expect(importGithub(w).stdout).toMatch(/tasks\s+7 new/);
  const r = run(w, ["import", "github", "--repo", "Acme/Widgets"]);
  expect(r.code, r.stderr).toBe(0);
  expect(r.stdout).toMatch(/tasks\s+0 new, 0 updated, 7 unchanged/);
  expect((await counts(url)).tasks).toBe(7);
});

test("an issue listed twice while paging is taken once", async () => {
  const url = await migrated();
  const w = world(url);
  const r = importGithub(w, [], { FAKE_GH_DUP: "1" });
  expect(r.code, r.stderr).toBe(0);
  expect(r.stdout).toMatch(/tasks\s+7 new/);
});

// --- the board as the record (#502, decision 0007 point 5) ----------------------------------------------------------------

test("with --board-is-record, a status the board changed since the last import is kept; one it didn't change follows GitHub", async () => {
  const url = await migrated();
  const fx = fixture();
  const w = world(url, fx);
  expect(importGithub(w).code).toBe(0);
  const t6 = (await byRef(url)).get(ref(6)) as Task;
  await look(url, (b) => b.move(t6.id, { to: "blocked", reason: "waits for the owner" }));

  const now = new Date().toISOString();
  const i6 = fx.issues.find((i) => i.number === 6) as Record<string, unknown>;
  Object.assign(i6, { title: "Fix the crash on start", labels: [{ name: "factory:in-review" }], updated_at: now });
  const i2 = fx.issues.find((i) => i.number === 2) as Record<string, unknown>;
  Object.assign(i2, { labels: [{ name: "factory:in-review" }], updated_at: now });
  writeFileSync(w.dbFile, JSON.stringify(fx));

  const r = importGithub(w, ["--board-is-record"]);
  expect(r.code, r.stderr).toBe(0);
  expect(r.stdout).toContain("the board is the record");
  const t = await byRef(url);
  expect(t.get(ref(6))).toMatchObject({ status: "deferred", title: "Fix the crash on start" });
  expect(t.get(ref(2))?.status).toBe("in_review");

  // without the flag GitHub wins on status, as before
  const again = importGithub(w);
  expect(again.code, again.stderr).toBe(0);
  expect((await byRef(url)).get(ref(6))?.status).toBe("in_review");
});

test("a comment the board's mirror wrote is not imported again, and a reply to it joins the board's own message", async () => {
  const url = await migrated();
  const fx = fixture();
  const w = world(url, fx);
  expect(importGithub(w).code).toBe(0);
  const queue = (await byRef(url)).get(ref(9)) as Task;
  const mirrored = comment(9, "<!-- factory-owner-ask id=colour -->\nWhich colour?\n\n<!-- factory-mirror v=1 message=1 -->", "boss", new Date().toISOString());
  const ask = await look(url, async (b) => {
    const m = await b.post({ task: queue.id, kind: "ask", tag: "owner-ask", to: "owner", body: "<!-- factory-owner-ask id=colour -->\nWhich colour?" });
    return b.linkMessage(m.id, `github:${REPO}/comments/${mirrored.id}`);
  });
  fx.comments.push(mirrored, comment(9, "<!-- factory-owner-answer id=colour -->\nBlue.", "boss", new Date(Date.now() + 1000).toISOString()));
  writeFileSync(w.dbFile, JSON.stringify(fx));

  const r = importGithub(w);
  expect(r.code, r.stderr).toBe(0);
  expect(r.stdout).toMatch(/messages\s+1 new/);
  expect(r.stdout).toContain("1 comment the board mirrored");
  const thread = await look(url, (b) => b.thread({ thread: ask.threadId }));
  expect(thread.map((m) => [m.kind, m.from, m.inReplyTo])).toEqual([["ask", "system", null], ["answer", "boss", ask.id]]);
  expect(thread[0]?.state).toBe("answered");
  expect(thread[0]?.body).not.toContain("factory-mirror");
});
