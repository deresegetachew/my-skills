// A task whose pull request merged is closed on the board (#536): `factory board sweep`, which the dev manager's pass
// runs after the mirror, first closes each task in progress or in review whose linked pull request has merged (done,
// its claim released, "closed after merge by the dev manager"), then sweeps, so a merged task is never sent back to
// ready. "Linked": the PR's branch names the task (task/b3-..., b3-..., task/7-...), or its title or body says `b3:` or
// `Closes b3` / `Closes #7`. One list call to GitHub at most, none when nothing is in progress or in review.
// A real Postgres (board_pg.ts) and the stateful fake gh (fakegh.ts), which serves the pull requests from its file.
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Board, type Task } from "../message-board/src/index.ts";
import { freshDb, type Pg, startPg } from "./board_pg.ts";
import { installFakeGh } from "./fakegh.ts";
import { gitRepo, HOOKS, type Proc, runBun, tmp, write } from "./support.ts";

setDefaultTimeout(120_000);

const REPO = "acme/shop";
type Row = Record<string, unknown>;

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

interface World {
  d: string;
  dbFile: string;
  log: string;
  env: Record<string, string>;
  board: Board;
  as(actor: string): Promise<Board>;
}

async function world(): Promise<World> {
  const db = await freshDb(pg);
  drops.push(db.drop);
  const root = tmp("factory-merged-");
  const d = join(root, "work");
  write(join(d, ".claude", "factory.json"), JSON.stringify({ tasks: { source: "board" } }));
  gitRepo(d);
  const bin = installFakeGh(root);
  const dbFile = join(root, "db.json");
  writeFileSync(dbFile, JSON.stringify({ repo: REPO, issues: [], comments: {}, pulls: [] }));
  const log = join(root, "gh.log");
  writeFileSync(log, "");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("FACTORY_") && !k.startsWith("MB_") && !k.startsWith("GH_") && k !== "CLAUDE_PROJECT_DIR") env[k] = v;
  }
  Object.assign(env, { PATH: `${bin}:${process.env.PATH}`, FAKE_DB: dbFile, LOOP_LOG: log, MB_URL: db.url, GH_REPO: REPO,
    FACTORY_CONFIG_DIR: join(root, "cfg"), HOME: root });
  const board = await Board.open(db.url, { as: "system", max: 1 });
  boards.push(board);
  await board.migrate();
  const as = async (actor: string): Promise<Board> => {
    const b = await Board.open(db.url, { as: actor, max: 1 });
    boards.push(b);
    return b;
  };
  return { d, dbFile, log, env, board, as };
}

/** A pull request as GitHub's list gives it: merged when `merged` is a time. */
function pull(number: number, o: { branch: string; title?: string; body?: string; merged?: string | null }): Row {
  const merged = o.merged === undefined ? "2026-11-07T09:00:00Z" : o.merged;
  return { number, title: o.title ?? "A change", body: o.body ?? "", head: { ref: o.branch }, state: merged ? "closed" : "open", merged_at: merged };
}

function setPulls(w: World, pulls: Row[]): void {
  const db = JSON.parse(readFileSync(w.dbFile, "utf8")) as Row;
  writeFileSync(w.dbFile, JSON.stringify({ ...db, pulls }));
}

const sweep = (w: World, args: string[] = [], extra: Record<string, string> = {}): Proc =>
  runBun(join(HOOKS, "factory_board.ts"), ["sweep", ...args], { cwd: w.d, env: { ...w.env, ...extra }, timeoutMs: 120_000 });

/** The `gh` calls made since the log was cleared. */
const ghCalls = (w: World): string[] => readFileSync(w.log, "utf8").split("\n").filter((l) => l.startsWith("gh api"));

/** A task made on the board for the project (b<id>), claimed by `holder`. */
async function held(w: World, title: string, holder = "taytu"): Promise<Task> {
  const t = await w.board.create({ title, ref: `factory:${REPO}/${title.replace(/\W+/g, "-")}` });
  const b = await w.as(holder);
  await b.claim(t.id);
  return w.board.get(t.id);
}

test("a task in progress whose merged pull request's branch names it is done after one pass, unclaimed, with the reason on its thread", async () => {
  const w = await world();
  const t = await held(w, "Add login");
  setPulls(w, [pull(60, { branch: `task/b${t.id}-add-login` })]);
  const p = sweep(w);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain(`closed b${t.id}: pull request #60 merged`);
  const after = await w.board.get(t.id);
  expect(after).toMatchObject({ status: "done", outcome: "done", holder: null });
  const events = (await w.board.events(0, 500)).filter((e) => e.subject === `task:${t.id}`);
  const moved = events.find((e) => e.kind === "task.moved");
  expect(String(moved?.payload.reason)).toContain("closed after merge by the dev manager");
  expect(events.some((e) => e.kind === "task.taken_back" && e.payload.holder === "taytu")).toBe(true);
  expect(ghCalls(w).length).toBe(1); // one list of pull requests, nothing more
});

test("a task in review is closed by a merged pull request that says `b<n>:` in its title or `Closes b<n>` / `Closes #n` in its body", async () => {
  const w = await world();
  const byTitle = await held(w, "By title");
  const byBody = await held(w, "By body");
  const issue = await w.board.create({ title: "From an issue", ref: `github:${REPO}#7` });
  const builder = await w.as("taytu");
  const c = await builder.claim(issue.id);
  await builder.release(issue.id, c?.token as string, { next: "review", reason: "PR open" });
  setPulls(w, [
    pull(61, { branch: "feature/x", title: `b${byTitle.id}: by title` }),
    pull(62, { branch: "feature/y", body: `Some words.\n\nCloses b${byBody.id}` }),
    pull(63, { branch: "feature/z", body: "Fixes nothing.\nCloses #7" }),
  ]);
  const p = sweep(w);
  expect(p.code, p.out).toBe(0);
  for (const id of [byTitle.id, byBody.id, issue.id]) expect((await w.board.get(id)).status).toBe("done");
  expect(p.stdout).toContain("closed #7: pull request #63 merged");
});

test("an open pull request, or a merged one that names another task, changes nothing", async () => {
  const w = await world();
  const t = await held(w, "Open PR");
  const other = await held(w, "Another task");
  setPulls(w, [
    pull(70, { branch: `task/b${t.id}-open-pr`, merged: null }),
    pull(71, { branch: `task/b${t.id}0-x`, title: `b${t.id}0: a task with a longer number`, body: `Closes b${t.id}0\nCloses #${t.id}` }),
    pull(72, { branch: "main-fix", title: "no task named" }),
  ]);
  const p = sweep(w);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).not.toContain("closed");
  for (const id of [t.id, other.id]) expect(await w.board.get(id)).toMatchObject({ status: "in_progress", holder: "taytu" });
});

test("the sweep doesn't send a stale task whose pull request merged back to ready: it closes it", async () => {
  const w = await world();
  const t = await w.board.create({ title: "Stale", ref: `factory:${REPO}/stale` });
  const b = await w.as("taytu");
  await b.claim(t.id, { ttlSeconds: 0 });
  setPulls(w, [pull(80, { branch: `b${t.id}-stale` })]);
  const p = sweep(w, ["--quiet-minutes", "0"]);
  expect(p.code, p.out).toBe(0);
  expect(await w.board.get(t.id)).toMatchObject({ status: "done", holder: null });
  expect((await w.board.events(0, 500)).some((e) => e.kind === "task.swept" && e.subject === `task:${t.id}`)).toBe(false);
});

test("when GitHub can't list the pull requests, the sweep frees no claim this pass and says so; the next pass does", async () => {
  const w = await world();
  const t = await w.board.create({ title: "Stale", ref: `factory:${REPO}/stale` });
  const b = await w.as("taytu");
  await b.claim(t.id, { ttlSeconds: 0 });
  setPulls(w, [pull(80, { branch: `b${t.id}-stale` })]);
  const down = sweep(w, ["--quiet-minutes", "0", "--max-seconds", "60"], { FAKE_GH_FAIL: "1" });
  expect(down.code, down.out).toBe(0);
  expect(down.out).toContain("next pass");
  expect(await w.board.get(t.id)).toMatchObject({ status: "in_progress", holder: "taytu" });
  const up = sweep(w, ["--quiet-minutes", "0", "--max-seconds", "60"]);
  expect(up.code, up.out).toBe(0);
  expect((await w.board.get(t.id)).status).toBe("done");
});

test("a task moved back to ready after its pull request merged, then claimed again, is left alone", async () => {
  const w = await world();
  const t = await held(w, "Redo");
  await w.board.move(t.id, { to: "ready", reason: "the owner wants it done again" });
  await (await w.as("taytu")).claim(t.id);
  setPulls(w, [pull(90, { branch: `task/b${t.id}-redo`, merged: "2026-01-01T00:00:00Z" })]);
  const p = sweep(w);
  expect(p.code, p.out).toBe(0);
  expect((await w.board.get(t.id)).status).toBe("in_progress");
});

test("with nothing in progress or in review, the pass asks GitHub nothing", async () => {
  const w = await world();
  await w.board.create({ title: "Ready one", ref: `factory:${REPO}/ready` });
  setPulls(w, [pull(60, { branch: "task/b1-ready-one" })]);
  const p = sweep(w);
  expect(p.code, p.out).toBe(0);
  expect(ghCalls(w)).toEqual([]);
  expect((await w.board.get(1)).status).toBe("open");
});
