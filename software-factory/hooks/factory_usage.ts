#!/usr/bin/env -S bun --no-env-file
// `factory usage`: how many tokens the factory's sessions used, per task, from Claude Code's own session logs on
// this machine. Use it to measure a change to the factory (a cheaper model, less reading) before and after.
//
//   factory usage                       the last 7 days, per task, then the totals
//   factory usage --since 2026-10-20 --until 2026-10-24
//   factory usage --by agent            per subagent type (reviewer, test-writer, ...) instead of per task
//   factory usage --by role             manager (sessions that start with /manage-pass, or end with a `factory-role` line naming
//                                       the dev manager), product-owner (that line names it) against builder (all others)
//   factory usage --json                the same as JSON
//   factory usage --task 96 --markdown  one task's tokens per subagent, as a PR comment (the next-task skill posts it)
//   factory usage --record "label"      also append a dated summary row to the usage log (`usageLog` in
//                                       factory.json, default docs/factory-usage.md), to commit in a PR
//
// Reads ~/.claude/projects/<this project's folders>/*.jsonl (the main sessions, including each agent worktree) and
// their subagents/*.jsonl. Each model reply is counted once (by message id). A session belongs to the task whose
// branch (`task/<n>-...`) it spent most replies on. Nothing leaves the machine; the log row holds only totals.
//
// Tokens are reported as Claude reports them: input (not cached), cache writes, cache reads, output. "Fresh input"
// is input + cache writes: what had to be read without a cache hit. Prices differ per model, so use `/usage` or the
// console for money; this command is for comparing like with like.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { load } from "./factory_config.ts";
import { die, pyDumps, pyRepr, runMain, splitLines } from "./factory_lib.ts";

const TASK = /^task\/(\d+(?:[.-]\d+)*?)-/;
export const FIELDS = ["input", "cache_write", "cache_read", "output"] as const;
export type Tokens = { input: number; cache_write: number; cache_read: number; output: number };
type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function listDir(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

/** Claude Code keeps a project's logs in ~/.claude/projects/<its path with / and . as ->. Agent worktrees live
 * in <root>-agents/<name>, so their folders start with the same prefix. */
export function projectDirs(root: string, base: string): string[] {
  const slug = root.replace(/[^A-Za-z0-9]/g, "-");
  return listDir(base).filter((n) => n.startsWith(slug)).map((n) => join(base, n)).filter(isDir);
}

interface Reply {
  id: unknown;
  ts: string;
  branch: string;
  model: string;
  usage: Obj;
  cwd: string;
}

function jsonLines(path: string): unknown[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: unknown[] = [];
  for (const line of splitLines(text)) {
    try {
      out.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return out;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** (message id, timestamp, branch, model, usage, cwd) for each assistant reply in one log file. */
export function replies(path: string): Reply[] {
  const out: Reply[] = [];
  for (const d of jsonLines(path)) {
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
export function sessionRole(path: string): string {
  for (const d of jsonLines(path)) {
    if (!isObj(d) || d.type !== "user") continue;
    let c: unknown = isObj(d.message) ? d.message.content : undefined;
    if (Array.isArray(c)) c = c.filter(isObj).map((b) => str(b.text)).join(" ");
    const marked = typeof c === "string" ? ROLE.exec(c) : null;
    if (marked) return ROLE_LABEL[marked[1] as string] ?? (marked[1] as string);
    return typeof c === "string" && MANAGER_PASS.test(c.replace(/^\s*<command-(?:message|name)>\s*/, "")) ? "manager" : "builder";
  }
  return "builder";
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

export interface Session {
  task: string;
  rows: [kind: string, model: string, tokens: Tokens][];
  role: string;
}

/** {session: {task, rows: [(kind, model, tokens)], role}} for replies between since and until (ms since the epoch). */
export function collect(root: string, base: string, since: number, until: number): Map<string, Session> {
  const seen = new Set<unknown>();
  const sessions = new Map<string, { branches: Map<string, number>; rows: Session["rows"]; role: string }>();
  for (const d of projectDirs(root, base)) {
    for (const f of listDir(d).filter((n) => n.endsWith(".jsonl"))) {
      const main = join(d, f);
      const sid = f.slice(0, -6);
      const role = sessionRole(main);
      const files: [string, string][] = [[main, "main"]];
      const subDir = join(d, sid, "subagents");
      for (const s of listDir(subDir).filter((n) => n.endsWith(".jsonl"))) {
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
      for (const [path, kind] of files) {
        for (const r of replies(path)) {
          const t = when(r.ts);
          if (seen.has(r.id) || t === null || t < since || t >= until) continue;
          if (r.cwd && !(r.cwd === root || r.cwd.startsWith(root + sep) || r.cwd.startsWith(root + "-agents"))) continue;
          seen.add(r.id);
          let s = sessions.get(sid);
          if (!s) sessions.set(sid, (s = { branches: new Map(), rows: [], role: "builder" }));
          s.role = role;
          const m = TASK.exec(r.branch);
          if (m && kind === "main") {
            const k = (m[1] as string).replace(/-/g, ".");
            s.branches.set(k, (s.branches.get(k) ?? 0) + 1);
          }
          s.rows.push([kind, r.model, tokens(r.usage)]);
        }
      }
    }
  }
  const out = new Map<string, Session>();
  for (const [sid, s] of sessions) out.set(sid, { task: mostCommon(s.branches)[0]?.[0] ?? "-", rows: s.rows, role: s.role });
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
}

export interface Total {
  tokens: Tokens;
  replies: number;
  tasks: Set<string>;
  models: Map<string, number>;
}

export function summarise(sessions: Map<string, Session>, by: string): [Map<string, Group>, Total] {
  const groups = new Map<string, Group>();
  const total: Total = { tokens: zero(), replies: 0, tasks: new Set(), models: new Map() };
  for (const [sid, s] of sessions) {
    for (const [kind, model, t] of s.rows) {
      const key = by === "task" ? s.task : by === "agent" ? kind : by === "role" ? s.role || "builder" : model;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { tokens: zero(), replies: 0, sessions: new Set() }));
      add(g.tokens, t);
      g.replies += 1;
      g.sessions.add(sid);
      add(total.tokens, t);
      total.replies += 1;
      total.models.set(model, (total.models.get(model) ?? 0) + t.input + t.cache_write + t.cache_read + t.output);
    }
    if (s.task !== "-") total.tasks.add(s.task);
  }
  return [groups, total];
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

/** A PR comment: this task's tokens per subagent type, from this machine's logs up to now. */
export function markdown(task: string, groups: Map<string, Group>, total: Total, since: number): string {
  const t = total.tokens;
  const lines = [`<!-- factory-usage task=${task} -->`,
    `**Tokens for task ${task}** so far, from this machine's Claude Code logs (${ymd(since)} to now). ` +
    "Fresh input is input that missed the cache.", "",
    "| Agent | Replies | Fresh input | Cache reads | Output | Cache hit |", "|---|---|---|---|---|---|"];
  for (const [key, g] of byFresh(groups)) {
    const x = g.tokens;
    lines.push(`| ${key} | ${g.replies} | ${k(fresh(x))} | ${k(x.cache_read)} | ${k(x.output)} | ${pct(hit(x))}% |`);
  }
  lines.push(`| **All** | ${total.replies} | ${k(fresh(t))} | ${k(t.cache_read)} | ${k(t.output)} | ${pct(hit(t))}% |`);
  if (total.models.size) lines.push("", "By model: " + byModel(total) + ".");
  if (!total.replies) lines.push("", "No replies found for this task on this machine (another machine may have built it).");
  return lines.join("\n");
}

function out(line = ""): void {
  process.stdout.write(line + "\n");
}

export function report(groups: Map<string, Group>, total: Total, by: string, since: number, until: number): void {
  out(`Token use ${ymd(since)} to ${ymd(until)} (from this machine's Claude Code logs), per ${by}.\n`);
  out(`${by.padEnd(14)} ${"replies".padStart(8)} ${"fresh in".padStart(10)} ${"cache read".padStart(11)} ${"output".padStart(9)} ${"cache hit".padStart(10)}`);
  for (const [key, g] of byFresh(groups)) {
    const t = g.tokens;
    out(`${key.slice(0, 14).padEnd(14)} ${String(g.replies).padStart(8)} ${k(fresh(t)).padStart(10)} ${k(t.cache_read).padStart(11)} ` +
      `${k(t.output).padStart(9)} ${pct(hit(t)).padStart(9)}%`);
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

const USAGE = `usage: factory usage [-h] [--since SINCE] [--until UNTIL]
                     [--by {task,agent,model,role}] [--json] [--record LABEL]
                     [--task TASK] [--markdown]
`;

const HELP = `${USAGE}
Token use per task, from this machine's logs.

options:
  -h, --help            show this help message and exit
  --since SINCE         first day (YYYY-MM-DD, UTC); default 7 days ago
  --until UNTIL         day after the last (YYYY-MM-DD, UTC); default tomorrow
  --by {task,agent,model,role}
  --json
  --record LABEL        append a summary row to the usage log
  --task TASK           only the sessions of this task (its id or issue
                        number)
  --markdown            print a PR comment (use with --task)
`;

interface Args {
  since: number | null;
  until: number | null;
  by: string;
  json: boolean;
  record: string | null;
  task: string | null;
  markdown: boolean;
  logs: string;
}

function argError(message: string): never {
  process.stderr.write(USAGE + `factory usage: error: ${message}\n`);
  die(2);
}

const OPTIONS = ["--help", "--since", "--until", "--by", "--json", "--record", "--task", "--markdown", "--logs"];
const TAKES_VALUE = new Set(["--since", "--until", "--by", "--record", "--task", "--logs"]);

/** argparse, by hand: the same options, abbreviations, errors (exit 2) and help. */
export function parseArgs(argv: string[]): Args {
  const a: Args = { since: null, until: null, by: "task", json: false, record: null, task: null, markdown: false,
    logs: join(process.env.HOME || homedir(), ".claude", "projects") };
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
        if (!["task", "agent", "model", "role"].includes(v)) {
          argError(`argument --by: invalid choice: ${pyRepr(v)} (choose from 'task', 'agent', 'model', 'role')`);
        }
        a.by = v;
        break;
      case "--json":
        a.json = true;
        break;
      case "--markdown":
        a.markdown = true;
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
  return a;
}

const DAY_MS = 86_400_000;

export function main(argv: string[]): number {
  const a = parseArgs(argv);
  const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const until = a.until ?? today + DAY_MS;
  const since = a.since ?? until - 8 * DAY_MS;
  const cfg = load();
  const root = process.cwd();
  let sessions = collect(root, a.logs, since, until);
  if (a.task) {
    const task = a.task.replace(/^#+/, "").replace(/-/g, ".");
    sessions = new Map([...sessions].filter(([, s]) => s.task === task));
  }
  const [groups, total] = summarise(sessions, a.markdown ? "agent" : a.by);
  if (a.markdown) out(markdown(a.task ? a.task.replace(/^#+/, "") : "-", groups, total, since));
  else if (a.json) {
    const g: Record<string, { tokens: Tokens; replies: number }> = {};
    for (const [key, x] of groups) g[key] = { tokens: x.tokens, replies: x.replies };
    out(pyDumps({ since: isoformat(since), until: isoformat(until), by: a.by, groups: g,
      total: { tokens: total.tokens, replies: total.replies, tasks: [...total.tasks].sort() } }, { indent: 2 }));
  } else report(groups, total, a.by, since, until);
  if (a.record) {
    const log = typeof cfg.usageLog === "string" && cfg.usageLog ? cfg.usageLog : "docs/factory-usage.md";
    record(log, a.record.replace(/\|/g, "/"), total, since, until);
  }
  return 0;
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
