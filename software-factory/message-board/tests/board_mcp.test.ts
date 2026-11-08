// `factory board mcp --as <actor>` (#495, decision 0007): the message board as an MCP server over stdio. Each test
// starts `bun bin.ts mcp` against a real Postgres and talks JSON-RPC to it over stdin and stdout, as a client would:
// the lifecycle, the tools and their schemas, each tool's happy path, the refusals, the fixed actor, and a clean exit.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { SQL } from "bun";
import { join } from "node:path";
import { Board } from "../src/index.ts";
import { freshDatabase, type Server, startServer } from "./pg.ts";

setDefaultTimeout(60_000);

const BIN = join(import.meta.dir, "..", "bin.ts");
/** A task made on the board, by its number as tools take and give it (#515): b<board id>. */
const n = (t: { id: number }): string => `b${t.id}`;
const TOOLS = ["board_prime", "board_ready", "board_claim", "board_heartbeat", "board_release", "board_close", "board_show",
  "board_post", "board_thread", "board_note", "board_on_me", "board_delegated", "board_attach"];
let server: Server | null = null;
const dbs: { url: string; drop(): Promise<void> }[] = [];
const clients: Client[] = [];

beforeAll(async () => {
  server = await startServer();
}, 600_000);

afterAll(async () => {
  for (const c of clients) c.kill();
  await Promise.all(clients.map((c) => c.proc.exited));
  for (const d of dbs) await d.drop().catch(() => {});
  server?.stop();
});

/** A new migrated database; its URL. */
async function database(): Promise<string> {
  const d = await freshDatabase(server as Server);
  dbs.push(d);
  const b = await Board.open(d.url);
  await b.migrate();
  await b.end();
  return d.url;
}

function env(url?: string): Record<string, string> {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("MB_") && !k.startsWith("FACTORY_")) e[k] = v;
  e.FACTORY_CONFIG_DIR = join(process.env.TMPDIR || "/tmp", `mb-mcp-none-${process.pid}`); // no url file there
  if (url) e.MB_URL = url;
  return e;
}

type Json = Record<string, unknown>;
interface Reply { jsonrpc: string; id: unknown; result?: Json; error?: { code: number; message: string; data?: unknown } }
interface ToolResult { content: { type: string; text: string }[]; structuredContent?: Json; isError?: boolean }

class Client {
  readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  readonly replies: Reply[] = [];
  private waiting: (() => void)[] = [];
  private nextId = 1;
  stderr = "";

  constructor(url: string, args: string[] = ["--as", "haile"], read = true) {
    this.proc = Bun.spawn([process.execPath, "--no-env-file", BIN, "mcp", ...args], { env: env(url), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    clients.push(this);
    if (read) void this.read();
    const proc = this.proc;
    void (async () => {
      this.stderr = await new Response(proc.stderr).text();
    })();
  }

  private async read(): Promise<void> {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of this.proc.stdout) {
      buf += dec.decode(chunk, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) this.replies.push(JSON.parse(line) as Reply);
        for (const w of this.waiting.splice(0)) w();
        nl = buf.indexOf("\n");
      }
    }
  }

  raw(line: string): void {
    this.proc.stdin.write(line + "\n");
    void this.proc.stdin.flush();
  }

  /** The reply with this id (waits up to 30 s). */
  async reply(id: unknown): Promise<Reply> {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const r = this.replies.find((x) => x.id === id);
      if (r) return r;
      if (Date.now() > deadline) throw new Error(`no reply to ${String(id)}; stderr: ${this.stderr}`);
      await new Promise<void>((res) => {
        this.waiting.push(res);
        setTimeout(res, 200);
      });
    }
  }

  async request(method: string, params?: Json): Promise<Reply> {
    const id = this.nextId++;
    this.raw(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }));
    return this.reply(id);
  }

  notify(method: string, params?: Json): void {
    this.raw(JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }));
  }

  async start(version = "2025-11-25"): Promise<Reply> {
    const r = await this.request("initialize", { protocolVersion: version, capabilities: {}, clientInfo: { name: "test", version: "1" } });
    this.notify("notifications/initialized");
    return r;
  }

  async call(name: string, args: Json = {}): Promise<ToolResult> {
    const r = await this.request("tools/call", { name, arguments: args });
    if (r.error) throw new Error(`tools/call ${name} failed: ${JSON.stringify(r.error)}`);
    return r.result as unknown as ToolResult;
  }

  /** The structured result of a call that must succeed. */
  async ok(name: string, args: Json = {}): Promise<Json> {
    const r = await this.call(name, args);
    if (r.isError) throw new Error(`${name} was refused: ${r.content[0]?.text}`);
    expect(r.content[0]?.type).toBe("text");
    expect(JSON.parse(r.content[0]?.text as string)).toEqual(JSON.parse(JSON.stringify(r.structuredContent)));
    return r.structuredContent as Json;
  }

  /** The error of a call that must be refused. */
  async refused(name: string, args: Json = {}): Promise<{ code: string; message: string; fix: string; text: string }> {
    const r = await this.call(name, args);
    expect(r.isError).toBe(true);
    const e = (r.structuredContent as { error: { code: string; message: string; fix: string } }).error;
    expect(r.content[0]?.text).toBe(`${e.code}: ${e.message} Fix: ${e.fix}`);
    return { ...e, text: r.content[0]?.text as string };
  }

  async end(): Promise<number> {
    this.proc.stdin.end();
    return this.proc.exited;
  }

  kill(): void {
    if (this.proc.exitCode === null) this.proc.kill();
  }
}

test("initialize answers with the version asked for when it is supported, else the newest it has", async () => {
  const url = await database();
  const c = new Client(url);
  const r = await c.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  expect(r.jsonrpc).toBe("2.0");
  expect(r.result?.protocolVersion).toBe("2025-06-18");
  expect(r.result?.capabilities).toMatchObject({ tools: {} });
  expect(r.result?.serverInfo).toMatchObject({ name: "factory-message-board" });
  expect(typeof (r.result?.serverInfo as Json).version).toBe("string");
  expect(String(r.result?.instructions)).toContain("haile");
  expect(await c.end()).toBe(0);

  const d = new Client(url);
  const r2 = await d.request("initialize", { protocolVersion: "1900-01-01", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  expect(r2.result?.protocolVersion).toBe("2025-11-25");
  expect(await d.end()).toBe(0);
});

test("before initialize only ping is answered; tools/list is refused", async () => {
  const c = new Client(await database());
  expect((await c.request("ping")).result).toEqual({});
  const r = await c.request("tools/list");
  expect(r.error?.code).toBe(-32600);
  expect(r.error?.message).toContain("initialize");
  await c.end();
});

test("tools/list names every tool, each with a description and an input schema that takes no actor", async () => {
  const c = new Client(await database());
  await c.start();
  const r = await c.request("tools/list");
  const tools = (r.result?.tools ?? []) as { name: string; description: string; inputSchema: { type: string; properties: Json; required?: string[]; additionalProperties: boolean } }[];
  expect(tools.map((t) => t.name).sort()).toEqual([...TOOLS].sort());
  for (const t of tools) {
    expect(t.description.length).toBeGreaterThan(20);
    expect(t.inputSchema.type).toBe("object");
    expect(t.inputSchema.additionalProperties).toBe(false);
    for (const p of Object.keys(t.inputSchema.properties)) expect(["as", "actor", "sender", "from", "author", "holder"]).not.toContain(p);
  }
  const by = Object.fromEntries(tools.map((t) => [t.name, t.inputSchema]));
  expect(by.board_claim?.required ?? []).toEqual([]);
  expect(by.board_claim?.properties).toHaveProperty("task");
  expect(by.board_release?.required?.sort()).toEqual(["next", "reason", "task", "token"]);
  expect(by.board_release?.properties.next).toMatchObject({ enum: ["ready", "deferred", "handoff"] });
  expect(by.board_close?.properties.outcome).toMatchObject({ enum: ["done", "wont_do", "duplicate", "superseded"] });
  expect(by.board_post?.properties.kind).toMatchObject({ enum: ["question", "answer", "status", "note"] });
  expect(by.board_post?.required?.sort()).toEqual(["body", "kind"]);
  expect(by.board_note?.properties.kind).toMatchObject({ enum: ["discovery", "decision", "blocker", "result"] });
  await c.end();
});

test("each tool's happy path, all written as haile", async () => {
  const url = await database();
  const po = await Board.open(url, { as: "po" });
  const a = await po.create({ title: "Write the importer", priority: 1 });
  const b = await po.create({ title: "Show the board", priority: 2 });
  const blocked = await po.create({ title: "Ship it", priority: 3 });
  await po.link(b.id, blocked.id, "blocks");
  await po.post({ task: a.id, kind: "question", to: "haile", body: "Which issues first?" });

  const c = new Client(url, ["--as", "haile", "--session", "s-9"]);
  await c.start();

  const ready = (await c.ok("board_ready")).tasks as { id: string }[];
  expect(ready.map((t) => t.id)).toEqual([n(a), n(b)]);

  const claimed = (await c.ok("board_claim")).claim as { token: string; task: { id: string; holder: string } };
  expect(claimed.task.id).toBe(n(a));
  expect(claimed.task.holder).toBe("haile");
  expect(claimed.token).toMatch(/^[0-9a-f-]{36}$/);
  const token = claimed.token;

  const hb = (await c.ok("board_heartbeat", { task: n(a), token, ttlSeconds: 600 })).task as { claimUntil: string };
  expect(Date.parse(hb.claimUntil)).toBeGreaterThan(Date.now() + 500_000);

  const onMe = await c.ok("board_on_me");
  expect((onMe.tasks as { id: string }[]).map((t) => t.id)).toEqual([n(a)]);
  expect((onMe.messages as { body: string }[]).map((m) => m.body)).toEqual(["Which issues first?"]);

  const question = (await po.thread({ task: a.id }))[0] as { id: number };
  const answer = (await c.ok("board_post", { task: n(a), kind: "answer", body: "The open ones.", inReplyTo: question.id })).message as Json;
  expect(answer).toMatchObject({ from: "haile", kind: "answer", taskId: n(a), threadId: question.id });
  const asked = (await c.ok("board_post", { task: n(a), kind: "question", to: "po", body: "Closed ones too?" })).message as Json;
  expect(asked).toMatchObject({ from: "haile", to: "po", state: "open" });

  const note = (await c.ok("board_note", { task: n(a), kind: "decision", body: "Keep the issue number as the ref" })).entry as Json;
  expect(note).toMatchObject({ author: "haile", kind: "decision", taskId: n(a) });

  const thread = (await c.ok("board_thread", { task: n(a) })).messages as { from: string }[];
  expect(thread.map((m) => m.from)).toEqual(["po", "haile", "haile"]);
  const byThread = (await c.ok("board_thread", { thread: question.id })).messages as unknown[];
  expect(byThread.length).toBe(2);

  const shown = await c.ok("board_show", { task: n(a) });
  expect((shown.task as Json).title).toBe("Write the importer");
  expect((shown.thread as unknown[]).length).toBe(3);
  expect((shown.context as { body: string }[]).map((x) => x.body)).toEqual(["Keep the issue number as the ref"]);
  expect(shown.edges).toEqual([]);

  const prime = await c.ok("board_prime");
  expect(prime.actor).toBe("haile");
  expect((prime.holding as { task: { id: string } }[]).map((h) => h.task.id)).toEqual([n(a)]);
  expect((prime.ready as { id: string }[]).map((t) => t.id)).toEqual([n(b)]);
  expect((prime.blocked as { id: string }[]).map((t) => t.id)).toEqual([n(blocked)]);
  expect((prime.recent as unknown[]).length).toBeGreaterThan(0);

  const delegated = await c.ok("board_delegated");
  expect((delegated.messages as { body: string }[]).map((m) => m.body)).toEqual(["Closed ones too?"]);

  const closed = (await c.ok("board_close", { task: n(a), token, outcome: "done", reason: "merged" })).task as Json;
  expect(closed).toMatchObject({ status: "done", outcome: "done", holder: null });

  const named = (await c.ok("board_claim", { task: n(b) })).claim as { token: string };
  const released = (await c.ok("board_release", { task: n(b), token: named.token, next: "handoff", to: "selam", reason: "needs the web UI" })).task as Json;
  expect(released).toMatchObject({ status: "open", holder: null, assignee: "selam" });

  expect((await c.ok("board_claim")).claim).toBeNull(); // b is handed to selam, blocked is blocked

  const events = await po.events(0);
  const mine = events.filter((e) => e.actor === "haile");
  expect(mine.length).toBeGreaterThan(5);
  expect(mine.every((e) => e.session === "s-9")).toBe(true);
  await po.end();
  expect(await c.end()).toBe(0);
});

test("refusals come back as tool errors with code, message and fix", async () => {
  const url = await database();
  const po = await Board.open(url, { as: "po" });
  const a = await po.create({ title: "A" });
  const b = await po.create({ title: "B" });
  await po.link(a.id, b.id, "blocks");
  const c = new Client(url);
  await c.start();

  const notReady = await c.refused("board_claim", { task: n(b) });
  expect(notReady.code).toBe("not-ready");
  expect(notReady.fix.length).toBeGreaterThan(0);

  const claim = (await c.ok("board_claim", { task: n(a) })).claim as { token: string };
  const lost = await c.refused("board_heartbeat", { task: n(a), token: "00000000-0000-0000-0000-000000000000" });
  expect(lost.code).toBe("claim-lost");
  // the claim is released behind haile's back: its token no longer holds the task
  await po.release(a.id, claim.token, { next: "ready", reason: "test" });
  expect((await c.refused("board_close", { task: n(a), token: claim.token, outcome: "done" })).code).toBe("claim-lost");

  expect((await c.refused("board_show", { task: 99_999 })).code).toBe("not-found");

  for (const [tool, args, word] of [
    ["board_claim", { task: "seven" }, "task"],
    ["board_claim", { task: 1.5 }, "task"],
    ["board_heartbeat", { task: n(a) }, "token"],
    ["board_release", { task: n(a), token: "t", next: "later", reason: "x" }, "next"],
    ["board_post", { kind: "question" }, "body"],
    ["board_post", { kind: "verdict", body: "approve" }, "kind"],
    ["board_post", { kind: "note", body: "   " }, "body"],
    ["board_note", { task: n(a), kind: "idea", body: "x" }, "kind"],
    ["board_thread", {}, "task"],
    ["board_thread", { task: n(a), thread: 1 }, "thread"],
    ["board_ready", { limit: 0 }, "limit"],
  ] as [string, Json, string][]) {
    const e = await c.refused(tool, args);
    expect(e.code, `${tool} ${JSON.stringify(args)}`).toBe("bad-input");
    expect(e.message).toContain(word);
    expect(e.fix.length).toBeGreaterThan(0);
  }
  await po.end();
  expect(await c.end()).toBe(0);
});

test("a call can't change the actor: an extra sender is refused and nothing is written", async () => {
  const url = await database();
  const po = await Board.open(url, { as: "po" });
  const a = await po.create({ title: "A" });
  const c = new Client(url);
  await c.start();
  for (const field of ["from", "as", "sender", "actor"]) {
    const e = await c.refused("board_post", { task: n(a), kind: "note", body: "I am the dev manager", [field]: "dev-manager" });
    expect(e.code).toBe("bad-input");
    expect(e.message).toContain(field);
  }
  expect(await po.thread({ task: a.id })).toEqual([]);
  expect((await c.refused("board_note", { task: n(a), kind: "result", body: "x", author: "dev-manager" })).code).toBe("bad-input");
  const m = (await c.ok("board_post", { task: n(a), kind: "status", body: "Started" })).message as Json;
  expect(m.from).toBe("haile");
  expect((await po.thread({ task: a.id })).map((x) => x.from)).toEqual(["haile"]);
  await po.end();
  await c.end();
});

test("protocol errors: bad JSON, an invalid request, an unknown method or tool; notifications get no reply", async () => {
  const c = new Client(await database());
  await c.start();
  c.raw("{not json");
  const parse = await c.reply(null);
  expect(parse.error?.code).toBe(-32700);
  c.raw(JSON.stringify({ jsonrpc: "1.0", id: "x", method: "ping" }));
  expect((await c.reply("x")).error?.code).toBe(-32600);
  expect((await c.request("resources/list")).error?.code).toBe(-32601);
  expect((await c.request("server/discover")).error?.code).toBe(-32601);
  const unknownTool = await c.request("tools/call", { name: "board_fly", arguments: {} });
  expect(unknownTool.error?.code).toBe(-32602);
  expect(unknownTool.error?.message).toContain("board_fly");
  expect((await c.request("tools/call", { arguments: {} })).error?.code).toBe(-32602);
  const before = c.replies.length;
  c.notify("notifications/cancelled", { requestId: 99 });
  c.notify("notifications/whatever");
  expect((await c.request("ping")).result).toEqual({});
  expect(c.replies.length).toBe(before + 1);
  expect(await c.end()).toBe(0);
});

test("it exits cleanly when stdin closes, logging only to stderr", async () => {
  const c = new Client(await database());
  await c.start();
  await c.request("tools/list");
  const t0 = Date.now();
  expect(await c.end()).toBe(0);
  expect(Date.now() - t0).toBeLessThan(10_000);
  await Bun.sleep(50);
  expect(c.stderr).not.toContain("at ");
  for (const r of c.replies) expect(r.jsonrpc).toBe("2.0");
});

test("it won't start without --as, or without a board, and says how to fix it", async () => {
  const run = (args: string[], url?: string): { code: number; stderr: string } => {
    const p = Bun.spawnSync([process.execPath, "--no-env-file", BIN, "mcp", ...args], { env: env(url), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode ?? 124, stderr: p.stderr.toString() };
  };
  const url = await database();
  const noActor = run([], url);
  expect(noActor.code).toBe(1);
  expect(JSON.parse(noActor.stderr.trim().split("\n").at(-1) as string)).toMatchObject({ code: "bad-input" });
  expect(noActor.stderr).toContain("--as");
  const noBoard = run(["--as", "haile"]);
  expect(noBoard.code).toBe(1);
  expect(JSON.parse(noBoard.stderr.trim().split("\n").at(-1) as string)).toMatchObject({ code: "no-board" });
  const extra = run(["--as", "haile", "--fly"], url);
  expect(extra.code).toBe(1);
});

test("factory board help lists the mcp verb", () => {
  const p = Bun.spawnSync([process.execPath, "--no-env-file", BIN, "help"], { env: env(), stdout: "pipe", stderr: "pipe" });
  expect(p.stdout.toString()).toContain("factory board mcp --as <actor> [--session <id>]");
});

/** How many connections are open to the database at `url`, other than this query's. */
async function connections(url: string): Promise<number> {
  const name = new URL(url).pathname.slice(1);
  const u = new URL(url);
  u.pathname = "/postgres";
  const sql = new SQL(u.toString(), { max: 1 });
  try {
    const r = (await sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = ${name} AND pid <> pg_backend_pid()`) as { n: number }[];
    return r[0]?.n ?? 0;
  } finally {
    await sql.close();
  }
}

/** The connections still open to `url` after waiting up to 10 s for them to close. */
async function noConnections(url: string): Promise<number> {
  const deadline = Date.now() + 10_000;
  let n = await connections(url);
  while (n > 0 && Date.now() < deadline) {
    await Bun.sleep(100);
    n = await connections(url);
  }
  return n;
}

const STACK = /\n\s+at /;

for (const [signal, code] of [["SIGTERM", 143], ["SIGINT", 130]] as const) {
  test(`${signal} closes the board's connection and exits ${code}, writing nothing more to stdout`, async () => {
    const url = await database();
    const c = new Client(url);
    await c.start();
    await c.request("tools/list");
    expect(await connections(url)).toBeGreaterThan(0);
    const replies = c.replies.length;
    c.proc.kill(signal);
    expect(await c.proc.exited).toBe(code);
    await Bun.sleep(50);
    expect(c.replies.length).toBe(replies);
    expect(await noConnections(url)).toBe(0);
    expect(c.stderr).not.toMatch(STACK);
  });
}

test("when the client stops reading stdout, the server closes the board and exits without a stack trace", async () => {
  const url = await database();
  const c = new Client(url, ["--as", "haile"], false);
  await c.proc.stdout.cancel();
  c.raw(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } }));
  for (let i = 2; i < 40; i++) c.raw(JSON.stringify({ jsonrpc: "2.0", id: i, method: "tools/list" }));
  const exited = await Promise.race([c.proc.exited, Bun.sleep(15_000).then(() => -1)]);
  expect(exited).toBe(0);
  await Bun.sleep(50);
  expect(c.stderr).toContain("stopped reading");
  expect(c.stderr).not.toMatch(STACK);
  expect(c.stderr).not.toContain("unexpected");
  expect(await noConnections(url)).toBe(0);
});

test("a batch is refused with -32600, and the server keeps serving", async () => {
  const c = new Client(await database());
  await c.start();
  c.raw(JSON.stringify([{ jsonrpc: "2.0", id: 50, method: "ping" }, { jsonrpc: "2.0", id: 51, method: "ping" }]));
  const r = await c.reply(null);
  expect(r.error?.code).toBe(-32600);
  expect(r.error?.message).toContain("batch");
  expect((await c.request("ping")).result).toEqual({});
  expect(c.replies.some((x) => x.id === 50 || x.id === 51)).toBe(false);
  expect(await c.end()).toBe(0);
});

test("a body over the cap on a very large line is bad-input, and the server keeps serving", async () => {
  const url = await database();
  const po = await Board.open(url, { as: "po" });
  const a = await po.create({ title: "A" });
  const c = new Client(url);
  await c.start();
  const e = await c.refused("board_post", { task: n(a), kind: "note", body: "x".repeat(1_000_000) });
  expect(e.code).toBe("bad-input");
  expect(e.message).toContain("body");
  expect(e.message).toContain("20000");
  expect(await po.thread({ task: a.id })).toEqual([]);
  expect((await c.ok("board_post", { task: n(a), kind: "note", body: "x".repeat(20_000) })).message).toMatchObject({ from: "haile" });
  await po.end();
  expect(await c.end()).toBe(0);
});

test("requests sent back to back without waiting are answered in order", async () => {
  const url = await database();
  const po = await Board.open(url, { as: "po" });
  const a = await po.create({ title: "A" });
  await po.end();
  const c = new Client(url);
  await c.start();
  const before = c.replies.length;
  const call = (id: number, name: string, args: Json): string => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  c.raw([
    call(101, "board_claim", { task: n(a) }),
    call(102, "board_show", { task: n(a) }),
    JSON.stringify({ jsonrpc: "2.0", id: 103, method: "ping" }),
    call(104, "board_post", { task: n(a), kind: "status", body: "Started" }),
    call(105, "board_thread", { task: n(a) }),
  ].join("\n"));
  await c.reply(105);
  expect(c.replies.slice(before).map((r) => r.id)).toEqual([101, 102, 103, 104, 105]);
  const shown = (await c.reply(102)).result as unknown as ToolResult;
  expect((shown.structuredContent as { task: { holder: string } }).task.holder).toBe("haile");
  const thread = (await c.reply(105)).result as unknown as ToolResult;
  expect((thread.structuredContent as { messages: unknown[] }).messages.length).toBe(1);
  expect(await c.end()).toBe(0);
});

// ---------- owner and manager tools (#503) ----------
const OWNER_TOOLS = ["board_move", "board_create", "board_assign", "board_link", "board_unlink", "board_comment", "board_signoff_add"];

async function toolNames(c: Client): Promise<string[]> {
  return (((await c.request("tools/list")).result?.tools ?? []) as { name: string }[]).map((t) => t.name).sort();
}

test("a builder's server (the default) neither lists nor runs the owner's tools; owner and manager servers do", async () => {
  const url = await database();
  const po = await Board.open(url, { as: "po" });
  const a = await po.create({ title: "A" });
  for (const args of [["--as", "haile"], ["--as", "haile", "--role", "builder"]]) {
    const c = new Client(url, args);
    await c.start();
    expect(await toolNames(c)).toEqual([...TOOLS].sort());
    for (const name of OWNER_TOOLS) {
      const r = await c.request("tools/call", { name, arguments: { task: n(a), body: "x", title: "x", kind: "task", to: "ready" } });
      expect(r.error?.code, name).toBe(-32602);
      expect(r.error?.message).toContain(name);
    }
    expect(await c.end()).toBe(0);
  }
  expect((await po.get(a.id)).status).toBe("open");
  expect(await po.thread({ task: a.id })).toEqual([]);
  expect((await po.tasks()).length).toBe(1);
  for (const role of ["owner", "manager"]) {
    const c = new Client(url, ["--as", role === "owner" ? "abebe" : "dev-manager", "--role", role]);
    const init = await c.start();
    expect(String(init.result?.instructions)).toContain(role);
    expect(await toolNames(c)).toEqual([...TOOLS, ...OWNER_TOOLS].sort());
    expect(await c.end()).toBe(0);
  }
  await po.end();
});

test("the owner's tools take no sender and refuse what they don't list", async () => {
  const c = new Client(await database(), ["--as", "abebe", "--role", "owner"]);
  await c.start();
  const tools = ((await c.request("tools/list")).result?.tools ?? []) as { name: string; inputSchema: { properties: Json; required?: string[]; additionalProperties: boolean } }[];
  const by = Object.fromEntries(tools.map((t) => [t.name, t.inputSchema]));
  for (const name of OWNER_TOOLS) {
    const s = by[name];
    expect(s?.additionalProperties, name).toBe(false);
    for (const p of Object.keys(s?.properties ?? {})) expect(["as", "actor", "sender", "author", "holder"]).not.toContain(p);
  }
  expect(by.board_move?.required?.sort()).toEqual(["task", "to"]);
  expect(by.board_move?.properties.to).toMatchObject({ enum: ["ready", "in_progress", "in_review", "done", "deferred", "blocked"] });
  expect(by.board_move?.properties.blockedBy).toMatchObject({ type: "array" });
  expect(by.board_create?.required?.sort()).toEqual(["kind", "title"]);
  expect(by.board_create?.properties.kind).toMatchObject({ enum: ["task", "bug", "epic", "note"] });
  expect(by.board_assign?.required?.sort()).toEqual(["task", "to"]);
  expect(by.board_link?.required?.sort()).toEqual(["from", "kind", "to"]);
  expect(by.board_link?.properties.kind).toMatchObject({ enum: ["blocks", "waits_for", "discovered_from", "supersedes", "duplicates", "related"] });
  // which way a blocking link points, said plainly (an agent read waits_for backwards, 7 Nov)
  const linkHelp = String((tools as unknown as { name: string; description?: string }[]).find((t) => t.name === "board_link")?.description);
  expect(linkHelp).toContain("blocks: from must be done before to can start.");
  expect(linkHelp).toContain("waits_for: from can't start until to is done.");
  expect(by.board_unlink?.required?.sort()).toEqual(["from", "kind", "to"]);
  expect(by.board_comment?.required?.sort()).toEqual(["body", "task"]);
  const e = await c.refused("board_comment", { task: 1, body: "hi", from: "dev-manager" });
  expect(e.code).toBe("bad-input");
  expect(e.message).toContain("from");
  expect(await c.end()).toBe(0);
});

test("board_create makes a task, bug, epic or note with a parent, written as the owner", async () => {
  const url = await database();
  const c = new Client(url, ["--as", "abebe", "--role", "owner", "--session", "o-1"]);
  await c.start();
  const epic = (await c.ok("board_create", { title: "Run the board", kind: "epic" })).task as Json;
  expect(epic).toMatchObject({ title: "Run the board", kind: "epic", createdBy: "abebe", status: "open" });
  const task = (await c.ok("board_create", { title: "Move cards", kind: "task", body: "From chat", parent: epic.id, priority: 1 })).task as Json;
  expect(task).toMatchObject({ kind: "task", body: "From chat", parentId: epic.id, priority: 1, createdBy: "abebe" });
  expect((await c.ok("board_create", { title: "It crashes", kind: "bug" })).task).toMatchObject({ kind: "bug", priority: 2 });
  expect((await c.ok("board_create", { title: "Remember this", kind: "note" })).task).toMatchObject({ kind: "note" });

  for (const [args, word] of [
    [{ title: "x" }, "kind"],
    [{ title: "x", kind: "decision" }, "kind"],
    [{ title: "  ", kind: "task" }, "title"],
    [{ title: "x".repeat(501), kind: "task" }, "title"],
    [{ title: "x", kind: "task", priority: -1 }, "priority"],
    [{ title: "x", kind: "task", parent: "one" }, "parent"],
  ] as [Json, string][]) {
    const e = await c.refused("board_create", args);
    expect(e.code, JSON.stringify(args)).toBe("bad-input");
    expect(e.message).toContain(word);
  }
  expect((await c.refused("board_create", { title: "x", kind: "task", parent: 99_999 })).code).toBe("not-found");
  const po = await Board.open(url, { as: "po" });
  expect((await po.tasks()).length).toBe(4);
  const created = (await po.events(0, 500, { kind: "task.created" }));
  expect(created.length).toBe(4);
  expect(created.every((e) => e.actor === "abebe" && e.session === "o-1")).toBe(true);
  await po.end();
  expect(await c.end()).toBe(0);
});

test("board_move moves a task between columns, each move an event a live listener sees", async () => {
  const url = await database();
  const po = await Board.open(url, { as: "po" });
  const a = await po.create({ title: "A" });
  const seen: { kind: string; actor: string; payload: Json }[] = [];
  const listener = await po.listen((e) => {
    seen.push({ kind: e.kind, actor: e.actor, payload: e.payload });
  });
  const c = new Client(url, ["--as", "dev-manager", "--role", "manager"]);
  await c.start();
  const move = async (to: string, extra: Json = {}): Promise<Json> => (await c.ok("board_move", { task: n(a), to, ...extra })).task as Json;

  expect(await move("deferred")).toMatchObject({ status: "deferred" });
  expect(await move("in_review")).toMatchObject({ status: "in_review" });
  expect(await move("done")).toMatchObject({ status: "done", outcome: "done" });
  expect(await move("ready")).toMatchObject({ status: "open", outcome: null });
  expect(await move("done", { outcome: "wont_do", reason: "not needed" })).toMatchObject({ status: "done", outcome: "wont_do" });
  expect(await move("ready")).toMatchObject({ status: "open" });

  const deadline = Date.now() + 5_000;
  while (seen.filter((e) => e.kind === "task.moved").length < 6 && Date.now() < deadline) await Bun.sleep(50);
  const moves = seen.filter((e) => e.kind === "task.moved");
  expect(moves.map((e) => e.payload.to)).toEqual(["deferred", "in_review", "done", "ready", "done", "ready"]);
  expect(moves.every((e) => e.actor === "dev-manager")).toBe(true);
  expect(moves[4]?.payload).toMatchObject({ from: "open", to: "done", outcome: "wont_do", reason: "not needed" });
  await listener.close();

  // refusals
  const refusal = async (args: Json, code: string, word: string): Promise<void> => {
    const e = await c.refused("board_move", { task: n(a), ...args });
    expect(e.code, JSON.stringify(args)).toBe(code);
    expect(e.message.toLowerCase()).toContain(word);
    expect(e.fix.length).toBeGreaterThan(0);
  };
  await refusal({ to: "sideways" }, "bad-input", "to");
  await refusal({ to: "blocked" }, "bad-input", "blocked");
  await refusal({ to: "ready", outcome: "done" }, "bad-input", "outcome");
  await refusal({ to: "ready", blockedBy: [n(a)] }, "bad-input", "blockedby");
  await refusal({ to: "blocked", blockedBy: [] }, "bad-input", "blockedby");
  await refusal({ to: "blocked", blockedBy: ["one"] }, "bad-input", "blockedby");
  await refusal({ to: "in_progress" }, "bad-input", "claim");
  expect((await c.refused("board_move", { task: 99_999, to: "ready" })).code).toBe("not-found");
  expect((await po.get(a.id)).status).toBe("open");
  await po.end();
  expect(await c.end()).toBe(0);
});

test("the owner moving a held task takes the claim back, with an event naming the owner and the reason", async () => {
  const url = await database();
  const po = await Board.open(url, { as: "po" });
  const a = await po.create({ title: "A" });
  const b = await po.create({ title: "B" });
  const agent = await Board.open(url, { as: "haile" });
  const claimA = await agent.claim(a.id);
  const claimB = await agent.claim(b.id);
  const c = new Client(url, ["--as", "abebe", "--role", "owner"]);
  await c.start();

  const noReason = await c.refused("board_move", { task: n(a), to: "ready" });
  expect(noReason.code).toBe("bad-input");
  expect(noReason.message).toContain("haile");
  expect(noReason.fix).toContain("reason");
  expect((await po.get(a.id)).holder).toBe("haile");

  const moved = (await c.ok("board_move", { task: n(a), to: "ready", reason: "haile is stuck" })).task as Json;
  expect(moved).toMatchObject({ status: "open", holder: null });
  const back = await po.events(0, 500, { kind: "task.taken_back" });
  expect(back.length).toBe(1);
  expect(back[0]).toMatchObject({ actor: "abebe", subject: `task:${a.id}`, payload: { holder: "haile", reason: "haile is stuck" } });
  // the holder's token no longer holds it
  await expect(agent.heartbeat(a.id, claimA?.token as string)).rejects.toMatchObject({ code: "claim-lost" });
  expect((await po.ready()).map((t) => t.id)).toContain(a.id);

  // done from held: taken back and closed
  expect((await c.ok("board_move", { task: n(b), to: "done", reason: "done by hand" })).task).toMatchObject({ status: "done", outcome: "done", holder: null });
  await expect(agent.close(b.id, { token: claimB?.token as string, outcome: "done" })).rejects.toMatchObject({ code: "claim-lost" });
  expect((await po.events(0, 500, { kind: "task.taken_back" })).length).toBe(2);
  await agent.end();
  await po.end();
  expect(await c.end()).toBe(0);
});

test("blocked with blockedBy adds the blocks edge and the task isn't ready; with a reason only it is deferred with a blocker note", async () => {
  const url = await database();
  const po = await Board.open(url, { as: "po" });
  const a = await po.create({ title: "A" });
  const b = await po.create({ title: "B" });
  const d = await po.create({ title: "D" });
  const c = new Client(url, ["--as", "abebe", "--role", "owner"]);
  await c.start();

  const t = (await c.ok("board_move", { task: n(a), to: "blocked", blockedBy: [n(b)], reason: "needs B" })).task as Json;
  expect(t).toMatchObject({ status: "open", blocked: true, blockedBy: [n(b)] });
  expect(await po.edges(a.id)).toEqual([{ from: b.id, to: a.id, kind: "blocks" }]);
  expect((await po.ready()).map((x) => x.id)).not.toContain(a.id);
  expect((await po.contextFor(a.id)).map((x) => [x.kind, x.body, x.author])).toEqual([["blocker", "needs B", "abebe"]]);

  // a cycle is refused and nothing changes
  const cycle = await c.refused("board_move", { task: n(b), to: "blocked", blockedBy: [n(a)] });
  expect(cycle.code).toBe("cycle");
  expect(await po.edges(b.id)).toEqual([{ from: b.id, to: a.id, kind: "blocks" }]);
  expect((await po.get(b.id)).status).toBe("open");

  const r = (await c.ok("board_move", { task: n(d), to: "blocked", reason: "waiting on the owner" })).task as Json;
  expect(r).toMatchObject({ status: "deferred" });
  expect((await po.contextFor(d.id)).map((x) => x.kind)).toEqual(["blocker"]);
  expect((await po.ready()).map((x) => x.id)).not.toContain(d.id);
  await po.end();
  expect(await c.end()).toBe(0);
});

test("board_assign hands a task to one actor: only they may claim it", async () => {
  const url = await database();
  const po = await Board.open(url, { as: "po" });
  const a = await po.create({ title: "A" });
  const h = await po.create({ title: "Held" });
  const haile = await Board.open(url, { as: "haile" });
  const selam = await Board.open(url, { as: "selam" });
  const held = await haile.claim(h.id);
  const c = new Client(url, ["--as", "dev-manager", "--role", "manager"]);
  await c.start();

  expect((await c.ok("board_assign", { task: n(a), to: "selam" })).task).toMatchObject({ assignee: "selam", status: "open" });
  await expect(haile.claim(a.id)).rejects.toMatchObject({ code: "not-ready" });
  expect((await haile.ready({ for: "haile" })).map((t) => t.id)).not.toContain(a.id);
  expect((await selam.claim(a.id))?.task.holder).toBe("selam");
  const assigned = await po.events(0, 500, { kind: "task.assigned" });
  expect(assigned[0]).toMatchObject({ actor: "dev-manager", payload: { to: "selam" } });

  // a held task: refused without a reason, taken back and handed on with one
  const e = await c.refused("board_assign", { task: n(h), to: "selam" });
  expect(e.code).toBe("bad-input");
  expect(e.message).toContain("haile");
  const moved = (await c.ok("board_assign", { task: n(h), to: "selam", reason: "selam knows the UI" })).task as Json;
  expect(moved).toMatchObject({ holder: null, assignee: "selam", status: "open" });
  await expect(haile.heartbeat(h.id, held?.token as string)).rejects.toMatchObject({ code: "claim-lost" });
  expect((await po.events(0, 500, { kind: "task.taken_back" }))[0]).toMatchObject({ actor: "dev-manager", payload: { holder: "haile", reason: "selam knows the UI" } });

  for (const [args, code] of [
    [{ task: n(a), to: " " }, "bad-input"],
    [{ task: n(a) }, "bad-input"],
    [{ task: 99_999, to: "selam" }, "not-found"],
  ] as [Json, string][]) {
    expect((await c.refused("board_assign", args)).code, JSON.stringify(args)).toBe(code);
  }
  await haile.end();
  await selam.end();
  await po.end();
  expect(await c.end()).toBe(0);
});

test("board_link and board_unlink add and remove typed links; a loop is refused", async () => {
  const url = await database();
  const po = await Board.open(url, { as: "po" });
  const a = await po.create({ title: "A" });
  const b = await po.create({ title: "B" });
  const c = new Client(url, ["--as", "abebe", "--role", "owner"]);
  await c.start();
  expect(await c.ok("board_link", { from: n(a), to: n(b), kind: "blocks" })).toMatchObject({ linked: true });
  expect(await c.ok("board_link", { from: n(a), to: n(b), kind: "blocks" })).toMatchObject({ linked: false });
  expect(await c.ok("board_link", { from: n(a), to: n(b), kind: "related" })).toMatchObject({ linked: true });
  expect((await po.get(b.id)).blockedBy).toEqual([a.id]);
  // a blocks b, so a waiting for b would be a loop; b waiting for a says the same order again
  const loop = await c.refused("board_link", { from: n(a), to: n(b), kind: "waits_for" });
  expect(loop.code).toBe("cycle");
  expect((await c.refused("board_link", { from: n(a), to: n(a), kind: "blocks" })).code).toBe("cycle");
  expect((await c.refused("board_link", { from: n(a), to: n(b), kind: "parent" })).code).toBe("bad-input");
  expect((await c.refused("board_link", { from: n(a), to: 99_999, kind: "blocks" })).code).toBe("not-found");
  expect(await c.ok("board_unlink", { from: n(a), to: n(b), kind: "blocks" })).toMatchObject({ unlinked: true });
  expect(await c.ok("board_unlink", { from: n(a), to: n(b), kind: "blocks" })).toMatchObject({ unlinked: false });
  expect((await po.get(b.id)).blocked).toBe(false);
  expect(await po.edges()).toEqual([{ from: a.id, to: b.id, kind: "related" }]);
  const kinds = (await po.events(0)).filter((e) => e.actor === "abebe").map((e) => e.kind);
  expect(kinds).toEqual(["edge.linked", "edge.linked", "edge.unlinked"]);
  await po.end();
  expect(await c.end()).toBe(0);
});

test("a task linked to its PRD change's note card isn't ready until the card is done; the owner moving it is build now (#578)", async () => {
  const url = await database();
  const po = new Client(url, ["--as", "po", "--role", "manager"]);
  const builder = new Client(url, ["--as", "haile"]);
  const owner = new Client(url, ["--as", "abebe", "--role", "owner"]);
  for (const c of [po, builder, owner]) await c.start();
  // the tools name cards as people see them: b<id>
  const card = String(((await po.ok("board_create", { title: "PRD change: #62 (Shelf v1.1)", kind: "note", body: "PRD change: #62" })).task as Json).id);
  const task = String(((await po.ok("board_create", { title: "Shelf search", kind: "task", body: "PRD: US-12\nPRD change: #62" })).task as Json).id);
  expect(await po.ok("board_link", { from: task, to: card, kind: "waits_for" })).toMatchObject({ linked: true });
  expect(((await builder.ok("board_ready")).tasks as Json[]).map((t) => t.id)).toEqual([]);
  expect((await builder.refused("board_claim", { task })).code).toBe("not-ready");
  await owner.ok("board_move", { task: card, to: "done", reason: "build now: the owner read PR #62" });
  expect(((await builder.ok("board_ready")).tasks as Json[]).map((t) => t.id)).toEqual([task]);
  expect(((await builder.ok("board_claim", { task })).claim as Json).task).toMatchObject({ id: task, holder: "haile" });
  const b = await Board.open(url, { as: "po" });
  const moved = (await b.events(0, 500, { kind: "task.moved" })).find((e) => e.subject === `task:${card.slice(1)}`);
  expect(moved).toMatchObject({ actor: "abebe", payload: { to: "done", reason: "build now: the owner read PR #62" } });
  await b.end();
  for (const c of [po, builder, owner]) expect(await c.end()).toBe(0);
});

test("board_comment posts a note on the task's thread as the server's actor", async () => {
  const url = await database();
  const po = await Board.open(url, { as: "po" });
  const a = await po.create({ title: "A" });
  const c = new Client(url, ["--as", "abebe", "--role", "owner"]);
  await c.start();
  const m = (await c.ok("board_comment", { task: n(a), body: "Do the login first." })).message as Json;
  expect(m).toMatchObject({ from: "abebe", kind: "note", taskId: n(a), body: "Do the login first." });
  expect((await po.thread({ task: a.id })).map((x) => [x.from, x.body])).toEqual([["abebe", "Do the login first."]]);
  expect((await c.refused("board_comment", { task: n(a), body: "  " })).code).toBe("bad-input");
  expect((await c.refused("board_comment", { task: n(a), body: "x".repeat(20_001) })).code).toBe("bad-input");
  expect((await c.refused("board_comment", { task: 99_999, body: "hi" })).code).toBe("not-found");
  await po.end();
  expect(await c.end()).toBe(0);
});

test("--role takes owner, manager or builder; mcp --help shows how to add the server to a Claude Code session", () => {
  const run = (args: string[]): { code: number; stdout: string; stderr: string } => {
    const p = Bun.spawnSync([process.execPath, "--no-env-file", BIN, "mcp", ...args], { env: env(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode ?? 124, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
  };
  const bad = run(["--as", "abebe", "--role", "boss"]);
  expect(bad.code).toBe(1);
  const err = JSON.parse(bad.stderr.trim().split("\n").at(-1) as string) as { code: string; message: string; fix: string };
  expect(err.code).toBe("bad-input");
  expect(err.message).toContain("boss");
  expect(err.fix).toContain("owner");
  for (const flag of ["--help", "-h"]) {
    const h = run([flag]);
    expect(h.code).toBe(0);
    expect(h.stdout).toContain("--role owner|manager|builder");
    expect(h.stdout).toContain("claude mcp add board -- bun ");
    expect(h.stdout).toContain("message-board/bin.ts mcp --as owner --role owner");
    expect(h.stdout).toContain("./factory board mcp --as owner --role owner");
    for (const t of OWNER_TOOLS) expect(h.stdout).toContain(t);
  }
  const p = Bun.spawnSync([process.execPath, "--no-env-file", BIN, "help"], { env: env(), stdout: "pipe", stderr: "pipe" });
  expect(p.stdout.toString()).toContain("factory board mcp --as <actor> [--session <id>] [--role owner|manager|builder]");
});

// ---------- one number people see (#515) ----------
test("tasks are named by their issue number (3, \"#3\") or b<id>, in what the tools take and in what they give", async () => {
  const url = await database();
  const po = await Board.open(url, { as: "po" });
  // board ids and issue numbers differ on purpose: board task 1 is issue #7, and a task numbered like an issue is b-only
  const seven = await po.create({ title: "Seven", ref: "github:o/r#7", priority: 1 });
  const three = await po.create({ title: "Three", ref: "github:o/r#3", priority: 2, parentId: seven.id });
  const filed = await po.create({ title: "Filed on the board", priority: 3 });
  const other = await po.create({ title: "Another repo's", ref: "github:x/y#3", priority: 4 });
  await po.link(seven.id, filed.id, "blocks");
  await po.post({ task: three.id, kind: "note", body: "hello" });
  const c = new Client(url, ["--as", "abebe", "--role", "owner", "--repo", "o/r"]);
  const init = await c.start();
  expect(String(init.result?.instructions)).toContain("b17");

  const ready = (await c.ok("board_ready")).tasks as Json[];
  expect(ready.map((t) => t.id)).toEqual(["#7", "#3", "x/y#3"]);
  expect(ready.find((t) => t.id === "#3")?.parentId).toBe("#7");

  for (const named of [3, "3", "#3"]) {
    const shown = await c.ok("board_show", { task: named });
    expect((shown.task as Json).title, String(named)).toBe("Three");
    expect((shown.thread as Json[])[0]?.taskId).toBe("#3");
  }
  expect(((await c.ok("board_show", { task: "x/y#3" })).task as Json).title).toBe("Another repo's");
  const b = await c.ok("board_show", { task: `b${filed.id}` });
  expect(b.task).toMatchObject({ id: `b${filed.id}`, blocked: true, blockedBy: ["#7"] });
  expect(b.edges).toEqual([{ from: "#7", to: `b${filed.id}`, kind: "blocks" }]);

  // the owner moves "#3" and the board moves issue 3's task, not board task 3
  expect((await c.ok("board_move", { task: 3, to: "deferred" })).task).toMatchObject({ id: "#3", status: "deferred" });
  expect((await po.get(three.id)).status).toBe("deferred");
  expect(filed.id).toBe(3); // board task 3 is left as it was
  expect((await po.get(filed.id)).status).toBe("open");
  expect((await po.get(other.id)).status).toBe("open");

  const missing = await c.refused("board_show", { task: 99 });
  expect(missing.code).toBe("not-found");
  expect(missing.message).toContain("issue #99");
  expect(missing.fix).toContain("b17");
  const gone = await c.refused("board_show", { task: "b99999" });
  expect(gone.code).toBe("not-found");
  expect(gone.message).toContain("b99999");
  expect(gone.message).not.toContain("#99999");
  expect((await c.refused("board_show", { task: "three" })).code).toBe("bad-input");
  await po.end();
  expect(await c.end()).toBe(0);
});

test("board_close on a done task says to move it back to ready with board_move", async () => {
  const url = await database();
  const po = await Board.open(url, { as: "po" });
  const a = await po.create({ title: "A" });
  await po.close(a.id, { outcome: "done" });
  const c = new Client(url, ["--as", "dev-manager", "--role", "manager"]);
  await c.start();
  const e = await c.refused("board_close", { task: n(a), outcome: "wont_do" });
  expect(e.code).toBe("bad-input");
  expect(e.message).toContain(`${n(a)} is already done`);
  expect(e.fix).toContain("board_move");
  expect(e.fix).not.toContain("board.update");
  await po.end();
  expect(await c.end()).toBe(0);
});

test("errors name tasks by their number: the board's own, the one it is blocked by, and a lookup's are left as written (#515)", async () => {
  const url = await database();
  const po = await Board.open(url, { as: "po" });
  const three = await po.create({ title: "Three", ref: "github:o/r#3", priority: 1 }); // board id 1
  const seven = await po.create({ title: "Seven", ref: "github:o/r#7", priority: 2 }); // board id 2
  const filed = await po.create({ title: "Filed", priority: 3 }); // board id 3
  await po.link(seven.id, three.id, "blocks");
  expect([three.id, seven.id, filed.id]).toEqual([1, 2, 3]);
  const c = new Client(url, ["--as", "abebe", "--role", "owner", "--repo", "o/r"]);
  await c.start();

  // "#1" is issue 1, which isn't on the board: the lookup's message is kept, not turned into "#3" (board id 1)
  const lookup = await c.refused("board_link", { from: "#3", to: "#1", kind: "related" });
  expect(lookup.code).toBe("not-found");
  expect(lookup.message).toBe("There is no task for issue #1 on the board.");
  expect(lookup.fix).toContain("3 or #3 for issue 3, b17 for a task made on the board");

  // the board's own refusal names the task and its blocker as people see them
  const blocked = await c.refused("board_claim", { task: 3 });
  expect(blocked.code).toBe("not-ready");
  expect(blocked.message).toContain("#3 isn't ready for abebe");
  expect(blocked.message).toContain("blocked by #7");
  expect(blocked.message).not.toContain("#2");
  expect(blocked.text).toContain("blocked by #7");

  const loop = await c.refused("board_link", { from: "#3", to: "#7", kind: "blocks" });
  expect(loop.code).toBe("cycle");
  expect(loop.message).toBe("#3 blocks #7 would make a loop: #3 already waits on #7, or is under it.");
  const self = await c.refused("board_link", { from: `b${filed.id}`, to: `b${filed.id}`, kind: "blocks" });
  expect(self.message).toContain(`(b${filed.id})`);
  await po.end();
  expect(await c.end()).toBe(0);
});
