// `factory board login add|ls|remove` (#504): a login of its own for each machine that uses the board from elsewhere,
// against a real Postgres. A login is a Postgres role with only the board's rights (connect, and read and write the
// board's tables); the board notes when it is first used; remove drops it and ends its connections; --unused removes it
// only if it was never used. The board's machine is a world with the board's url file and its state.json (the address
// other machines use: here 127.0.0.1 and the test server's port, so the login's URL really connects).
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { SQL } from "bun";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/index.ts";
import { freshDatabase, type Server, startServer } from "./pg.ts";

setDefaultTimeout(60_000);

const BIN = join(import.meta.dir, "..", "bin.ts");
let server: Server | null = null;
const dbs: { url: string; drop(): Promise<void> }[] = [];

beforeAll(async () => {
  server = await startServer();
}, 600_000);

afterAll(async () => {
  for (const d of dbs) await d.drop().catch(() => {});
  server?.stop();
});

interface World { dir: string; env: Record<string, string>; url: string }
interface Run { code: number; stdout: string; stderr: string }
interface Made { name: string; role: string; url: string }
interface Row { name: string; role: string; firstSeen: string | null; lastSeen: string | null; connected: boolean }

/** The board's machine: a fresh, migrated database, its url file, and state.json saying where others reach it. */
async function hub(o: { address?: string; state?: boolean } = {}): Promise<World> {
  const db = await freshDatabase(server as Server);
  dbs.push(db);
  const b = await Board.open(db.url);
  await b.migrate();
  await b.end();
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "mb-login-"));
  const dir = join(root, "cfg", "message-board");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "url"), db.url + "\n", { mode: 0o600 });
  const port = Number(new URL(db.url).port || 5432);
  if (o.state !== false) {
    writeFileSync(join(dir, "state.json"), JSON.stringify({ port, tailnetPort: port, address: o.address ?? "127.0.0.1", image: "postgres:17-alpine" }));
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("MB_") && !k.startsWith("FACTORY_")) env[k] = v;
  Object.assign(env, { HOME: root, FACTORY_CONFIG_DIR: join(root, "cfg") });
  return { dir, env, url: db.url };
}

function board(w: World, args: string[]): Run {
  const p = Bun.spawnSync([process.execPath, "--no-env-file", BIN, ...args], { env: w.env, stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: 60_000 });
  return { code: p.exitCode ?? 124, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

const err = (r: Run): { code: string; message: string; fix: string } =>
  JSON.parse(r.stderr.trim().split("\n").at(-1) as string) as { code: string; message: string; fix: string };

function add(w: World, name: string): Made {
  const r = board(w, ["login", "add", name, "--json"]);
  expect(r.code, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as Made;
}

function ls(w: World): Row[] {
  const r = board(w, ["login", "ls", "--json"]);
  expect(r.code, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as Row[];
}

async function roleExists(w: World, role: string): Promise<boolean> {
  const sql = new SQL(w.url, { max: 1 });
  try {
    return (await sql`select 1 from pg_roles where rolname = ${role}`).length > 0;
  } finally {
    await sql.close();
  }
}

/** What happens when `url` connects and runs `query`: "ok", or the error's message. */
async function tryQuery(url: string, query: string): Promise<string> {
  const sql = new SQL(url, { max: 1, connectionTimeout: 5 });
  try {
    await sql.unsafe(query);
    return "ok";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  } finally {
    await sql.close().catch(() => {});
  }
}

test("help lists the login verbs", () => {
  const r = Bun.spawnSync([process.execPath, "--no-env-file", BIN, "help"], { stdout: "pipe" });
  for (const v of ["factory board login add <name>", "factory board login ls", "factory board login remove <name>"]) expect(r.stdout.toString()).toContain(v);
});

test("add makes a login whose URL names the board's address for other machines, shown once", async () => {
  const w = await hub();
  const port = new URL(w.url).port;
  const made = add(w, "laptop");
  expect(made.name).toBe("laptop");
  const u = new URL(made.url);
  expect(`${u.hostname}:${u.port}`).toBe(`127.0.0.1:${port}`);
  expect(u.pathname).toBe(new URL(w.url).pathname);
  expect(decodeURIComponent(u.username)).toBe(made.role);
  expect(u.password.length).toBeGreaterThanOrEqual(20);
  expect(await roleExists(w, made.role)).toBe(true);
  const plain = board(w, ["login", "add", "desktop"]);
  expect(plain.code, plain.stderr).toBe(0);
  expect(plain.stdout).toContain("postgres://");
  expect(plain.stdout).toMatch(/shown once/i);
});

test("the login connects and reads and writes the board, and nothing more", async () => {
  const w = await hub();
  const made = add(w, "laptop");
  const b = await Board.open(made.url, { as: "haile" });
  try {
    const t = await b.create({ title: "From the laptop" });
    const claim = await b.claim(t.id);
    expect(claim?.task.holder).toBe("haile");
    await b.post({ task: t.id, kind: "note", body: "hello" });
    expect((await b.info()).migrations.length).toBeGreaterThan(0);
  } finally {
    await b.end();
  }
  expect(await tryQuery(made.url, "create table mine (x int)")).toMatch(/permission denied/i);
  expect(await tryQuery(made.url, "select * from mb_logins")).toMatch(/permission denied/i);
  expect(await tryQuery(made.url, "insert into mb_migrations (name) values ('999_x.sql')")).toMatch(/permission denied/i);
  expect(await tryQuery(made.url, "create role sneaky login")).toMatch(/permission denied/i);
  expect(await tryQuery(made.url, "drop table tasks")).toMatch(/must be (the )?owner|permission denied/i);
  expect(await tryQuery(made.url, "create temp table scratch (x int)")).toMatch(/permission denied/i);
});

test("the login reaches only the board's database: not postgres, not template1", async () => {
  const w = await hub();
  const made = add(w, "laptop");
  for (const other of ["postgres", "template1"]) {
    const u = new URL(made.url);
    u.pathname = `/${other}`;
    expect(await tryQuery(u.toString(), "select 1"), other).toMatch(/permission denied|not permitted/i);
  }
  expect(await tryQuery(made.url, "select 1")).toBe("ok");
});

test("ls says when each login was first used, and says so for a login connected now", async () => {
  const w = await hub();
  const a = add(w, "laptop");
  add(w, "desktop");
  let rows = ls(w);
  expect(rows.map((r) => r.name)).toEqual(["desktop", "laptop"]);
  expect(rows.every((r) => r.firstSeen === null && !r.connected)).toBe(true);
  expect(await tryQuery(a.url, "select 1")).toBe("ok");
  rows = ls(w);
  expect(rows.find((r) => r.name === "laptop")?.firstSeen).not.toBeNull();
  expect(rows.find((r) => r.name === "desktop")?.firstSeen).toBeNull();
  const held = new SQL(a.url, { max: 1 });
  try {
    await held`select 1`;
    expect(ls(w).find((r) => r.name === "laptop")?.connected).toBe(true);
  } finally {
    await held.close();
  }
  const text = board(w, ["login", "ls"]);
  expect(text.stdout).toMatch(/laptop\s.*used/);
  expect(text.stdout).toMatch(/desktop\s.*never used/);
});

test("remove drops the login and ends its connections; it can't connect again", async () => {
  const w = await hub();
  const a = add(w, "laptop");
  const held = new SQL(a.url, { max: 1 });
  await held`select 1`;
  const r = board(w, ["login", "remove", "laptop"]);
  expect(r.code, r.stderr).toBe(0);
  expect(r.stdout).toContain("laptop");
  expect(await roleExists(w, a.role)).toBe(false);
  let ended = false;
  try {
    await held`select 1`;
  } catch {
    ended = true;
  }
  await held.close().catch(() => {});
  expect(ended).toBe(true);
  expect(await tryQuery(a.url, "select 1")).not.toBe("ok");
  expect(ls(w)).toEqual([]);
  expect(err(board(w, ["login", "remove", "laptop"])).code).toBe("not-found");
});

test("remove --unused removes only a login never used", async () => {
  const w = await hub();
  const a = add(w, "laptop");
  const b = add(w, "desktop");
  expect(await tryQuery(a.url, "select 1")).toBe("ok");
  const used = board(w, ["login", "remove", "laptop", "--unused"]);
  expect(used.code).toBe(1);
  expect(err(used).code).toBe("login-used");
  expect(await roleExists(w, a.role)).toBe(true);
  expect(board(w, ["login", "remove", "desktop", "--unused"]).code).toBe(0);
  expect(await roleExists(w, b.role)).toBe(false);
});

test("add refuses a bad name and a name already used, and is safe to run twice", async () => {
  const w = await hub();
  expect(err(board(w, ["login", "add", "Bad_Name"])).code).toBe("bad-input");
  add(w, "laptop");
  const again = board(w, ["login", "add", "laptop"]);
  expect(again.code).toBe(1);
  expect(err(again).code).toBe("login-exists");
  expect(err(again).fix).toContain("factory board login remove laptop");
  expect(ls(w).length).toBe(1);
});

test("add on a machine that doesn't run the board, or whose board has no Tailscale address, is refused", async () => {
  const joined = await hub({ state: false });
  const r = board(joined, ["login", "add", "laptop"]);
  expect(r.code).toBe(1);
  expect(err(r).code).toBe("not-board-host");
  const local = await hub({ address: "" });
  const s = board(local, ["login", "add", "laptop"]);
  expect(err(s).code).toBe("no-tailscale");
  expect(err(s).fix).toContain("tailscale up");
  expect(ls(local)).toEqual([]);
});

test("a login can't make logins", async () => {
  const w = await hub();
  const a = add(w, "laptop");
  const other = await hub();
  writeFileSync(join(other.dir, "url"), a.url + "\n", { mode: 0o600 });
  const r = board(other, ["login", "add", "sneaky"]);
  expect(r.code).toBe(1);
  expect(err(r).code).toBe("no-rights");
  expect(r.stdout + r.stderr).not.toContain(new URL(a.url).password);
});
