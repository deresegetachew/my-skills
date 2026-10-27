#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// `factory ci log <pr or run>`: why did my CI fail? Prints the failed job's log, trimmed to the failing step (#206).
//
// Read-only: it only GETs through `gh api`, so it needs none of the writes the deny rules keep out. The argument is a
// pull request number or a workflow run id; a number that is not a pull request is tried as a run.
//
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_ci_log.ts <pr or run>
//
// No failed job: one line saying so (exit 0). Not found or unreadable: `{code, message, fix}` on stderr (exit 1).
import { pyDumps, run, runMain, splitLines } from "./factory_lib.ts";

const UNSUCCESSFUL = new Set(["failure", "startup_failure", "timed_out", "cancelled", "action_required", "stale"]);
const STAMP = /^\d{4}-\d\d-\d\dT[\d:.]+Z ?/;
const MAX_LINES = 80;

type Row = { [key: string]: unknown };

function isRow(v: unknown): v is Row {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The JSON at a path; null when gh fails. */
function gh(path: string): unknown {
  const p = run(["gh", "api", path]);
  if (p.code !== 0) return null;
  try {
    return JSON.parse(p.stdout) as unknown;
  } catch {
    return null;
  }
}

/** The text at a path; null when gh fails. */
function ghText(path: string): string | null {
  const p = run(["gh", "api", path]);
  return p.code === 0 ? p.stdout : null;
}

function fail(code: string, message: string, fix: string): number {
  process.stderr.write(pyDumps({ code, message, fix }) + "\n");
  return 1;
}

/** [label, failed jobs] for a pull request, else for a run; [null, null] when it is neither. */
function failedJobs(n: string): [string, Row[]] | [null, null] {
  const pr = gh(`repos/{owner}/{repo}/pulls/${n}`);
  const head = isRow(pr) && isRow(pr.head) ? pr.head : {};
  if (head.sha) {
    const sha = String(head.sha);
    const data = gh(`repos/{owner}/{repo}/commits/${sha}/check-runs?per_page=100`);
    const runs = isRow(data) && Array.isArray(data.check_runs) ? (data.check_runs as Row[]) : [];
    const bad = runs.filter((r) => UNSUCCESSFUL.has(String(r.conclusion)));
    const jobs = bad.map((r) => {
      const j = gh(`repos/{owner}/{repo}/actions/jobs/${String(r.id)}`);
      return isRow(j) && Object.keys(j).length ? j : r;
    });
    return [`PR #${n} (${sha.slice(0, 7)})`, jobs];
  }
  const data = gh(`repos/{owner}/{repo}/actions/runs/${n}/jobs?per_page=100`);
  if (isRow(data) && "jobs" in data) {
    return [`run ${n}`, (Array.isArray(data.jobs) ? (data.jobs as Row[]) : []).filter((j) => UNSUCCESSFUL.has(String(j.conclusion)))];
  }
  return [null, null];
}

/** The log lines of the failing step: from the last group start before the first error to the error line. */
export function trim(log: string): string[] {
  const lines = splitLines(log).map((l) => l.replace(STAMP, ""));
  const err = lines.findIndex((l) => l.startsWith("##[error]"));
  if (err < 0) return lines.slice(-MAX_LINES);
  const groups = lines.slice(0, err).map((l, i) => (l.startsWith("##[group]") ? i : -1)).filter((i) => i >= 0);
  const start = groups.length ? Math.max(...groups) : Math.max(0, err - MAX_LINES);
  const chunk = lines.slice(start, Math.min(lines.length, err + 1));
  return chunk.slice(-MAX_LINES);
}

function main(argv: string[]): number {
  if (argv.length !== 1 || !/^\d+$/.test(argv[0] as string)) {
    return fail("usage", "factory ci log needs a pull request number or a run id.", "Run `factory ci log 123`.");
  }
  const n = argv[0] as string;
  const [label, jobs] = failedJobs(n);
  if (label === null) {
    return fail("ci-not-found", `${n} is not a pull request or a workflow run here (or gh could not read it).`,
      "Check the number with `gh pr list` or `factory ci status`, then run `factory ci log <number>` again.");
  }
  if (!jobs.length) {
    console.log(`${label}: No failed job found. CI passed, is still running, or has not started.`);
    return 0;
  }
  for (const job of jobs) {
    const steps = Array.isArray(job.steps) ? (job.steps as Row[]) : [];
    const step = steps.find((s) => UNSUCCESSFUL.has(String(s.conclusion)));
    const name = job.name === undefined || job.name === null ? "None" : String(job.name);
    console.log(`${label}: job ${name}` + (step ? `, failed step ${String(step.number ?? "None")}: ${String(step.name ?? "None")}` : ""));
    const log = ghText(`repos/{owner}/{repo}/actions/jobs/${String(job.id)}/logs`);
    if (log === null) {
      console.log("  (no log to read: GitHub gave none, perhaps because the job never started; see `factory ci status`)");
      continue;
    }
    console.log(trim(log).join("\n"));
    console.log();
  }
  return 0;
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
