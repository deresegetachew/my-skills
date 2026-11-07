// "Request changes" on a pull request with the message board (#453): besides the must-fix on the pull request, the
// author gets a verdict message on its task's thread, the way the dev manager's verdicts reach a builder. A real
// Postgres (board_pg.ts), the real server (startUi) and the pull request page's fake gh (web_ui_pr_support.ts).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Board } from "../message-board/src/index.ts";
import { freshDb, type Pg, startPg } from "./board_pg.ts";
import { api, project, type Row, startUi, type Running } from "./web_ui_support.ts";
import { posted, PR_CONFIG, prProject, RED_HEAD } from "./web_ui_pr_support.ts";

const T = 90_000;
let pg: Pg;
const running: Running[] = [];
const roots: string[] = [];
const drops: (() => Promise<void>)[] = [];
const boards: Board[] = [];

beforeAll(async () => {
  pg = await startPg();
}, 600_000);

afterAll(async () => {
  for (const r of running) await r.stop();
  for (const b of boards) await b.end().catch(() => {});
  for (const d of drops) await d().catch(() => {});
  for (const d of roots) rmSync(d, { recursive: true, force: true });
  pg?.stop();
}, 120_000);

test("request changes: a must-fix on the pull request and a verdict to its author on the task's thread", async () => {
  const db = await freshDb(pg);
  drops.push(db.drop);
  const board = await Board.open(db.url, { as: "system", max: 1 });
  boards.push(board);
  await board.migrate();
  const t7 = await board.create({ title: "Login", ref: "github:o/work#7", priority: 1 });

  const p = project(PR_CONFIG);
  roots.push(p.root);
  prProject(p);
  const ui = await startUi(p, ["--port", "0"], null, { MB_URL: db.url });
  running.push(ui);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && (await api(ui, "/api/projects/work/tasks")).json.from !== "board") await Bun.sleep(150);

  const r = await api(ui, "/api/projects/work/pull-requests/23/actions/request-changes", { method: "POST",
    body: { confirm: true, text: "Keep the session in a cookie." } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(String(r.json.output)).toContain("Told menelik on the message board, on #7's thread.");
  const comment = posted(p).find((x) => x.kind === "comment") as Row;
  expect(String(comment.body).startsWith(`<!-- factory-mustfix sha=${RED_HEAD} -->`)).toBe(true);
  const thread = await board.thread({ task: t7.id });
  expect(thread.map((m) => [m.kind, m.from, m.to])).toEqual([["verdict", "web-ui", "menelik"]]);
  expect(thread[0]?.body).toContain("PR #23: the owner asks for changes.");
  expect(thread[0]?.body).toContain("Keep the session in a cookie.");
}, T);
