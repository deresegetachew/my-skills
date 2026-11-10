// `factory release <agent>` with tasks on the message board (#554): a stopped agent's board claims are given back on the
// board too, and the output names them; a running agent is refused and keeps its board claim. A real Postgres.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { Task as BoardTask } from "../message-board/src/index.ts";
import { aLoop } from "./claims_support.ts";
import { type BoardWorld, boardWorld } from "./board_support.ts";
import { FAKE_GH } from "./issues_support.ts";
import { git, gitRepo, runHook, write, writeExe } from "./support.ts";

setDefaultTimeout(180_000);

let world: BoardWorld;
beforeAll(async () => {
  world = await boardWorld();
}, 600_000);
afterAll(async () => {
  await world?.end();
}, 120_000);

type Env = Record<string, string | undefined>;

const onBoard = (id: number): BoardTask => world.child.call("system", [{ op: "get", args: [id] }])[0] as BoardTask;

/** A project on the board with task One (#101) ready, claimed as haile through `factory next`. */
function claimed(): { d: string; env: Env; id: number } {
  const repo = world.repo();
  const d = gitRepo();
  writeExe(join(d, "bin", "gh"), FAKE_GH);
  write(join(d, ".claude", "factory.json"), JSON.stringify({ tasks: { source: "board" }, agents: ["haile", "taytu"] }));
  git(d, "add", "-A");
  git(d, "commit", "-q", "-m", "factory.json");
  const db = write(join(d, "gh-db.json"), JSON.stringify({ issues: [], pulls: [] }));
  const made = world.child.call("system", [{ op: "create", args: [{ title: "One", ref: `github:${repo}#101` }] }]) as BoardTask[];
  const env: Env = { ...process.env, PATH: `${d}/bin:${process.env.PATH}`, FAKE_GH_DB: db, MB_URL: world.url, GH_REPO: repo };
  delete env.FACTORY_AGENT;
  delete env.FACTORY_PID;
  delete env.FACTORY_AGENTS;
  const id = (made[0] as BoardTask).id;
  const c = runHook("next_task", ["--claim", "haile", "--pid", "123"], { cwd: d, env, timeoutMs: 90_000 });
  expect(c.code, c.out).toBe(0);
  expect(onBoard(id)).toMatchObject({ holder: "haile", status: "in_progress" });
  return { d, env, id };
}

/** The checkout claim of haile on this machine, held by `pid`. */
function checkoutHeldBy(d: string, pid: number): void {
  const file = join(d, ".git", "factory", "claims.json");
  const old = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> : {};
  write(file, JSON.stringify({ ...old, checkouts: { haile: { agent: "haile", pid, host: hostname(), at: Date.now() / 1000,
    path: `${d}-agents/haile`, role: "coding-agent" } } }));
}

const release = (d: string, env: Env, ...extra: string[]) =>
  runHook("factory_claims", ["release", "--agent", "haile", ...extra], { cwd: d, env, timeoutMs: 90_000 });

test("releasing a stopped agent gives its board claims back on the board, and the output names them", () => {
  const p = claimed();
  checkoutHeldBy(p.d, 2 ** 22 + 12345);
  const r = release(p.d, p.env);
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toContain("Released haile: the checkout");
  const line = r.stdout.split("\n").find((l) => l.startsWith("Gave back on the message board:"));
  expect(line, r.out).toBeDefined();
  expect(line).toContain("101");
  expect(onBoard(p.id)).toMatchObject({ holder: null, status: "open" });
});

test("releasing an agent whose loop runs is refused, and its board claim stays", () => {
  const p = claimed();
  const loop = aLoop();
  try {
    checkoutHeldBy(p.d, loop.pid);
    const r = release(p.d, p.env);
    expect(r.code, r.out).toBe(1);
    expect(JSON.parse(r.stderr.trim().split("\n").at(-1) as string).code).toBe("release_running");
    expect(onBoard(p.id)).toMatchObject({ holder: "haile", status: "in_progress" });
  } finally {
    loop.kill();
  }
});
