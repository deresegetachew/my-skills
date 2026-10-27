#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// `factory report`: how long each task took and how often it went round, from GitHub (#65). The tokens are in
// `factory usage`, from this machine's logs; this is the part GitHub knows, the same on every machine.
//
// Per task pull request (branch task/<id>-...) opened since the cut-off:
//   claim -> PR     issues mode: from the agent's last claim comment on the issue before the PR opened
//   PR -> merge     from opening the PR to merging it (open: so far; closed unmerged: "closed")
//   rework          the dev manager's must-fix comments on the PR (each one is a round of rework)
//   CI runs         workflow runs on the PR's branch, and how many of them failed
//
//   factory report                  the last 7 days
//   factory report --since 2026-10-20
//   factory report --json           the same as JSON
//
// Reads only, through `gh api`.
import { branchTask, load, taskSource } from "./factory_config.ts";
import { die, parseArgs, parseIso, pyDumps, pyQuote, run, runMain } from "./factory_lib.ts";
import { verdicts } from "./factory_messages.ts";

export const CLAIM = /<!--\s*factory-claim\s+agent=([\w.-]+)(?:\s+machine=[\w-]+)?\s*-->/;

type Obj = { [key: string]: unknown };

function obj(v: unknown): Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {};
}

function list(v: unknown): Obj[] {
  return Array.isArray(v) ? v.map(obj) : [];
}

function gh(path: string): unknown {
  const p = run(["gh", "api", path]);
  if (p.code !== 0) die(`factory report: gh api ${path.split("?")[0]} failed: ${(p.stderr || p.stdout).trim().slice(0, 200)}`);
  return p.stdout.trim() ? (JSON.parse(p.stdout) as unknown) : null;
}

function when(s: unknown): number | null {
  return typeof s === "string" && s ? parseIso(s) : null;
}

/** Hours between two times, to one decimal; null when either is missing. */
function hours(a: number | null, b: number | null): number | null {
  return a !== null && b !== null ? Math.round(((b - a) / 3600) * 10) / 10 : null;
}

/** Python's str() of a float: 6 -> "6.0". */
export function pyFloat(x: number): string {
  return Number.isInteger(x) ? `${x}.0` : String(x);
}

export interface ReportRow {
  task: string;
  pr: number;
  agent: string | null;
  state: string;
  claimToPr: number | null;
  prToMerge: number | null;
  claimToMerge: number | null;
  rework: number;
  ciRuns: number;
  ciFailed: number;
}

/** Task PRs opened at or after `cut`, newest first (the list is sorted by creation, so stop at the first older). */
function pullsSince(cut: number): Obj[] {
  const out: Obj[] = [];
  for (let page = 1; ; page++) {
    const chunk = list(gh(`repos/{owner}/{repo}/pulls?state=all&sort=created&direction=desc&per_page=100&page=${page}`));
    for (const p of chunk) {
      if ((when(p.created_at) as number) < cut) return out;
      if (branchTask(String(obj(p.head).ref))) out.push(p);
    }
    if (chunk.length < 100) return out;
  }
}

function row(p: Obj, issuesMode: boolean, now: number): ReportRow {
  const branch = String(obj(p.head).ref);
  const opened = when(p.created_at) as number;
  const tid = branchTask(branch) as string;
  let claimed: number | null = null;
  let agent: string | null = null;
  if (issuesMode) {
    for (const c of list(gh(`repos/{owner}/{repo}/issues/${tid.split(".")[0]}/comments?per_page=100`))) {
      const m = CLAIM.exec(typeof c.body === "string" ? c.body : "");
      const at = when(c.created_at);
      if (m && at !== null && at <= opened) {
        claimed = at;
        agent = m[1] as string;
      }
    }
  }
  const comments = list(gh(`repos/{owner}/{repo}/issues/${String(p.number)}/comments?per_page=100`));
  const runs = list(obj(gh(`repos/{owner}/{repo}/actions/runs?branch=${pyQuote(branch)}&per_page=100`)).workflow_runs);
  const merged = when(p.merged_at);
  const state = merged !== null ? "merged" : p.state === "closed" ? "closed" : "open";
  return {
    task: tid, pr: Number(p.number), agent, state,
    claimToPr: hours(claimed, opened),
    prToMerge: merged !== null ? hours(opened, merged) : state === "open" ? hours(opened, now) : null,
    claimToMerge: hours(claimed, merged),
    rework: comments.filter((c) => verdicts(typeof c.body === "string" ? c.body : "").some(([k]) => k === "mustfix")).length,
    ciRuns: runs.length, ciFailed: runs.filter((r) => r.conclusion === "failure").length,
  };
}

function cell(v: number | null, unit = "h"): string {
  return v === null ? "-" : `${pyFloat(v)}${unit}`;
}

/** statistics.median: the middle value, or the mean of the two middle ones. */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? (s[(n - 1) / 2] as number) : ((s[n / 2 - 1] as number) + (s[n / 2] as number)) / 2;
}

function day(t: number): string {
  return new Date(t * 1000).toISOString().slice(0, 10);
}

function show(rows: ReportRow[], cut: number): void {
  console.log(`Task pull requests opened since ${day(cut)}: ${rows.length}`);
  if (!rows.length) return;
  console.log(`${"task".padEnd(8)} ${"PR".padEnd(6)} ${"state".padEnd(7)} ${"claim->PR".padStart(10)} ${"PR->merge".padStart(13)} ` +
    `${"rework".padStart(7)} ${"CI runs".padStart(14)}  agent`);
  for (const r of rows) {
    const merge = cell(r.prToMerge) + (r.state === "open" ? " so far" : "");
    const ci = String(r.ciRuns) + (r.ciFailed ? ` (${r.ciFailed} failed)` : "");
    console.log(`${r.task.padEnd(8)} #${String(r.pr).padEnd(5)} ${r.state.padEnd(7)} ${cell(r.claimToPr).padStart(10)} ` +
      `${merge.padStart(13)} ${String(r.rework).padStart(7)} ${ci.padStart(14)}  ${r.agent || "-"}`);
  }
  const done = rows.filter((r) => r.state === "merged");
  if (done.length) {
    const med = (k: "prToMerge" | "claimToMerge"): string => {
      const xs = done.map((r) => r[k]).filter((x): x is number => x !== null);
      return xs.length ? pyFloat(median(xs)) : "0"; // Python: median([0]), an int
    };
    const sum = (k: "rework" | "ciRuns" | "ciFailed"): number => done.reduce((a, r) => a + r[k], 0);
    console.log(`Merged: ${done.length}. Median PR->merge ${med("prToMerge")}h` +
      (done.some((r) => r.claimToMerge !== null) ? `, claim->merge ${med("claimToMerge")}h` : "") +
      `. Rework rounds ${sum("rework")}, CI runs ${sum("ciRuns")} (${sum("ciFailed")} failed).`);
  }
}

const PROG = "factory_report.ts";
const USAGE = `usage: ${PROG} [-h] [--since SINCE] [--json]`;

export function main(argv: string[]): number {
  const a = parseArgs(argv, { valued: ["--since"], flags: ["--json"] }, PROG, USAGE);
  const since = (a.since as string | undefined) ?? "7d";
  const cfg = load();
  const now = Date.now() / 1000;
  const m = /^(\d+)d$/.exec(since);
  let cut: number;
  if (m) cut = now - Number(m[1]) * 86400;
  else {
    const t = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/.test(since) ? parseIso(since.replace(" ", "T").length === 10 ? since + "T00:00:00Z" : since.replace(" ", "T") + "Z") : null;
    if (t === null) die(`Invalid isoformat string: '${since}'`);
    cut = t;
  }
  const issuesMode = taskSource(cfg) === "issues";
  const rows = pullsSince(cut).map((p) => row(p, issuesMode, now));
  if (a.json) console.log(pyDumps({ since: day(cut), tasks: rows }, { indent: 2 }));
  else show(rows, cut);
  return 0;
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
