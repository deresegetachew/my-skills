#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// Pull requests and CI over NATS: one reader per hub, everyone else listens. When `pr` is in `messaging.kinds` (and
// `messaging.transport` is nats), one watcher per project reads the open pull requests, their head, checks and labels
// from GitHub, keeps what it saw as a snapshot in the hub's key-value bucket, and publishes one event per change
// (opened, head, checks, labels, draft, merged, closed). The readers (`factory wait slot` and `ci`, the PR-slot check
// before a pull request opens, the dev manager's pass over the open pull requests, the coding agents' rework check)
// read the snapshot and listen for the events instead of asking GitHub. GitHub stays the record: the PR gate, the
// merge and every write still go to GitHub, and a reader whose snapshot is older than `messaging.pollMinutes` (no
// watcher, NATS down) asks GitHub exactly as before.
//
// The watcher asks with conditional requests (`If-None-Match` with the ETag of the last answer): an unchanged list or
// check run comes back as 304 Not Modified, which doesn't count against GitHub's REST limit. Only one runs per
// project: it holds the NATS claim `pr-feed` and gives up when another holder has it. The dev manager's orchestrator
// starts it (factory_orchestrator.ts cycle) on the machine the dev manager runs on; it ends when that loop ends.
//
//   factory_pr_feed.ts look [--name N]                 one look at GitHub: write the snapshot, publish the changes
//   factory_pr_feed.ts watch --name N [--parent PID]   look every FACTORY_PR_FEED_SECONDS (60), sooner on a wake-up,
//                                                      while PID lives and this watcher holds the claim
//   factory_pr_feed.ts show                            the snapshot as JSON (exit 2 when there is none, or it is old)
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Config, load, roleNames, safeAgent, toFloat } from "./factory_config.ts";
import { judge, type Row } from "./factory_ci_judge.ts";
import { bunCmd, Exit, GITHUB_BUSY, githubBusy, parseArgs, pyDumps, run, runMain } from "./factory_lib.ts";
import { busTransport, messagingSettings, natsFor } from "./core/compose.ts";
import type { CoreError } from "./core/domain/error.ts";
import type { Leases, PrEvent, PrFeed, PrSnapshot, PrState } from "./core/ports/messaging.ts";
import { notice, waitForWake } from "./factory_wake.ts";

export const FEED_CLAIM = "pr-feed";
const BODY_MAX = 4000;

/** Whether the settings move pull request reads to NATS or the message board (no connection is made to answer). */
export function prFeedIsOn(cfg: Config): boolean {
  const s = messagingSettings(cfg);
  return busTransport(s) && s.kinds.includes("pr");
}

/** NATS's pull request feed (and its claims), or null: `pr` isn't on, or NATS can't be had (`notice` says so, once). */
export function feedOn(cfg: Config): (PrFeed & Leases) | null {
  if (!prFeedIsOn(cfg)) return null;
  try {
    return natsFor(cfg, "pr", notice);
  } catch (e) {
    notice(e as CoreError);
    return null;
  }
}

/** The watcher's snapshot while it is fresh (written within `messaging.pollMinutes`), else null: then the caller asks
 * GitHub, as it always did. */
export function freshPrs(cfg: Config): PrSnapshot | null {
  const feed = feedOn(cfg);
  if (!feed) return null;
  try {
    const s = feed.prs();
    return s && Date.now() - s.at <= messagingSettings(cfg).pollMinutes * 60_000 ? s : null;
  } catch (e) {
    notice(e as CoreError);
    return null;
  }
}

/** Waits up to `seconds` for a pull request event said since `since` (ms); true when one came. */
export type Waker = (seconds: number, since: number) => boolean;

/** A waker that listens for the watcher's events (about pull request `pr` when given), and how long a wait listens
 * before it reads again (messaging.pollMinutes). Null while `pr` isn't on NATS. */
export function prWaker(cfg: Config, pr?: number): { wake: Waker; seconds: number } | null {
  const feed = feedOn(cfg);
  if (!feed) return null;
  return {
    wake: (seconds, since) => {
      try {
        return feed.prEvents({ since, seconds, ...(pr ? { pr } : {}), first: true }).length > 0;
      } catch (e) {
        notice(e as CoreError);
        Bun.sleepSync(Math.max(0, seconds) * 1000);
        return false;
      }
    },
    seconds: messagingSettings(cfg).pollMinutes * 60,
  };
}

/** A pull request the way GitHub's REST API lists it, from the snapshot: what the readers read. */
export interface FeedPull {
  number: number;
  state: string;
  draft: boolean;
  title: string;
  body: string;
  user: { login: string };
  head: { sha: string; ref: string; repo: { full_name: string } };
  base: { ref: string };
  labels: { name: string }[];
  updated_at: string;
  mergeable_state: string;
  [key: string]: unknown;
}

export function asPull(p: PrState): FeedPull {
  return { number: p.number, state: "open", draft: p.draft, title: p.title, body: p.body, user: { login: p.author },
    head: { sha: p.head, ref: p.branch, repo: { full_name: p.headRepo } }, base: { ref: p.base },
    labels: p.labels.map((name) => ({ name })), updated_at: p.updated, mergeable_state: p.mergeable };
}

/** The open pull requests the snapshot's account has ready (not drafts): what the gate's `maxOpenPRs` counts. */
export function readyOf(s: PrSnapshot): number[] {
  return s.prs.filter((p) => !p.draft && p.author === s.login).map((p) => p.number).sort((a, b) => a - b);
}

// --- reading GitHub with conditional requests ------------------------------------------------------------------------

interface Kept {
  etag: string;
  data: unknown;
}

/** The watcher's own memory, on this machine: the last answer and ETag for each path, and the head commits' times. */
interface State {
  paths: Record<string, Kept>;
  headAt: Record<string, string | null>;
}

function commonDir(): string {
  const p = run(["git", "rev-parse", "--git-common-dir"]);
  return resolve(p.stdout.trim() || ".git");
}

function statePath(): string {
  return join(commonDir(), "factory-manager", "pr-feed.json");
}

function loadState(): State {
  try {
    const s = JSON.parse(readFileSync(statePath(), "utf8")) as Partial<State>;
    return { paths: s.paths ?? {}, headAt: s.headAt ?? {} };
  } catch {
    return { paths: {}, headAt: {} };
  }
}

function saveState(s: State): void {
  const path = statePath();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(`${path}.${process.pid}.tmp`, JSON.stringify(s));
  renameSync(`${path}.${process.pid}.tmp`, path);
}

/** GET `path`, sending the ETag of the last answer: a 304 gives the kept answer back (and costs no REST call). */
export function getConditional<T>(path: string, state: State, used: Set<string>): T {
  used.add(path);
  const had = state.paths[path];
  const args = ["gh", "api", "-i", "-X", "GET", path, "-H", "Accept: application/vnd.github+json"];
  if (had?.etag) args.push("-H", `If-None-Match: ${had.etag}`);
  const p = run(args);
  const status = /^HTTP\/\S+\s+(\d{3})/.exec(p.stdout);
  let body = p.stdout;
  let etag = "";
  if (status) {
    const split = /\r?\n\r?\n/.exec(p.stdout);
    const headers = split ? p.stdout.slice(0, split.index) : p.stdout;
    body = split ? p.stdout.slice(split.index + split[0].length) : "";
    etag = /^etag:\s*(.+?)\s*$/im.exec(headers)?.[1] ?? "";
    if (Number(status[1]) === 304 && had) return had.data as T;
  }
  if (p.code !== 0 && !(status && Number(status[1]) < 300)) {
    const said = (p.stderr || p.stdout).trim();
    throw new Exit(`gh api GET ${path} failed: ${said.slice(0, 300)}`, githubBusy(said) ? GITHUB_BUSY : 1);
  }
  const data = (body.trim() ? JSON.parse(body) : null) as T;
  state.paths[path] = { etag, data };
  return data;
}

interface RawPull {
  number: number;
  title?: string;
  body?: string | null;
  draft?: boolean;
  user?: { login?: string } | null;
  head: { sha: string; ref?: string; repo?: { full_name?: string } | null };
  base?: { ref?: string };
  labels?: { name: string }[];
  updated_at?: string;
  merged_at?: string | null;
  closed_at?: string | null;
  mergeable_state?: string;
}

const RUN_FIELDS = ["id", "name", "status", "conclusion", "started_at", "created_at", "completed_at"];
const STATUS_FIELDS = ["context", "state", "created_at", "updated_at"];

function cut(rows: unknown, fields: string[]): Record<string, unknown>[] {
  if (!Array.isArray(rows)) return [];
  return rows.filter((r): r is Row => typeof r === "object" && r !== null)
    .map((r) => Object.fromEntries(fields.filter((f) => f in r).map((f) => [f, r[f]])));
}

/** The changes between two snapshots, one event per change. The first snapshot has nothing to compare with. */
export function changes(before: PrSnapshot | null, after: PrSnapshot): PrEvent[] {
  if (!before) return [];
  const out: PrEvent[] = [];
  const at = new Date(after.at).toISOString();
  const event = (p: PrState, change: string): PrEvent =>
    ({ pr: p.number, change, from: after.by, head: p.head, checks: p.checks, labels: p.labels, at });
  const old = new Map(before.prs.map((p) => [p.number, p]));
  for (const p of after.prs) {
    const was = old.get(p.number);
    if (!was) {
      out.push(event(p, "opened"));
      continue;
    }
    if (was.head !== p.head) out.push(event(p, "head"));
    else if (was.checks !== p.checks) out.push(event(p, "checks"));
    if ([...was.labels].sort().join("\n") !== [...p.labels].sort().join("\n")) out.push(event(p, "labels"));
    if (was.draft !== p.draft) out.push(event(p, "draft"));
  }
  const open = new Set(after.prs.map((p) => p.number));
  for (const p of before.prs) {
    if (open.has(p.number)) continue;
    const gone = after.closed.find((c) => c.number === p.number);
    out.push({ ...event(p, gone && !gone.merged ? "closed" : "merged"), checks: p.checks });
  }
  return out;
}

export interface Looked {
  held: boolean;
  holder: string;
  snapshot: PrSnapshot | null;
  events: PrEvent[];
}

function ttlSeconds(): number {
  return Math.max(30, 3 * interval());
}

function interval(): number {
  return Math.max(1, toFloat(process.env.FACTORY_PR_FEED_SECONDS ?? 60) ?? 60);
}

/** One look at GitHub as watcher `name`: the snapshot is written and the changes published. Another watcher holding
 * the claim: nothing is read (held false). Throws Exit when GitHub can't be read; the snapshot then stays as it was. */
export function look(cfg: Config, name: string, feed: PrFeed & Leases): Looked {
  const claim = feed.claim(FEED_CLAIM, name, ttlSeconds());
  if (!claim.held) return { held: false, holder: claim.holder, snapshot: null, events: [] };
  const state = loadState();
  const used = new Set<string>();
  const before = feed.prs();
  const login = (getConditional<{ login?: string } | null>("user", state, used) ?? {}).login ?? "";
  const repo = (getConditional<{ full_name?: string } | null>("repos/{owner}/{repo}", state, used) ?? {}).full_name ?? "";
  const open = getConditional<RawPull[] | null>("repos/{owner}/{repo}/pulls?state=open&per_page=100", state, used) ?? [];
  const closed = getConditional<RawPull[] | null>("repos/{owner}/{repo}/pulls?state=closed&sort=updated&direction=desc&per_page=10",
    state, used) ?? [];
  const prs: PrState[] = [];
  for (const raw of [...open].sort((a, b) => a.number - b.number)) {
    const n = raw.number;
    const sha = raw.head.sha;
    const detail = getConditional<RawPull | null>(`repos/{owner}/{repo}/pulls/${n}`, state, used) ?? raw;
    const runs = cut((getConditional<{ check_runs?: unknown } | null>(`repos/{owner}/{repo}/commits/${sha}/check-runs?per_page=100`,
      state, used) ?? {}).check_runs, RUN_FIELDS);
    const statuses = cut((getConditional<{ statuses?: unknown } | null>(`repos/{owner}/{repo}/commits/${sha}/status?per_page=100`,
      state, used) ?? {}).statuses, STATUS_FIELDS);
    if (!(sha in state.headAt)) {
      const c = getConditional<{ commit?: { committer?: { date?: string } | null } | null } | null>(`repos/{owner}/{repo}/commits/${sha}`,
        state, new Set()) ?? {};
      state.headAt[sha] = c.commit?.committer?.date ?? null;
      delete state.paths[`repos/{owner}/{repo}/commits/${sha}`]; // a commit never changes: its time is kept below
    }
    prs.push({ number: n, title: raw.title ?? "", body: (raw.body ?? "").slice(0, BODY_MAX), author: raw.user?.login ?? "",
      draft: Boolean(raw.draft), branch: raw.head.ref ?? "", base: raw.base?.ref ?? "", headRepo: raw.head.repo?.full_name ?? "",
      head: sha, headAt: state.headAt[sha] ?? null, labels: (raw.labels ?? []).map((l) => l.name).sort(),
      updated: raw.updated_at ?? "", mergeable: detail.mergeable_state ?? "", checks: judge(runs, statuses)[0], runs, statuses });
  }
  const snapshot: PrSnapshot = { v: 1, at: Date.now(), by: name, login, repo, prs,
    closed: closed.map((c) => ({ number: c.number, merged: Boolean(c.merged_at), at: c.merged_at ?? c.closed_at ?? "" })) };
  const events = changes(before, snapshot);
  feed.putPrs(snapshot, events);
  for (const path of Object.keys(state.paths)) if (!used.has(path)) delete state.paths[path];
  const heads = new Set(prs.map((p) => p.head));
  for (const sha of Object.keys(state.headAt)) if (!heads.has(sha)) delete state.headAt[sha];
  saveState(state);
  return { held: true, holder: name, snapshot, events };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function logLine(line: string): void {
  try {
    mkdirSync(join(commonDir(), "factory-manager"), { recursive: true });
    appendFileSync(join(commonDir(), "factory-manager", "pr-feed.log"), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // the log is a convenience
  }
}

/** Look every interval (sooner when a wake-up for the dev manager comes) while `parent` lives and this watcher holds
 * the claim. */
export function watch(cfg: Config, name: string, feed: PrFeed & Leases, parent: number | null): number {
  for (;;) {
    if (parent !== null && !alive(parent)) return 0;
    try {
      const r = look(cfg, name, feed);
      if (!r.held) {
        logLine(`${name}: ${r.holder} watches the pull requests; stopping`);
        return 0;
      }
      for (const e of r.events) logLine(`${name}: pr#${e.pr} ${e.change} (head ${e.head.slice(0, 7)}, checks ${e.checks})`);
    } catch (e) {
      if (!(e instanceof Exit)) throw e;
      logLine(`${name}: could not read GitHub (${e.text ?? e.exitCode}); the readers ask GitHub themselves until it can`);
    }
    waitForWake(cfg, name, interval());
  }
}

/** For the dev manager's cycle: start the watcher for this project when nobody holds its claim. Says who watches and
 * whether it was started now, or null while `pr` isn't on NATS. */
export function ensureWatcher(cfg: Config, name: string, dry = false): { holder: string; started: boolean } | null {
  const feed = feedOn(cfg);
  if (!feed) return null;
  let holder: string;
  try {
    holder = feed.holder(FEED_CLAIM);
  } catch (e) {
    notice(e as CoreError);
    return null;
  }
  if (holder || dry) return { holder, started: false };
  const p = Bun.spawn([...bunCmd(import.meta.path), "watch", "--name", name, "--parent", String(process.ppid)], {
    stdio: ["ignore", "ignore", "ignore"], detached: true, cwd: process.cwd(), env: { ...process.env, FACTORY_AGENT: name },
  });
  p.unref();
  return { holder: name, started: true };
}

// --- the command ------------------------------------------------------------------------------------------------------

const USAGE = "usage: factory_pr_feed.ts look [--name N] | watch --name N [--parent PID] | show";

export function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  if (cmd !== "look" && cmd !== "watch" && cmd !== "show") {
    process.stderr.write(`${USAGE}\n`);
    throw new Exit(2);
  }
  const cfg = load();
  if (cmd === "show") {
    const s = freshPrs(cfg);
    if (!s) {
      console.log(prFeedIsOn(cfg) ? "no fresh pull request snapshot: the readers ask GitHub" : "pr isn't in messaging.kinds");
      return 2;
    }
    console.log(pyDumps(s));
    return 0;
  }
  const a = parseArgs(rest, { valued: ["--name", "--parent"], flags: [] }, `factory_pr_feed.ts ${cmd}`, USAGE);
  const given = (a.name as string | undefined) ?? process.env.FACTORY_AGENT;
  const name = safeAgent(given || (roleNames(cfg, "dev-manager")[0] ?? "manager"));
  const feed = feedOn(cfg);
  if (!feed) {
    console.log("pr isn't in messaging.kinds, or NATS can't be reached: nothing to watch");
    return 2;
  }
  if (cmd === "watch") {
    const parent = a.parent ? Number(a.parent) : null;
    return watch(cfg, name, feed, parent !== null && Number.isInteger(parent) ? parent : null);
  }
  const r = look(cfg, name, feed);
  if (!r.held) {
    console.log(`${r.holder} watches the pull requests; nothing read`);
    return 0;
  }
  console.log(`${r.snapshot?.prs.length ?? 0} open pull request(s); ${r.events.length} change(s)` +
    r.events.map((e) => `\npr#${e.pr} ${e.change}`).join(""));
  return 0;
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
