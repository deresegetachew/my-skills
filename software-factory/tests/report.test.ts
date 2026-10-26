// `factory report`: per task, claim to PR to merge, rework rounds and CI runs, from GitHub (#65), against a fake
// `gh` that answers from a scenario.
import { expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { CLAIM } from "../hooks/factory_report.ts";
import { HOOKS, SF, envWith, gitRepo, sh, tmp, write, writeExe, type Proc } from "./support.ts";

const FAKE_GH = String.raw`#!/usr/bin/env bun
import { readFileSync } from "node:fs";
const s = JSON.parse(readFileSync(process.env.REPORT_SCENARIO as string, "utf8"));
const a = process.argv.slice(2);
function fail(m: string): never { console.error(m); process.exit(1); }
if (a[0] !== "api" || a.includes("-X") || a.includes("--input")) fail("fake gh: report must only read");
const u = new URL((a[1] as string).replace("repos/{owner}/{repo}/", ""), "http://x/");
const p = u.pathname.slice(1); const q = u.searchParams;
const out = (x: unknown): never => { console.log(JSON.stringify(x)); process.exit(0); };
if (p === "pulls") out((q.get("page") ?? "1") === "1" ? s.pulls : []);
if (p === "actions/runs") out({ workflow_runs: s.runs[q.get("branch") as string] ?? [] });
if (p.startsWith("issues/") && p.endsWith("/comments")) out(s.comments[p.split("/")[1] as string] ?? []);
fail("fake gh: no answer for " + a[1]);
`;

const NOW = Math.floor(Date.now() / 1000) * 1000;

function t(hoursAgo: number): string {
  return new Date(NOW - hoursAgo * 3600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function pr(n: number, branch: string, created: string, merged: string | null = null, state = "closed"): Record<string, unknown> {
  return { number: n, head: { ref: branch }, created_at: created, merged_at: merged,
    state: merged || state === "open" ? state : "closed" };
}

function setup(cfg: Record<string, unknown>): [string, Record<string, string | undefined>] {
  const root = tmp();
  const d = join(root, "work");
  sh(["mkdir", "-p", d]);
  gitRepo(d);
  write(join(d, ".claude", "factory.json"), JSON.stringify(cfg));
  symlinkSync(HOOKS, join(d, ".claude", "hooks"));
  writeExe(join(root, "bin", "gh"), FAKE_GH);
  const scenario = {
    // newest first, as GitHub sorts them
    pulls: [pr(30, "task/12-open", t(2), null, "open"), pr(29, "chore/not-a-task", t(3), t(1)),
      pr(28, "task/11-merged", t(10), t(4)), pr(20, "task/9-old", t(24 * 20), t(24 * 19))],
    comments: {
      "11": [{ body: "<!-- factory-claim agent=taytu -->", created_at: t(14) }],
      "12": [{ body: "<!-- factory-claim agent=menelik -->", created_at: t(3) }],
      "28": [{ body: "<!-- factory-mustfix --> fix it", created_at: t(8) }, { body: "<!-- factory-mustfix --> and this", created_at: t(6) },
        { body: "<!-- factory-approved sha=abc -->", created_at: t(5) }],
    },
    runs: { "task/11-merged": [{ conclusion: "failure" }, { conclusion: "success" }, { conclusion: "success" }],
      "task/12-open": [{ conclusion: null }] },
  };
  write(join(root, "scenario.json"), JSON.stringify(scenario));
  return [d, envWith(join(root, "bin"), { REPORT_SCENARIO: join(root, "scenario.json"), CLAUDE_PROJECT_DIR: undefined })];
}

function report(d: string, env: Record<string, string | undefined>, ...args: string[]): Proc {
  return sh(["bash", join(SF, "factory"), "report", ...args], { cwd: d, env });
}

type Row = Record<string, unknown>;

function rowsOf(p: Proc): Map<number, Row> {
  return new Map(((JSON.parse(p.stdout) as { tasks: Row[] }).tasks).map((r) => [r.pr as number, r]));
}

test("each task pr gets its timings rework and ci runs", () => {
  const [d, env] = setup({ tasks: { source: "issues" } });
  const p = report(d, env, "--json");
  expect(p.code, p.out).toBe(0);
  const rows = rowsOf(p);
  expect([...rows.keys()].sort()).toEqual([28, 30]); // not the chore branch, not the PR from 20 days ago
  const r = rows.get(28) as Row;
  expect([r.task, r.agent, r.state]).toEqual(["11", "taytu", "merged"]);
  expect([r.claimToPr, r.prToMerge, r.claimToMerge]).toEqual([4.0, 6.0, 10.0]);
  expect([r.rework, r.ciRuns, r.ciFailed]).toEqual([2, 3, 1]);
  const open = rows.get(30) as Row;
  expect([open.state, open.prToMerge, open.claimToPr]).toEqual(["open", 2.0, 1.0]);
});

test("the text view and a longer window", () => {
  const [d, env] = setup({ tasks: { source: "issues" } });
  let p = report(d, env);
  for (const w of ["#28", "3 (1 failed)", "so far"]) expect(p.stdout).toContain(w);
  expect(p.stdout).toContain("Median PR->merge 6.0h, claim->merge 10.0h");
  p = report(d, env, "--since", "30d", "--json");
  expect([...rowsOf(p).keys()].sort()).toEqual([20, 28, 30]);
});

test("plan mode has no claim times", () => {
  const [d, env] = setup({});
  const r = rowsOf(report(d, env, "--json")).get(28) as Row;
  expect(r.claimToPr).toBeNull();
  expect(r.prToMerge).toBe(6.0);
});

test("the report reads claims with a machine", () => {
  // (from test_machines.py, #45)
  const m = CLAIM.exec("<!-- factory-claim agent=menelik machine=mach-a -->");
  expect(m?.[1]).toBe("menelik");
});
