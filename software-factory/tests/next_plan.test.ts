// next_task.ts in plan mode reads its tasks through the TaskTracker port (#377): a task that depends on an unticked
// plan task waits, and `--json` lists the blocked tasks of the plan.
import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { runHook, tmp, write } from "./support.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function project(plan: string, blocked = "# Blocked\n"): string {
  const d = tmp();
  dirs.push(d);
  write(join(d, ".claude", "factory.json"), "{}");
  write(join(d, "docs", "build-plan.md"), plan);
  write(join(d, "docs", "blocked.md"), blocked);
  return d;
}

function next(d: string, ...args: string[]): [number, string] {
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_DIR: d };
  delete env.FACTORY_AGENT;
  delete env.FACTORY_PID;
  const p = runHook("next_task", ["--no-rework", ...args], { cwd: d, env });
  return [p.code, p.stdout.trim()];
}

test("a plan task that depends on an unticked one waits, and is next once that one is ticked", () => {
  const plan = "## Phase 1\n\n- [ ] **1.1 One.** Build.\n- [ ] **1.2 Two.** Depends on 1.1.\n- [ ] **1.3 Three.** Build.\n";
  const d = project(plan);
  expect(next(d, "--after", "1.1")).toEqual([0, "1.3 Three"]);
  expect(JSON.parse(next(d, "--json")[1])).toEqual({ id: "1.1", title: "One", remaining: 2, blocked: [] });
  write(join(d, "docs", "build-plan.md"), plan.replace("- [ ] **1.1", "- [x] **1.1"));
  expect(next(d)).toEqual([0, "1.2 Two"]);
});

test("--json lists the plan's blocked tasks, not a blocked line for a task that is done or not in the plan", () => {
  const d = project("## Phase 1\n\n- [x] **1.1 One.**\n- [ ] **1.2 Two.**\n- [ ] **1.3 Three.**\n",
    "# Blocked\n\n- 1.1: was waiting\n- 1.2: needs keys\n- 9.9: gone\n");
  expect(JSON.parse(next(d, "--json")[1])).toEqual({ id: "1.3", title: "Three", remaining: 1, blocked: ["1.2"] });
});
