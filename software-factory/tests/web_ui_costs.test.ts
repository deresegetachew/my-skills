// What each task took, in the web UI (#580): GET /costs (each task's build time, working minutes, sessions, tokens, cost,
// CI runs and review rounds, and each epic's totals), Usage and cost's byTask rows, and the spinning warning in Needs
// attention. The real server and the real `factory usage` over fake Claude Code logs, a fake snapshot and the times kept
// in the state folder (as the board's claims and done times are kept); no GitHub call.
import { afterAll, expect, test } from "bun:test";
import { readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { api, CONFIG, project, type Project, type Row, startUi, type Running } from "./web_ui_support.ts";
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
if [ "\${1:-}" = usage ] && [ "\${2:-}" != --github ]; then shift; exec "$FAKE_BUN" --no-env-file --config=/dev/null "$FAKE_USAGE_REAL" "$@"; fi
case "$*" in
  "usage --github --json") echo '{"since":"2026-11-07T09:00:00+00:00","total":0,"agents":{},"commands":{},"endpoints":{},"callers":{},"github":null}' ;;
  *) echo "fake factory: $*" ;;
esac
`;

const HOUR = 3_600_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const task = (id: string, title: string, state: string, holders: string[] = []): Row =>
  ({ id, title, state, holders, group: "", todos: [], dependsOn: [] });

/** Five done tasks (1 to 5) of 10 minutes and 150 tokens each, claimed and done; #7 in progress with a long, big
 *  session; #8 in progress whose last 3 CI runs failed; #9 in review with 3 must-fix rounds; #10 in progress and fine. */
function setup(o: { done?: number } = {}): Project {
  const done = o.done ?? 5;
  const p = project(CONFIG);
  roots.push(p.root);
  writeExe(join(p.d, "factory"), FAKE_FACTORY);
  p.env.FAKE_USAGE_REAL = join(HOOKS, "factory_usage.ts");
  p.env.FAKE_BUN = process.execPath;
  const top = realpathSync(p.d);
  const logs = join(p.root, "home", ".claude", "projects");
  const slug = (x: string): string => x.replace(/[^A-Za-z0-9]/g, "-");
  const wt = `${top}-agents/taytu`;
  const now = Date.now();
  const start = now - 48 * HOUR;
  let n = 0;
  const reply = (branch: string, at: number, out = 50): string => JSON.stringify({ type: "assistant", timestamp: iso(at), gitBranch: branch, cwd: wt,
    message: { id: `m${n++}`, model: "claude-opus-5-5", usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: out } } });
  const events: Row[] = [];
  for (let i = 1; i <= done; i++) {
    const t0 = start + i * HOUR;
    write(join(logs, slug(wt), `done${i}.jsonl`), [reply(`task/${i}-x`, t0), reply(`task/${i}-x`, t0 + 10 * 60_000)].join("\n") + "\n");
    events.push({ id: `board-c${i}`, task: String(i), kind: "claimed", at: iso(t0 - 5 * 60_000) }, { id: `board-d${i}`, task: String(i), kind: "done", at: iso(t0 + 30 * 60_000) });
  }
  // #7: one session of 3 hours with 20 big replies
  const big = Array.from({ length: 20 }, (_, i) => reply("task/7-big", now - 4 * HOUR + i * (3 * HOUR / 19), 5000));
  write(join(logs, slug(wt), "seven.jsonl"), big.join("\n") + "\n");
  events.push({ id: "board-c7", task: "7", kind: "claimed", at: iso(now - 4 * HOUR - 60_000) });
  write(join(logs, slug(wt), "ten.jsonl"), [reply("task/10-ok", now - 2 * HOUR), reply("task/10-ok", now - 2 * HOUR + 5 * 60_000)].join("\n") + "\n");
  for (const r of [1, 2, 3]) events.push({ id: `review-31-sha${r}`, task: "9", kind: "review", at: iso(now - (5 - r) * HOUR) });
  write(join(p.state, "task-times.json"), JSON.stringify({ version: 1, events }));
  const tasks = [...Array.from({ length: done }, (_, i) => task(String(i + 1), `Done ${i + 1}`, "done")),
    task("7", "Search", "in-progress", ["taytu"]), task("8", "Export", "in-progress", ["menelik"]), task("9", "Pay", "in-review", ["menelik"]),
    task("10", "Login", "in-progress", ["menelik"])];
  write(join(p.state, "snapshot.json"), JSON.stringify({ generatedAt: iso(now), sessions: [], missing: [], needsYou: [],
    tasks: { source: "issues", tasks, epics: [{ id: "100", title: "Shelf", stage: "building", prd: "", decisions: [], summary: "", cites: [], url: null,
      tasks: [{ id: "1", done: true }, { id: "2", done: true }, { id: "7", done: false }] }] },
    pulls: [], ci: { mode: "github", repo: "o/work", runners: [], errors: [], runs: [
      { id: 501, ref: "#30", branch: "task/8-export", state: "success", name: "CI", minutesAgo: 90 },
      { id: 502, ref: "#30", branch: "task/8-export", state: "failure", name: "CI", minutesAgo: 60 },
      { id: 503, ref: "#30", branch: "task/8-export", state: "failure", name: "CI", minutesAgo: 40 },
      { id: 504, ref: "#30", branch: "task/8-export", state: "failure", name: "CI", minutesAgo: 20 },
      { id: 505, ref: "#33", branch: "task/10-ok", state: "failure", name: "CI", minutesAgo: 30 },
      { id: 506, ref: "#33", branch: "task/10-ok", state: "success", name: "CI", minutesAgo: 10 }] } }));
  return p;
}

async function started(p: Project): Promise<Running> {
  const ui = await startUi(p, ["--port", "0"]);
  running.push(ui);
  return ui;
}

test("costs: each task's build time, working minutes, sessions, tokens, cost, CI runs and review rounds; the epic's totals add up", async () => {
  const p = setup();
  const ui = await started(p);
  const r = await api(ui, "/api/projects/work/costs");
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.problems, JSON.stringify(r.json.problems)).toEqual([]);
  const rows = r.json.tasks as Row[];
  const one = rows.find((x) => x.task === "1") as Row;
  expect(one).toMatchObject({ title: "Done 1", state: "done", epic: "100", startFrom: "claim", buildMinutes: 35, workingMinutes: 10, sessions: 1,
    replies: 2, used: 300, unpriced: 0 });
  expect(one.cost as number).toBeCloseTo((200 * 4 + 100 * 20) / 1_000_000, 9);
  const seven = rows.find((x) => x.task === "7") as Row;
  expect(seven).toMatchObject({ title: "Search", state: "in-progress", doneAt: null, buildMinutes: null, workingMinutes: 180, sessions: 1, replies: 20 });
  expect(rows.find((x) => x.task === "8")).toMatchObject({ ci: { runs: 4, failed: 3, failedInARow: 3 } });
  expect(rows.find((x) => x.task === "9")).toMatchObject({ reviews: { rounds: 3 }, sessions: 0 });
  expect(r.json.medians).toEqual({ done: 5, used: 300, workingMinutes: 10 });
  const epic = (r.json.epics as Row[]).find((e) => e.epic === "100") as Row;
  const mine = rows.filter((x) => ["1", "2", "7"].includes(String(x.task)));
  const sum = (k: string): number => mine.reduce((n, x) => n + Number(x[k]), 0);
  expect(epic).toMatchObject({ tasks: 3, done: 2, buildMinutes: 70, workingMinutes: sum("workingMinutes"), sessions: sum("sessions"), used: sum("used") });
  expect(epic.cost as number).toBeCloseTo(sum("cost"), 9);
  // the snapshot's CI runs are kept beside the board's times, so they outlast the snapshot
  const kept = JSON.parse(readFileSync(join(p.state, "task-times.json"), "utf8")) as { events: Row[] };
  expect(kept.events.filter((e) => e.kind === "ci").map((e) => e.id).sort()).toEqual(["ci-501", "ci-502", "ci-503", "ci-504", "ci-505", "ci-506"]);
}, T);

test("usage: Usage and cost gets the same rows by task", async () => {
  const p = setup();
  const ui = await started(p);
  const u = (await api(ui, "/api/projects/work/usage")).json;
  const byTask = u.byTask as Row[];
  expect(byTask.map((x) => x.task).sort()).toEqual(["1", "10", "2", "3", "4", "5", "7", "8", "9"]);
  expect(byTask.find((x) => x.task === "7")).toMatchObject({ title: "Search", workingMinutes: 180 });
}, T);

test("attention: a task past the median, with too many review rounds, or failing CI in a row is spinning; Open its output", async () => {
  const p = setup();
  const ui = await started(p);
  const r = await api(ui, "/api/projects/work/attention");
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.limits).toMatchObject({ spinFactor: 3, spinReviewRounds: 3, spinFailedCi: 3 });
  const spin = (r.json.items as Row[]).filter((x) => x.kind === "task-spinning");
  expect(spin.map((x) => x.task).sort()).toEqual(["7", "8", "9"]);
  const seven = spin.find((x) => x.task === "7") as Row;
  expect(seven.agent).toBe("taytu");
  expect(seven.action).toEqual({ kind: "open", label: "Open its output", link: "agent:taytu" });
  expect(String(seven.reason)).toContain("more than 3 times the median of the done tasks");
  expect(String(seven.reason)).toContain("going in circles");
  expect(String(spin.find((x) => x.task === "8")?.reason)).toContain("last 3 CI runs failed");
  expect(String(spin.find((x) => x.task === "9")?.reason)).toContain("3 review rounds with must-fixes");
}, T);

test("attention: with fewer than 5 done tasks nothing is compared with a median; the thresholds are settings", async () => {
  const p = setup({ done: 4 });
  const ui = await started(p);
  const spin = ((await api(ui, "/api/projects/work/attention")).json.items as Row[]).filter((x) => x.kind === "task-spinning");
  expect(spin.map((x) => x.task).sort()).toEqual(["8", "9"]);

  const q = setup();
  write(join(q.d, ".claude", "factory.json"), JSON.stringify({ ...CONFIG, attention: { spinFactor: 1000, spinReviewRounds: 4, spinFailedCi: 4 } }));
  const ui2 = await started(q);
  expect(((await api(ui2, "/api/projects/work/attention")).json.items as Row[]).filter((x) => x.kind === "task-spinning")).toEqual([]);
}, T);
