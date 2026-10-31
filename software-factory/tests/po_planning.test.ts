// The product owner plans when the builders run low (#378): `roles.product-owner.minReady`. When fewer `factory:ready`
// tasks can start now (no open `Depends on #n`, not claimed) than that, the product owner's work has a planning line.
//
// Runs the real factory in a throwaway project (roles_support.ts) with a fake `claude` and the stateful fake `gh`.
import { expect, test } from "bun:test";
import { claudeCalls, factory, issue, poProject, posted, type Row } from "./roles_support.ts";
import { readmeAndWiki } from "./support.ts";

const READY = "factory:ready";

// A task the builders finished: planning is for once they have started.
const BUILT = issue(9, "Built", "", [], "closed");

function dryRun(issues: Row[], po: Row = {}, tasks: Row = { source: "issues" }, built = true): string {
  const cfg = { tasks, roles: { "product-owner": { names: ["eleni"], busyMinutes: 0, idleMinutes: 0, ...po } } };
  const [d, work, env] = poProject({ db: { issues: built ? [BUILT, ...issues] : issues }, cfg });
  const p = factory(work, env, ["product-owner", "loop", "--once", "--dry-run"]);
  expect(p.code, p.out).toBe(0);
  expect(posted(d), "the dry run writes nothing").toEqual([]);
  expect(claudeCalls(env)).toEqual([]);
  return p.stdout;
}

const ready = (n: number, body = ""): Row => issue(n, `Task ${n}`, body, [READY]);

test("two startable tasks with minReady 4 is a planning line", () => {
  const out = dryRun([ready(584), ready(569)], { minReady: 4 });
  expect(out).toContain("work: planning: 2 tasks can start (#569, #584), below 4");
});

test("ready tasks that depend on open issues do not count", () => {
  const out = dryRun([ready(20), ready(21), ready(22, "Depends on #30"), ready(23, "Depends on #31"),
    issue(30, "Open one", "", ["factory:in-progress"]), issue(31, "Open two")], { minReady: 4 });
  expect(out).toContain("work: planning: 2 tasks can start (#20, #21), below 4");
});

test("a claimed or blocked ready task does not count and a closed dependency does not hold one back", () => {
  const out = dryRun([ready(20, "Depends on #30"), issue(30, "Done", "", [], "closed"),
    issue(21, "Claimed", "", [READY, "agent:menelik"]), issue(22, "Blocked", "", [READY, "factory:blocked"])], { minReady: 2 });
  expect(out).toContain("work: planning: 1 task can start (#20), below 2");
});

test("five startable tasks is no planning line", () => {
  const out = dryRun([ready(1), ready(2), ready(3), ready(4), ready(5)], { minReady: 4 });
  expect(out).not.toContain("planning:");
});

test("the default is 4", () => {
  expect(dryRun([ready(1), ready(2), ready(3)])).toContain("work: planning: 3 tasks can start (#1, #2, #3), below 4");
  expect(dryRun([ready(1), ready(2), ready(3), ready(4)])).not.toContain("planning:");
});

test("minReady 0 turns it off", () => {
  expect(dryRun([], { minReady: 0 })).not.toContain("planning:");
  expect(dryRun([ready(1)], { minReady: 0 })).not.toContain("planning:");
});

test("no ready task at all is a planning line", () => {
  expect(dryRun([], { minReady: 4 })).toContain("work: planning: 0 tasks can start, below 4");
});

test("before the builders started there is no planning line and an open task in progress counts as started", () => {
  expect(dryRun([], { minReady: 4 }, undefined, false), "a new project plans through discovery").not.toContain("planning:");
  expect(dryRun([ready(1)], { minReady: 4 }, undefined, false)).not.toContain("planning:");
  const out = dryRun([ready(1), issue(2, "Being built", "", ["factory:in-progress", "agent:menelik"])], { minReady: 4 }, undefined, false);
  expect(out).toContain("work: planning: 1 task can start (#1), below 4");
  const review = dryRun([issue(3, "In review", "", ["factory:in-review"])], { minReady: 4 }, undefined, false);
  expect(review).toContain("work: planning: 0 tasks can start, below 4");
});

test("in plan mode there is no planning line", () => {
  expect(dryRun([ready(1)], { minReady: 4 }, { source: "plan" })).not.toContain("planning:");
});

test("the setting is in factory settings and on the settings page", () => {
  const [, work, env] = poProject();
  const p = factory(work, env, ["settings", "get", "roles.product-owner.minReady"]);
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("4");
  expect(readmeAndWiki("settings.md")).toContain("| `roles.product-owner.minReady` | int | `4` |");
});
