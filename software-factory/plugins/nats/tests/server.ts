// A real nats-server with JetStream for the NATS plugin's tests (decision 0004 point 5): started on a free port in a
// scratch folder, stopped after the file. Not a test file. With no `nats-server` on PATH the tests are skipped with a
// message saying so, except where FACTORY_REQUIRE_NATS=1 (CI installs a pinned one and sets it), where that fails.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const NATS_SERVER = Bun.which("nats-server");
export const MISSING = "nats-server is not installed, so the NATS plugin's tests are skipped. Install it (`brew install " +
  "nats-server`, or a release binary from github.com/nats-io/nats-server) to run them.";

if (!NATS_SERVER && process.env.FACTORY_REQUIRE_NATS === "1") {
  throw new Error("FACTORY_REQUIRE_NATS=1 but there is no nats-server on PATH: install it before the tests.");
}
if (!NATS_SERVER) process.stderr.write(MISSING + "\n");

export interface Server {
  url: string;
  port: number;
  stop(): void;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      const port = typeof a === "object" && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });
}

async function answers(port: number): Promise<boolean> {
  try {
    const c = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
    c.end();
    return true;
  } catch {
    return false;
  }
}

/** Start nats-server with JetStream on a free port; `config` is extra server config (an authorization block). */
export async function startServer(config = ""): Promise<Server> {
  if (!NATS_SERVER) throw new Error(MISSING);
  const dir = mkdtempSync(join(tmpdir(), "nats-test-"));
  const port = await freePort();
  const conf = join(dir, "server.conf");
  writeFileSync(conf, `listen: "127.0.0.1:${port}"\njetstream { store_dir: "${join(dir, "js")}" }\n${config}\n`);
  const proc = Bun.spawn([NATS_SERVER, "-c", conf], { stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 100 && !(await answers(port)); i++) await Bun.sleep(50);
  if (!(await answers(port))) {
    proc.kill(9);
    throw new Error(`nats-server did not answer on port ${port}`);
  }
  return {
    url: `nats://127.0.0.1:${port}`,
    port,
    stop() {
      proc.kill(9);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let n = 0;
/** A project name no other test in this process used: each gets its own stream and claims bucket. */
export function freshProject(): string {
  n += 1;
  return `p${process.pid}-${n}`;
}
