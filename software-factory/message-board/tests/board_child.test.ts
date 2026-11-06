// What a synchronous caller needs from the board (#500): the child (src/child.ts) that runs one request per process,
// every edge at once, messages after a cursor, leases, and signals a waiter hears. Against a real Postgres.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { Board, type ChildAnswer, type ChildRequest } from "../src/index.ts";
import { freshDatabase, type Server, startServer } from "./pg.ts";

setDefaultTimeout(60_000);

const CHILD = join(import.meta.dir, "..", "src", "child.ts");
let server: Server | null = null;
let db: { url: string; drop(): Promise<void> } | null = null;

beforeAll(async () => {
  server = await startServer();
  db = await freshDatabase(server);
  const b = await Board.open(db.url);
  await b.migrate();
  await b.end();
}, 600_000);

afterAll(async () => {
  await db?.drop().catch(() => {});
  server?.stop();
});

const url = (): string => (db as { url: string }).url;

/** Run the child the way a synchronous caller does: Bun.spawnSync, the request on stdin, one JSON line back. */
function child(req: Partial<ChildRequest>, timeout = 20_000): { answer: ChildAnswer; out: string; err: string; ms: number } {
  const started = Date.now();
  const p = Bun.spawnSync([process.execPath, "--no-env-file", "--config=/dev/null", CHILD], {
    stdin: Buffer.from(JSON.stringify(req)), stdout: "pipe", stderr: "pipe", timeout,
  });
  const out = p.stdout.toString();
  return { answer: JSON.parse(out.trim().split("\n").at(-1) ?? "null") as ChildAnswer, out, err: p.stderr.toString(), ms: Date.now() - started };
}

function results(a: ChildAnswer): unknown[] {
  if (!a.ok) throw new Error(`refused: ${a.code} ${a.message}`);
  return a.results;
}

const n = { i: 0 };
const title = (what: string): string => `${what} ${++n.i}-${Date.now()}`;

test("the child makes its calls in order as the actor it names, and prints one JSON line", () => {
  const t1 = title("first");
  const { answer, out } = child({ url: url(), as: "haile", calls: [{ op: "create", args: [{ title: t1 }] }, { op: "claim", args: [] }] });
  expect(out.trim().split("\n")).toHaveLength(1);
  const [made, claim] = results(answer) as [{ id: number; createdBy: string }, { task: { id: number; holder: string }; token: string }];
  expect(made.createdBy).toBe("haile");
  expect(claim.task.holder).toBe("haile");
  expect(typeof claim.token).toBe("string");
});

test("a refusal is {code, message, fix}, and the URL's password is never printed", () => {
  const r = child({ url: url(), as: "haile", calls: [{ op: "get", args: [987654] }] });
  expect(r.answer).toMatchObject({ ok: false, code: "not-found" });
  const bad = child({ url: url(), calls: [{ op: "drop table", args: [] }] });
  expect(bad.answer).toMatchObject({ ok: false, code: "bad-input" });
  const password = new URL(url()).password;
  const down = new URL(url());
  down.port = "1";
  const gone = child({ url: down.toString(), calls: [{ op: "tasks", args: [] }] });
  expect(gone.answer).toMatchObject({ ok: false, code: "no-answer" });
  expect(gone.out + gone.err).not.toContain(password);
  expect(child({}).answer).toMatchObject({ ok: false, code: "bad-input" });
  const none = Bun.spawnSync([process.execPath, "--no-env-file", "--config=/dev/null", CHILD], {
    stdin: Buffer.from(JSON.stringify({ calls: [{ op: "tasks" }] })), stdout: "pipe", stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", HOME: "/nonexistent", FACTORY_CONFIG_DIR: "/nonexistent/mb" },
  });
  expect(JSON.parse(none.stdout.toString())).toMatchObject({ ok: false, code: "no-answer" });
});

test("edges() with no id gives every edge on the board", async () => {
  const b = await Board.open(url(), { as: "system" });
  try {
    const [a, c, d] = [await b.create({ title: title("a") }), await b.create({ title: title("c") }), await b.create({ title: title("d") })];
    await b.link(a.id, c.id, "blocks");
    await b.link(c.id, d.id, "related");
    const all = await b.edges();
    expect(all).toContainEqual({ from: a.id, to: c.id, kind: "blocks" });
    expect(all).toContainEqual({ from: c.id, to: d.id, kind: "related" });
    expect(await b.edges(a.id)).toEqual([{ from: a.id, to: c.id, kind: "blocks" }]);
  } finally {
    await b.end();
  }
});

test("messages: everything with no cursor, then each posted message once after the cursor it gave", async () => {
  const b = await Board.open(url(), { as: "haile" });
  try {
    await b.post({ kind: "note", body: "before" });
    const first = await b.messages();
    expect(first.messages.map((m) => m.body)).toContain("before");
    expect((await b.messages({ after: first.cursor })).messages).toEqual([]);
    await b.post({ kind: "question", body: "one?" });
    await b.post({ kind: "note", body: "two" });
    const next = await b.messages({ after: first.cursor });
    expect(next.messages.map((m) => m.body)).toEqual(["one?", "two"]);
    expect((await b.messages({ after: next.cursor })).messages).toEqual([]);
  } finally {
    await b.end();
  }
});

test("a lease has one holder until its time runs out; taking it again keeps it; release and drop free it", async () => {
  const b = await Board.open(url(), { as: "system" });
  try {
    const key = `review.${Date.now()}`;
    expect(await b.lease(key, "haile", 60)).toEqual({ held: true, holder: "haile" });
    expect(await b.lease(key, "taytu", 60)).toEqual({ held: false, holder: "haile" });
    expect(await b.lease(key, "haile", 60)).toEqual({ held: true, holder: "haile" });
    expect(await b.leaseHolder(key)).toBe("haile");
    expect(await b.unlease(key, "taytu")).toBe(false);
    expect(await b.unlease(key, "haile")).toBe(true);
    expect(await b.leaseHolder(key)).toBe("");
    expect(await b.lease(key, "taytu", 0)).toEqual({ held: true, holder: "taytu" }); // ran out at once
    expect(await b.leaseHolder(key)).toBe("");
    expect(await b.lease(key, "menelik", 60)).toEqual({ held: true, holder: "menelik" });
    expect(await b.dropLease(key)).toBe(true);
    expect(await b.dropLease(key)).toBe(false);
  } finally {
    await b.end();
  }
});

test("a wait hears a matching signal said since its time, or one said while it waits, and gives null at its limit", async () => {
  const since = Date.now();
  const b = await Board.open(url(), { as: "po" });
  try {
    await b.signal("wake", { from: "po", to: "someone-else", why: "not for us" });
    await b.signal("wake", { from: "po", to: "haile", why: "look" });
    const wait = { kind: "signal.wake", since, seconds: 5, match: { to: ["haile", "all"] }, not: { from: ["haile"] } };
    const [got] = results(child({ url: url(), as: "haile", calls: [{ op: "wait", args: [wait] }] }).answer) as [{ payload: { why: string } }];
    expect(got.payload.why).toBe("look");
    const none = child({ url: url(), as: "haile", calls: [{ op: "wait", args: [{ ...wait, since: Date.now(), seconds: 1 }] }] });
    expect(results(none.answer)).toEqual([null]);
    expect(none.ms).toBeGreaterThanOrEqual(1000);
    const later = Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", CHILD], {
      stdin: Buffer.from(JSON.stringify({ url: url(), as: "haile", calls: [{ op: "wait", args: [{ ...wait, since: Date.now(), seconds: 15 }] }] })),
      stdout: "pipe",
    });
    await Bun.sleep(1500);
    await b.signal("wake", { from: "dev-manager", to: "all", why: "merged" });
    const text = await new Response(later.stdout).text();
    const answer = JSON.parse(text.trim()) as ChildAnswer;
    expect((results(answer)[0] as { payload: { why: string } }).payload.why).toBe("merged");
  } finally {
    await b.end();
  }
});
