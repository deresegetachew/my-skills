#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// Token budgets per task (#183). A budget is advisory: it is shown and compared, and warns at 80%, but nothing stops.
//
// What counts: fresh input (input + cache writes) + output, as `factory usage` reports them. Cache reads are not
// counted (they are cheap and grow with every turn), and there is no money: prices differ per model.
//
// Where a budget comes from, first match wins:
//   1. the budget the claim recorded (`<!-- factory-budget tokens=N|none -->` in the winning claim comment since the
//      last release): the issue's `Budget:` line as it was when the task was claimed, so a later edit doesn't move it;
//   2. no record (a claim from an older kit, or plan mode): the issue's `Budget:` line now (the PR gate keeps a coding
//      agent from changing it);
//   3. `budget.builder` in .claude/factory.json, as main has it;
//   4. none: nothing is compared.
//
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_budget.ts prompt issue-42
//       -> the line the loop adds to the task's first prompt, or nothing when the task has no budget. Exit 0.
import { branchTask, type Config, load, taskSource } from "./factory_config.ts";
import { run, runMain, splitLines } from "./factory_lib.ts";
import { CLAIM, RELEASE } from "./factory_issues.ts";

export const COUNTED = "fresh input (input + cache writes) + output";
export const WARN_PERCENT = 80;
const LINE = /^\s*(?:[-*]\s+)?(?:\*\*)?budget(?:\*\*)?\s*:\s*(?:\*\*)?\s*([0-9][0-9,_]*(?:\.[0-9]+)?)\s*([km])?(?![\w.])/i;
const MARK = /<!--\s*factory-budget\s+tokens=(\d+|none)\s*-->/;

/** The tokens a task body's `Budget:` line names (300k, 1.2m, 300000, 300,000), or null when there is none. */
export function parseBudget(body: string | null | undefined): number | null {
  for (const line of splitLines(body || "")) {
    const m = LINE.exec(line);
    if (!m) continue;
    const n = Number((m[1] as string).replace(/[,_]/g, ""));
    const unit = (m[2] ?? "").toLowerCase();
    const tokens = Math.round(n * (unit === "m" ? 1_000_000 : unit === "k" ? 1000 : 1));
    return Number.isFinite(tokens) && tokens > 0 ? tokens : null;
  }
  return null;
}

/** 300000 -> "300k", 1200000 -> "1.2m", 950 -> "950". */
export function short(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${Number((n / 1_000_000).toFixed(1))}m`;
  if (Math.abs(n) >= 1000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
}

/** The lines a claim comment adds: the budget the issue has now, recorded so a later edit doesn't change it. */
export function claimRecord(body: string | null | undefined): string {
  const b = parseBudget(body);
  if (b === null) return "<!-- factory-budget tokens=none -->";
  return `<!-- factory-budget tokens=${b} -->\nBudget: ${short(b)} tokens, counting ${COUNTED} as \`factory usage\` reports them.`;
}

/** What the winning claim since the last release recorded: tokens, "none", or undefined when it recorded nothing. */
export function recorded(comments: { body?: string | null }[]): number | "none" | undefined {
  let first: string | null = null;
  for (const c of comments) {
    const body = c.body || "";
    if (RELEASE.test(body)) first = null;
    if (first === null && CLAIM.test(body)) first = body;
  }
  const m = first === null ? null : MARK.exec(first);
  if (!m) return undefined;
  return m[1] === "none" ? "none" : Number(m[1]);
}

/** `gh api <path>` parsed, or null on any failure: a budget is advice, so a lookup never stops anything. */
function ghRead(path: string): unknown {
  const p = run(["gh", "api", path]);
  if (p.code !== 0 || !p.stdout.trim()) return null;
  try {
    return JSON.parse(p.stdout.replace(/\]\s*\[/g, ","));
  } catch {
    return null;
  }
}

function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** `budget.builder` as main has it (an agent's own copy of factory.json could say anything), else this copy's. */
export function roleDefault(cfg: Config): number | null {
  let data: unknown = cfg;
  const p = run(["git", "show", `origin/${cfg.mainBranch}:.claude/factory.json`]);
  if (p.code === 0) {
    try {
      data = JSON.parse(p.stdout);
    } catch {
      // a broken file on main: this copy's value
    }
  }
  const v = obj(obj(data).budget).builder;
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

export interface Budget {
  tokens: number | null;
  /** Where it came from, for people: "the issue when it was claimed", "budget.builder in .claude/factory.json" ... */
  source: string;
}

/** The budget of task `task` (an issue number in issues mode, a plan id otherwise). */
export function taskBudget(cfg: Config, task: string): Budget {
  const n = /^#?(\d+)(?:[.-]\d+)*$/.exec(task.trim())?.[1];
  if (n && taskSource(cfg) === "issues") {
    const comments = ghRead(`repos/{owner}/{repo}/issues/${n}/comments?per_page=100`);
    const rec = recorded(Array.isArray(comments) ? comments.map(obj) as { body?: string }[] : []);
    if (typeof rec === "number") return { tokens: rec, source: "the issue's Budget line when the task was claimed" };
    if (rec === undefined) {
      const b = parseBudget(String(obj(ghRead(`repos/{owner}/{repo}/issues/${n}`)).body ?? ""));
      if (b !== null) return { tokens: b, source: "the issue's Budget line" };
    }
  }
  const d = roleDefault(cfg);
  if (d !== null) return { tokens: d, source: "budget.builder in .claude/factory.json" };
  return { tokens: null, source: "" };
}

/** The task a loop id names: issue-42 -> 42, pr-42 -> the task of that PR's branch, 1.3 -> 1.3. */
function taskOf(id: string): string | null {
  const pr = /^pr-(\d+)$/.exec(id);
  if (pr) return branchTask(String(obj(obj(ghRead(`repos/{owner}/{repo}/pulls/${pr[1]}`)).head).ref ?? ""));
  return id.replace(/^issue-/, "") || null;
}

/** The line the loop adds to a task's first prompt, or "" when it has no budget. */
export function promptLine(cfg: Config, id: string): string {
  const task = taskOf(id);
  if (!task) return "";
  const b = taskBudget(cfg, task);
  if (b.tokens === null) return "";
  return `Budget for this task: ${short(b.tokens)} tokens, counting ${COUNTED} as \`factory usage\` reports them ` +
    `(cache reads are not counted; from ${b.source}). Plan to fit it: after reading the brief, write a short plan with a ` +
    `rough estimate, and check with \`factory usage --task ${task} --budget\` at the checkpoints the next-task skill names. ` +
    "It is advisory: nothing stops at the limit, and at 80% you wrap up or ask.";
}

function main(argv: string[]): number {
  if (argv[0] !== "prompt" || !argv[1]) {
    process.stderr.write("usage: factory_budget.ts prompt <task id>\n");
    return 2;
  }
  const line = promptLine(load(), argv[1]);
  if (line) console.log(line);
  return 0;
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
