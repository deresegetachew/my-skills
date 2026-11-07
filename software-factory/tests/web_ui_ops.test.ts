// The web UI's Health, Usage and cost, Activity and Home pages (#455, #451), driven through the real server with a fake
// `factory` (it logs what it was asked and answers `doctor --json` and `usage ... --json` from files), a fake `gh` and a
// snapshot cache written by hand: the JSON each page gets, the command each action runs, and that the doctor (it costs
// GitHub calls) and the usage report are run once and kept, never on each look.
import { afterAll, expect, test } from "bun:test";
import { readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { api, CONFIG, heartbeat, hbRow, project, type Project, type Row, startUi, type Running } from "./web_ui_support.ts";
import { HOOKS, write, writeExe } from "./support.ts";

const T = 60_000;
const running: Running[] = [];
const roots: string[] = [];
afterAll(async () => {
  for (const r of running) await r.stop();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

const FAKE_FACTORY = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_FACTORY_LOG"
if [ "\${1:-}" = usage ] && [ -n "\${FAKE_USAGE_REAL:-}" ]; then shift; exec "$FAKE_BUN" --no-env-file --config=/dev/null "$FAKE_USAGE_REAL" "$@"; fi
if [ "\${1:-}" = usage ] && [ "\${2:-}" != --github ] && [ -n "\${FAKE_USAGE_FAIL:-}" ]; then echo "$FAKE_USAGE_FAIL" >&2; exit 2; fi
case "$*" in
  "doctor --json") sleep "\${FAKE_DOCTOR_SLEEP:-0}"; cat "$FAKE_DOCTOR"; exit 1 ;;
  "usage --json") cat "$FAKE_USAGE_TASK" ;;
  "usage --json --by worker") cat "$FAKE_USAGE_WORKER" ;;
  "usage --github --json") cat "$FAKE_USAGE_GITHUB" ;;
  snapshot) exit 0 ;;
  *) echo "fake factory: $*" ;;
esac
`;

const DOCTOR = { ok: false, fixes: 1, checks: [
  { group: "machine", level: "ok", what: "git", how: "" },
  { group: "machine", level: "fix", what: "tmux", how: "it is too old: run `brew upgrade tmux`" },
  { group: "github", level: "ok", what: "gh is signed in", how: "" },
  { group: "project", level: "note", what: "trustedReviewers", how: "it is empty" },
  { group: "ci", level: "ok", what: "CI workflows: every factory script they call is there", how: "" },
  { group: "board", level: "ok", what: "message board answers", how: "" },
] };

const tokens = (input: number, write: number, read: number, output: number): Row => ({ input, cache_write: write, cache_read: read, output });
const USAGE_TASK = { since: "2026-10-30T00:00:00+00:00", until: "2026-11-07T00:00:00+00:00", by: "task",
  groups: { "7": { tokens: tokens(100, 700, 5000, 200), replies: 12 }, "10": { tokens: tokens(10, 50, 900, 40), replies: 3 },
    "-": { tokens: tokens(5, 5, 10, 5), replies: 1 } },
  total: { tokens: tokens(115, 755, 5910, 245), replies: 16, tasks: ["10", "7"] } };
const USAGE_WORKER = { since: USAGE_TASK.since, until: USAGE_TASK.until, by: "worker",
  groups: { taytu: { tokens: tokens(100, 700, 5000, 200), replies: 12 }, "(project folder)": { tokens: tokens(15, 55, 910, 45), replies: 4 } },
  total: USAGE_TASK.total };
const GITHUB = { since: "2026-11-07T09:00:00+00:00", total: 42, agents: { "menelik (work)": 30, "- (work)": 12 }, commands: { "factory_prs": 40 },
  endpoints: { "pulls": 20 }, callers: {}, github: { used: 812, limit: 5000, reset: "2026-11-07T10:00:00+00:00" } };

const TASKS: Row[] = [
  { id: "7", title: "Add the login page", state: "in-progress", holders: ["menelik"], group: "", todos: [], dependsOn: [] },
  { id: "10", title: "Export to CSV", state: "ready", holders: [], group: "", todos: [], dependsOn: [] },
  { id: "12", title: "Pay by card", state: "blocked", holders: [], group: "", todos: [], dependsOn: [] },
  { id: "13", title: "Search", state: "blocked", holders: [], group: "", todos: [], dependsOn: [], blockedBy: ["7"] },
  { id: "5", title: "Sign up", state: "done", holders: [], group: "", todos: [], dependsOn: [] },
];
const EPICS: Row[] = [{ id: "1", title: "Sign in", stage: "building", prd: "", decisions: [], summary: "", cites: [], url: null,
  tasks: [{ id: "5", done: true }, { id: "7", done: false }, { id: "10", done: false }] }];

const pull = (n: number, branch: string, more: Row = {}): Row => ({ number: n, title: `PR ${n}`, url: `https://github.com/o/work/pull/${n}`, branch,
  draft: false, ci: "green", next: "review", nextText: "review", agent: "menelik", review: null, gate: null, notGreen: [], protected: null,
  claim: null, createdAt: null, ...more });

function cache(p: Project, more: Row = {}): void {
  write(join(p.state, "snapshot.json"), JSON.stringify({ generatedAt: new Date().toISOString(), sessions: [], missing: [],
    needsYou: [{ kind: "owner-ask", id: "pick-db", issue: 50, url: null, ageMinutes: 30, state: "open", text: "Which database for the cache?" }],
    doctor: { fixes: 1, notes: 0, ok: 4, summary: "1 to fix.", fix: ["tmux: it is too old"] },
    tasks: { source: "issues", tasks: TASKS, epics: EPICS },
    pulls: [pull(21, "task/7-login", { createdAt: "2026-11-07T08:00:00Z" }),
      pull(22, "task/8-settings", { next: "owner-merges", nextText: "owner merges (protected)", agent: "taytu", createdAt: "2026-11-07T07:00:00Z" })],
    ci: { mode: "github", repo: "o/work", runners: [], errors: [], runs: [
      { ref: "main", branch: "main", state: "failure", name: "CI", minutesAgo: 10, id: 900 },
      { ref: "main", branch: "main", state: "success", name: "CI", minutesAgo: 60, id: 800 },
      { ref: "#21", branch: "task/7-login", state: "failure", name: "CI", minutesAgo: 20, id: 901 }] },
    ...more }));
}

function workProject(cfg: Row = { ...CONFIG, budget: { builder: 1000 } }): Project {
  const p = project(cfg);
  roots.push(p.root);
  writeExe(join(p.d, "factory"), FAKE_FACTORY);
  p.env.FAKE_DOCTOR = write(join(p.root, "doctor.json"), JSON.stringify(DOCTOR));
  p.env.FAKE_USAGE_TASK = write(join(p.root, "usage-task.json"), JSON.stringify(USAGE_TASK));
  p.env.FAKE_USAGE_WORKER = write(join(p.root, "usage-worker.json"), JSON.stringify(USAGE_WORKER));
  p.env.FAKE_USAGE_GITHUB = write(join(p.root, "usage-github.json"), JSON.stringify(GITHUB));
  cache(p);
  return p;
}

async function started(p: Project, env: Record<string, string> = {}): Promise<Running> {
  const ui = await startUi(p, ["--port", "0"], null, env);
  running.push(ui);
  return ui;
}

function calls(p: Project, what: string): number {
  return readFileSync(p.factoryLog, "utf8").split("\n").filter((l) => l === what).length;
}

async function until<X>(read: () => Promise<X>, ok: (x: X) => boolean, ms = 15_000): Promise<X> {
  const deadline = Date.now() + ms;
  let last = await read();
  while (!ok(last) && Date.now() < deadline) {
    await Bun.sleep(100);
    last = await read();
  }
  return last;
}

// --- Health ------------------------------------------------------------------------------------------------------------

test("health: the first look starts one doctor run; its checks come grouped, as ok, warning or failed with the fix", async () => {
  const p = workProject();
  const ui = await started(p);
  const first = await api(ui, "/api/projects/work/health");
  expect(first.status, JSON.stringify(first.json)).toBe(200);
  expect(first.json.command).toBe("factory doctor --json");
  const done = await until(() => api(ui, "/api/projects/work/health"), (r) => r.json.ranAt !== null && r.json.running === false);
  const h = done.json;
  expect(h.ok).toBe(false);
  expect(h.counts).toEqual({ ok: 4, warning: 1, failed: 1 });
  const groups = h.groups as Row[];
  expect(groups.map((g) => g.id)).toEqual(["machine", "project", "board", "github", "ci"]);
  expect(groups.map((g) => g.title)).toEqual(["This machine", "The project", "The board", "GitHub", "CI runners"]);
  expect(groups[0]?.checks).toEqual([{ level: "ok", what: "git", fix: "" },
    { level: "failed", what: "tmux", fix: "it is too old: run `brew upgrade tmux`" }]);
  expect(groups[1]?.checks).toEqual([{ level: "warning", what: "trustedReviewers", fix: "it is empty" }]);
  // looked at again and again: still one run (a run costs GitHub calls)
  for (let i = 0; i < 3; i++) await api(ui, "/api/projects/work/health");
  expect(calls(p, "doctor --json")).toBe(1);
}, T);

test("health: Check again runs the doctor again and answers with it; two at once share one run", async () => {
  const p = workProject();
  const ui = await started(p, { FAKE_DOCTOR_SLEEP: "0.5" });
  await until(() => api(ui, "/api/projects/work/health"), (r) => r.json.ranAt !== null && r.json.running === false);
  expect(calls(p, "doctor --json")).toBe(1);
  write(p.env.FAKE_DOCTOR as string, JSON.stringify({ ok: true, fixes: 0, checks: [{ group: "machine", level: "ok", what: "git", how: "" }] }));
  const [a, b] = await Promise.all([api(ui, "/api/projects/work/health/check", { method: "POST" }), api(ui, "/api/projects/work/health/check", { method: "POST" })]);
  expect(a.status, JSON.stringify(a.json)).toBe(200);
  expect(a.json.command).toBe("factory doctor --json");
  expect(a.json.ok).toBe(true);
  expect(a.json.counts).toEqual({ ok: 1, warning: 0, failed: 0 });
  expect(b.json.ranAt).toBe(a.json.ranAt as string);
  expect(calls(p, "doctor --json")).toBe(2);
  expect((await api(ui, "/api/projects/work/health/check")).status).toBe(405);
}, T);

test("health: the result is kept in the state folder, so a new server shows it without running the doctor", async () => {
  const p = workProject();
  const ui = await started(p);
  await until(() => api(ui, "/api/projects/work/health"), (r) => r.json.ranAt !== null && r.json.running === false);
  await ui.stop();
  const again = await started(p);
  const r = await api(again, "/api/projects/work/health");
  expect(r.json.counts).toEqual({ ok: 4, warning: 1, failed: 1 });
  expect(calls(p, "doctor --json")).toBe(1);
}, T);

test("health: a doctor that prints no JSON is said, with what to do", async () => {
  const p = workProject();
  write(p.env.FAKE_DOCTOR as string, "ok    git\n");
  const ui = await started(p);
  const r = await api(ui, "/api/projects/work/health/check", { method: "POST" });
  expect(r.status).toBe(500);
  const problems = r.json.problems as Row[];
  expect(problems.map((x) => x.code)).toEqual(["ui_doctor_unreadable"]);
  expect(String(problems[0]?.fix)).toContain(p.d);
  // a failed run is kept too: looking again doesn't run the doctor again
  for (let i = 0; i < 3; i++) expect(((await api(ui, "/api/projects/work/health")).json.problems as Row[])[0]?.code).toBe("ui_doctor_unreadable");
  expect(calls(p, "doctor --json")).toBe(1);
}, T);

// --- Usage and cost ----------------------------------------------------------------------------------------------------

test("usage: tokens per task against budget.builder, per agent, and the GitHub calls; read once and kept", async () => {
  const p = workProject();
  const ui = await started(p);
  const r = await api(ui, "/api/projects/work/usage");
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const u = r.json;
  expect(u.measured).toBe(true);
  expect(u.budget).toEqual({ tokens: 1000, source: "budget.builder in .claude/factory.json", warnPercent: 80 });
  const tasks = u.tasks as Row[];
  // counted: fresh input (input + cache writes) + output, as a budget counts it
  expect(tasks.map((t) => [t.key, t.title, t.used, t.percent, t.tone])).toEqual([
    ["7", "Add the login page", 1000, 100, "warn"],
    ["10", "Export to CSV", 100, 10, "ok"],
    ["-", "No task", 15, 2, "ok"],
  ]);
  const agents = u.agents as Row[];
  expect(agents.map((a) => [a.key, a.used, a.budget])).toEqual([["taytu", 1000, null], ["(project folder)", 115, null]]);
  expect(u.github).toMatchObject({ total: 42, agents: { "menelik (work)": 30 }, account: { used: 812, limit: 5000 } });
  expect((u.notMeasured as string[]).some((x) => x.startsWith("Money"))).toBe(true);
  for (let i = 0; i < 3; i++) await api(ui, "/api/projects/work/usage");
  expect(calls(p, "usage --json")).toBe(1);
  expect(calls(p, "usage --json --by worker")).toBe(1);
  expect(calls(p, "usage --github --json")).toBe(1);
}, T);

test("usage: over the budget is over; with no budget nothing is compared; no tokens recorded says so", async () => {
  const p = workProject({ ...CONFIG, budget: { builder: 500 } });
  const ui = await started(p);
  const tasks = (await api(ui, "/api/projects/work/usage")).json.tasks as Row[];
  expect(tasks[0]).toMatchObject({ key: "7", percent: 200, tone: "over" });

  const q = workProject(CONFIG);
  write(q.env.FAKE_USAGE_TASK as string, JSON.stringify({ ...USAGE_TASK, groups: {}, total: { tokens: tokens(0, 0, 0, 0), replies: 0, tasks: [] } }));
  write(q.env.FAKE_USAGE_WORKER as string, JSON.stringify({ ...USAGE_WORKER, groups: {} }));
  const ui2 = await started(q);
  const u = (await api(ui2, "/api/projects/work/usage")).json;
  expect(u.measured).toBe(false);
  expect(u.tasks).toEqual([]);
  expect(u.budget).toEqual({ tokens: null, source: null, warnPercent: 80 });
  expect(u.github).toMatchObject({ total: 42 });
}, T);

test("usage: the page reads the real logs of the project folder and an agent's worktree, by task, agent and day, with cost (#571)", async () => {
  const p = workProject();
  p.env.FAKE_USAGE_REAL = join(HOOKS, "factory_usage.ts");
  p.env.FAKE_BUN = process.execPath;
  const top = realpathSync(p.d);
  const logs = join(p.root, "home", ".claude", "projects");
  const day = new Date().toISOString().slice(0, 10);
  const reply = (id: string, branch: string, cwd: string, out: number): string => JSON.stringify({ type: "assistant",
    timestamp: `${day}T08:00:00Z`, gitBranch: branch, cwd, message: { id, model: "claude-opus-5-5",
      usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: out } } });
  const slug = (x: string): string => x.replace(/[^A-Za-z0-9]/g, "-");
  write(join(logs, slug(top), "own.jsonl"), reply("a1", "main", top, 10) + "\n");
  const wt = `${top}-agents/taytu`;
  write(join(logs, slug(wt), "agent.jsonl"), [reply("b1", "task/7-login", wt, 400), reply("b2", "task/7-login", wt, 500)].join("\n") + "\n");
  const ui = await started(p);
  const u = (await api(ui, "/api/projects/work/usage")).json;
  expect(u.problems, JSON.stringify(u)).toEqual([]);
  expect(u.measured).toBe(true);
  expect((u.tasks as Row[]).map((t) => [t.key, t.title, t.used, t.replies])).toEqual([["7", "Add the login page", 1100, 2], ["-", "No task", 110, 1]]);
  expect((u.agents as Row[]).map((a) => [a.key, a.used])).toEqual([["taytu", 1100], ["(project folder)", 110]]);
  expect((u.days as Row[]).map((d) => [d.key, d.used, d.replies])).toEqual([[day, 1210, 3]]);
  // 300 input at $4 per million and 910 output at $20 per million
  expect((u.total as Row).cost).toBeCloseTo((300 * 4 + 910 * 20) / 1_000_000, 9);
  expect((u.tasks as Row[])[0]?.cost).toBeCloseTo((200 * 4 + 900 * 20) / 1_000_000, 9);
}, T);

test("usage: no logs says where it looked; a failed run shows its own error, not just that it failed (#571)", async () => {
  const p = workProject();
  p.env.FAKE_USAGE_REAL = join(HOOKS, "factory_usage.ts");
  p.env.FAKE_BUN = process.execPath;
  const ui = await started(p);
  const u = (await api(ui, "/api/projects/work/usage")).json;
  expect(u.measured).toBe(false);
  const no = (u.problems as Row[]).find((x) => x.code === "usage_no_logs");
  expect(String(no?.message)).toContain(join(p.root, "home", ".claude", "projects"));
  expect(String(no?.fix)).toContain("usage.logFolders");

  const q = workProject();
  q.env.FAKE_USAGE_FAIL = "factory usage: error: argument --by: invalid choice: 'worker' (choose from 'task', 'agent', 'model', 'role')";
  const ui2 = await started(q);
  const bad = (await api(ui2, "/api/projects/work/usage")).json.problems as Row[];
  expect(bad[0]?.code).toBe("ui_usage_unreadable");
  expect(String(bad[0]?.message)).toContain("invalid choice: 'worker'");
  expect(String(bad[0]?.fix)).toContain("factory update");

  const r = workProject();
  r.env.FAKE_USAGE_FAIL = JSON.stringify({ code: "bun_missing", message: "factory_usage.ts needs Bun.", fix: "Install Bun." });
  const ui3 = await started(r);
  expect(((await api(ui3, "/api/projects/work/usage")).json.problems as Row[])[0]).toEqual({ code: "bun_missing", message: "factory_usage.ts needs Bun.", fix: "Install Bun." });
}, T);

// --- Activity ----------------------------------------------------------------------------------------------------------

test("activity: with tasks on GitHub, what the snapshot knows, newest first, and a notice that says so", async () => {
  const p = workProject();
  const ui = await started(p);
  const r = await api(ui, "/api/projects/work/activity");
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.from).toBe("snapshot");
  expect((r.json.problems as Row[]).map((x) => x.code)).toEqual(["ui_activity_snapshot"]);
  const items = r.json.items as Row[];
  const texts = items.map((x) => x.text);
  expect(texts).toContain("opened PR #21: PR 21");
  expect(texts).toContain("CI failed on main");
  expect(texts).toContain("CI failed on PR #21");
  expect(texts).toContain("asked you: Which database for the cache?");
  const ats = items.map((x) => String(x.at ?? ""));
  expect(ats).toEqual([...ats].sort().reverse());
  expect(items.find((x) => x.text === "opened PR #22: PR 22")).toMatchObject({ kind: "pr", agent: "taytu", task: "8", pr: 22, link: "view:pull-requests",
    at: "2026-11-07T07:00:00Z" });
  expect(r.json.kinds).toEqual(["pr", "ci", "ask"]);
  expect(r.json.agents).toEqual(["menelik", "taytu"]);
}, T);

test("activity: filters by agent, task and kind", async () => {
  const p = workProject();
  const ui = await started(p);
  const byKind = (await api(ui, "/api/projects/work/activity?kind=ci")).json.items as Row[];
  expect(byKind.length).toBe(2);
  expect(byKind.every((x) => x.kind === "ci")).toBe(true);
  const byAgent = (await api(ui, "/api/projects/work/activity?agent=taytu")).json.items as Row[];
  expect(byAgent.map((x) => x.text)).toEqual(["opened PR #22: PR 22"]);
  const byTask = (await api(ui, "/api/projects/work/activity?task=%237")).json;
  expect((byTask.items as Row[]).map((x) => x.text).sort()).toEqual(["CI failed on PR #21", "opened PR #21: PR 21"]);
  expect(byTask.filter).toEqual({ agent: "", task: "7", kind: "" });
}, T);

test("activity: a pull request that leaves the snapshot's open list shows as no longer open", async () => {
  const p = workProject();
  const ui = await started(p);
  await api(ui, "/api/projects/work/activity"); // the first look: the open list is kept
  cache(p, { pulls: [pull(21, "task/7-login", { createdAt: "2026-11-07T08:00:00Z" })] });
  const items = (await api(ui, "/api/projects/work/activity")).json.items as Row[];
  expect(items.find((x) => x.pr === 22 && String(x.text).includes("no longer open"))).toMatchObject({ kind: "pr", agent: "taytu", task: "8",
    text: "PR #22 is no longer open (merged or closed): PR 22" });
  // still there on the next look
  expect(((await api(ui, "/api/projects/work/activity")).json.items as Row[]).filter((x) => String(x.text).includes("no longer open")).length).toBe(1);
}, T);

// --- Home --------------------------------------------------------------------------------------------------------------

test("home: what needs you, the team, progress by epic and recent activity, each with its page", async () => {
  const p = workProject();
  write(join(p.root, "db.json"), JSON.stringify({
    issues: [{ number: 50, title: "Dev manager: needs the owner", body: "", state: "open", labels: [], html_url: "https://github.com/o/work/issues/50" }],
    comments: { "50": [{ body: "<!-- factory-owner-ask id=pick-db -->\nWhich database for the cache?\n\n- Postgres\n- SQLite\n", created_at: "2026-11-07T09:00:00Z" }] },
  }));
  heartbeat(p, [hbRow("menelik", { state: "working", detail: "working on #7", task: "7" }), hbRow("fasil", { kind: "dev-manager" })]);
  const ui = await started(p);
  const r = await api(ui, "/api/projects/work/home");
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const needs = r.json.needs as Row[];
  expect(needs.map((n) => [n.kind, n.title, n.link])).toEqual([
    ["ask", "Which database for the cache?", "view:owner-queue"],
    ["merge", "Merge PR #22? PR 22", "view:pull-requests"],
    ["blocked", "#12 Pay by card", "view:tasks"],
    ["blocked", "#13 Search", "view:tasks"],
    ["ci", "CI failed on main", "view:ci"],
    ["health", "tmux", "page:health"],
  ]);
  expect(needs[3]?.sub).toBe("Waits for #7.");
  expect(needs[1]?.find).toBe("#22");
  const team = r.json.team as Row[];
  expect(team.find((a) => a.name === "menelik")).toMatchObject({ state: "working", task: "7", taskTitle: "Add the login page", link: "agent:menelik" });
  expect(r.json.progress).toMatchObject({ epics: [{ id: "1", title: "Sign in", done: 1, all: 3 }], noEpic: { done: 0, all: 2 }, done: 1, all: 5 });
  const recent = r.json.recent as Row[];
  expect(recent.length).toBeLessThanOrEqual(10);
  expect(recent.length).toBeGreaterThan(0);
  expect(r.json.activityFrom).toBe("snapshot");
  // Home runs no doctor: its failures come from the last result (here the snapshot's summary)
  expect(calls(p, "doctor --json")).toBe(0);
}, T);

test("the new pages need the token and refuse what they don't do, as {code, message, fix}", async () => {
  const p = workProject();
  const ui = await started(p);
  for (const path of ["health", "usage", "activity", "home"]) {
    const r = await api(ui, `/api/projects/work/${path}`, { token: null });
    expect(r.status).toBe(401);
    const bad = await api(ui, `/api/projects/work/${path}`, { method: "POST" });
    expect(bad.status, path).toBe(405);
    expect(Object.keys(bad.json).sort()).toEqual(["code", "fix", "message"]);
  }
  expect((await api(ui, "/api/projects/work/health/nothing")).status).toBe(404);
}, T);
