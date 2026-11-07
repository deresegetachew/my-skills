// The dev manager answers a coding agent's question on the board (#565): with the board on, an open question an agent
// posts to the dev manager (one of its names, or `dev-manager`) in this project is an item of the orchestrator's pass,
// and the pass starts one sub-manager for it, whose prompt carries the question's id and text and how to answer it.
// Not twice while one is on it, not again once it is answered, and never for a question to someone else or another
// project's. `--dry-run` lists it. The orchestrator's throwaway project (orchestrator_support.ts: fake `gh`, fake
// `claude` that records its prompt) on a real Postgres board (board_pg.ts).
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Board } from "../message-board/src/index.ts";
import { freshDb, type Pg, startPg } from "./board_pg.ts";
import { cycle, prompts, SF, world } from "./orchestrator_support.ts";
import type { Env } from "./roles_support.ts";

setDefaultTimeout(180_000);

const REPO = "acme/shop";
const ref = (repo: string, n: number): string => `github:${repo}#${n}`;

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

interface W {
  d: string;
  work: string;
  env: Env;
  board: Board;
  as(actor: string): Promise<Board>;
}

/** The orchestrator's project with `tasks.source: board` on a fresh board; the dev managers are lead and second. */
async function setUp(): Promise<W> {
  const db = await freshDb(pg);
  drops.push(db.drop);
  const [d, work, env] = world({ cfg: { tasks: { source: "board" } } });
  symlinkSync(join(SF, "message-board"), join(work, ".claude", "message-board")); // where a release puts the board
  env.MB_URL = db.url;
  env.GH_REPO = REPO;
  const board = await Board.open(db.url, { as: "system", max: 1 });
  boards.push(board);
  await board.migrate();
  const as = async (actor: string): Promise<Board> => {
    const b = await Board.open(db.url, { as: actor, max: 1 });
    boards.push(b);
    return b;
  };
  return { d, work, env, board, as };
}

let issueNo = 18;

/** taytu's question to `to` on a new task of `repo`. */
async function ask(w: W, to: string, body: string, repo = REPO): Promise<number> {
  issueNo += 1;
  const t = await w.board.create({ title: "Harden the login", ref: ref(repo, issueNo) });
  return (await (await w.as("taytu")).post({ task: t.id, kind: "question", to, body })).id;
}

const subLines = (env: Env): string[] => prompts(env).filter((l) => l.includes(" -p "));

test("an open question to the dev manager on the board starts one sub-manager, whose prompt has the question", async () => {
  const w = await setUp();
  const id = await ask(w, "lead", "Proposal: a new task to rate-limit the login endpoint. Shall I add it?");
  const p = cycle(w.work, w.env, "--wait");
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain(`board-m${id}`);
  const calls = subLines(w.env);
  expect(calls.length, calls.join("\n")).toBe(1);
  const line = calls[0] as string;
  expect(line).toContain(`/manage-pass board-m${id}`);
  expect(line).toContain(`m${id}`);
  expect(line).toContain("Proposal: a new task to rate-limit the login endpoint. Shall I add it?");
  expect(line).toContain("taytu");
  expect(line).toContain(`inReplyTo ${id}`);
  expect(line).toContain("<!-- factory-role role=dev-manager name=lead -->");
});

test("a second pass while the sub-manager is on the question starts no other", async () => {
  const w = await setUp();
  const id = await ask(w, "lead", "Which test runner?");
  const h = join(w.d, "hook.sh");
  writeFileSync(h, `cd "${w.work}" && bun --no-env-file .claude/hooks/factory_orchestrator.ts cycle --name lead --wait ` +
    `> "${w.d}/second.out" 2>&1\nexit 0\n`);
  w.env.FAKE_CLAUDE_HOOK = h;
  expect(cycle(w.work, w.env, "--wait").code).toBe(0);
  expect(subLines(w.env).length, subLines(w.env).join("\n")).toBe(1);
  expect(readFileSync(join(w.d, "second.out"), "utf8")).toContain(`board-m${id}: a sub-manager is already on it`);
});

test("once the question has an answer on the board, no pass starts it", async () => {
  const w = await setUp();
  const id = await ask(w, "lead", "Which test runner?");
  await (await w.as("lead")).post({ kind: "answer", inReplyTo: id, to: "taytu", body: "bun test" });
  const p = cycle(w.work, w.env, "--wait");
  expect(subLines(w.env)).toEqual([]);
  expect(p.stdout).not.toContain(`board-m${id}`);
  expect(p.code, p.out).toBe(3);
});

test("a question to another agent, or another project's question to the dev manager, starts nothing", async () => {
  const w = await setUp();
  await ask(w, "menelik", "Can you rebase on main?");
  await ask(w, "lead", "Not this project's.", "acme/other");
  const p = cycle(w.work, w.env, "--wait");
  expect(subLines(w.env)).toEqual([]);
  expect(p.stdout).not.toContain("board-m");
  expect(p.code, p.out).toBe(3);
});

test("--dry-run lists the question as an item; one to dev-manager is the first dev manager's", async () => {
  const w = await setUp();
  const id = await ask(w, "lead", "Which test runner?");
  const role = await ask(w, "dev-manager", "Who reviews b18?");
  const p = cycle(w.work, w.env, "--dry-run");
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain(`would start a sub-manager for board-m${id}: question m${id} from taytu to lead`);
  expect(p.stdout).toContain(`would start a sub-manager for board-m${role}: question m${role} from taytu to dev-manager`);
  expect(subLines(w.env)).toEqual([]);
  // the second dev manager leaves both to lead
  const other = Bun.spawnSync([process.execPath, "--no-env-file", join(w.work, ".claude", "hooks", "factory_orchestrator.ts"),
    "cycle", "--name", "second", "--dry-run"], { cwd: w.work, env: w.env });
  expect(other.stdout.toString()).not.toContain("board-m");
});
