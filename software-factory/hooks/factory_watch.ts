#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// The dev manager's watcher (#109): from GitHub state alone, with no model, work out what needs a manager and what
// needs the owner. It recomputes everything each time, so a missed event hides nothing, and it only reads.
//
//   factory_watch.ts            one line per item: ref, who it is for, how long it has waited, and why  (exit 3 when any)
//   factory_watch.ts --json     the same as JSON
//   --fresh                     read GitHub now: the one-line view answers from the views' cache while it is fresh
//                               (factory_views_cache.ts, `views.cacheSeconds`); --json and `collect` (the
//                               orchestrator's) always read GitHub, since programs act on them
//
// The seven checks (thresholds are `manager.*` settings):
//   1 review     an open PR whose head commit has no reviewed marker (factory-approved, factory-mustfix or pr-watch) and has
//                been quiet for `quietMinutes` (5)
//   2 question   a question with no later answer (`<!-- factory-question -->`, or `<!-- factory-msg ... kind=question
//                to=dev-manager -->` as #107 defines it)
//   3 fix        a must-fix, failing CI or a merge conflict on a PR with no new commit for `staleMinutes` (15)
//   4 merge      an approved, green, unmerged PR (a PR the manager opened itself waits for the owner instead)
//   5 owner-wait a PR labelled for the product owner (`roles.product-owner.workLabel`) or the owner (`factory:needs-owner`)
//                that has waited `ownerWaitMinutes` (120)
//   6 agent      a coding agent silent (for a manager), or down, or idle for `agentIdleMinutes` (45) while tasks are ready
//                (for the owner)
//   7 ci         a CI job queued for `ciQueuedMinutes` (10), with a note when no runner is online
//
// Each item is {kind, ref, to ("manager" or "owner"), line, since, target, lease}. `target` is the issue or PR a lease and
// the thread note go on; `lease` is [kind, key] for factory_lease.ts. `since` is when the item became actionable (seconds
// since the epoch), which the dead-man's switch uses. Idempotent by construction: a head that carries a marker, a
// question that has an answer, a claim that is unexpired, all clear their item.
import { type Config, load, managerSetting, roleSetting, toFloat } from "./factory_config.ts";
import { agentIssues, current, fields, nameOf, roleOf, stateOf } from "./factory_agents.ts";
import { JudgeError, state as judgeState, type Verdict } from "./factory_ci_judge.ts";
import { type Comment, gh, ghAll, type Issue, readyIssues } from "./factory_issues.ts";
import { now as leaseNow } from "./factory_lease.ts";
import { parseComment, verdicts } from "./factory_messages.ts";
import { questions } from "./factory_po.ts";
import { type Pull as WaitPull, precheckItems, waitingTasks } from "./factory_wait.ts";
import { Exit, isoUtc, parseIso, pyDumps, runMain } from "./factory_lib.ts";
import { answer, sayAge } from "./factory_views_cache.ts";

export const WATCH = /<!--\s*pr-watch\s+sha=([0-9a-f]{7,40})/g;
export const OWNER_LABEL = "factory:needs-owner";
export const OWN_BRANCH = /^manager\//;
export const OWN_BODY = /<!--\s*factory-role\s+role=dev-manager\b/;
export const ORDER: Record<string, number> = { merge: 0, question: 1, review: 2, fix: 3, stale: 4, agent: 5, owner: 6 };

export interface Pull extends WaitPull {
  title?: string;
  body?: string | null;
  labels?: { name: string }[];
  mergeable_state?: string;
  merged_at?: string | null;
  base?: { ref?: string };
}

export interface Item {
  kind: string;
  ref: string;
  to: string;
  line: string;
  /** Seconds since the epoch, or null when unknown. */
  since: number | null;
  target: number | null;
  lease: [kind: string, key: string];
  pr: number | null;
}

/** Seconds since the epoch for an ISO time, else null. */
export function when(text: string | null | undefined): number | null {
  return parseIso(text || "");
}

/** Python's datetime.isoformat() of a UTC time: "2026-10-25T10:00:00+00:00". */
export function isoformat(t: number): string {
  const whole = Math.floor(t);
  const base = isoUtc(whole).replace(/Z$/, "");
  const micro = Math.round((t - whole) * 1e6);
  return base + (micro ? "." + String(micro).padStart(6, "0") : "") + "+00:00";
}

export function minutes(since: number | null | undefined, now: number): number {
  return since ? (now - since) / 60 : 0.0;
}

/** ["none" | "watch" | "approved" | "mustfix", when] for the head commit: the latest marker that names it (a verdict
 * in a message envelope or the old marker; `pr-watch` ends the review of a head without a verdict). */
export function reviewState(comments: Comment[], head: string): [string, number | null] {
  let got: [string, number | null] = ["none", null];
  for (const c of comments) {
    const b = c.body || "";
    const marks: [string, string][] = [];
    for (const [k, v] of verdicts(b)) if (v) marks.push([k, v]);
    for (const m of b.matchAll(WATCH)) marks.push(["watch", m[1] as string]);
    for (const [kind, sha] of marks) {
      if (head.startsWith(sha) || sha.startsWith(head)) {
        if (kind === "watch" && (got[0] === "approved" || got[0] === "mustfix")) {
          continue; // the pr-watch marker rides along with a verdict; the verdict is what counts
        }
        got = [kind, when(c.created_at)];
      }
    }
  }
  return got;
}

/** The task issue a PR closes (`Closes #n`, else its task/<n>-... branch), else null. */
export function issueOf(pr: { body?: string | null; head?: { ref?: string } }): number | null {
  const m = /\b(?:closes|fixes|resolves)\s+#(\d+)/i.exec(pr.body || "");
  if (m) return Number(m[1]);
  const b = /^task\/(\d+)-/.exec(pr.head?.ref ?? "");
  return b ? Number(b[1]) : null;
}

export function isOwn(pr: { body?: string | null; head?: { ref?: string } }): boolean {
  return OWN_BRANCH.test(pr.head?.ref ?? "") || OWN_BODY.test(pr.body || "");
}

/** The manager's CI verdict for a commit; "unknown" when GitHub cannot be read (nothing is acted on then). */
export function ciState(head: string): [Verdict | "unknown", string[]] {
  try {
    return judgeState(head);
  } catch (e) {
    if (e instanceof JudgeError) return ["unknown", []];
    throw e;
  }
}

export function make(kind: string, ref: string, line: string, o: { to?: string; since?: number | null; target?: number | null;
  key?: string | number | null; leaseKind?: string; pr?: number | null } = {}): Item {
  return { kind, ref, to: o.to ?? "manager", line, since: o.since ?? null, target: o.target ?? null,
    lease: [o.leaseKind ?? "item", String(o.key !== undefined && o.key !== null ? o.key : ref)], pr: o.pr ?? null };
}

const ACTIVITY = /<!--\s*(?:factory-(?:approved|mustfix|answer)|pr-watch|factory-owner-ask)\b/;

/** When a dev manager last did something visible: a verdict, an answer, a watch or an owner ask on an open PR, a merge,
 * or a "working" ping from a dev-manager agent issue. Claims are left out on purpose: taking a lease is not progress. */
export function lastActivity(prs: Pull[], commentsOf: (n: number) => Comment[], agents: Map<string, Issue>, cfg: Config): number | null {
  let best: number | null = null;
  const see = (t: number | null): void => {
    if (t && (best === null || t > best)) best = t;
  };
  for (const p of prs) {
    for (const c of commentsOf(p.number)) {
      const body = c.body || "";
      if (ACTIVITY.test(body) || verdicts(body).length || parseComment(c).some((m) => m.kind === "answer")) see(when(c.created_at));
    }
  }
  for (const p of ghAll<Pull>("repos/{owner}/{repo}/pulls?state=closed&sort=updated&direction=desc&per_page=10").slice(0, 10)) {
    see(when(p.merged_at));
  }
  for (const issue of agents.values()) {
    if (roleOf(issue) === "dev-manager") {
      const st = stateOf(cfg, issue);
      if (st && st[1] === "working") see(st[2]);
    }
  }
  return best;
}

function utcParts(t: number): { y: string; mo: string; d: string; h: string; mi: string } {
  const s = isoUtc(t); // 2026-10-25T10:00:00Z
  return { y: s.slice(0, 4), mo: s.slice(5, 7), d: s.slice(8, 10), h: s.slice(11, 13), mi: s.slice(14, 16) };
}

interface Info {
  activity?: number | null;
}

/** All items that need a manager or the owner, most urgent first. Reads GitHub only. `info`, when given, is filled
 * with "activity": the time of the last visible dev-manager action (see lastActivity). */
export function collect(cfg: Config, nowArg: number | null = null, info: Info | null = null): Item[] {
  const now = nowArg ?? leaseNow();
  const quiet = toFloat(managerSetting(cfg, "quietMinutes")) ?? 0;
  const stale = toFloat(managerSetting(cfg, "staleMinutes")) ?? 0;
  const prs = ghAll<Pull>("repos/{owner}/{repo}/pulls?state=open");
  const byPr = new Map<number, Pull>(prs.map((p) => [p.number, p]));
  const cache = new Map<number, Comment[]>();
  const commentsOf = (n: number): Comment[] => {
    if (!cache.has(n)) cache.set(n, ghAll<Comment>(`repos/{owner}/{repo}/issues/${n}/comments`));
    return cache.get(n) as Comment[];
  };
  const commitTimes = new Map<string, number | null>();
  const commitTime = (sha: string): number | null => {
    if (!commitTimes.has(sha)) {
      const c = gh<{ commit?: { committer?: { date?: string } | null } | null } | null>("GET", `repos/{owner}/{repo}/commits/${sha}`) ?? {};
      commitTimes.set(sha, when(((c.commit ?? {}).committer ?? {}).date));
    }
    return commitTimes.get(sha) ?? null;
  };

  const items: Item[] = [];
  let agentRoles = new Map<string, Issue>();
  const tasks = (cfg.tasks || {}) as Record<string, unknown>;
  if (tasks.source === "issues") {
    agentRoles = new Map(current(agentIssues()).map((i) => [nameOf(i) as string, i]));
  }

  // checks 1 and 2 (and the silent agents and quiet issues the precheck knows), from the precheck itself
  for (const [kind, ref, text] of precheckItems(cfg, prs, commentsOf)) {
    if (kind === "review") {
      const p = byPr.get(ref as number) as Pull;
      const t = commitTime(p.head.sha);
      if (t && minutes(t, now) < quiet) continue; // the agent may still be pushing: give it a few minutes
      const since = t ? t + quiet * 60 : null;
      items.push(make("review", `pr-${ref}`, text, { since, target: ref as number, key: p.head.sha, leaseKind: "review", pr: ref as number }));
    } else if (kind === "question") {
      const n = ref as number;
      // One item per thread: every question on it shares the ref, the lease and the sub-manager, which answers them all.
      const seen = items.find((i) => i.ref === `question-${n}`);
      if (seen) {
        const more = /\((\d+) questions wait\)$/.exec(seen.line);
        const count = more ? Number(more[1]) + 1 : 2;
        seen.line = seen.line.replace(/ \(\d+ questions wait\)$/, "") + ` (${count} questions wait)`;
        continue;
      }
      const waiting = waitingTasks(commentsOf(n));
      if (!waiting.length) continue;
      const first = waiting[0] as (typeof waiting)[number];
      const q = first.question;
      const key = q.commentId !== null && q.commentId !== undefined && q.commentId !== "" && q.commentId !== 0 ? String(q.commentId) : first.id;
      items.push(make("question", `question-${n}`, text, { since: when(q.created), target: n, key, leaseKind: "answer",
        pr: byPr.has(n) ? n : null }));
    } else if (kind === "agent") {
      const issue = agentRoles.get(String(ref));
      if (issue && roleOf(issue) !== "coding-agent") continue; // a sleeping manager or product owner is not a dead coding agent
      items.push(make("agent", `agent-${ref}`, text, { target: issue ? issue.number : null, key: `agent-${ref}` }));
    } else if (kind === "stale") {
      items.push(make("stale", `issue-${ref}`, text, { target: ref as number, key: `issue-${ref}` }));
    }
  }

  // a product question (`to=po`, #110) that nobody answered for a level moves up: to the dev manager, then to the owner
  for (const q of questions(cfg, { commentsOf, now })) {
    const n = q.number;
    const about = `${q.what} #${n}: product question ${q.id} from ${q.frm}, unanswered for ${(q.age / 60).toFixed(1)} h`;
    if (q.level === "dev-manager" && !items.some((i) => i.kind === "question" && i.target === n)) {
      items.push(make("question", `question-${n}`, about + ": answer it, or escalate it to the owner",
        { since: when(q.since), target: n, key: q.id, leaseKind: "answer", pr: n }));
    } else if (q.level === "owner") {
      items.push(make("owner", `po-question-${q.id}`, about + ": the product owner and the dev manager have not answered",
        { to: "owner", since: when(q.since), target: n, key: `po-question-${q.id}` }));
    }
  }

  // checks 3, 4 and 5, per pull request
  const poLabel = String(roleSetting(cfg, "product-owner", "workLabel", "") || "");
  for (const p of prs) {
    const n = p.number;
    const head = p.head.sha;
    const labels = new Set((p.labels ?? []).map((x) => x.name));
    for (const label of [poLabel, OWNER_LABEL].filter((x) => x && labels.has(x))) {
      const events = ghAll<{ event?: string; created_at?: string; label?: { name?: string } | null }>(`repos/{owner}/{repo}/issues/${n}/events`);
      const marked = events.filter((e) => e.event === "labeled" && (e.label ?? {}).name === label).map((e) => when(e.created_at));
      const ts = marked.filter((x): x is number => Boolean(x));
      const t = ts.length ? Math.max(...ts) : null;
      if (t && minutes(t, now) >= (toFloat(managerSetting(cfg, "ownerWaitMinutes")) ?? 0)) {
        const who = label === poLabel ? "the product owner" : "the owner";
        items.push(make("owner", `wait-${n}-${label}`, `PR #${n} has waited ${(minutes(t, now) / 60).toFixed(1)} h for ${who} ` +
          `(label ${label})`, { to: "owner", since: t, target: n, key: `wait-${n}-${label}`, pr: n }));
      }
    }
    if (p.draft) continue;
    const [state, markedAt] = reviewState(commentsOf(n), head);
    if (state === "none") continue; // check 1 owns it
    const t = commitTime(head);
    const reasons: string[] = [];
    let green = false;
    const [verdict, jobs] = ciState(head);
    if (state === "approved" && verdict === "green") green = true;
    if (verdict === "failed" && t && minutes(t, now) >= stale) reasons.push(`CI failed (${jobs.join(", ")})`);
    if (state === "mustfix" && markedAt && minutes(markedAt, now) >= stale) reasons.push("a must-fix waits for a new commit");
    if ((state === "approved" || state === "mustfix" || state === "watch") && t && minutes(t, now) >= stale) {
      const detail = gh<Pull | null>("GET", `repos/{owner}/{repo}/pulls/${n}`) ?? ({} as Partial<Pull>);
      if (detail.mergeable_state === "dirty") {
        reasons.push("a merge conflict");
        green = false; // approved and green, but it cannot merge as it is
      }
    }
    if (green && isOwn(p)) {
      items.push(make("owner", `own-${n}`, `PR #${n} is approved and green, but the manager opened it: it waits ` +
        "for the owner to merge", { to: "owner", since: markedAt, target: n, key: `own-${n}`, pr: n }));
    } else if (green) {
      items.push(make("merge", `pr-${n}`, `PR #${n}: approved and green, merge pending`, { since: markedAt, target: n, key: head,
        leaseKind: "review", pr: n }));
    } else if (reasons.length) {
      items.push(make("fix", `pr-${n}`, `PR #${n}: ` + reasons.join("; "), { since: t ? t + stale * 60 : null, target: n, key: head,
        leaseKind: "review", pr: n }));
    }
  }

  // check 6: agents that are down, or idle with work ready
  if (agentRoles.size) {
    let ready: Issue[] | null = null;
    for (const [name, issue] of agentRoles) {
      if (roleOf(issue) !== "coding-agent") continue;
      const st = stateOf(cfg, issue);
      if (!st) continue;
      const [, status, t] = st;
      const since = when(fields(issue).since); // when it entered this state (the heartbeat writes it)
      const quietMin = since ? minutes(since, now) : 0.0;
      const tp = utcParts(t);
      if (status === "down") {
        const id = `agent-down-${name}-${tp.y}${tp.mo}${tp.d}${tp.h}`;
        items.push(make("owner", id, `agent ${name} is down (last ping ${tp.h}:${tp.mi} UTC)`,
          { to: "owner", since: t, target: issue.number, key: id }));
      } else if (status === "idle" && quietMin >= (toFloat(managerSetting(cfg, "agentIdleMinutes")) ?? 0)) {
        ready = ready === null ? readyIssues(cfg) : ready;
        if (ready.length) {
          const np = utcParts(now);
          const id = `agent-idle-${name}-${np.y}${np.mo}${np.d}`;
          items.push(make("owner", id, `agent ${name} has been idle for ${pyRound(quietMin)} min while ${ready.length} task(s) are ready`,
            { to: "owner", since: t, target: issue.number, key: id }));
        }
      }
    }
  }

  // check 7: queued CI
  try {
    const runs = (gh<{ workflow_runs?: { name?: string; created_at?: string }[] } | null>("GET",
      "repos/{owner}/{repo}/actions/runs?status=queued&per_page=50") ?? {}).workflow_runs ?? [];
    const limit = toFloat(managerSetting(cfg, "ciQueuedMinutes")) ?? 0;
    const old = runs.filter((r) => { const w = when(r.created_at); return w && minutes(w, now) >= limit; });
    if (old.length) {
      const first = Math.min(...old.map((r) => when(r.created_at) as number));
      const names = [...new Set(old.map((r) => r.name ?? "?"))].sort();
      let line = `CI: ${old.length} run(s) queued for ${pyRound(minutes(first, now))}+ min (${names.join(", ")})`;
      try {
        const online = ((gh<{ runners?: { status?: string }[] } | null>("GET", "repos/{owner}/{repo}/actions/runners") ?? {}).runners ?? [])
          .filter((r) => r.status === "online");
        if (!online.length) line += "; no self-hosted runner is online";
      } catch (e) {
        if (!(e instanceof Exit)) throw e; // listing runners needs admin rights: say nothing about them
      }
      items.push(make("owner", "ci-queue", line, { to: "owner", since: first, key: "ci-queue" }));
    }
  } catch (e) {
    if (!(e instanceof Exit)) throw e; // Actions not readable: nothing to report
  }

  if (info !== null) info.activity = lastActivity(prs, commentsOf, agentRoles, cfg);
  const dead = 4 * (toFloat(managerSetting(cfg, "deadManMinutes")) ?? 0); // 2 hours by default

  /** 0 for a task PR whose CI is green (#201), and for anything that has already waited four times `deadManMinutes`,
   * so a docs PR is never starved; 1 for the rest. It only orders items of the same kind. */
  const tier = (i: Item): number => {
    const pr = i.pr !== null ? byPr.get(i.pr) : undefined;
    if (!pr) return 1;
    if (i.since && minutes(i.since, now) >= dead) return 0;
    return issueOf(pr) && ciState(pr.head.sha)[0] === "green" ? 0 : 1;
  };
  const keyed = items.map((i) => [i, ORDER[i.kind] as number, tier(i), i.since || now] as const);
  keyed.sort((a, b) => a[1] - b[1] || a[2] - b[2] || a[3] - b[3]);
  return keyed.map(([i]) => i);
}

/** Python's f"{x:.0f}" (round half to even). */
export function pyRound(x: number): string {
  const r = Math.round(x);
  const v = Math.abs(x - Math.trunc(x)) === 0.5 ? 2 * Math.round(x / 2) : r;
  return (Object.is(v, -0) ? 0 : v).toFixed(0);
}

export function render(items: Item[], nowArg: number | null = null): string[] {
  const now = nowArg ?? leaseNow();
  return items.map((i) => `${i.ref.padEnd(18)} ${i.to.padEnd(8)} ${pyRound(minutes(i.since, now)).padStart(5)} min  ${i.line}`);
}

export function main(argv: string[]): number {
  const cfg = load();
  const json = argv.includes("--json");
  // --json is for programs, which act on it: it always reads GitHub, and keeps the answer for the next person's view.
  const got = answer(cfg, { name: "watch", hook: import.meta.path, args: [] }, json || argv.includes("--fresh"), () => collect(cfg));
  const items = got.data;
  if (json) {
    console.log(pyDumps(items.map((i) => ({ ...i, since: i.since ? isoformat(i.since) : null })), { indent: 2 }));
  } else if (items.length) {
    console.log(render(items).join("\n"));
  } else {
    console.log("nothing to do");
  }
  sayAge(got.age, json);
  return items.length ? 3 : 0;
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
