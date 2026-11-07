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
import { pausedLogin } from "./scram_pause.ts";

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

/** Seconds until `role` stops being able to log in, by the server's clock (its VALID UNTIL); Infinity when it has none. */
async function secondsLeft(w: World, role: string): Promise<number> {
  const sql = new SQL(w.url, { max: 1 });
  try {
    const [r] = (await sql`select rolvaliduntil is null or rolvaliduntil = 'infinity' as never,
      extract(epoch from rolvaliduntil - now())::float8 as left from pg_roles where rolname = ${role}`) as { never: boolean; left: number }[];
    if (!r) throw new Error(`no role ${role}`);
    return r.never ? Infinity : r.left;
  } finally {
    await sql.close();
  }
}

/** Moves `role`'s VALID UNTIL (what --valid-for set, and what Postgres and the sweep check) a minute into the past, as
 * the board's own user: the expiry arrives now instead of after a sleep that a slow machine can outrun (#525). */
async function expire(w: World, role: string): Promise<void> {
  const sql = new SQL(w.url, { max: 1 });
  try {
    const [r] = (await sql`select (now() - interval '1 minute')::text as t`) as { t: string }[];
    await sql.unsafe(`alter role "${role}" valid until '${r?.t}'`);
  } finally {
    await sql.close();
  }
  expect(await secondsLeft(w, role)).toBeLessThan(0);
}

/** `url` as the login `role` with `password`. */
const withLogin = (url: string, role: string, password: string): string => {
  const u = new URL(url);
  u.username = encodeURIComponent(role);
  u.password = encodeURIComponent(password);
  return u.toString();
};

/** Redeems the login of `url`; its new role and password, or the refusal's code. */
async function redeem(url: string, keep: (login: { role: string; password: string }) => Promise<void> | void = () => {}):
  Promise<{ role: string; password: string } | { code: string }> {
  let b: Board;
  try {
    b = await Board.open(url, { max: 1 });
  } catch (e) {
    return { code: (e as { code: string }).code };
  }
  try {
    let got = { role: "", password: "" };
    await b.redeemLogin((l) => {
      got = l;
      return keep(l);
    });
    return got;
  } catch (e) {
    return { code: (e as { code: string }).code };
  } finally {
    await b.end().catch(() => {});
  }
}

test("a login made with --valid-for is refused by Postgres itself once it expires", async () => {
  const w = await hub();
  const made = addFor(w, "laptop", 600);
  const left = await secondsLeft(w, made.role); // --valid-for sets the role's expiry, by the server's clock
  expect(left).toBeLessThanOrEqual(600);
  expect(left).toBeGreaterThan(600 - 120);
  expect(await tryQuery(made.url, "select 1")).toBe("ok");
  await expire(w, made.role);
  expect(await tryQuery(made.url, "select 1")).toMatch(/password authentication failed/i);
  expect(err(board(w, ["login", "add", "desktop", "--valid-for", "0"])).code).toBe("bad-input");
});

test("redeeming a login works once: it rotates the password and lifts the expiry", async () => {
  const w = await hub();
  const made = addFor(w, "laptop", 600);
  expect(ls(w)[0]?.redeemedAt).toBeNull();
  const first = await redeem(made.url);
  if (!("password" in first)) throw new Error(`redeem refused: ${first.code}`);
  expect(first.password.length).toBeGreaterThanOrEqual(32);
  expect(first.role).not.toBe(made.role); // a fresh role: the code's own can only ever change its own password
  const fresh = withLogin(made.url, first.role, first.password);
  expect(await tryQuery(made.url, "select 1")).toMatch(/not permitted to log in/i); // the code's role can't log in any more
  expect(await tryQuery(fresh, "select 1")).toBe("ok");
  expect(ls(w)[0]?.redeemedAt).not.toBeNull();
  // The login is kept past the code's expiry: the fresh role has none (Postgres lets it log in at any time to come).
  expect(await secondsLeft(w, first.role)).toBe(Infinity);
  expect(await tryQuery(fresh, "select count(*) from tasks")).toBe("ok");
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
  expect(ls(w).map((l) => l.name)).toEqual(["desktop"]);
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

test("a session that connected during the redeem and survived the commit is ended before the redeem returns", async () => {
  const w = await hub();
  const made = addFor(w, "laptop", 60);
  const copy = new SQL(made.url, { max: 1 });
  let connected = false;
  const r = await redeem(made.url, async () => {
    await copy`select 1`; // a copy of the code connects while the redeem's transaction is open
    connected = true;
  });
  expect(connected).toBe(true);
  expect("password" in r).toBe(true);
  let ended = false;
  try {
    await copy`select 1`;
  } catch {
    ended = true;
  }
  await copy.close().catch(() => {});
  expect(ended).toBe(true);
});

test("a redeem whose new password doesn't work after the commit says the code may have been copied", async () => {
  const w = await hub();
  const made = addFor(w, "laptop", 60);
  await stealOnRedeem(w.url);
  expect(await redeem(made.url)).toEqual({ code: "login-compromised" });
});

/** As if a copy of the code changed the login's password just as it was redeemed: a trigger on the board's record of
 * logins sets another password in the redeem's own transaction. */
async function stealOnRedeem(url: string): Promise<void> {
  const sql = new SQL(url, { max: 1 });
  try {
    await sql.unsafe(`create or replace function steal() returns trigger language plpgsql security definer as $f$
      begin execute format('alter role %I password %L', new.role, 'stolen-password'); return new; end $f$`);
    await sql.unsafe("create trigger steal after update of redeemed_at on mb_logins for each row execute function steal()");
  } finally {
    await sql.close();
  }
}

test("board sweep drops a join code's login that expired unredeemed and ends its sessions; others are kept", async () => {
  const w = await hub();
  const late = addFor(w, "laptop", 600);
  const live = addFor(w, "desktop", 600);
  const joined = addFor(w, "tablet", 600);
  const plain = add(w, "phone");
  const redeemed = await redeem(joined.url);
  if (!("role" in redeemed)) throw new Error(`redeem refused: ${redeemed.code}`);
  const held = new SQL(late.url, { max: 1 });
  await held`select 1`;
  await expire(w, late.role);
  await expire(w, joined.role); // the redeemed code's own expiry passes too
  let still = true;
  try {
    await held`select 1`; // VALID UNTIL is checked only when connecting: the session outlives it until a sweep
  } catch {
    still = false;
  }
  expect(still).toBe(true);
  const r = board(w, ["sweep"]);
  expect(r.code, r.stderr).toBe(0);
  expect(r.stdout).toContain("laptop");
  expect(await roleExists(w, late.role)).toBe(false);
  let ended = false;
  try {
    await held`select 1`;
  } catch {
    ended = true;
  }
  await held.close().catch(() => {});
  expect(ended).toBe(true);
  for (const kept of [live.role, redeemed.role, plain.role]) expect(await roleExists(w, kept)).toBe(true);
  expect(await roleExists(w, joined.role)).toBe(false); // the spent code's role goes too
  expect(ls(w).map((l) => l.name)).toEqual(["desktop", "phone", "tablet"]);
});

test("a login that starts its handshake with the code's password before the redeem and finishes after is refused", async () => {
  const w = await hub();
  const made = addFor(w, "laptop", 60);
  const copy = await pausedLogin(made.url); // Postgres has read the code's password; the login isn't in pg_stat_activity yet
  const r = await redeem(made.url);
  if (!("role" in r)) throw new Error(`redeem refused: ${r.code}`);
  expect(await copy.finish(`alter role "${made.role}" password 'evil'`)).toMatch(/not permitted to log in/i);
  expect(await tryQuery(withLogin(made.url, r.role, r.password), "select count(*) from tasks")).toBe("ok");
});

test("after the redeem the code's role can't log in at all, and the next ls on the hub drops it", async () => {
  const w = await hub();
  const made = addFor(w, "laptop", 60);
  const r = await redeem(made.url);
  if (!("role" in r)) throw new Error(`redeem refused: ${r.code}`);
  expect(await tryQuery(made.url, "select 1")).toMatch(/not permitted to log in/i);
  expect(ls(w).map((l) => [l.name, l.role])).toEqual([["laptop", r.role]]);
  expect(await roleExists(w, made.role)).toBe(false);
  expect(board(w, ["login", "remove", "laptop"]).code).toBe(0); // remove drops the login's current role
  expect(await roleExists(w, r.role)).toBe(false);
  expect(await tryQuery(withLogin(made.url, r.role, r.password), "select 1")).not.toBe("ok");
});

// ---------- a login that owns something (#514 review 3): any role may make a large object or set its default privileges
/** What any role may do without CREATE, so that DROP ROLE alone fails on it. */
/** A login of `url` that owns something: default privileges it set itself, and a large object it owns (made by the
 * board's user and given to it, as a login can't make one since #514's review 7). The large object's oid. */
async function poison(w: World, url: string): Promise<number> {
  expect(await tryQuery(url, "alter default privileges grant select on tables to public")).toBe("ok");
  const role = decodeURIComponent(new URL(url).username);
  const sql = new SQL(w.url, { max: 1 });
  try {
    const [o] = (await sql`select lo_create(0)::int as oid`) as { oid: number }[];
    await sql.unsafe(`alter large object ${o?.oid} owner to "${role}"`);
    return o?.oid as number;
  } finally {
    await sql.close();
  }
}

async function largeObjects(w: World, oids: number[]): Promise<number> {
  const sql = new SQL(w.url, { max: 1 });
  try {
    let n = 0;
    for (const oid of oids) n += ((await sql`select 1 from pg_largeobject_metadata where oid = ${oid}`) as unknown[]).length;
    return n;
  } finally {
    await sql.close();
  }
}

test("a login that made a large object and set default privileges is still removed, and ls goes on for the others", async () => {
  const w = await hub();
  const a = add(w, "laptop");
  add(w, "desktop");
  const lo = await poison(w, a.url);
  expect(ls(w).map((l) => l.name)).toEqual(["desktop", "laptop"]);
  const r = board(w, ["login", "remove", "laptop"]);
  expect(r.code, r.stderr).toBe(0);
  expect(await roleExists(w, a.role)).toBe(false);
  expect(await largeObjects(w, [lo])).toBe(0); // what it owned went with it
  expect(ls(w).map((l) => l.name)).toEqual(["desktop"]);
});

test("a code role poisoned before the redeem is dropped by the next ls, and the redeemed login can still be removed", async () => {
  const w = await hub();
  const made = addFor(w, "laptop", 60);
  add(w, "desktop");
  const los = [await poison(w, made.url)];
  const r = await redeem(made.url);
  if (!("role" in r)) throw new Error(`redeem refused: ${r.code}`);
  los.push(await poison(w, withLogin(made.url, r.role, r.password))); // the fresh role too
  const listed = board(w, ["login", "ls", "--json"]);
  expect(listed.code, listed.stderr).toBe(0);
  expect((JSON.parse(listed.stdout) as Row[]).map((l) => l.name)).toEqual(["desktop", "laptop"]);
  expect(await roleExists(w, made.role)).toBe(false);
  const gone = board(w, ["login", "remove", "laptop"]);
  expect(gone.code, gone.stderr).toBe(0);
  expect(await roleExists(w, r.role)).toBe(false);
  expect(await largeObjects(w, los)).toBe(0);
});

test("the sweep drops a poisoned expired login and ends its held session", async () => {
  const w = await hub();
  const late = addFor(w, "laptop", 600);
  const other = addFor(w, "desktop", 600);
  const lo = await poison(w, late.url);
  const held = new SQL(late.url, { max: 1 });
  await held`select 1`;
  await expire(w, late.role);
  await expire(w, other.role);
  const r = board(w, ["sweep"]);
  expect(r.code, r.stderr).toBe(0);
  expect(await roleExists(w, late.role)).toBe(false);
  expect(await largeObjects(w, [lo])).toBe(0);
  expect(await roleExists(w, other.role)).toBe(false);
  let ended = false;
  try {
    await held`select 1`;
  } catch {
    ended = true;
  }
  await held.close().catch(() => {});
  expect(ended).toBe(true);
});

// ---------- a remove that crosses a redeem (#514 review 4) ----------
/** Every role of the login made from \`codeRole\` (the code's and any fresh one): their names. */
async function rolesOf(w: World, codeRole: string): Promise<string[]> {
  const sql = new SQL(w.url, { max: 1 });
  try {
    return ((await sql`select rolname from pg_roles where rolname = ${codeRole} or rolname like ${`${codeRole}\\_%`}`) as { rolname: string }[])
      .map((r) => r.rolname);
  } finally {
    await sql.close();
  }
}

test("a remove that waits on a redeem in progress drops the fresh role the redeem made too", async () => {
  const w = await hub();
  const made = addFor(w, "laptop", 60);
  const copy = new SQL(made.url, { max: 1 });
  const tx = await copy.reserve();
  await tx`begin`;
  await tx`select * from mb_redeem_login()`; // holds the login's row
  const remove = Bun.spawn([process.execPath, "--no-env-file", BIN, "login", "remove", "laptop"], { env: w.env, stdout: "pipe", stderr: "pipe" });
  await Bun.sleep(1500); // the remove reads the row and waits for it, or (since #514 review 6) cuts the code off first
  try {
    await tx`commit`; // and ends this session, which rolls the redeem back: then the commit fails
  } catch {
    // ended by the remove
  }
  tx.release();
  const code = await remove.exited;
  expect(code, await new Response(remove.stderr).text()).toBe(0);
  expect(await rolesOf(w, made.role)).toEqual([]);
  const admin = new SQL(w.url, { max: 1 });
  try { // no session of a dropped role is left on this database (the copy's included)
    const [left] = (await admin`select count(*)::int as n from pg_stat_activity where datname = current_database()
      and usesysid is not null and usesysid not in (select oid from pg_roles)`) as { n: number }[];
    expect(left?.n).toBe(0);
  } finally {
    await admin.close();
  }
  let ended = false;
  try {
    await copy`select 1`;
  } catch {
    ended = true;
  }
  await copy.close().catch(() => {});
  expect(ended).toBe(true);
  expect(ls(w)).toEqual([]);
});

test("a session of the code's role that predates its NOLOGIN can't redeem", async () => {
  const w = await hub();
  const made = addFor(w, "laptop", 60);
  const b = await Board.open(made.url, { max: 1 });
  try {
    const admin = new SQL(w.url, { max: 1 });
    try {
      await admin.unsafe(`alter role "${made.role}" nologin`); // as a remove's first step does
    } finally {
      await admin.close();
    }
    let code = "";
    try {
      await b.redeemLogin(() => {});
    } catch (e) {
      code = (e as { code: string }).code;
    }
    expect(code).toBe("login-expired");
  } finally {
    await b.end().catch(() => {});
  }
  expect(await rolesOf(w, made.role)).toEqual([made.role]); // no fresh role was made
});

test("a redeem held open by a copy of the code doesn't stall login remove: it ends that session and removes the login", async () => {
  const w = await hub();
  const made = addFor(w, "laptop", 60);
  add(w, "desktop");
  const copy = new SQL(made.url, { max: 1 });
  const tx = await copy.reserve();
  await tx`begin`;
  await tx`select * from mb_redeem_login()`; // holds the login's row and never commits
  const started = Date.now();
  const r = board(w, ["login", "remove", "laptop"]);
  expect(r.code, r.stderr).toBe(0);
  expect(Date.now() - started).toBeLessThan(20_000);
  let ended = false;
  try {
    await tx`commit`;
    await tx`select 1`;
  } catch {
    ended = true;
  }
  tx.release();
  await copy.close().catch(() => {});
  expect(ended).toBe(true);
  expect(await rolesOf(w, made.role)).toEqual([]);
  expect(ls(w).map((l) => l.name)).toEqual(["desktop"]);
});

// ---------- an unredeemed code can do almost nothing (#514 review 6) ----------
test("a code's role can only connect and redeem: no board tables, no advisory locks; the fresh role can use the board", async () => {
  const w = await hub();
  const made = addFor(w, "laptop", 60);
  expect(await tryQuery(made.url, "select 1")).toBe("ok");
  for (const q of ["select count(*) from tasks", "insert into tasks (title) values ('x')", "select * from mb_locks", "select pg_advisory_lock(4891009)",
    "select pg_advisory_xact_lock(4891008)", "select pg_try_advisory_lock(1)"]) {
    expect(await tryQuery(made.url, q), q).toMatch(/permission denied/i);
  }
  const r = await redeem(made.url);
  if (!("role" in r)) throw new Error(`redeem refused: ${r.code}`);
  const fresh = withLogin(made.url, r.role, r.password);
  expect(await tryQuery(fresh, "select count(*) from tasks")).toBe("ok");
  expect(await tryQuery(fresh, "select * from mb_locks")).toMatch(/permission denied/i);
  expect(await redeem(fresh)).toEqual({ code: "login-redeemed" });
});

test("a plain login can't redeem: only a join code's role can", async () => {
  const w = await hub();
  const plain = add(w, "laptop");
  expect(await redeem(plain.url)).toEqual({ code: "not-found" });
});

test("a holder that reconnects in a loop and re-runs a redeem it never commits can't keep login remove from finishing", async () => {
  const w = await hub();
  const made = addFor(w, "laptop", 120);
  let stop = false;
  let held = 0;
  const loop = (async () => {
    while (!stop) {
      const c = new SQL(made.url, { max: 1, connectionTimeout: 2 });
      try {
        const t = await c.reserve();
        await t`begin`;
        await t`select * from mb_redeem_login()`;
        held++;
        await t`select pg_sleep(30)`;
      } catch {
        // ended, or refused
      } finally {
        await c.close().catch(() => {});
      }
      await Bun.sleep(20);
    }
  })();
  while (held === 0) await Bun.sleep(50);
  const started = Date.now();
  const p = Bun.spawn([process.execPath, "--no-env-file", BIN, "login", "remove", "laptop"], { env: w.env, stdout: "pipe", stderr: "pipe" });
  const code = await p.exited;
  const took = Date.now() - started;
  stop = true;
  await loop;
  expect(code, await new Response(p.stderr).text()).toBe(0);
  expect(took).toBeLessThan(30_000);
  expect(await rolesOf(w, made.role)).toEqual([]);
  expect(await tryQuery(made.url, "select 1")).not.toBe("ok");
  expect(ls(w)).toEqual([]);
});

test("a login holding the advisory locks the board once used doesn't affect login add, remove, ls, sweep or migrate", async () => {
  const w = await hub();
  const plain = add(w, "laptop");
  const holder = new SQL(plain.url, { max: 1 });
  try {
    await holder`select pg_advisory_lock(4891008), pg_advisory_lock(4891007)`;
    const started = Date.now();
    for (const args of [["login", "add", "desktop", "--valid-for", "60"], ["login", "ls"], ["login", "remove", "desktop"], ["sweep"], ["migrate"]]) {
      const r = board(w, args);
      expect(r.code, `${args.join(" ")}: ${r.stderr}`).toBe(0);
    }
    expect(Date.now() - started).toBeLessThan(30_000);
  } finally {
    await holder.close();
  }
});

// ---------- #514 review 7 ----------
test("neither a code's role nor a login may make large objects", async () => {
  const w = await hub();
  const code = addFor(w, "laptop", 60);
  const plain = add(w, "desktop");
  const r = await redeem(code.url);
  if (!("role" in r)) throw new Error(`redeem refused: ${r.code}`);
  const other = addFor(w, "tablet", 60);
  for (const url of [other.url, plain.url, withLogin(code.url, r.role, r.password)]) {
    for (const q of ["select lo_create(0)", "select lo_creat(-1)", "select lo_from_bytea(0, 'x')", "select lo_put(1, 0, 'x')"]) {
      expect(await tryQuery(url, q), q).toMatch(/permission denied/i);
    }
  }
});

test("a code used on more connections than it allows is refused as possibly copied, not as a board that doesn't answer", async () => {
  const w = await hub();
  const made = addFor(w, "laptop", 60);
  const held = [new SQL(made.url, { max: 1 }), new SQL(made.url, { max: 1 })];
  try {
    for (const h of held) await h`select 1`;
    let e: { code?: string; message?: string; fix?: string } = {};
    try {
      const b = await Board.open(made.url, { max: 1 });
      await b.end();
    } catch (x) {
      e = x as typeof e;
    }
    expect(e.code).toBe("login-in-use");
    expect(e.message).toMatch(/may have been copied/);
    expect(e.fix).toContain("factory machine remove");
    expect(e.fix).toContain("factory machine add");
  } finally {
    for (const h of held) await h.close().catch(() => {});
  }
});

test("login changes at the same moment don't trip over each other", async () => {
  const w = await hub();
  for (let round = 0; round < 3; round++) {
    const names = ["a", "b", "c", "d"].map((x) => `${x}${round}`);
    for (const n of names.slice(0, 2)) addFor(w, n, 60);
    const runs = [
      ["login", "remove", names[0] as string], ["login", "remove", names[1] as string],
      ["login", "add", names[2] as string, "--valid-for", "60"], ["login", "add", names[3] as string, "--valid-for", "60"],
    ].map((args) => Bun.spawn([process.execPath, "--no-env-file", BIN, ...args], { env: w.env, stdout: "pipe", stderr: "pipe" }));
    for (const p of runs) expect(await p.exited, await new Response(p.stderr).text()).toBe(0);
    for (const n of names.slice(2)) expect(board(w, ["login", "remove", n]).code).toBe(0);
  }
  expect(ls(w)).toEqual([]);
});

test("login add on several boards of one server at once: all succeed (shared catalog rows are written only when needed)", async () => {
  for (let round = 0; round < 3; round++) {
    const hubs = await Promise.all([1, 2, 3, 4, 5, 6].map(() => hub()));
    const runs = hubs.flatMap((w) => [["login", "add", "laptop", "--valid-for", "60"], ["login", "add", "desktop"]]
      .map((args) => Bun.spawn([process.execPath, "--no-env-file", BIN, ...args], { env: w.env, stdout: "pipe", stderr: "pipe" })));
    for (const p of runs) expect(await p.exited, await new Response(p.stderr).text()).toBe(0);
    const removes = hubs.map((w) => Bun.spawn([process.execPath, "--no-env-file", BIN, "login", "remove", "laptop"], { env: w.env, stdout: "pipe", stderr: "pipe" }));
    for (const p of removes) expect(await p.exited, await new Response(p.stderr).text()).toBe(0);
  }
});
