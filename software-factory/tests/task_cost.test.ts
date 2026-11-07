// Cost and time per task (#580): `factory usage --by task` (text and JSON) joins the sessions in Claude Code's logs with
// the task's times kept in the state folder (task-times.json, the board's claims and done times) and the snapshot's CI
// runs and review rounds. Fake logs, a fake kept file and a fake snapshot; no GitHub call.
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runHook, tmp, write } from "./support.ts";

type Row = Record<string, unknown>;

function reply(mid: string, branch: string, cwd: string, ts: string, o: { out?: number; model?: string } = {}): string {
  return JSON.stringify({ type: "assistant", timestamp: ts, gitBranch: branch, cwd,
    message: { id: mid, model: o.model ?? "claude-opus-5-5", usage: { input_tokens: 100, cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0, output_tokens: o.out ?? 50 } } });
}

const slugOf = (root: string): string => root.replace(/[^A-Za-z0-9]/g, "-");

interface Setup {
  root: string;
  logs: string;
  state: string;
  env: Record<string, string | undefined>;
}

/** Task 7: two sessions (40 and 20 minutes), claimed 09:00 and merged 12:30, 3 CI runs (one failed), one must-fix round.
 *  Task 8: one session with an unpriced model, still in progress, its last two CI runs failed. */
function setup(): Setup {
  const root = join(tmp(), "proj");
  mkdirSync(join(root, ".claude"), { recursive: true });
  const logs = tmp();
  const xdg = tmp();
  const state = join(xdg, "proj-factory");
  const wt = root + "-agents/taytu";
  const agentDir = join(logs, slugOf(wt));
  write(join(agentDir, "s1.jsonl"), [reply("a1", "task/7-x", wt, "2026-10-24T09:05:00Z"), reply("a2", "task/7-x", wt, "2026-10-24T09:45:00Z")].join("\n") + "\n");
  write(join(agentDir, "s2.jsonl"), [reply("a3", "task/7-x", wt, "2026-10-24T11:00:00Z"), reply("a4", "task/7-x", wt, "2026-10-24T11:20:00Z")].join("\n") + "\n");
  write(join(agentDir, "s3.jsonl"), [reply("b1", "task/8-y", wt, "2026-10-24T13:00:00Z", { model: "some-other-model" }),
    reply("b2", "task/8-y", wt, "2026-10-24T13:10:00Z")].join("\n") + "\n");
  write(join(state, "task-times.json"), JSON.stringify({ version: 1, events: [
    { id: "board-1", task: "7", kind: "claimed", at: "2026-10-24T09:00:00.000Z" },
    { id: "board-2", task: "7", kind: "claimed", at: "2026-10-24T10:50:00.000Z" },
    { id: "board-3", task: "7", kind: "done", at: "2026-10-24T12:30:00.000Z" },
    { id: "ci-1", task: "7", kind: "ci", at: "2026-10-24T09:50:00.000Z", failed: true },
    { id: "board-4", task: "8", kind: "claimed", at: "2026-10-24T12:55:00.000Z" },
  ] }));
  write(join(state, "snapshot.json"), JSON.stringify({ generatedAt: "2026-10-24T14:00:00.000Z",
    tasks: { source: "board", tasks: [], epics: [] },
    pulls: [{ number: 21, branch: "task/7-x", head: "abc1234", review: "factory-mustfix" }, { number: 22, branch: "task/8-y", head: "def5678", review: null }],
    ci: { runs: [
      { id: 2, branch: "task/7-x", state: "success", minutesAgo: 200 },
      { id: 3, branch: "task/7-x", state: "success", minutesAgo: 100 },
      { id: 4, branch: "task/8-y", state: "success", minutesAgo: 50 },
      { id: 5, branch: "task/8-y", state: "failure", minutesAgo: 30 },
      { id: 6, branch: "task/8-y", state: "failure", minutesAgo: 10 },
      { id: 7, branch: "task/8-y", state: "in_progress", minutesAgo: 1 },
      { id: 8, branch: "main", state: "failure", minutesAgo: 5 }] } }));
  return { root, logs, state, env: { ...process.env, CLAUDE_PROJECT_DIR: root, XDG_STATE_HOME: xdg } };
}

function usage(s: Setup, ...args: string[]) {
  return runHook("factory_usage", ["--logs", s.logs, "--since", "2026-10-20", "--until", "2026-10-25", ...args], { cwd: s.root, env: s.env });
}

test("--by task --json: each task's build time, working minutes, sessions, tokens, cost, CI runs and review rounds", () => {
  const s = setup();
  const p = usage(s, "--by", "task", "--json");
  expect(p.code, p.out).toBe(0);
  const data = JSON.parse(p.stdout) as { task_costs: Row[]; medians: Row; times_from: string };
  expect(data.times_from).toBe(s.state);
  const seven = data.task_costs.find((t) => t.task === "7") as Row;
  expect(seven).toMatchObject({ startedAt: "2026-10-24T09:00:00.000Z", startFrom: "claim", doneAt: "2026-10-24T12:30:00.000Z", buildMinutes: 210,
    workingMinutes: 60, sessions: 2, replies: 4, used: 600, unpriced: 0, unpricedShare: 0,
    ci: { runs: 3, failed: 1, failedInARow: 0 }, reviews: { rounds: 1 }, worker: "taytu" });
  // 400 input at $4 per million and 200 output at $20 per million
  expect(seven.cost as number).toBeCloseTo((400 * 4 + 200 * 20) / 1_000_000, 9);
  const eight = data.task_costs.find((t) => t.task === "8") as Row;
  expect(eight).toMatchObject({ doneAt: null, buildMinutes: null, workingMinutes: 10, sessions: 1, replies: 2, unpriced: 1, unpricedShare: 0.5,
    ci: { runs: 3, failed: 2, failedInARow: 2 }, reviews: { rounds: 0 } });
  expect(data.medians).toEqual({ done: 1, used: 600, workingMinutes: 60 });
});

test("--by task: the text report lists each task's build time, working time, sessions, cost, CI and reviews", () => {
  const s = setup();
  const p = usage(s, "--by", "task");
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("What each task took");
  const line7 = p.stdout.split("\n").find((l) => /^7\s/.test(l) && l.includes("3h 30m")) ?? "";
  expect(line7, p.stdout).toContain("1h 00m");
  expect(line7).toContain("$0.01");
  expect(line7).toContain("3 (1 failed)");
  const line8 = p.stdout.split("\n").find((l) => /^8\s/.test(l) && l.includes("in progress")) ?? "";
  expect(line8, p.stdout).toContain("10m");
  expect(line8).toContain("50% unpriced");
  expect(line8).toContain("3 (2 failed)");
});

test("--by task with nothing kept: the times say where they would come from; the sessions still count", () => {
  const s = setup();
  write(join(s.state, "task-times.json"), "not json");
  write(join(s.state, "snapshot.json"), "{}");
  const p = usage(s, "--by", "task", "--json");
  expect(p.code, p.out).toBe(0);
  const data = JSON.parse(p.stdout) as { task_costs: Row[] };
  expect(data.task_costs.find((t) => t.task === "7")).toMatchObject({ startFrom: "first-reply", startedAt: "2026-10-24T09:05:00Z", buildMinutes: null,
    sessions: 2, ci: { runs: 0, failed: 0, failedInARow: 0 } });
  // read only: nothing is written to the state folder
  expect(readFileSync(join(s.state, "task-times.json"), "utf8")).toBe("not json");
});

test("--by agent leaves the per task times out", () => {
  const s = setup();
  const p = usage(s, "--by", "agent", "--json");
  expect(p.code, p.out).toBe(0);
  expect("task_costs" in (JSON.parse(p.stdout) as Row)).toBe(false);
  expect(usage(s, "--by", "agent").stdout).not.toContain("What each task took");
});

test("--by task: a board task (b<n>) gets its sessions, CI runs and review rounds from its task/b<n>- branch (#604)", () => {
  const s = setup();
  const wt = s.root + "-agents/taytu";
  write(join(s.logs, slugOf(wt), "s4.jsonl"), [reply("c1", "task/b27-goal", wt, "2026-10-24T13:20:00Z"),
    reply("c2", "task/b27-goal", wt, "2026-10-24T13:35:00Z")].join("\n") + "\n");
  write(join(s.state, "snapshot.json"), JSON.stringify({ generatedAt: "2026-10-24T14:00:00.000Z",
    tasks: { source: "board", tasks: [], epics: [] },
    pulls: [{ number: 30, branch: "task/b27-goal", head: "aaa1111", review: "factory-mustfix" }],
    ci: { runs: [{ id: 11, branch: "task/b27-goal", state: "failure", minutesAgo: 40 },
      { id: 12, branch: "task/b27-goal", state: "success", minutesAgo: 20 }] } }));
  const p = usage(s, "--by", "task", "--json");
  expect(p.code, p.out).toBe(0);
  const data = JSON.parse(p.stdout) as { task_costs: Row[] };
  expect(data.task_costs.find((t) => t.task === "b27")).toMatchObject({ sessions: 1, replies: 2, workingMinutes: 15,
    ci: { runs: 2, failed: 1, failedInARow: 0 }, reviews: { rounds: 1 } });
});
