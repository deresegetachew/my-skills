// The web UI's tasks and pull requests carry the citations in their bodies (`cites`) from the snapshot's cache, so the page
// can link them to the Docs section; a cache without them gives [].
import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { api, project, type Row, startUi, type Running } from "./web_ui_support.ts";
import { write } from "./support.ts";

const T = 60_000;
const running: Running[] = [];
const roots: string[] = [];
afterAll(async () => {
  for (const r of running) await r.stop();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

const task = (id: string, more: Row = {}): Row => ({ id, title: `Task ${id}`, state: "ready", holders: [], group: "Phase 1", todos: [], dependsOn: [], ...more });
const pull = (number: number, more: Row = {}): Row => ({ number, title: `Pull ${number}`, url: `https://github.com/o/work/pull/${number}`,
  branch: `task/${number}-x`, draft: false, ci: "green", next: "waiting-for-agent", nextText: "waiting for agent", agent: null, review: null,
  gate: null, notGreen: [], protected: null, claim: null, ...more });

async function started(): Promise<Running> {
  const p = project();
  roots.push(p.root);
  write(join(p.state, "snapshot.json"), JSON.stringify({ generatedAt: new Date().toISOString(), sessions: [], needsYou: [], missing: [],
    tasks: { source: "issues", tasks: [task("1", { cites: ["decision 0004", "US-12"] }), task("2")] },
    pulls: [pull(21, { cites: ["ADR 5"] }), pull(22)], ci: null }));
  const ui = await startUi(p, ["--port", "0"]);
  running.push(ui);
  return ui;
}

test("tasks: each task passes its cites through, [] when the cache has none", async () => {
  const ui = await started();
  const r = await api(ui, "/api/projects/work/tasks");
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect((r.json.tasks as Row[]).map((t) => [t.id, t.cites])).toEqual([["1", ["decision 0004", "US-12"]], ["2", []]]);
}, T);

test("pull requests: each pull passes its cites through, [] when the cache has none", async () => {
  const ui = await started();
  const r = await api(ui, "/api/projects/work/pull-requests");
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect((r.json.pulls as Row[]).map((x) => [x.number, x.cites])).toEqual([[21, ["ADR 5"]], [22, []]]);
}, T);
