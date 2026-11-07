#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// `factory usage`: how many tokens the factory's sessions used, per task, from Claude Code's own session logs on
// this machine. Use it to measure a change to the factory (a cheaper model, less reading) before and after.
//
//   factory usage                       the last 7 days, per task, then the totals
//   factory usage --since 2026-10-20 --until 2026-10-24
//   factory usage --by agent            per subagent type (reviewer, test-writer, ...) instead of per task
//   factory usage --by worker           per agent: the folder each session ran in (`<project>-agents/<name>` is <name>,
//                                       the project folder itself "(project folder)": your own sessions, and the first
//                                       builder's from releases before #572)
//   factory usage --by role             manager (sessions that start with /manage-pass, or end with a `factory-role` line naming
//                                       the dev manager), product-owner (that line names it) against builder (all others)
//   factory usage --by day              per day (UTC) of each reply
//   factory usage --json                the same as JSON, with each group's cost, the days, each session (its id, task,
//                                       where the task came from, agent, role, first and last reply, tokens, cost: the
//                                       shape a cost per task joins on), the folders looked in and any problem
//   factory usage --task 96 --markdown  one task's tokens per subagent, as a PR comment (the next-task skill posts it);
//                                       with a budget (#183) it adds used against budget and the top subagent
//   factory usage --task 96 --budget    the checkpoint: used, budget, what is left and the percent; a warning from 80%.
//                                       Always exit 0: a budget is advice (factory_budget.ts says where it comes from)
//   factory usage --github [--json]     this machine's GitHub calls in the last hour (#371), by agent, command and
//                                       endpoint, biggest first, and what GitHub counts on the account (factory_lib.ts
//                                       counts them; the other options don't apply)
//   factory usage --record "label"      also append a dated summary row to the usage log (`usageLog` in
//                                       factory.json, default docs/factory-usage.md), to commit in a PR
//
// Reads Claude Code's logs of the project folder, every agent's worktree and every other worktree of the repository
// (factory_usage_logs.ts says where it looks: yours, the project folder's owner's and `usage.logFolders`), the same
// from the project folder or an agent's worktree: <log folder>/*.jsonl and their subagents/*.jsonl. Each model reply
// is counted once (by message id). A session belongs to the task whose branch (`task/<n>-...`) it spent most replies
// on, else the task its first prompt names (a dev manager's sub-manager: `Task issue: #n`, `on branch task/<n>-`,
// `/manage-pass issue-<n>`). When no log is found it says where it looked and why (`usage_no_logs`). Nothing leaves the
// machine; the log row holds only totals.
//
// Tokens are reported as Claude reports them: input (not cached), cache writes, cache reads, output. "Fresh input"
// is input + cache writes: what had to be read without a cache hit. Cost is in US dollars at Anthropic's API prices,
// for the models whose prices are known (factory_usage_logs.ts, plus `usage.prices`); replies of other models are
// counted as unpriced. A subscription isn't billed per token, so the cost is what the same work costs on the API.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { COUNTED, short, taskBudget, WARN_PERCENT } from "./factory_budget.ts";
import { type Config, load } from "./factory_config.ts";
import { die, githubCallsLastHour, pyDumps, pyRepr, runMain, splitLines } from "./factory_lib.ts";
import { costOf, findLogs, listLogs, logBases, type Looked, type Price, PRICES_AS_OF, pricesFrom, type Problem, problemsOf,
  PROJECT_FOLDER, type Scope, scopeOf, belongs, workerOf } from "./factory_usage_logs.ts";
import { limitStatus } from "./factory_views_cache.ts";

export { PROJECT_FOLDER };

const TASK = /^task\/(\d+(?:[.-]\d+)*?)-/;
export const FIELDS = ["input", "cache_write", "cache_read", "output"] as const;
export type Tokens = { input: number; cache_write: number; cache_read: number; output: number };
type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

interface Reply {
  id: unknown;
  ts: string;
  branch: string;
  model: string;
  usage: Obj;
  cwd: string;
}

/** The lines of a log that are JSON objects; with `only`, only the lines holding that text are parsed (a log's tool
 * results can be large, and most lines are not replies). */
function jsonLines(path: string, only = ""): unknown[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: unknown[] = [];
  for (const line of splitLines(text)) {
    if (only && !line.includes(only)) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return out;
}

/** The first user message of a log, as text ("" when there is none). Parses lines only until it is found. */
function firstPrompt(path: string): string {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return "";
  }
  for (const line of splitLines(text)) {
    if (!line.includes('"user"')) continue;
    let d: unknown;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(d) || d.type !== "user") continue;
    let c: unknown = isObj(d.message) ? d.message.content : undefined;
    if (Array.isArray(c)) c = c.filter(isObj).map((b) => str(b.text)).join(" ");
    return typeof c === "string" ? c : "";
  }
  return "";
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** (message id, timestamp, branch, model, usage, cwd) for each assistant reply in one log file. */
export function replies(path: string): Reply[] {
  const out: Reply[] = [];
  for (const d of jsonLines(path, '"assistant"')) {
    if (!isObj(d) || d.type !== "assistant") continue;
    const m = isObj(d.message) ? d.message : {};
    const u = isObj(m.usage) ? m.usage : {};
    if (!Object.keys(u).length) continue;
    out.push({ id: m.id || d.uuid || null, ts: str(d.timestamp) || "", branch: str(d.gitBranch) || "",
      model: str(m.model) || "?", usage: u, cwd: str(d.cwd) || "" });
  }
  return out;
}

const MANAGER_PASS = /^\/?manage-pass\b/;
// The role loops end their prompt with `<!-- factory-role role=... name=... -->` (#102). It names the role exactly, so a
// product owner's session is not counted as a builder's.
const ROLE = /<!--\s*factory-role\s+role=([\w-]+)/;
const ROLE_LABEL: Record<string, string> = { "coding-agent": "builder", "dev-manager": "manager", "product-owner": "product-owner" };

/** 'manager' when the session's first prompt is the dev manager's `/manage-pass` (how `factory manage-tick` and the
 * manager loop start it), else 'builder': every other session on this project, builders and people alike. */
export function sessionRole(prompt: string): string {
  const marked = ROLE.exec(prompt);
  if (marked) return ROLE_LABEL[marked[1] as string] ?? (marked[1] as string);
  return MANAGER_PASS.test(prompt.replace(/^\s*<command-(?:message|name)>\s*/, "")) ? "manager" : "builder";
}

// A session not on a task branch (a dev manager's sub-manager runs on the manager's) names its task in its first prompt:
// the item (`/manage-pass issue-31`, `/next-task issue-31`) or the fact sheet (`Task issue: #31.`, `on branch task/31-x`).
const PROMPT_TASK = [/\/(?:manage-pass|next-task)\s+issue-(\d+)\b/, /\bTask issue: #(\d+)\b/, /\bon branch task\/(\d+(?:[.-]\d+)*?)-/];

/** The task a session's first prompt names, or null. */
export function promptTask(prompt: string): string | null {
  for (const re of PROMPT_TASK) {
    const m = re.exec(prompt);
    if (m) return (m[1] as string).replace(/-/g, ".");
  }
  return null;
}

function int(v: unknown): number {
  const n = Number(v || 0);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

export function tokens(u: Obj): Tokens {
  return { input: int(u.input_tokens), cache_write: int(u.cache_creation_input_tokens),
    cache_read: int(u.cache_read_input_tokens), output: int(u.output_tokens) };
}

function when(ts: string): number | null {
  if (!ts) return null;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? null : t;
}

/** One reply counted: the subagent type (or main), the model, its tokens, its day (UTC) and its cost (null: no price). */
export interface Row {
  kind: string;
  model: string;
  tokens: Tokens;
  day: string;
  cost: number | null;
}

export interface Session {
  task: string;
  /** Where the task came from: the session's branch, its first prompt, or nowhere (task "-"). */
  taskFrom: "branch" | "prompt" | null;
  rows: Row[];
  role: string;
  /** The agent whose folder the session ran in (`<root>-agents/<name>`), another worktree's folder name, or
   * "(project folder)". */
  worker: string;
  /** The first and last reply counted, as logged. */
  first: string;
  last: string;
}

/** Where the logs were looked for and what was found: the log folders, each Claude Code folder looked in, problems. */
export interface Found {
  scope: Scope;
  folders: string[];
  looked: Looked[];
  problems: Problem[];
}

/** This project's log folders (factory_usage_logs.ts): from `cwd`, in `logs` (the hidden --logs) or the usual places,
 * and each of `usage.logFolders`. `given` are the project folder's paths as given (a symlinked one is an alias). */
export function findAll(cwd: string, logs: string | null, extra: string[], given: string[] = []): Found {
  const scope = scopeOf(cwd, given);
  const looked = logBases(scope, extra, logs).map((b) => findLogs(b, scope));
  return { scope, folders: [...new Set(looked.flatMap((l) => l.folders))], looked, problems: problemsOf(looked, scope) };
}

/** The session logs of one log folder: each main log with its subagents' logs, by kind (`main`, or the subagent type). */
function sessionFiles(d: string, f: string): [string, string][] {
  const sid = f.slice(0, -6);
  const files: [string, string][] = [[join(d, f), "main"]];
  const subDir = join(d, sid, "subagents");
  for (const s of listLogs(subDir)) {
    const sub = join(subDir, s);
    let kind = "subagent";
    try {
      const meta: unknown = JSON.parse(readFileSync(sub.slice(0, -6) + ".meta.json", "utf8"));
      if (isObj(meta) && meta.agentType) kind = String(meta.agentType);
    } catch {
      // no meta file: a plain subagent
    }
    files.push([sub, kind]);
  }
  return files;
}

interface Building {
  branches: Map<string, number>;
  rows: Row[];
  role: string;
  prompt: string;
  worker: string | null;
  first: [number, string] | null;
  last: [number, string] | null;
}

/** {session id: Session} for the replies between since and until (ms since the epoch) in `folders`. */
export function collect(found: Pick<Found, "scope" | "folders">, since: number, until: number, prices: Record<string, Price> = {}): Map<string, Session> {
  const { scope } = found;
  const seen = new Set<unknown>();
  const sessions = new Map<string, Building>();
  for (const d of found.folders) {
    for (const f of listLogs(d)) {
      const sid = f.slice(0, -6);
      let prompt: string | null = null;
      for (const [path, kind] of sessionFiles(d, f)) {
        for (const r of replies(path)) {
          const t = when(r.ts);
          if (seen.has(r.id) || t === null || t < since || t >= until) continue;
          if (r.cwd && !belongs(r.cwd, scope)) continue;
          seen.add(r.id);
          if (prompt === null) prompt = firstPrompt(join(d, f));
          let s = sessions.get(sid);
          if (!s) sessions.set(sid, (s = { branches: new Map(), rows: [], role: sessionRole(prompt), prompt, worker: null, first: null, last: null }));
          if (s.worker === null && r.cwd && kind === "main") s.worker = workerOf(r.cwd, scope);
          const m = TASK.exec(r.branch);
          if (m && kind === "main") {
            const k = (m[1] as string).replace(/-/g, ".");
            s.branches.set(k, (s.branches.get(k) ?? 0) + 1);
          }
          if (!s.first || t < s.first[0]) s.first = [t, r.ts];
          if (!s.last || t > s.last[0]) s.last = [t, r.ts];
          s.rows.push({ kind, model: r.model, tokens: tokens(r.usage), day: new Date(t).toISOString().slice(0, 10), cost: costOf(r.model, r.usage, prices) });
        }
      }
    }
  }
  const out = new Map<string, Session>();
  for (const [sid, s] of sessions) {
    const branch = mostCommon(s.branches)[0]?.[0] ?? null;
    const fromPrompt = branch === null ? promptTask(s.prompt) : null;
    out.set(sid, { task: branch ?? fromPrompt ?? "-", taskFrom: branch !== null ? "branch" : fromPrompt !== null ? "prompt" : null,
      rows: s.rows, role: s.role, worker: s.worker ?? PROJECT_FOLDER, first: s.first?.[1] ?? "", last: s.last?.[1] ?? "" });
  }
  return out;
}

/** Counter.most_common(): by count, highest first; ties keep the order they were first counted in. */
function mostCommon(c: Map<string, number>): [string, number][] {
  return [...c.entries()].sort((a, b) => b[1] - a[1]);
}

function add(a: Tokens, b: Tokens): void {
  for (const k of FIELDS) a[k] += b[k];
}

function zero(): Tokens {
  return { input: 0, cache_write: 0, cache_read: 0, output: 0 };
}

export interface Group {
  tokens: Tokens;
  replies: number;
  sessions: Set<string>;
  /** US dollars of the replies whose model has a known price. */
  cost: number;
  /** Replies of a model without a known price (their tokens are counted, their cost isn't). */
  unpriced: number;
}

export interface Total {
  tokens: Tokens;
  replies: number;
  tasks: Set<string>;
  models: Map<string, number>;
  cost: number;
  unpriced: number;
}

function group(): Group {
  return { tokens: zero(), replies: 0, sessions: new Set(), cost: 0, unpriced: 0 };
}

function count(g: { tokens: Tokens; replies: number; cost: number; unpriced: number }, r: Row): void {
  add(g.tokens, r.tokens);
  g.replies += 1;
  if (r.cost === null) g.unpriced += 1;
  else g.cost += r.cost;
}

function keyOf(by: string, s: Session, r: Row): string {
  switch (by) {
    case "task": return s.task;
    case "agent": return r.kind;
    case "role": return s.role || "builder";
    case "worker": return s.worker;
    case "day": return r.day;
    default: return r.model;
  }
}

export function summarise(sessions: Map<string, Session>, by: string): [Map<string, Group>, Total] {
  const groups = new Map<string, Group>();
  const total: Total = { tokens: zero(), replies: 0, tasks: new Set(), models: new Map(), cost: 0, unpriced: 0 };
  for (const [sid, s] of sessions) {
    for (const r of s.rows) {
      const key = keyOf(by, s, r);
      let g = groups.get(key);
      if (!g) groups.set(key, (g = group()));
      count(g, r);
      g.sessions.add(sid);
      count(total, r);
      const t = r.tokens;
      total.models.set(r.model, (total.models.get(r.model) ?? 0) + t.input + t.cache_write + t.cache_read + t.output);
    }
    if (s.task !== "-") total.tasks.add(s.task);
  }
  return [groups, total];
}

/** Dollars to the cent for people ("$29.20", "$0.00"); "-" when nothing had a price. */
export function dollars(cost: number, replies: number, unpriced: number): string {
  return replies > unpriced || cost > 0 ? `$${cost.toFixed(2)}` : "-";
}

/** A group as JSON: its tokens, replies, cost (US dollars, rounded to a millionth) and unpriced replies. */
function groupJson(g: Group | Total): { tokens: Tokens; replies: number; cost_usd: number; unpriced_replies: number } {
  return { tokens: g.tokens, replies: g.replies, cost_usd: Math.round(g.cost * 1e6) / 1e6, unpriced_replies: g.unpriced };
}

/** Each session as JSON, oldest first: what a cost per task joins on (its task, and where the task came from). */
export function sessionsJson(sessions: Map<string, Session>): Array<Record<string, unknown>> {
  return [...sessions].map(([id, s]) => {
    const g = group();
    for (const r of s.rows) count(g, r);
    return { id, task: s.task, task_from: s.taskFrom, worker: s.worker, role: s.role, first: s.first, last: s.last,
      models: [...new Set(s.rows.map((r) => r.model))].sort(), subagents: s.rows.filter((r) => r.kind !== "main").length, ...groupJson(g) };
  }).sort((a, b) => String(a.first).localeCompare(String(b.first)) || String(a.id).localeCompare(String(b.id)));
}

function fresh(t: Tokens): number {
  return t.input + t.cache_write;
}

function hit(t: Tokens): number {
  const read = t.input + t.cache_write + t.cache_read;
  return read ? (t.cache_read / read) * 100 : 0.0;
}

/** Python's format(x, ".0f"): the nearest whole number, an exact half to the even one. */
function round0(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  return d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1;
}

function commas(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function k(n: number): string {
  return n >= 1000 ? `${commas(round0(n / 1000))}k` : String(n);
}

function pct(x: number): string {
  return String(round0(x));
}

function ymd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function byFresh(groups: Map<string, Group>): [string, Group][] {
  const key = (g: Group): number => -fresh(g.tokens) - g.tokens.cache_read;
  return [...groups.entries()].sort((a, b) => key(a[1]) - key(b[1]));
}

function byModel(total: Total): string {
  return mostCommon(total.models).map(([m, v]) => `${m} ${k(v)}`).join(", ");
}

/** What a budget counts: fresh input + output (cache reads are not counted). */
export function counted(t: Tokens): number {
  return fresh(t) + t.output;
}

function percent(used: number, budget: number): number {
  return Math.round((used / budget) * 100);
}

/** The subagent (not the main session) that spent the most counted tokens, or null when there was none. */
function topSubagent(groups: Map<string, Group>): [string, number] | null {
  const subs = [...groups.entries()].filter(([key]) => key !== "main").map(([key, g]): [string, number] => [key, counted(g.tokens)]);
  return subs.sort((a, b) => b[1] - a[1])[0] ?? null;
}

/** A PR comment: this task's tokens per subagent type, from this machine's logs up to now. With a budget, the marker
 * carries used= and budget= (`factory report` reads them) and a line compares the two. */
export function markdown(task: string, groups: Map<string, Group>, total: Total, since: number, budget: number | null = null): string {
  const t = total.tokens;
  const used = counted(t);
  const mark = budget === null ? `<!-- factory-usage task=${task} -->` : `<!-- factory-usage task=${task} used=${used} budget=${budget} -->`;
  const lines = [mark,
    `**Tokens for task ${task}** so far, from this machine's Claude Code logs (${ymd(since)} to now). ` +
    "Fresh input is input that missed the cache.", "",
    "| Agent | Replies | Fresh input | Cache reads | Output | Cache hit |", "|---|---|---|---|---|---|"];
  for (const [key, g] of byFresh(groups)) {
    const x = g.tokens;
    lines.push(`| ${key} | ${g.replies} | ${k(fresh(x))} | ${k(x.cache_read)} | ${k(x.output)} | ${pct(hit(x))}% |`);
  }
  lines.push(`| **All** | ${total.replies} | ${k(fresh(t))} | ${k(t.cache_read)} | ${k(t.output)} | ${pct(hit(t))}% |`);
  if (total.models.size) lines.push("", "By model: " + byModel(total) + ".");
  if (budget !== null) {
    const top = topSubagent(groups);
    const pct = percent(used, budget);
    lines.push("", `**Budget:** used ${short(used)} of ${short(budget)} (${pct}%), counting ${COUNTED}; cache reads are not counted.` +
      (top ? ` Top subagent: ${top[0]}, ${short(top[1])}.` : "") +
      (pct > 100 ? " Over the budget: the dev manager decides at review (accept, ask for a split, or note it)." : ""));
  }
  if (!total.replies) lines.push("", "No replies found for this task on this machine (another machine may have built it).");
  return lines.join("\n");
}

function out(line = ""): void {
  process.stdout.write(line + "\n");
}

export function report(groups: Map<string, Group>, total: Total, by: string, since: number, until: number, problems: Problem[] = []): void {
  out(`Token use ${ymd(since)} to ${ymd(until)} (from this machine's Claude Code logs), per ${by}.\n`);
  out(`${by.padEnd(14)} ${"replies".padStart(8)} ${"fresh in".padStart(10)} ${"cache read".padStart(11)} ${"output".padStart(9)} ` +
    `${"cache hit".padStart(10)} ${"cost".padStart(10)}`);
  const rows = by === "day" ? [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])) : byFresh(groups);
  for (const [key, g] of rows) {
    const t = g.tokens;
    out(`${key.slice(0, 14).padEnd(14)} ${String(g.replies).padStart(8)} ${k(fresh(t)).padStart(10)} ${k(t.cache_read).padStart(11)} ` +
      `${k(t.output).padStart(9)} ${pct(hit(t)).padStart(9)}% ${dollars(g.cost, g.replies, g.unpriced).padStart(10)}`);
  }
  const t = total.tokens;
  const n = total.tasks.size;
  out(`\nAll: ${total.replies} replies, fresh input ${k(fresh(t))}, cache reads ${k(t.cache_read)}, output ` +
    `${k(t.output)}, cache hit ${pct(hit(t))}%.`);
  if (n) {
    out(`Per task (${n} tasks): fresh input ${k(Math.floor(fresh(t) / n))}, cache reads ${k(Math.floor(t.cache_read / n))}, ` +
      `output ${k(Math.floor(t.output / n))}.`);
  }
  if (total.models.size) out("By model (all tokens): " + byModel(total));
  if (total.replies) {
    out(`Cost at Anthropic's API prices (as of ${PRICES_AS_OF}): ${dollars(total.cost, total.replies, total.unpriced)}` +
      (total.unpriced ? `; ${total.unpriced} replies of models without a known price are not in it (add one with usage.prices).` : "."));
  }
  for (const p of problems) out(`\n${p.message} (${p.code})\nFix: ${p.fix}`);
}

/** The checkpoint (`--budget`): used, budget, what is left and the percent, and a warning from 80%. */
export function checkpoint(task: string, total: Total, budget: number | null, source: string): string {
  const used = counted(total.tokens);
  const lines: string[] = [];
  if (budget === null) {
    lines.push(`Task ${task} has no budget: no Budget: line on its issue and no budget.builder in .claude/factory.json. ` +
      `Used ${short(used)} tokens so far, counting ${COUNTED}.`);
  } else {
    const pct = percent(used, budget);
    const left = budget - used;
    lines.push(`Task ${task}: ${short(used)} of ${short(budget)} tokens used (${pct}%), ` +
      (left >= 0 ? `${short(left)} left.` : `over the budget by ${short(-left)}.`));
    lines.push(`Counted: ${COUNTED}, from this machine's Claude Code logs; cache reads are not counted. Budget from ${source}.`);
    if (pct >= WARN_PERCENT) {
      lines.push(`Warning: ${pct}% of the budget is used. Finish the step you are on, commit a working state and write in ` +
        "the PR what is left. If the rest will not fit, ask the dev manager in a <!-- factory-question --> comment before " +
        "going on. Nothing stops at the limit: the dev manager weighs an overrun at review.");
    }
  }
  if (!total.replies) lines.push("No replies found for this task on this machine (another machine may have built it).");
  return lines.join("\n");
}

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function record(path: string, label: string, total: Total, since: number, until: number): void {
  const t = total.tokens;
  const n = Math.max(total.tasks.size, 1);
  const isNew = !existsSync(path);
  mkdirSync(dirname(path) || ".", { recursive: true });
  let text = "";
  if (isNew) {
    text += "# Factory token use\n\nOne row per measurement (`factory usage --record \"label\"`), from one " +
      "machine's Claude Code logs. Compare rows for the same kind of work: tokens per task matter more " +
      "than totals. \"Fresh input\" is input that missed the cache.\n\n" +
      "| Measured | Period | Label | Tasks | Fresh input per task | Cache reads per task | " +
      "Output per task | Cache hit |\n|---|---|---|---|---|---|---|---|\n";
  }
  text += `| ${localToday()} | ${ymd(since)} to ${ymd(until)} | ${label} | ` +
    `${total.tasks.size} | ${k(Math.floor(fresh(t) / n))} | ${k(Math.floor(t.cache_read / n))} | ${k(Math.floor(t.output / n))} | ` +
    `${pct(hit(t))}% |\n`;
  appendFileSync(path, text, "utf8");
  out(`\nRecorded in ${path}. Commit it in a pull request to keep the history.`);
}

/** A day given on the command line (YYYY-MM-DD, or an ISO time), at UTC; null when unreadable. */
function day(s: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}(:\d{2}(:\d{2}(\.\d+)?)?)?)?$/.test(s)) return null;
  const t = Date.parse(s.replace(" ", "T").length === 10 ? s + "T00:00:00Z" : s.replace(" ", "T") + "Z");
  return Number.isNaN(t) ? null : t;
}

/** Python's datetime.isoformat() of a UTC time: 2026-10-20T00:00:00+00:00. */
function isoformat(ms: number): string {
  const s = new Date(ms).toISOString();
  const frac = ms % 1000 ? s.slice(19, 23) + "000" : "";
  return s.slice(0, 19) + frac + "+00:00";
}

const BY = ["task", "agent", "model", "role", "worker", "day"];

const USAGE = `usage: factory usage [-h] [--since SINCE] [--until UNTIL]
                     [--by {task,agent,model,role,worker,day}] [--json] [--record LABEL]
                     [--task TASK] [--markdown] [--budget] [--github]
`;

const HELP = `${USAGE}
Token use per task, from this machine's logs.

options:
  -h, --help            show this help message and exit
  --since SINCE         first day (YYYY-MM-DD, UTC); default 7 days ago
  --until UNTIL         day after the last (YYYY-MM-DD, UTC); default tomorrow
  --by {task,agent,model,role,worker,day}
  --json                also the cost, the days, each session, where it
                        looked and any problem
  --record LABEL        append a summary row to the usage log
  --task TASK           only the sessions of this task (its id or issue
                        number)
  --markdown            print a PR comment (use with --task)
  --budget              the task's tokens against its budget (use with
                        --task): used, budget, left, percent; warns at 80%
  --github              this machine's GitHub calls in the last hour, by
                        agent, command and endpoint (with --json too)
`;

interface Args {
  since: number | null;
  until: number | null;
  by: string;
  json: boolean;
  record: string | null;
  task: string | null;
  markdown: boolean;
  budget: boolean;
  github: boolean;
  logs: string | null;
}

function argError(message: string): never {
  process.stderr.write(USAGE + `factory usage: error: ${message}\n`);
  die(2);
}

const OPTIONS = ["--help", "--since", "--until", "--by", "--json", "--record", "--task", "--markdown", "--budget", "--github", "--logs"];
const TAKES_VALUE = new Set(["--since", "--until", "--by", "--record", "--task", "--logs"]);

/** argparse, by hand: the same options, abbreviations, errors (exit 2) and help. */
export function parseArgs(argv: string[]): Args {
  const a: Args = { since: null, until: null, by: "task", json: false, record: null, task: null, markdown: false, budget: false, github: false,
    logs: null };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i] as string;
    let value: string | undefined;
    if (arg === "-h") arg = "--help";
    if (!arg.startsWith("--") || arg === "--") argError(`unrecognized arguments: ${argv.slice(i).join(" ")}`);
    const eq = arg.indexOf("=");
    if (eq > 0) {
      value = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    const hits = OPTIONS.includes(arg) ? [arg] : OPTIONS.filter((o) => o.startsWith(arg));
    if (hits.length > 1) argError(`ambiguous option: ${arg} could match ${hits.join(", ")}`);
    const opt = hits[0];
    if (!opt) argError(`unrecognized arguments: ${argv[i]}`);
    if (TAKES_VALUE.has(opt) && value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith("-") && next !== "-")) {
        argError(`argument ${opt}: expected one argument`);
      }
      value = next;
      i++;
    } else if (!TAKES_VALUE.has(opt) && value !== undefined) {
      argError(`argument ${opt}: ignored explicit argument ${pyRepr(value)}`);
    }
    const v = value as string;
    switch (opt) {
      case "--help":
        process.stdout.write(HELP);
        die(0);
      case "--since":
      case "--until": {
        const t = day(v);
        if (t === null) argError(`argument ${opt}: invalid day value: ${pyRepr(v)}`);
        if (opt === "--since") a.since = t;
        else a.until = t;
        break;
      }
      case "--by":
        if (!BY.includes(v)) {
          argError(`argument --by: invalid choice: ${pyRepr(v)} (choose from ${BY.map((b) => `'${b}'`).join(", ")})`);
        }
        a.by = v;
        break;
      case "--json":
        a.json = true;
        break;
      case "--markdown":
        a.markdown = true;
        break;
      case "--budget":
        a.budget = true;
        break;
      case "--github":
        a.github = true;
        break;
      case "--record":
        a.record = v;
        break;
      case "--task":
        a.task = v;
        break;
      case "--logs":
        a.logs = v;
        break;
    }
  }
  if (a.github && (a.task || a.markdown || a.budget || a.record !== null || a.since !== null || a.until !== null)) {
    argError("--github shows the last hour of GitHub calls: use it alone or with --json");
  }
  if (a.budget && !a.task) argError("--budget needs --task: factory usage --task <n> --budget");
  return a;
}

const DAY_MS = 86_400_000;

/** A task's budget; any failure to look it up means no budget, since this is advice. */
function budgetOf(cfg: Config, task: string): { tokens: number | null; source: string } {
  try {
    return taskBudget(cfg, task);
  } catch {
    return { tokens: null, source: "" };
  }
}

const TOP = 10;

/** `--github` (#371): this machine's GitHub calls in the last hour, as factory_lib.ts counted them, biggest first; and
 * what GitHub itself counts on the account (agents' own `gh` and other machines included), when it can be read. */
function githubReport(json: boolean): number {
  const h = githubCallsLastHour();
  const core = limitStatus();
  if (json) {
    out(pyDumps({ since: isoformat(h.since * 1000), total: h.total, agents: Object.fromEntries(h.agents),
      commands: Object.fromEntries(h.commands), endpoints: Object.fromEntries(h.endpoints), callers: Object.fromEntries(h.callers),
      github: core ? { used: core.limit - core.remaining, limit: core.limit, reset: isoformat(core.reset * 1000) } : null },
    { indent: 2 }));
    return 0;
  }
  const account = core ? `GitHub counts ${core.limit - core.remaining} of ${core.limit} used on the account this hour ` +
    `(resets ${isoformat(core.reset * 1000).slice(11, 16)} UTC), from every machine and agents' own gh.` : null;
  if (h.total === 0) {
    out("No GitHub calls counted on this machine in the last hour.");
    if (account) out(account);
    return 0;
  }
  out(`${h.total} GitHub calls in the last hour from the factory's commands on this machine.`);
  if (account) out(account);
  for (const [title, rows] of [["By agent (project)", h.agents], ["By command", h.commands], ["By endpoint", h.endpoints]] as const) {
    out();
    out(`${title}:`);
    const width = Math.max(...rows.slice(0, TOP).map(([k]) => k.length));
    for (const [k, n] of rows.slice(0, TOP)) out(`  ${k.padEnd(width)}  ${String(n).padStart(5)}`);
    if (rows.length > TOP) out(`  ... ${rows.length - TOP} more (--json lists them all)`);
  }
  return 0;
}

export function main(argv: string[]): number {
  const a = parseArgs(argv);
  if (a.github) return githubReport(a.json);
  const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const until = a.until ?? today + DAY_MS;
  const since = a.since ?? until - 8 * DAY_MS;
  const given = [process.env.CLAUDE_PROJECT_DIR ?? "", process.env.PWD ?? "", process.cwd()];
  const cfg = load();
  const usageCfg = isObj(cfg.usage) ? cfg.usage : {};
  const extra = Array.isArray(usageCfg.logFolders) ? usageCfg.logFolders.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
  const found = findAll(process.cwd(), a.logs, extra, given.filter(Boolean));
  let sessions = collect(found, since, until, pricesFrom(usageCfg.prices));
  if (a.task) {
    const task = a.task.replace(/^#+/, "").replace(/-/g, ".");
    sessions = new Map([...sessions].filter(([, s]) => s.task === task));
  }
  const [groups, total] = summarise(sessions, a.markdown ? "agent" : a.by);
  const id = a.task ? a.task.replace(/^#+/, "") : "-";
  const budget = a.task && (a.markdown || a.budget) ? budgetOf(cfg, id) : { tokens: null, source: "" };
  if (a.budget) out(checkpoint(id, total, budget.tokens, budget.source));
  else if (a.markdown) out(markdown(id, groups, total, since, budget.tokens));
  else if (a.json) {
    const g: Record<string, ReturnType<typeof groupJson>> = {};
    for (const [key, x] of groups) g[key] = groupJson(x);
    const days: Record<string, ReturnType<typeof groupJson>> = {};
    for (const [key, x] of [...summarise(sessions, "day")[0]].sort((p, q) => p[0].localeCompare(q[0]))) days[key] = groupJson(x);
    out(pyDumps({ since: isoformat(since), until: isoformat(until), by: a.by, groups: g,
      total: { ...groupJson(total), tasks: [...total.tasks].sort() }, days, sessions: sessionsJson(sessions),
      prices_as_of: PRICES_AS_OF, project: found.scope.top,
      looked: found.looked.map((l) => ({ dir: l.dir, why: l.why, state: l.state, folders: l.folders, ...(l.error ? { error: l.error } : {}) })),
      problems: found.problems }, { indent: 2 }));
  } else report(groups, total, a.by, since, until, found.problems);
  if (a.record) {
    const log = typeof cfg.usageLog === "string" && cfg.usageLog ? cfg.usageLog : "docs/factory-usage.md";
    record(log, a.record.replace(/\|/g, "/"), total, since, until);
  }
  return 0;
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
