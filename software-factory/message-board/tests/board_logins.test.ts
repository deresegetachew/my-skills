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
interface Row { name: string; role: string; firstSeen: string | null; lastSeen: string | null; connected: boolean; redeemedAt: string | null }

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

// ---------- join codes (#514): the server enforces the expiry and the one use ----------
function addFor(w: World, name: string, seconds: number): Made {
  const r = board(w, ["login", "add", name, "--valid-for", String(seconds), "--json"]);
  expect(r.code, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as Made;
}

const withPassword = (url: string, password: string): string => {
  const u = new URL(url);
  u.password = encodeURIComponent(password);
  return u.toString();
};

/** Redeems the login of `url`; the new password, or the refusal's code. */
async function redeem(url: string, keep: (password: string) => void = () => {}): Promise<{ password: string } | { code: string }> {
  let b: Board;
  try {
    b = await Board.open(url, { max: 1 });
  } catch (e) {
    return { code: (e as { code: string }).code };
  }
  try {
    let password = "";
    await b.redeemLogin((p) => {
      password = p;
      keep(p);
    });
    return { password };
  } catch (e) {
    return { code: (e as { code: string }).code };
  } finally {
    await b.end().catch(() => {});
  }
}

test("a login made with --valid-for is refused by Postgres itself once it expires", async () => {
  const w = await hub();
  const made = addFor(w, "laptop", 2);
  expect(await tryQuery(made.url, "select 1")).toBe("ok");
  await Bun.sleep(3500);
  expect(await tryQuery(made.url, "select 1")).toMatch(/password authentication failed/i);
  expect(err(board(w, ["login", "add", "desktop", "--valid-for", "0"])).code).toBe("bad-input");
});

test("redeeming a login works once: it rotates the password and lifts the expiry", async () => {
  const w = await hub();
  const made = addFor(w, "laptop", 3);
  expect(ls(w)[0]?.redeemedAt).toBeNull();
  const first = await redeem(made.url);
  if (!("password" in first)) throw new Error(`redeem refused: ${first.code}`);
  expect(first.password.length).toBeGreaterThanOrEqual(32);
  const fresh = withPassword(made.url, first.password);
  expect(await tryQuery(made.url, "select 1")).toMatch(/password authentication failed/i); // the code's password is gone
  expect(await tryQuery(fresh, "select 1")).toBe("ok");
  expect(ls(w)[0]?.redeemedAt).not.toBeNull();
  await Bun.sleep(4000);
  expect(await tryQuery(fresh, "select count(*) from tasks")).toBe("ok"); // past the code's expiry: the login is kept
  expect(await redeem(fresh)).toEqual({ code: "login-redeemed" });
  expect(await redeem(made.url)).toEqual({ code: "login-refused" });
});

test("a redeem whose keeper fails changes nothing: the code's password still works", async () => {
  const w = await hub();
  const made = addFor(w, "laptop", 60);
  const r = await redeem(made.url, () => {
    throw new Error("disk full");
  });
  expect("password" in r).toBe(false);
  expect(await tryQuery(made.url, "select 1")).toBe("ok");
  expect(ls(w)[0]?.redeemedAt).toBeNull();
  expect("password" in (await redeem(made.url))).toBe(true);
});

test("a redeem ends the other connections of the same login", async () => {
  const w = await hub();
  const made = addFor(w, "laptop", 60);
  const other = new SQL(made.url, { max: 1 });
  await other`select 1`;
  expect("password" in (await redeem(made.url))).toBe(true);
  let ended = false;
  try {
    await other`select 1`;
  } catch {
    ended = true;
  }
  await other.close().catch(() => {});
  expect(ended).toBe(true);
});

test("only a login redeems, only itself, and the redeem can't be bent to another role", async () => {
  const w = await hub();
  const a = addFor(w, "laptop", 60);
  const b = addFor(w, "desktop", 60);
  expect(await redeem(w.url)).toEqual({ code: "not-found" }); // the board's own user isn't a login
  expect(await tryQuery(a.url, `alter role "${b.role}" password 'taken'`)).toMatch(/permission denied/i);
  expect(await tryQuery(a.url, `alter role "${a.role}" valid until 'infinity'`)).toMatch(/permission denied/i);
  expect(await tryQuery(a.url, "set role postgres")).not.toBe("ok");
  expect("password" in (await redeem(a.url))).toBe(true);
  expect(await tryQuery(b.url, "select 1")).toBe("ok"); // the other login is untouched
  const sql = new SQL(w.url, { max: 1 });
  try {
    const [f] = (await sql`select p.prosecdef, p.proconfig, r.rolsuper,
        has_function_privilege('public', p.oid, 'execute') as public_may
      from pg_proc p join pg_roles r on r.oid = p.proowner where p.proname = 'mb_redeem_login'`) as
      { prosecdef: boolean; proconfig: string[]; rolsuper: boolean; public_may: boolean }[];
    expect(f?.prosecdef).toBe(true);
    expect(f?.rolsuper).toBe(true);
    expect(f?.proconfig.some((c) => c.startsWith("search_path=pg_catalog"))).toBe(true);
    expect(f?.public_may).toBe(false);
  } finally {
    await sql.close();
  }
});

test("remove --unredeemed drops a login that connected but never redeemed, and keeps a redeemed one", async () => {
  const w = await hub();
  const a = addFor(w, "laptop", 60);
  const b = addFor(w, "desktop", 60);
  expect(await tryQuery(a.url, "select 1")).toBe("ok"); // used, not redeemed
  expect(board(w, ["login", "remove", "laptop", "--unredeemed"]).code).toBe(0);
  expect(await roleExists(w, a.role)).toBe(false);
  expect("password" in (await redeem(b.url))).toBe(true);
  const kept = board(w, ["login", "remove", "desktop", "--unredeemed"]);
  expect(kept.code).toBe(1);
  expect(err(kept).code).toBe("login-redeemed");
  expect(await roleExists(w, b.role)).toBe(true);
});

test("a refused login says to ask the hub for a new code, not to start the board", async () => {
  const w = await hub();
  const a = add(w, "laptop");
  expect(board(w, ["login", "remove", "laptop"]).code).toBe(0);
  const joined = await hub({ state: false });
  writeFileSync(join(joined.dir, "url"), a.url + "\n", { mode: 0o600 });
  const s = board(joined, ["status"]);
  expect(s.code).toBe(1);
  expect(s.stdout).toContain("This machine's board login was refused (removed or expired).");
  expect(s.stdout).toContain("factory machine add <name> --agent ...");
  expect(s.stdout).toContain("factory machine leave");
  expect(s.stdout).not.toContain("factory board up");
  expect(s.stdout).not.toContain(new URL(a.url).password);
  const t = board(joined, ["tasks"]);
  expect(err(t).code).toBe("login-refused");
  expect(err(t).fix).toContain("factory machine leave");
});
