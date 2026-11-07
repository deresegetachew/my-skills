// Needs attention (#579): the web UI's server works out what is stuck from what it already reads (the snapshot's tasks,
// epics, pull requests and CI, this machine's heartbeats, the pull requests gone from the snapshot) and serves it at
// GET /api/projects/:p/attention, on Home, and over the WebSocket. Each case is made to appear with a fake snapshot or
// heartbeat, then fixed, and must clear. Close (a task or an epic) runs through the same confirm as a card's actions,
// through a fake `gh`. The real server (startUi), a fake `factory` and a fake `gh`.
import { afterAll, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { api, CONFIG, heartbeat, hbRow, project, type Project, type Row, startUi, type Running } from "./web_ui_support.ts";
import { readmeAndWiki, write } from "./support.ts";

const T = 60_000;
const running: Running[] = [];
const roots: string[] = [];
afterAll(async () => {
  for (const r of running) await r.stop();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

const ago = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();

const TASKS: Row[] = [
  { id: "7", title: "Add the login page", state: "in-progress", holders: ["menelik"], group: "", todos: [], dependsOn: [] },
  { id: "10", title: "Export to CSV", state: "ready", holders: [], group: "", todos: [], dependsOn: [] },
  { id: "5", title: "Sign up", state: "done", holders: [], group: "", todos: [], dependsOn: [] },
];
const EPICS: Row[] = [{ id: "1", title: "Sign in", stage: "building", prd: "", decisions: [], summary: "", cites: [], url: null,
  tasks: [{ id: "5", done: true }, { id: "7", done: false }] }];

const pull = (n: number, branch: string, more: Row = {}): Row => ({ number: n, title: `PR ${n}`, url: `https://github.com/o/work/pull/${n}`, branch,
  draft: false, ci: "green", next: "review", nextText: "review", agent: "menelik", review: "factory-approved", gate: null, notGreen: [], protected: null,
  claim: null, createdAt: ago(10), ...more });

interface Snap {
  tasks?: Row[];
  epics?: Row[];
  pulls?: Row[];
  ci?: Row;
  needsYou?: Row[];
}

function cache(p: Project, s: Snap = {}): void {
  write(join(p.state, "snapshot.json"), JSON.stringify({ generatedAt: new Date().toISOString(), sessions: [], missing: [], needsYou: s.needsYou ?? [],
    tasks: { source: "issues", tasks: s.tasks ?? TASKS, epics: s.epics ?? EPICS }, pulls: s.pulls ?? [pull(21, "task/7-login")],
    ci: s.ci ?? { mode: "github", repo: "o/work", runners: [], errors: [], runs: [] } }));
}

/** Everyone running and well: menelik works on #7, the others idle. */
const WELL: Row[] = [hbRow("menelik", { state: "working", detail: "working on #7", task: "7", since: ago(5) }), hbRow("taytu"),
  hbRow("fasil", { kind: "dev-manager" }), hbRow("mentewab", { kind: "product-owner" })];

function team(over: Record<string, Row> = {}): Row[] {
  return WELL.map((r) => ({ ...r, ...(over[String(r.name)] ?? {}) }));
}

function workProject(cfg: Row = CONFIG): Project {
  const p = project(cfg);
  roots.push(p.root);
  cache(p);
  heartbeat(p, WELL);
  return p;
}

async function started(p: Project): Promise<Running> {
  const ui = await startUi(p, ["--port", "0"]);
  running.push(ui);
  return ui;
}

type Item = { id: string; kind: string; title: string; reason: string; task: string | null; agent: string | null; pr: number | null; epic: string | null;
  action: { kind: string; label: string; task?: string; agent?: string; link?: string } };

async function items(ui: Running): Promise<Item[]> {
  const r = await api(ui, "/api/projects/work/attention");
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.items as Item[];
}

/** GET attention until `ok` says so (the agents are read again each poll, a second here); the last answer. */
async function until(ui: Running, ok: (x: Item[]) => boolean, ms = 15_000): Promise<Item[]> {
  const deadline = Date.now() + ms;
  let last = await items(ui);
  while (!ok(last) && Date.now() < deadline) {
    await Bun.sleep(150);
    last = await items(ui);
  }
  return last;
}

const has = (id: string) => (x: Item[]) => x.some((i) => i.id === id);
const hasNot = (id: string) => (x: Item[]) => !x.some((i) => i.id === id);
const one = (x: Item[], id: string): Item => x.find((i) => i.id === id) as Item;

test("nothing is stuck: the list is empty, and the thresholds in use are their defaults", async () => {
  const ui = await started(workProject());
  const r = await api(ui, "/api/projects/work/attention");
  expect(r.status).toBe(200);
  expect(r.json.items).toEqual([]);
  expect(r.json.limits).toEqual({ taskQuietMinutes: 60, prWaitHours: 24, maxMinutes: { "coding-agent": 120, "dev-manager": 30, "product-owner": 30 } });
}, T);

test("an agent down while it holds a task: Start it, and its task shows held by one that is down (Release); both clear when it runs", async () => {
  const p = workProject();
  const ui = await started(p);
  heartbeat(p, team({ menelik: { state: "down", detail: "down", task: null, since: null } }));
  const x = await until(ui, (l) => has("agent-down:menelik")(l) && has("task-quiet:7")(l));
  expect(one(x, "agent-down:menelik")).toMatchObject({ kind: "agent-down", agent: "menelik", task: "7", reason: "menelik is down but holds #7.",
    action: { kind: "start", label: "Start menelik", agent: "menelik" } });
  expect(one(x, "task-quiet:7")).toMatchObject({ title: "#7 Add the login page", reason: "Held by menelik, which is down.",
    action: { kind: "release", label: "Release", task: "7" } });
  heartbeat(p, WELL);
  expect(await until(ui, (l) => l.length === 0)).toEqual([]);
}, T);

test("a session working longer than its role's limit: open its output; a higher attention.<role>.maxMinutes clears it", async () => {
  const p = workProject();
  const ui = await started(p);
  heartbeat(p, team({ fasil: { state: "working", detail: "reviewing PR #21", since: ago(82) } }));
  const x = await until(ui, has("session-long:fasil"));
  expect(one(x, "session-long:fasil")).toMatchObject({ title: "fasil has been working for 82 minutes",
    reason: "Working for 82 minutes; the limit for a dev manager is 30. It may be stuck.", action: { kind: "open", label: "Open its output", link: "agent:fasil" } });
  write(join(p.d, ".claude", "factory.json"), JSON.stringify({ ...CONFIG, attention: { "dev-manager": { maxMinutes: 90 } } }));
  expect(await until(ui, hasNot("session-long:fasil"))).toEqual([]);
  expect(((await api(ui, "/api/projects/work/attention")).json.limits as Row).maxMinutes).toMatchObject({ "dev-manager": 90 });
}, T);

test("a role down while its queue has items: no dev manager with a PR to review, no product owner with an ask; Start clears", async () => {
  const p = workProject();
  cache(p, { needsYou: [{ kind: "owner-ask", id: "v11", issue: 50, url: null, ageMinutes: 30, state: "product", text: "Add v1.1 to the PRD" }] });
  const ui = await started(p);
  heartbeat(p, team({ fasil: { state: "down", detail: "down", since: null }, mentewab: { state: "down", detail: "down", since: null } }));
  const x = await until(ui, (l) => has("role-down:dev-manager")(l) && has("role-down:product-owner")(l));
  expect(one(x, "role-down:dev-manager")).toMatchObject({ title: "No dev manager is running", agent: "fasil",
    reason: "1 pull request waits for review, and no dev manager runs to take it.", action: { kind: "start", agent: "fasil" } });
  expect(one(x, "role-down:product-owner")).toMatchObject({ title: "No product owner is running",
    reason: "1 ask waits for it, and no product owner runs to take it.", action: { kind: "start", label: "Start mentewab", agent: "mentewab" } });
  heartbeat(p, WELL);
  expect(await until(ui, (l) => l.length === 0)).toEqual([]);
}, T);

test("a role down with an empty queue isn't flagged", async () => {
  const p = workProject();
  cache(p, { pulls: [] });
  heartbeat(p, team({ fasil: { state: "down", detail: "down", since: null }, mentewab: { state: "down", detail: "down", since: null } }));
  const ui = await started(p);
  await Bun.sleep(1500);
  expect(await items(ui)).toEqual([]);
}, T);

test("a pull request waiting more than attention.prWaitHours: red checks, no review, a merge only a person can do; open the PR", async () => {
  const p = workProject();
  const ui = await started(p);
  cache(p, { pulls: [pull(21, "task/7-login", { ci: "red", createdAt: ago(30 * 60) }), pull(22, "task/8-x", { review: null, createdAt: ago(25 * 60) }),
    pull(23, "task/9-y", { next: "owner-merges", nextText: "owner merges (protected)", createdAt: ago(48 * 60) }),
    pull(24, "task/11-z", { review: "factory-mustfix", createdAt: ago(26 * 60) }),
    pull(25, "task/12-w", { ci: "red", draft: true, createdAt: ago(48 * 60) }), pull(26, "task/13-v", { ci: "red", createdAt: ago(60) })] });
  const x = await until(ui, has("pr-waiting:21"));
  expect(x.filter((i) => i.kind === "pr-waiting").map((i) => [i.pr, i.reason, i.action.link])).toEqual([
    [21, "Its checks are red; open for 30 hours.", "pr:21"],
    [22, "Nobody has reviewed it; open for 25 hours.", "pr:22"],
    [23, "Only a person can merge it; open for 48 hours.", "pr:23"],
    [24, "A must-fix waits and nobody has picked it up; open for 26 hours.", "pr:24"],
  ]); // a draft, and one opened an hour ago, aren't
  cache(p);
  expect(await until(ui, (l) => l.length === 0)).toEqual([]);
}, T);

test("an epic whose tasks are all done and still open: Close the epic; it clears once closed", async () => {
  const p = workProject();
  const ui = await started(p);
  cache(p, { epics: [{ ...EPICS[0], tasks: [{ id: "5", done: true }, { id: "6", done: true }] }] });
  const x = await until(ui, has("epic-done:1"));
  expect(one(x, "epic-done:1")).toMatchObject({ title: "#1 Sign in", epic: "1", reason: "All 2 tasks are done, but the epic is still open.",
    action: { kind: "close", label: "Close the epic", task: "1" } });
  cache(p, { epics: [{ ...EPICS[0], stage: "done", tasks: [{ id: "5", done: true }, { id: "6", done: true }] }] });
  expect(await until(ui, hasNot("epic-done:1"))).toEqual([]);
}, T);

test("a PRD change still open while tasks are being built (#578): open the PR; it clears when the PR is merged", async () => {
  const p = workProject();
  const ui = await started(p);
  cache(p, { pulls: [pull(21, "task/7-login"), pull(62, "po/prd-v1-1", { title: "PRD: Shelf v1.1", agent: null })] });
  const x = await until(ui, has("prd-open:62"));
  expect(one(x, "prd-open:62")).toMatchObject({ title: "PR #62 PRD: Shelf v1.1", pr: 62,
    reason: "This PRD change is still open while 1 task is being built from it. Read it, then merge it or say what to change.",
    action: { kind: "open", label: "Open the PR", link: "pr:62" } });
  cache(p);
  expect(await until(ui, hasNot("prd-open:62"))).toEqual([]);
}, T);

test("a task whose pull request is no longer open but isn't done: Close; it clears once the task is done", async () => {
  const p = workProject();
  const ui = await started(p);
  expect(await items(ui)).toEqual([]); // the first look keeps which pull requests are open
  cache(p, { pulls: [] });
  const x = await until(ui, has("task-pr-gone:7"));
  expect(one(x, "task-pr-gone:7")).toMatchObject({ title: "#7 Add the login page", task: "7", pr: 21,
    reason: "PR #21 is no longer open (merged or closed), but #7 is still in progress.", action: { kind: "close", label: "Close", task: "7" } });
  expect(x.some((i) => i.id === "task-quiet:7")).toBe(false); // said once, as the stronger reason
  cache(p, { pulls: [], tasks: TASKS.map((t) => (t.id === "7" ? { ...t, state: "done", holders: [] } : t)) });
  expect(await until(ui, hasNot("task-pr-gone:7"))).toEqual([]);
}, T);

test("every CI runner offline: open CI; it clears when one is back", async () => {
  const p = workProject();
  const ui = await started(p);
  const ci = (status: string): Row => ({ mode: "local", repo: "o/work", errors: [], runs: [],
    runners: [{ name: "work-ci-m-here-1", status, busy: false }, { name: "work-ci-m-here-2", status: "offline", busy: false }] });
  cache(p, { ci: ci("offline") });
  const x = await until(ui, has("runners-down:ci"));
  expect(one(x, "runners-down:ci")).toMatchObject({ title: "Every CI runner is offline", reason: "2 runners and none online, so the checks can't run.",
    action: { kind: "open", label: "Open CI", link: "view:ci" } });
  cache(p, { ci: ci("online") });
  expect(await until(ui, hasNot("runners-down:ci"))).toEqual([]);
}, T);

test("the message board down while it keeps the tasks: open Health; it clears when the tasks don't depend on it", async () => {
  const p = workProject({ ...CONFIG, tasks: { source: "board" } });
  const ui = await started(p);
  const x = await until(ui, has("board-down:board"));
  expect(one(x, "board-down:board")).toMatchObject({ title: "The message board can't be reached", action: { kind: "open", label: "Open Health", link: "page:health" } });
  expect(one(x, "board-down:board").reason).toContain("can't be reached");
  write(join(p.d, ".claude", "factory.json"), JSON.stringify(CONFIG));
  expect(await until(ui, hasNot("board-down:board"))).toEqual([]);
}, T);

test("Home carries the list, and the WebSocket pushes it on connect and again when it changes", async () => {
  const p = workProject();
  const ui = await started(p);
  const home = await api(ui, "/api/projects/work/home");
  expect(home.json.attention).toEqual([]);
  const ws = new WebSocket(ui.url.replace("http", "ws") + `/api/ws?token=${ui.token}`);
  const seen: Row[] = [];
  ws.onmessage = (e) => seen.push(JSON.parse(String(e.data)) as Row);
  const pushed = async (ok: (m: Row) => boolean): Promise<Row | undefined> => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const m = seen.find((x) => x.type === "attention" && x.project === "work" && ok(x));
      if (m) return m;
      await Bun.sleep(100);
    }
    return undefined;
  };
  expect(await pushed((m) => Array.isArray(m.items) && (m.items as Item[]).length === 0)).toBeTruthy();
  heartbeat(p, team({ menelik: { state: "down", detail: "down", task: null, since: null } }));
  const m = await pushed((x) => (x.items as Item[]).some((i) => i.id === "agent-down:menelik"));
  expect(m, JSON.stringify(seen.filter((x) => x.type === "attention"))).toBeTruthy();
  ws.close();
  const again = await api(ui, "/api/projects/work/home");
  expect((again.json.attention as Item[]).map((i) => i.id)).toContain("agent-down:menelik");
}, T);

test("Close runs after a confirm: a task's and an epic's issue are closed as completed through gh; a done task can't be", async () => {
  const p = workProject();
  write(join(p.root, "db.json"), JSON.stringify({ issues: [{ number: 7, title: "Add the login page", state: "open", labels: [] },
    { number: 1, title: "Sign in", state: "open", labels: [{ name: "epic" }] }] }));
  const ui = await started(p);
  const no = await api(ui, "/api/projects/work/tasks/7/actions/close", { method: "POST", body: {} });
  expect(no.status).toBe(400);
  expect(no.json).toMatchObject({ code: "confirm_needed" });
  expect(readFileSync(p.ghLog, "utf8")).not.toContain("issues/7");
  const r = await api(ui, "/api/projects/work/tasks/7/actions/close", { method: "POST", body: { confirm: true } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const e = await api(ui, "/api/projects/work/tasks/1/actions/close", { method: "POST", body: { confirm: true } });
  expect(e.status, JSON.stringify(e.json)).toBe(200);
  const log = readFileSync(p.ghLog, "utf8");
  expect(log).toContain("gh api -X PATCH repos/{owner}/{repo}/issues/7 -f state=closed -f state_reason=completed");
  expect(log).toContain("gh api -X PATCH repos/{owner}/{repo}/issues/1 -f state=closed -f state_reason=completed");
  const done = await api(ui, "/api/projects/work/tasks/5/actions/close", { method: "POST", body: { confirm: true } });
  expect(done.status).toBe(400);
  expect(done.json).toMatchObject({ code: "ui_action_unavailable" });
  const tasks = (await api(ui, "/api/projects/work/tasks")).json.tasks as Row[];
  expect(tasks.find((t) => t.id === "7")?.actions).toEqual(["release", "block", "reassign"]); // Close isn't a card's action
}, T);

test("the thresholds are settings, on the settings page", () => {
  const page = readmeAndWiki("settings.md");
  for (const key of ["attention.taskQuietMinutes", "attention.prWaitHours", "attention.coding-agent.maxMinutes", "attention.dev-manager.maxMinutes",
    "attention.product-owner.maxMinutes"]) expect(page).toContain(`| \`${key}\` | int |`);
});
