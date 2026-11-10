// The Board page follows what changes while the web UI runs, with no restart (#539): a project's `.claude/factory.json`
// changed on disk reaches the pushed views at the next poll (not only on an API request), and a project added through
// + Add project reads its tasks from the message board like the ones the server started with.
// A real Postgres (board_pg.ts), the real server (startUi), a fake gh and a fake `factory`.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Board } from "../message-board/src/index.ts";
import { freshDb, type Pg, startPg } from "./board_pg.ts";
import { api, CONFIG, project, type Project, type Row, startUi, type Running } from "./web_ui_support.ts";
import { git, gitRepo, write, writeExe } from "./support.ts";

const T = 120_000;
let pg: Pg;
const running: Running[] = [];
const roots: string[] = [];
const drops: (() => Promise<void>)[] = [];
const boards: Board[] = [];

beforeAll(async () => {
  pg = await startPg();
}, 600_000);

afterEach(async () => {
  for (const r of running.splice(0)) await r.stop().catch(() => {});
  for (const b of boards.splice(0)) await b.end().catch(() => {});
}, 120_000);

afterAll(async () => {
  for (const r of running) await r.stop();
  for (const b of boards) await b.end().catch(() => {});
  for (const d of drops) await d().catch(() => {});
  for (const d of roots) rmSync(d, { recursive: true, force: true });
  pg?.stop();
}, 120_000);

const FAKE_FACTORY = `#!/usr/bin/env bash
if [ "$1" = snapshot ]; then exit 0; fi
echo "$*" >> "$FAKE_FACTORY_LOG"
if [ "$1" = doctor ]; then echo "doctor ran"; fi
exit 0
`;

async function boardUrl(): Promise<string> {
  const db = await freshDb(pg);
  drops.push(db.drop);
  return db.url;
}

async function openBoard(url: string): Promise<Board> {
  const board = await Board.open(url, { as: "system", max: 1 });
  boards.push(board);
  await board.migrate();
  return board;
}

/** The snapshot cache as `factory snapshot` left it: GitHub's tasks (#99 only). */
function cache(p: Project, repo: string): void {
  write(join(p.state, "snapshot.json"), JSON.stringify({ generatedAt: new Date().toISOString(), sessions: [], needsYou: [], missing: [],
    tasks: { source: "issues", tasks: [{ id: "99", title: "From GitHub", state: "ready", holders: [], group: "", todos: [], dependsOn: [] }], epics: [] },
    pulls: [], ci: { mode: "github", repo, runners: [], runs: [], errors: [] } }));
}

async function started(p: Project, url: string): Promise<Running> {
  const ui = await startUi(p, ["--port", "0"], null, { MB_URL: url });
  running.push(ui);
  return ui;
}

function socket(ui: Running): { ws: WebSocket; next: (want: (m: Row) => boolean, ms: number) => Promise<Row | null> } {
  const ws = new WebSocket(ui.url.replace("http", "ws") + `/api/ws?token=${ui.token}`);
  const seen: Row[] = [];
  const waiting: { want: (m: Row) => boolean; done: (m: Row) => void }[] = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as Row;
    const w = waiting.findIndex((x) => x.want(m));
    if (w >= 0) waiting.splice(w, 1)[0]?.done(m);
    else seen.push(m);
  };
  const next = (want: (m: Row) => boolean, ms: number): Promise<Row | null> => {
    const i = seen.findIndex(want);
    if (i >= 0) return Promise.resolve(seen.splice(i, 1)[0] as Row);
    return new Promise((resolve) => {
      const entry = { want, done: (m: Row) => resolve(m) };
      waiting.push(entry);
      setTimeout(() => {
        const at = waiting.indexOf(entry);
        if (at >= 0) {
          waiting.splice(at, 1);
          resolve(null);
        }
      }, ms);
    });
  };
  return { ws, next };
}

const viewsFrom = (id: string, from: string) => (m: Row) => m.type === "views" && m.project === id && (m.tasks as Row | undefined)?.from === from;

// --- A: a settings change on disk reaches the pushed views --------------------------------------------------------------

test("tasks.source changed on disk from issues to board reaches the open page's views at the next polls, with no API request (#539)", async () => {
  const url = await boardUrl();
  const board = await openBoard(url);
  await board.create({ title: "Someone else's", ref: "github:x/other#1" }); // a board with none of this project's tasks
  const p = project(CONFIG);
  roots.push(p.root);
  writeExe(join(p.d, "factory"), FAKE_FACTORY);
  cache(p, "o/work");
  const ui = await started(p, url);
  const { ws, next } = socket(ui);
  try {
    const first = await next(viewsFrom("work", "github"), 15_000);
    expect(first, "the first views say tasks from github").not.toBeNull();
    // the file changes on disk (a merged and pulled settings change); nobody calls the API
    writeFileSync(join(p.d, ".claude", "factory.json"), JSON.stringify({ ...CONFIG, tasks: { source: "board" } }));
    const m = await next(viewsFrom("work", "board"), 8_000); // a few polls at ui.pollSeconds 1
    expect(m, "a views message with tasks from the board, from the poll alone").not.toBeNull();
    expect((m?.tasks as Row).tasks).toEqual([]); // not #99 from GitHub's snapshot
    const json = (await api(ui, "/api/projects/work/tasks")).json;
    expect(json.from).toBe("board");
  } finally {
    ws.close();
  }
}, T);

// --- B: a project added at runtime reads its tasks from the board ------------------------------------------------------

const FAKE_GH = `#!/usr/bin/env bash
echo "gh $*" >> "$LOOP_LOG"
case "$1 $2" in
  "repo list") echo "[]"; exit 0 ;;
  "pr list") echo "[]"; exit 0 ;;
  "pr create") echo "https://github.com/acme/mine/pull/1"; exit 0 ;;
esac
exit 1
`;

test("a project added through + Add project gets its tasks from the board once the run is done, with no restart (#539)", async () => {
  const url = await boardUrl();
  const board = await openBoard(url);
  await board.create({ title: "Add the cart", ref: "github:acme/mine#5", priority: 1 });
  await board.create({ title: "Pay by card", ref: "github:acme/mine#6", priority: 2 });
  const p = project(CONFIG);
  roots.push(p.root);
  writeExe(join(p.d, "factory"), FAKE_FACTORY);
  cache(p, "o/work");
  const bin = join(p.root, "fakebin");
  writeExe(join(bin, "gh"), FAKE_GH);
  p.env.PATH = `${bin}:${p.env.PATH ?? ""}`;
  git(p.d, "remote", "add", "origin", "https://github.com/o/work.git");
  git(p.d, "add", "-A");
  git(p.d, "commit", "-q", "-m", "setup");
  // the new project: a clean repo whose origin names acme/mine, pushed to a local bare repo
  const dir = join(p.root, "mine");
  mkdirSync(dir, { recursive: true });
  gitRepo(dir);
  writeExe(join(dir, "factory"), FAKE_FACTORY);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "files");
  const bare = join(p.root, "remotes", "acme", "mine.git");
  mkdirSync(dirname(bare), { recursive: true });
  git(dir, "init", "-q", "--bare", "-b", "main", bare);
  const remote = "https://github.com/acme/mine.git";
  git(dir, "config", `url.${bare}.insteadOf`, remote);
  git(dir, "remote", "add", "origin", remote);
  git(dir, "push", "-q", "origin", "main");

  const ui = await started(p, url);
  const body = { confirm: true, source: "folder", repo: "", path: dir, visibility: "private", tasks: "issues", mainBranch: "main",
    test: "bun test", lint: "", protected: [], team: { devManager: "haile", productOwner: "abebe", builders: ["menelik", "taytu"] } };
  const r = await api(ui, "/api/add-project", { method: "POST", body });
  expect(r.status, JSON.stringify(r.json)).toBe(202);
  const id = String((r.json.run as Row).id);
  let run: Row = {};
  const deadline = Date.now() + 80_000;
  while (Date.now() < deadline) {
    run = (await api(ui, `/api/add-project/runs/${id}`)).json.run as Row;
    if (run.state !== "running") break;
    await Bun.sleep(150);
  }
  expect(run.state, JSON.stringify(run)).toBe("done");
  expect(run.project).toBe("mine");

  // the page asks for the new project's tasks; they come from the board, without a restart
  let json: Row = {};
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    json = (await api(ui, "/api/projects/mine/tasks")).json;
    if (json.from === "board") break;
    await Bun.sleep(150);
  }
  expect(json.from, JSON.stringify(json)).toBe("board");
  const rows = json.tasks as Row[];
  expect(rows.map((t) => String(t.id)).sort()).toEqual(["5", "6"]);
  expect(rows.find((t) => t.id === "5")?.title).toBe("Add the cart");
}, T);
