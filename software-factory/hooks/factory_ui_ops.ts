// The web UI's Health, Home, Activity and Usage and cost pages (#455, #451), served by factory_ui_server.ts. Each reads
// what the server already has (the snapshot's cache, the message board's feed, the owner queue, the agents read live)
// or runs the command that knows it, in that project's folder, and keeps the answer:
//
//   GET  /api/projects/:p/health          the last `factory doctor --json`, its checks grouped (this machine, the project,
//                                         the board, GitHub, CI runners) as ok, warning or failed with each one's fix.
//                                         Kept in the state folder (ui-health.json); one run is started when there is
//                                         none, never on a poll: a run costs GitHub calls (about 70 seen in one)
//   POST /api/projects/:p/health/check    runs `factory doctor --json` now (one at a time per project) and answers with it
//   GET  /api/projects/:p/usage           tokens and cost per task, per agent and per day against the budget (`factory
//                                         usage --json`, by task and by worker), the problems it reported (no logs found:
//                                         where it looked), or its own error when it failed (#571), and this machine's
//                                         GitHub calls in the last hour
//                                         (`factory usage --github --json`), and Claude's limit windows (#614: the last 5
//                                         hours and 7 days per agent, the soft budget, `factory usage --window --json`);
//                                         kept for FACTORY_SNAPSHOT_CACHE_SECONDS
//   GET  /api/projects/:p/activity        everything that happened, newest first, one line each with who, what, when and
//                                         the page it opens (#583): the message board's events (claims, moves, comments,
//                                         closes, agents up or down, the pull request feed) while it is the project's
//                                         record, and what the snapshot read (pull requests opened and gone, their CI
//                                         and reviews, failed runs). ?agent=, ?task=, ?epic=, ?kind= filter it
//   GET  /api/projects/:p/home            what needs attention (#579), what needs the owner, the team, progress by epic
//                                         and the last 10 events
//   GET  /api/projects/:p/attention       what needs attention (factory_ui_attention.ts): anything stuck, each with its
//                                         reason and one action, and the thresholds used
//   GET  /api/projects/:p/costs           what each task took (#580, factory_task_cost.ts): its build time, working
//                                         minutes, sessions, tokens, cost, CI runs and review rounds, each epic's totals and
//                                         the done tasks' medians. The board's claims and done times (its events, as
//                                         Activity reads them) and the snapshot's CI runs and must-fixes are kept in the
//                                         state folder (task-times.json); then `factory usage --json --by task` over the
//                                         last COST_DAYS days joins them with the sessions. Kept like the usage; Usage and
//                                         cost gets the same rows as byTask (null with byTaskUpdating while the first read
//                                         runs). Usage and Needs attention never wait for it: they use what is kept and
//                                         start a read in the background; {type: "costs", project} is pushed when it ends
//
// The WebSocket gets {type: "health", project} when a doctor run ends and {type: "activity", project, items} with
// Activity's new entries (a board event, or what a new snapshot read tells, #583); the pages read their route again
// then (and on "state" and "views"), so they stay live.
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { branchTask } from "./factory_config.ts";
import { type AttentionItem, attentionOf, limitsOf } from "./factory_ui_attention.ts";
import type { Queue } from "./factory_ui_chat.ts";
import { type Agent, channels, claudeLimitOf, envFor, factoryScript, type Live, type Obj, type Problem, readJson, spawn, stateDirOf, type UiProject } from "./factory_ui_data.ts";
import { ttl, type Views } from "./factory_ui_views.ts";
import { epicCost, type EpicCost, keepEvents, type Medians, snapshotEvents as snapshotTimes, type TaskCost, type TaskEvent } from "./factory_task_cost.ts";

const DOCTOR_TIMEOUT_MS = 240_000;
const USAGE_TIMEOUT_MS = 120_000;
const ACTIVITY_MAX = 200;
const HOME_RECENT = 10;
const PULLS_GONE_MAX = 100;
/** What each task took is read over this many days of logs (#580). */
export const COST_DAYS = 30;
/** The board's events read back for the tasks' claims and done times, at most. */
const COST_EVENTS = 2_000;

/** A task's cost and times as the pages show them: with its title, state and epic from the views. */
export interface CostRow extends TaskCost {
  title: string;
  state: string | null;
  epic: string | null;
}

export interface Costs {
  since: string | null;
  tasks: CostRow[];
  epics: EpicCost[];
  medians: Medians;
  problems: Problem[];
}

export interface Reply {
  status: number;
  body: Obj;
}

/** One event on the Activity page. */
export interface ActivityItem {
  /** A stable key: the board's seq, or pr-<n>-opened / pr-<n>-gone. */
  id: string;
  at: string | null;
  agent: string | null;
  kind: ActivityKind;
  text: string;
  task: string | null;
  pr: number | null;
  /** The epic its task is in (#583), or null. */
  epic: string | null;
  /** The page it opens (#583): its task (`view:tasks` with `find`), its pull request's page (`pr:<n>`), its agent's
   *  (`agent:<name>`), else `view:ci` or `view:owner-queue`. */
  link: string;
  /** The search a link opens with (`#7`). */
  find: string;
  /** What it means for the task's times (#580): a claim, or done (closed done, moved to done, its pull request merged). */
  mark?: "claimed" | "done";
}

export const ACTIVITY_KINDS = ["claim", "move", "comment", "close", "handoff", "new", "note", "agent", "pr", "ci", "review", "ask"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** What the board gives Activity for one project (factory_ui_board.ts BoardFeed.activity), or null when its tasks aren't
 *  read from the board. */
export interface BoardEvents {
  activity(p: UiProject, most: number): Promise<ActivityItem[] | null>;
  /** True while project `p`'s tasks come from the board. */
  live?(p: UiProject): boolean;
}

export interface OpsDeps {
  views: (p: UiProject) => Views;
  live: (p: UiProject) => Promise<Live>;
  queue: (p: UiProject) => Promise<Queue>;
  /** The owner queue as last read, or null (never read for this). */
  keptQueue?: (p: UiProject) => Queue | null;
  board: BoardEvents;
  publish: (m: Obj) => void;
}

function obj(v: unknown): Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {};
}

function list(v: unknown): Obj[] {
  return Array.isArray(v) ? v.map(obj) : [];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function problem(status: number, code: string, message: string, fix: string): Reply {
  return { status, body: { code, message, fix } };
}

function writeAtomic(path: string, data: unknown): void {
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // a state folder that can't be written: the answer is still kept in memory
  }
}

function snapshotOf(p: UiProject): Obj {
  return obj(readJson(join(stateDirOf(p), "snapshot.json")));
}

// --- health ------------------------------------------------------------------------------------------------------------

export type Level = "ok" | "warning" | "failed";

export interface HealthCheck {
  level: Level;
  what: string;
  fix: string;
}

export interface HealthGroup {
  id: string;
  title: string;
  checks: HealthCheck[];
}

export interface Health {
  ranAt: string | null;
  ok: boolean | null;
  counts: { ok: number; warning: number; failed: number };
  groups: HealthGroup[];
  problem: Problem | null;
}

/** The groups in the page's order, and their titles. */
export const HEALTH_GROUPS: Array<{ id: string; title: string }> = [
  { id: "machine", title: "This machine" },
  { id: "project", title: "The project" },
  { id: "board", title: "The board" },
  { id: "github", title: "GitHub" },
  { id: "ci", title: "CI runners" },
];

const LEVEL: Record<string, Level> = { ok: "ok", note: "warning", fix: "failed" };

/** The Health answer from what `factory doctor --json` printed (its `checks`), at `ranAt`. */
export function healthOf(out: Obj, ranAt: string): Health {
  const checks = list(out.checks).filter((c) => str(c.what));
  const groups = HEALTH_GROUPS.map((g) => ({ ...g, checks: checks.filter((c) => (HEALTH_GROUPS.some((x) => x.id === str(c.group)) ? str(c.group) : "project") === g.id)
    .map((c): HealthCheck => ({ level: LEVEL[str(c.level)] ?? "warning", what: str(c.what), fix: str(c.how) })) })).filter((g) => g.checks.length);
  const all = groups.flatMap((g) => g.checks);
  const count = (l: Level): number => all.filter((c) => c.level === l).length;
  return { ranAt, ok: count("failed") === 0, counts: { ok: count("ok"), warning: count("warning"), failed: count("failed") }, groups, problem: null };
}

const HEALTH_FILE = "ui-health.json";
const NO_HEALTH: Health = { ranAt: null, ok: null, counts: { ok: 0, warning: 0, failed: 0 }, groups: [], problem: null };

// --- usage -------------------------------------------------------------------------------------------------------------

interface UsageRow {
  key: string;
  title: string;
  used: number;
  tokens: { input: number; cache_write: number; cache_read: number; output: number };
  replies: number;
  budget: number | null;
  percent: number | null;
  /** ok, warn (80% of the budget or more), over (more than the budget), none (no budget to compare). */
  tone: "ok" | "warn" | "over" | "none";
  /** US dollars at Anthropic's API prices, of the replies whose model has a known price (null: none had one). */
  cost: number | null;
  /** Replies of a model without a known price. */
  unpriced: number;
}

/** What a budget counts (factory_budget.ts): fresh input (input + cache writes) + output. */
function counted(t: Obj): number {
  return num(t.input) + num(t.cache_write) + num(t.output);
}

function toneOf(used: number, budget: number | null): UsageRow["tone"] {
  if (budget === null) return "none";
  return used > budget ? "over" : used >= budget * 0.8 ? "warn" : "ok";
}

function usageRows(groups: Obj, budget: number | null, title: (key: string) => string): UsageRow[] {
  return Object.entries(groups).map(([key, g]): UsageRow => {
    const t = obj(obj(g).tokens);
    const used = counted(t);
    const replies = num(obj(g).replies);
    const unpriced = num(obj(g).unpriced_replies);
    return { key, title: title(key), used, tokens: { input: num(t.input), cache_write: num(t.cache_write), cache_read: num(t.cache_read), output: num(t.output) },
      replies, budget, percent: budget ? Math.round((used / budget) * 100) : null, tone: toneOf(used, budget),
      cost: typeof obj(g).cost_usd === "number" && replies > unpriced ? num(obj(g).cost_usd) : null, unpriced };
  }).sort((a, b) => b.used - a.used || a.key.localeCompare(b.key));
}

/** Why `factory usage` gave no JSON: its own {code, message, fix} when its last line on stderr is one, else its first
 * error line (an older factory that doesn't know `--by worker` says so there). */
function usageFailure(p: UiProject, r: { code: number; stderr: string }): Problem {
  const lines = r.stderr.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  try {
    const own = JSON.parse(lines.at(-1) ?? "") as unknown;
    const o = obj(own);
    if (typeof o.code === "string" && typeof o.message === "string") return { code: o.code, message: o.message, fix: str(o.fix) };
  } catch {
    // not JSON: say what it printed
  }
  const said = lines.find((l) => /error/i.test(l)) ?? lines[0] ?? (r.code === 0 ? "it printed no JSON" : `it ended with exit ${r.code}`);
  return { code: "ui_usage_unreadable", message: `The token counts can't be read from this machine's Claude Code logs: \`factory usage --json\` said: ${said}`,
    fix: `Run \`factory usage --json\` in ${p.path} to see the whole error. When it doesn't know an option, that folder runs an older factory: ` +
      "bring it up to date (Bring this machine up to date on Factory settings, or `factory update`)." };
}

/** Problems `factory usage --json` reported itself (no logs found, a folder it can't read). */
function usageProblems(report: Obj | null): Problem[] {
  return list(report?.problems).filter((x) => typeof x.code === "string" && typeof x.message === "string")
    .map((x) => ({ code: str(x.code), message: str(x.message), fix: str(x.fix) }));
}

/** budget.builder from the project's factory.json: a task's budget when its issue has no Budget: line. */
function builderBudget(p: UiProject): number | null {
  const v = obj(p.config?.budget).builder;
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

/** Claude's limit windows (#614), from `factory usage --window --json`: the last 5 hours and the last 7 days per agent,
 *  the soft budget and the limit the loops wait on (its time as seconds since 1970). */
function windowOf(w: Obj): Obj {
  const limit = obj(w.limit);
  return { since5h: str(w.window && obj(w.window).since) || null, since7d: str(w.week && obj(w.week).since) || null,
    agents: list(w.agents).map((a) => ({ agent: str(a.agent), window: num(a.window), week: num(a.week) })),
    total: { window: num(obj(w.total).window), week: num(obj(w.total).week) },
    softTokens5h: typeof w.softTokens5h === "number" ? w.softTokens5h : null, over: w.over === true,
    limitUntil: typeof limit.until === "number" ? limit.until : null };
}

/** What the Usage page says isn't measured (yet). */
export const NOT_MEASURED = [
  "Money: cost is at Anthropic's API prices, only for models whose prices the factory knows (add one with usage.prices); a subscription isn't billed per token.",
  "Other machines: each machine reads only its own Claude Code logs, so an agent on another machine isn't counted here.",
  "A task's own Budget: line: reading it costs GitHub calls per task, so every task is compared with budget.builder.",
  "An agent's own budget: budgets are per task; an agent's total is shown without one.",
];

// --- activity ----------------------------------------------------------------------------------------------------------

interface SeenPull {
  title: string;
  agent: string | null;
  task: string | null;
  /** Its CI and review as last seen (#583); left out by an older server, so nothing is told for it the first time. */
  ci?: string | null;
  review?: string | null;
}

interface Seen {
  open: Record<string, SeenPull>;
  gone: Array<{ number: number; title: string; agent: string | null; task: string | null; at: string }>;
  /** The CI and review changes seen between two snapshots (#583), newest first. */
  changes: ActivityItem[];
}

const SEEN_FILE = "ui-pulls-seen.json";

/** A pull request's CI as the snapshot gives it, when it is news: passed or failed. */
const CI_WORDS: Record<string, string> = { green: "passed", red: "failed" };
/** A review marker on a pull request's head, when it is news. */
const REVIEW_WORDS: Record<string, string> = { "factory-approved": "was approved", "factory-mustfix": "got must-fixes" };

/** What changed in the snapshot's open pull requests since the server first looked (kept in ui-pulls-seen.json): those
 *  that left the list (merged or closed, the snapshot can't tell which), and each one whose CI passed or failed or whose
 *  head was reviewed (#583). The first look only keeps what it saw. */
function pullsSeen(p: UiProject, snap: Obj): Pick<Seen, "gone" | "changes"> {
  const path = join(stateDirOf(p), SEEN_FILE);
  const kept = obj(readJson(path));
  const keptGone = Array.isArray(kept.gone) ? (kept.gone as Seen["gone"]) : [];
  const keptChanges = Array.isArray(kept.changes) ? (kept.changes as ActivityItem[]) : [];
  if (!Array.isArray(snap.pulls)) return { gone: keptGone, changes: keptChanges }; // not read: nothing is known to have changed
  const pulls = list(snap.pulls).filter((x) => typeof x.number === "number");
  const before: Seen = { open: obj(kept.open) as Seen["open"], gone: keptGone, changes: keptChanges };
  const first = !existsSync(path);
  const now: Seen["open"] = {};
  for (const x of pulls) {
    now[String(x.number)] = { title: str(x.title), agent: str(x.agent) || null, task: branchTask(str(x.branch)), ci: str(x.ci) || null,
      review: str(x.review) || null };
  }
  const at = str(snap.generatedAt) || new Date().toISOString();
  const gone = first ? [] : Object.entries(before.open).filter(([n]) => !(n in now))
    .map(([n, x]) => ({ number: Number(n), title: str(x.title), agent: x.agent ?? null, task: x.task ?? null, at }));
  const changes: ActivityItem[] = [];
  for (const [n, x] of first ? [] : Object.entries(now)) {
    const was = before.open[n];
    if (!was) continue;
    const pr = Number(n);
    const base = { at, agent: x.agent, task: x.task, pr, epic: null, link: `pr:${pr}`, find: "" };
    const ci = x.ci ? CI_WORDS[x.ci] : undefined;
    if ("ci" in was && was.ci !== x.ci && ci) changes.push({ ...base, id: `pr-${pr}-ci-${x.ci}-${at}`, kind: "ci", text: `CI ${ci} on PR #${pr}` });
    const review = x.review ? REVIEW_WORDS[x.review] : undefined;
    if ("review" in was && was.review !== x.review && review) {
      changes.push({ ...base, id: `pr-${pr}-review-${x.review}-${at}`, kind: "review", text: `PR #${pr} ${review}` });
    }
  }
  const next: Seen = { open: now, gone: [...gone, ...before.gone].slice(0, PULLS_GONE_MAX),
    changes: [...changes, ...before.changes].slice(0, PULLS_GONE_MAX) };
  if (first || gone.length || changes.length || JSON.stringify(now) !== JSON.stringify(before.open)) writeAtomic(path, next);
  return { gone: next.gone, changes: next.changes };
}

/** What the snapshot knows as events: each open pull request (when it was opened), each one gone since, its CI and
 *  review changes, the failed CI runs and the owner's asks, at the times the snapshot gives. No GitHub call. */
function snapshotEvents(p: UiProject, snap: Obj, board: boolean): ActivityItem[] {
  const out: ActivityItem[] = [];
  const at = Date.parse(str(snap.generatedAt));
  const before = (minutes: number): string | null => (Number.isNaN(at) ? null : new Date(at - minutes * 60_000).toISOString());
  for (const x of list(snap.pulls).filter((r) => typeof r.number === "number")) {
    const n = num(x.number);
    const task = branchTask(str(x.branch));
    out.push({ id: `pr-${n}-opened`, at: str(x.createdAt) || null, agent: str(x.agent) || null, kind: "pr", text: `opened PR #${n}: ${str(x.title)}`,
      task, pr: n, epic: null, link: `pr:${n}`, find: "" });
  }
  const seen = pullsSeen(p, snap);
  for (const g of seen.gone) {
    out.push({ id: `pr-${g.number}-gone-${g.at}`, at: g.at, agent: g.agent, kind: "pr", text: `PR #${g.number} is no longer open (merged or closed): ${g.title}`,
      task: g.task, pr: g.number, epic: null, link: `pr:${g.number}`, find: "" });
  }
  out.push(...seen.changes);
  for (const r of list(obj(snap.ci).runs)) {
    if (!["failure", "timed_out", "startup_failure"].includes(str(r.state))) continue;
    const pr = /^#(\d+)$/.exec(str(r.ref));
    out.push({ id: `ci-${str(r.id) || str(r.ref)}`, at: before(num(r.minutesAgo)), agent: null, kind: "ci",
      text: `${str(r.name) || "CI"} failed on ${pr ? `PR #${pr[1]}` : str(r.branch) || str(r.ref)}`, task: branchTask(str(r.branch)),
      pr: pr ? Number(pr[1]) : null, epic: null, link: pr ? `pr:${pr[1]}` : "view:ci", find: pr ? "" : str(r.ref) });
  }
  if (!board) {
    for (const a of list(snap.needsYou).filter((x) => x.kind === "owner-ask")) {
      out.push({ id: `ask-${str(a.id)}`, at: a.ageMinutes === null || a.ageMinutes === undefined ? null : before(num(a.ageMinutes)), agent: null, kind: "ask",
        text: `asked you: ${str(a.text).split("\n")[0]?.slice(0, 200) ?? ""}`, task: null, pr: null, epic: null, link: "view:owner-queue", find: "" });
    }
  }
  return out;
}

/** What a pull request event from the snapshot is (opened, gone, a CI or review change), to leave out what the board's
 *  own pull request feed already told (#583); "" for anything else. */
function prWhat(x: ActivityItem): string {
  if (x.pr === null) return "";
  if (x.id.startsWith("board-")) return x.kind === "ci" ? "ci" : /^opened /.test(x.text) ? "opened" : /^(merged|closed) /.test(x.text) ? "gone" : "";
  return x.id.endsWith("-opened") ? "opened" : x.id.includes("-gone-") ? "gone" : x.id.includes("-ci-") ? "ci" : "";
}

/** `<pr>:<what>` for a pull request event (prWhat), "" for any other. */
function prKey(x: ActivityItem): string {
  const what = prWhat(x);
  return what ? `${x.pr}:${what}` : "";
}

const SNAPSHOT_ONLY: Problem = { code: "ui_activity_snapshot",
  message: "The tasks are kept as GitHub issues, so claims, moves, comments and agents starting or going down aren't recorded here. This shows what the last snapshot knows: pull requests with their CI and reviews, failed CI runs and the asks waiting for you.",
  fix: "Move the tasks to the message board to see every claim, move, comment and agent as it happens." };

/** The board's order for its own events (`board-<seq>`): one transaction gives several the same time. */
function seqOf(x: ActivityItem): number {
  return x.id.startsWith("board-") ? Number(x.id.slice(6)) || 0 : 0;
}

function newestFirst(a: ActivityItem, b: ActivityItem): number {
  return (b.at ?? "").localeCompare(a.at ?? "") || seqOf(b) - seqOf(a);
}

// --- the pages' API ----------------------------------------------------------------------------------------------------

export class Ops {
  private health = new Map<string, { value: Health; at: number }>();
  private running = new Map<string, Promise<Health>>();
  private usage = new Map<string, { value: Obj; at: number }>();
  private usageReading = new Map<string, Promise<Obj>>();

  constructor(private readonly d: OpsDeps) {}

  /** The reply to a Health, Usage, Activity or Home request (after the token), or null when the path is none of theirs. */
  async api(req: Request, p: UiProject, rest: string[], url: URL): Promise<Reply | null> {
    const page = rest[0] ?? "";
    if (!["health", "usage", "activity", "home", "attention", "costs"].includes(page)) return null;
    if (page === "health" && rest.length === 2 && rest[1] === "check") {
      if (req.method !== "POST") return problem(405, "method_not_allowed", `${req.method} isn't used here.`, "Use POST.");
      const h = await this.check(p);
      return { status: h.problem && !h.ranAt ? 500 : 200, body: { project: p.id, command: "factory doctor --json", ...this.healthBody(p, h) } };
    }
    if (rest.length !== 1) return problem(404, "not_found", `There is no ${url.pathname}.`, "Health has GET and POST .../health/check; Usage, Activity, Home, Attention and Costs are GET.");
    if (req.method !== "GET") return problem(405, "method_not_allowed", `${req.method} isn't used here.`, "Use GET.");
    if (p.problem) return { status: 200, body: { project: p.id, problems: [p.problem] } };
    if (page === "health") return { status: 200, body: { project: p.id, command: "factory doctor --json", ...this.healthBody(p, this.kept(p)) } };
    if (page === "usage") {
      // what each task took is never waited for (#580): the kept rows now, a read started in the background when old
      const c = this.keptCosts(p);
      const u = await this.usageOf(p);
      const seen = new Set<string>();
      const problems = [...(Array.isArray(u.problems) ? (u.problems as Problem[]) : []), ...(c?.problems ?? [])].filter((x) => {
        const k = `${x.code} ${x.message}`;
        return seen.has(k) ? false : (seen.add(k), true);
      });
      return { status: 200, body: { project: p.id, ...u, byTask: c?.tasks ?? null, byTaskUpdating: this.costsReading.has(p.id), problems } };
    }
    if (page === "costs") return { status: 200, body: { project: p.id, ...(await this.costsOf(p)) } };
    if (page === "attention") {
      const live = await this.d.live(p); // the costs as kept: a slow `factory usage` never holds the answer (#580)
      return { status: 200, body: { project: p.id, items: this.attention(p, live), limits: limitsOf(p.config) } };
    }
    if (page === "activity") {
      const a = await this.activity(p);
      const want = (k: string): string => (url.searchParams.get(k) ?? "").trim().replace(/^#/, "");
      const [agent, task, epic, kind] = [want("agent"), want("task"), want("epic"), want("kind")];
      const items = a.items.filter((x) => (!agent || x.agent === agent) && (!task || x.task === task || (x.pr !== null && String(x.pr) === task))
        && (!epic || x.epic === epic) && (!kind || x.kind === kind));
      const titles = new Map(this.d.views(p).epics.epics.map((e) => [e.id, e.title]));
      const epics = [...new Set(a.items.map((x) => x.epic).filter((x): x is string => !!x))].sort((x, y) => Number(x) - Number(y) || x.localeCompare(y))
        .map((id) => ({ id, title: titles.get(id) ?? "" }));
      return { status: 200, body: { project: p.id, from: a.from, items, agents: [...new Set(a.items.map((x) => x.agent).filter((x): x is string => !!x))].sort(),
        kinds: ACTIVITY_KINDS.filter((k) => a.items.some((x) => x.kind === k)), epics, filter: { agent, task, kind, ...(epic ? { epic } : {}) }, problems: a.problems } };
    }
    return { status: 200, body: { project: p.id, ...(await this.home(p)) } };
  }

  // --- health ------------------------------------------------------------------------------------------------------

  private healthBody(p: UiProject, h: Health): Obj {
    const at = h.ranAt ? Date.parse(h.ranAt) : NaN;
    return { ...h, age: Number.isNaN(at) ? null : Math.max(Math.round((Date.now() - at) / 1000), 0), running: this.running.has(p.id),
      problems: h.problem ? [h.problem] : [] };
  }

  /** The kept result: in memory, else the state folder's; with none, a run is started (once) in the background. */
  private kept(p: UiProject): Health {
    let k = this.health.get(p.id);
    if (!k) {
      const file = obj(readJson(join(stateDirOf(p), HEALTH_FILE)));
      if (Array.isArray(file.groups)) {
        k = { value: file as unknown as Health, at: Date.parse(str(file.ranAt)) || 0 };
        this.health.set(p.id, k);
      }
    }
    if (!k && !p.problem) void this.check(p);
    return k?.value ?? NO_HEALTH;
  }

  /** Runs `factory doctor --json` in project `p`, or waits for the run under way. */
  check(p: UiProject): Promise<Health> {
    const busy = this.running.get(p.id);
    if (busy) return busy;
    const job = this.doctor(p).finally(() => {
      this.running.delete(p.id);
      this.d.publish({ type: "health", project: p.id });
    });
    this.running.set(p.id, job);
    return job;
  }

  private async doctor(p: UiProject): Promise<Health> {
    if (p.problem) return { ...NO_HEALTH, problem: p.problem };
    const r = await spawn(["bash", factoryScript(p), "doctor", "--json"], p.path, envFor(p), DOCTOR_TIMEOUT_MS);
    let out: Obj | null = null;
    try {
      const parsed = JSON.parse(r.stdout) as unknown;
      if (Array.isArray(obj(parsed).checks)) out = obj(parsed);
    } catch {
      // said below
    }
    if (!out) {
      const last = (r.stderr.trim() || r.stdout.trim()).split("\n").at(-1) ?? "";
      const before = this.health.get(p.id)?.value ?? NO_HEALTH;
      const failed: Health = { ...before, problem: { code: "ui_doctor_unreadable", message: `The checks didn't give a result (${last.slice(0, 200) || `exit ${r.code}`}).`,
        fix: `Run the factory's doctor in ${p.path} to see the whole error; the project may run an older release.` } };
      this.health.set(p.id, { value: failed, at: Date.now() }); // kept too: a look doesn't start another run, only Check again does
      return failed;
    }
    const h = healthOf(out, new Date().toISOString());
    this.health.set(p.id, { value: h, at: Date.now() });
    writeAtomic(join(stateDirOf(p), HEALTH_FILE), h);
    return h;
  }

  // --- usage -------------------------------------------------------------------------------------------------------

  private usageOf(p: UiProject): Promise<Obj> {
    const k = this.usage.get(p.id);
    if (k && Date.now() - k.at <= ttl() * 1000) return Promise.resolve({ ...k.value, age: Math.round((Date.now() - k.at) / 1000) });
    const busy = this.usageReading.get(p.id);
    if (busy) return busy;
    const job = this.readUsage(p).then((value) => {
      this.usage.set(p.id, { value, at: Date.now() });
      return { ...value, age: 0 };
    }).finally(() => this.usageReading.delete(p.id));
    this.usageReading.set(p.id, job);
    return job;
  }

  private async readUsage(p: UiProject): Promise<Obj> {
    const run = (args: string[]) => spawn(["bash", factoryScript(p), "usage", ...args], p.path, envFor(p), USAGE_TIMEOUT_MS);
    const [byTask, byWorker, github, windows] = await Promise.all([run(["--json"]), run(["--json", "--by", "worker"]), run(["--github", "--json"]),
      run(["--window", "--json"])]);
    const parse = (r: { stdout: string }): Obj | null => {
      try {
        const v = JSON.parse(r.stdout) as unknown;
        return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : null;
      } catch {
        return null;
      }
    };
    const problems: Problem[] = [];
    const tasks = parse(byTask);
    const workers = parse(byWorker);
    const calls = parse(github);
    const win = parse(windows); // an older factory without --window: no window section, nothing said
    if (!tasks) problems.push(usageFailure(p, byTask));
    else if (!workers) problems.push(usageFailure(p, byWorker));
    problems.push(...usageProblems(tasks));
    if (!calls) problems.push({ code: "ui_github_calls_unreadable", message: "The GitHub calls of the last hour can't be read.", fix: `Check the state folder ${stateDirOf(p)} is readable.` });
    const budget = builderBudget(p);
    const titles = new Map<string, string>();
    for (const t of this.d.views(p).tasks.tasks) titles.set(t.id, t.title);
    for (const t of list(obj(snapshotOf(p).tasks).tasks)) if (!titles.has(str(t.id))) titles.set(str(t.id), str(t.title));
    const taskRows = usageRows(obj(tasks?.groups), budget, (k) => (k === "-" ? "No task" : titles.get(k) ?? ""));
    const agentRows = usageRows(obj(workers?.groups), null, (k) => k);
    const dayRows = usageRows(obj(tasks?.days), null, (k) => k).sort((a, b) => a.key.localeCompare(b.key));
    const total = obj(tasks?.total);
    const replies = num(total.replies);
    const unpriced = num(total.unpriced_replies);
    return { since: str(tasks?.since) || null, until: str(tasks?.until) || null, measured: replies > 0,
      total: { used: counted(obj(total.tokens)), replies, tasks: Array.isArray(total.tasks) ? total.tasks.length : 0,
        cost: typeof total.cost_usd === "number" && replies > unpriced ? total.cost_usd : null, unpriced },
      pricesAsOf: str(tasks?.prices_as_of) || null, days: dayRows,
      looked: list(tasks?.looked).map((l) => ({ dir: str(l.dir), why: str(l.why), state: str(l.state), folders: Array.isArray(l.folders) ? l.folders.length : 0 })),
      budget: { tokens: budget, source: budget ? "budget.builder in .claude/factory.json" : null, warnPercent: 80 },
      tasks: taskRows, agents: agentRows,
      github: calls ? { total: num(calls.total), since: str(calls.since) || null, agents: obj(calls.agents), commands: obj(calls.commands),
        endpoints: obj(calls.endpoints), account: calls.github ?? null } : null,
      window: win ? windowOf(win) : null, notMeasured: NOT_MEASURED, problems };
  }

  // --- what each task took (#580) ------------------------------------------------------------------------------------

  private costs = new Map<string, { value: Costs; at: number }>();
  private costsReading = new Map<string, Promise<Costs>>();

  /** What each task took in project `p`: kept for the snapshot cache's time, read again after (one read at a time). */
  costsOf(p: UiProject): Promise<Costs> {
    const k = this.costs.get(p.id);
    if (k && Date.now() - k.at <= ttl() * 1000) return Promise.resolve(k.value);
    const busy = this.costsReading.get(p.id);
    if (busy) return busy;
    const job = this.readCosts(p).then((value) => {
      this.costs.set(p.id, { value, at: Date.now() });
      return value;
    }).finally(() => {
      this.costsReading.delete(p.id);
      this.d.publish({ type: "costs", project: p.id }); // Needs attention is pushed again on the next tick when it changed
    });
    this.costsReading.set(p.id, job);
    return job;
  }

  /** The costs last read for `p`, or null; a read is started when there are none or they are old. */
  private keptCosts(p: UiProject): Costs | null {
    const k = this.costs.get(p.id);
    if ((!k || Date.now() - k.at > ttl() * 1000) && !p.problem) void this.costsOf(p).catch(() => null);
    return k?.value ?? null;
  }

  private async readCosts(p: UiProject): Promise<Costs> {
    const views = this.d.views(p);
    const empty: Costs = { since: null, tasks: [], epics: [], medians: { done: 0, used: null, workingMinutes: null }, problems: [] };
    if (p.problem) return { ...empty, problems: [p.problem] };
    // the board's claims and done times, and the snapshot's CI runs and must-fixes, kept so they outlast both
    const board = await this.d.board.activity(p, COST_EVENTS).catch(() => null);
    const marked = board ? this.placed(p, board) : [];
    const events: TaskEvent[] = marked.filter((x) => x.mark && x.task && x.at)
      .map((x) => ({ id: x.id, task: x.task as string, kind: x.mark as "claimed" | "done", at: x.at as string }));
    keepEvents(stateDirOf(p), [...events, ...snapshotTimes(snapshotOf(p))]);
    const since = new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000 - (COST_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
    const r = await spawn(["bash", factoryScript(p), "usage", "--json", "--by", "task", "--since", since], p.path, envFor(p), USAGE_TIMEOUT_MS);
    let report: Obj | null = null;
    try {
      const v = JSON.parse(r.stdout) as unknown;
      if (Array.isArray(obj(v).task_costs)) report = obj(v);
    } catch {
      report = null;
    }
    if (!report) return { ...empty, problems: [usageFailure(p, r)] };
    const rows = new Map<string, { title: string; state: string; epic: string | null }>();
    for (const t of [...views.tasks.tasks, ...views.tasks.done]) if (!rows.has(t.id)) rows.set(t.id, { title: t.title, state: t.state, epic: t.epic });
    const epicOf = new Map<string, string>();
    for (const e of views.epics.epics) for (const t of e.tasks) epicOf.set(t.id, e.id);
    const titles = new Map<string, string>();
    for (const t of list(obj(snapshotOf(p).tasks).tasks)) titles.set(str(t.id), str(t.title));
    const costs = (report.task_costs as unknown[]).map((x) => x as TaskCost);
    const tasks: CostRow[] = costs.map((c) => {
      const row = rows.get(c.task);
      return { ...c, title: row?.title ?? titles.get(c.task) ?? "", state: row?.state ?? null, epic: row?.epic ?? epicOf.get(c.task) ?? null };
    });
    const m = obj(report.medians);
    const medianOf = (v: unknown): number | null => (typeof v === "number" ? v : null);
    return { since: str(report.since) || null, tasks, epics: views.epics.epics.map((e) => epicCost(e.id, e.tasks.map((t) => t.id), costs)),
      medians: { done: num(m.done), used: medianOf(m.used), workingMinutes: medianOf(m.workingMinutes) }, problems: usageProblems(report) };
  }

  // --- activity ----------------------------------------------------------------------------------------------------

  private async activity(p: UiProject): Promise<{ from: "board" | "snapshot"; items: ActivityItem[]; problems: Problem[] }> {
    const snap = snapshotOf(p);
    const fromBoard = await this.d.board.activity(p, ACTIVITY_MAX * 2).catch(() => null);
    this.noteTold(p, fromBoard ?? []);
    const told = this.toldBy.get(p.id) ?? new Set<string>();
    const fromSnapshot = snapshotEvents(p, snap, fromBoard !== null).filter((x) => !told.has(prKey(x)));
    const items = this.placed(p, [...(fromBoard ?? []), ...fromSnapshot], snap).sort(newestFirst).slice(0, ACTIVITY_MAX);
    const problems: Problem[] = [];
    if (fromBoard === null) problems.push(SNAPSHOT_ONLY);
    if (!Object.keys(snap).length) {
      problems.push({ code: "ui_no_snapshot", message: `${p.name} has no snapshot yet; one is being read.`, fix: "Wait a minute; the page fills in by itself." });
    }
    return { from: fromBoard === null ? "snapshot" : "board", items, problems };
  }

  /** `items` with what the server already holds filled in (#583): a pull request's agent and task from the snapshot's
   *  pull requests (open or gone), and each one's epic from the views. No GitHub call. */
  private placed(p: UiProject, items: ActivityItem[], snap: Obj = snapshotOf(p)): ActivityItem[] {
    const views = this.d.views(p);
    const epicOf = new Map<string, string>();
    for (const e of views.epics.epics) for (const t of e.tasks) epicOf.set(t.id, e.id);
    for (const t of views.tasks.tasks) if (t.epic) epicOf.set(t.id, t.epic);
    const pulls = new Map<number, { agent: string | null; task: string | null }>();
    const kept = obj(readJson(join(stateDirOf(p), SEEN_FILE)));
    for (const [n, x] of Object.entries(obj(kept.open))) pulls.set(Number(n), { agent: str(obj(x).agent) || null, task: str(obj(x).task) || null });
    for (const g of list(kept.gone)) pulls.set(num(g.number), { agent: str(g.agent) || null, task: str(g.task) || null });
    for (const x of list(snap.pulls)) pulls.set(num(x.number), { agent: str(x.agent) || null, task: branchTask(str(x.branch)) });
    return items.map((x) => {
      const pr = x.pr === null ? undefined : pulls.get(x.pr);
      const task = x.task ?? pr?.task ?? null;
      const agent = x.agent ?? pr?.agent ?? null;
      return { ...x, agent, task, epic: task ? epicOf.get(task) ?? null : null };
    });
  }

  /** The board's new events for project `p`, as the WebSocket pushes them (#583): the same entries the page reads. */
  pushed(p: UiProject, items: ActivityItem[]): ActivityItem[] {
    this.noteTold(p, items);
    return this.placed(p, items).sort(newestFirst);
  }

  private snapshotSent = new Map<string, Set<string>>();
  /** Per project, the pull request events the board's own feed told (`<pr>:opened|gone|ci`, prKey), so the snapshot's
   *  copy of one is neither listed nor pushed again (#583). */
  private toldBy = new Map<string, Set<string>>();

  private noteTold(p: UiProject, fromBoard: ActivityItem[]): void {
    const keys = fromBoard.filter((x) => x.id.startsWith("board-")).map(prKey).filter((k) => k !== "");
    if (!keys.length) return;
    let told = this.toldBy.get(p.id);
    if (!told) this.toldBy.set(p.id, (told = new Set()));
    for (const k of keys) told.add(k);
  }

  /** The snapshot's events for project `p` the WebSocket hasn't pushed yet (#583); the first call only keeps what there
   *  is, so an open page gets what is new, not everything again. Reads the snapshot's cache, no GitHub call. */
  freshFromSnapshot(p: UiProject): ActivityItem[] {
    if (p.problem) return [];
    const snap = snapshotOf(p);
    if (!Object.keys(snap).length) return [];
    const all = snapshotEvents(p, snap, this.d.board.live?.(p) ?? false);
    const sent = this.snapshotSent.get(p.id);
    this.snapshotSent.set(p.id, new Set([...(sent ?? []), ...all.map((x) => x.id)]));
    if (!sent) return [];
    const told = this.toldBy.get(p.id) ?? new Set<string>();
    return this.placed(p, all.filter((x) => !sent.has(x.id) && !told.has(prKey(x))), snap).sort(newestFirst);
  }

  // --- needs attention (#579) ----------------------------------------------------------------------------------------

  /** What needs attention in project `p`, from what the server holds: the views, `live` (null: not read yet, so no agent
   *  case is judged), the pull requests gone from the snapshot, and the product owner's open asks. No GitHub call. */
  attention(p: UiProject, live: Live | null): AttentionItem[] {
    if (p.problem) return [];
    const snap = snapshotOf(p);
    const kept = this.d.keptQueue?.(p) ?? null;
    const productAsks = kept && !kept.problem ? kept.asks.filter((a) => a.state === "open" && a.forProduct).length
      : list(snap.needsYou).filter((x) => x.kind === "owner-ask" && str(x.state) === "product").length;
    const readable = live !== null && !live.problems.some((x) => x.code === "ui_agents_unreadable");
    const costs = this.keptCosts(p);
    return attentionOf({ config: p.config, views: this.d.views(p), agents: readable ? live.agents : null,
      gone: pullsSeen(p, snap).gone.map((g) => ({ number: g.number, title: g.title, task: g.task, at: g.at })), productAsks,
      costs: costs && !costs.problems.some((x) => x.code === "ui_usage_unreadable") ? costs : null,
      claudeLimit: claudeLimitOf(stateDirOf(p), Date.now() / 1000), softBudget: this.keptSoftBudget(p) });
  }

  /** The last 5 hours against claudeLimit.softTokens5h (#614), from the usage as kept; a read is started in the
   *  background when it is old, never waited for. Null when the budget is off or nothing is kept yet. */
  private keptSoftBudget(p: UiProject): { used: number; budget: number } | null {
    const budget = obj(p.config?.claudeLimit).softTokens5h;
    if (typeof budget !== "number" || budget <= 0 || p.problem) return null;
    const k = this.usage.get(p.id);
    if ((!k || Date.now() - k.at > ttl() * 1000) && !this.usageReading.has(p.id)) void this.usageOf(p).catch(() => null);
    const w = obj(k?.value.window);
    const used = obj(w.total).window;
    return typeof used === "number" ? { used, budget } : null;
  }

  // --- home --------------------------------------------------------------------------------------------------------

  private async home(p: UiProject): Promise<Obj> {
    const snap = snapshotOf(p);
    const views = this.d.views(p);
    const [live, queue, act] = await Promise.all([this.d.live(p), this.d.queue(p).catch(() => null), this.activity(p)]);
    const needs: Obj[] = [];
    // asks nobody answered: the owner queue as the Inbox reads it, else the snapshot's
    const asks = queue && !queue.problem ? queue.asks.filter((a) => a.state === "open" && !a.forProduct).map((a) => ({ id: a.id, text: a.text, created: a.created }))
      : list(snap.needsYou).filter((x) => x.kind === "owner-ask" && str(x.state) !== "product")
        .map((x) => ({ id: str(x.id), text: str(x.text), created: null }));
    for (const a of asks) {
      needs.push({ kind: "ask", title: a.text.split("\n")[0]?.slice(0, 200) || "An ask waits for your answer", sub: "Asked on the owner queue; nobody has answered.",
        link: "view:owner-queue", find: "", action: "Answer" });
    }
    for (const pr of views.pulls.pulls.filter((x) => x.next.action === "owner-merges")) {
      needs.push({ kind: "merge", title: `Merge PR #${pr.number}? ${pr.title}`, sub: `Only a person merges it: ${pr.next.text}.`, link: "view:pull-requests",
        find: `#${pr.number}`, action: "Review and merge" });
    }
    const reasons = new Map<string, string>();
    for (const e of [...act.items].reverse()) if (e.kind === "move" && e.task && / to blocked/.test(e.text)) reasons.set(e.task, e.text.replace(/^.* to blocked:? ?/, ""));
    for (const t of views.tasks.tasks.filter((x) => x.state === "blocked")) {
      const why = t.blockedBy.length ? `Waits for ${t.blockedBy.map((b) => (/^\d+$/.test(b) ? `#${b}` : b)).join(", ")}.` : reasons.get(t.id) || "Blocked; its reason is on the task.";
      needs.push({ kind: "blocked", title: `#${t.id} ${t.title}`, sub: why, link: "view:tasks", find: `#${t.id}`, action: "Open" });
    }
    const main = p.config?.mainBranch || "main";
    const onMain = views.ci.runs.filter((r) => r.branch === main || r.ref === main);
    const newest = [...onMain].sort((a, b) => a.minutesAgo - b.minutesAgo)[0];
    if (newest?.failed) {
      needs.push({ kind: "ci", title: `CI failed on ${main}`, sub: `${newest.name}, ${newest.minutesAgo} min before the last read.`, link: "view:ci", find: "", action: "Open" });
    }
    const h = this.health.get(p.id)?.value ?? (() => {
      const file = obj(readJson(join(stateDirOf(p), HEALTH_FILE)));
      return Array.isArray(file.groups) ? (file as unknown as Health) : null;
    })();
    const failed = h ? h.groups.flatMap((g) => g.checks.filter((c) => c.level === "failed").map((c) => ({ what: c.what, fix: c.fix })))
      : (Array.isArray(obj(snap.doctor).fix) ? (obj(snap.doctor).fix as unknown[]).map(str) : []).map((line) => {
        const i = line.indexOf(": ");
        return i > 0 ? { what: line.slice(0, i), fix: line.slice(i + 2) } : { what: line, fix: "" };
      });
    for (const f of failed) needs.push({ kind: "health", title: f.what, sub: f.fix, link: "page:health", find: "", action: "Open" });
    // every role the settings name, as the sidebar lists them; one with no live row is down (#609)
    const byName = new Map(live.agents.map((a: Agent) => [a.name, a]));
    const team = channels(p, live.agents).filter((c) => c.kind === "agent").map((c) => {
      const a = byName.get(c.name);
      return a ? { name: a.name, role: a.role, state: a.state, detail: a.detail, task: a.task, taskTitle: a.taskTitle,
        machine: a.machineName ?? a.machine, link: `agent:${a.name}` }
        : { name: c.name, role: c.role ?? "", state: "down", detail: "not running", task: null, taskTitle: null, machine: null, link: `agent:${c.name}` };
    });
    const epics = views.epics.epics.map((e) => ({ id: e.id, title: e.title, done: e.done, all: e.all, stage: e.stage }));
    const inEpics = new Set(views.epics.epics.flatMap((e) => e.tasks.map((t) => t.id)));
    const loose = views.tasks.tasks.filter((t) => !inEpics.has(t.id) && t.epic === null);
    const done = epics.reduce((n, e) => n + e.done, 0) + loose.filter((t) => t.state === "done").length;
    const all = epics.reduce((n, e) => n + e.all, 0) + loose.length;
    return { attention: this.attention(p, live), needs, team, progress: { done, all, epics, noEpic: { done: loose.filter((t) => t.state === "done").length, all: loose.length } },
      recent: act.items.slice(0, HOME_RECENT), activityFrom: act.from, limit: live.limit,
      problems: [...live.problems, ...(queue?.problem ? [queue.problem] : []), ...views.problems] };
  }
}
