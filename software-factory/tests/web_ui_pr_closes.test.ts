// A pull request whose body says Closes b3 (the snapshot's `closes`) is linked to that card on the Board, after its
// branch and its title (#545 item 4). A real Postgres board, the real server, a fake `factory`.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Board } from "../message-board/src/index.ts";
import { freshDb, type Pg, startPg } from "./board_pg.ts";
import { api, CONFIG, project, type Row, startUi, type Running } from "./web_ui_support.ts";
import { write, writeExe } from "./support.ts";

const T = 90_000;
const REPO = "o/work";
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
`;

/** `@0` and `@1` in a branch, title or closes stand for the first and second card's id (`b<id>`). */
const pr = (n: number, branch: string, title: string, closes: string[]): Row => ({ number: n, title, url: `https://github.com/${REPO}/pull/${n}`, branch,
  draft: false, ci: "green", next: "none", nextText: "none", agent: "taytu", review: null, gate: null, notGreen: [], protected: null, claim: null, closes });

async function linked(pulls: Row[]): Promise<(card: number) => number | undefined> {
  const db = await freshDb(pg);
  drops.push(db.drop);
  const board = await Board.open(db.url, { as: "system", max: 1 });
  boards.push(board);
  await board.migrate();
  const ids: number[] = [];
  for (const t of [{ title: "Slugify", ref: `factory:${REPO}/s1` }, { title: "Word count", ref: `factory:${REPO}/w1` }]) {
    ids.push((await board.create({ title: t.title, ref: t.ref, priority: 0 })).id);
  }
  const sub = (s: string): string => s.replace(/@(\d+)/g, (_, i: string) => `b${ids[Number(i)]}`);
  const p = project(CONFIG);
  roots.push(p.root);
  writeExe(join(p.d, "factory"), FAKE_FACTORY);
  write(join(p.state, "snapshot.json"), JSON.stringify({ generatedAt: new Date().toISOString(), sessions: [], needsYou: [], missing: [],
    tasks: { source: "issues", tasks: [], epics: [] },
    pulls: pulls.map((x) => ({ ...x, branch: sub(String(x.branch)), title: sub(String(x.title)), closes: (x.closes as string[]).map(sub) })),
    ci: { mode: "github", repo: REPO, runners: [], runs: [], errors: [] } }));
  const ui = await startUi(p, ["--port", "0"], null, { MB_URL: db.url });
  running.push(ui);
  const deadline = Date.now() + 15_000;
  let json: Row = {};
  while (Date.now() < deadline) {
    json = (await api(ui, "/api/projects/work/tasks")).json;
    if ((json.tasks as Row[]).some((t) => t.id === `b${ids[0]}`)) break;
    await Bun.sleep(150);
  }
  const byId = Object.fromEntries((json.tasks as Row[]).map((t) => [String(t.id), t]));
  return (card) => (byId[`b${ids[card]}`]?.pr as Row | null)?.number as number | undefined;
}

test("a pull request with an unrelated branch and title but closes b<id> is linked to that card", async () => {
  const prOf = await linked([pr(50, "taytu/misc", "Tidy things", ["@0"])]);
  expect(prOf(0)).toBe(50);
  expect(prOf(1)).toBeUndefined();
}, T);

test("the branch wins over closes, and the title wins over closes", async () => {
  const prOf = await linked([pr(51, "task/@0-slugify", "Slugify", ["@1"]), pr(52, "taytu/wc", "@1: word count", ["@0"])]);
  expect(prOf(0)).toBe(51);
  expect(prOf(1)).toBe(52);
}, T);

test("with several closes the first names the card", async () => {
  const prOf = await linked([pr(53, "taytu/misc", "Tidy things", ["@1", "@0"])]);
  expect(prOf(1)).toBe(53);
  expect(prOf(0)).toBeUndefined();
}, T);
