// `factory update` migrates the message board (#570). A release can bring board migrations that change what the board's
// rules mean (004_waits_for: which way waits_for points); until they are applied the board keeps the old meaning, and
// nothing said so. Now the update applies them on the machine that runs the board (the hub), under the board's migrate
// lock, and safe to run twice; a machine that joined changes nothing and is warned with the fix; `factory board status`
// and `factory doctor` say how many migrations are pending, with the fix.
//
// A real Postgres (board_pg.ts), real release archives built from this repo's own board code (tools/build_release.ts,
// served by the fake GitHub of release_support.ts), and the release client run as a person runs it.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { SQL } from "bun";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { freshDb, migrateUpTo, olderBoard, type Pg, startPg } from "./board_pg.ts";
import { doctor, lines, machine, project as doctorProject } from "./doctor_support.ts";
import { commit, type Env, fac, world } from "./release_support.ts";
import { SF, tmp } from "./support.ts";

setDefaultTimeout(240_000);

const BIN = join(SF, "message-board", "bin.ts");
const OLD = "003_leases_values.sql";
const NEW = "004_waits_for.sql";
let pg: Pg;
const drops: (() => Promise<void>)[] = [];

beforeAll(async () => {
  pg = await startPg();
}, 600_000);

afterAll(async () => {
  for (const d of drops) await d().catch(() => {});
  pg?.stop();
}, 120_000);

async function database(): Promise<string> {
  const db = await freshDb(pg);
  drops.push(db.drop);
  return db.url;
}

/** The migrations applied to the board at `url`, read with the board's own user. */
async function applied(url: string): Promise<string[]> {
  const sql = new SQL(url, { max: 1 });
  try {
    const exists = (await sql`SELECT to_regclass('mb_migrations') IS NOT NULL AS ok`) as { ok: boolean }[];
    if (!exists[0]?.ok) return [];
    return ((await sql`SELECT name FROM mb_migrations ORDER BY name`) as { name: string }[]).map((r) => r.name);
  } finally {
    await sql.close();
  }
}

/** The board's files in a release: message-board/<path> for each file under `dir` (no tests). */
function boardFiles(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (n === "tests" && d === dir) continue;
      if (statSync(p).isDirectory()) walk(p);
      else out[`message-board/${relative(dir, p)}`] = readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}

/** This machine's settings folder: the board's url file, and state.json when `factory board up` ran here (the hub). */
function machineDir(url: string, hub: boolean): string {
  const cfg = join(tmp("mb-machine-"), "cfg");
  const dir = join(cfg, "message-board");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "url"), url + "\n", { mode: 0o600 });
  if (hub) {
    const port = Number(new URL(url).port || 5432);
    writeFileSync(join(dir, "state.json"), JSON.stringify({ port, tailnetPort: port, address: "127.0.0.1", image: "postgres:17-alpine" }));
  }
  return cfg;
}

function onMachine(env: Env, cfg: string): Env {
  const out: Env = { ...env, FACTORY_CONFIG_DIR: cfg };
  for (const k of Object.keys(out)) if (k.startsWith("MB_")) delete out[k];
  return out;
}

interface Run { code: number; stdout: string; stderr: string }

/** `factory board <args>` with this repo's board code, on the machine whose settings folder is `cfg`. */
function board(cfg: string, ...args: string[]): Run {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("MB_") && !k.startsWith("FACTORY_")) env[k] = v;
  const p = Bun.spawnSync([process.execPath, "--no-env-file", BIN, ...args], { env: { ...env, FACTORY_CONFIG_DIR: cfg },
    stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: 120_000 });
  return { code: p.exitCode ?? 124, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

const OLD_BOARD = (): Record<string, string> => boardFiles(olderBoard(OLD).dir);
const NEW_BOARD = (): Record<string, string> => boardFiles(join(SF, "message-board"));

test("on the hub, factory update applies the release's new board migrations, and running it again changes nothing", async () => {
  const url = await database();
  const cfg = machineDir(url, true);
  const [gh, d, base] = await world();
  const env = onMachine(base, cfg);
  gh.add("1.0.0", { files: OLD_BOARD(), date: "2026-10-01T10:00:00Z" });
  gh.add("1.1.0", { files: NEW_BOARD(), date: "2026-11-01T10:00:00Z" });

  let [rc, out] = await fac(d, env, "update", "1.0.0");
  expect(rc, out).toBe(0);
  expect(out).toContain(`message board: applied 001_init.sql, 002_import_refs.sql, ${OLD}.`);
  expect(await applied(url)).toEqual(["001_init.sql", "002_import_refs.sql", OLD]);
  commit(d);

  // the code is newer than the board: status says so, with the fix, before the update
  const before = board(cfg, "status");
  expect(before.code, before.stdout + before.stderr).toBe(1);
  expect(before.stdout).toContain(`1 migration pending (${NEW})`);
  expect(before.stdout).toContain("Run `factory board migrate`.");

  [rc, out] = await fac(d, env, "update");
  expect(rc, out).toBe(0);
  expect(out).toContain("v1.0.0 -> v1.1.0");
  expect(out).toContain(`message board: applied ${NEW}.`);
  expect(await applied(url)).toEqual(["001_init.sql", "002_import_refs.sql", OLD, NEW]);

  const after = board(cfg, "status");
  expect(after.code, after.stdout + after.stderr).toBe(0);
  expect(after.stdout).toContain(`schema    ${NEW}`);
  expect(after.stdout).not.toContain("pending");

  commit(d);
  [rc, out] = await fac(d, env, "update");
  expect(rc, out).toBe(0);
  expect(out).toContain(`message board: the schema is up to date (${NEW}).`);
  expect(await applied(url)).toEqual(["001_init.sql", "002_import_refs.sql", OLD, NEW]);
});

test("on a machine that joined, factory update changes nothing on the board and warns with the fix; migrate there is refused, not a crash", async () => {
  const url = await database();
  migrateUpTo(url, OLD);
  const hubCfg = machineDir(url, true);
  const made = board(hubCfg, "login", "add", "laptop", "--json");
  expect(made.code, made.stderr).toBe(0);
  const login = (JSON.parse(made.stdout) as { url: string }).url;
  const cfg = machineDir(login, false);
  const [gh, d, base] = await world();
  const env = onMachine(base, cfg);
  gh.add("1.1.0", { files: NEW_BOARD() });

  const [rc, out] = await fac(d, env, "update");
  expect(rc, out).toBe(0);
  expect(out).toContain(`message board: warning: 1 migration pending (${NEW})`);
  expect(out).toContain("Run `factory board migrate` on the hub, the machine that runs the board.");
  expect(out).toContain("Done. This project is on v1.1.0.");
  expect(out).not.toContain(new URL(login).password);
  expect(await applied(url)).toEqual(["001_init.sql", "002_import_refs.sql", OLD]);

  const status = board(cfg, "status");
  expect(status.code).toBe(1);
  expect(status.stdout).toContain(`1 migration pending (${NEW})`);
  expect(status.stdout).toContain("on the hub");

  const m = board(cfg, "migrate");
  expect(m.code).toBe(1);
  const err = JSON.parse(m.stderr.trim().split("\n").at(-1) as string) as { code: string; message: string; fix: string };
  expect(err.code).toBe("no-rights");
  expect(err.fix).toContain("machine that runs the board");
  expect(await applied(url)).toEqual(["001_init.sql", "002_import_refs.sql", OLD]);

  // on the hub it is applied, and the joined machine's next update says the schema is up to date
  const hub = board(hubCfg, "migrate", "--if-hub");
  expect(hub.code, hub.stderr).toBe(0);
  expect(hub.stdout).toContain(`message board: applied ${NEW}.`);
  const again = board(cfg, "migrate", "--if-hub");
  expect(again.stdout).toContain(`message board: the schema is up to date (${NEW}, on the hub).`);
});

test("on the hub with its board stopped, factory update finishes and says board up applies the migrations", async () => {
  const dead = "postgres://factory:secret-pw@127.0.0.1:9/board"; // nothing listens on port 9
  const cfg = machineDir(dead, true);
  const [gh, d, base] = await world();
  gh.add("1.1.0", { files: NEW_BOARD() });
  const [rc, out] = await fac(d, onMachine(base, cfg), "update");
  expect(rc, out).toBe(0);
  expect(out).toContain("message board: doesn't answer here, so nothing was migrated; `factory board up` applies the migrations when it starts it.");
  expect(out).not.toContain("secret-pw");
});

test("on the hub, a board that refuses the board's own user stops the update with the board's fix; once fixed, update again finishes", async () => {
  const url = await database();
  migrateUpTo(url, OLD);
  const wrong = new URL(url);
  wrong.password = "not-the-password";
  const cfg = machineDir(wrong.toString(), true);
  const [gh, d, base] = await world();
  const env = onMachine(base, cfg);
  gh.add("1.1.0", { files: NEW_BOARD() });
  let [rc, out] = await fac(d, env, "update");
  expect(rc, out).toBe(1);
  expect(out).toContain("[board_migrate_failed]");
  expect(out).toContain("factory update` again");
  expect(out).not.toContain("not-the-password");
  expect(await applied(url)).toEqual(["001_init.sql", "002_import_refs.sql", OLD]);
  writeFileSync(join(cfg, "message-board", "url"), url + "\n", { mode: 0o600 });
  commit(d);
  [rc, out] = await fac(d, env, "update");
  expect(rc, out).toBe(0);
  expect(out).toContain(`message board: applied ${NEW}.`);
  expect(await applied(url)).toEqual(["001_init.sql", "002_import_refs.sql", OLD, NEW]);
});

test("factory doctor says how many board migrations are pending, with the fix, and nothing once they are applied", async () => {
  const url = await database();
  migrateUpTo(url, OLD);
  const d = doctorProject({}, { tasks: { source: "board" }, agents: ["haile"] });
  const env = { ...machine(), MB_URL: url };
  const before = doctor(d, env);
  const fix = lines(before, "fix").find((l) => l.includes("message board schema"));
  expect(fix, before.stdout).toBeDefined();
  expect(fix).toContain(`1 migration pending (${NEW})`);
  expect(fix).toContain("factory board migrate");
  expect(fix).toContain("on the hub");
  const cfg = machineDir(url, true);
  expect(board(cfg, "migrate").code).toBe(0);
  const after = doctor(d, env);
  expect(lines(after, "fix").some((l) => l.includes("message board schema")), after.stdout).toBe(false);
  expect(lines(after, "ok").some((l) => l.includes("message board answers")), after.stdout).toBe(true);
});
