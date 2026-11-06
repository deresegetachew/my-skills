// Epics through the TaskTracker port (#440): the GitHub adapter reads the issues labelled `epic` (open and closed), keeps
// them out of the task list; the plan and memory adapters have none.
import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { GithubTaskTracker } from "../hooks/core/adapters/github/task_tracker.ts";
import { MemoryTaskTracker } from "../hooks/core/adapters/memory/task_tracker.ts";
import { PlanTaskTracker } from "../hooks/core/adapters/plan/task_tracker.ts";
import type { Config } from "../hooks/factory_config.ts";
import { FAKE_GH, type IssueRow, issue } from "./issues_support.ts";
import { tmp, write, writeExe } from "./support.ts";

const dirs: string[] = [];
const PATH = process.env.PATH;
const HOME = process.cwd();
afterAll(() => {
  process.chdir(HOME);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const cfg = { tasks: { source: "issues" }, mainBranch: "main" } as unknown as Config;

function world(issues: IssueRow[]): void {
  const d = tmp();
  dirs.push(d);
  writeExe(join(d, "bin", "gh"), FAKE_GH);
  const db = write(join(d, "db.json"), JSON.stringify({ issues }));
  Object.assign(process.env, { PATH: `${d}/bin:${PATH}`, FAKE_GH_DB: db, FACTORY_CLAIM_SETTLE_SECONDS: "0" });
}

const epic = (n: number, labels: string[], body = "", state = "open"): IssueRow => ({ ...issue(n, ["epic", ...labels], body), title: `Epic ${n}`, state });

test("github: the issues labelled epic come back as epics, in issue-number order, with stage, tasks, PRD and decisions", () => {
  world([epic(9, ["epic:building"], "PRD: docs/b.md\nDecisions: 0003, 0004\n- [ ] #2 One\n- [ ] #3 Two"),
    epic(5, []), issue(2, ["factory:ready"]), issue(3, ["factory:ready"])]);
  const epics = new GithubTaskTracker(cfg).epics();
  expect(epics.map((e) => e.id)).toEqual(["5", "9"]);
  expect(epics[0]).toMatchObject({ title: "Epic 5", stage: "investigating", tasks: [], prd: "", decisions: [] });
  expect(epics[1]).toMatchObject({ stage: "building", prd: "docs/b.md", decisions: ["0003", "0004"],
    tasks: [{ id: "2", done: false }, { id: "3", done: false }] });
});

test("github: a task is done when its issue is closed, though its box is not ticked", () => {
  world([epic(9, ["epic:building"], "- [ ] #2 Merged\n- [ ] #3 Open"), { ...issue(2, []), state: "closed" }, issue(3, ["factory:ready"])]);
  expect(new GithubTaskTracker(cfg).epics()[0]?.tasks).toEqual([{ id: "2", done: true }, { id: "3", done: false }]);
});

test("github: a closed epic is still listed, as done", () => {
  world([epic(9, ["epic:building"], "", "closed"), epic(10, [])]);
  const epics = new GithubTaskTracker(cfg).epics();
  expect(epics.map((e) => [e.id, e.stage])).toEqual([["9", "done"], ["10", "investigating"]]);
});

test("github: an epic is not a task: the task list leaves it out", () => {
  world([epic(9, [], "- [ ] #2 x"), issue(2, ["factory:ready"]), epic(10, ["factory:ready"])]);
  expect(new GithubTaskTracker(cfg).list().map((t) => t.id)).toEqual(["2"]);
});

test("github: no epic issues, no epics", () => {
  world([issue(1)]);
  expect(new GithubTaskTracker(cfg).epics()).toEqual([]);
});

test("memory: no epics", () => {
  expect(new MemoryTaskTracker().epics()).toEqual([]);
});

test("plan: no epics", () => {
  const d = tmp();
  dirs.push(d);
  process.chdir(d);
  write(join(d, "docs", "build-plan.md"), "# Plan\n");
  write(join(d, "docs", "blocked.md"), "# Blocked\n");
  expect(new PlanTaskTracker({ plan: "docs/build-plan.md", blocked: "docs/blocked.md", mainBranch: "main" } as Config).epics()).toEqual([]);
});
