#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// Prints the next build-plan task: the first unticked task, in order, that isn't in the blocked list.
//
//   bun --no-env-file --config=/dev/null .claude/hooks/next_task.ts           -> "1.3 Validators"   (exit 1 when nothing is left)
//   bun --no-env-file --config=/dev/null .claude/hooks/next_task.ts --json    -> {"id": "1.3", "title": "Validators", "remaining": 7, ...}
//   bun --no-env-file --config=/dev/null .claude/hooks/next_task.ts --after 1.3   -> the next one after 1.3 (to work around a blocked PR)
//   Rework comes first: an open PR whose latest must-fix (`<!-- factory-mustfix sha=<head> -->` or a `factory-msg` of kind
//   mustfix) from the dev manager names its current head commit (nothing pushed since) is printed as
//   "pr-42 Rework #42: <title> (<branch>)". With `trustedReviewers` set, only must-fixes from those logins count.
//   A PR with the `holdLabel` label (default `factory-hold`) is the dev manager's to review: it's never rework.
//   bun --no-env-file --config=/dev/null .claude/hooks/next_task.ts --note    -> what `factory next` runs: the same line, then "Not claimed. To claim it: ..."
//   bun --no-env-file --config=/dev/null .claude/hooks/next_task.ts --claim taytu --pid 123
//       -> the first task no other running loop holds, claimed for taytu (factory-loop.sh does this; see
//          factory_claims.ts). Exit 1 when every open task is done, blocked or held by another loop.
//
//   bun --no-env-file --config=/dev/null .claude/hooks/next_task.ts --claim taytu --issue 42
//       -> issues mode: claim issue #42 for taytu, only that one, when it is free and its dependencies are done.
//          Taken, blocked or missing: prints {code, message, fix} on stderr, exit 1, nothing changed. This is how a dev
//          manager hands a builder a named task.
//
// Issues mode (`tasks.source: "issues"`): tasks are GitHub issues (factory_issues.ts). Rework still comes first; then
// the agent's own in-progress issue, else the next `factory:ready` one, claimed on GitHub: "issue-42 <title>".
//
// Reads the plan and blocked list from the main branch when it can (`git show origin/<main>:...`), so a stale
// working copy can't make the agent skip or repeat a task.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { blockedIds, type Config, load, taskSource, tasks } from "./factory_config.ts";
import { staleClaims } from "./factory_agents.ts";
import { claimTask } from "./factory_claims.ts";
import { type Issue, pick, pickNamed, readyIssues } from "./factory_issues.ts";
import { verdicts } from "./factory_messages.ts";
import { bunCmd, Exit, parseArgs, pyDumps, run, runMain } from "./factory_lib.ts";

type Job = [id: string, title: string];

function read(cfg: Config, path: string): string {
  const p = run(["git", "show", `origin/${cfg.mainBranch}:${path}`]);
  if (p.code === 0) return p.stdout;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

interface Pull {
  number: number;
  title: string;
  labels?: { name?: string }[];
  head: { sha: string; ref: string };
}

interface Comment {
  body?: string | null;
  user?: { login?: string } | null;
}

/** [[id, title]] for open PRs with a must-fix on their current head commit, oldest first. Needs `gh`. */
function rework(cfg: Config): Job[] {
  const ghAll = <T>(path: string): T[] => {
    const p = run(["gh", "api", "--paginate", path]);
    if (p.code !== 0) return [];
    try {
      return JSON.parse(p.stdout.replace(/\]\[/g, ",")) as T[];
    } catch {
      return [];
    }
  };
  const out: Job[] = [];
  const hold = (cfg.holdLabel as string | undefined) ?? "factory-hold";
  // With `trustedReviewers`, only those logins' must-fixes count, so an agent can't send the loops to rework (#260).
  const trusted = new Set(Array.isArray(cfg.trustedReviewers) ? (cfg.trustedReviewers as unknown[]).map(String) : []);
  const prs = ghAll<Pull>("repos/{owner}/{repo}/pulls?state=open&per_page=100").sort((a, b) => a.number - b.number);
  for (const pr of prs) {
    if ((pr.labels ?? []).some((l) => l.name === hold)) continue; // the dev manager is reviewing it: not rework
    const shas = ghAll<Comment>(`repos/{owner}/{repo}/issues/${pr.number}/comments?per_page=100`)
      .filter((c) => !trusted.size || trusted.has(String(c.user?.login ?? "")))
      .flatMap((c) => verdicts(c.body || "")).filter(([kind, sha]) => kind === "mustfix" && sha).map(([, sha]) => sha as string); // either form
    if (shas.length && pr.head.sha.startsWith(shas[shas.length - 1] as string)) {
      out.push([`pr-${pr.number}`, `Rework #${pr.number}: ${pr.title} (${pr.head.ref})`]);
    }
  }
  return out;
}

interface Args {
  json: boolean;
  after: string | null;
  claim: string | null;
  pid: string | null;
  issue: number | null;
  note: boolean;
  noRework: boolean;
}

const PROG = "next_task.ts";
const USAGE = `usage: ${PROG} [-h] [--json] [--after AFTER] [--claim AGENT] [--pid PID] [--issue N] [--note] [--no-rework]`;

function argError(text: string): never {
  process.stderr.write(`${USAGE}\n${PROG}: error: ${text}\n`);
  throw new Exit(2);
}

function ping(agent: string, n: number): void {
  run([...bunCmd(join(import.meta.dir, "factory_agents.ts")), "ping", "--agent", agent, "--status", `working on #${n}`],
    { timeoutMs: 60_000 });
}

function main(argv: string[]): number {
  const p = parseArgs(argv, { valued: ["--after", "--claim", "--pid", "--issue"], flags: ["--json", "--note", "--no-rework"] }, PROG, USAGE);
  let issue: number | null = null;
  if (p.issue !== undefined) {
    if (!/^\s*[+-]?\d+\s*$/.test(p.issue as string)) argError(`argument --issue: invalid int value: '${p.issue}'`);
    issue = Number(p.issue);
  }
  const a: Args = { json: Boolean(p.json), after: (p.after as string | undefined) ?? null, claim: (p.claim as string | undefined) ?? null,
    pid: (p.pid as string | undefined) ?? null, issue, note: Boolean(p.note), noRework: Boolean(p["no-rework"]) };
  if (a.issue && !a.claim) argError("--issue needs --claim AGENT");
  const cfg = load();
  run(["git", "fetch", "-q", "origin", cfg.mainBranch]);
  if (a.issue && taskSource(cfg) !== "issues") argError('--issue works only in issues mode (tasks.source: "issues")');
  if (taskSource(cfg) === "issues") return issuesMode(cfg, a);
  const allTasks = tasks(read(cfg, cfg.plan));
  const blocked = blockedIds(read(cfg, cfg.blocked));
  let openTasks: Job[] = allTasks.filter(([i, done]) => !done && !blocked.has(i)).map(([i, , t]): Job => [i, t]);
  if (a.after) {
    const ids = openTasks.map(([i]) => i);
    if (ids.includes(a.after)) openTasks = openTasks.slice(ids.indexOf(a.after) + 1);
  }
  const remaining = openTasks.length;
  if (!a.noRework && !a.after) openTasks = [...rework(cfg), ...openTasks]; // fixing a reviewed PR comes before new work
  if (a.claim && openTasks.length) {
    const tid = claimTask(openTasks.map(([i]) => i), a.claim, a.pid || process.ppid, cfg);
    openTasks = openTasks.filter(([i]) => i === tid);
  }
  const blockedSorted = [...blocked].sort();
  if (!openTasks.length) {
    console.log(a.json ? pyDumps({ id: null, remaining: 0, blocked: blockedSorted }) : "none");
    return 1;
  }
  const [tid, title] = openTasks[0] as Job;
  if (a.json) console.log(pyDumps({ id: tid, title, remaining, blocked: blockedSorted }));
  else {
    console.log(`${tid} ${title}`);
    note(a);
  }
  return 0;
}

/** `factory next` only looks: say so, and show the command that claims. Other programs read one line, so only --note adds it. */
function note(a: Args): void {
  if (a.note && !a.claim) {
    const who = process.env.FACTORY_AGENT || "<your-agent-name>";
    console.log(`Not claimed. To claim it: bun --no-env-file --config=/dev/null .claude/hooks/next_task.ts --claim ${who} --pid $$`);
  }
}

/** --claim AGENT --issue N: claim exactly that issue, or refuse with {code, message, fix} and change nothing. */
function namedIssue(cfg: Config, a: Args): number {
  const [i, err] = pickNamed(cfg, a.claim as string, a.issue as number);
  if (err) {
    process.stderr.write(pyDumps(err) + "\n");
    return 1;
  }
  ping(a.claim as string, i.number);
  console.log(a.json ? pyDumps({ id: `issue-${i.number}`, title: i.title }) : `issue-${i.number} ${i.title}`);
  return 0;
}

/** On stderr, one line per in-progress issue whose agent is down: `next` skips it, and this says why (#191). */
function sayStaleClaims(cfg: Config): void {
  try {
    for (const [n, name, status] of staleClaims(cfg)) {
      process.stderr.write(`Skipped #${n}: ${name} still holds it and is ${status}. Free it with \`factory issues release ${n}\` ` +
        `(or \`factory agents sweep\` does it once ${name} has been down long enough).\n`);
    }
  } catch {
    // a hint only: never stop the pick for it
  }
}

function issuesMode(cfg: Config, a: Args): number {
  if (a.issue) return namedIssue(cfg, a);
  sayStaleClaims(cfg);
  let jobs = a.noRework ? [] : rework(cfg);
  if (jobs.length && a.claim) {
    const tid = claimTask(jobs.map(([i]) => i), a.claim, a.pid || process.ppid, cfg);
    jobs = jobs.filter(([i]) => i === tid);
  }
  if (!jobs.length) {
    let i: Issue | null;
    if (a.claim) i = pick(cfg, a.claim);
    else i = readyIssues(cfg)[0] ?? null;
    if (i) {
      jobs = [[`issue-${i.number}`, i.title]];
      if (a.claim) ping(a.claim, i.number);
    }
  }
  if (!jobs.length) {
    console.log(a.json ? pyDumps({ id: null, remaining: 0 }) : "none");
    return 1;
  }
  const [tid, title] = jobs[0] as Job;
  console.log(a.json ? pyDumps({ id: tid, title }) : `${tid} ${title}`);
  if (!a.json) note(a);
  return 0;
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
