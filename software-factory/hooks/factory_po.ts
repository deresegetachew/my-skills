#!/usr/bin/env -S bun --no-env-file
// Product questions (#110): a question addressed `to=po` waits for the product owner, and moves up a level when nobody
// answers: product owner, then dev manager, then the owner. It only reads.
//
// A coding agent posts a question on its task issue (or PR) with `to=po` for a product question ("what should this screen do
// when X?", "which of these two behaviours is right?"), `to=dev-manager` (the default) for a technical or process one. It keeps
// working on other things while it waits. The levels:
//
//   po           the first `roles.product-owner.escalateMinutes` (120) after the question, when a product owner is running
//   dev-manager  the next `escalateMinutes`, or from the start when no product owner is running: the dev manager answers it
//                or escalates it (the fallback)
//   owner        after that: the dev manager's watcher reports it to the owner queue
//
// A product owner is running when its agent issue is not down or silent. State-based and idempotent: nothing is stored,
// the level is worked out from the question's age each time, so a missed wake-up finds it later.
//
//   factory_po.ts [--json]      the open `to=po` questions with their level and age (like `factory messages ls --to po`, plus
//                               the level); exit 0
import { type Config, load, roleSetting, toFloat } from "./factory_config.ts";
import { agentIssues, current, roleOf, stateOf } from "./factory_agents.ts";
import { type Comment, ghAll, type Issue, names } from "./factory_issues.ts";
import { fold, messagesOf, select, type Task, type Thread } from "./factory_messages.ts";
import { now as nowSeconds, parseIso, pyDumps, runMain } from "./factory_lib.ts";

export const PO = "po";
export const LEVELS = ["po", "dev-manager", "owner"] as const;
export type Level = (typeof LEVELS)[number];

export function escalateMinutes(cfg: Config): number {
  const v = toFloat(roleSetting(cfg, "product-owner", "escalateMinutes", 120));
  if (v === null) throw new Error(`could not convert roles.product-owner.escalateMinutes to float`);
  return v;
}

/** Whether a product owner is running: an agent issue of the product-owner role that is not down or silent. */
export function running(cfg: Config | Record<string, unknown>, issues: Issue[] | null = null): boolean {
  const tasks = (cfg.tasks || {}) as Record<string, unknown>;
  if (tasks.source !== "issues") {
    return false; // agents are not tracked on GitHub: nobody can say a product owner runs, so the fallback applies
  }
  for (const issue of current(issues === null ? agentIssues() : issues)) {
    if (roleOf(issue) !== "product-owner") continue;
    const st = stateOf(cfg, issue);
    if (st && st[1] !== "down" && st[1] !== "silent") return true;
  }
  return false;
}

/** po, dev-manager or owner for a `to=po` question of that age. */
export function level(ageMinutes: number, every: number, poRunning: boolean): Level {
  const step = every > 0 ? Math.floor(Math.max(ageMinutes, 0) / every) : 0;
  return LEVELS[Math.min((poRunning ? 0 : 1) + step, 2)] as Level;
}

/** Minutes from an ISO time to `now` (seconds since the epoch); 0 when unreadable or in the future. */
export function minutesSince(text: string | null | undefined, now: number): number {
  const t = parseIso(text || "");
  if (t === null) return 0.0;
  return Math.max((now - t) / 60, 0.0);
}

export type Waiting = [task: Task, level: Level, ageMinutes: number];

/** [(task, level, age in minutes)] for the open `to=po` questions of a folded thread. A question that asks the asker
 * for more information (input-required) waits for the asker, not for the product owner, so it is left out. */
export function waiting(thread: Thread, every: number, alive: boolean, now: number): Waiting[] {
  const out: Waiting[] = [];
  for (const t of select(thread.tasks.values(), PO)) {
    if (t.state === "submitted" || t.state === "working") {
      const age = minutesSince(t.question.created, now);
      out.push([t, level(age, every, alive), age]);
    }
  }
  return out;
}

export interface PoQuestion {
  id: string;
  number: number;
  what: "PR" | "issue";
  level: Level;
  age: number;
  summary: string;
  frm: string;
  since: string;
}

export interface QuestionsOptions {
  commentsOf?: ((n: number) => Comment[]) | null;
  items?: Issue[] | null;
  /** Seconds since the epoch. */
  now?: number | null;
  poRunning?: boolean | null;
}

/** Open questions addressed to `po` on the open issues and PRs: [{id, number, what, level, age, summary, frm, since}],
 * oldest first. `items` and `commentsOf` let a caller share what it has read; `poRunning` says whether to assume a
 * product owner runs (the product owner's own pass passes true: it is the one asking). */
export function questions(cfg: Config, opts: QuestionsOptions = {}): PoQuestion[] {
  const now = opts.now ?? nowSeconds();
  const every = escalateMinutes(cfg);
  const alive = opts.poRunning === undefined || opts.poRunning === null ? running(cfg) : opts.poRunning;
  const items = opts.items ?? ghAll<Issue>("repos/{owner}/{repo}/issues?state=open").filter((i) => !names(i).has("factory:agent"));
  const commentsOf = opts.commentsOf ?? ((n: number) => ghAll<Comment>(`repos/{owner}/{repo}/issues/${n}/comments`));
  const out: PoQuestion[] = [];
  for (const item of items) {
    const n = item.number;
    if (!(item.comments ?? 1)) continue;
    const what = item.pull_request ? "PR" : "issue";
    const thread = fold(messagesOf(commentsOf(n), `${what === "PR" ? "pr" : "issue"}#${n}`));
    for (const [t, lvl, age] of waiting(thread, every, alive, now)) {
      out.push({ id: t.id, number: n, what, level: lvl, age, summary: t.question.summary, frm: t.frm || "an agent",
        since: t.question.created });
    }
  }
  return out.map((q, i) => [q, i] as const).sort((a, b) => b[0].age - a[0].age || a[1] - b[1]).map(([q]) => q);
}

export function main(argv: string[]): void {
  const cfg = load();
  const rows = questions(cfg);
  if (argv.includes("--json")) {
    console.log(pyDumps(rows, { indent: 2 }));
  } else {
    console.log(rows.map((q) => `${q.id.padEnd(14)} ${q.level.padEnd(12)} ${q.what} #${q.number}  ${(q.age / 60).toFixed(1)} h  ` +
      `${q.frm}: ${q.summary}`).join("\n") || "no product questions waiting");
  }
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
