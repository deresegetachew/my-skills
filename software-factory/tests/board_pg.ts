// A real Postgres for the factory's tests that use the message board (decision 0007 point 10). Not a test file.
//
// The factory may import only the board's public entry (check_skills.ts), so this is the factory's own copy of what
// message-board/tests/pg.ts does: MB_TEST_URL names a server the tests may create databases on (CI sets it); without
// it, a throwaway postgres:17-alpine container with its data in memory (tmpfs), removed when the tests end or the
// process exits. It carries the board tests' label, so a container a killed run left behind is removed by either.
// Without Postgres or Docker, the tests fail and say how to fix it.
import { SQL } from "bun";
import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BOARD_SRC = join(import.meta.dir, "..", "message-board");

/** The board's files as an older release shipped them (#570): a copy of message-board (no tests) whose migrations stop
 *  at `last` (for example "003_leases_values.sql"). Its folder; `bin` is its `factory board`. */
export function olderBoard(last: string): { dir: string; bin: string } {
  const dir = join(mkdtempSync(join(process.env.TMPDIR || tmpdir(), "mb-older-")), "message-board");
  cpSync(BOARD_SRC, dir, { recursive: true, filter: (src) => !src.startsWith(join(BOARD_SRC, "tests")) });
  const migrations = join(dir, "src", "migrations");
  for (const f of readdirSync(migrations)) if (f > last) rmSync(join(migrations, f));
  return { dir, bin: join(dir, "bin.ts") };
}

/** Database `url` migrated by an older release's board code, up to migration `last` and no further (#570). */
export function migrateUpTo(url: string, last: string): void {
  const { bin } = olderBoard(last);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("MB_") && !k.startsWith("FACTORY_")) env[k] = v;
  const p = Bun.spawnSync([process.execPath, "--no-env-file", bin, "migrate"], { env: { ...env, MB_URL: url, FACTORY_CONFIG_DIR: join(bin, "..", "cfg") },
    stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: 120_000 });
  if (p.exitCode !== 0) throw new Error(`the older board's migrate failed: ${p.stderr.toString()}`);
}

const IMAGE = "postgres:17-alpine";
const LABEL = "factory-message-board-test";
const USER = "factory";
const PASSWORD = `pw${randomBytes(9).toString("hex")}`;
const HOW = "Set MB_TEST_URL to a Postgres the tests may create databases on (postgres://user:password@host:5432/postgres), " +
  "or start Docker so the tests can run a throwaway postgres:17-alpine container.";

function docker(args: string[], timeout = 120_000): { code: number; out: string } {
  try {
    const p = Bun.spawnSync(["docker", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout });
    return { code: p.exitCode ?? 124, out: (p.stdout.toString() + p.stderr.toString()).trim() };
  } catch (e) {
    return { code: 127, out: e instanceof Error ? e.message : String(e) };
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function answers(url: string, seconds: number): Promise<string> {
  const deadline = Date.now() + seconds * 1000;
  let last = "no answer";
  while (Date.now() < deadline) {
    const sql = new SQL(url, { max: 1, connectionTimeout: 5 });
    try {
      await sql`select 1`;
      return "";
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    } finally {
      await sql.close();
    }
    await Bun.sleep(300);
  }
  return last;
}

export interface Pg {
  url: string;
  stop(): void;
}

/** MB_TEST_URL, or a throwaway container. Throws with the fix when there is neither. */
export async function startPg(): Promise<Pg> {
  const given = process.env.MB_TEST_URL;
  if (given) {
    const why = await answers(given, 30);
    if (why) throw new Error(`MB_TEST_URL doesn't answer (${why}). ${HOW}`);
    return { url: given, stop: () => {} };
  }
  if (docker(["info"], 30_000).code !== 0) throw new Error(`No Postgres for these tests: MB_TEST_URL is unset and Docker isn't running. ${HOW}`);
  const left = docker(["ps", "-a", "--filter", `label=${LABEL}`, "--format", `{{.ID}} {{.Label "${LABEL}"}}`]);
  for (const line of left.code === 0 ? left.out.split("\n") : []) {
    const [id, pid] = line.trim().split(" ");
    if (id && pid && !alive(Number(pid))) docker(["rm", "-f", id]);
  }
  const run = docker(["run", "-d", "--rm", "--label", `${LABEL}=${process.pid}`, "-e", `POSTGRES_USER=${USER}`, "-e", `POSTGRES_PASSWORD=${PASSWORD}`,
    "-e", "POSTGRES_DB=postgres", "--tmpfs", "/var/lib/postgresql/data", "-p", "127.0.0.1::5432", IMAGE], 600_000);
  if (run.code !== 0) throw new Error(`docker run ${IMAGE} failed: ${run.out.slice(-400)}. ${HOW}`);
  const id = run.out.split("\n").at(-1) as string;
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    docker(["rm", "-f", id], 60_000);
  };
  process.on("exit", stop);
  try {
    const port = /:(\d+)\s*$/.exec(docker(["port", id, "5432/tcp"]).out.split("\n")[0] ?? "")?.[1];
    if (!port) throw new Error("docker didn't say which port the container listens on");
    const url = `postgres://${USER}:${PASSWORD}@127.0.0.1:${port}/postgres`;
    const why = await answers(url, 60);
    if (why) throw new Error(`the test container didn't answer: ${why}`);
    return { url, stop };
  } catch (e) {
    stop();
    throw e;
  }
}

/** A new empty database on `pg`: its URL, and a drop that also ends every connection to it. */
export async function freshDb(pg: Pg): Promise<{ url: string; drop(): Promise<void> }> {
  const name = `mb_ui_${randomBytes(6).toString("hex")}`;
  const admin = new SQL(pg.url, { max: 1 });
  try {
    await admin.unsafe(`create database ${name}`);
  } finally {
    await admin.close();
  }
  const u = new URL(pg.url);
  u.pathname = `/${name}`;
  return {
    url: u.toString(),
    drop: async () => {
      const a = new SQL(pg.url, { max: 1 });
      try {
        await a.unsafe(`drop database if exists ${name} with (force)`);
      } finally {
        await a.close();
      }
    },
  };
}
