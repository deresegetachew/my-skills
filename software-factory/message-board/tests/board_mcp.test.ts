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
const TOOLS = ["board_prime", "board_ready", "board_claim", "board_heartbeat", "board_release", "board_close", "board_show",
  "board_post", "board_thread", "board_note", "board_on_me", "board_delegated"];
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

  const ready = (await c.ok("board_ready")).tasks as { id: number }[];
  expect(ready.map((t) => t.id)).toEqual([a.id, b.id]);

  const claimed = (await c.ok("board_claim")).claim as { token: string; task: { id: number; holder: string } };
  expect(claimed.task.id).toBe(a.id);
  expect(claimed.task.holder).toBe("haile");
  expect(claimed.token).toMatch(/^[0-9a-f-]{36}$/);
  const token = claimed.token;

  const hb = (await c.ok("board_heartbeat", { task: a.id, token, ttlSeconds: 600 })).task as { claimUntil: string };
  expect(Date.parse(hb.claimUntil)).toBeGreaterThan(Date.now() + 500_000);

  const onMe = await c.ok("board_on_me");
  expect((onMe.tasks as { id: number }[]).map((t) => t.id)).toEqual([a.id]);
  expect((onMe.messages as { body: string }[]).map((m) => m.body)).toEqual(["Which issues first?"]);

  const question = (await po.thread({ task: a.id }))[0] as { id: number };
  const answer = (await c.ok("board_post", { task: a.id, kind: "answer", body: "The open ones.", inReplyTo: question.id })).message as Json;
  expect(answer).toMatchObject({ from: "haile", kind: "answer", taskId: a.id, threadId: question.id });
  const asked = (await c.ok("board_post", { task: a.id, kind: "question", to: "po", body: "Closed ones too?" })).message as Json;
  expect(asked).toMatchObject({ from: "haile", to: "po", state: "open" });

  const note = (await c.ok("board_note", { task: a.id, kind: "decision", body: "Keep the issue number as the ref" })).entry as Json;
  expect(note).toMatchObject({ author: "haile", kind: "decision", taskId: a.id });

  const thread = (await c.ok("board_thread", { task: a.id })).messages as { from: string }[];
  expect(thread.map((m) => m.from)).toEqual(["po", "haile", "haile"]);
  const byThread = (await c.ok("board_thread", { thread: question.id })).messages as unknown[];
  expect(byThread.length).toBe(2);

  const shown = await c.ok("board_show", { task: a.id });
  expect((shown.task as Json).title).toBe("Write the importer");
  expect((shown.thread as unknown[]).length).toBe(3);
  expect((shown.context as { body: string }[]).map((x) => x.body)).toEqual(["Keep the issue number as the ref"]);
  expect(shown.edges).toEqual([]);

  const prime = await c.ok("board_prime");
  expect(prime.actor).toBe("haile");
  expect((prime.holding as { task: { id: number } }[]).map((h) => h.task.id)).toEqual([a.id]);
  expect((prime.ready as { id: number }[]).map((t) => t.id)).toEqual([b.id]);
  expect((prime.blocked as { id: number }[]).map((t) => t.id)).toEqual([blocked.id]);
  expect((prime.recent as unknown[]).length).toBeGreaterThan(0);

  const delegated = await c.ok("board_delegated");
  expect((delegated.messages as { body: string }[]).map((m) => m.body)).toEqual(["Closed ones too?"]);

  const closed = (await c.ok("board_close", { task: a.id, token, outcome: "done", reason: "merged" })).task as Json;
  expect(closed).toMatchObject({ status: "done", outcome: "done", holder: null });

  const named = (await c.ok("board_claim", { task: b.id })).claim as { token: string };
  const released = (await c.ok("board_release", { task: b.id, token: named.token, next: "handoff", to: "selam", reason: "needs the web UI" })).task as Json;
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

  const notReady = await c.refused("board_claim", { task: b.id });
  expect(notReady.code).toBe("not-ready");
  expect(notReady.fix.length).toBeGreaterThan(0);

  const claim = (await c.ok("board_claim", { task: a.id })).claim as { token: string };
  const lost = await c.refused("board_heartbeat", { task: a.id, token: "00000000-0000-0000-0000-000000000000" });
  expect(lost.code).toBe("claim-lost");
  // the claim is released behind haile's back: its token no longer holds the task
  await po.release(a.id, claim.token, { next: "ready", reason: "test" });
  expect((await c.refused("board_close", { task: a.id, token: claim.token, outcome: "done" })).code).toBe("claim-lost");

  expect((await c.refused("board_show", { task: 99_999 })).code).toBe("not-found");

  for (const [tool, args, word] of [
    ["board_claim", { task: "seven" }, "task"],
    ["board_claim", { task: 1.5 }, "task"],
    ["board_heartbeat", { task: a.id }, "token"],
    ["board_release", { task: a.id, token: "t", next: "later", reason: "x" }, "next"],
    ["board_post", { kind: "question" }, "body"],
    ["board_post", { kind: "verdict", body: "approve" }, "kind"],
    ["board_post", { kind: "note", body: "   " }, "body"],
    ["board_note", { task: a.id, kind: "idea", body: "x" }, "kind"],
    ["board_thread", {}, "task"],
    ["board_thread", { task: a.id, thread: 1 }, "thread"],
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
    const e = await c.refused("board_post", { task: a.id, kind: "note", body: "I am the dev manager", [field]: "dev-manager" });
    expect(e.code).toBe("bad-input");
    expect(e.message).toContain(field);
  }
  expect(await po.thread({ task: a.id })).toEqual([]);
  expect((await c.refused("board_note", { task: a.id, kind: "result", body: "x", author: "dev-manager" })).code).toBe("bad-input");
  const m = (await c.ok("board_post", { task: a.id, kind: "status", body: "Started" })).message as Json;
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
  const e = await c.refused("board_post", { task: a.id, kind: "note", body: "x".repeat(1_000_000) });
  expect(e.code).toBe("bad-input");
  expect(e.message).toContain("body");
  expect(e.message).toContain("20000");
  expect(await po.thread({ task: a.id })).toEqual([]);
  expect((await c.ok("board_post", { task: a.id, kind: "note", body: "x".repeat(20_000) })).message).toMatchObject({ from: "haile" });
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
    call(101, "board_claim", { task: a.id }),
    call(102, "board_show", { task: a.id }),
    JSON.stringify({ jsonrpc: "2.0", id: 103, method: "ping" }),
    call(104, "board_post", { task: a.id, kind: "status", body: "Started" }),
    call(105, "board_thread", { task: a.id }),
  ].join("\n"));
  await c.reply(105);
  expect(c.replies.slice(before).map((r) => r.id)).toEqual([101, 102, 103, 104, 105]);
  const shown = (await c.reply(102)).result as unknown as ToolResult;
  expect((shown.structuredContent as { task: { holder: string } }).task.holder).toBe("haile");
  const thread = (await c.reply(105)).result as unknown as ToolResult;
  expect((thread.structuredContent as { messages: unknown[] }).messages.length).toBe(1);
  expect(await c.end()).toBe(0);
});
