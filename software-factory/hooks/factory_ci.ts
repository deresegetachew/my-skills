#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// Tells a CI failure from CI that never ran.
//
// When GitHub can't start a job (the account's Actions minutes or spending limit, a failed payment), every job ends
// at once as a failure, with no steps and an annotation such as "The job was not started because recent account
// payments have failed or your spending limit needs to be increased". That says nothing about the code: pushing
// again or re-running CI only adds more failed runs. Only a person (billing) can fix it.
//
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_ci.ts <commit>     prints why CI didn't run and exits 3; exits 0 when it did run
import { die, run, runMain } from "./factory_lib.ts";

// Only GitHub's own wording: a real test named "billing" that fails must still count as a failure.
const NOT_STARTED = /\bjob was not started\b|\bspending limit needs to be increased\b/i;
export const MESSAGE = "CI didn't run on this commit: GitHub didn't start the jobs ({why}). That isn't a result about your code, " +
  "so don't change code, push again or re-run CI to chase it. A person has to fix the account (Settings > " +
  "Billing and plans). Leave the pull request open, say so on it once, and carry on with the next task; " +
  "the dev manager re-runs CI when it works again.";

/** MESSAGE with the reason filled in. */
export function message(why: string): string {
  return MESSAGE.replace("{why}", why);
}

export const UNSUCCESSFUL = new Set(["failure", "startup_failure", "timed_out", "cancelled", "action_required", "stale"]);

type Row = { [key: string]: unknown };

function isRow(v: unknown): v is Row {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function ghJson(path: string): unknown {
  const p = run(["gh", "api", path]);
  if (p.code !== 0) return null;
  try {
    return JSON.parse(p.stdout) as unknown;
  } catch {
    return null;
  }
}

function rows(v: unknown): Row[] {
  return Array.isArray(v) ? (v as Row[]) : [];
}

function count(data: Row, items: unknown[]): number {
  return "total_count" in data ? Number(data.total_count) : items.length;
}

/** The annotation's text when every unsuccessful check run on the commit never started, else null. Anything it
 * can't see in full (more runs or annotations than one page) counts as a real result, the safe side. */
export function notStarted(sha: string): string | null {
  const data = ghJson(`repos/{owner}/{repo}/commits/${sha}/check-runs?per_page=100`);
  if (!isRow(data)) return null;
  const runs = rows(data.check_runs ?? []);
  if (count(data, runs) > runs.length) return null;
  const bad = runs.filter((r) => UNSUCCESSFUL.has(String(r.conclusion)));
  if (!bad.length) return null;
  // Commit statuses (other CI services) are part of `gh pr checks` too, and one that failed is a real result.
  const status = ghJson(`repos/{owner}/{repo}/commits/${sha}/status?per_page=100`);
  if (!isRow(status)) return null;
  const statuses = rows(status.statuses ?? []);
  if (count(status, statuses) > statuses.length) return null;
  if (statuses.some((st) => st.state === "failure" || st.state === "error")) return null;
  let why: string | null = null;
  for (const r of bad) {
    const notes = ghJson(`repos/{owner}/{repo}/check-runs/${String(r.id)}/annotations?per_page=100`);
    if (!Array.isArray(notes)) return null;
    const hit = (notes as Row[]).map((n) => String(n.message ?? "")).find((m) => NOT_STARTED.test(m));
    if (!hit) return null; // this job ran (or ended some other way): a real result
    why = why || hit;
  }
  return (why as string).trim().replace(/\.+$/, "");
}

function main(argv: string[]): number {
  if (argv.length !== 1) die("usage: factory_ci.ts <commit>");
  const why = notStarted(argv[0] as string);
  if (why) {
    console.log(message(why));
    return 3;
  }
  return 0;
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
