// The web UI's task board (#439): each task row's actions by state and its PR's checks, the actions' POST (release,
// block, reassign) running `factory issues release|block` and `factory say` through a fake `factory` that logs what it
// was asked, their refusals (each with code, message and fix), and the token. The board is a way of drawing the tasks
// channel, so the channels stay as web_ui.test.ts has them.
import { afterAll, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { api, CONFIG, project, type Project, type Row, startUi, type Running } from "./web_ui_support.ts";
import { write, writeExe } from "./support.ts";

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
  { id: "13", title: "Reviewed work", state: "in-review", holders: ["taytu"], group: "Phase 2", todos: [], dependsOn: [] },
  { id: "14", title: "Shipped work", state: "done", holders: [], group: "Phase 2", todos: [], dependsOn: [] },
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
  runners: [{ name: "work-ci-m-here-1", status: "online", busy: true }],
  light: { label: "work-light", runners: [] },
  runs: [{ ref: "#21", branch: "task/7-login", state: "failure", name: "CI", createdAt: "", minutesAgo: 30, id: 9300 }],
  queuedLong: { count: 0, longestMinutes: 0, thresholdMinutes: 15, noRunnerOnline: false },
  errors: [],
};

function cache(p: Project, source: string): void {
  write(join(p.state, "snapshot.json"), JSON.stringify({ generatedAt: new Date().toISOString(), sessions: [], needsYou: [], missing: [],
    tasks: { source, tasks: TASKS }, pulls: PULLS, ci: CI }));
}

async function started(source = "issues"): Promise<{ ui: Running; p: Project }> {
  const p = project(source === "issues" ? CONFIG : { ...CONFIG, tasks: { source } });
  roots.push(p.root);
  cache(p, source);
  const ui = await startUi(p, ["--port", "0"]);
  running.push(ui);
  return { ui, p };
}

function factoryCalls(p: Project): string[] {
  return readFileSync(p.factoryLog, "utf8").split("\n").filter(Boolean);
}

/** What the fake factory was asked, without the snapshot read the server adds after an action. */
function calls(p: Project): string[] {
  return factoryCalls(p).filter((c) => c !== "snapshot");
}

function act(ui: Running, id: string, name: string, body: unknown = { confirm: true }, token?: string | null) {
  return api(ui, `/api/projects/work/tasks/${id}/actions/${name}`, { method: "POST", body, token });
}

function expectRefusal(r: { status: number; json: Row }, status: number, code: string): void {
  expect(r.status, JSON.stringify(r.json)).toBe(status);
  expect(r.json.code).toBe(code);
  for (const k of ["code", "message", "fix"]) {
    expect(typeof r.json[k], k).toBe("string");
    expect(String(r.json[k]).length, k).toBeGreaterThan(0);
  }
}

// --- the rows ------------------------------------------------------------------------------------------------------------

test("each task row offers the actions its state allows, in the order release, block, reassign", async () => {
  const { ui } = await started();
  const r = await api(ui, "/api/projects/work/tasks");
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const byId = Object.fromEntries((r.json.tasks as Row[]).map((t) => [String(t.id), t.actions]));
  expect(byId["7"]).toEqual(["release", "block", "reassign"]);
  expect(byId["10"]).toEqual(["block", "reassign"]);
  expect(byId["9"]).toEqual(["block", "reassign"]);
  expect(byId["11"]).toEqual(["block"]);
  expect(byId["12"]).toEqual(["release"]);
  expect(byId["13"]).toEqual([]);
  expect(byId["14"]).toEqual([]);
}, T);

test("a task's pull request carries its checks, with the failing jobs", async () => {
  const { ui } = await started();
  const r = await api(ui, "/api/projects/work/tasks");
  const t7 = (r.json.tasks as Row[]).find((t) => t.id === "7") as Row;
  expect(t7.pr).toEqual({ number: 21, url: "https://github.com/o/work/pull/21", checks: { state: "red", failing: ["test"] } });
}, T);

test("with tasks.source plan no row offers an action", async () => {
  const { ui } = await started("plan");
  const r = await api(ui, "/api/projects/work/tasks");
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const tasks = r.json.tasks as Row[];
  expect(tasks.length).toBeGreaterThan(0);
  for (const t of tasks) expect(t.actions, String(t.id)).toEqual([]);
}, T);

// --- refusals ------------------------------------------------------------------------------------------------------------

test("an unknown action is 404 ui_action_unknown, a GET of an action is 405, and nothing runs", async () => {
  const { ui, p } = await started();
  expectRefusal(await act(ui, "7", "delete"), 404, "ui_action_unknown");
  expect((await api(ui, "/api/projects/work/tasks/7/actions/release")).status).toBe(405);
  expect(factoryCalls(p)).toEqual([]);
}, T);

test("an action without a confirm is 400 confirm_needed and nothing runs", async () => {
  const { ui, p } = await started();
  for (const name of ["release", "block", "reassign"]) {
    expectRefusal(await act(ui, "7", name, { reason: "x", agent: "taytu" }), 400, "confirm_needed");
    expectRefusal(await act(ui, "7", name, { confirm: "yes", reason: "x", agent: "taytu" }), 400, "confirm_needed");
  }
  expect(factoryCalls(p)).toEqual([]);
}, T);

test("a task that is not in the cache is 404 ui_task_unknown", async () => {
  const { ui, p } = await started();
  expectRefusal(await act(ui, "999", "release"), 404, "ui_task_unknown");
  expect(factoryCalls(p)).toEqual([]);
}, T);

test("an action the task's state does not offer is 400 ui_action_unavailable and nothing runs", async () => {
  const { ui, p } = await started();
  expectRefusal(await act(ui, "10", "release"), 400, "ui_action_unavailable");
  expectRefusal(await act(ui, "13", "block", { confirm: true, reason: "x" }), 400, "ui_action_unavailable");
  expectRefusal(await act(ui, "12", "reassign", { confirm: true, agent: "taytu" }), 400, "ui_action_unavailable");
  expect(factoryCalls(p)).toEqual([]);
}, T);

test("with tasks.source plan every action is 400 ui_action_unavailable and nothing runs", async () => {
  const { ui, p } = await started("plan");
  expectRefusal(await act(ui, "7", "release"), 400, "ui_action_unavailable");
  expect(factoryCalls(p)).toEqual([]);
}, T);

test("block needs a reason: none, or only spaces, is 400 ui_reason_needed", async () => {
  const { ui, p } = await started();
  expectRefusal(await act(ui, "10", "block"), 400, "ui_reason_needed");
  expectRefusal(await act(ui, "10", "block", { confirm: true, reason: "   " }), 400, "ui_reason_needed");
  expect(factoryCalls(p)).toEqual([]);
}, T);

test("reassign needs one of the project's agents: none, a stranger and a path are 400 ui_agent_unknown", async () => {
  const { ui, p } = await started();
  expectRefusal(await act(ui, "7", "reassign"), 400, "ui_agent_unknown");
  expectRefusal(await act(ui, "7", "reassign", { confirm: true, agent: "mallory" }), 400, "ui_agent_unknown");
  expectRefusal(await act(ui, "7", "reassign", { confirm: true, agent: "../x" }), 400, "ui_agent_unknown");
  expect(factoryCalls(p)).toEqual([]);
}, T);

test("a reason is never read as an option: every leading dash and space goes, and dashes alone are no reason", async () => {
  const { ui, p } = await started();
  for (const reason of ["- -x", " --x", "\t-- x"]) {
    const r = await act(ui, "10", "block", { confirm: true, reason });
    expect(r.status, `${JSON.stringify(reason)}: ${JSON.stringify(r.json)}`).toBe(200);
  }
  expect(calls(p)).toEqual(["issues block 10 x", "issues block 10 x", "issues block 10 x"]);
  expectRefusal(await act(ui, "10", "block", { confirm: true, reason: "- --" }), 400, "ui_reason_needed");
}, T);

test("a bad agent name in factory.json is left out of reassign and doesn't stop the server", async () => {
  const p = project({ ...CONFIG, agents: ["Bad_Name", "taytu", "menelik"] });
  roots.push(p.root);
  cache(p, "issues");
  const ui = await startUi(p, ["--port", "0"]);
  running.push(ui);
  expectRefusal(await act(ui, "7", "reassign", { confirm: true, agent: "Bad_Name" }), 400, "ui_agent_unknown");
  expect((await api(ui, "/api/projects/work/tasks")).status).toBe(200);
  const r = await act(ui, "7", "reassign", { confirm: true, agent: "taytu" });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(calls(p)).toEqual(["issues release 7 reassigned to taytu from the web UI", "say taytu /next-task issue-7"]);
}, T);

test("a task id that isn't an issue number is 404 ui_task_unknown and nothing runs", async () => {
  const { ui, p } = await started();
  for (const id of ["-7", "7 ", "--help", "1.3"]) expectRefusal(await act(ui, encodeURIComponent(id), "release"), 404, "ui_task_unknown");
  expect(factoryCalls(p)).toEqual([]);
}, T);

test("a reason with spaces reaches factory as one argument, and the agent and the message as one each", async () => {
  const p = project();
  roots.push(p.root);
  cache(p, "issues");
  // this fake logs each argument between bars, so a reason split into words shows
  writeExe(join(p.d, "factory"), `#!/usr/bin/env bash\nline=""\nfor a in "$@"; do line="$line|$a"; done\necho "$line|" >> "$FAKE_FACTORY_LOG"\n`);
  const ui = await startUi(p, ["--port", "0"]);
  running.push(ui);
  expect((await act(ui, "10", "block", { confirm: true, reason: "needs the Stripe keys" })).status).toBe(200);
  expect((await act(ui, "7", "reassign", { confirm: true, agent: "taytu" })).status).toBe(200);
  expect(factoryCalls(p).filter((c) => !c.startsWith("|snapshot|"))).toEqual(["|issues|block|10|needs the Stripe keys|",
    "|issues|release|7|reassigned to taytu from the web UI|", "|say|taytu|/next-task issue-7|"]);
}, T);

test("an action needs the token, and nothing runs without it", async () => {
  const { ui, p } = await started();
  expect((await act(ui, "7", "release", { confirm: true }, null)).status).toBe(401);
  expect((await act(ui, "7", "release", { confirm: true }, "nope")).status).toBe(401);
  await Bun.sleep(300);
  expect(factoryCalls(p)).toEqual([]);
}, T);

// --- acting --------------------------------------------------------------------------------------------------------------

test("release runs factory issues release with the default reason, or the one given", async () => {
  const { ui, p } = await started();
  const r = await act(ui, "7", "release");
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.ok).toBe(true);
  expect(r.json.command).toBe('factory issues release 7 "released from the web UI"');
  expect(calls(p)).toEqual(["issues release 7 released from the web UI"]);
  expect(factoryCalls(p)).toContain("snapshot");
  const again = await act(ui, "7", "release", { confirm: true, reason: "went quiet" });
  expect(again.status, JSON.stringify(again.json)).toBe(200);
  expect(calls(p)).toEqual(["issues release 7 released from the web UI", "issues release 7 went quiet"]);
}, T);

test("with no message board set up, the read after a release starts at once, every time (#498: nothing waits for a board)", async () => {
  for (let i = 0; i < 20; i++) {
    const { ui, p } = await started();
    const r = await act(ui, "7", "release");
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(factoryCalls(p), `run ${i + 1}`).toContain("snapshot");
    await ui.stop();
  }
}, 240_000);

test("the answer to an action comes after the read it starts, so a slow-starting read is in the log (#519)", async () => {
  const p = project();
  roots.push(p.root);
  cache(p, "issues");
  // a busy machine: the snapshot's process takes a moment before it does anything (CI under load did this)
  writeExe(join(p.d, "factory"), `#!/usr/bin/env bash\n[ "$1" = snapshot ] && sleep 0.5\necho "$*" >> "$FAKE_FACTORY_LOG"\necho "fake factory: $*"\n`);
  const ui = await startUi(p, ["--port", "0"]);
  running.push(ui);
  for (const [id, name, body] of [["7", "release", { confirm: true }], ["10", "block", { confirm: true, reason: "needs keys" }]] as const) {
    const r = await act(ui, id, name, body);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(factoryCalls(p).at(-1), name).toBe("snapshot");
  }
}, T);

test("an action while a read runs is read again after that one, before its answer (#519)", async () => {
  const p = project();
  roots.push(p.root);
  cache(p, "issues");
  writeExe(join(p.d, "factory"), `#!/usr/bin/env bash\nif [ "$1" = snapshot ]; then echo "snapshot start" >> "$FAKE_FACTORY_LOG"; sleep 1; ` +
    `echo "snapshot end" >> "$FAKE_FACTORY_LOG"; exit 0; fi\necho "$*" >> "$FAKE_FACTORY_LOG"\n`);
  const ui = await startUi(p, ["--port", "0"]);
  running.push(ui);
  expect((await api(ui, "/api/projects/work/refresh", { method: "POST" })).status).toBe(202); // a read that began before the action
  const r = await act(ui, "7", "release");
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const log = factoryCalls(p);
  const after = log.slice(log.indexOf("issues release 7 released from the web UI") + 1);
  expect(after, log.join("\n")).toContain("snapshot start"); // the running read began before the release: another one ran
  expect(after.at(-1), log.join("\n")).toBe("snapshot end");
}, T);

test("block runs factory issues block with the reason", async () => {
  const { ui, p } = await started();
  const r = await act(ui, "10", "block", { confirm: true, reason: "needs the Stripe keys" });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.ok).toBe(true);
  expect(calls(p)).toEqual(["issues block 10 needs the Stripe keys"]);
  expect(factoryCalls(p)).toContain("snapshot");
}, T);

test("reassign releases the task, then tells the agent to take it", async () => {
  const { ui, p } = await started();
  const r = await act(ui, "7", "reassign", { confirm: true, agent: "taytu" });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.ok).toBe(true);
  expect(String(r.json.command)).toContain(" then ");
  expect(calls(p)).toEqual(["issues release 7 reassigned to taytu from the web UI", "say taytu /next-task issue-7"]);
  expect(factoryCalls(p)).toContain("snapshot");
}, T);

test("a failing step is 500 with the command's own error, and reassign says nothing after a failed release", async () => {
  const { ui, p } = await started();
  write(join(p.d, "factory"), "#!/usr/bin/env bash\necho \"$*\" >> \"$FAKE_FACTORY_LOG\"\n" +
    "echo '{\"code\": \"issues_no_gh\", \"message\": \"gh failed.\", \"fix\": \"Run gh auth login.\"}' >&2\nexit 1\n", 0o755);
  const r = await act(ui, "7", "reassign", { confirm: true, agent: "taytu" });
  expect(r.status).toBe(500);
  expect(r.json).toMatchObject({ ok: false, code: "issues_no_gh", message: "gh failed.", fix: "Run gh auth login." });
  expect(calls(p)).toEqual(["issues release 7 reassigned to taytu from the web UI"]);
  const b = await act(ui, "10", "block", { confirm: true, reason: "x" });
  expect(b.status).toBe(500);
  expect(b.json.code).toBe("issues_no_gh");
}, T);
