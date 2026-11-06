// The board's rules against a real Postgres (decision 0007 point 10, #489): migrations, ready and blocked from typed
// edges, the atomic claim and its token, release with what happens next, the sweep, versioned edits, events with
// NOTIFY, context for linked tasks, prime, onMe and delegated. Each test file gets its own database.
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { SQL } from "bun";
import { Board, BoardError, type BoardEvent } from "../src/index.ts";
import { freshDatabase, type Server, startServer } from "./pg.ts";

setDefaultTimeout(60_000);

let server: Server | null = null;
let db: { url: string; drop(): Promise<void> } | null = null;
const open: Board[] = [];

beforeAll(async () => {
  server = await startServer();
  db = await freshDatabase(server);
  const b = await Board.open(db.url);
  await b.migrate();
  await b.end();
}, 600_000);

// Each test closes its boards, so the connections don't pile up.
afterEach(async () => {
  for (const b of open.splice(0)) await b.end().catch(() => {});
});

afterAll(async () => {
  for (const b of open) await b.end().catch(() => {});
  await db?.drop().catch(() => {});
  server?.stop();
});

async function board(as = "system", session?: string): Promise<Board> {
  const b = await Board.open((db as { url: string }).url, { as, session });
  open.push(b);
  return b;
}

/** The error a promise rejects with, as {code, message, fix}. */
async function refusal(p: Promise<unknown>): Promise<BoardError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(BoardError);
    const err = e as BoardError;
    expect(err.message.length).toBeGreaterThan(0);
    expect(err.fix.length).toBeGreaterThan(0);
    return err;
  }
  throw new Error("expected a refusal");
}

/** A fresh title, so tests sharing the database don't see each other's tasks by name. */
let n = 0;
const title = (what: string): string => `${what} ${++n}-${Date.now()}`;

// ---------- migrations ----------
test("migrations are recorded, and running them twice changes nothing", async () => {
  const b = await board();
  expect(await b.migrate()).toEqual([]);
  const sql = new SQL((db as { url: string }).url, { max: 1 });
  try {
    const rows = await sql`select name from mb_migrations order by name`;
    expect(rows.map((r: { name: string }) => r.name)).toContain("001_init.sql");
  } finally {
    await sql.close();
  }
});

// ---------- claim ----------
test("two claimers race for one task: exactly one wins, the other gets nothing", async () => {
  const setup = await board("po");
  // Its own priority puts it first in the queue, so both claimers aim at it.
  const t = await setup.create({ title: title("the only one"), priority: -1000 });
  const [a, b] = [await board("haile"), await board("taytu")];
  const [ca, cb] = await Promise.all([a.claim(t.id).catch((e: unknown) => e), b.claim(t.id).catch((e: unknown) => e)]);
  const results = [ca, cb];
  const wins = results.filter((r) => r !== null && !(r instanceof Error) && typeof r === "object" && "token" in r);
  expect(wins.length).toBe(1);
  const lost = results.find((r) => r instanceof BoardError) as BoardError;
  expect(lost.code).toBe("not-ready");
  expect((await setup.get(t.id)).status).toBe("in_progress");
});

test("many claimers of any ready task: each task goes to exactly one of them", async () => {
  const setup = await board("po");
  const ids = new Set<number>();
  for (let i = 0; i < 4; i++) ids.add((await setup.create({ title: title("race any"), priority: -900 })).id);
  const claimers = await Promise.all(Array.from({ length: 10 }, (_, i) => board(`racer-${i}`)));
  const claims = await Promise.all(claimers.map((c) => c.claim()));
  const mine = claims.filter((c) => c !== null && ids.has(c.task.id));
  expect(mine.length).toBe(4);
  expect(new Set(mine.map((c) => c?.task.id)).size).toBe(4);
  expect(new Set(mine.map((c) => c?.token)).size).toBe(4);
});

test("a named claim of a task someone else holds is refused; the holder claiming again gets a new token", async () => {
  const po = await board("po");
  const t = await po.create({ title: title("held") });
  const a = await board("haile");
  const first = await a.claim(t.id);
  expect(first?.task.holder).toBe("haile");
  const err = await refusal((await board("taytu")).claim(t.id));
  expect(err.code).toBe("not-ready");
  expect(err.message).toContain("haile");
  const again = await a.claim(t.id);
  expect(again?.token).not.toBe(first?.token);
});

// ---------- tokens ----------
test("an old token is refused (claim-lost) once the task has passed to someone else", async () => {
  const po = await board("po");
  const t = await po.create({ title: title("fenced") });
  const a = await board("haile");
  const old = await a.claim(t.id);
  if (!old) throw new Error("no claim");
  await a.release(t.id, old.token, { next: "ready", reason: "giving it up" });
  const b = await board("taytu");
  const now = await b.claim(t.id);
  expect(now?.task.holder).toBe("taytu");
  for (const write of [
    () => a.close(t.id, { token: old.token, outcome: "done" }),
    () => a.heartbeat(t.id, old.token),
    () => a.release(t.id, old.token, { next: "ready", reason: "again" }),
  ]) {
    expect((await refusal(write())).code).toBe("claim-lost");
  }
  const after = await po.get(t.id);
  expect(after.status).toBe("in_progress");
  expect(after.holder).toBe("taytu");
  await b.close(t.id, { token: now?.token, outcome: "done" });
  expect((await po.get(t.id)).status).toBe("done");
});

test("a held task can't be closed without its token", async () => {
  const po = await board("po");
  const t = await po.create({ title: title("no token") });
  await (await board("haile")).claim(t.id);
  expect((await refusal(po.close(t.id, { outcome: "wont_do" }))).code).toBe("claim-lost");
});

// ---------- release ----------
test("release says what happens next: ready, deferred, or a hand-off only the named actor can claim", async () => {
  const po = await board("po");
  const a = await board("haile");
  const t1 = await po.create({ title: title("give up"), priority: -800 });
  const c1 = await a.claim(t1.id);
  const r1 = await a.release(t1.id, c1?.token ?? "", { next: "ready", reason: "stuck" });
  expect([r1.status, r1.holder]).toEqual(["open", null]);
  expect((await po.ready()).map((t) => t.id)).toContain(t1.id);

  const t2 = await po.create({ title: title("later") });
  const c2 = await a.claim(t2.id);
  const r2 = await a.release(t2.id, c2?.token ?? "", { next: "deferred", reason: "not now" });
  expect(r2.status).toBe("deferred");
  expect((await po.ready()).map((t) => t.id)).not.toContain(t2.id);

  const t3 = await po.create({ title: title("hand off"), priority: -2000 });
  const c3 = await a.claim(t3.id);
  const r3 = await a.release(t3.id, c3?.token ?? "", { next: "handoff", to: "menelik", reason: "yours now" });
  expect([r3.status, r3.assignee]).toEqual(["open", "menelik"]);
  expect((await refusal((await board("taytu")).claim(t3.id))).code).toBe("not-ready");
  const other = await (await board("zewditu")).claim();
  expect(other?.task.id).not.toBe(t3.id);
  expect((await po.ready()).map((t) => t.id)).not.toContain(t3.id);
  const got = await (await board("menelik")).claim();
  expect(got?.task.id).toBe(t3.id);
  const ev = (await po.events(0)).filter((e) => e.subject === `task:${t3.id}` && e.kind === "task.released");
  expect(ev.at(-1)?.payload).toMatchObject({ next: "handoff", to: "menelik", reason: "yours now" });
  expect((await refusal(a.release(t1.id, "x", { next: "handoff", reason: "nobody" }))).code).toBe("bad-input");
});

// ---------- dependencies ----------
test("a cycle of blocking edges is refused and nothing is written", async () => {
  const po = await board("po");
  const [a, b, c] = [await po.create({ title: title("A") }), await po.create({ title: title("B") }), await po.create({ title: title("C") })];
  await po.link(a.id, b.id, "blocks");
  await po.link(b.id, c.id, "waits_for");
  const before = (await po.events(0)).at(-1)?.seq ?? 0;
  expect((await refusal(po.link(c.id, a.id, "blocks"))).code).toBe("cycle");
  expect((await refusal(po.link(a.id, a.id, "blocks"))).code).toBe("cycle");
  expect(await po.events(before)).toEqual([]);
  // a non-blocking edge may point back
  await po.link(c.id, a.id, "related");
});

test("a task is blocked by its parent's blocker, and ready once the blocker is done", async () => {
  const po = await board("po");
  const epic = await po.create({ title: title("epic"), kind: "epic" });
  const child = await po.create({ title: title("child"), parentId: epic.id });
  const grandchild = await po.create({ title: title("grandchild"), parentId: child.id });
  const blocker = await po.create({ title: title("blocker") });
  await po.link(blocker.id, epic.id, "blocks");
  for (const id of [epic.id, child.id, grandchild.id]) {
    const t = await po.get(id);
    expect(t.blocked).toBe(true);
    expect(t.blockedBy).toEqual([blocker.id]);
  }
  const ready = (await po.ready()).map((t) => t.id);
  expect(ready).not.toContain(child.id);
  expect(ready).not.toContain(grandchild.id);
  expect((await refusal((await board("haile")).claim(grandchild.id))).message).toContain(`#${blocker.id}`);
  await po.close(blocker.id, { outcome: "done" });
  expect((await po.get(grandchild.id)).blocked).toBe(false);
  expect((await po.ready()).map((t) => t.id)).toContain(grandchild.id);
});

test("unlink removes the edge and unblocks", async () => {
  const po = await board("po");
  const [a, b] = [await po.create({ title: title("A") }), await po.create({ title: title("B") })];
  await po.link(a.id, b.id, "blocks");
  expect((await po.get(b.id)).blocked).toBe(true);
  expect(await po.unlink(a.id, b.id, "blocks")).toBe(true);
  expect((await po.get(b.id)).blocked).toBe(false);
  expect(await po.unlink(a.id, b.id, "blocks")).toBe(false);
});

test("a parent that would make a loop is refused", async () => {
  const po = await board("po");
  const a = await po.create({ title: title("A") });
  const b = await po.create({ title: title("B"), parentId: a.id });
  expect((await refusal(po.update(a.id, { version: a.version, parentId: b.id }))).code).toBe("cycle");
});

// ---------- sweep ----------
test("a sweep releases a claim only when both the claim and its holder are quiet", async () => {
  const po = await board("po");
  const sys = await board("system");
  const quietSeconds = 3;
  // The claim's time is up, but its holder is still heard from (a heartbeat on another task): kept.
  const busy = await board("busy");
  const t1 = await po.create({ title: title("expired, holder alive") });
  const keep = await po.create({ title: title("holder's other task") });
  await busy.claim(t1.id, { ttlSeconds: 1 });
  const other = await busy.claim(keep.id, { ttlSeconds: 600 });
  // The holder is quiet, but the claim's time isn't up: kept.
  const quiet = await board("quiet");
  const t2 = await po.create({ title: title("quiet holder, claim running") });
  await quiet.claim(t2.id, { ttlSeconds: 600 });
  // Both quiet: released.
  const gone = await board("gone");
  const t3 = await po.create({ title: title("both quiet") });
  await gone.claim(t3.id, { ttlSeconds: 1 });

  await Bun.sleep(1500);
  await busy.heartbeat(keep.id, other?.token ?? "");
  let swept = (await sys.sweep({ quietSeconds })).map((s) => s.id);
  expect(swept).not.toContain(t1.id);
  expect(swept).not.toContain(t3.id); // its holder claimed it 1.5 s ago: not quiet yet

  await Bun.sleep(2000);
  await busy.heartbeat(keep.id, other?.token ?? "");
  swept = (await sys.sweep({ quietSeconds })).map((s) => s.id);
  expect(swept).toContain(t3.id);
  expect(swept).not.toContain(t1.id);
  expect(swept).not.toContain(t2.id);
  const t = await po.get(t3.id);
  expect([t.status, t.holder]).toEqual(["open", null]);
  const ev = (await po.events(0)).filter((e) => e.subject === `task:${t3.id}`).at(-1);
  expect([ev?.kind, ev?.actor]).toEqual(["task.swept", "system"]);
  expect(ev?.payload).toMatchObject({ holder: "gone" });
});

test("a heartbeat keeps the claim: the sweep re-checks the time in its own update", async () => {
  const po = await board("po");
  const a = await board("beats");
  const t = await po.create({ title: title("heartbeat") });
  const c = await a.claim(t.id, { ttlSeconds: 1 });
  await Bun.sleep(1200);
  await a.heartbeat(t.id, c?.token ?? "", { ttlSeconds: 600 });
  expect((await (await board("system")).sweep({ quietSeconds: 0 })).map((s) => s.id)).not.toContain(t.id);
  expect((await po.get(t.id)).holder).toBe("beats");
});

// ---------- versions ----------
test("an edit carries the version it read: a stale one is a conflict and changes nothing", async () => {
  const po = await board("po");
  const t = await po.create({ title: title("versioned"), body: "one" });
  const u = await po.update(t.id, { version: t.version, body: "two" });
  expect(u.version).toBe(t.version + 1);
  const err = await refusal(po.update(t.id, { version: t.version, body: "three" }));
  expect(err.code).toBe("conflict");
  expect((await po.get(t.id)).body).toBe("two");
  expect((await refusal(po.get(999_999_999))).code).toBe("not-found");
});

test("every write raises the version", async () => {
  const po = await board("po");
  const a = await board("haile");
  const t = await po.create({ title: title("versions") });
  const c = await a.claim(t.id);
  const h = await a.heartbeat(t.id, c?.token ?? "");
  expect(h.version).toBeGreaterThan(c?.task.version ?? 0);
  expect((c?.task.version ?? 0)).toBeGreaterThan(t.version);
});

// ---------- context ----------
test("context on a task reaches a task linked to it, and not an unlinked one", async () => {
  const po = await board("po");
  const a = await po.create({ title: title("found it") });
  const linked = await po.create({ title: title("linked") });
  const unlinked = await po.create({ title: title("unlinked") });
  await po.link(linked.id, a.id, "discovered_from");
  const finder = await board("haile");
  await finder.note(a.id, { kind: "discovery", body: "the cache key ignores the locale" });
  await finder.note(linked.id, { kind: "decision", body: "use the locale in the key" });
  const ctx = await po.contextFor(linked.id);
  expect(ctx.map((c) => [c.taskId, c.kind, c.body, c.author])).toEqual([
    [a.id, "discovery", "the cache key ignores the locale", "haile"],
    [linked.id, "decision", "use the locale in the key", "haile"],
  ]);
  expect(await po.contextFor(unlinked.id)).toEqual([]);
  // The agent that takes the linked task starts with it.
  const taker = await board("taytu");
  await taker.claim(linked.id);
  const p = await taker.prime("taytu");
  const held = p.holding.find((h) => h.task.id === linked.id);
  expect(held?.context.map((c) => c.body)).toContain("the cache key ignores the locale");
});

// ---------- threads, on me, delegated, prime ----------
test("threads: a question and its answer share a thread, and the answer closes the question", async () => {
  const po = await board("owner");
  const t = await po.create({ title: title("asked") });
  const q = await (await board("haile")).post({ task: t.id, kind: "question", to: "owner", body: "Which locale?" });
  expect([q.from, q.state, q.threadId]).toEqual(["haile", "open", q.id]);
  const onMe = await po.onMe("owner");
  expect(onMe.messages.map((m) => m.id)).toContain(q.id);
  const a = await po.post({ kind: "answer", inReplyTo: q.id, to: "haile", body: "en-GB" });
  expect([a.threadId, a.taskId]).toEqual([q.id, t.id]);
  expect((await po.thread({ thread: q.id })).map((m) => [m.kind, m.state])).toEqual([["question", "answered"], ["answer", "closed"]]);
  expect((await po.thread({ task: t.id })).length).toBe(2);
  expect((await po.onMe("owner")).messages.map((m) => m.id)).not.toContain(q.id);
});

test("on me and delegated: what waits on an actor, and what it asked for and where each is", async () => {
  const owner = await board("owner-2");
  const asked = await owner.create({ title: title("owner asked") });
  const builder = await board("builder-2");
  const c = await builder.claim(asked.id);
  const q = await builder.post({ task: asked.id, kind: "question", to: "owner-2", body: "Blue or green?" });
  const mine = await builder.onMe("builder-2");
  expect(mine.tasks.map((t) => t.id)).toContain(asked.id);
  const ownerOnMe = await owner.onMe("owner-2");
  expect(ownerOnMe.messages.map((m) => m.id)).toContain(q.id);
  const del = await owner.delegated("owner-2");
  const row = del.tasks.find((t) => t.id === asked.id);
  expect([row?.status, row?.holder]).toEqual(["in_progress", "builder-2"]);
  const bq = await builder.delegated("builder-2");
  expect(bq.messages.map((m) => m.id)).toContain(q.id);
  await builder.close(asked.id, { token: c?.token, outcome: "done" });
  expect((await owner.delegated("owner-2")).tasks.find((t) => t.id === asked.id)?.status).toBe("done");
});

test("prime returns what the actor holds, what is ready, what is blocked, and recent events", async () => {
  const po = await board("po");
  const a = await board("primer");
  const held = await po.create({ title: title("primed held") });
  const blocked = await po.create({ title: title("primed blocked") });
  const blocker = await po.create({ title: title("primed blocker"), priority: -3000 });
  await po.link(blocker.id, blocked.id, "blocks");
  await a.claim(held.id);
  const p = await a.prime("primer");
  expect(p.actor).toBe("primer");
  expect(p.holding.map((h) => h.task.id)).toEqual([held.id]);
  expect(p.ready.map((t) => t.id)).toContain(blocker.id);
  expect(p.blocked.map((t) => t.id)).toContain(blocked.id);
  expect(p.recent.length).toBeGreaterThan(0);
});

// ---------- events ----------
test("every write emits an event, and listen gets them in order, once each", async () => {
  const po = await board("po", "session-1");
  const watcher = await board("watcher");
  const got: BoardEvent[] = [];
  const start = (await watcher.events(0)).at(-1)?.seq ?? 0;
  const sub = await watcher.listen((e) => {
    got.push(e);
  }, { after: start });
  try {
    const t = await po.create({ title: title("live") });
    const u = await po.update(t.id, { version: t.version, title: title("live, renamed") });
    const other = await po.create({ title: title("live other") });
    await po.link(other.id, t.id, "related");
    await po.unlink(other.id, t.id, "related");
    const claim = await (await board("live-claimer")).claim(t.id);
    await po.note(t.id, { kind: "result", body: "done well" });
    await po.post({ task: t.id, kind: "status", body: "on it" });
    await (await board("live-claimer")).close(t.id, { token: claim?.token, outcome: "done" });
    expect(u.version).toBe(t.version + 1);
    const deadline = Date.now() + 10_000;
    while (got.length < 9 && Date.now() < deadline) await Bun.sleep(50);
    const mine = got.filter((e) => e.subject === `task:${t.id}` || (e.payload as { task?: number }).task === t.id || e.subject === `task:${other.id}`);
    expect(mine.map((e) => e.kind)).toEqual([
      "task.created", "task.updated", "task.created", "edge.linked", "edge.unlinked", "task.claimed", "context.noted",
      "message.posted", "task.closed",
    ]);
    const seqs = got.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(got[0]?.session).toBe("session-1");
    expect((await watcher.events(start)).map((e) => e.seq)).toEqual(seqs);
  } finally {
    await sub.close();
  }
});

test("a refused write emits no event", async () => {
  const po = await board("po");
  const t = await po.create({ title: title("quiet refusal") });
  const before = (await po.events(0)).at(-1)?.seq ?? 0;
  await refusal(po.update(t.id, { version: t.version + 5, body: "x" }));
  expect(await po.events(before)).toEqual([]);
});

// ---------- races on the graph, and event order ----------
test("two links that together close a loop, sent at once: exactly one wins, the other is a cycle", async () => {
  for (let round = 0; round < 5; round++) {
    const po = await board("po");
    const [a, b] = [await po.create({ title: title("race A") }), await po.create({ title: title("race B") })];
    const [x, y] = [await board("x"), await board("y")];
    const results = await Promise.all([x.link(a.id, b.id, "blocks").catch((e: unknown) => e), y.link(b.id, a.id, "waits_for").catch((e: unknown) => e)]);
    expect(results.filter((r) => r === true).length).toBe(1);
    expect(results.filter((r) => r instanceof BoardError && r.code === "cycle").length).toBe(1);
  }
});

test("two parent changes that together make a loop, sent at once: exactly one wins, the other is a cycle", async () => {
  for (let round = 0; round < 5; round++) {
    const po = await board("po");
    const [a, b] = [await po.create({ title: title("parent A") }), await po.create({ title: title("parent B") })];
    const [x, y] = [await board("x"), await board("y")];
    const results = await Promise.all([
      x.update(a.id, { version: a.version, parentId: b.id }).catch((e: unknown) => e),
      y.update(b.id, { version: b.version, parentId: a.id }).catch((e: unknown) => e),
    ]);
    expect(results.filter((r) => r instanceof BoardError && r.code === "cycle").length).toBe(1);
    expect(results.filter((r) => !(r instanceof Error)).length).toBe(1);
  }
});

test("events from many writers at once reach a listener in commit order, none skipped", async () => {
  const watcher = await board("watcher");
  const start = (await watcher.events(0)).at(-1)?.seq ?? 0;
  const got: number[] = [];
  const sub = await watcher.listen((e) => {
    got.push(e.seq);
  }, { after: start });
  try {
    const writers = await Promise.all(Array.from({ length: 8 }, (_, i) => board(`writer-${i}`)));
    await Promise.all(writers.map(async (w) => {
      for (let k = 0; k < 5; k++) await w.create({ title: title("burst") });
    }));
    const all = (await watcher.events(start)).map((e) => e.seq);
    expect(all.length).toBe(40);
    const deadline = Date.now() + 10_000;
    while (got.length < all.length && Date.now() < deadline) await Bun.sleep(50);
    expect(got).toEqual(all);
  } finally {
    await sub.close();
  }
});

// ---------- states and kinds ----------
test("the sweep keeps an in-review task in review and only drops its holder", async () => {
  const po = await board("po");
  const a = await board("reviewing");
  const t = await po.create({ title: title("in review") });
  const c = await a.claim(t.id, { ttlSeconds: 1 });
  await po.update(t.id, { version: c?.task.version ?? 0, status: "in_review" });
  await Bun.sleep(2200);
  const swept = (await (await board("system")).sweep({ quietSeconds: 1 })).map((s) => s.id);
  expect(swept).toContain(t.id);
  const after = await po.get(t.id);
  expect([after.status, after.holder]).toEqual(["in_review", null]);
});

test("closing a done task without a token is refused and keeps its outcome; reopening clears the outcome", async () => {
  const po = await board("po");
  const t = await po.create({ title: title("done once") });
  const done = await po.close(t.id, { outcome: "wont_do" });
  const err = await refusal(po.close(t.id, { outcome: "done" }));
  expect(err.code).toBe("bad-input");
  expect((await po.get(t.id)).outcome).toBe("wont_do");
  const reopened = await po.update(t.id, { version: done.version, status: "open" });
  expect([reopened.status, reopened.outcome]).toEqual(["open", null]);
  const deferred = await po.update(t.id, { version: reopened.version, status: "deferred" });
  expect(deferred.outcome).toBeNull();
});

test("only tasks and bugs are claimed: epics, notes and decisions are never ready", async () => {
  const po = await board("po");
  const kinds = ["epic", "note", "decision"] as const;
  const made = [];
  for (const kind of kinds) made.push(await po.create({ title: title(kind), kind, priority: -9000 }));
  const bug = await po.create({ title: title("bug"), kind: "bug", priority: -8999 });
  const ready = (await po.ready()).map((t) => t.id);
  for (const m of made) expect(ready).not.toContain(m.id);
  expect(ready).toContain(bug.id);
  const a = await board("kind-claimer");
  for (const m of made) {
    const msg = (await refusal(a.claim(m.id))).message;
    expect(msg).toContain(m.kind);
    expect(msg).toContain("only tasks and bugs are claimed");
  }
  expect((await a.claim())?.task.id).toBe(bug.id);
});

test("ready without an actor leaves out tasks handed to someone; with one it includes theirs", async () => {
  const po = await board("po");
  const a = await board("hander");
  const t = await po.create({ title: title("handed") });
  const c = await a.claim(t.id);
  await a.release(t.id, c?.token ?? "", { next: "handoff", to: "receiver", reason: "yours" });
  expect((await po.ready()).map((x) => x.id)).not.toContain(t.id);
  expect((await po.ready({ for: "receiver" })).map((x) => x.id)).toContain(t.id);
  expect((await po.ready({ for: "someone-else" })).map((x) => x.id)).not.toContain(t.id);
});

// ---------- moves (#503) ----------
test("a move with blockedBy and a parent change on the same task, at once, many rounds: each completes or is refused, never a raw error", async () => {
  const a = await board("abebe");
  const b = await board("po");
  for (let i = 0; i < 40; i++) {
    const x = await a.create({ title: title("X") });
    const blocker = await a.create({ title: title("B") });
    const parent = await a.create({ title: title("P") });
    const results = await Promise.allSettled([
      a.move(x.id, { to: "blocked", blockedBy: [blocker.id] }),
      b.update(x.id, { version: x.version, parentId: parent.id }),
    ]);
    for (const r of results) {
      if (r.status === "fulfilled") continue;
      expect(r.reason, String(r.reason)).toBeInstanceOf(BoardError);
      const e = r.reason as BoardError;
      expect(["busy", "conflict"], `${e.code}: ${e.message}`).toContain(e.code);
      expect(e.fix.length).toBeGreaterThan(0);
    }
  }
});

test("a move lists each blocking task once, however often it is named", async () => {
  const a = await board("abebe");
  const x = await a.create({ title: title("X") });
  const blocker = await a.create({ title: title("B") });
  const after = await a.lastSeq();
  const moved = await a.move(x.id, { to: "blocked", blockedBy: [blocker.id, blocker.id, blocker.id] });
  expect(moved.blockedBy).toEqual([blocker.id]);
  expect(await a.edges(x.id)).toEqual([{ from: blocker.id, to: x.id, kind: "blocks" }]);
  const ev = (await a.events(after)).find((e) => e.kind === "task.moved");
  expect(ev?.payload.blockedBy).toEqual([blocker.id]);
});
