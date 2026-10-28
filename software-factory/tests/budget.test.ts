// Token budgets per task (#183): the `Budget:` line of a task issue, the `budget.builder` default, the budget recorded
// in the claim, `factory usage --task <n> --budget` and the budget line on the PR's usage comment, the loop's prompt.
// Against the issues fake `gh` (a JSON file) and fake Claude Code logs.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FAKE_GH, issue, loadDb, type IssueRow } from "./issues_support.ts";
import { calls, loopProject } from "./loop_support.ts";
import { KIT, read, readmeAndWiki, runHook, SF, sh, tmp, write, writeExe, type Proc } from "./support.ts";

type Env = Record<string, string | undefined>;
type Comments = Record<string, { body: string; at: number }[]>;

function reply(mid: string, branch: string, cwd: string, o: { inp: number; write: number; read: number; out: number }): string {
  return JSON.stringify({ type: "assistant", timestamp: "2026-10-24T10:00:00Z", gitBranch: branch, cwd,
    message: { id: mid, model: "claude-opus-5-5", usage: { input_tokens: o.inp, cache_creation_input_tokens: o.write,
      cache_read_input_tokens: o.read, output_tokens: o.out } } });
}

const MAIN = { inp: 1000, write: 9000, read: 50000, out: 2000 }; // counted: 12k a reply (cache reads are not)
const REVIEW = { inp: 1000, write: 9000, read: 80000, out: 10000 }; // counted: 20k

/** A project in issues mode with the fake gh, and Claude Code logs for task 7: two main replies and a reviewer's,
 * 44k counted (fresh input + output) and 180k cache reads, which a budget does not count. */
function setup(issues: IssueRow[], o: { cfg?: Record<string, unknown>; comments?: Comments } = {}): [string, string, Env] {
  const d = tmp();
  const root = join(d, "proj");
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeExe(join(d, "bin", "gh"), FAKE_GH);
  write(join(root, ".claude", "factory.json"), JSON.stringify({ tasks: { source: "issues" }, agents: ["menelik"], ...(o.cfg ?? {}) }));
  const db = write(join(d, "db.json"), JSON.stringify({ issues, comments: o.comments ?? {} }));
  const logs = join(d, "logs");
  const dir = join(logs, root.replace(/[^A-Za-z0-9]/g, "-"));
  write(join(dir, "s1.jsonl"), [reply("m1", "task/7-x", root, MAIN), reply("m2", "task/7-x", root, MAIN)].join("\n") + "\n");
  write(join(dir, "s1", "subagents", "agent-a.jsonl"), reply("r1", "HEAD", root, REVIEW) + "\n");
  writeFileSync(join(dir, "s1", "subagents", "agent-a.meta.json"), JSON.stringify({ agentType: "reviewer" }));
  const env: Env = { ...process.env, PATH: `${d}/bin:${process.env.PATH}`, FAKE_GH_DB: db, CLAUDE_PROJECT_DIR: root };
  delete env.FACTORY_AGENT;
  env.FAKE_LOGS = logs;
  return [root, db, env];
}

function usage(root: string, env: Env, ...args: string[]): Proc {
  return runHook("factory_usage", ["--logs", env.FAKE_LOGS as string, "--since", "2026-10-20", "--until", "2026-10-25", ...args],
    { cwd: root, env });
}

const claim = (budget: string | null): string => `<!-- factory-claim agent=menelik -->\n**menelik** is working on this.` +
  (budget === null ? "" : `\n<!-- factory-budget tokens=${budget} -->`);

test("the checkpoint shows used budget remaining and percent counting fresh input and output", () => {
  const [root, , env] = setup([issue(7, ["factory:in-progress"], "Some text.\n\n- **PRD:** US-1\n- **Budget:** 100k\n")]);
  const p = usage(root, env, "--task", "7", "--budget");
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("44k of 100k");
  expect(p.stdout).toContain("(44%)");
  expect(p.stdout).toContain("56k left");
  expect(p.stdout).toContain("fresh input (input + cache writes) + output");
  expect(p.stdout).toContain("cache reads are not counted");
  expect(p.stdout).not.toContain("Warning");
});

test("the checkpoint warns at 80 percent and over the budget and still exits 0", () => {
  let [root, , env] = setup([issue(7, ["factory:in-progress"], "Budget: 50k")]);
  let p = usage(root, env, "--task", "7", "--budget");
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("(88%)");
  expect(p.stdout).toContain("Warning");
  expect(p.stdout).toContain("factory-question");
  [root, , env] = setup([issue(7, ["factory:in-progress"], "Budget: 40k")]);
  p = usage(root, env, "--task", "7", "--budget");
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("(110%)");
  expect(p.stdout).toContain("over the budget by 4k");
});

test("a budget line takes the usual ways of writing a number", () => {
  for (const [line, shown] of [["Budget: 1.2m", "of 1.2m"], ["- **Budget:** 300k fresh+output", "of 300k"],
    ["Budget: 300000", "of 300k"], ["Budget: 300,000", "of 300k"], ["budget: 250K", "of 250k"]] as const) {
    const [root, , env] = setup([issue(7, ["factory:in-progress"], `Intro\n${line}\nMore`)]);
    const p = usage(root, env, "--task", "7", "--budget");
    expect(p.stdout, line).toContain(shown);
  }
});

test("without a budget line the role default from factory json applies", () => {
  const [root, , env] = setup([issue(7, ["factory:in-progress"], "No budget here.")], { cfg: { budget: { builder: 100000 } } });
  const p = usage(root, env, "--task", "7", "--budget");
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("44k of 100k");
  expect(p.stdout).toContain("budget.builder");
});

test("with no budget anywhere nothing is compared and it exits 0", () => {
  const [root, , env] = setup([issue(7, ["factory:in-progress"], "No budget here.")]);
  const p = usage(root, env, "--task", "7", "--budget");
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("no budget");
  expect(p.stdout).toContain("44k");
  expect(p.stdout).not.toContain("%)");
});

test("the budget recorded at the claim wins over a later edit of the issue", () => {
  let [root, , env] = setup([issue(7, ["factory:in-progress"], "Budget: 900k")], { comments: { "7": [{ body: claim("50000"), at: 1 }] } });
  expect(usage(root, env, "--task", "7", "--budget").stdout).toContain("44k of 50k");
  // The claim said the issue had none: the role default, not the line added since.
  [root, , env] = setup([issue(7, ["factory:in-progress"], "Budget: 900k")],
    { cfg: { budget: { builder: 200000 } }, comments: { "7": [{ body: claim("none"), at: 1 }] } });
  expect(usage(root, env, "--task", "7", "--budget").stdout).toContain("44k of 200k");
  // A release ends that claim; a claim without a record (an older kit) reads the issue.
  [root, , env] = setup([issue(7, ["factory:in-progress"], "Budget: 100k")], { comments: { "7": [
    { body: claim("50000"), at: 1 }, { body: "<!-- factory-release agent=menelik -->", at: 2 }, { body: claim(null), at: 3 }] } });
  expect(usage(root, env, "--task", "7", "--budget").stdout).toContain("44k of 100k");
});

test("a task with no replies on this machine shows the whole budget left", () => {
  const [root, , env] = setup([issue(9, ["factory:in-progress"], "Budget: 100k")]);
  const p = usage(root, env, "--task", "9", "--budget");
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("0 of 100k");
  expect(p.stdout).toContain("(0%)");
  expect(p.stdout).toContain("No replies found");
});

test("budget needs a task", () => {
  const [root, , env] = setup([]);
  const p = usage(root, env, "--budget");
  expect(p.code).toBe(2);
  expect(p.stderr).toContain("--budget needs --task");
});

test("the pr comment adds used against budget and the top subagent", () => {
  const [root, , env] = setup([issue(7, ["factory:in-progress"], "Budget: 100k")]);
  const p = usage(root, env, "--task", "7", "--markdown");
  expect(p.code, p.out).toBe(0);
  expect(p.stdout.split("\n")[0]).toBe("<!-- factory-usage task=7 used=44000 budget=100000 -->");
  expect(p.stdout).toContain("**Budget:** used 44k of 100k (44%)");
  expect(p.stdout).toContain("fresh input (input + cache writes) + output");
  expect(p.stdout).toContain("Top subagent: reviewer, 20k");
});

test("the pr comment is unchanged without a budget", () => {
  const [root, , env] = setup([issue(7, ["factory:in-progress"], "No budget.")]);
  const p = usage(root, env, "--task", "7", "--markdown");
  expect(p.stdout.split("\n")[0]).toBe("<!-- factory-usage task=7 -->");
  expect(p.stdout).not.toContain("Budget");
});

test("a claim records the budget the issue had then", () => {
  const [root, db, env] = setup([issue(1, ["factory:ready"], "- **Budget:** 300k"), issue(2, ["factory:ready"], "none")]);
  let p = runHook("factory_issues", ["pick", "--agent", "menelik"], { cwd: root, env });
  expect(p.code, p.out).toBe(0);
  const first = (loadDb(db).comments?.["1"] ?? []).map((c) => c.body).join("\n");
  expect(first).toContain("<!-- factory-claim agent=menelik");
  expect(first).toContain("<!-- factory-budget tokens=300000 -->");
  expect(first).toContain("300k");
  write(db, JSON.stringify({ ...loadDb(db), issues: loadDb(db).issues.map((i) => i.number === 1 ? { ...i, state: "closed" } : i) }));
  p = runHook("factory_issues", ["pick", "--agent", "menelik"], { cwd: root, env });
  expect(p.code, p.out).toBe(0);
  const second = (loadDb(db).comments?.["2"] ?? []).map((c) => c.body).join("\n");
  expect(second).toContain("<!-- factory-budget tokens=none -->");
});

test("the prompt line states the budget and what it counts", () => {
  let [root, , env] = setup([issue(7, ["factory:in-progress"], "Budget: 300k")]);
  let p = runHook("factory_budget", ["prompt", "issue-7"], { cwd: root, env });
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("300k");
  expect(p.stdout).toContain("fresh input (input + cache writes) + output");
  expect(p.stdout).toContain("factory usage --task 7 --budget");
  [root, , env] = setup([issue(7, ["factory:in-progress"], "None.")]);
  p = runHook("factory_budget", ["prompt", "issue-7"], { cwd: root, env });
  expect([p.code, p.stdout]).toEqual([0, ""]);
});

test("the loop puts the budget line in the prompt", () => {
  const [work, env] = loopProject();
  writeExe(join(work, ".claude", "hooks", "factory_budget.ts"),
    '#!/usr/bin/env bun\nif (process.argv[2] === "prompt") console.log("Budget for this task: 300k tokens (" + process.argv[3] + ").");\n');
  const p = sh(["bash", "./factory-loop.sh", "1"], { cwd: work, env, timeoutMs: 60_000 });
  const got = calls(env);
  expect(got.length, p.out).toBe(1);
  expect((got[0] as string[]).at(-1)).toBe("/next-task 1.1\n\nBudget for this task: 300k tokens (1.1).");
});

test("the setting the help the commands page and the task template know budgets", () => {
  const help = sh(["bash", join(SF, "factory"), "help"], { cwd: SF }).stdout;
  expect(help).toContain("--budget");
  expect(readmeAndWiki()).toContain("factory usage --task <n> --budget");
  expect(readmeAndWiki("settings.md")).toContain("| `budget.builder` |");
  const p = sh(["bash", join(SF, "factory"), "settings", "help", "budget.builder"], { cwd: SF });
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("fresh input");
  expect(read(join(KIT, ".github", "ISSUE_TEMPLATE", "factory-task.md"))).toContain("**Budget:**");
  expect(read(join(KIT, ".claude", "skills", "next-task", "SKILL.md"))).toContain("--budget");
});
