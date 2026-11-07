// What each task took to build (#580): its build time, the agent's working minutes, its sessions, tokens and cost, its CI
// runs and its review rounds, from what the factory already has. No GitHub call.
//
//   - The sessions are `factory usage`'s (factory_usage.ts): each with its task, its first and last reply, its tokens and
//     cost. The working minutes are the sum of each session's span (first reply to last).
//   - The times are the task's events, kept in `task-times.json` in this machine's state folder: its claims and when it
//     was done (the message board's claims, closes, moves to done and merged pull requests, which the web UI reads and
//     keeps), and from the snapshot (`snapshot.json`): a claim and a done time the board's tasks part gives, each
//     finished CI run on the task's branch, and each head of its pull request the dev manager gave must-fixes (one review
//     round). A run or a round is kept by its id, so one seen in many snapshots counts once and an old one stays when the
//     snapshot no longer lists it.
//   - The build time is from the first claim to when it was done (merged or closed done); with no claim recorded, from
//     its first session's first reply (`startFrom` says which).
//
// The spinning check (Needs attention, factory_ui_attention.ts) compares a task in progress with the median of the done
// tasks (at least SPIN_MIN_DONE of them), and counts its review rounds and its failed CI runs in a row.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { branchTask } from "./factory_config.ts";

export const TIMES_FILE = "task-times.json";
/** The events kept at most (the oldest go first). */
export const TIMES_MAX = 20_000;
/** The done tasks needed before a median is compared with. */
export const SPIN_MIN_DONE = 5;

type Obj = Record<string, unknown>;

export interface Tokens {
  input: number;
  cache_write: number;
  cache_read: number;
  output: number;
}

/** One session as `factory usage --json` gives it (its `sessions`). */
export interface SessionRow {
  id: string;
  task: string;
  worker: string;
  first: string;
  last: string;
  tokens: Tokens;
  replies: number;
  cost_usd: number;
  unpriced_replies: number;
}

/** One thing that happened to a task: a claim, done (merged or closed done), a finished CI run, a review round with
 *  must-fixes. `id` keeps it once. */
export interface TaskEvent {
  id: string;
  task: string;
  kind: "claimed" | "done" | "ci" | "review";
  at: string;
  /** For a CI run: it failed. */
  failed?: boolean;
}

export interface TaskCost {
  task: string;
  /** When the build started: the first claim, else the first reply of its first session. */
  startedAt: string | null;
  startFrom: "claim" | "first-reply" | null;
  /** When it was done (merged, or closed done); null while it isn't. */
  doneAt: string | null;
  /** Minutes from the start to done; null while it isn't done. */
  buildMinutes: number | null;
  /** The sum of its sessions' spans, in minutes. */
  workingMinutes: number;
  sessions: number;
  replies: number;
  tokens: Tokens;
  /** What a budget counts: fresh input (input + cache writes) + output. */
  used: number;
  /** US dollars of the replies whose model has a known price. */
  cost: number;
  /** Replies of a model without a known price, and their share of all its replies (0 to 1). */
  unpriced: number;
  unpricedShare: number;
  ci: { runs: number; failed: number; failedInARow: number };
  reviews: { rounds: number };
  /** The agent whose folder its last session ran in, or null. */
  worker: string | null;
}

function obj(v: unknown): Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {};
}

function str(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function ms(iso: string | null | undefined): number | null {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? null : t;
}

function zero(): Tokens {
  return { input: 0, cache_write: 0, cache_read: 0, output: 0 };
}

/** The sessions of a `factory usage --json` answer, read defensively. */
export function sessionsOf(report: unknown): SessionRow[] {
  const rows = obj(report).sessions;
  return (Array.isArray(rows) ? rows : []).map(obj).map((s): SessionRow => {
    const t = obj(s.tokens);
    return { id: str(s.id), task: str(s.task) || "-", worker: str(s.worker), first: str(s.first), last: str(s.last),
      tokens: { input: num(t.input), cache_write: num(t.cache_write), cache_read: num(t.cache_read), output: num(t.output) },
      replies: num(s.replies), cost_usd: num(s.cost_usd), unpriced_replies: num(s.unpriced_replies) };
  });
}

const FAILED = new Set(["failure", "timed_out", "startup_failure", "cancelled"]);
const FINISHED = new Set([...FAILED, "success", "neutral", "skipped"]);

/** The events a snapshot (snapshot.json) gives: the board's tasks part's claims and done times, each finished CI run on a
 *  task's branch, and each pull request head with must-fixes on it (one review round). */
export function snapshotEvents(snap: unknown): TaskEvent[] {
  const s = obj(snap);
  const out: TaskEvent[] = [];
  const at = ms(str(s.generatedAt));
  for (const t of Array.isArray(obj(s.tasks).tasks) ? (obj(s.tasks).tasks as unknown[]).map(obj) : []) {
    const id = str(t.id);
    if (!id) continue;
    const claimed = str(t.claimedAt);
    if (claimed && ms(claimed) !== null) out.push({ id: `claim-${id}-${claimed}`, task: id, kind: "claimed", at: claimed });
    const updated = str(t.updatedAt);
    if (str(t.state) === "done" && updated && ms(updated) !== null) out.push({ id: `done-${id}-${updated}`, task: id, kind: "done", at: updated }); // a task done again is a new event
  }
  if (at !== null) {
    for (const r of Array.isArray(obj(s.ci).runs) ? (obj(s.ci).runs as unknown[]).map(obj) : []) {
      const state = str(r.state);
      const task = branchTask(str(r.branch));
      const id = str(r.id);
      if (!task || !id || !FINISHED.has(state) || state === "skipped") continue;
      out.push({ id: `ci-${id}`, task, kind: "ci", at: new Date(at - num(r.minutesAgo) * 60_000).toISOString(), failed: FAILED.has(state) });
    }
    for (const p of Array.isArray(s.pulls) ? (s.pulls as unknown[]).map(obj) : []) {
      const task = branchTask(str(p.branch));
      const head = str(p.head);
      if (!task || str(p.review) !== "factory-mustfix") continue;
      out.push({ id: `review-${num(p.number)}-${head || "head"}`, task, kind: "review", at: new Date(at).toISOString() });
    }
  }
  return out;
}

/** The events kept in `dir`'s task-times.json ([] when there are none or it can't be read). */
export function keptEvents(dir: string): TaskEvent[] {
  try {
    const data = obj(JSON.parse(readFileSync(join(dir, TIMES_FILE), "utf8")) as unknown);
    return (Array.isArray(data.events) ? data.events : []).map(obj).filter((e) => str(e.id) && str(e.task) && str(e.at) &&
      ["claimed", "done", "ci", "review"].includes(str(e.kind))).map((e): TaskEvent => ({ id: str(e.id), task: str(e.task),
      kind: str(e.kind) as TaskEvent["kind"], at: str(e.at), ...(e.failed === true ? { failed: true } : e.failed === false ? { failed: false } : {}) }));
  } catch {
    return [];
  }
}

/** `a` with each of `b` it doesn't have yet (by id; the first one seen stays), oldest first, at most TIMES_MAX. */
export function merged(a: TaskEvent[], b: TaskEvent[]): TaskEvent[] {
  const byId = new Map<string, TaskEvent>();
  for (const e of [...a, ...b]) if (!byId.has(e.id)) byId.set(e.id, e);
  return [...byId.values()].sort((x, y) => x.at.localeCompare(y.at) || x.id.localeCompare(y.id)).slice(-TIMES_MAX);
}

/** Keeps `events` in `dir`'s task-times.json with those already there; true when the file changed. Written whole
 *  (a temporary file, then renamed), readable by its owner only. A folder that can't be written keeps nothing. */
export function keepEvents(dir: string, events: TaskEvent[]): boolean {
  const before = keptEvents(dir);
  const after = merged(before, events);
  if (after.length === before.length && existsSync(join(dir, TIMES_FILE))) return false;
  try {
    const path = join(dir, TIMES_FILE);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, events: after }), { mode: 0o600 });
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/** The events of `dir`: those kept, and the snapshot's there now. */
export function eventsIn(dir: string): TaskEvent[] {
  let snap: unknown = null;
  try {
    snap = JSON.parse(readFileSync(join(dir, "snapshot.json"), "utf8")) as unknown;
  } catch {
    snap = null;
  }
  return merged(keptEvents(dir), snapshotEvents(snap));
}

function counted(t: Tokens): number {
  return t.input + t.cache_write + t.output;
}

/** Each task's cost and times, from its sessions and its events; the tasks with a session or an event, by task id. */
export function taskCosts(sessions: SessionRow[], events: TaskEvent[]): TaskCost[] {
  const ids = new Set<string>();
  for (const s of sessions) if (s.task && s.task !== "-") ids.add(s.task);
  for (const e of events) ids.add(e.task);
  const out: TaskCost[] = [];
  for (const task of ids) {
    const mine = sessions.filter((s) => s.task === task).sort((a, b) => a.first.localeCompare(b.first));
    const evs = events.filter((e) => e.task === task).sort((a, b) => a.at.localeCompare(b.at));
    const tokens = zero();
    let working = 0;
    let replies = 0;
    let cost = 0;
    let unpriced = 0;
    for (const s of mine) {
      for (const k of ["input", "cache_write", "cache_read", "output"] as const) tokens[k] += s.tokens[k];
      const a = ms(s.first);
      const b = ms(s.last);
      if (a !== null && b !== null && b > a) working += b - a;
      replies += s.replies;
      cost += s.cost_usd;
      unpriced += s.unpriced_replies;
    }
    const claim = evs.find((e) => e.kind === "claimed");
    const firstReply = mine.find((s) => ms(s.first) !== null)?.first ?? null;
    const startedAt = claim?.at ?? firstReply;
    const lastDone = [...evs].reverse().find((e) => e.kind === "done") ?? null;
    // claimed again after it was done (reopened): it is being built again, not done
    const reopened = lastDone !== null && evs.some((e) => e.kind === "claimed" && e.at > lastDone.at);
    const doneAt = lastDone && !reopened ? lastDone.at : null;
    const start = ms(startedAt);
    const end = ms(doneAt);
    const runs = evs.filter((e) => e.kind === "ci");
    let inARow = 0;
    for (const r of [...runs].reverse()) {
      if (!r.failed) break;
      inARow += 1;
    }
    out.push({ task, startedAt, startFrom: claim ? "claim" : firstReply ? "first-reply" : null, doneAt,
      buildMinutes: start !== null && end !== null ? Math.max(Math.round((end - start) / 60_000), 0) : null,
      workingMinutes: Math.round(working / 60_000), sessions: mine.length, replies, tokens, used: counted(tokens),
      cost: Math.round(cost * 1e6) / 1e6, unpriced, unpricedShare: replies ? Math.round((unpriced / replies) * 100) / 100 : 0,
      ci: { runs: runs.length, failed: runs.filter((r) => r.failed).length, failedInARow: inARow },
      reviews: { rounds: evs.filter((e) => e.kind === "review").length }, worker: mine.at(-1)?.worker || null });
  }
  return out.sort((a, b) => Number(a.task) - Number(b.task) || a.task.localeCompare(b.task));
}

/** The middle value (the mean of the two middle ones for an even count); null for none. */
export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

export interface Medians {
  /** How many done tasks they are the median of. */
  done: number;
  used: number | null;
  workingMinutes: number | null;
}

/** The median tokens and working minutes of the done tasks. */
export function mediansOf(costs: TaskCost[]): Medians {
  const done = costs.filter((c) => c.doneAt !== null);
  return { done: done.length, used: median(done.map((c) => c.used)), workingMinutes: median(done.map((c) => c.workingMinutes)) };
}

export interface SpinLimits {
  spinFactor: number;
  spinReviewRounds: number;
  spinFailedCi: number;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function commas(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Why a task in progress looks like it is going in circles, in plain words, or null when it doesn't. Tokens and working
 *  time are compared with `spinFactor` times the done tasks' median, only with SPIN_MIN_DONE done tasks or more. */
export function spinReason(c: TaskCost, m: Medians, lim: SpinLimits): string | null {
  const why: string[] = [];
  if (m.done >= SPIN_MIN_DONE) {
    if (m.used !== null && m.used > 0 && c.used > lim.spinFactor * m.used) {
      why.push(`it has used ${commas(c.used)} tokens, more than ${lim.spinFactor} times the median of the done tasks (${commas(m.used)})`);
    }
    if (m.workingMinutes !== null && m.workingMinutes > 0 && c.workingMinutes > lim.spinFactor * m.workingMinutes) {
      why.push(`its agent has worked ${plural(c.workingMinutes, "minute")} on it, more than ${lim.spinFactor} times the median of the done tasks (${plural(Math.round(m.workingMinutes), "minute")})`);
    }
  }
  if (c.reviews.rounds >= lim.spinReviewRounds) why.push(`it has had ${plural(c.reviews.rounds, "review round")} with must-fixes`);
  if (c.ci.failedInARow >= lim.spinFailedCi) why.push(`its last ${c.ci.failedInARow} CI runs failed`);
  if (!why.length) return null;
  const text = why.join("; ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}. Its agent may be going in circles.`;
}

export interface EpicCost {
  epic: string;
  tasks: number;
  done: number;
  buildMinutes: number;
  workingMinutes: number;
  sessions: number;
  replies: number;
  used: number;
  cost: number;
  unpriced: number;
  ci: { runs: number; failed: number };
  reviews: { rounds: number };
}

/** The totals of an epic's tasks: what each of `ids` with a cost adds up to (build minutes of the done ones). */
export function epicCost(epic: string, ids: string[], costs: TaskCost[]): EpicCost {
  const mine = costs.filter((c) => ids.includes(c.task));
  const sum = (f: (c: TaskCost) => number): number => mine.reduce((n, c) => n + f(c), 0);
  return { epic, tasks: ids.length, done: mine.filter((c) => c.doneAt !== null).length, buildMinutes: sum((c) => c.buildMinutes ?? 0),
    workingMinutes: sum((c) => c.workingMinutes), sessions: sum((c) => c.sessions), replies: sum((c) => c.replies), used: sum((c) => c.used),
    cost: Math.round(sum((c) => c.cost) * 1e6) / 1e6, unpriced: sum((c) => c.unpriced),
    ci: { runs: sum((c) => c.ci.runs), failed: sum((c) => c.ci.failed) }, reviews: { rounds: sum((c) => c.reviews.rounds) } };
}

/** 95 -> "1h 35m", 40 -> "40m", 0 -> "0m"; null -> "-". */
export function duration(minutes: number | null): string {
  if (minutes === null) return "-";
  const m = Math.round(minutes);
  if (m < 60) return `${m}m`;
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const r = m % 60;
  return d ? `${d}d ${h}h` : `${h}h ${String(r).padStart(2, "0")}m`;
}
