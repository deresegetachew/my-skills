#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// Token-free waiting. A Claude session that waits by checking again and again pays for every check (each turn
// re-sends the whole context), so every wait is a shell loop here that only returns when there is something to do,
// with one short line. Exit codes: 0 = it happened, 2 = timed out (do other work), 1 = it can't happen (see the line),
// 3 = the PR is closed or merged, 4 = CI never started (billing; see factory_ci.ts).
//
//   factory_wait.ts ci <pr> [minutes]       until every check on the PR's head commit has finished: 0 green, 1 failed
//   factory_wait.ts answer <pr> [minutes]   until every question on the PR (a `factory-msg` question or an old
//                                           `<!-- factory-question -->`) is answered: 0 answered, or 0 at once when the
//                                           addressee asked for more information (input-required: your turn), 1 when
//                                           nothing is waiting
//   factory_wait.ts slot [minutes]          until this account has fewer than `maxOpenPRs` ready PRs open
//   factory_wait.ts ready [minutes]         until a task is ready to take (issues mode): prints "issue-N title"
//   factory_wait.ts precheck                for the dev manager: exit 0 and "nothing to do" when no PR has an unreviewed
//                                           commit, no question addressed to the dev manager waits (on a PR or an issue)
//                                           and no agent went quiet; else exit 3, one line each
//
// Waits default to 30 minutes and look every FACTORY_WAIT_START seconds (default 15), growing by half each time up to
// FACTORY_WAIT_MAX seconds (default 60). Everything goes through the GitHub REST API (`gh api`).
import { type Config, load, taskLabels, toFloat } from "./factory_config.ts";
import { agentIssues, current, stateOf } from "./factory_agents.ts";
import { type Comment, gh, ghAll, type Issue, lastActivity, names, readyIssues, taskIssues, waitingForSlot } from "./factory_issues.ts";
import { DEV_MANAGER, fold, messagesOf, type Task, type Thread, verdicts } from "./factory_messages.ts";
import { notStarted } from "./factory_ci.ts";
import { escalateMinutes, running, waiting } from "./factory_po.ts";
import { die, Exit, now, runMain, sleepSync } from "./factory_lib.ts";

const DOC = `Token-free waiting. A Claude session that waits by checking again and again pays for every check (each turn
re-sends the whole context), so every wait is a shell loop here that only returns when there is something to do,
with one short line. Exit codes: 0 = it happened, 2 = timed out (do other work), 1 = it can't happen (see the line),
3 = the PR is closed or merged, 4 = CI never started (billing; see factory_ci.ts).

  factory_wait.ts ci <pr> [minutes]       until every check on the PR's head commit has finished: 0 green, 1 failed
  factory_wait.ts answer <pr> [minutes]   until every question on the PR (a \`factory-msg\` question or an old
                                          \`<!-- factory-question -->\`) is answered: 0 answered, or 0 at once when the
                                          addressee asked for more information (input-required: your turn), 1 when
                                          nothing is waiting
  factory_wait.ts slot [minutes]          until this account has fewer than \`maxOpenPRs\` ready PRs open
  factory_wait.ts ready [minutes]         until a task is ready to take (issues mode): prints "issue-N title"
  factory_wait.ts precheck                for the dev manager: exit 0 and "nothing to do" when no PR has an unreviewed
                                          commit, no question addressed to the dev manager waits (on a PR or an issue)
                                          and no agent went quiet; else exit 3, one line each

Waits default to 30 minutes and look every FACTORY_WAIT_START seconds (default 15), growing by half each time up to
FACTORY_WAIT_MAX seconds (default 60). Everything goes through the GitHub REST API (\`gh api\`).
`;

export const QUESTION = /<!--\s*factory-question\b/; // the old markers: factory_watch.ts still reads them
export const ANSWER = /<!--\s*factory-answer\b/;
/** A failed review is not retried for the same head (#202). */
export const WATCHED = /<!--\s*(?:pr-watch|factory-review-failed)\s+sha=([0-9a-f]{7,40})/g;
export const BAD = new Set(["failure", "startup_failure", "timed_out", "cancelled", "action_required", "stale"]);

export type Outcome = [code: number, line: string];

export interface Pull {
  number: number;
  state?: string;
  merged?: boolean;
  draft?: boolean;
  user?: { login?: string } | null;
  head: { sha: string; ref?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/** Calls check() with a growing pause until it returns something (not null) or the minutes are up. */
export function waitUntil<T>(check: () => T | null, minutes: number): T | null {
  let delay = toFloat(process.env.FACTORY_WAIT_START ?? 15) ?? 15;
  const cap = toFloat(process.env.FACTORY_WAIT_MAX ?? 60) ?? 60;
  const end = performance.now() / 1000 + minutes * 60;
  for (;;) {
    const got = check();
    if (got !== null) return got;
    if (performance.now() / 1000 + delay > end) return null;
    sleepSync(delay);
    delay = Math.min(delay * 1.5, cap);
  }
}

export function prOf(n: number): Pull {
  return gh<Pull>("GET", `repos/{owner}/{repo}/pulls/${n}`);
}

interface Run {
  name: string;
  status?: string;
  conclusion?: string | null;
}

interface Status {
  context: string;
  state: string;
}

/** ['green' | 'failed' | 'pending', detail] for the commit, from its check runs and commit statuses. */
export function ciState(sha: string): ["green" | "failed" | "pending", string] {
  const runs = gh<{ check_runs?: Run[] }>("GET", `repos/{owner}/{repo}/commits/${sha}/check-runs?per_page=100`)?.check_runs ?? [];
  const st = gh<{ statuses?: Status[] }>("GET", `repos/{owner}/{repo}/commits/${sha}/status?per_page=100`)?.statuses ?? [];
  const bad = [...runs.filter((r) => BAD.has(String(r.conclusion))).map((r) => r.name),
    ...st.filter((s) => s.state === "failure" || s.state === "error").map((s) => s.context)];
  if (bad.length) return ["failed", bad.join(", ")];
  if (!runs.length && !st.length) return ["pending", "no checks yet"];
  const waitingOn = [...runs.filter((r) => r.status !== "completed").map((r) => r.name),
    ...st.filter((s) => s.state === "pending").map((s) => s.context)];
  if (waitingOn.length) return ["pending", waitingOn.join(", ")];
  return ["green", `${runs.length + st.length} checks`];
}

/** Python's str(float) for a minutes argument: 5 -> "5", 30.0 -> "30.0" (as Python printed it). */
function shownMinutes(m: number | string): string {
  return String(m);
}

export function waitCi(n: number, minutes: number | string): Outcome {
  let last = "?";
  const check = (): Outcome | null => {
    const pr = prOf(n);
    if (pr.state !== "open") return [3, `PR #${n} is ${pr.merged ? "merged" : "closed"}`];
    const sha = pr.head.sha;
    const [state, detail] = ciState(sha);
    last = detail;
    if (state === "green") return [0, `PR #${n}: CI green (${detail}) on ${sha.slice(0, 7)}`];
    if (state === "failed") {
      if (notStarted(sha)) {
        return [4, `PR #${n}: CI didn't run on ${sha.slice(0, 7)} (GitHub didn't start the jobs). Run: bun --no-env-file --config=/dev/null .claude/hooks/factory_ci.ts ${sha}`];
      }
      return [1, `PR #${n}: CI failed on ${sha.slice(0, 7)}: ${detail}`];
    }
    return null;
  };
  return waitUntil(check, Number(minutes)) ?? [2, `PR #${n}: CI still running after ${shownMinutes(minutes)} minutes (${last})`];
}

/** The fold (factory_messages.ts) of the comments on issue or PR n. */
export function threadOf(n: number): Thread {
  return fold(messagesOf(ghAll<Comment>(`repos/{owner}/{repo}/issues/${n}/comments`)));
}

/** Open questions still waiting for their addressee (submitted or working), oldest first. */
export function unanswered(thread: Thread, to: string | null = null): Task[] {
  return [...thread.tasks.values()].filter((t) => (t.state === "submitted" || t.state === "working") && (!to || t.to === to));
}

export function asksForMore(n: number, tasks: Task[]): string {
  return `PR #${n}: ${tasks.map((t) => t.id).join(", ")} needs more information from you (input-required). ` +
    `Read it and reply with the same in-reply-to: gh api repos/{owner}/{repo}/issues/${n}/comments`;
}

export function waitAnswer(n: number, minutes: number | string): Outcome {
  const first = threadOf(n);
  if (![...first.tasks.values()].some((t) => t.isOpen)) return [1, `PR #${n}: no question is waiting for an answer`];
  const ask0 = [...first.tasks.values()].filter((t) => t.state === "input-required");
  if (ask0.length && !unanswered(first).length) return [0, asksForMore(n, ask0)];
  const check = (): Outcome | null => {
    const thread = threadOf(n);
    if (unanswered(thread).length) return null;
    const ask = [...thread.tasks.values()].filter((t) => t.state === "input-required");
    return ask.length ? [0, asksForMore(n, ask)]
      : [0, `PR #${n}: answered. Read it: gh api repos/{owner}/{repo}/issues/${n}/comments`];
  };
  return waitUntil(check, Number(minutes)) ?? [2, `PR #${n}: still no answer after ${shownMinutes(minutes)} minutes; carry on with other work`];
}

export function myReadyPrs(): number[] {
  const me = (gh<{ login?: string } | null>("GET", "user") ?? {}).login;
  return ghAll<Pull>("repos/{owner}/{repo}/pulls?state=open")
    .filter((p) => !p.draft && (p.user ?? {}).login === me).map((p) => p.number).sort((a, b) => a - b);
}

export function waitSlot(minutes: number | string, cfg: Config): Outcome {
  const cap = Math.trunc(Number(cfg.maxOpenPRs ?? 3));
  const check = (): Outcome | null => {
    const ready = myReadyPrs();
    return ready.length < cap ? [0, `a PR slot is free (${ready.length} of ${cap} open)`] : null;
  };
  return waitUntil(check, Number(minutes)) ??
    [2, `still ${cap} of ${cap} PRs open after ${shownMinutes(minutes)} minutes: ` + myReadyPrs().map((x) => `#${x}`).join(", ")];
}

export function waitReady(minutes: number | string, cfg: Config): Outcome {
  const check = (): Outcome | null => {
    const found = readyIssues(cfg);
    return found.length ? [0, `issue-${found[0]?.number} ${found[0]?.title}`] : null;
  };
  return waitUntil(check, Number(minutes)) ?? [2, `no task became ready in ${shownMinutes(minutes)} minutes`];
}

/** The questions addressed to the dev manager that wait for its answer, oldest first (a question that asks the
 * asker for more information waits for the asker, not for the dev manager). */
export function waitingTasks(comments: Comment[]): Task[] {
  return unanswered(fold(messagesOf(comments)), DEV_MANAGER);
}

/** [minutes per level, whether a product owner runs, now in seconds since the epoch]. */
export type Escalation = [every: number, poRunning: boolean, now: number];
export type Item = [kind: string, ref: number | string, text: string];

/** What the dev manager has to do right now: [(kind, ref, text)], empty when nothing. Reads GitHub only.
 * kind is review (ref: PR number), question (the PR or issue number), agent (name) or stale (issue number). `prs` and
 * `commentsOf` (a function: number -> its comments) let the orchestrator's watcher share what it has already read. */
export function precheckItems(cfg: Config, prs: Pull[] | null = null, commentsOf: ((n: number) => Comment[]) | null = null): Item[] {
  const todo: Item[] = [];
  const escalation: Escalation = [escalateMinutes(cfg), running(cfg), now()];
  const pulls = prs ?? ghAll<Pull>("repos/{owner}/{repo}/pulls?state=open");
  const comOf = commentsOf ?? ((n: number) => ghAll<Comment>(`repos/{owner}/{repo}/issues/${n}/comments`));
  for (const p of pulls) {
    const n = p.number;
    const sha = p.head.sha;
    const comments = comOf(n);
    if (!p.draft) {
      const marks: string[] = [];
      for (const c of comments) for (const [, v] of verdicts(c.body ?? "")) if (v) marks.push(v);
      for (const c of comments) for (const m of (c.body ?? "").matchAll(WATCHED)) marks.push(m[1] as string);
      if (!marks.some((m) => sha.startsWith(m) || m.startsWith(sha))) {
        todo.push(["review", n, `PR #${n}: commit ${sha.slice(0, 7)} not reviewed yet`]);
      }
    }
    todo.push(...waitingQuestions("PR", n, comments, escalation));
  }
  for (const i of ghAll<Issue>("repos/{owner}/{repo}/issues?state=open")) { // questions on task issues too
    if (!i.pull_request && (i.comments ?? 1) && !names(i).has("factory:agent")) {
      todo.push(...waitingQuestions("issue", i.number, comOf(i.number), escalation));
    }
  }
  const tasks = (cfg.tasks || {}) as Record<string, unknown>;
  if (tasks.source === "issues") {
    const L = taskLabels(cfg);
    for (const i of current(agentIssues())) {
      const st = stateOf(cfg, i);
      if (st && st[1] === "silent") todo.push(["agent", st[0], `agent ${st[0]} has been silent for ${(st[3] / 60).toFixed(1)} h`]);
    }
    const hours = toFloat(tasks.staleHours ?? 3) ?? 3;
    const t = now();
    for (const i of taskIssues("open", L.inProgress)) {
      const age = (t - lastActivity(i)) / 3600;
      if (age >= hours && !waitingForSlot(cfg, i)) todo.push(["stale", i.number, `#${i.number} in progress but quiet for ${age.toFixed(1)} h`]);
    }
  }
  return todo;
}

/** What the dev manager has to do right now, one line each; empty when nothing. Reads GitHub only. */
export function precheck(cfg: Config): string[] {
  return precheckItems(cfg).map(([, , text]) => text);
}

/** One ["question", number, line] per question addressed to the dev manager that waits for its answer (a
 * question that asks the asker for more information waits for the asker, not for the dev manager). `escalation`
 * is [minutes per level, whether a product owner runs, now]: then a question addressed `to=po` that nobody answered
 * for a level, or that has no product owner to go to, is the dev manager's too (#110). A question with no known time
 * (age 0) is not escalated yet: a level is worked out from an age, never from a guess. */
export function waitingQuestions(what: string, n: number, comments: Comment[], escalation: Escalation | null = null): Item[] {
  const thread = fold(messagesOf(comments));
  const out: Item[] = unanswered(thread, DEV_MANAGER).map((t) =>
    ["question", n, `${what} #${n}: question waits for an answer (${t.id} from ${t.frm || "an agent"})`]);
  if (escalation) {
    for (const [t, lvl, age] of waiting(thread, ...escalation)) {
      if (lvl === "dev-manager" && age > 0) {
        out.push(["question", n, `${what} #${n}: product question ${t.id} from ${t.frm || "an agent"} is unanswered ` +
          `for ${(age / 60).toFixed(1)} h: answer it, or escalate it to the owner`]);
      }
    }
  }
  return out;
}

/** The minutes argument at args[k] (a number), else the default. */
export function minutesArg(args: string[], k: number, dflt = 30): number | string {
  if (args.length <= k) return dflt;
  const v = toFloat(args[k]);
  if (v === null) die(`factory wait: '${args[k]}' is not a number of minutes`);
  // Python printed float(arg): "5" -> 5.0 in its lines.
  return Number.isInteger(v) ? `${v}.0` : String(v);
}

export function main(a: string[]): number {
  if (!a.length) die(DOC);
  const [cmd, ...rest] = a as [string, ...string[]];
  const cfg = load();
  let out: Outcome;
  if (cmd === "ci" || cmd === "answer") {
    if (!rest.length || !/^\d+$/.test(rest[0] as string)) die(`usage: factory wait ${cmd} <pr> [minutes]`);
    out = (cmd === "ci" ? waitCi : waitAnswer)(Number(rest[0]), minutesArg(rest, 1));
  } else if (cmd === "slot") {
    out = waitSlot(minutesArg(rest, 0), cfg);
  } else if (cmd === "ready") {
    out = waitReady(minutesArg(rest, 0), cfg);
  } else if (cmd === "precheck") {
    const todo = precheck(cfg);
    console.log(todo.length ? todo.join("\n") : "nothing to do");
    throw new Exit(todo.length ? 3 : 0);
  } else {
    die(`factory wait: unknown wait '${cmd}' (ci, answer, slot, ready; or a PR number)`);
  }
  console.log(out[1]);
  return out[0];
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
