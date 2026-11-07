// What each task took, as the pages say it (#580), from web/cost_model.ts as it is (no React): a task's facts, an epic's
// totals, the "By task" table's cells and its sort, and the spinning mark on a card.
import { expect, test } from "bun:test";
import { type AttentionItem, stuckMarks } from "../web/attention_model.ts";
import { costCells, costFacts, type CostRow, costText, durationText, epicCostFacts, sortCosts } from "../web/cost_model.ts";

const row = (task: string, more: Partial<CostRow> = {}): CostRow => ({ task, title: `Task ${task}`, state: "done", epic: null, startedAt: "2026-11-01T09:00:00Z",
  startFrom: "claim", doneAt: "2026-11-01T12:30:00Z", buildMinutes: 210, workingMinutes: 60, sessions: 2, replies: 10, used: 12_000, cost: 1.5, unpriced: 0,
  unpricedShare: 0, ci: { runs: 3, failed: 1, failedInARow: 0 }, reviews: { rounds: 1 }, ...more });

test("durations read as minutes, hours and days", () => {
  expect([durationText(null), durationText(0), durationText(40), durationText(95), durationText(3000)]).toEqual(["-", "0m", "40m", "1h 35m", "2d 2h"]);
});

test("a task's facts: build time, working time over its sessions, tokens, cost with the unpriced share, CI and reviews", () => {
  expect(costFacts(row("7"))).toEqual([
    { label: "Build time", value: "3h 30m" },
    { label: "Agent working", value: "1h 00m over 2 sessions" },
    { label: "Tokens", value: "12k" },
    { label: "Cost", value: "$1.50" },
    { label: "CI runs", value: "3 runs, 1 failed" },
    { label: "Review rounds", value: "1 with must-fixes" },
  ]);
  const going = costFacts(row("8", { doneAt: null, buildMinutes: null, sessions: 1, unpriced: 5, ci: { runs: 0, failed: 0, failedInARow: 0 }, reviews: { rounds: 0 } }));
  expect(going.map((f) => f.value)).toEqual(["Not done yet (started with its first claim)", "1h 00m over 1 session", "12k",
    "$1.50 (50% of replies unpriced)", "None seen", "None with must-fixes"]);
  expect(costText(0, 4, 4)).toBe("No price known");
});

test("an epic's totals", () => {
  expect(epicCostFacts({ epic: "100", tasks: 3, done: 2, buildMinutes: 70, workingMinutes: 200, sessions: 3, replies: 24, used: 2_500_000, cost: 12.345,
    unpriced: 0, ci: { runs: 6, failed: 2 }, reviews: { rounds: 0 } }).map((f) => `${f.label}: ${f.value}`)).toEqual([
    "Tasks done: 2 of 3", "Build time: 1h 10m (its done tasks added up)", "Agent working: 3h 20m over 3 sessions", "Tokens: 2.5M", "Cost: $12.35",
    "CI runs: 6 runs, 2 failed", "Review rounds: None with must-fixes"]);
});

test("the By task table sorts by any column, both ways; a task not done has no build time", () => {
  const rows = [row("7", { cost: 3, buildMinutes: 100 }), row("10", { cost: 1, doneAt: null, buildMinutes: null }), row("8", { cost: 2, buildMinutes: 300 })];
  expect(sortCosts(rows, "cost", true).map((r) => r.task)).toEqual(["7", "8", "10"]);
  expect(sortCosts(rows, "cost", false).map((r) => r.task)).toEqual(["10", "8", "7"]);
  expect(sortCosts(rows, "build", true).map((r) => r.task)).toEqual(["8", "7", "10"]);
  expect(sortCosts(rows, "task", false).map((r) => r.task)).toEqual(["7", "8", "10"]);
  expect(costCells(rows[1] as CostRow)).toEqual({ task: "#10 Task 10", build: "Not done", working: "1h 00m", sessions: "2", tokens: "12k", cost: "$1.00",
    ci: "3 (1)", reviews: "1" });
});

test("a spinning task is marked on its card with its reason", () => {
  const i: AttentionItem = { id: "task-spinning:7", kind: "task-spinning", title: "#7 Search", reason: "Its last 3 CI runs failed.", task: "7", agent: "taytu",
    pr: null, epic: null, action: { kind: "open", label: "Open its output", link: "agent:taytu" } };
  expect(stuckMarks([i]).tasks).toEqual({ "7": "Its last 3 CI runs failed." });
});
