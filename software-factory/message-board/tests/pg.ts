// A real Postgres for the message board's tests (decision 0007 point 10). Not a test file.
//
// MB_TEST_URL names a server the tests may create databases on (CI sets it to its `postgres` service). Without it,
// the tests start a throwaway postgres:17-alpine container with Docker on a free port and remove it when they finish:
// in afterAll, and again when the process exits or is stopped. A container left by a run that was killed is removed by
// the next run (each one carries the process id that made it). Without either, the tests fail and say how to fix it.
import { SQL } from "bun";
import { randomBytes } from "node:crypto";

const IMAGE = "postgres:17-alpine";
const LABEL = "factory-message-board-test";
const USER = "factory";
const PASSWORD = "factory-test";

export interface Server {
  /** A URL with rights to create databases and roles. */
  url: string;
  stop(): void;
}

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

/** Remove containers that earlier runs left behind when they were killed. */
function removeLeftovers(): void {
  const p = docker(["ps", "-a", "--filter", `label=${LABEL}`, "--format", `{{.ID}} {{.Label "${LABEL}"}}`]);
  if (p.code !== 0) return;
  for (const line of p.out.split("\n")) {
    const [id, pid] = line.trim().split(" ");
    if (id && pid && !alive(Number(pid))) docker(["rm", "-f", id]);
  }
}

async function waitFor(url: string, seconds: number): Promise<string> {
  const deadline = Date.now() + seconds * 1000;
  let last = "";
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
  return last || "no answer";
}

const HOW = "Set MB_TEST_URL to a Postgres the tests may create databases on (postgres://user:password@host:5432/postgres), " +
  "or start Docker so the tests can run a throwaway postgres:17-alpine container.";

/** The test server: MB_TEST_URL, or a throwaway container. Throws with the fix when there is neither. */
export async function startServer(): Promise<Server> {
  const given = process.env.MB_TEST_URL;
  if (given) {
    const why = await waitFor(given, 30);
    if (why) throw new Error(`MB_TEST_URL doesn't answer (${why}). ${HOW}`);
    return { url: given, stop: () => {} };
  }
  if (docker(["info"], 30_000).code !== 0) throw new Error(`No Postgres for the message board's tests: MB_TEST_URL is unset and Docker isn't running. ${HOW}`);
  removeLeftovers();
  const run = docker(["run", "-d", "--rm", "--label", `${LABEL}=${process.pid}`, "-e", `POSTGRES_USER=${USER}`,
    "-e", `POSTGRES_PASSWORD=${PASSWORD}`, "-e", "POSTGRES_DB=postgres", "-p", "127.0.0.1::5432", IMAGE], 600_000);
  if (run.code !== 0) throw new Error(`docker run ${IMAGE} failed: ${run.out.slice(-400)}. ${HOW}`);
  const id = run.out.split("\n").at(-1) as string;
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    docker(["rm", "-f", id], 60_000);
  };
  process.on("exit", stop);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      stop();
      process.exit(130);
    });
  }
  try {
    const port = /:(\d+)\s*$/.exec(docker(["port", id, "5432/tcp"]).out.split("\n")[0] ?? "")?.[1];
    if (!port) throw new Error("docker didn't say which port the container listens on");
    const url = `postgres://${USER}:${PASSWORD}@127.0.0.1:${port}/postgres`;
    const why = await waitFor(url, 60);
    if (why) throw new Error(`the test container didn't answer: ${why}`);
    return { url, stop };
  } catch (e) {
    stop();
    throw e;
  }
}

/** A URL like `url` for another database (and optionally another user and password). */
export function withDatabase(url: string, db: string, user?: string, password?: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  if (user) u.username = user;
  if (password) u.password = password;
  return u.toString();
}

/** A new empty database on the server, and a function that drops it. */
export async function freshDatabase(server: Server): Promise<{ url: string; drop(): Promise<void> }> {
  const name = `mb_t_${randomBytes(6).toString("hex")}`;
  const admin = new SQL(server.url, { max: 1 });
  try {
    await admin.unsafe(`create database ${name}`);
  } finally {
    await admin.close();
  }
  return {
    url: withDatabase(server.url, name),
    drop: async () => {
      const a = new SQL(server.url, { max: 1 });
      try {
        await a.unsafe(`drop database if exists ${name} with (force)`);
      } finally {
        await a.close();
      }
    },
  };
}
