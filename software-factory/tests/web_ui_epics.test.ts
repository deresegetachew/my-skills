// The web UI's epics channel (#440): GET /api/projects/:p/epics from the cockpit's cache, the epic each task belongs to,
// and the channel in the sidebar after tasks. Same harness as web_ui_views.test.ts.
import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { api, project, type Project, type Row, startUi, type Running } from "./web_ui_support.ts";
import { write } from "./support.ts";

const T = 60_000;
const running: Running[] = [];
const roots: string[] = [];
afterAll(async () => {
  for (const r of running) await r.stop();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

const TASKS: Row[] = [
  { id: "7", title: "Add the login page", state: "in-progress", holders: ["menelik"], group: "Phase 1", todos: [], dependsOn: [] },
  { id: "9", title: "Search the catalogue", state: "ready", holders: [], group: "Phase 1", todos: [], dependsOn: [] },
  { id: "11", title: "Index the catalogue", state: "ready", holders: [], group: "Phase 2", todos: [], dependsOn: [] },
];

const EPICS: Row[] = [
  { id: "40", title: "Accounts", stage: "building", tasks: [{ id: "7", done: false }, { id: "8", done: true }], prd: "docs/accounts.md", decisions: ["0003", "0004"] },
  { id: "41", title: "Catalogue search", stage: "planned", tasks: [{ id: "9", done: false }, { id: "7", done: false }], prd: "", decisions: [] },
  { id: "42", title: "Billing", stage: "investigating", tasks: [], prd: "", decisions: [] },
];

function cache(p: Project, epics: Row[] | null): void {
  const tasks: Row = { source: "issues", tasks: TASKS };
  if (epics) tasks.epics = epics;
  write(join(p.state, "cockpit.json"), JSON.stringify({ generatedAt: new Date().toISOString(), sessions: [], needsYou: [], missing: [], tasks,
    pulls: [], ci: { mode: "local", repo: "o/work", label: "", runners: [], runs: [], errors: [] } }));
}

async function started(withCache = true, epics: Row[] | null = EPICS): Promise<Running> {
  const p = project();
  roots.push(p.root);
  if (withCache) cache(p, epics);
  const ui = await startUi(p, ["--port", "0"]);
  running.push(ui);
  return ui;
}

test("epics: each with its stage, progress, tasks, PRD, decisions and search text, in the cache's order", async () => {
  const ui = await started();
  const r = await api(ui, "/api/projects/work/epics");
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.project).toBe("work");
  for (const k of ["generatedAt", "age", "refreshing", "source", "problems"]) expect(r.json).toHaveProperty(k);
  expect(r.json.source).toBe("issues");
  const epics = r.json.epics as Row[];
  expect(epics.map((e) => e.id)).toEqual(["40", "41", "42"]);
  expect(epics[0]).toMatchObject({ id: "40", title: "Accounts", stage: "building", stageText: "building", done: 1, all: 2,
    tasks: [{ id: "7", done: false }, { id: "8", done: true }], prd: "docs/accounts.md", decisions: ["0003", "0004"] });
  expect(epics[2]).toMatchObject({ stage: "investigating", done: 0, all: 0, tasks: [] });
  const find = String(epics[0]?.find).toLowerCase();
  for (const word of ["40", "accounts", "building"]) expect(find).toContain(word);
}, T);

test("epics: the url is the issue's page when the project has one, else null", async () => {
  const ui = await started();
  const epics = (await api(ui, "/api/projects/work/epics")).json.epics as Row[];
  expect(epics[0]?.url === null || String(epics[0]?.url).endsWith("/issues/40")).toBe(true);
}, T);

test("epics: a cache with no epics gives an empty list", async () => {
  const ui = await started(true, null);
  const r = await api(ui, "/api/projects/work/epics");
  expect(r.status).toBe(200);
  expect(r.json.epics).toEqual([]);
}, T);

test("epics: no cache yet says so, with the command that reads it", async () => {
  const ui = await started(false);
  const r = await api(ui, "/api/projects/work/epics");
  expect(r.status).toBe(200);
  expect(r.json.epics).toEqual([]);
  expect((r.json.problems as Row[]).map((x) => x.code)).toContain("ui_no_snapshot");
}, T);

test("epics: the token is needed", async () => {
  const ui = await started();
  expect((await api(ui, "/api/projects/work/epics", { token: null })).status).toBe(401);
}, T);

test("tasks: each says which epic it is in, the first that names it, or null", async () => {
  const ui = await started();
  const tasks = (await api(ui, "/api/projects/work/tasks")).json.tasks as Row[];
  expect(Object.fromEntries(tasks.map((t) => [t.id, t.epic]))).toEqual({ "7": "40", "9": "41", "11": null });
}, T);

test("tasks: a cache without epics leaves every task in none", async () => {
  const ui = await started(true, null);
  const tasks = (await api(ui, "/api/projects/work/tasks")).json.tasks as Row[];
  expect(tasks.map((t) => t.epic)).toEqual([null, null, null]);
}, T);

test("channels: epics is in the sidebar right after tasks", async () => {
  const ui = await started();
  const channels = (await api(ui, "/api/projects/work/channels")).json.channels as Row[];
  const views = channels.filter((c) => c.kind === "view");
  expect(views.map((c) => c.name).slice(0, 3)).toEqual(["tasks", "epics", "pull-requests"]);
  expect(views.find((c) => c.name === "epics")).toEqual({ id: "view:epics", kind: "view", name: "epics", title: "Epics" });
}, T);
