// A task lists the decisions and PRD stories its body cites (`cites`), from either tracker: the GitHub issue body or the
// task's block in the build plan. A task that cites nothing has an empty list.
import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { GithubTaskTracker } from "../hooks/core/adapters/github/task_tracker.ts";
import { PlanTaskTracker } from "../hooks/core/adapters/plan/task_tracker.ts";
import type { Config } from "../hooks/factory_config.ts";
import { FAKE_GH, issue } from "./issues_support.ts";
import { tmp, write, writeExe } from "./support.ts";

const dirs: string[] = [];
const PATH = process.env.PATH;
const HOME = process.cwd();
afterAll(() => {
  process.chdir(HOME);
  process.env.PATH = PATH;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const citesOf = (tasks: object[]): unknown[] => tasks.map((t) => t as { id: string; cites?: string[] }).map((t) => [t.id, t.cites]);

test("github: the issue body's citations are the task's cites; no citations is []", () => {
  const d = tmp();
  dirs.push(d);
  writeExe(join(d, "bin", "gh"), FAKE_GH);
  const db = write(join(d, "db.json"), JSON.stringify({ issues: [
    issue(1, ["factory:ready"], "Build it as decision 0004 says, for US-12."), issue(2, ["factory:ready"], "Nothing cited here.")] }));
  Object.assign(process.env, { PATH: `${d}/bin:${PATH}`, FAKE_GH_DB: db });
  const port = new GithubTaskTracker({ tasks: { source: "issues" }, mainBranch: "main" } as unknown as Config);
  expect(citesOf(port.list())).toEqual([["1", ["decision 0004", "US-12"]], ["2", []]]);
});

test("plan: a task's block in the plan gives its cites, and only its own block", () => {
  const d = tmp();
  dirs.push(d);
  process.chdir(d);
  write(join(d, "docs", "build-plan.md"), "## Phase 1\n\n- [ ] **1.1 One.** Per decision 0004.\n  - [ ] cover US-12\n- [ ] **1.2 Two.** Build.\n");
  write(join(d, "docs", "blocked.md"), "# Blocked\n");
  const port = new PlanTaskTracker({ plan: "docs/build-plan.md", blocked: "docs/blocked.md", mainBranch: "main" } as Config);
  expect(citesOf(port.list())).toEqual([["1.1", ["decision 0004", "US-12"]], ["1.2", []]]);
});
