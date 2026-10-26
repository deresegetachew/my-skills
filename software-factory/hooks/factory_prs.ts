#!/usr/bin/env -S bun --no-env-file
// `factory prs`: the one list a dev manager starts a pass from (#98). Read-only, REST only (`gh api`; no `gh pr`).
//
// For every open pull request: the head and its age, labels, CI judged by one rule, the newest marker per commit,
// the review claim, and the next action. Below them: unanswered questions, unanswered owner asks, agents that went
// quiet. `factory status` uses the same CI rule and the same reading of the dev manager's markers (this file).
//
//   bun --no-env-file .claude/hooks/factory_prs.ts [--json] [--since-days N]
//
// The CI rule: per job name, the newest run that was not skipped decides (a re-run replaces a failure; a skipped run
// decides nothing). One state for the PR: red (a job failed), running, queued, green; `none` when GitHub shows no
// runs yet; `unknown` when they could not be read. The next action is one of: review, merge, wait CI, rerun flake,
// waiting for agent, owner merges (protected), owner merges (own PR), held by <manager>, none.
import { agentIssues, current, stateOf } from "./factory_agents.ts";
import { type Config, branchTask, load, loadFromMain, taskLabels, taskSource } from "./factory_config.ts";
import * as fi from "./factory_issues.ts";
import { Exit, isoUtc, parseArgs, parseIso, pyDumps, pyInt, runMain } from "./factory_lib.ts";
import * as claims from "./factory_manager_claims.ts";

const SHA_IN = /sha=([0-9a-f]{7,40})/;
const MARKER = /<!--\s*(factory-approved|factory-mustfix|pr-watch)\b([^>]*?)-->/g;
const QUESTION = /<!--\s*factory-question\b/;
const ANSWER = /<!--\s*factory-answer\b/;
export const OWNER_ASK = /<!--\s*factory-owner-ask\s+id=([\w.-]+)(?:\s+[^>]*?)?\s*-->/; // for=product may follow
const OWNER_ANSWER = /<!--\s*factory-owner-answer\s+id=([\w.-]+)\s*-->/;
export const OWNER_QUEUE_TITLE = "Dev manager: needs the owner";
const PERSON_MERGES = "a person merges this one";
const GREEN = ["success", "neutral"];
const TEXT: Record<string, string> = { review: "review", merge: "merge", "wait-ci": "wait CI", "rerun-flake": "rerun flake",
  "waiting-for-agent": "waiting for agent", none: "none" };

type Obj = { [key: string]: unknown };
export type Failed = { error: string };

function obj(v: unknown): Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {};
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** The text of an error the way Python's str(e) printed it (an Exit's message, or the class name when empty). */
export function errorText(e: unknown): string {
  if (e instanceof Exit) return e.text ?? String(e.exitCode);
  if (e instanceof Error) return e.message || e.name;
  return String(e);
}

/** fn's result, or {error} when it fails (factory_issues stops on errors). */
export function section<T>(fn: () => T): T | Failed {
  try {
    return fn();
  } catch (e) {
    return { error: errorText(e) };
  }
}

export function isFailed(v: unknown): v is Failed {
  return typeof v === "object" && v !== null && !Array.isArray(v) && "error" in v;
}

export function minutesSince(stamp: unknown, now: number): number | null {
  const t = typeof stamp === "string" && stamp ? parseIso(stamp) : null;
  return t === null ? null : Math.max(0, Math.floor((now - t) / 60));
}

export function human(m: number | null): string {
  return m === null ? "" : m < 120 ? `${m} min` : m < 2880 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / 1440)} d`;
}

// --- CI judged by the rule --------------------------------------------------------------------------------------

export type Run = Obj;

/** {job name: [its newest run that was not skipped, how many such runs there are]}. */
export function newestRuns(runs: Run[]): Map<string, [Run, number]> {
  const by = new Map<string, Run[]>();
  for (const r of runs) {
    if (r.conclusion === "skipped") continue;
    const name = str(r.name) || (r.name === undefined ? "?" : String(r.name));
    if (!by.has(name)) by.set(name, []);
    (by.get(name) as Run[]).push(r);
  }
  const out = new Map<string, [Run, number]>();
  for (const [n, rs] of by) {
    let best = rs[0] as Run;
    for (const r of rs.slice(1)) {
      const ka = str(best.started_at);
      const kb = str(r.started_at);
      if (kb > ka || (kb === ka && Number(r.id ?? 0) > Number(best.id ?? 0))) best = r;
    }
    out.set(n, [best, rs.length]);
  }
  return out;
}

function jobState(run: Run): string {
  if (run.status !== "completed") {
    return ["queued", "waiting", "pending", "requested"].includes(str(run.status)) ? "queued" : "running";
  }
  return GREEN.includes(str(run.conclusion)) ? "green" : "red";
}

export type NotGreen = { name: string; state: string };

/** [state, the jobs that are not green]. red beats running beats queued beats green. */
export function judgeCi(runs: Run[]): [string, NotGreen[]] {
  if (!runs.length) return ["none", []];
  const jobs = new Map([...newestRuns(runs)].map(([n, [r]]) => [n, jobState(r)]));
  const bad = [...jobs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).filter(([, s]) => s !== "green")
    .map(([name, state]) => ({ name, state }));
  for (const state of ["red", "running", "queued"]) {
    if ([...jobs.values()].includes(state)) return [state, bad];
  }
  return ["green", bad]; // also when every run was skipped: nothing is failing or waiting
}

function checkRuns(sha: string): Run[] {
  const out: Run[] = [];
  for (let page = 1; ; page++) {
    const got = fi.gh<unknown>("GET", `repos/{owner}/{repo}/commits/${sha}/check-runs?per_page=100&page=${page}`);
    const chunk = Array.isArray(obj(got).check_runs) ? (obj(got).check_runs as Run[]) : [];
    out.push(...chunk);
    if (chunk.length < 100) return out;
  }
}

/** [state, notGreen, runs] for a commit. `unknown` when its checks could not be read; the others still show. */
export function ciState(sha: string): [string, NotGreen[], Run[]] {
  let runs: Run[];
  try {
    runs = checkRuns(sha);
  } catch (e) {
    if (e instanceof Exit) return ["unknown", [], []];
    throw e;
  }
  const [state, bad] = judgeCi(runs);
  return [state, bad, runs];
}

// --- the dev manager's markers ----------------------------------------------------------------------------------

function namesHead(sha: string | null, head: string): boolean {
  return Boolean(sha) && (head.startsWith(sha as string) || (sha as string).startsWith(head));
}

function loginOf(c: Obj): string {
  return str(obj(c.user ?? c.author).login);
}

/** The dev manager's word on a PR, by the PR gate's rule (pr-gate.ts, gateMerge): the last marker counts; an
 * approval only from a trusted login (when `trustedReviewers` is set on main) and only for the head commit. */
export function gateWord(comments: Obj[], head: string, trusted: Set<string>): string | null {
  let last: string | null = null;
  let mustfixSha: string | null = null;
  for (const c of comments) {
    const body = str(c.body);
    const login = loginOf(c);
    if (body.includes("<!-- factory-mustfix")) {
      last = "mustfix";
      mustfixSha = SHA_IN.exec(body)?.[1] ?? null;
    } else if (body.includes("<!-- factory-approved") && (!trusted.size || trusted.has(login))) {
      const m = /factory-approved\s+sha=([0-9a-f]{7,40})/.exec(body);
      last = m && head.startsWith(m[1] as string) ? "approved" : "stale";
    }
  }
  if (last === "mustfix") { // it holds the merge whatever commit it names, until an approval of the head
    return !mustfixSha || head.startsWith(mustfixSha) ? "must-fix" : "must-fix (older commit)";
  }
  return last === "approved" ? "approved" : last === "stale" ? "approval stale" : null;
}

export interface MarkerRow {
  kind: string;
  sha: string | null;
  at: unknown;
  namesHead: boolean;
}

/** The newest marker per commit, oldest first, and the kind that names the head. */
export function markersOf(comments: Obj[], head: string, trusted: Set<string>): [MarkerRow[], string | null] {
  const newest = new Map<string | null, MarkerRow>();
  for (const c of comments) {
    const login = loginOf(c);
    for (const m of str(c.body).matchAll(MARKER)) {
      const kind = m[1] as string;
      if (kind === "factory-approved" && trusted.size && !trusted.has(login)) continue; // only a trusted login's approval counts
      const sha = SHA_IN.exec(m[2] as string)?.[1] ?? null;
      const key = sha === null ? null
        : [...newest.keys()].find((k) => k && (namesHead(k, sha) || namesHead(sha, k))) ?? sha;
      newest.set(key, { kind, sha, at: c.created_at ?? null, namesHead: namesHead(sha, head) });
    }
  }
  const found = [...newest.values()].map((m, i) => [m, i] as const)
    .sort(([a, i], [b, j]) => (str(a.at) < str(b.at) ? -1 : str(a.at) > str(b.at) ? 1 : i - j)).map(([m]) => m);
  const headKind = [...found].reverse().find((m) => m.namesHead)?.kind ?? null;
  return [found, headKind];
}

export type ClaimRow = { manager: string; until: string; expired: boolean };

/** [the review claim that holds this head or null, whether an expired one exists for it]. The claim protocol itself
 * (earliest unexpired wins, releases, the lease cap) lives in factory_manager_claims.ts (#99). */
export function claimOf(comments: Obj[], head: string, now: number): [ClaimRow | null, boolean] {
  const held = claims.reviewWinner(comments as claims.Comment[], head, now);
  if (held) return [{ manager: held.manager, until: claims.stamp(held.until), expired: false }, false];
  const seen = (comments as claims.Comment[]).map(claims.parseMarker).filter((m) => m && m.kind === "review" && claims.sameSha(head, m.sha));
  return [null, seen.length > 0];
}

/** Comments with a `factory-question` and no later `factory-answer` (an answer clears what is open before it). */
export function openQuestions(comments: Obj[]): Obj[] {
  let asked: Obj[] = [];
  for (const c of comments) {
    const body = str(c.body);
    if (QUESTION.test(body)) asked.push(c);
    else if (ANSWER.test(body)) asked = [];
  }
  return asked;
}

/** Owner-queue asks nobody has answered: no later comment before the next ask, and no owner-answer marker. */
export function openOwnerAsks(comments: Obj[]): [string, Obj][] {
  const asks: [string, Obj][] = [];
  const answered = new Set<string>();
  for (const c of comments) {
    const body = str(c.body);
    const ask = OWNER_ASK.exec(body);
    if (ask) {
      asks.push([ask[1] as string, c]);
      continue;
    }
    const marked = OWNER_ANSWER.exec(body);
    if (marked) answered.add(marked[1] as string);
    else if (asks.length && !answered.has((asks[asks.length - 1] as [string, Obj])[0])) {
      answered.add((asks[asks.length - 1] as [string, Obj])[0]); // a reply under the newest ask, before the next one
    }
  }
  return asks.filter(([slug]) => !answered.has(slug));
}

// --- the next action ---------------------------------------------------------------------------------------------

export type Action = { action: string; text: string; [key: string]: unknown };

function act(action: string, more: Obj = {}): Action {
  return { action, text: TEXT[action] ?? action, ...more };
}

export interface PullRow {
  number: number;
  title: string;
  url: unknown;
  branch: string;
  draft: boolean;
  head?: { sha: string; ageMinutes: number | null };
  labels?: string[];
  agent?: string | null;
  agentPr?: boolean;
  ci?: { state: string; notGreen: NotGreen[]; runs: number };
  markers?: MarkerRow[];
  headMarker?: string | null;
  gate?: string | null;
  claim?: ClaimRow | null;
  staleHold?: boolean;
  protected?: boolean | null;
  next?: Action;
}

/** One next step for the manager, from what the record already holds (see docs/wiki/dev-manager.md for the order). */
export function nextAction(p: PullRow, held: boolean, runsByJob: Map<string, number>, flakes: Set<string>): Action {
  const ci = p.ci as { state: string; notGreen: NotGreen[] };
  const claim = p.claim ?? null;
  const head = p.headMarker ?? null;
  if (held) {
    if (!(p.staleHold && head === null)) {
      const who = claim ? claim.manager : "manager";
      return act("held", { text: `held by ${who}`, by: who });
    }
  }
  if (p.draft) return act("waiting-for-agent");
  if (ci.state === "unknown") return act("none", { error: "CI could not be read" });
  const waiting = ["running", "queued", "none"].includes(ci.state);
  if (!p.agentPr) { // the manager's own PR (or a person's): the manager never merges it
    if (ci.state === "red") return act("none", { reason: "not-agent-pr" });
    if (waiting) return act("wait-ci");
    return act("owner-merges", { text: "owner merges (own PR)", reason: "not-agent-pr" });
  }
  if (head === "factory-mustfix" || (head === "factory-approved" && p.gate && p.gate.startsWith("must-fix"))) {
    return act("waiting-for-agent");
  }
  if (ci.state === "red") {
    const red = ci.notGreen.filter((j) => j.state === "red").map((j) => j.name);
    if (red.length && red.every((n) => flakes.has(n) && runsByJob.get(n) === 1)) return act("rerun-flake", { jobs: red });
    return act("waiting-for-agent");
  }
  if (head === null) return act("review");
  if (head === "pr-watch") return act("none");
  if (waiting) return act("wait-ci");
  if (p.protected === null || p.protected === undefined) return act("none", { error: "changed files could not be read" });
  if (p.protected) return act("owner-merges", { text: "owner merges (protected)", reason: "protected" });
  return act("merge");
}

// --- assembling the list -----------------------------------------------------------------------------------------

function isProtected(number: number, body: unknown, cfg: Config): boolean {
  if (str(body).toLowerCase().includes(PERSON_MERGES)) return true;
  const files = fi.ghAll<Obj>(`repos/{owner}/{repo}/pulls/${number}/files`).map((f) => str(f.filename));
  return files.some((f) => !cfg.alwaysAllowed.includes(f) && cfg.protected.some((rx) => new RegExp(rx).test(f)));
}

export function trustedOf(cfg: Config): Set<string> {
  return new Set(Array.isArray(cfg.trustedReviewers) ? (cfg.trustedReviewers as unknown[]).map(String) : []);
}

type Pulls = { pulls: PullRow[]; comments: Map<number, Obj[]> };

function pulls(_cfg: Config, gateCfg: Config, now: number): Pulls {
  const trusted = trustedOf(gateCfg);
  const hold = gateCfg.holdLabel ?? "factory-hold";
  const mgr = obj(gateCfg.manager);
  const flakes = new Set(Array.isArray(mgr.flakes) ? (mgr.flakes as unknown[]).map(String) : []);
  const prefix = taskLabels(gateCfg).agentPrefix;
  const commentsBy = new Map<number, Obj[]>();

  const one = (p: Obj): PullRow => {
    const n = Number(p.number);
    const sha = str(obj(p.head).sha);
    const branch = str(obj(p.head).ref);
    const out: PullRow = { number: n, title: str(p.title), url: p.html_url ?? null, branch, draft: Boolean(p.draft) };
    try {
      const labels = (Array.isArray(p.labels) ? p.labels : []).map((x) => str(obj(x).name));
      const comments = fi.ghAll<Obj>(`repos/{owner}/{repo}/issues/${n}/comments`);
      commentsBy.set(n, comments);
      const date = obj(obj(obj(fi.gh<unknown>("GET", `repos/{owner}/{repo}/commits/${sha}`)).commit).committer).date;
      const [state, bad, runs] = ciState(sha);
      const [marks, headKind] = markersOf(comments, sha, trusted);
      const [claim, expired] = claimOf(comments, sha, now);
      const agent = labels.find((x) => x.startsWith(prefix))?.slice(prefix.length) ?? null;
      Object.assign(out, { head: { sha, ageMinutes: minutesSince(date, now) }, labels, agent,
        agentPr: Boolean(agent) || branchTask(branch) !== null, ci: { state, notGreen: bad, runs: runs.length },
        markers: marks, headMarker: headKind, gate: gateWord(comments, sha, trusted), claim,
        staleHold: labels.includes(hold) && expired && claim === null, protected: null });
      const held = labels.includes(hold);
      const ready = out.agentPr && !out.draft && headKind === "factory-approved" && state === "green" && !held;
      if (ready) { // only a PR that could be merged is worth the extra call
        try {
          out.protected = isProtected(n, p.body, gateCfg);
        } catch (e) {
          if (!(e instanceof Exit)) throw e;
          out.protected = null;
        }
      }
      const runsByJob = new Map([...newestRuns(runs)].map(([k, [, c]]) => [k, c]));
      out.next = nextAction(out, held, runsByJob, flakes);
    } catch (e) {
      out.next = act("none", { error: errorText(e) });
    }
    return out;
  };

  const rows = fi.ghAll<Obj>("repos/{owner}/{repo}/pulls?state=open").sort((a, b) => Number(a.number) - Number(b.number)).map(one);
  return { pulls: rows, comments: commentsBy };
}

export type QuestionOut = { kind: string; number: number; title: string; url: unknown; ageMinutes: number | null };
export type AskOut = { id: string; issue: number; url: unknown; ageMinutes: number | null };

/** Unanswered questions on open PRs and open issues, and unanswered owner-queue asks. */
function questionsAndAsks(openPrs: PullRow[], commentsBy: Map<number, Obj[]>, now: number, sinceDays: number): [QuestionOut[], AskOut[]] {
  const issues = fi.ghAll<Obj>("repos/{owner}/{repo}/issues?state=open");
  const plain = new Map<number, Obj>(issues.filter((i) => !("pull_request" in i)).map((i) => [Number(i.number), i]));
  const prs = new Map(openPrs.map((p) => [p.number, p]));
  const found: [string, number, string, Obj, unknown][] = [];
  for (const [n, comments] of commentsBy) {
    for (const c of openQuestions(comments)) found.push(["pr", n, (prs.get(n) as PullRow).title, c, (prs.get(n) as PullRow).url]);
  }
  const since = isoUtc(now - sinceDays * 86400);
  const perIssue = new Map<number, Obj[]>();
  for (const c of fi.ghAll<Obj>(`repos/{owner}/{repo}/issues/comments?sort=created&direction=asc&since=${since}`)) {
    const m = /\/issues\/(\d+)$/.exec(str(c.issue_url));
    if (m && plain.has(Number(m[1]))) {
      const k = Number(m[1]);
      if (!perIssue.has(k)) perIssue.set(k, []);
      (perIssue.get(k) as Obj[]).push(c);
    }
  }
  for (const [n, comments] of perIssue) {
    for (const c of openQuestions(comments)) found.push(["issue", n, str((plain.get(n) as Obj).title), c, null]);
  }
  const qs = found.map((x, i) => [x, i] as const)
    .sort(([a, i], [b, j]) => { const ka = str(a[3].created_at); const kb = str(b[3].created_at); return ka < kb ? -1 : ka > kb ? 1 : i - j; })
    .map(([[k, n, t, c, u]]) => ({ kind: k, number: n, title: t, url: c.html_url || u, ageMinutes: minutesSince(c.created_at, now) }));
  const asks: AskOut[] = [];
  for (const [n, i] of plain) {
    if (str(i.title).startsWith(OWNER_QUEUE_TITLE)) {
      for (const [slug, c] of openOwnerAsks(fi.ghAll<Obj>(`repos/{owner}/{repo}/issues/${n}/comments`))) {
        asks.push({ id: slug, issue: n, url: c.html_url ?? null, ageMinutes: minutesSince(c.created_at, now) });
      }
    }
  }
  return [qs, asks];
}

type Quiet = { note?: string; agents: { name: string; status: string; minutesAgo: number }[];
  staleTasks: { number: number; title: string; quietHours: number }[] };

/** Python's round() to n places (half to even on the decimal value, close enough for these displays). */
function round(x: number, places = 0): number {
  const f = 10 ** places;
  const v = x * f;
  const r = Math.round(v);
  const even = Math.abs(v - Math.trunc(v)) === 0.5 ? 2 * Math.round(v / 2) : r;
  return even / f;
}

/** Agents silent or down, and in-progress tasks with no activity (issues mode). */
function quiet(cfg: Config, now: number): Quiet {
  if (taskSource(cfg) !== "issues") {
    return { note: "agents report on GitHub in issues mode only (tasks.source \"issues\")", agents: [], staleTasks: [] };
  }
  const rows = current(agentIssues()).map((i) => stateOf(cfg, i)).filter((r) => r !== null);
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[2] - b[2]));
  const agents = rows.filter(([, s]) => s === "silent" || s === "down").map(([n, s, , q]) => ({ name: n, status: s, minutesAgo: round(q) }));
  const L = taskLabels(cfg);
  const staleHours = Number(obj(cfg.tasks).staleHours ?? 3);
  const stale: Quiet["staleTasks"] = [];
  for (const i of fi.taskIssues("open", L.inProgress)) {
    if (!fi.names(i).has(L.inProgress)) continue;
    const age = (now - fi.lastActivity(i)) / 3600;
    if (age >= staleHours && !fi.waitingForSlot(cfg, i)) stale.push({ number: i.number, title: i.title, quietHours: round(age, 1) });
  }
  return { agents, staleTasks: stale };
}

export interface Built {
  generatedAt: string;
  pulls: PullRow[] | Failed;
  questions: QuestionOut[] | Failed;
  ownerAsks: AskOut[] | Failed;
  agents: Quiet["agents"] | Failed;
  staleTasks: Quiet["staleTasks"];
  note?: string;
}

export function build(cfg: Config, sinceDays = 14): Built {
  const now = Date.now() / 1000;
  let gateCfg: Config;
  try {
    gateCfg = loadFromMain(cfg); // main's settings, as the gate reads them: an agent can't widen them
  } catch {
    gateCfg = cfg;
  }
  const got = section(() => pulls(cfg, gateCfg, now));
  const result: Built = { generatedAt: isoUtc(now), pulls: isFailed(got) ? got : got.pulls, questions: [], ownerAsks: [], agents: [],
    staleTasks: [] };
  if (isFailed(got)) {
    result.questions = { error: got.error };
    result.ownerAsks = { error: got.error };
  } else {
    const both = section(() => questionsAndAsks(got.pulls, got.comments, now, sinceDays));
    if (isFailed(both)) {
      result.questions = both;
      result.ownerAsks = both;
    } else {
      [result.questions, result.ownerAsks] = both;
    }
  }
  const q = section(() => quiet(cfg, now));
  result.agents = isFailed(q) ? q : q.agents;
  result.staleTasks = isFailed(q) ? [] : q.staleTasks;
  if (!isFailed(q) && q.note !== undefined) result.note = q.note;
  return result;
}

function show(r: Built): void {
  const failed = (part: Failed): string => `  can't read it: ${part.error}`;
  const prs = r.pulls;
  console.log(`Open pull requests (${Array.isArray(prs) ? prs.length : "?"})`);
  if (!Array.isArray(prs)) console.log(failed(prs));
  else if (!prs.length) console.log("  no open pull requests");
  for (const p of Array.isArray(prs) ? prs : []) {
    const nxt = p.next as Action;
    console.log(`#${p.number} ${!("error" in nxt) ? nxt.text : "none (" + String(nxt.error) + ")"}: ${p.title.slice(0, 60)}`);
    if (!p.head) continue;
    const ci = p.ci as { state: string; notGreen: NotGreen[] };
    const bits = [p.branch.slice(0, 36), `${p.head.sha.slice(0, 7)} (${human(p.head.ageMinutes)})`, ...(p.draft ? ["draft"] : []), ...(p.labels ?? [])];
    console.log("    " + bits.join(" | "));
    const names = ci.notGreen.map((j) => j.name).join(", ");
    let mark = p.headMarker || "no marker for the head";
    const marks = p.markers ?? [];
    if (p.headMarker === null && marks.length) {
      const last = marks[marks.length - 1] as MarkerRow;
      mark += ` (older: ${last.kind} ${last.sha ? last.sha.slice(0, 7) : "None"})`;
    }
    const claim = p.claim ? `claim ${p.claim.manager} until ${p.claim.until}` : "no claim";
    console.log(`    CI ${ci.state}${names && ci.state !== "green" ? " (" + names + ")" : ""} | ${mark} | ${claim}`);
  }
  console.log("Questions");
  const q = r.questions;
  if (!Array.isArray(q)) console.log(failed(q));
  for (const x of Array.isArray(q) ? q : []) console.log(`  ${x.kind} #${x.number} waiting ${human(x.ageMinutes)}: ${String(x.url)}`);
  if (Array.isArray(q) && !q.length) console.log("  none waiting");
  console.log("Owner asks");
  const a = r.ownerAsks;
  if (!Array.isArray(a)) console.log(failed(a));
  for (const x of Array.isArray(a) ? a : []) console.log(`  ${x.id} waiting ${human(x.ageMinutes)}: ${String(x.url)}`);
  if (Array.isArray(a) && !a.length) console.log("  none waiting");
  console.log("Agents");
  const ag = r.agents;
  if (!Array.isArray(ag)) console.log(failed(ag));
  else if (r.note) console.log("  " + r.note);
  else {
    for (const x of ag) console.log(`  ${x.name} ${x.status}, last ping ${human(x.minutesAgo)} ago`);
    for (const x of r.staleTasks) console.log(`  #${x.number} in progress, quiet for ${Number.isInteger(x.quietHours) ? x.quietHours + ".0" : x.quietHours} h: ${x.title.slice(0, 50)}`);
    if (!ag.length && !r.staleTasks.length) console.log("  all agents answering");
  }
}

const PROG = "factory_prs.ts";
const USAGE = `usage: ${PROG} [-h] [--json] [--since-days SINCE_DAYS]`;

export function main(argv: string[]): number {
  const a = parseArgs(argv, { valued: ["--since-days"], flags: ["--json"] }, PROG, USAGE);
  let sinceDays = 14;
  if (a["since-days"] !== undefined) {
    const v = String(a["since-days"]);
    const n = /^\s*[+-]?\d+\s*$/.test(v) ? pyInt(v) : null;
    if (n === null) {
      process.stderr.write(`${USAGE}\n${PROG}: error: argument --since-days: invalid int value: '${v}'\n`);
      return 2;
    }
    sinceDays = n;
  }
  const r = build(load(), sinceDays);
  if (a.json) console.log(pyDumps(r, { indent: 2 }));
  else show(r);
  return 0;
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
