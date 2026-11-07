// The plan-file TaskTracker adapter (decision 0003, #377): it passes the port's contract, with the build plan and the
// blocked list as files and the claims in the local claims file (factory_claims.ts), as plan mode always kept them.
import { afterAll, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PlanTaskTracker } from "../hooks/core/adapters/plan/task_tracker.ts";
import type { Config } from "../hooks/factory_config.ts";
import { claimTask } from "../hooks/factory_claims.ts";
import { taskTrackerContract } from "./contracts/task_tracker.ts";
import { FAKE_GH, type IssueRow, issue, saveDb } from "./issues_support.ts";
import { read, tmp, write, writeExe } from "./support.ts";

const dirs: string[] = [];
const HOME = process.cwd();
const PATH = process.env.PATH;
afterAll(() => {
  process.env.PATH = PATH;
  process.chdir(HOME);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A project folder (not a git repo, so nothing is fetched) with `plan` and `blocked` written; the port works in it. */
function project(plan: string, blocked = "# Blocked\n"): [PlanTaskTracker, Config, string] {
  const d = tmp();
  dirs.push(d);
  process.chdir(d);
  write(join(d, "docs", "build-plan.md"), plan);
  write(join(d, "docs", "blocked.md"), blocked);
  const cfg = { plan: "docs/build-plan.md", blocked: "docs/blocked.md", mainBranch: "main" } as Config;
  return [new PlanTaskTracker(cfg), cfg, d];
}

taskTrackerContract("plan", (specs) => {
  const ids = specs.map((_, k) => `1.${k + 1}`);
  const lines = specs.map((s, k) => {
    const deps = s.dependsOn?.length ? ` Depends on ${s.dependsOn.map((d) => ids[d]).join(", ")}.` : "";
    const todos = Array.from({ length: s.todos ?? 0 }, (_, j) => `\n  - [ ] todo ${j + 1}`).join("");
    const prd = s.prd ? "\n  PRD change: #500" : "";
    return `- [${s.state === "done" ? "x" : " "}] **${ids[k]} ${s.title ?? `Task ${k + 1}`}.** Build it.${deps}${prd}${todos}`;
  });
  const blocked = specs.flatMap((s, k) => (s.state === "blocked" ? [`- ${ids[k]}: needs a person`] : []));
  const [port, cfg, d] = project(`# Build plan\n\n## Phase 1: the core\n\n${lines.join("\n")}\n`, `# Blocked\n\n${blocked.join("\n")}\n`);
  const db = github(d, [prdPull(500, null)]);
  return { port, ids, missing: "9.9", foreign: "42", rival: (id, who) => void claimTask([id], who.agent, process.pid, cfg),
    prd: "500", mergePrd: () => saveDb(db, { issues: [prdPull(500, "2026-11-07T09:00:00Z")] }) };
});

/** A fake GitHub for project `d` holding `issues` (the PRD change's pull request is one); the port's gh is it. */
function github(d: string, issues: IssueRow[]): string {
  writeExe(join(d, "bin", "gh"), FAKE_GH);
  const db = write(join(d, "gh-db.json"), JSON.stringify({ issues }));
  Object.assign(process.env, { PATH: `${d}/bin:${PATH}`, FAKE_GH_DB: db });
  return db;
}

/** The PRD change's pull request as the issues API gives it: merged when `merged` is a time. */
function prdPull(n: number, merged: string | null): IssueRow {
  return { ...issue(n, []), state: merged ? "closed" : "open", pull_request: { url: `https://x/pulls/${n}`, merged_at: merged } };
}

test("plan: a task line with no PRD change asks GitHub nothing (#578)", () => {
  const [port, , d] = project("## Phase 1\n\n- [ ] **1.1 One.** Build it.\n");
  writeExe(join(d, "bin", "gh"), "#!/bin/sh\necho called >> \"$(dirname \"$0\")/../gh-called\"\nexit 1\n");
  Object.assign(process.env, { PATH: `${d}/bin:${PATH}` });
  expect(port.next()?.id).toBe("1.1");
  expect(port.list()[0]?.waitsForPrd).toBeUndefined();
  expect(existsSync(join(d, "gh-called"))).toBe(false);
});

test("plan: a task's todos are the checkboxes under it, up to the next task", () => {
  const [port] = project("## Phase 1\n\n- [ ] **1.1 One.** Build.\n  - [ ] a\n  - [ ] b\n- [ ] **1.2 Two.** Build.\n  - [ ] c\n");
  port.tick("1.2", 1);
  expect(port.list().map((t) => [t.id, t.todos.map((x) => `${x.text}:${x.done}`)])).toEqual([["1.1", ["a:false", "b:false"]],
    ["1.2", ["c:true"]]]);
});

test("plan: the phase is the task's group, and a done task is not listed", () => {
  const [port] = project("## Phase 1: core\n\n- [x] **1.1 One.**\n\n## Phase 2: more\n\n- [ ] **2.1 Two.**\n");
  expect(port.list().map((t) => [t.id, t.group])).toEqual([["2.1", "Phase 2: more"]]);
});

test("plan: a block is written to the blocked list with its reason, and a release takes only that line off", () => {
  const [port, , d] = project("## Phase 1\n\n- [ ] **1.1 One.**\n- [ ] **1.2 Two.**\n", "# Blocked\n\n- 1.2: a person's line\n");
  port.block("1.1", "needs the Stripe keys");
  expect(read(join(d, "docs", "blocked.md"))).toBe("# Blocked\n\n- 1.2: a person's line\n- 1.1: needs the Stripe keys\n");
  port.release("1.1");
  expect(read(join(d, "docs", "blocked.md"))).toBe("# Blocked\n\n- 1.2: a person's line\n");
});

test("plan: done ticks the task's own line in the plan, and nothing else", () => {
  const [port, , d] = project("## Phase 1\n\n- [ ] **1.1 One.**\n  - [ ] a\n- [ ] **1.2 Two.**\n");
  port.setState("1.1", "done");
  expect(read(join(d, "docs", "build-plan.md"))).toBe("## Phase 1\n\n- [x] **1.1 One.**\n  - [ ] a\n- [ ] **1.2 Two.**\n");
});

test("plan: a filed task gets the next id after the last task, on the line after it", () => {
  const [port, , d] = project("## Phase 1\n\n- [ ] **1.1 One.**\n- [x] **1.2 Two.**\n\n## Before launch\n\nNot code.\n");
  expect(port.file({ title: "Three", body: "What we're building.\nMore." }).id).toBe("1.3");
  expect(read(join(d, "docs", "build-plan.md"))).toBe("## Phase 1\n\n- [ ] **1.1 One.**\n- [x] **1.2 Two.**\n" +
    "- [ ] **1.3 Three.** What we're building.\n\n## Before launch\n\nNot code.\n");
});

test("plan: a plan with no unticked task gives nothing to pick", () => {
  const [port] = project("## Phase 1\n\n- [x] **1.1 One.**\n");
  expect([port.next(), port.pick({ agent: "haile", machine: "m1" }).task]).toEqual([null, null]);
});
