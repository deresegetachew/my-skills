// `factory board <verb>` (message-board/bin.ts, decision 0007 point 10, #489): what a person sees. The read verbs and
// migrate and sweep run against a real Postgres; up, down and backup run with a fake `docker` (and `tailscale`) on
// PATH that log what they were given, so what is checked is the compose file, the files' modes, the docker commands
// and the output. `up` still migrates a real database: the fake docker stands in only for the container.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { SQL } from "bun";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, migrationNames } from "../src/index.ts";
import { freshDatabase, type Server, startServer, withDatabase } from "./pg.ts";

setDefaultTimeout(60_000);

const BIN = join(import.meta.dir, "..", "bin.ts");
let server: Server | null = null;
let db: { url: string; drop(): Promise<void> } | null = null;

beforeAll(async () => {
  server = await startServer();
  db = await freshDatabase(server);
}, 600_000);

afterAll(async () => {
  await db?.drop().catch(() => {});
  server?.stop();
});

const FAKE_DOCKER = `#!/usr/bin/env bash
echo "$*" >>"$FAKE_LOG"
[ "$1" = info ] && { [ "\${FAKE_DOCKER_DOWN:-0}" = 1 ] && exit 1; exit 0; }
case " $* " in *" up "*) [ "\${FAKE_COMPOSE_FAIL:-0}" = 1 ] && { echo "Error: port is already allocated" >&2; exit 1; } ;; esac
case " $* " in *" pg_dump "*) echo "-- PostgreSQL database dump"; echo "CREATE TABLE tasks ();" ;; esac
case " $* " in *" volume inspect "*) [ "\${FAKE_VOLUME:-0}" = 1 ] && exit 0; exit 1 ;; esac
case " $* " in *" ps "*) [ "\${FAKE_RUNNING:-0}" = 1 ] && echo 0123abcd; exit 0 ;; esac
case " $* " in *" psql "*) cat >"\$FAKE_LOG.psql"; [ "\${FAKE_PSQL_FAIL:-0}" = 1 ] && { echo "ERROR:  syntax error at or near \"oops\"" >&2; exit 3; }; exit 0 ;; esac
exit 0
`;
const FAKE_TAILSCALE = `#!/usr/bin/env bash
[ "$*" = "ip -4" ] || exit 2
[ -n "\${FAKE_TS_IP:-}" ] || exit 1
echo "$FAKE_TS_IP"
`;

interface World { root: string; cfg: string; dir: string; env: Record<string, string> }
interface Run { code: number; stdout: string; stderr: string }

function world(url?: string): World {
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "mb-cli-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "docker"), FAKE_DOCKER, { mode: 0o755 });
  writeFileSync(join(bin, "tailscale"), FAKE_TAILSCALE, { mode: 0o755 });
  const cfg = join(root, "cfg");
  const dir = join(cfg, "message-board");
  if (url) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "url"), url + "\n", { mode: 0o600 });
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("MB_") && !k.startsWith("FACTORY_")) env[k] = v;
  Object.assign(env, { PATH: `${bin}:${process.env.PATH}`, HOME: root, FACTORY_CONFIG_DIR: cfg, FAKE_LOG: join(root, "docker.log"),
    FAKE_TS_IP: "100.64.0.7", MB_WAIT_SECONDS: "5" });
  return { root, cfg, dir, env };
}

function board(w: World, args: string[], extra: Record<string, string> = {}): Run {
  const p = Bun.spawnSync([process.execPath, "--no-env-file", BIN, ...args], { env: { ...w.env, ...extra }, stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: 120_000 });
  return { code: p.exitCode ?? 124, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

const dockerLog = (w: World): string => (existsSync(w.env.FAKE_LOG as string) ? readFileSync(w.env.FAKE_LOG as string, "utf8") : "");
const mode = (p: string): number => statSync(p).mode & 0o777;
const err = (r: Run): { code: string; message: string; fix: string } =>
  JSON.parse(r.stderr.trim().split("\n").at(-1) as string) as { code: string; message: string; fix: string };
const password = (url: string): string => decodeURIComponent(new URL(url).password);

test("help lists every verb", () => {
  const r = board(world(), ["help"]);
  expect(r.code).toBe(0);
  for (const verb of ["up", "down", "status", "migrate", "backup", "sweep", "tasks", "show <number>", "ready", "prime <actor>", "restore <file> --yes"]) {
    expect(r.stdout).toContain(`factory board ${verb}`);
  }
});

test("an unknown verb is refused with the fix", () => {
  const r = board(world(), ["fly"]);
  expect(r.code).toBe(1);
  expect(err(r)).toMatchObject({ code: "unknown-verb" });
  expect(err(r).fix).toContain("factory board help");
});

test("without a database URL, the read verbs say how to set one up", () => {
  const r = board(world(), ["tasks"]);
  expect(r.code).toBe(1);
  expect(err(r).code).toBe("no-board");
  expect(err(r).fix).toContain("factory board up");
});

test("migrate, then tasks, ready, show, prime and sweep print what is on the board", async () => {
  const url = (db as { url: string }).url;
  const w = world(url);
  const m = board(w, ["migrate"]);
  expect(m.code, m.stderr).toBe(0);
  expect(m.stdout).toContain("001_init.sql");
  expect(board(w, ["migrate"]).stdout).toContain("up to date");

  const po = await Board.open(url, { as: "po" });
  const a = await po.create({ title: "Write the importer", body: "From GitHub issues.", priority: 1 });
  const b = await po.create({ title: "Show the board in the web UI", priority: 2 });
  await po.link(a.id, b.id, "blocks");
  await po.note(a.id, { kind: "decision", body: "Keep the issue number as the ref" });
  const haile = await Board.open(url, { as: "haile" });
  await haile.claim(a.id, { ttlSeconds: 1 });
  await po.end();
  await haile.end();

  const tasks = board(w, ["tasks"]);
  expect(tasks.code, tasks.stderr).toBe(0);
  expect(tasks.stdout).toMatch(new RegExp(`b${a.id}\\s+in_progress\\s+haile\\s+Write the importer`));
  expect(tasks.stdout).toMatch(new RegExp(`b${b.id}\\s+blocked\\s+Show the board in the web UI`));

  const ready = board(w, ["ready"]);
  expect(ready.stdout).toContain("Nothing is ready");

  const show = board(w, ["show", `b${a.id}`]);
  expect(show.code, show.stderr).toBe(0);
  for (const s of ["Write the importer", "status    in_progress", "holder    haile", "From GitHub issues.", `blocks b${b.id}`, "Keep the issue number as the ref"]) {
    expect(show.stdout).toContain(s);
  }
  const json = JSON.parse(board(w, ["show", `b${a.id}`, "--json"]).stdout) as { task: { id: number; holder: string } };
  expect(json.task).toMatchObject({ id: a.id, holder: "haile" });
  expect(err(board(w, ["show", "999999"])).code).toBe("not-found");
  expect(err(board(w, ["show"])).code).toBe("bad-input");

  const prime = board(w, ["prime", "haile"]);
  expect(prime.code, prime.stderr).toBe(0);
  expect(prime.stdout).toContain("Holding");
  expect(prime.stdout).toContain(`b${a.id}`);
  expect(prime.stdout).toContain("Keep the issue number as the ref");

  await Bun.sleep(1200);
  const sweep = board(w, ["sweep", "--quiet-minutes", "0"]);
  expect(sweep.code, sweep.stderr).toBe(0);
  expect(sweep.stdout).toContain(`released b${a.id} (held by haile)`);
  expect(board(w, ["sweep"]).stdout).toContain("No stale claims");
  expect(board(w, ["ready"]).stdout).toContain(`b${a.id}`);
});

test("status says the board answers, and never prints the password", () => {
  const url = (db as { url: string }).url;
  const w = world(url);
  board(w, ["migrate"]);
  const r = board(w, ["status"]);
  expect(r.code, r.stderr).toBe(0);
  expect(r.stdout).toContain("answers");
  expect(r.stdout).toContain(`schema    ${migrationNames().at(-1)}`);
  expect(r.stdout + r.stderr).not.toContain(password(url));
});

test("status says when the board doesn't answer, with exit 1", () => {
  const w = world("postgres://factory:secret-pw@127.0.0.1:1/board");
  const r = board(w, ["status"]);
  expect(r.code).toBe(1);
  expect(r.stdout + r.stderr).toContain("doesn't answer");
  expect(r.stdout + r.stderr).not.toContain("secret-pw");
});

// ---------- up, down, backup (fake docker) ----------

/** A role `factory` and a database `board` on the test server, as the board's container would have them. */
async function boardDatabase(): Promise<{ password: string; port: string; drop(): Promise<void> }> {
  const admin = new URL((server as Server).url);
  const sql = new SQL((server as Server).url, { max: 1 });
  let pw = password(admin.toString());
  try {
    if (admin.username !== "factory") {
      pw = "board-test-pw";
      const exists = await sql`select 1 from pg_roles where rolname = 'factory'`;
      await sql.unsafe(exists.length ? `alter role factory login password '${pw}'` : `create role factory login password '${pw}'`);
    }
    await sql.unsafe("drop database if exists board with (force)");
    await sql.unsafe("create database board owner factory");
  } finally {
    await sql.close();
  }
  return {
    password: pw,
    port: admin.port || "5432",
    drop: async () => {
      const s = new SQL((server as Server).url, { max: 1 });
      try {
        await s.unsafe("drop database if exists board with (force)");
      } finally {
        await s.close();
      }
    },
  };
}

test("up writes the compose file on 127.0.0.1 and the Tailscale address only, keeps the secrets mode 600, and migrates", async () => {
  const target = await boardDatabase();
  try {
    const w = world();
    mkdirSync(w.dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(w.dir, "password"), target.password + "\n", { mode: 0o600 });
    const r = board(w, ["up", "--port", target.port]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const compose = readFileSync(join(w.dir, "compose.yaml"), "utf8");
    expect(compose).toContain("image: postgres:17-alpine");
    expect(compose).toContain(`"127.0.0.1:${target.port}:5432"`);
    expect(compose).toContain(`"100.64.0.7:${Number(target.port) + 1}:5432"`);
    expect(compose).not.toMatch(/"\d+:5432"|0\.0\.0\.0/);
    expect(compose).not.toContain(target.password);
    expect(mode(join(w.dir, "url"))).toBe(0o600);
    expect(mode(join(w.dir, "password"))).toBe(0o600);
    expect(mode(w.dir)).toBe(0o700);
    expect(readFileSync(join(w.dir, "url"), "utf8").trim()).toBe(`postgres://factory:${encodeURIComponent(target.password)}@127.0.0.1:${target.port}/board`);
    expect(r.stdout + r.stderr).not.toContain(target.password);
    expect(r.stdout).toContain("001_init.sql");
    expect(r.stdout).toContain(`100.64.0.7:${Number(target.port) + 1}`);
    const log = dockerLog(w);
    expect(log).toContain("compose --file");
    expect(log).toMatch(/ up -d/);
    expect(log).toContain("pg_isready");
    const check = new SQL(withDatabase((server as Server).url, "board"), { max: 1 });
    try {
      expect((await check`select count(*)::int as n from mb_migrations`)[0]).toEqual({ n: migrationNames().length });
    } finally {
      await check.close();
    }
  } finally {
    await target.drop();
  }
});

test("up makes a password when there is none, and without Tailscale listens on localhost only and says so", () => {
  const w = world();
  const r = board(w, ["up", "--port", "1"], { FAKE_TS_IP: "", MB_WAIT_SECONDS: "0" });
  // Nothing answers on port 1, so it can't migrate: it says so, with the fix, and keeps what it wrote.
  expect(r.code).toBe(1);
  expect(err(r).code).toBe("no-answer");
  const pw = readFileSync(join(w.dir, "password"), "utf8").trim();
  expect(pw.length).toBeGreaterThanOrEqual(24);
  expect(mode(join(w.dir, "password"))).toBe(0o600);
  const compose = readFileSync(join(w.dir, "compose.yaml"), "utf8");
  expect(compose).toContain('"127.0.0.1:1:5432"');
  expect(compose).not.toContain("100.64");
  expect(compose).toContain("env_file: db.env");
  expect(mode(join(w.dir, "db.env"))).toBe(0o600);
  expect(r.stdout).toContain("localhost only");
  expect(r.stdout + r.stderr).not.toContain(pw);
});

test("up refuses before writing anything when Docker is down, and puts the files back when compose fails", () => {
  const w = world();
  const down = board(w, ["up"], { FAKE_DOCKER_DOWN: "1" });
  expect(down.code).toBe(1);
  expect(err(down).code).toBe("docker-down");
  expect(existsSync(w.dir)).toBe(false);
  const fail = board(w, ["up"], { FAKE_COMPOSE_FAIL: "1" });
  expect(fail.code).toBe(1);
  expect(err(fail).code).toBe("compose-failed");
  expect(err(fail).message).toContain("port is already allocated");
  expect(existsSync(w.dir)).toBe(false);
});

test("down stops it; --purge also removes the data", () => {
  const w = world();
  expect(board(w, ["down"]).stdout).toContain("Nothing to stop");
  mkdirSync(w.dir, { recursive: true });
  writeFileSync(join(w.dir, "compose.yaml"), "name: factory-message-board\n");
  const r = board(w, ["down"]);
  expect(r.code, r.stderr).toBe(0);
  expect(r.stdout).toContain("data is kept");
  expect(dockerLog(w)).toMatch(/compose .* down --remove-orphans\n/);
  const p = board(w, ["down", "--purge"]);
  expect(p.stdout).toContain("removed");
  expect(dockerLog(w)).toContain("down --remove-orphans --volumes");
});

test("backup runs pg_dump inside the container and writes a mode 600 file", () => {
  const w = world();
  expect(err(board(w, ["backup"])).code).toBe("no-board");
  mkdirSync(w.dir, { recursive: true });
  writeFileSync(join(w.dir, "compose.yaml"), "name: factory-message-board\n");
  const out = join(w.root, "b.sql");
  const r = board(w, ["backup", "--out", out]);
  expect(r.code, r.stderr).toBe(0);
  expect(r.stdout).toContain(out);
  expect(readFileSync(out, "utf8")).toContain("PostgreSQL database dump");
  expect(mode(out)).toBe(0o600);
  // no owner and no grants in the dump, so a restore has no role errors (#515)
  expect(dockerLog(w)).toMatch(/exec -T db pg_dump -U factory -d board --no-owner --no-privileges\n/);
  const def = board(w, ["backup"]);
  expect(def.code, def.stderr).toBe(0);
  expect(def.stdout).toContain(join(w.dir, "backups"));
  // the time in the name is UTC, and the name says so (#515)
  expect(def.stdout).toMatch(/board-\d{8}-\d{6}-utc\.sql/);
  expect(def.stdout).toContain("UTC");
});

test("a url file that others can read is fixed to mode 600 when read", () => {
  const url = (db as { url: string }).url;
  const w = world(url);
  chmodSync(join(w.dir, "url"), 0o644);
  expect(board(w, ["tasks"]).code).toBe(0);
  expect(mode(join(w.dir, "url"))).toBe(0o600);
});

test("the tests' own Postgres: without MB_TEST_URL and with Docker down, they fail and say how to fix it", () => {
  const w = world();
  const code = `import { startServer } from ${JSON.stringify(join(import.meta.dir, "pg.ts"))};\n` +
    "try { await startServer(); console.log('started'); } catch (e) { console.log(String(e)); process.exit(3); }";
  const p = Bun.spawnSync([process.execPath, "--no-env-file", "-e", code], { env: { ...w.env, FAKE_DOCKER_DOWN: "1" }, stdout: "pipe", stderr: "pipe" });
  expect(p.exitCode).toBe(3);
  expect(p.stdout.toString()).toContain("MB_TEST_URL is unset and Docker isn't running");
  expect(p.stdout.toString()).toContain("Set MB_TEST_URL");
});

test("up refuses when the password is gone but the data volume is still there, and changes nothing", () => {
  const w = world();
  const r = board(w, ["up"], { FAKE_VOLUME: "1" });
  expect(r.code).toBe(1);
  const e = err(r);
  expect(e.code).toBe("password-missing");
  expect(e.fix).toContain("factory board down --purge");
  expect(e.fix).toContain(join(w.dir, "password"));
  expect(existsSync(w.dir)).toBe(false);
  expect(dockerLog(w)).not.toMatch(/ up -d/);
});

test("ready leaves out tasks handed to someone else; --for <actor> shows that actor's queue", async () => {
  const url = (db as { url: string }).url;
  const w = world(url);
  board(w, ["migrate"]);
  const po = await Board.open(url, { as: "po" });
  const t = await po.create({ title: "Handed to menelik", priority: -50 });
  const a = await Board.open(url, { as: "haile" });
  const c = await a.claim(t.id);
  await a.release(t.id, c?.token ?? "", { next: "handoff", to: "menelik", reason: "yours" });
  await po.end();
  await a.end();
  expect(board(w, ["ready"]).stdout).not.toContain("Handed to menelik");
  const mine = board(w, ["ready", "--for", "menelik"]);
  expect(mine.code, mine.stderr).toBe(0);
  expect(mine.stdout).toMatch(new RegExp(`b${t.id}\\s+open\\s+menelik\\s+Handed to menelik`));
});

test("tasks, ready, show and prime name a task by its issue number (#7) or b<id>, and show takes 7, #7 or b<id> (#515)", async () => {
  const fresh = await freshDatabase(server as Server);
  try {
    const url = fresh.url;
    const w = world(url);
    board(w, ["migrate"]);
    const po = await Board.open(url, { as: "po" });
    const epic = await po.create({ title: "The epic", kind: "epic", ref: "github:o/r#9" });
    const seven = await po.create({ title: "Issue seven", ref: "github:o/r#7", parentId: epic.id, priority: 1 });
    const filed = await po.create({ title: "Filed on the board", priority: 2 });
    await po.link(seven.id, filed.id, "blocks");
    await po.end();

    const tasks = board(w, ["tasks", "--repo", "o/r"]);
    expect(tasks.code, tasks.stderr).toBe(0);
    expect(tasks.stdout).toMatch(/^#7\s+open\s+Issue seven$/m);
    expect(tasks.stdout).toMatch(new RegExp(`^b${filed.id}\\s+blocked\\s+Filed on the board$`, "m"));
    expect(tasks.stdout).not.toContain(`#${seven.id} `);
    // the repo from GH_REPO, as the importer takes it
    expect(board(w, ["ready"], { GH_REPO: "o/r" }).stdout).toMatch(/^#7\s+open/m);
    for (const named of ["7", "#7"]) {
      const show = board(w, ["show", named, "--repo", "o/r"]);
      expect(show.code, show.stderr).toBe(0);
      expect(show.stdout.split("\n")[0]).toBe("#7 Issue seven");
      expect(show.stdout).toContain("parent    #9");
      expect(show.stdout).toContain(`edge      blocks b${filed.id}`);
    }
    const filedShow = board(w, ["show", `b${filed.id}`, "--repo", "o/r"]);
    expect(filedShow.stdout).toContain("blocked   by #7");
    const json = JSON.parse(board(w, ["show", "7", "--json", "--repo", "o/r"]).stdout) as { task: { id: number; number: string } };
    expect(json.task).toMatchObject({ id: seven.id, number: "#7" });
    const list = JSON.parse(board(w, ["tasks", "--json", "--repo", "o/r"]).stdout) as { number: string }[];
    expect(list.map((t) => t.number)).toEqual(["#7", "#9", `b${filed.id}`]);
    const missing = board(w, ["show", "8", "--repo", "o/r"]);
    expect(err(missing).code).toBe("not-found");
    expect(err(missing).message).toContain("issue #8");
    expect(err(board(w, ["show", "seven"])).code).toBe("bad-input");
    expect(board(w, ["prime", "nobody", "--repo", "o/r"]).stdout).toMatch(/Blocked\n\s+b\d+\s+blocked\s+Filed on the board \(by #7\)/);
  } finally {
    await fresh.drop();
  }
});

test("up on a stopped container says it started it; on a running one, that it is up to date (#515)", async () => {
  const target = await boardDatabase();
  try {
    const w = world();
    mkdirSync(w.dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(w.dir, "password"), target.password + "\n", { mode: 0o600 });
    const first = board(w, ["up", "--port", target.port]);
    expect(first.code, first.stdout + first.stderr).toBe(0);
    expect(first.stdout).toContain("Started the message board");
    const stopped = board(w, ["up", "--port", target.port]); // nothing changed, and the container isn't running
    expect(stopped.code, stopped.stdout + stopped.stderr).toBe(0);
    expect(stopped.stdout).toContain("Started the message board");
    expect(stopped.stdout).not.toContain("up to date (");
    const running = board(w, ["up", "--port", target.port], { FAKE_RUNNING: "1" });
    expect(running.code, running.stdout + running.stderr).toBe(0);
    expect(running.stdout).toContain("The message board is up to date");
  } finally {
    await target.drop();
  }
});

test("restore refuses without --yes, without a file or a board, and changes nothing; a failed restore says nothing changed (#515)", () => {
  const w = world();
  const file = join(w.root, "b.sql");
  writeFileSync(file, "-- PostgreSQL database dump\n", { mode: 0o600 });
  expect(err(board(w, ["restore", file, "--yes"])).code).toBe("no-board");
  mkdirSync(w.dir, { recursive: true });
  writeFileSync(join(w.dir, "compose.yaml"), "name: factory-message-board\n");
  const noFile = board(w, ["restore", join(w.root, "nope.sql"), "--yes"]);
  expect(err(noFile).code).toBe("no-file");
  expect(err(board(w, ["restore"])).code).toBe("bad-input");
  const ask = board(w, ["restore", file]);
  expect(ask.code).toBe(1);
  const e = err(ask);
  expect(e.code).toBe("needs-yes");
  expect(e.message).toContain("replaces everything on the board");
  expect(e.fix).toContain(`factory board restore ${file} --yes`);
  expect(e.fix).toContain("factory board backup");
  expect(dockerLog(w)).not.toContain("psql");
  const failed = board(w, ["restore", file, "--yes"], { FAKE_PSQL_FAIL: "1" });
  expect(failed.code).toBe(1);
  expect(err(failed).code).toBe("restore-failed");
  expect(err(failed).message).toContain("oops");
  expect(err(failed).fix).toContain("Nothing was changed");
  expect(dockerLog(w)).toMatch(/exec -T db psql -U factory -d board .*--single-transaction/);
  expect(readFileSync(`${w.env.FAKE_LOG}.psql`, "utf8")).toBe("-- PostgreSQL database dump\n");
});
