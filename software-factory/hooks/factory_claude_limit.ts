#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// Claude's usage limit (#614): when a session ends because the login's 5-hour or weekly limit is used up, the loop
// waits for the reset once, instead of starting a session every 10 s that ends at once, and every loop on the machine
// waits with it.
//
//   factory_claude_limit.ts check --since <epoch seconds> [--name AGENT]
//       after a session: did it end on Claude's usage limit? Reads the last reply of the newest Claude Code transcript of
//       this folder written since then ($CLAUDE_CONFIG_DIR/projects, else ~/.claude/projects, as `factory usage` reads
//       them) against PATTERNS below. A limit is written to the shared file (`claude-limit.json` in the state folder,
//       beside GitHub's `github-rate.json`) with its reset time, or, when the reset can't be read, the time
//       `claudeLimit.waitMinutes` (30) from now. Exit 0: a limit, 1: none.
//   factory_claude_limit.ts wait [--name AGENT]
//       before a session: while the shared file says the limit holds, print "Claude limit reached; waiting until HH:MM
//       (local)", report the agent as "waiting on the Claude limit until HH:MM" and sleep until then plus
//       `claudeLimit.marginSeconds` (60). With `claudeLimit.softTokens5h` set, it then also waits while the last 5 hours
//       of this project's sessions used more than that (fresh input + output, as `factory usage` counts them). Exit 0:
//       it waited, 1: nothing to wait for. Ctrl-C ends it (the loop then stops).
//   factory_claude_limit.ts status [--json]
//       the limit now, if any.
//   factory_claude_limit.ts detect <transcript.jsonl>
//       what PATTERNS make of a transcript's last reply (to check a new message by hand).
//
// The shared file is per project and machine: every loop of the project on this machine reads it before it starts a
// session, so one loop finds the limit and the others wait without trying. A loop of another project on the same login
// finds it by itself, once. The heartbeat daemon and `factory agents ls` show a loop waiting here as
// "waiting on the Claude limit until HH:MM" (factory_heartbeat.ts), and the web UI shows one Needs attention item.
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { type Config, load, toFloat } from "./factory_config.ts";
import { now as clockNow } from "./factory_clock.ts";
import { die, parseArgs, pyDumps, runMain } from "./factory_lib.ts";
import { real, slug } from "./factory_usage_logs.ts";

/** The project's state folder on this machine, as factory_machine.ts's stateDir() names it (`$XDG_STATE_HOME/<repo>-factory`,
 * else `~/.local/state/<repo>-factory`); not imported from there, so the loop's check before each session loads little. */
export function stateDir(): string {
  const p = spawnSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8" });
  const out = p.status === 0 ? p.stdout.trim() : "";
  const key = basename(dirname(resolve(out || ".git")));
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), `${key}-factory`);
}

export const LIMIT_FILE = "claude-limit.json";
export const DEFAULT_WAIT_MINUTES = 30;
export const DEFAULT_MARGIN_SECONDS = 60;
const PING_SECONDS = 300;
const TAIL_BYTES = 524_288;
const MAX_AHEAD = 8 * 86_400; // a reset further away than this was misread

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// --- the patterns ------------------------------------------------------------------------------------------------------

/** One reply of a transcript, as far as the patterns need it. */
export interface Entry {
  /** Claude Code's error kind on a synthetic reply: rate_limit, overloaded, server_error, authentication_failed... */
  error: string | null;
  /** True for a reply Claude Code wrote itself for an API error (isApiErrorMessage, or the model "<synthetic>"). */
  apiError: boolean;
  text: string;
  /** Seconds since 1970 when it was written; null when not logged. */
  at: number | null;
  raw: Obj;
}

/** What a pattern found: a usage limit (with its reset time when it could be read) or explicitly not one. */
export interface Hit {
  pattern: string;
  limit: boolean;
  /** Seconds since 1970; null when the message names no time that could be read. */
  reset: number | null;
  /** five_hour, seven_day, or null when not said. */
  window: string | null;
  text: string;
}

export interface Pattern {
  id: string;
  /** Where the shape was seen. */
  source: string;
  limit: boolean;
  match(e: Entry): { reset: number | null; window: string | null } | null;
}

/** A number of seconds since 1970 from resetsAt (seconds, or milliseconds from a newer release). */
function epoch(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1e12 ? Math.floor(n / 1000) : n;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** The offset of time zone `tz` (undefined: this machine's) at `t`, in seconds (Berlin in winter: 3600). */
function offsetOf(tz: string | undefined, t: number): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(new Date(t * 1000));
  const get = (k: string): number => Number(parts.find((p) => p.type === k)?.value ?? 0);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second")) / 1000 - Math.floor(t);
}

/** [year, month 0-11, day] of `t` in `tz`. */
function dateIn(tz: string | undefined, t: number): [number, number, number] {
  const d = new Date((t + offsetOf(tz, t)) * 1000);
  return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
}

/** The instant a wall-clock time in `tz` stands for. */
function zoned(tz: string | undefined, y: number, mo: number, d: number, h: number, mi: number): number {
  const wall = Date.UTC(y, mo, d, h, mi) / 1000;
  let t = wall - offsetOf(tz, wall);
  t = wall - offsetOf(tz, t); // once more, for a time next to a daylight-saving change
  return t;
}

function validZone(tz: string | undefined): string | undefined {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

/** "resets 9:20pm (Europe/Berlin)", "resets Oct 27 at 4pm (Europe/Berlin)", "resets 3am": the first such time at or
 * after `at` (seconds since 1970); null when there is none or it makes no sense. */
export function resetFromText(text: string, at: number): number | null {
  const m = /\bresets?\s+(?:at\s+)?(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)\s]+)\))?/i.exec(text);
  if (!m) return null;
  let h = Number(m[3]);
  const mi = m[4] ? Number(m[4]) : 0;
  const ap = (m[5] ?? "").toLowerCase();
  if (!ap && !m[4]) return null; // "resets 3" is not a time
  if (ap) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (ap === "pm" ? 12 : 0);
  } else if (h > 23) return null;
  if (mi > 59) return null;
  const tz = validZone(m[6]);
  const [y, mo, d] = dateIn(tz, at);
  let t: number;
  if (m[1]) {
    const month = MONTHS.indexOf(m[1].toLowerCase());
    if (month < 0) return null;
    t = zoned(tz, y, month, Number(m[2]), h, mi);
    if (t < at - 86_400) t = zoned(tz, y + 1, month, Number(m[2]), h, mi); // "Jan 2" said on 30 Dec
  } else {
    t = zoned(tz, y, mo, d, h, mi);
    if (t < at - 60) t = zoned(tz, y, mo, d + 1, h, mi); // "resets 3am" said at 11pm: tomorrow
  }
  return t - at > MAX_AHEAD ? null : t;
}

const LIMIT_WORDS = /usage limit reached|\bhit your (?:[\w-]+ )*limit\b|\blimit reached\b|\blimit will reset\b/i;

/** The table. The first pattern that matches the session's last reply decides; nothing matching means no limit. */
export const PATTERNS: Pattern[] = [
  { id: "quota-rejected", limit: true,
    source: "Claude Code 2.1.304 and 2.1.310 transcripts (20 and 24 Oct 2026): a synthetic reply with error rate_limit, " +
      "apiError usage_limit_reached and quotaLimits {status: rejected, resetsAt, rateLimitType five_hour|seven_day}",
    match(e) {
      const q = isObj(e.raw.quotaLimits) ? e.raw.quotaLimits : {};
      const params = isObj(e.raw.apiErrorParams) ? e.raw.apiErrorParams : {};
      const info = isObj(params.rate_limit_info) ? params.rate_limit_info : {};
      const rejected = e.raw.apiError === "usage_limit_reached" || q.status === "rejected" || info.status === "rejected";
      const reset = epoch(q.resetsAt) ?? epoch(info.resetsAt);
      if (!rejected || reset === null) return null;
      const w = q.rateLimitType ?? info.rateLimitType;
      return { reset, window: typeof w === "string" ? w : null };
    } },
  { id: "text-epoch", limit: true,
    source: "Claude Code 1.0.x: `Claude AI usage limit reached|<reset, seconds since 1970>`",
    match(e) {
      const m = /usage limit reached\|(\d{9,13})/i.exec(e.text);
      return m && e.apiError ? { reset: epoch(m[1]), window: null } : null;
    } },
  { id: "text-resets", limit: true,
    source: "the same 2.1.x replies' text: `You've hit your ... limit · ... your session limit resets 9:20pm (Europe/Berlin)`, " +
      "`your weekly limit resets Oct 27 at 4pm (Europe/Berlin)`; and `5-hour limit reached ∙ resets 3am` (2.0.x)",
    match(e) {
      if (!e.apiError || !LIMIT_WORDS.test(e.text)) return null;
      const reset = resetFromText(e.text, e.at ?? clockNow());
      if (reset === null) return null;
      const window = /weekly|7-day|seven/i.test(e.text) ? "seven_day" : /session|5-hour|five/i.test(e.text) ? "five_hour" : null;
      return { reset, window };
    } },
  { id: "text-no-time", limit: true,
    source: "any of the messages above whose time can't be read: waits claudeLimit.waitMinutes",
    match(e) {
      return e.apiError && LIMIT_WORDS.test(e.text) ? { reset: null, window: null } : null;
    } },
  { id: "rate-limit", limit: true,
    source: "a synthetic reply with error rate_limit and none of the shapes above: waits claudeLimit.waitMinutes",
    match(e) {
      return e.apiError && e.error === "rate_limit" ? { reset: null, window: null } : null;
    } },
  { id: "overloaded", limit: false,
    source: "error overloaded (HTTP 529) or `Overloaded`: Anthropic is busy, not the login's limit; the loop carries on as before",
    match(e) {
      return e.apiError && (e.error === "overloaded" || e.error === "overloaded_error" || /\boverloaded\b/i.test(e.text))
        ? { reset: null, window: null } : null;
    } },
];

/** What the table makes of one reply; null when no pattern matches (a normal reply, another error). */
export function detect(e: Entry): Hit | null {
  for (const p of PATTERNS) {
    const got = p.match(e);
    if (got) return { pattern: p.id, limit: p.limit, reset: got.reset, window: got.window, text: e.text.slice(0, 300) };
  }
  return null;
}

/** A transcript line as an Entry; null when it is not an assistant reply. */
export function entryOf(raw: unknown): Entry | null {
  if (!isObj(raw) || raw.type !== "assistant") return null;
  const m = isObj(raw.message) ? raw.message : {};
  const content = m.content;
  const text = typeof content === "string" ? content
    : Array.isArray(content) ? content.filter(isObj).map((c) => (typeof c.text === "string" ? c.text : "")).join(" ").trim() : "";
  const ts = typeof raw.timestamp === "string" ? Date.parse(raw.timestamp) : NaN;
  return { error: typeof raw.error === "string" ? raw.error : null, apiError: raw.isApiErrorMessage === true || m.model === "<synthetic>",
    text, at: Number.isNaN(ts) ? null : ts / 1000, raw };
}

// --- the transcripts ---------------------------------------------------------------------------------------------------

/** The last `TAIL_BYTES` of a file, from the start of a line. */
function tail(path: string): string {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return "";
  }
  try {
    const size = statSync(path).size;
    const start = Math.max(size - TAIL_BYTES, 0);
    const buf = Buffer.alloc(size - start);
    const n = readSync(fd, buf, 0, buf.length, start);
    const text = buf.subarray(0, n).toString("utf8");
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } catch {
    return "";
  } finally {
    closeSync(fd);
  }
}

/** The last assistant reply in a transcript, or null. */
export function lastReply(path: string): Entry | null {
  const lines = tail(path).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string;
    if (!line.includes('"assistant"')) continue;
    try {
      const e = entryOf(JSON.parse(line));
      if (e) return e;
    } catch {
      continue;
    }
  }
  return null;
}

/** Claude Code's projects folder: $CLAUDE_CONFIG_DIR/projects, else ~/.claude/projects. */
function projectsDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, "projects") : join(process.env.HOME || homedir(), ".claude", "projects");
}

/** The transcripts of sessions run in `cwd` written since `since` (seconds since 1970), newest first. */
export function transcriptsSince(cwd: string, since: number): string[] {
  const base = projectsDir();
  const found: Array<[number, string]> = [];
  for (const name of [...new Set([slug(cwd), slug(real(cwd))])]) {
    const dir = join(base, name);
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        const m = statSync(join(dir, f)).mtimeMs / 1000;
        if (m >= since - 1) found.push([m, join(dir, f)]);
      } catch {
        continue;
      }
    }
  }
  return found.sort((a, b) => b[0] - a[0]).map(([, p]) => p);
}

/** What ended the session run in `cwd` since `since`: the newest transcript's last reply against the table. */
export function sessionHit(cwd: string, since: number): Hit | null {
  for (const path of transcriptsSince(cwd, since).slice(0, 3)) {
    const e = lastReply(path);
    if (!e || (e.at !== null && e.at < since - 1)) continue;
    return detect(e);
  }
  return null;
}

// --- the shared file ---------------------------------------------------------------------------------------------------

export interface LimitState {
  /** When it was found (seconds since 1970). */
  at: number;
  /** The reset Claude named; null when it couldn't be read. */
  reset: number | null;
  /** Until when loops wait (without the margin): the reset, or `at` + claudeLimit.waitMinutes. */
  until: number;
  window: string | null;
  pattern: string;
  text: string;
  /** The agent that found it. */
  by: string;
}

export interface Settings {
  waitMinutes: number;
  marginSeconds: number;
  softTokens5h: number | null;
}

function whole(v: unknown, dflt: number, min: number): number {
  const n = toFloat(v);
  return n === null || n < min ? dflt : Math.trunc(n);
}

/** The claudeLimit settings, else their defaults. */
export function settingsOf(cfg: Config | Obj | null): Settings {
  const c = isObj(cfg) && isObj(cfg.claudeLimit) ? cfg.claudeLimit : {};
  const soft = toFloat(c.softTokens5h);
  return { waitMinutes: whole(c.waitMinutes, DEFAULT_WAIT_MINUTES, 1), marginSeconds: whole(c.marginSeconds, DEFAULT_MARGIN_SECONDS, 0),
    softTokens5h: soft !== null && soft > 0 ? Math.trunc(soft) : null };
}

function safeLoad(): Config | null {
  try {
    return load();
  } catch {
    return null;
  }
}

export function limitFile(dir: string = stateDir()): string {
  return join(dir, LIMIT_FILE);
}

/** The shared file as written; null when there is none or it can't be read. */
export function readLimit(path: string = limitFile()): LimitState | null {
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isObj(v) || typeof v.until !== "number" || typeof v.at !== "number") return null;
    return { at: v.at, reset: typeof v.reset === "number" ? v.reset : null, until: v.until, window: typeof v.window === "string" ? v.window : null,
      pattern: typeof v.pattern === "string" ? v.pattern : "", text: typeof v.text === "string" ? v.text : "", by: typeof v.by === "string" ? v.by : "" };
  } catch {
    return null;
  }
}

/** The limit while it holds (its `until` is still ahead), else null. */
export function activeLimit(t: number = clockNow(), path: string = limitFile()): LimitState | null {
  const s = readLimit(path);
  return s && s.until > t ? s : null;
}

/** Writes a limit found now; a later wait already in the file is kept. Safe to run twice; never half written. */
export function writeLimit(hit: Hit, by: string, t: number, s: Settings, path: string = limitFile()): LimitState {
  const until = hit.reset !== null && hit.reset > t ? hit.reset : t + s.waitMinutes * 60;
  const kept = activeLimit(t, path);
  const state: LimitState = kept && kept.until >= until ? kept
    : { at: Math.floor(t), reset: hit.reset, until: Math.floor(until), window: hit.window, pattern: hit.pattern, text: hit.text, by };
  if (state === kept) return state;
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, pyDumps(state, { indent: 2 }) + "\n");
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
  return state;
}

// --- the wait ----------------------------------------------------------------------------------------------------------

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "16:00" in this machine's time, with the day ("2026-10-27 16:00") when it is not today. */
export function clock(t: number, from: number = clockNow()): string {
  const d = new Date(t * 1000);
  const today = new Date(from * 1000);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === today.toDateString() ? hm : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}

/** The agent's state while it waits on the limit (the heartbeat shows the same words). */
export function waitingStatus(s: LimitState, t: number = clockNow()): string {
  return `waiting on the Claude limit until ${clock(s.until, t)}`;
}

/** The line the loop prints when it starts to wait. */
export function waitLine(s: LimitState, cfg: Settings, t: number = clockNow()): string {
  if (s.reset !== null) return `Claude limit reached; waiting until ${clock(s.until, t)} (local)`;
  return `Claude limit reached; its reset time couldn't be read, so waiting claudeLimit.waitMinutes (${cfg.waitMinutes} min), until ` +
    `${clock(s.until, t)} (local)`;
}

/** Says the agent's state on its card (factory_agents.ts ping), in the background; never fails the wait. */
function ping(name: string, status: string): void {
  if (!name) return;
  const script = join(import.meta.dir, "factory_agents.ts");
  try {
    statSync(script);
    spawnSync(process.execPath, ["--no-env-file", "--config=/dev/null", script, "ping", "--agent", name, "--status", status],
      { stdio: "ignore", timeout: 60_000 });
  } catch {
    // no agents script here, or it failed: the wait goes on
  }
}

/** Sleeps `seconds` of real time, saying `status` every few minutes, and ends when the loop that started it is gone.
 * No sleep under a test clock (FACTORY_NOW). */
function sleepFor(seconds: number, name: string, status: string): void {
  if ((process.env.FACTORY_NOW ?? "").trim()) return;
  const parent = process.ppid;
  const end = Date.now() + seconds * 1000;
  let pinged = Date.now();
  for (let left = seconds; left > 0; left = (end - Date.now()) / 1000) {
    Bun.sleepSync(Math.min(left, 5) * 1000);
    if (process.ppid !== parent) process.exit(130); // the loop stopped
    if (Date.now() - pinged >= PING_SECONDS * 1000 && end - Date.now() > 0) {
      ping(name, status);
      pinged = Date.now();
    }
  }
}

/** Tokens the last 5 hours of this project's sessions used (fresh input + output), from this machine's logs. */
async function used5h(t: number): Promise<number> {
  const u = await import("./factory_usage.ts");
  return u.windowReport(process.cwd(), t, null).total.window;
}

async function waitCmd(name: string): Promise<number> {
  const cfg = settingsOf(safeLoad());
  const tag = name ? `[${name}] ` : "";
  let waited = false;
  const s = activeLimit();
  if (s) {
    const t = clockNow();
    const status = waitingStatus(s, t);
    console.log(tag + waitLine(s, cfg, t));
    ping(name, status);
    sleepFor(s.until + cfg.marginSeconds - t, name, status);
    console.log(`${tag}${clock(clockNow())} the Claude limit should have reset; carrying on.`);
    waited = true;
  }
  if (cfg.softTokens5h !== null) {
    let said = false;
    for (;;) {
      const used = await used5h(clockNow());
      if (used < cfg.softTokens5h) break;
      if (!said) {
        console.log(`${tag}The last 5 hours used ${used.toLocaleString("en-US")} tokens, past claudeLimit.softTokens5h ` +
          `(${cfg.softTokens5h.toLocaleString("en-US")}): starting no new task; checking again every ${PING_SECONDS / 60} min.`);
        said = true;
      }
      ping(name, "waiting on the 5-hour token budget");
      waited = true;
      if ((process.env.FACTORY_NOW ?? "").trim()) break; // a test clock never moves: say it once
      sleepFor(PING_SECONDS, name, "waiting on the 5-hour token budget");
    }
  }
  return waited ? 0 : 1;
}

function checkCmd(name: string, since: number): number {
  const hit = sessionHit(process.cwd(), since);
  if (!hit || !hit.limit) return 1;
  const tag = name ? `[${name}] ` : "";
  const t = clockNow();
  const s = writeLimit(hit, name, t, settingsOf(safeLoad()));
  console.log(`${tag}The session ended on Claude's usage limit (${hit.pattern}${hit.window ? `, ${hit.window.replace("_", "-")} window` : ""}); ` +
    `${hit.reset !== null ? `it resets at ${clock(s.until, t)} (local)` : "its reset time couldn't be read"}.`);
  return 0;
}

const USAGE = "usage: factory_claude_limit.ts {check --since EPOCH [--name AGENT] | wait [--name AGENT] | status [--json] | detect FILE}";

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "check") {
    const a = parseArgs(rest, { valued: ["--since", "--name"] }, "factory_claude_limit.ts check", USAGE);
    const since = toFloat(a.since ?? "");
    if (since === null) die(USAGE);
    return checkCmd(String(a.name ?? ""), since);
  }
  if (cmd === "wait") {
    const a = parseArgs(rest, { valued: ["--name"] }, "factory_claude_limit.ts wait", USAGE);
    return await waitCmd(String(a.name ?? ""));
  }
  if (cmd === "status") {
    const a = parseArgs(rest, { flags: ["--json"] }, "factory_claude_limit.ts status", USAGE);
    const s = activeLimit();
    if (a.json) console.log(pyDumps({ limit: s }, { indent: 2 }));
    else console.log(s ? waitLine(s, settingsOf(safeLoad())) : "No Claude limit is known on this machine.");
    return 0;
  }
  if (cmd === "detect") {
    const e = rest[0] ? lastReply(rest[0]) : null;
    console.log(pyDumps({ hit: e ? detect(e) : null }, { indent: 2 }));
    return 0;
  }
  die(USAGE);
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
