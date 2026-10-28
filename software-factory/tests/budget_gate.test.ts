// Token budgets (#183), the parts other people rely on: the PR gate keeps a coding agent from changing its own task's
// budget, and `factory report` shows budget against used per merged task from the PRs' usage comments.
import { expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { type Env, runGate } from "./pr_gate_support.ts";
import { HOOKS, SF, envWith, gitRepo, sh, tmp, write, writeExe } from "./support.ts";

// The gate's fake gh: main's settings, and one issue whose body the scenario gives.
const GATE_GH = String.raw`#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
const s = JSON.parse(readFileSync(process.env.GATE_SCENARIO as string, "utf8"));
const a = process.argv.slice(2);
appendFileSync(process.env.GATE_LOG as string, a.join(" ") + "\n");
const j = a.join(" ");
function out(x: unknown): never { console.log(JSON.stringify(x)); process.exit(0); }
function fail(m: string): never { console.error(m); process.exit(1); }
if (a[0] === "repo" && a[1] === "view") { console.log("main"); process.exit(0); }
if (a[0] === "api" && j.includes("/contents/.claude/factory.json")) out({});
if (a[0] === "api" && /issues\/7$/.test(a.find((x) => x.includes("issues/")) ?? "")) {
  if (s.issue_broken) fail("gh: HTTP 502");
  out({ number: 7, state: "open", labels: [], body: s.body });
}
fail("fake gh: no answer for " + j);
`;

function gateSetup(body: string, extra: Record<string, unknown> = {}): [string, Env] {
  const d = tmp();
  writeExe(join(d, "bin", "gh"), GATE_GH);
  write(join(d, ".claude", "factory.json"), "{}");
  write(join(d, "scenario.json"), JSON.stringify({ body, ...extra }));
  sh(["git", "init", "-q", d]);
  const env: Env = { ...process.env, PATH: `${d}/bin:${process.env.PATH}`, GATE_SCENARIO: join(d, "scenario.json"),
    GATE_LOG: join(d, "log"), FACTORY_ROLE: "coding-agent" };
  delete env.FACTORY_AGENT;
  delete env.CLAUDE_PROJECT_DIR;
  return [d, env];
}

const ISSUE = "## What\n\nBuild it.\n\n- **PRD:** US-1\n- **Budget:** 300k\n";

function edit(d: string, env: Env, newBody: string): [number, string] {
  const f = write(join(d, "body.md"), newBody);
  return runGate(d, env, `gh issue edit 7 --body-file ${f}`);
}

test("a coding agent cannot raise or remove its task budget", () => {
  const [d, env] = gateSetup(ISSUE);
  let [code, err] = edit(d, env, ISSUE.replace("300k", "900k"));
  expect(code, err).toBe(2);
  expect(err).toContain("Budget");
  expect(err).toContain("factory-question");
  [code, err] = edit(d, env, ISSUE.replace("- **Budget:** 300k\n", ""));
  expect(code, err).toBe(2);
  [code, err] = runGate(d, env, "gh issue edit 7 --body 'Budget: 1m'");
  expect(code, err).toBe(2);
});

test("a coding agent may edit the rest of the issue and add labels", () => {
  const [d, env] = gateSetup(ISSUE);
  expect(edit(d, env, ISSUE.replace("Build it.", "Build it well.").replace("300k", "300,000"))).toEqual([0, ""]);
  expect(runGate(d, env, "gh issue edit 7 --add-label factory:blocked")).toEqual([0, ""]);
});

test("the product owner and the dev manager may change a budget", () => {
  for (const role of ["product-owner", "dev-manager"]) {
    const [d, env] = gateSetup(ISSUE);
    env.FACTORY_ROLE = role;
    expect(edit(d, env, ISSUE.replace("300k", "900k")), role).toEqual([0, ""]);
  }
});

test("an issue the gate cannot read fails closed", () => {
  const [d, env] = gateSetup(ISSUE, { issue_broken: true });
  const [code, err] = edit(d, env, ISSUE);
  expect(code, err).toBe(2);
  expect(err).toContain("#7");
});

test("the api way is checked the same and the budget marker is reserved", () => {
  const [d, env] = gateSetup(ISSUE);
  let [code, err] = runGate(d, env, "gh api -X PATCH repos/o/r/issues/7 -f 'body=Budget: 2m'");
  expect(code, err).toBe(2);
  expect(err).toContain("Budget");
  [code, err] = runGate(d, env, "gh issue comment 7 --body '<!-- factory-budget tokens=9000000 -->'");
  expect(code, err).toBe(2);
});

// --- factory report ------------------------------------------------------------------------------------------------

const REPORT_GH = String.raw`#!/usr/bin/env bun
import { readFileSync } from "node:fs";
const s = JSON.parse(readFileSync(process.env.REPORT_SCENARIO as string, "utf8"));
const a = process.argv.slice(2);
function fail(m: string): never { console.error(m); process.exit(1); }
if (a[0] !== "api" || a.includes("-X") || a.includes("--input")) fail("fake gh: report must only read");
const u = new URL((a[1] as string).replace("repos/{owner}/{repo}/", ""), "http://x/");
const p = u.pathname.slice(1); const q = u.searchParams;
const out = (x: unknown): never => { console.log(JSON.stringify(x)); process.exit(0); };
if (p === "pulls") out((q.get("page") ?? "1") === "1" ? s.pulls : []);
if (p === "actions/runs") out({ workflow_runs: [] });
if (p.startsWith("issues/") && p.endsWith("/comments")) out(s.comments[p.split("/")[1] as string] ?? []);
fail("fake gh: no answer for " + a[1]);
`;

function ago(hours: number): string {
  return new Date(Date.now() - hours * 3600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function reportSetup(): [string, Env] {
  const root = tmp();
  const d = join(root, "work");
  sh(["mkdir", "-p", d]);
  gitRepo(d);
  write(join(d, ".claude", "factory.json"), JSON.stringify({ tasks: { source: "issues" } }));
  symlinkSync(HOOKS, join(d, ".claude", "hooks"));
  writeExe(join(root, "bin", "gh"), REPORT_GH);
  const pr = (n: number, branch: string) => ({ number: n, head: { ref: branch }, created_at: ago(10), merged_at: ago(2), state: "closed" });
  const usage = (task: number, used: number, budget: number | null) => ({ created_at: ago(3),
    body: `<!-- factory-usage task=${task}${budget === null ? "" : ` used=${used} budget=${budget}`} -->\n**Tokens**` });
  const scenario = {
    pulls: [pr(41, "task/21-a"), pr(40, "task/20-b"), pr(39, "task/19-c")],
    comments: {
      // the last usage comment counts: the one posted before the merge
      "41": [usage(21, 10000, 100000), usage(21, 60000, 100000)],
      "40": [usage(20, 150000, 100000)],
      "39": [usage(19, 5000, null)],
    },
  };
  write(join(root, "scenario.json"), JSON.stringify(scenario));
  return [d, envWith(join(root, "bin"), { REPORT_SCENARIO: join(root, "scenario.json"), CLAUDE_PROJECT_DIR: undefined })];
}

test("the report shows budget against used per merged task and the median", () => {
  const [d, env] = reportSetup();
  let p = sh(["bash", join(SF, "factory"), "report", "--json"], { cwd: d, env });
  expect(p.code, p.out).toBe(0);
  const rows = new Map((JSON.parse(p.stdout) as { tasks: Record<string, unknown>[] }).tasks.map((r) => [r.pr, r]));
  expect([rows.get(41)?.used, rows.get(41)?.budget]).toEqual([60000, 100000]);
  expect([rows.get(40)?.used, rows.get(40)?.budget]).toEqual([150000, 100000]);
  expect([rows.get(39)?.used, rows.get(39)?.budget]).toEqual([null, null]);
  p = sh(["bash", join(SF, "factory"), "report"], { cwd: d, env });
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("60k of 100k (60%)");
  expect(p.stdout).toContain("150k of 100k (150%)");
  expect(p.stdout).toContain("Median used/budget over 2 merged tasks with a budget: 105%");
  expect(p.stdout).toContain("fresh input + output");
});
