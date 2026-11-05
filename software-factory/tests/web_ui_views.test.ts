// The web UI's tasks, pull requests and CI channels (#424): their JSON from the cockpit's cache (written by hand here),
// the CI view's actions (#396) running the same commands the cockpit's CI view runs, through a fake `factory` and a fake
// `gh` that log what they were asked, the token on every new endpoint, a read-again that runs `factory cockpit --json`,
// and the views sent over the WebSocket again when the cache changes.
import { afterAll, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
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
  { id: "9", title: "Search the catalogue", state: "ready", holders: [], group: "Phase 1", todos: [], dependsOn: ["11"] },
  { id: "10", title: "Export to CSV", state: "ready", holders: [], group: "Phase 1", todos: [{ done: true }, { done: false }], dependsOn: [] },
  { id: "11", title: "Index the catalogue", state: "new", holders: [], group: "Phase 2", todos: [], dependsOn: [] },
  { id: "12", title: "Pay by card", state: "blocked", holders: [], group: "Phase 2", todos: [], dependsOn: [] },
];

const PULLS: Row[] = [
  { number: 21, title: "Add the login page", url: "https://github.com/o/work/pull/21", branch: "task/7-login", draft: false, ci: "red",
    next: "waiting-for-agent", nextText: "waiting for agent", agent: "menelik", review: "factory-mustfix", gate: null,
    notGreen: [{ name: "test", state: "red" }], protected: null, claim: null },
  { number: 22, title: "The settings page", url: "https://github.com/o/work/pull/22", branch: "task/8-settings", draft: false, ci: "green",
    next: "owner-merges", nextText: "owner merges (protected)", agent: "taytu", review: "factory-approved", gate: null, notGreen: [],
    protected: true, claim: { manager: "fasil", until: "2026-11-05T12:00:00Z", expired: false } },
  { number: 23, title: "Docs", url: "https://github.com/o/work/pull/23", branch: "docs-fix", draft: true, ci: "none", next: "waiting-for-agent",
    nextText: "waiting for agent", agent: null, review: null, gate: null, notGreen: [], protected: null, claim: null },
];

const CI: Row = {
  mode: "local", repo: "o/work", label: "work-local", runsOn: "[\"self-hosted\",\"work-local\"]",
  runners: [{ name: "work-ci-m-here-1", status: "online", busy: true }, { name: "work-ci-old-box-2", status: "offline", busy: false }],
  light: { label: "work-light", runners: [{ name: "work-ci-m-here.light-1", status: "online", busy: false }] },
  runs: [
    { ref: "#21", branch: "task/7-login", state: "failure", name: "CI", createdAt: "", minutesAgo: 30, id: 9300 },
    { ref: "main", branch: "main", state: "in_progress", name: "CI", createdAt: "", minutesAgo: 4, id: 9000 },
    { ref: "#22", branch: "task/8-settings", state: "queued", name: "CI", createdAt: "", minutesAgo: 2, id: 9100 },
  ],
  queuedLong: { count: 0, longestMinutes: 0, thresholdMinutes: 15, noRunnerOnline: false },
  errors: [],
};

function cache(p: Project, more: Row = {}): void {
  write(join(p.state, "cockpit.json"), JSON.stringify({ generatedAt: new Date().toISOString(), sessions: [], needsYou: [], missing: [],
    tasks: { source: "issues", tasks: TASKS }, pulls: PULLS, ci: CI, ...more }));
}

async function started(withCache = true, env: Record<string, string> = {}): Promise<{ ui: Running; p: Project }> {
  const p = project();
  roots.push(p.root);
  if (withCache) cache(p);
  const ui = await startUi(p, ["--port", "0"], null, env);
  running.push(ui);
  return { ui, p };
}

function factoryCalls(p: Project): string[] {
  return readFileSync(p.factoryLog, "utf8").split("\n").filter(Boolean);
}

// --- tasks ---------------------------------------------------------------------------------------------------------------

test("tasks: in the order factory next walks them, with state, agent, links and which one is next", async () => {
  const { ui } = await started();
  const r = await api(ui, "/api/projects/work/tasks");
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.source).toBe("issues");
  const tasks = r.json.tasks as Row[];
  expect(tasks.map((t) => t.id)).toEqual(["7", "9", "10", "11", "12"]);
  expect(tasks[0]).toMatchObject({ id: "7", title: "Add the login page", state: "in-progress", stateText: "in progress", holders: ["menelik"],
    group: "Phase 1", url: "https://github.com/o/work/issues/7", pr: { number: 21, url: "https://github.com/o/work/pull/21" }, next: false });
  expect(tasks[3]?.stateText).toBe("not ready");
  // #9 waits for #11, which is still open: the next one is #10
  expect(r.json.next).toBe("10");
  expect(tasks.filter((t) => t.next).map((t) => t.id)).toEqual(["10"]);
  expect(tasks[2]?.todos).toEqual({ done: 1, all: 2 });
  // the search matches what the cockpit's does (#392): number, title, lane, holders, phase
  expect(String(tasks[0]?.find)).toBe("#7 Add the login page in progress menelik Phase 1");
}, T);

test("tasks: no cache yet says so, with the command that reads it", async () => {
  const { ui } = await started(false);
  const r = await api(ui, "/api/projects/work/tasks");
  expect(r.status).toBe(200);
  expect(r.json.tasks).toEqual([]);
  expect((r.json.problems as Row[]).map((x) => x.code)).toContain("ui_no_snapshot");
}, T);

// --- pull requests ---------------------------------------------------------------------------------------------------------

test("pull requests: each with its checks, review state, protected files, agent and task", async () => {
  const { ui } = await started();
  const r = await api(ui, "/api/projects/work/pull-requests");
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const pulls = r.json.pulls as Row[];
  expect(pulls.map((x) => x.number)).toEqual([21, 22, 23]);
  expect(pulls[0]).toMatchObject({ number: 21, agent: "menelik", task: "7", checks: { state: "red", failing: ["test"] },
    review: { state: "changes-asked" }, protected: null, next: { action: "waiting-for-agent", text: "waiting for agent" } });
  expect(pulls[1]).toMatchObject({ number: 22, agent: "taytu", task: "8", checks: { state: "green", failing: [] },
    review: { state: "approved", claim: "fasil" }, protected: true, next: { action: "owner-merges", text: "owner merges (protected)" } });
  expect(pulls[2]).toMatchObject({ number: 23, draft: true, agent: null, task: null, review: { state: "none" } });
  expect(String(pulls[0]?.find)).toBe("#21 Add the login page task/7-login menelik");
}, T);

// --- CI ------------------------------------------------------------------------------------------------------------------

test("CI: the verdict first, then the runs (going first), the runners by machine, and the actions with their commands", async () => {
  const { ui } = await started(true, { FACTORY_CI_RUNNERS: "2" });
  const r = await api(ui, "/api/projects/work/ci");
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(Object.keys(r.json)[0]).toBe("verdict");
  expect(r.json.verdict).toEqual({ text: "CI is busy: the one runner online is running a job; 1 run queued", tone: "amber" });
  expect((r.json.runs as Row[]).map((x) => x.id)).toEqual([9000, 9100, 9300]);
  expect((r.json.runs as Row[])[2]).toMatchObject({ ref: "#21", state: "failure", failed: true });
  expect(r.json.runners).toEqual([
    expect.objectContaining({ name: "work-ci-m-here-1", lane: "heavy", machine: "m-here", state: "busy" }),
    expect.objectContaining({ name: "work-ci-old-box-2", lane: "heavy", machine: "old-box", state: "offline" }),
    expect.objectContaining({ name: "work-ci-m-here.light-1", lane: "light", machine: "m-here", state: "idle" }),
  ]);
  expect(r.json.waiting).toEqual(["#22"]);
  const actions = Object.fromEntries((r.json.actions as Row[]).map((a) => [a.name, a]));
  expect(actions.install).toMatchObject({ command: "factory ci install" });
  expect(actions["use-local"]).toMatchObject({ command: "factory ci use local" });
  expect(actions["use-github"]).toMatchObject({ command: "factory ci use github" });
  expect(actions["runners-up"]).toMatchObject({ command: "factory ci runners 3" });
  expect(actions["runners-down"]).toMatchObject({ command: "factory ci runners 1" });
  expect(actions["light-lane"]).toMatchObject({ command: "factory settings set --stage ci.light false then factory settings pr" });
  expect(actions.clean).toMatchObject({ command: "factory ci clean --apply" });
  expect(r.json.settings).toMatchObject({ heavy: { raw: "2", source: "FACTORY_CI_RUNNERS" }, light: true });
}, T);

test("a CI action needs a confirm: without it 400 confirm_needed and nothing runs", async () => {
  const { ui, p } = await started();
  const r = await api(ui, "/api/projects/work/ci/actions/install", { method: "POST", body: {} });
  expect(r.status).toBe(400);
  expect(r.json.code).toBe("confirm_needed");
  expect(factoryCalls(p)).toEqual([]);
}, T);

test("each CI action runs the command the cockpit's CI view runs", async () => {
  const { ui, p } = await started(true, { FACTORY_CI_RUNNERS: "2" });
  const want: Array<[string, string[]]> = [
    ["install", ["ci install"]],
    ["use-local", ["ci use local"]],
    ["use-github", ["ci use github"]],
    ["runners-up", ["ci runners 3"]],
    ["runners-down", ["ci runners 1"]],
    ["light-lane", ["settings set --stage ci.light false", "settings pr"]],
    ["clean", ["ci clean --apply"]],
  ];
  const seen: string[] = [];
  for (const [name, calls] of want) {
    const r = await api(ui, `/api/projects/work/ci/actions/${name}`, { method: "POST", body: { confirm: true } });
    expect(r.status, `${name}: ${JSON.stringify(r.json)}`).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.command).toBe(calls.map((c) => `factory ${c}`).join(" then "));
    seen.push(...calls);
  }
  // after an action the server reads the snapshot again (factory cockpit --json), so the channel shows what changed
  expect(factoryCalls(p).filter((c) => c !== "cockpit --json")).toEqual(seen);
  expect(factoryCalls(p)).toContain("cockpit --json");
}, T);

test("rerun runs gh run rerun on a failed run; a run that didn't fail is refused and nothing runs", async () => {
  const { ui, p } = await started();
  const no = await api(ui, "/api/projects/work/ci/actions/rerun", { method: "POST", body: { confirm: true, run: 9000 } });
  expect(no.status).toBe(400);
  expect(no.json.code).toBe("ui_action_unavailable");
  expect(String(no.json.message)).toContain("Only a failed run can be rerun");
  expect(readFileSync(p.ghLog, "utf8")).not.toContain("run rerun");
  await api(ui, "/api/projects/work/ci/actions/rerun", { method: "POST", body: { confirm: true, run: 9300 } });
  expect(readFileSync(p.ghLog, "utf8")).toContain("gh run rerun 9300 --failed --repo o/work");
}, T);

test("a run's log is read through factory ci log, without a confirm", async () => {
  const { ui, p } = await started();
  const r = await api(ui, "/api/projects/work/ci/actions/log", { method: "POST", body: { run: 9300 } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.command).toBe("factory ci log 21");
  expect(factoryCalls(p)).toEqual(["ci log 21"]);
}, T);

test("an unknown CI action is 404, and a GET of an action is 405", async () => {
  const { ui, p } = await started();
  const r = await api(ui, "/api/projects/work/ci/actions/reboot", { method: "POST", body: { confirm: true } });
  expect(r.status).toBe(404);
  expect(r.json.code).toBe("ui_action_unknown");
  expect((await api(ui, "/api/projects/work/ci/actions/install")).status).toBe(405);
  expect(factoryCalls(p)).toEqual([]);
}, T);

test("a failing CI action is 500 with the command's own error and its output", async () => {
  const { ui, p } = await started();
  write(join(p.d, "factory"), '#!/usr/bin/env bash\necho \'{"code": "ci_no_docker", "message": "No Docker.", "fix": "Start Docker."}\' >&2\nexit 1\n', 0o755);
  const r = await api(ui, "/api/projects/work/ci/actions/install", { method: "POST", body: { confirm: true } });
  expect(r.status).toBe(500);
  expect(r.json).toMatchObject({ ok: false, code: "ci_no_docker", message: "No Docker.", fix: "Start Docker." });
}, T);

// --- read again, the token, live --------------------------------------------------------------------------------------------

test("read again runs factory cockpit --json in the project", async () => {
  const { ui, p } = await started();
  const r = await api(ui, "/api/projects/work/refresh", { method: "POST", body: {} });
  expect(r.status, JSON.stringify(r.json)).toBe(202);
  expect(r.json).toMatchObject({ ok: true, command: "factory cockpit --json" });
  for (let i = 0; i < 50 && !factoryCalls(p).length; i++) await Bun.sleep(100);
  expect(factoryCalls(p)).toEqual(["cockpit --json"]);
}, T);

test("every new endpoint needs the token, and nothing runs without it", async () => {
  const { ui, p } = await started();
  const gets = ["/api/projects/work/tasks", "/api/projects/work/pull-requests", "/api/projects/work/ci"];
  for (const path of gets) {
    expect((await api(ui, path, { token: null })).json.code, path).toBe("ui_token_missing");
    expect((await api(ui, path, { token: "x".repeat(ui.token.length) })).json.code, path).toBe("ui_token_wrong");
  }
  for (const path of ["/api/projects/work/ci/actions/install", "/api/projects/work/refresh"]) {
    const none = await api(ui, path, { method: "POST", body: { confirm: true }, token: null });
    expect(none.status, path).toBe(401);
    const wrong = await api(ui, path, { method: "POST", body: { confirm: true }, token: "nope" });
    expect(wrong.status, path).toBe(401);
  }
  await Bun.sleep(300);
  expect(factoryCalls(p)).toEqual([]);
}, T);

test("the WebSocket sends the views on connect, and again when the cockpit's cache changes", async () => {
  const { ui, p } = await started();
  const ws = new WebSocket(ui.url.replace("http", "ws") + `/api/ws?token=${ui.token}`);
  const views = (want: (m: Row) => boolean): Promise<Row | null> => new Promise((done) => {
    const timer = setTimeout(() => done(null), 15_000);
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(String(e.data)) as Row;
      if (m.type === "views" && m.project === "work" && want(m)) {
        clearTimeout(timer);
        done(m);
      }
    });
  });
  const first = await views(() => true);
  expect(first).not.toBeNull();
  expect(((first as Row).tasks as Row).tasks).toHaveLength(5);
  expect(((first as Row).ci as Row).verdict).toBeDefined();
  expect(((first as Row).pulls as Row).pulls).toHaveLength(3);
  cache(p, { tasks: { source: "issues", tasks: TASKS.slice(0, 2) } });
  const next = await views((m) => ((m.tasks as Row).tasks as Row[]).length === 2);
  ws.close();
  expect(next).not.toBeNull();
}, T);
