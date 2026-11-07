// `factory machine add|join|ls|remove` (#445, #504): the machine that runs the message board makes a join code for a
// new machine, and the machine uses it. The code carries a board login of the machine's own (a Postgres role with only
// the board's rights), made with `factory board login add`; `machine remove` drops it, and a login whose code expired
// before its machine connected is dropped by the hub.
//
// Two worlds against a real Postgres: the hub (its board's url file and state.json, the address other machines use
// being 127.0.0.1 and the test server's port, so a joined machine really connects) and a new machine (own HOME, config
// folder and git repo). `tailscale` is a fake on PATH. What is checked is what a person sees: output, exit codes, files
// written with their modes, and what the board's database says (the roles, and what a login can do). The code is opaque.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { SQL } from "bun";
import { existsSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Board } from "../message-board/src/index.ts";
import { freshDb, type Pg, startPg } from "./board_pg.ts";
import { read, runHook, SF, sh, type Proc, tmp, write, writeExe } from "./support.ts";

setDefaultTimeout(120_000);

const FAKE_TAILSCALE = `#!/usr/bin/env bash
[ "$*" = "ip -4" ] || exit 2
[ -n "\${FAKE_TS_IP:-}" ] || { echo "Tailscale is stopped." >&2; exit 1; }
echo "$FAKE_TS_IP"
`;

type Env = Record<string, string | undefined>;
interface World { d: string; root: string; env: Env; cfg: string; board: string; url: string }
interface Opts { tailscale?: boolean; ip?: string | null }

const NOW = 1_800_000_000;
const LATER = NOW + 16 * 60;

let pg: Pg;
const dbs: { url: string; drop(): Promise<void> }[] = [];

beforeAll(async () => {
  pg = await startPg();
}, 600_000);

afterAll(async () => {
  for (const d of dbs) await d.drop().catch(() => {});
  pg?.stop();
}, 120_000);

function world(o: Opts = {}): World {
  const root = tmp("mjoin-");
  const d = join(root, "work");
  const bin = join(root, "bin");
  sh(["git", "init", "-q", "-b", "main", d]);
  sh(["git", "-C", d, "remote", "add", "origin", "git@github.com:acme/Widget.git"]);
  write(join(d, ".claude", "factory.json"), JSON.stringify({}));
  mkdirSync(bin, { recursive: true });
  if (o.tailscale !== false) writeExe(join(bin, "tailscale"), FAKE_TAILSCALE);
  let path = `${bin}:${process.env.PATH}`;
  if (o.tailscale === false) { // a tailscale on this machine's PATH must not leak in
    for (const t of ["git", "bash", "sh", "env", "uname", "dirname", "basename", "cat", "mkdir", "chmod", "rm", "mv", "cp", "ls", "sleep", "head", "tr", "date", "sed", "grep", "awk"]) {
      const found = Bun.which(t);
      if (found && !existsSync(join(bin, t))) symlinkSync(found, join(bin, t));
    }
    symlinkSync(process.execPath, join(bin, "bun"));
    path = bin;
  }
  const env: Env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("FACTORY_") && !k.startsWith("CLAUDE") && !k.startsWith("MB_")) env[k] = v;
  const cfg = join(root, "cfg");
  Object.assign(env, { PATH: path, HOME: root, FACTORY_CONFIG_DIR: cfg, FACTORY_NOW: String(NOW) });
  const ip = o.ip === undefined ? "100.64.0.7" : o.ip;
  if (ip) env.FAKE_TS_IP = ip;
  return { d, root, env, cfg, board: join(cfg, "message-board"), url: "" };
}

/** The machine that runs the board: a fresh, migrated database, its url file, and state.json (the address other
 * machines use; "" when Tailscale wasn't up when the board started). */
async function hub(o: Opts & { address?: string } = {}): Promise<World> {
  const db = await freshDb(pg);
  dbs.push(db);
  const b = await Board.open(db.url);
  await b.migrate();
  await b.end();
  const w = world(o);
  const port = Number(new URL(db.url).port || 5432);
  write(join(w.board, "url"), db.url + "\n", 0o600);
  write(join(w.board, "state.json"), JSON.stringify({ port, tailnetPort: port, address: o.address ?? "127.0.0.1", image: "postgres:17-alpine" }));
  return { ...w, url: db.url };
}

const machine = (w: World, args: string[], extra: Env = {}): Proc =>
  runHook("factory_machine", args, { cwd: w.d, env: { ...w.env, ...extra }, timeoutMs: 90_000 });

interface Added { name: string; code: string; expiresAt: number; agents: { name: string; role: string }[]; command: string }
function add(w: World, name: string, agents = ["haile", "taytu:manager"], extra: string[] = [], env: Env = {}): Added {
  const p = machine(w, ["add", name, ...agents.flatMap((a) => ["--agent", a]), ...extra, "--json"], env);
  expect(p.code, p.out).toBe(0);
  return JSON.parse(p.stdout) as Added;
}

const mode = (path: string): number => statSync(path).mode & 0o777;
function error(p: Proc): { code: string; message: string; fix: string } {
  return JSON.parse(p.stderr.trim().split("\n").at(-1) as string) as { code: string; message: string; fix: string };
}
function refused(p: Proc, code: string): { code: string; message: string; fix: string } {
  expect(p.code, p.out).toBe(1);
  expect(error(p).code).toBe(code);
  return error(p);
}

/** The board logins on the hub's database (the roles' names, from the board's own record). */
async function logins(w: World): Promise<{ name: string; role: string }[]> {
  const sql = new SQL(w.url, { max: 1 });
  try {
    const exists = (await sql`select to_regclass('mb_logins') is not null as ok`)[0] as { ok: boolean };
    if (!exists.ok) return [];
    return (await sql`select name, role from mb_logins order by name`) as { name: string; role: string }[];
  } finally {
    await sql.close();
  }
}

async function roles(w: World): Promise<string[]> {
  const db = new URL(w.url).pathname.slice(1);
  const sql = new SQL(w.url, { max: 1 });
  try {
    const rows = (await sql`select rolname from pg_roles order by rolname`) as { rolname: string }[];
    return rows.map((r) => r.rolname).filter((n) => n.startsWith(`${db}_l_`));
  } finally {
    await sql.close();
  }
}

/** Whether `url` connects and answers. */
async function connects(url: string): Promise<boolean> {
  const sql = new SQL(url, { max: 1, connectionTimeout: 5 });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.close().catch(() => {});
  }
}

const urlFile = (m: World): string => join(m.board, "url");

/** The board URL a join code carries (the code is the secret a test made, read here to try it directly). */
function codeUrl(code: string): string {
  return (JSON.parse(Buffer.from(code.slice(4), "base64url").toString("utf8")) as { url: string }).url;
}

function withUrl(code: string, url: string): string {
  const p = JSON.parse(Buffer.from(code.slice(4), "base64url").toString("utf8")) as { url: string };
  return `FM1-${Buffer.from(JSON.stringify({ ...p, url }), "utf8").toString("base64url")}`;
}

// ---------- add ----------
test("add on a machine with no board is refused and says to start one", () => {
  const w = world();
  const p = machine(w, ["add", "laptop", "--agent", "haile"]);
  expect(refused(p, "no-board").fix).toContain("factory board up");
});

test("add on a machine that uses another's board, or whose board has no Tailscale address, is refused", async () => {
  const joined = await hub();
  rmSync(join(joined.board, "state.json"));
  refused(machine(joined, ["add", "laptop", "--agent", "haile"]), "not-board-host");
  const local = await hub({ address: "" });
  expect(refused(machine(local, ["add", "laptop", "--agent", "haile"]), "no-tailscale").fix).toContain("tailscale up");
  expect(await logins(local)).toEqual([]);
});

test("add refuses a bad name, no agents, a bad role and a name already in use", async () => {
  const w = await hub();
  refused(machine(w, ["add", "Bad_Name", "--agent", "haile"]), "bad-name");
  refused(machine(w, ["add", "-x", "--agent", "haile"]), "bad-name");
  refused(machine(w, ["add", "laptop"]), "no-agents");
  refused(machine(w, ["add", "laptop", "--agent", "haile:boss"]), "bad-role");
  expect(machine(w, ["add", "laptop", "--agent", "haile"]).code).toBe(0);
  const fix = refused(machine(w, ["add", "laptop", "--agent", "tewodros"]), "machine-exists").fix;
  expect(fix).toContain("factory machine remove");
  expect((await logins(w)).map((l) => l.name)).toEqual(["laptop"]);
});

test("add makes the machine's board login, saves a record, and prints the join code and the command to run", async () => {
  const w = await hub();
  const p = machine(w, ["add", "laptop", "--agent", "haile", "--agent", "taytu:manager"]);
  expect(p.code, p.out).toBe(0);
  const codeLine = p.stdout.split("\n").find((l) => l.startsWith("FM1-"));
  expect(codeLine).toBeTruthy();
  expect(p.stdout).toContain(`factory machine join ${codeLine}`);
  expect(p.stdout).toMatch(/expires in 15 min/);
  expect(p.stdout).toMatch(/board login is removed/);
  expect((await logins(w)).map((l) => l.name)).toEqual(["laptop"]);
  expect((await roles(w)).length).toBe(1);
  expect(mode(join(w.cfg, "machines.json"))).toBe(0o600);
});

test("add --json prints name, code, expiry (default 15 minutes), agents and the command; --ttl and FACTORY_NOW move it", async () => {
  const w = await hub();
  const a = add(w, "laptop");
  expect(a.name).toBe("laptop");
  expect(a.code).toStartWith("FM1-");
  expect(a.expiresAt).toBe(NOW + 15 * 60);
  expect(a.agents).toEqual([{ name: "haile", role: "builder" }, { name: "taytu", role: "manager" }]);
  expect(a.command).toBe(`factory machine join ${a.code}`);
  const b = add(w, "desktop", ["tewodros"], ["--ttl", "60"], { FACTORY_NOW: String(NOW + 100) });
  expect(b.expiresAt).toBe(NOW + 100 + 3600);
  expect(a.code).not.toBe(b.code);
});

test("an agent another machine already runs is refused and no login is made", async () => {
  const w = await hub();
  add(w, "laptop");
  refused(machine(w, ["add", "desktop", "--agent", "haile"]), "agent-taken");
  refused(machine(w, ["add", "desktop", "--agent", "tewodros", "--agent", "tewodros"]), "agent-taken");
  expect((await logins(w)).map((l) => l.name)).toEqual(["laptop"]);
  expect(machine(w, ["remove", "laptop"]).code).toBe(0);
  expect(machine(w, ["add", "desktop", "--agent", "haile"]).code).toBe(0); // free again after remove
});

test("add that can't write the machine's record drops the login it made", async () => {
  const w = await hub();
  mkdirSync(join(w.cfg, "machines.json"), { recursive: true }); // a folder where the records go: the write fails
  const p = machine(w, ["add", "laptop", "--agent", "haile"]);
  expect(p.code, p.out).toBe(1);
  expect(error(p).code).toBe("record-failed");
  expect(await logins(w)).toEqual([]);
  expect(await roles(w)).toEqual([]);
});

// ---------- join ----------
test("join refuses text that is not a code", () => {
  const m = world();
  refused(machine(m, ["join", "garbage"]), "bad-code");
  refused(machine(m, ["join", "XX9-abcdef"]), "bad-code");
  expect(existsSync(m.board)).toBe(false);
});

test("join with an expired code says to run add on the hub and writes nothing", async () => {
  const h = await hub();
  const a = add(h, "laptop");
  const m = world();
  const p = machine(m, ["join", a.code], { FACTORY_NOW: String(LATER) });
  expect(refused(p, "code-expired").fix).toContain("factory machine add");
  expect(existsSync(m.board)).toBe(false);
});

test("join writes the board's URL for the machine's login (folder 700, file 600) and the login uses the board", async () => {
  const h = await hub();
  const a = add(h, "laptop");
  const m = world();
  const p = machine(m, ["join", a.code, "--no-doctor"]);
  expect(p.code, p.out).toBe(0);
  expect(mode(m.board)).toBe(0o700);
  expect(mode(urlFile(m))).toBe(0o600);
  const url = read(urlFile(m)).trim();
  const [login] = await logins(h);
  expect(decodeURIComponent(new URL(url).username)).toBe(login?.role as string);
  expect(p.stdout).toContain("laptop");
  expect(p.stdout).toContain(urlFile(m));
  expect(p.out).not.toContain(new URL(url).password);
  const b = await Board.open(url, { as: "haile" });
  try {
    const t = await b.create({ title: "Made on the laptop" });
    expect((await b.claim(t.id))?.task.holder).toBe("haile");
  } finally {
    await b.end();
  }
  const shown = machine(m, ["show"]);
  expect(shown.out).toContain("haile");
  expect(shown.out).toContain("taytu");
});

test("the machine's login has only the board's rights", async () => {
  const h = await hub();
  const a = add(h, "laptop");
  const m = world();
  expect(machine(m, ["join", a.code, "--no-doctor"]).code).toBe(0);
  const sql = new SQL(read(urlFile(m)).trim(), { max: 1 });
  const denied = async (q: string): Promise<boolean> => {
    try {
      await sql.unsafe(q);
      return false;
    } catch {
      return true;
    }
  };
  try {
    expect(await denied("select count(*) from tasks")).toBe(false);
    expect(await denied("create table mine (x int)")).toBe(true);
    expect(await denied("select * from mb_logins")).toBe(true);
    expect(await denied("create role sneaky login")).toBe(true);
    expect(await denied("drop table tasks")).toBe(true);
  } finally {
    await sql.close();
  }
});

test("the same code used again is refused and changes nothing", async () => {
  const h = await hub();
  const a = add(h, "laptop");
  const m = world();
  expect(machine(m, ["join", a.code, "--no-doctor"]).code).toBe(0);
  const before = read(urlFile(m));
  refused(machine(m, ["join", a.code, "--no-doctor"]), "code-used");
  expect(read(urlFile(m))).toBe(before);
});

test("join on the machine that runs the board is refused", async () => {
  const h = await hub();
  const a = add(h, "laptop");
  const before = read(urlFile(h));
  refused(machine(h, ["join", a.code, "--no-doctor"]), "is-hub");
  expect(read(urlFile(h))).toBe(before);
});

test("join without Tailscale is refused with nothing written; --no-tailscale skips the check", async () => {
  const h = await hub();
  const a = add(h, "laptop");
  const m = world({ ip: null });
  refused(machine(m, ["join", a.code, "--no-doctor"]), "tailscale-missing");
  expect(existsSync(m.board)).toBe(false);
  const n = world({ tailscale: false });
  refused(machine(n, ["join", a.code, "--no-doctor"]), "tailscale-missing");
  expect(existsSync(n.board)).toBe(false);
  const p = machine(m, ["join", a.code, "--no-doctor", "--no-tailscale"]);
  expect(p.code, p.out).toBe(0);
  expect(existsSync(urlFile(m))).toBe(true);
});

test("a join whose login the board refuses keeps nothing, puts back the URL that was there, and says to ask for a new code", async () => {
  const h = await hub();
  const a = add(h, "laptop");
  expect(machine(h, ["remove", "laptop"]).code).toBe(0); // its login is gone
  const m = world();
  write(urlFile(m), "postgres://someone:pw@127.0.0.1:1/other\n", 0o600);
  const p = machine(m, ["join", a.code, "--no-doctor"]);
  const e = refused(p, "code-refused");
  expect(e.fix).toContain("factory machine add laptop --agent ...");
  expect(e.fix).not.toContain("factory board up");
  expect(p.out).not.toContain(new URL(codeUrl(a.code)).password);
  expect(read(urlFile(m))).toBe("postgres://someone:pw@127.0.0.1:1/other\n");
  const fresh = world();
  refused(machine(fresh, ["join", a.code, "--no-doctor"]), "code-refused");
  expect(existsSync(urlFile(fresh))).toBe(false);
});

test("a join whose board doesn't answer keeps nothing and says to check the route to the board", async () => {
  const h = await hub();
  const a = add(h, "laptop");
  const u = new URL(codeUrl(a.code));
  u.port = "1";
  const m = world();
  const p = machine(m, ["join", withUrl(a.code, u.toString()), "--no-doctor"]);
  expect(refused(p, "board-unreachable").fix).toMatch(/factory board status|tailscale/i);
  expect(existsSync(m.board)).toBe(false);
});

test("a join that can't record itself after reaching the board keeps nothing: the URL goes again", async () => {
  const h = await hub();
  const a = add(h, "laptop");
  const m = world();
  mkdirSync(join(m.cfg, "machine-joins.json"), { recursive: true }); // a folder where the used codes go: the write fails
  const p = machine(m, ["join", a.code, "--no-doctor"]);
  expect(p.code, p.out).toBe(1);
  expect(error(p).code).toBe("join-not-saved");
  expect(existsSync(urlFile(m))).toBe(false);
  expect(existsSync(m.board)).toBe(false);
  expect(await connects(codeUrl(a.code))).toBe(true); // the code wasn't spent: it still joins
  rmSync(join(m.cfg, "machine-joins.json"), { recursive: true });
  expect(machine(m, ["join", a.code, "--no-doctor"]).code).toBe(0);
});

test("join runs the doctor and reports it unless --no-doctor", async () => {
  const h = await hub();
  const a = add(h, "laptop");
  const m = world();
  const p = machine(m, ["join", a.code]);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toMatch(/^doctor:/m);
  const b = add(h, "desktop", ["tewodros"]);
  const n = world();
  const q = machine(n, ["join", b.code, "--no-doctor"]);
  expect(q.code, q.out).toBe(0);
  expect(q.stdout).not.toMatch(/^doctor:/m);
});

// ---------- ls, remove, and the hub enforcing the code's expiry ----------
interface Row { name: string; state: string; joinedAt: number | null; revokedAt: number | null }
const lsJson = (w: World, at: number): Row[] => JSON.parse(machine(w, ["ls", "--json"], { FACTORY_NOW: String(at) }).stdout) as Row[];
const lsLine = (w: World, name: string, at: number): string =>
  machine(w, ["ls"], { FACTORY_NOW: String(at) }).stdout.split("\n").find((l) => l.startsWith(name)) ?? "";

test("ls says none when there are no machines", async () => {
  const w = await hub();
  const p = machine(w, ["ls"]);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toMatch(/no machines/i);
});

test("ls lists each machine with its agents and whether its code is waiting", async () => {
  const w = await hub();
  add(w, "laptop");
  const line = lsLine(w, "laptop", NOW + 60);
  expect(line).toContain("haile");
  expect(line).toContain("taytu");
  expect(line).toContain("waiting for join (expires in 14 min)");
  expect(lsJson(w, NOW)).toEqual([{ name: "laptop", agents: [{ name: "haile", role: "builder" }, { name: "taytu", role: "manager" }],
    state: "waiting", expiresAt: NOW + 900, joinedAt: null, revokedAt: null }] as unknown as Row[]);
});

test("a machine that connected is joined, and stays joined (its login kept) after its code expires", async () => {
  const h = await hub();
  const a = add(h, "laptop");
  const m = world();
  expect(machine(m, ["join", a.code, "--no-doctor"]).code).toBe(0);
  expect(lsJson(h, NOW + 60)[0]).toMatchObject({ state: "joined", joinedAt: NOW + 60, revokedAt: null });
  expect(lsLine(h, "laptop", LATER + 600)).toContain("joined");
  expect(lsJson(h, LATER + 600)[0]).toMatchObject({ state: "joined", joinedAt: NOW + 60 });
  expect((await logins(h)).map((l) => l.name)).toEqual(["laptop"]);
  expect(await connects(read(urlFile(m)).trim())).toBe(true);
});

test("a code that expires before its machine joins: its login is dropped, ls says so, and the code no longer works", async () => {
  const h = await hub();
  const a = add(h, "laptop");
  expect(lsLine(h, "laptop", NOW + 60)).toContain("waiting for join");
  expect((await roles(h)).length).toBe(1); // before expiry nothing is touched
  const line = lsLine(h, "laptop", LATER);
  expect(line).toContain("code expired; its board login was removed");
  expect(line).toContain("factory machine remove laptop");
  expect(await logins(h)).toEqual([]);
  expect(await roles(h)).toEqual([]);
  const [row] = lsJson(h, LATER + 60);
  expect(row).toMatchObject({ state: "revoked", revokedAt: LATER, joinedAt: null });
  const m = world();
  refused(machine(m, ["join", a.code, "--no-doctor"]), "code-refused"); // a copy kept elsewhere is useless now
  expect(machine(h, ["remove", "laptop"]).code).toBe(0); // the record is kept until remove
  expect(machine(h, ["ls"]).stdout).not.toContain("laptop");
});

test("add sweeps too: an expired code that never joined is revoked when the next machine is added", async () => {
  const h = await hub();
  add(h, "laptop");
  add(h, "desktop", ["tewodros"], [], { FACTORY_NOW: String(LATER) });
  expect((await logins(h)).map((l) => l.name)).toEqual(["desktop"]);
  expect(lsJson(h, LATER).map((r) => [r.name, r.state])).toEqual([["laptop", "revoked"], ["desktop", "waiting"]]);
});

test("when the board doesn't answer, nothing is revoked and ls says it couldn't check", async () => {
  const h = await hub();
  add(h, "laptop");
  const url = read(urlFile(h));
  writeFileSync(urlFile(h), "postgres://factory:pw@127.0.0.1:1/board\n");
  const line = lsLine(h, "laptop", LATER);
  expect(line).toContain("code expired; not checked");
  expect(line).toContain("factory board status");
  expect(lsJson(h, LATER)[0]).toMatchObject({ state: "expired-unchecked", joinedAt: null, revokedAt: null });
  writeFileSync(urlFile(h), url);
  expect((await logins(h)).map((l) => l.name)).toEqual(["laptop"]);
});

test("remove drops the machine's login and its record; the joined machine can't connect any more", async () => {
  const h = await hub();
  const a = add(h, "laptop");
  add(h, "desktop", ["tewodros"]);
  const m = world();
  expect(machine(m, ["join", a.code, "--no-doctor"]).code).toBe(0);
  const url = read(urlFile(m)).trim();
  const p = machine(h, ["remove", "laptop"]);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("laptop");
  expect((await logins(h)).map((l) => l.name)).toEqual(["desktop"]);
  expect(await connects(url)).toBe(false);
  expect(machine(h, ["ls"]).stdout).not.toContain("laptop");
});

test("remove of an unknown machine, or the same one twice, is refused and changes nothing", async () => {
  const h = await hub();
  add(h, "laptop");
  refused(machine(h, ["remove", "nope"]), "unknown-machine");
  expect(machine(h, ["remove", "laptop"]).code).toBe(0);
  refused(machine(h, ["remove", "laptop"]), "unknown-machine");
  expect(await logins(h)).toEqual([]);
});

test("remove while the board doesn't answer is refused and keeps the record", async () => {
  const h = await hub();
  add(h, "laptop");
  const url = read(urlFile(h));
  writeFileSync(urlFile(h), "postgres://factory:pw@127.0.0.1:1/board\n");
  const p = machine(h, ["remove", "laptop"]);
  expect(p.code).toBe(1);
  expect(error(p).fix).toContain("factory board");
  writeFileSync(urlFile(h), url);
  expect(machine(h, ["ls"]).stdout).toContain("laptop");
  expect((await logins(h)).map((l) => l.name)).toEqual(["laptop"]);
});

// ---------- help ----------
test("factory help lists machine add, join, ls and remove", () => {
  const w = world();
  const help = sh(["bash", join(SF, "factory"), "help"], { cwd: w.d, env: w.env, timeoutMs: 60_000 });
  for (const c of ["machine add", "machine join", "machine ls", "machine remove", "machine leave"]) expect(help.stdout).toContain(c);
  expect(help.stdout).not.toMatch(/nats/i);
});

// ---------- the board enforces the code (#514): its expiry and its one use ----------
const BOARD_BIN = join(SF, "message-board", "bin.ts");
const boardStatus = (w: World): Proc => sh([process.execPath, "--no-env-file", BOARD_BIN, "status"], { cwd: w.d, env: w.env, timeoutMs: 60_000 });

test("a code joins exactly once: a second machine is refused, and the code's own password stops working", async () => {
  const h = await hub();
  const a = add(h, "laptop");
  const m = world();
  expect(machine(m, ["join", a.code, "--no-doctor"]).code).toBe(0);
  const mine = read(urlFile(m)).trim();
  expect(new URL(mine).password).not.toBe(new URL(codeUrl(a.code)).password); // the join wrote a new password
  expect(await connects(codeUrl(a.code))).toBe(false);
  expect(await connects(mine)).toBe(true);
  const other = world(); // another machine with a copy of the code
  const p = machine(other, ["join", a.code, "--no-doctor"]);
  expect(refused(p, "code-refused").fix).toContain("factory machine add laptop");
  expect(existsSync(other.board)).toBe(false);
  expect(await connects(mine)).toBe(true); // the first machine keeps its login
  expect(lsJson(h, NOW + 60)[0]).toMatchObject({ state: "joined" });
});

test("an expired code's password is refused by Postgres itself, whatever the clocks say", async () => {
  const h = await hub();
  const a = add(h, "laptop", ["haile"], ["--ttl", "0.05"]); // 3 seconds
  expect(await connects(codeUrl(a.code))).toBe(true);
  await Bun.sleep(4000);
  expect(await connects(codeUrl(a.code))).toBe(false);
  const m = world(); // its clock (FACTORY_NOW) says the code is still good: the board refuses it anyway
  refused(machine(m, ["join", a.code, "--no-doctor"]), "code-refused");
  expect(existsSync(m.board)).toBe(false);
});

test("ls says joined only once the code is redeemed: connecting with the code isn't joining", async () => {
  const h = await hub();
  const a = add(h, "laptop");
  expect(await connects(codeUrl(a.code))).toBe(true);
  expect(lsJson(h, NOW + 60)[0]).toMatchObject({ state: "waiting", joinedAt: null });
  const line = lsLine(h, "laptop", LATER);
  expect(line).toContain("code expired; its board login was removed");
  expect(await roles(h)).toEqual([]);
  expect(await connects(codeUrl(a.code))).toBe(false);
});

test("a joined machine whose login was removed is told to ask the hub for a new code, or leave", async () => {
  const h = await hub();
  const a = add(h, "laptop");
  const m = world();
  expect(machine(m, ["join", a.code, "--no-doctor"]).code).toBe(0);
  expect(machine(h, ["remove", "laptop"]).code).toBe(0);
  const s = boardStatus(m);
  expect(s.code).toBe(1);
  expect(s.stdout).toContain("This machine's board login was refused (removed or expired).");
  expect(s.stdout).toContain("on the hub run `factory machine add <name> --agent ...`, then `factory machine join <code>` here");
  expect(s.stdout).toContain("factory machine leave");
  expect(s.stdout).not.toContain("factory board up");
  const down = new URL(read(urlFile(m)).trim());
  down.port = "1";
  writeFileSync(urlFile(m), down.toString() + "\n");
  const d = boardStatus(m); // a board that doesn't answer is another matter
  expect(d.stdout).toMatch(/doesn't answer/);
  expect(d.stdout).not.toContain("login was refused");
});

// ---------- leave ----------
test("leave removes this machine's board URL and the agent names its join added; safe to run twice", async () => {
  const h = await hub();
  const a = add(h, "laptop");
  const m = world();
  write(join(m.cfg, "work.json"), JSON.stringify({ agents: ["menelik"] })); // a name this machine had before it joined (its names file)
  expect(machine(m, ["join", a.code, "--no-doctor"]).code).toBe(0);
  expect(machine(m, ["show"]).out).toContain("haile");
  const p = machine(m, ["leave"]);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("factory machine remove laptop");
  expect(existsSync(urlFile(m))).toBe(false);
  const shown = machine(m, ["show"]).out;
  expect(shown).toContain("menelik");
  expect(shown).not.toContain("haile");
  expect(shown).not.toContain("taytu");
  const again = machine(m, ["leave"]);
  expect(again.code, again.out).toBe(0);
  expect(again.stdout).toMatch(/doesn't use a message board|nothing to do/i);
  const b = add(h, "desktop", ["tewodros"]); // it can join again later
  expect(machine(m, ["join", b.code, "--no-doctor"]).code).toBe(0);
});

test("leave on the machine that runs the board is refused and changes nothing", async () => {
  const h = await hub();
  const before = read(urlFile(h));
  const e = refused(machine(h, ["leave"]), "is-hub");
  expect(e.fix).toContain("factory board down");
  expect(read(urlFile(h))).toBe(before);
});

test("a join whose new password doesn't work after the redeem says the code may have been copied and keeps nothing", async () => {
  const h = await hub();
  const a = add(h, "laptop");
  const sql = new SQL(h.url, { max: 1 }); // as if a copy of the code changed the login's password during the join
  try {
    await sql.unsafe(`create or replace function steal() returns trigger language plpgsql security definer as $f$
      begin execute format('alter role %I password %L', new.role, 'stolen-password'); return new; end $f$`);
    await sql.unsafe("create trigger steal after update of redeemed_at on mb_logins for each row execute function steal()");
  } finally {
    await sql.close();
  }
  const m = world();
  const p = machine(m, ["join", a.code, "--no-doctor"]);
  const e = refused(p, "code-compromised");
  expect(e.message).toContain("may have been copied");
  expect(e.fix).toContain("factory machine remove laptop");
  expect(p.out).not.toContain("stolen-password");
  expect(existsSync(m.board)).toBe(false);
  expect(existsSync(join(m.cfg, "machine-joins.json"))).toBe(false); // the code isn't marked used here
  expect(machine(m, ["show"]).out).not.toContain("haile");
});
