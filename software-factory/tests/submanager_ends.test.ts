// A sub-manager that has done its item ends, and none blocks the dev manager's pass (#585). On factory-sandbox a
// `loop -i` sub-manager answered its board question and then sat at its prompt for 90 minutes, and the cycle waited for
// it, so nothing else was handled. Here a fake `claude` behaves like that interactive session: it answers the question
// on the board, ends its turn (running the Stop hooks of the settings it was given, as Claude Code does), and then
// hangs. The orchestrator's throwaway project (orchestrator_support.ts) on a real Postgres board (board_pg.ts).
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Board } from "../message-board/src/index.ts";
import { freshDb, type Pg, startPg } from "./board_pg.ts";
import { cycle, H, H2, hook, iso, pr, SF } from "./orchestrator_support.ts";
import { world } from "./orchestrator_support.ts";
import type { Env } from "./roles_support.ts";

setDefaultTimeout(240_000);

const REPO = "acme/shop";
const HANG_SECONDS = 120;

let pg: Pg;
const drops: (() => Promise<void>)[] = [];
const boards: Board[] = [];

beforeAll(async () => {
  pg = await startPg();
}, 600_000);

afterEach(async () => {
  for (const b of boards.splice(0)) await b.end().catch(() => {});
  for (const d of drops.splice(0)) await d().catch(() => {});
}, 120_000);

afterAll(async () => {
  for (const b of boards) await b.end().catch(() => {});
  for (const d of drops) await d().catch(() => {});
  pg?.stop();
}, 120_000);

// What the fake claude runs: answer the question it was started for (as lead), then the Stop hooks of its --settings.
const ANSWER = `import { Board } from ${JSON.stringify(join(SF, "message-board", "src", "index.ts"))};
const b = await Board.open(process.env.MB_URL as string, { as: "lead", max: 1 });
const id = Number((process.env.FACTORY_ITEM ?? "").replace("board-m", ""));
const q = (await b.thread({ thread: id })).find((m) => m.id === id);
await b.post({ kind: "answer", inReplyTo: id, to: q?.from ?? "taytu", body: "bun test" });
await b.end();
`;

const STOP_HOOKS = `const a = process.argv.slice(2);
const at = a.indexOf("--settings");
const s = at >= 0 ? JSON.parse(a[at + 1] as string) : {};
for (const group of s.hooks?.Stop ?? []) {
  for (const h of group.hooks ?? []) {
    const p = Bun.spawnSync(["sh", "-c", h.command], { stdin: new TextEncoder().encode("{}"),
      env: { ...process.env, CLAUDE_PROJECT_DIR: process.cwd() } });
    if (p.exitCode !== 0) console.error("stop hook failed: " + p.stderr.toString());
  }
}
`;

/** The fake claude's script: an item in FAKE_HANG hangs at once (it never finishes); any other answers its question when
 * it is one, ends its turn, and then hangs like a session waiting at its prompt. Each start and wake-up is logged. */
const SESSION = `log="$FAKE_DIR/sessions"
echo "start $FACTORY_ITEM" >>"$log"
case " $FAKE_HANG " in *" $FACTORY_ITEM "*) ;; *)
  case "$FACTORY_ITEM" in board-m*) "$FAKE_BUN" --no-env-file "$FAKE_DIR/answer.ts" ;; esac
  "$FAKE_BUN" --no-env-file "$FAKE_DIR/stop_hooks.ts" "$@"
  echo "turn-ended $FACTORY_ITEM" >>"$log" ;;
esac
sleep ${HANG_SECONDS}
echo "woke $FACTORY_ITEM" >>"$log"
`;

interface W {
  d: string;
  work: string;
  env: Env;
  board: Board;
}

async function setUp(o: { cfg?: Record<string, unknown>; db?: Record<string, unknown>; hang?: string[] } = {}): Promise<W> {
  const db = await freshDb(pg);
  drops.push(db.drop);
  const [d, work, env] = world({ cfg: { tasks: { source: "board" }, ...(o.cfg ?? {}) }, db: o.db ?? {} });
  symlinkSync(join(SF, "message-board"), join(work, ".claude", "message-board"));
  writeFileSync(join(d, "answer.ts"), ANSWER);
  writeFileSync(join(d, "stop_hooks.ts"), STOP_HOOKS);
  writeFileSync(join(d, "session.sh"), SESSION);
  Object.assign(env, { MB_URL: db.url, GH_REPO: REPO, FAKE_DIR: d, FAKE_BUN: process.execPath, FAKE_HANG: (o.hang ?? []).join(" "),
    FAKE_CLAUDE_HOOK: join(d, "session.sh"), PATH: `${dirname(process.execPath)}:${env.PATH ?? ""}` });
  const board = await Board.open(db.url, { as: "system", max: 1 });
  boards.push(board);
  await board.migrate();
  return { d, work, env, board };
}

let issueNo = 40;

/** taytu's question to lead on a new task; its item ref. */
async function ask(w: W, body: string): Promise<string> {
  issueNo += 1;
  const t = await w.board.create({ title: "Harden the login", ref: `github:${REPO}#${issueNo}` });
  const b = await Board.open(w.env.MB_URL as string, { as: "taytu", max: 1 });
  boards.push(b);
  return `board-m${(await b.post({ task: t.id, kind: "question", to: "lead", body })).id}`;
}

const sessions = (w: W): string[] => {
  const f = join(w.d, "sessions");
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : [];
};
const subDir = (w: W): string => join(w.work, ".git", "factory-manager", "lead.d");
const managerLog = (w: W): string => {
  const f = join(w.work, ".git", "factory-manager", "lead.log");
  return existsSync(f) ? readFileSync(f, "utf8") : "";
};

async function answered(w: W, ref: string): Promise<boolean> {
  const id = Number(ref.replace("board-m", ""));
  return (await w.board.thread({ thread: id })).some((m) => m.kind === "answer" && m.inReplyTo === id);
}

function timed<T>(f: () => T): [T, number] {
  const t = Date.now();
  const r = f();
  return [r, (Date.now() - t) / 1000];
}

// --- -i: a session you can type into ---------------------------------------------------------------------------

test("-i: once the question is answered and the turn ends, the cycle ends the session and returns", async () => {
  const w = await setUp();
  const ref = await ask(w, "Which test runner?");
  const [p, took] = timed(() => cycle(w.work, w.env, "--interactive"));
  expect(p.code, p.out).toBe(0);
  expect(await answered(w, ref)).toBe(true);
  expect(p.stdout).toContain(`${ref}: the item is resolved and the session waits at its prompt; ending it`);
  expect(took, p.out).toBeLessThan(HANG_SECONDS / 2);
  expect(sessions(w)).toEqual([`start ${ref}`, `turn-ended ${ref}`]); // ended, never woke
  expect(existsSync(join(subDir(w), `${ref}.claude`))).toBe(false);
  expect(existsSync(join(subDir(w), `${ref}.pid`))).toBe(false);
});

test("-i: a session that never finishes is stopped at manager.subManagerMinutes and the pass goes on to the next item", async () => {
  const w = await setUp({ cfg: { manager: { subManagerMinutes: 0.1 } } });
  const stuck = await ask(w, "First: which runner?");
  const next = await ask(w, "Second: which linter?");
  w.env.FAKE_HANG = stuck;
  const [p, took] = timed(() => cycle(w.work, w.env, "--interactive"));
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain(`${stuck}: timed out after 0.1 minutes (manager.subManagerMinutes); stopped it, will retry`);
  expect(p.stdout).toContain(`${next}: the item is resolved`);
  expect(await answered(w, stuck)).toBe(false);
  expect(await answered(w, next)).toBe(true);
  expect(took, p.out).toBeLessThan(HANG_SECONDS / 2);
  expect(sessions(w).filter((l) => l.startsWith("woke"))).toEqual([]);
  expect(managerLog(w)).toContain(`${stuck}: timed out`);
});

test("-i: a question that keeps timing out feeds the board question backoff", async () => {
  const w = await setUp({ cfg: { manager: { subManagerMinutes: 0.05 } } });
  const ref = await ask(w, "Which runner?");
  w.env.FAKE_HANG = ref;
  for (let i = 0; i < 3; i += 1) expect(cycle(w.work, w.env, "--interactive").stdout).toContain(`${ref}: timed out`);
  const p = cycle(w.work, w.env, "--interactive");
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain(`${ref}: started 3 times and still not answered; the next start is after`);
  expect(sessions(w).filter((l) => l.startsWith("start")).length).toBe(3);
});

test("-i: a pull request whose session hangs is stopped at the limit and the next pull request is still handled", async () => {
  const w = await setUp({ cfg: { manager: { subManagerMinutes: 0.1 } },
    db: { pulls: [pr(5), pr(6, { sha: H2 })], commits: { [H]: iso(60), [H2]: iso(50) } } });
  w.env.FAKE_HANG = "pr-5";
  const p = cycle(w.work, w.env, "--interactive");
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("pr-5: timed out after 0.1 minutes (manager.subManagerMinutes); stopped it, will retry");
  expect(sessions(w).filter((l) => l.startsWith("start"))).toEqual(["start pr-5", "start pr-6"]);
});

// --- unattended sub-managers (-p) ------------------------------------------------------------------------------

test("-p: one sub-manager that hangs is stopped at the limit, and the other item of the same pass is answered", async () => {
  const w = await setUp({ cfg: { manager: { subManagerMinutes: 0.1, maxSubManagers: 2 } } });
  const stuck = await ask(w, "First: which runner?");
  const next = await ask(w, "Second: which linter?");
  w.env.FAKE_HANG = stuck;
  const [p, took] = timed(() => cycle(w.work, w.env, "--wait"));
  expect(p.code, p.out).toBe(0);
  expect(took, p.out).toBeLessThan(HANG_SECONDS / 2);
  expect(await answered(w, next)).toBe(true);
  expect(await answered(w, stuck)).toBe(false);
  const log = managerLog(w);
  expect(log).toContain(`${stuck}: timed out after 0.1 minutes (manager.subManagerMinutes); stopped it, will retry`);
  expect(log).toContain(`${next}: the item is resolved`);
  expect(sessions(w).filter((l) => l.startsWith("woke"))).toEqual([]);
});

// --- factory owner stop (the web UI's Stop) ----------------------------------------------------------------------

test("owner stop ends a sub-manager that runs in its dev manager's window, and the pass goes on", async () => {
  const w = await setUp();
  const ref = await ask(w, "Which runner?");
  w.env.FAKE_HANG = ref;
  const run = Bun.spawn([process.execPath, "--no-env-file", join(w.work, ".claude", "hooks", "factory_orchestrator.ts"), "cycle",
    "--name", "lead", "--interactive"], { cwd: w.work, env: w.env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const claudeFile = join(subDir(w), `${ref}.claude`);
  for (let i = 0; i < 300 && !existsSync(claudeFile); i += 1) await Bun.sleep(100);
  expect(existsSync(claudeFile)).toBe(true);
  const ls = hook(w.work, w.env, "factory_agents.ts", "ls", "--json", "--local");
  const row = (JSON.parse(ls.stdout) as { agents: Record<string, unknown>[] }).agents.find((a) => a.name === `lead-${ref}`);
  expect([row?.kind, row?.parent, row?.item, row?.stoppable], ls.out).toEqual(["sub manager", "lead", ref, true]);
  const stop = hook(w.work, w.env, "factory_owner.ts", "stop", `lead-${ref}`);
  expect(stop.code, stop.out).toBe(0);
  expect(stop.stdout).toContain(`Stopped lead-${ref}, lead's sub-manager on ${ref}`);
  const ended = await Promise.race([run.exited, Bun.sleep(30_000).then(() => "still running")]);
  if (ended === "still running") run.kill(9);
  expect(ended).toBe(0);
  expect(managerLog(w)).toContain(`${ref}: the session ended (exit`);
  expect(sessions(w).filter((l) => l.startsWith("woke"))).toEqual([]);
});

test("owner stop of a sub-manager whose session it can't find refuses with the fix and ends nothing", async () => {
  const w = await setUp();
  const stand = Bun.spawn(["sleep", "60"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  try {
    const dir = subDir(w);
    Bun.spawnSync(["mkdir", "-p", dir]);
    writeFileSync(join(dir, "board-m7.pid"), String(stand.pid)); // as an older release left it: no .claude file
    const stop = hook(w.work, w.env, "factory_owner.ts", "stop", "lead-board-m7");
    expect(stop.code, stop.out).toBe(1);
    const err = JSON.parse(stop.stderr.trim().split("\n").pop() as string) as { code: string; fix: string };
    expect(err.code).toBe("sub_unreachable");
    expect(err.fix).toContain("factory owner stop lead");
    expect(stand.killed || stand.exitCode !== null).toBe(false);
    const ls = hook(w.work, w.env, "factory_agents.ts", "ls", "--json", "--local");
    const row = (JSON.parse(ls.stdout) as { agents: Record<string, unknown>[] }).agents.find((a) => a.name === "lead-board-m7");
    expect(row?.stoppable).toBe(false);
  } finally {
    stand.kill(9);
  }
});

// --- agents ls: one past its time is stuck -----------------------------------------------------------------------

test("agents ls shows a sub-manager past manager.subManagerMinutes as stuck, with the command that ends it", async () => {
  const w = await setUp();
  const stand = Bun.spawn(["sleep", "60"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  try {
    const dir = subDir(w);
    Bun.spawnSync(["mkdir", "-p", dir]);
    writeFileSync(join(dir, "board-m12.pid"), String(stand.pid));
    writeFileSync(join(dir, "board-m12.claude"), String(stand.pid));
    const old = new Date(Date.now() - 83 * 60_000);
    utimesSync(join(dir, "board-m12.pid"), old, old);
    const ls = hook(w.work, w.env, "factory_agents.ts", "ls", "--json", "--local");
    const row = (JSON.parse(ls.stdout) as { agents: Record<string, unknown>[] }).agents.find((a) => a.name === "lead-board-m12");
    expect(row?.state, ls.out).toBe("stuck");
    expect(String(row?.detail)).toContain("past manager.subManagerMinutes (30)");
    expect(String(row?.detail)).toContain("factory owner stop lead-board-m12");
    const table = hook(w.work, w.env, "factory_agents.ts", "ls", "--local");
    expect(table.stdout).toMatch(/lead-board-m12\s+sub manager of lead\s+this machine\s+stuck/);
  } finally {
    stand.kill(9);
  }
});
