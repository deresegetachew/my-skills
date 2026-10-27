#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// Judging CI the way the dev manager does (#96): from a commit's check runs, take for each job name only the newest
// run that is not `skipped`; the commit is green only when every one of those succeeded.
//
// A re-run that passed replaces the failed run before it; a skipped job (a path filter, a cancelled duplicate) counts
// for nothing; a job still queued or running is not green yet; a commit with no runs at all is not green (CI may not
// have started). Commit statuses (the older API) are judged the same way by context.
//
//   bun factory_ci_judge.ts <sha>       prints "green", "pending: <jobs>", "failed: <jobs>" or "none"; exit 0 only on green
import { run, runMain } from "./factory_lib.ts";

const DOC = `Judging CI the way the dev manager does (#96): from a commit's check runs, take for each job name only the newest
run that is not \`skipped\`; the commit is green only when every one of those succeeded.

A re-run that passed replaces the failed run before it; a skipped job (a path filter, a cancelled duplicate) counts for
nothing; a job still queued or running is not green yet; a commit with no runs at all is not green (CI may not have
started). Commit statuses (the older API) are judged the same way by context.

  bun factory_ci_judge.ts <sha>       prints "green", "pending: <jobs>", "failed: <jobs>" or "none"; exit 0 only on green
`;

const OK = new Set(["success"]);

export type Verdict = "green" | "pending" | "failed" | "none";
export type Row = { [key: string]: unknown };

/** GitHub could not be read (Python's RuntimeError here). */
export class JudgeError extends Error {}

type Rank = [string, number];

function rankOf(r: Row, a: string, b: string): Rank {
  const t = (r[a] || r[b] || "") as unknown;
  return [String(t), Math.trunc(Number(r.id || 0)) || 0];
}

function greater(x: Rank, y: Rank): boolean {
  return x[0] > y[0] || (x[0] === y[0] && x[1] > y[1]);
}

function sorted(xs: Iterable<string>): string[] {
  return [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** [verdict, job names] from check runs and commit statuses. */
export function judge(runs: readonly Row[], statuses: readonly Row[] = []): [Verdict, string[]] {
  const newest = new Map<string, [Rank, Row]>();
  for (const r of runs) {
    if (r.conclusion === "skipped") continue;
    const key = String(r.name || "");
    const rank = rankOf(r, "started_at", "created_at");
    const have = newest.get(key);
    if (!have || greater(rank, have[0])) newest.set(key, [rank, r]);
  }
  const jobs = new Map<string, string>();
  for (const [k, [, v]] of newest) {
    jobs.set(k, v.status !== "completed" ? "pending" : OK.has(String(v.conclusion)) ? "ok" : "failed");
  }
  const latest = new Map<string, [Rank, Row]>();
  for (const s of statuses) {
    const key = String(s.context || "");
    const rank = rankOf(s, "updated_at", "created_at");
    const have = latest.get(key);
    if (!have || greater(rank, have[0])) latest.set(key, [rank, s]);
  }
  for (const [k, [, s]] of latest) {
    jobs.set(k, s.state === "success" ? "ok" : s.state === "pending" ? "pending" : "failed");
  }
  if (!jobs.size) return ["none", []];
  const failed = sorted([...jobs].filter(([, v]) => v === "failed").map(([k]) => k));
  const pending = sorted([...jobs].filter(([, v]) => v === "pending").map(([k]) => k));
  if (failed.length) return ["failed", failed];
  if (pending.length) return ["pending", pending];
  return ["green", sorted(jobs.keys())];
}

/** The JSON documents in a text that holds one or more of them back to back (`gh api --paginate`). */
export function jsonDocuments(text: string): unknown[] {
  const out: unknown[] = [];
  let i = 0;
  while (i < text.length) {
    let depth = 0;
    let inStr = false;
    let j = i;
    for (; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (c === "\\") j++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        depth--;
        if (depth === 0) break;
      } else if (depth === 0 && /\s/.test(c as string)) break;
    }
    out.push(JSON.parse(text.slice(i, j + 1)));
    i = j + 1;
    while (i < text.length && /\s/.test(text[i] as string)) i++;
  }
  return out;
}

function ghJson(path: string): unknown {
  const p = run(["gh", "api", "--paginate", path]);
  if (p.code !== 0) {
    throw new JudgeError((p.stderr || p.stdout).trim().slice(0, 300) || `gh api ${path} failed`);
  }
  const text = p.stdout.trim();
  if (!text) return [];
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return jsonDocuments(text); // --paginate prints one JSON document per page
  }
}

function isRow(v: unknown): v is Row {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function pages(path: string, key: string): Row[] {
  const got = ghJson(path);
  const items: Row[] = [];
  for (const page of Array.isArray(got) ? got : [got]) {
    if (isRow(page)) {
      const v = page[key];
      if (Array.isArray(v)) items.push(...(v as Row[]));
    } else items.push(page as Row);
  }
  return items;
}

/** judge() for a commit on GitHub. Throws JudgeError when GitHub can't be read. */
export function state(sha: string, repo = "repos/{owner}/{repo}"): [Verdict, string[]] {
  const runs = pages(`${repo}/commits/${sha}/check-runs?per_page=100`, "check_runs");
  const statuses = pages(`${repo}/commits/${sha}/status?per_page=100`, "statuses");
  return judge(runs, statuses);
}

export function main(argv: string[]): number {
  if (argv.length !== 1) {
    process.stderr.write(DOC + "\n");
    return 2;
  }
  let verdict: Verdict;
  let jobs: string[];
  try {
    [verdict, jobs] = state(argv[0] as string);
  } catch (e) {
    if (e instanceof JudgeError) {
      console.log(`unknown: ${e.message}`);
      return 1;
    }
    throw e;
  }
  console.log(verdict === "green" ? "green" : jobs.length ? `${verdict}: ${jobs.join(", ")}` : verdict);
  return verdict === "green" ? 0 : 1;
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
