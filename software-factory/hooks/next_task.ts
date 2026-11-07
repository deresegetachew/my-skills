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
//   A rework is claimed on the PR as well as locally (`factory-rework-claim`, factory_claims.ts, #355), so every
//   machine sees it: a PR whose rework another agent holds is skipped (one line on stderr says who holds it).
//   bun --no-env-file --config=/dev/null .claude/hooks/next_task.ts --note    -> what `factory next` runs: the same line, then "Not claimed. To claim it: ..."
//   bun --no-env-file --config=/dev/null .claude/hooks/next_task.ts --claim taytu --pid 123
//       -> the first task no other running loop holds, claimed for taytu (factory-loop.sh does this; see
//          factory_claims.ts). Exit 1 when every open task is done, blocked or held by another loop.
//
//   Inside an agent session the claim comes from the environment, so the command an agent runs is plain text (Claude
//   Code asks before running a command with a shell variable in it, and unattended nobody can answer): with
//   FACTORY_AGENT and FACTORY_PID set (the SessionStart hook writes both), no flags claims as FACTORY_AGENT with pid
//   FACTORY_PID, and `--issue N` claims as FACTORY_AGENT. Explicit --claim and --pid win; --no-claim and --note only look.
//   --dry-run (#520) only looks too, even with --claim: it prints what that agent would take and claims nothing, then
//   says so. With --issue it is refused ({code, message, fix}): `factory issues show N` says what that issue is.
//
//   bun --no-env-file --config=/dev/null .claude/hooks/next_task.ts --claim taytu --issue 42
//       -> issues mode: claim issue #42 for taytu, only that one, when it is free and its dependencies are done.
//          Taken, blocked or missing: prints {code, message, fix} on stderr, exit 1, nothing changed. This is how a dev
//          manager hands a builder a named task.
//
// Issues mode (`tasks.source: "issues"`): tasks are GitHub issues (factory_issues.ts). Rework still comes first; then
// the agent's own in-progress issue, else the next `factory:ready` one, claimed on GitHub: "issue-42 <title>".
//
// Board mode (`tasks.source: "board"`, #500): the same, on the message board; a task is printed by its id (the issue
// number for a task that came from GitHub, b<n> for one filed on the board), and `--issue N` works there too.
//
// A task from a PRD change (a `PRD change: #62` line, or on the board a link to the change's card, #578) is skipped until
// that pull request merges, in every mode: one line on stderr says so ("Skipped #5: it waits for its PRD change, PR #62,
// to merge.").
//
// Reads the plan and blocked list from the main branch when it can (`git show origin/<main>:...`), so a stale
// working copy can't make the agent skip or repeat a task.
//
// The tasks come from the TaskTracker port (core/ports/task_tracker.ts, #377), which compose() picks from
// `tasks.source`: the plan file or GitHub Issues. Rework is a pull request, not a task, so it is read here.
import { join } from "node:path";
import { type Config, load, taskSource, toFloat } from "./factory_config.ts";
import { compose } from "./core/compose.ts";
import { CoreError } from "./core/domain/error.ts";
import { prdSkipNote, type Task } from "./core/domain/task.ts";
import type { TaskTracker } from "./core/ports/task_tracker.ts";
import { staleClaims } from "./factory_agents.ts";
import { claimRework, claimTask, describeRework, isMine, release, reworkHolder } from "./factory_claims.ts";
import type { Comment } from "./factory_issues.ts";
import { claimKey, describeHolder, holderIsMe, leasesOn } from "./factory_leases.ts";
import { machineId } from "./factory_machine.ts";
import { asPull, freshPrs } from "./factory_pr_feed.ts";
import { remember, settled } from "./factory_views_cache.ts";
import { verdicts } from "./factory_messages.ts";
import { bunCmd, Exit, GITHUB_BUSY, parseArgs, pyDumps, run, runMain } from "./factory_lib.ts";

type Job = [id: string, title: string, head?: string];

interface Pull {
  number: number;
  title: string;
  labels?: { name?: string }[];
  head: { sha: string; ref: string };
  updated_at?: string;
}

/** [[id, title, head]] for open PRs with a must-fix on their current head commit, oldest first, leaving out those whose
 * rework another agent holds (#355: a claim on the PR that every machine sees). `me` is the agent picking, if any. Needs
 * `gh`. `cache` (board mode, #515): a pull request's comments are read again only when its updated_at moved, as with the
 * pull request feed, so a look when nothing changed costs one call (the open pull requests), not one more per pull request. */
function rework(cfg: Config, me: string | null, cache = false): Job[] {
  // null when gh fails: a failed read is never kept as "no comments"
  const ghList = <T>(path: string): T[] | null => {
    const p = run(["gh", "api", "--paginate", path]);
    if (p.code !== 0) return null;
    try {
      return JSON.parse(p.stdout.replace(/\]\[/g, ",")) as T[];
    } catch {
      return null;
    }
  };
  const ghAll = <T>(path: string): T[] => ghList<T>(path) ?? [];
  const out: Job[] = [];
  const hold = (cfg.holdLabel as string | undefined) ?? "factory-hold";
  // With `trustedReviewers`, only those logins' must-fixes count, so an agent can't send the loops to rework (#260).
  const trusted = new Set(Array.isArray(cfg.trustedReviewers) ? (cfg.trustedReviewers as unknown[]).map(String) : []);
  const hours = toFloat(cfg.claimStaleHours ?? 6) ?? 6;
  const machine = me ? machineId() : "";
  const bus = leasesOn(cfg);
  // With `pr` on the board, the open pull requests come from the watcher's snapshot, and a pull request's comments are read
  // again only when its updated_at moved (factory_pr_feed.ts). A rework found that way is checked once on GitHub: the
  // snapshot may not have this agent's last push yet.
  const fed = freshPrs(cfg);
  const prs = (fed ? fed.prs.map(asPull) : ghAll<Pull>("repos/{owner}/{repo}/pulls?state=open&per_page=100"))
    .sort((a, b) => a.number - b.number);
  for (const pr of prs) {
    if ((pr.labels ?? []).some((l) => l.name === hold)) continue; // the dev manager is reviewing it: not rework
    const path = `repos/{owner}/{repo}/issues/${pr.number}/comments?per_page=100`;
    const read = (): Comment[] | null => ghList<Comment>(path);
    const comments = (fed || cache ? remember(cfg, `rework-comments-${pr.number}`, settled(pr.updated_at), read, (d) => d !== null) : read()) ?? [];
    const shas = comments.filter((c) => !trusted.size || trusted.has(String(c.user?.login ?? "")))
      .flatMap((c) => verdicts(c.body || "")).filter(([kind, sha]) => kind === "mustfix" && sha).map(([, sha]) => sha as string); // either form
    if (!shas.length || !pr.head.sha.startsWith(shas[shas.length - 1] as string)) continue;
    if (fed) {
      const now = run(["gh", "api", `repos/{owner}/{repo}/pulls/${pr.number}`]);
      let head = "";
      try {
        head = (JSON.parse(now.stdout) as Pull).head.sha;
      } catch {
        head = "";
      }
      if (now.code !== 0 || head !== pr.head.sha) continue; // pushed since, or gone: not rework now
    }
    if (bus) { // claims on the board (#411): the board says who holds the rework
      const holder = bus.holder(claimKey("rework", pr.number));
      if (holder && !(me && holderIsMe(holder, me, machine))) {
        process.stderr.write(`Skipped #${pr.number}: ${describeHolder(holder)} is reworking it.\n`);
        continue;
      }
    } else {
      const held = reworkHolder(comments, pr.head.sha, Date.now() / 1000, hours);
      if (held && !(me && isMine(held, me, machine))) {
        process.stderr.write(`Skipped #${pr.number}: ${describeRework(held)} is reworking it.\n`);
        continue;
      }
    }
    out.push([`pr-${pr.number}`, `Rework #${pr.number}: ${pr.title} (${pr.head.ref})`, pr.head.sha]);
  }
  return out;
}

/** The first of `jobs` this agent may take, claimed: the local claim (factory_claims.ts) and, for a rework, the claim
 * on the PR. A rework lost to another agent, or one GitHub refused to claim, lets its local claim go and the next job is
 * tried; GitHub being busy stops the pick with its code. [] when none is left. */
function claimFirst(cfg: Config, jobs: Job[], agent: string, pid: string | number): Job[] {
  let left = jobs;
  while (left.length) {
    const tid = claimTask(left.map(([i]) => i), agent, pid, cfg);
    const job = left.find(([i]) => i === tid);
    if (!job) return [];
    const [id, , head] = job;
    if (!head || onPr(cfg, id, head, agent)) return [job];
    release(agent, true);
    left = left.filter(([i]) => i !== id);
  }
  return [];
}

/** Claim rework `id` on the PR; false when another agent holds it or GitHub refused the claim. Busy: the local claim
 * is let go and the error stops the pick. */
function onPr(cfg: Config, id: string, head: string, agent: string): boolean {
  try {
    return claimRework(cfg, Number(id.slice(3)), head, agent);
  } catch (e) {
    if (!(e instanceof Exit)) throw e;
    if (e.exitCode === GITHUB_BUSY) {
      release(agent, true);
      throw e;
    }
    process.stderr.write(`Skipped #${id.slice(3)}: could not claim its rework on GitHub (${e.message}).\n`);
    return false;
  }
}

interface Args {
  json: boolean;
  after: string | null;
  claim: string | null;
  pid: string | null;
  issue: number | null;
  note: boolean;
  noRework: boolean;
  /** --dry-run: look as `lookAs` (the --claim given), claim nothing. */
  dryRun: boolean;
  lookAs: string | null;
}

const PROG = "next_task.ts";
const USAGE = `usage: ${PROG} [-h] [--json] [--after AFTER] [--claim AGENT] [--pid PID] [--issue N] [--note] [--no-claim] [--no-rework] [--dry-run]`;

function argError(text: string): never {
  process.stderr.write(`${USAGE}\n${PROG}: error: ${text}\n`);
  throw new Exit(2);
}

function ping(agent: string, n: number | string): void {
  const what = /^\d+$/.test(String(n)) ? `#${n}` : String(n);
  run([...bunCmd(join(import.meta.dir, "factory_agents.ts")), "ping", "--agent", agent, "--status", `working on ${what}`],
    { timeoutMs: 60_000 });
}

/** No --claim given: inside an agent session, claim as FACTORY_AGENT. A pick claims only when FACTORY_PID is set too, as
 * the skill's old `${FACTORY_PID:+--claim ...}` did: under factory-loop.sh the loop has claimed already and sets no
 * FACTORY_PID. `--issue N` needs only the name. */
function fromEnv(a: Args): void {
  if (a.claim) return;
  const agent = (process.env.FACTORY_AGENT ?? "").trim();
  const pid = (process.env.FACTORY_PID ?? "").trim();
  if (!agent) return;
  if (a.issue) a.claim = agent;
  else if (pid) {
    a.claim = agent;
    a.pid ??= pid;
  }
}

function main(argv: string[]): number {
  const p = parseArgs(argv, { valued: ["--after", "--claim", "--pid", "--issue"], flags: ["--json", "--note", "--no-claim", "--no-rework", "--dry-run"] },
    PROG, USAGE);
  let issue: number | null = null;
  if (p.issue !== undefined) {
    if (!/^\s*[+-]?\d+\s*$/.test(p.issue as string)) argError(`argument --issue: invalid int value: '${p.issue}'`);
    issue = Number(p.issue);
  }
  const a: Args = { json: Boolean(p.json), after: (p.after as string | undefined) ?? null, claim: (p.claim as string | undefined) ?? null,
    pid: (p.pid as string | undefined) ?? null, issue, note: Boolean(p.note), noRework: Boolean(p["no-rework"]),
    dryRun: Boolean(p["dry-run"]), lookAs: null };
  if (a.dryRun) {
    if (a.issue !== null) {
      process.stderr.write(pyDumps({ code: "dry_run_issue", message: `--dry-run looks at what would be taken next; it can't try a claim of issue #${a.issue}.`,
        fix: `Run \`factory issues show ${a.issue}\` to see that issue, or drop --issue to see what would be taken next. Nothing was claimed.` }) + "\n");
      return 1;
    }
    a.lookAs = a.claim; // what that agent would take, without claiming it
    a.claim = null;
    a.pid = null;
  } else if (!p["no-claim"] && !a.note) fromEnv(a);
  if (a.issue && !a.claim) argError("--issue needs --claim AGENT");
  const cfg = load();
  run(["git", "fetch", "-q", "origin", cfg.mainBranch]);
  if (a.issue && !["issues", "board"].includes(taskSource(cfg))) argError('--issue works only with tasks.source "issues" or "board"');
  const tracker = compose(cfg).tasks;
  if (taskSource(cfg) === "issues") return issuesMode(cfg, tracker, a);
  if (taskSource(cfg) === "board") return boardMode(cfg, tracker, a);
  // Plan mode claims through the local claims file below, together with any rework, so only the list comes from the port.
  const listed = tracker.list();
  const blocked = new Set(listed.filter((t) => t.state === "blocked").map((t) => t.id));
  const free = listed.filter((t) => t.state !== "blocked" && !waits(t, listed));
  sayPrdSkips(free);
  let openTasks: Job[] = free.filter((t) => !(t.state === "ready" && t.waitsForPrd)).map((t): Job => [t.id, t.title]);
  if (a.after) {
    const ids = openTasks.map(([i]) => i);
    if (ids.includes(a.after)) openTasks = openTasks.slice(ids.indexOf(a.after) + 1);
  }
  const remaining = openTasks.length;
  if (!a.noRework && !a.after) openTasks = [...rework(cfg, me(a)), ...openTasks]; // fixing a reviewed PR comes before new work
  if (a.claim && openTasks.length) openTasks = claimFirst(cfg, openTasks, a.claim, a.pid || process.ppid);
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

/** Whose own rework claim doesn't hold a PR back: the agent claiming, else (`factory next` only looks) FACTORY_AGENT. */
function me(a: Args): string | null {
  return a.claim || a.lookAs || (process.env.FACTORY_AGENT ?? "").trim() || null;
}

/** `factory next` only looks: say so, and show the command that claims. Other programs read one line, so only --note adds it. */
function note(a: Args): void {
  if (a.dryRun) {
    console.log("Dry run: nothing was claimed.");
    return;
  }
  if (a.note && !a.claim) {
    const who = process.env.FACTORY_AGENT || "<your-agent-name>";
    console.log(`Not claimed. To claim it: bun --no-env-file --config=/dev/null .claude/hooks/next_task.ts --claim ${who} --pid $$`);
  }
}

/** Whether a plan task waits for another one that isn't done (`Depends on 1.2` in its text). */
function waits(t: Task, open: Task[]): boolean {
  return t.dependsOn.some((d) => open.some((x) => x.id === d));
}

/** On stderr, one line per ready task in `tasks` held back for its PRD change (#578). */
function sayPrdSkips(tasks: Task[]): void {
  const note = prdSkipNote(tasks.filter((t) => t.state === "ready" && t.waitsForPrd)
    .map((t) => ({ name: /^\d+$/.test(t.id) ? `#${t.id}` : t.id, pr: t.waitsForPrd as string })));
  if (note) process.stderr.write(note + "\n");
}

/** `factory next` only looks (`next()`), which says nothing of what it passed over: the open tasks' list does (#578). */
function lookAndSay(tracker: TaskTracker): Task | null {
  const t = tracker.next();
  sayPrdSkips(tracker.list());
  return t;
}

/** --claim AGENT --issue N: claim exactly that issue, or refuse with {code, message, fix} and change nothing. */
function namedIssue(tracker: TaskTracker, a: Args): number {
  let t: Task;
  try {
    t = tracker.claim(String(a.issue), { agent: a.claim as string, machine: machineId() });
  } catch (e) {
    if (!(e instanceof CoreError)) throw e;
    process.stderr.write(pyDumps(e.toJSON()) + "\n");
    return 1;
  }
  ping(a.claim as string, Number(t.id));
  console.log(a.json ? pyDumps({ id: `issue-${t.id}`, title: t.title }) : `issue-${t.id} ${t.title}`);
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

function issuesMode(cfg: Config, tracker: TaskTracker, a: Args): number {
  if (a.issue) return namedIssue(tracker, a);
  sayStaleClaims(cfg);
  let jobs = a.noRework ? [] : rework(cfg, me(a));
  if (jobs.length && a.claim) jobs = claimFirst(cfg, jobs, a.claim, a.pid || process.ppid);
  if (!jobs.length) {
    let t: Task | null = null;
    if (a.claim) {
      const picked = tracker.pick({ agent: a.claim, machine: machineId() });
      if (picked.note) process.stderr.write(picked.note + "\n");
      t = picked.task;
    } else t = lookAndSay(tracker);
    if (t) {
      jobs = [[`issue-${t.id}`, t.title]];
      if (a.claim) ping(a.claim, Number(t.id));
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

/** Board mode (`tasks.source: "board"`, #500): the tasks and their claims are the message board's (the TaskTracker
 * port claims there and keeps the token on this machine). Rework, a pull request, still comes first, read from GitHub: the
 * open pull requests in one call, and a pull request's comments only when its updated_at moved since the last look (#515).
 * A task is printed by its id: the issue number for one that came from GitHub, b<n> for one filed on the board. */
function boardMode(cfg: Config, tracker: TaskTracker, a: Args): number {
  let t: Task | null = null;
  try {
    if (a.issue) t = tracker.claim(String(a.issue), { agent: a.claim as string, machine: machineId() });
    else {
      let jobs = a.noRework ? [] : rework(cfg, me(a), true);
      if (jobs.length && a.claim) jobs = claimFirst(cfg, jobs, a.claim, a.pid || process.ppid);
      if (jobs.length) {
        const [tid, title] = jobs[0] as Job;
        console.log(a.json ? pyDumps({ id: tid, title }) : `${tid} ${title}`);
        if (!a.json) note(a);
        return 0;
      }
      if (a.claim) {
        const picked = tracker.pick({ agent: a.claim, machine: machineId() });
        if (picked.note) process.stderr.write(picked.note + "\n");
        t = picked.task;
      } else t = lookAndSay(tracker);
    }
  } catch (e) {
    if (!(e instanceof CoreError)) throw e;
    process.stderr.write(pyDumps(e.toJSON()) + "\n");
    return 1;
  }
  if (!t) {
    console.log(a.json ? pyDumps({ id: null, remaining: 0 }) : "none");
    return 1;
  }
  if (a.claim) ping(a.claim, t.id); // the agent's liveness on the board says what it works on (#513)
  console.log(a.json ? pyDumps({ id: t.id, title: t.title }) : `${t.id} ${t.title}`);
  if (!a.json && !a.issue) note(a);
  return 0;
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
