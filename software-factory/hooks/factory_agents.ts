#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// Live agents, tracked on GitHub (issues mode: `tasks.source: "issues"` in .claude/factory.json).
//
// Each agent has one issue, `Agent: <name> · <status>`, labelled `factory:agent`, so the board and your phone show who
// is alive and what each one does. The agent keeps it current itself:
//
//   start          register: status `idle`, with its machine id (the hostname only with showWhere)       (factory-loop.sh, SessionStart hook)
//   takes a task   `working on #42`                                             (next_task.ts)
//   any tool use   a ping, at most every `tasks.pingMinutes` (5), in the background   (PostToolUse hook)
//   turn ends      `idle`                                                       (Stop hook)
//   exits          `down`, label `factory:agent-down`                           (loop exit, SessionEnd hook)
//   waits on a question  `input-required` (ping --status input-required): the same word as a question waiting for
//                  more information; the next tool use after the wait puts it back to `working`
//
// The issue body also carries a `factory-msg kind=status` envelope (factory_messages.ts, docs/messages.md), so the status
// uses the shared message format and `factory messages ls --kind status` lists it.
//
// An agent whose last ping is older than `tasks.downMinutes` (30) counts as down: it crashed, the laptop slept, or it
// waits at a prompt nobody answers. The dev manager's `sweep` marks it down and puts its in-progress issues back to
// ready, so a live agent takes them.
//
// With the heartbeat daemon running on a machine (factory_heartbeat.ts, #108) the daemon is the one that writes for the
// agents there: it knows whether the process is really alive, and says `waiting` (alive, blocked in a `factory wait`)
// besides `working`, `idle` and `down`, on change plus a keepalive. The hooks then leave the pings and `idle` to it; only
// `register`, a clean `down` and the cloud agents' own pings still write. Its markers carry `hb=1`: a keepalive missed
// for `tasks.heartbeatMissMinutes` (12) counts as silent, not after 30 minutes. The sweep never gives away an issue of an
// agent that is alive on its machine, and also releases the issues of an agent that is plainly `down` for
// `tasks.releaseDownMinutes` (10).
//
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_agents.ts ls [--json] [--local] [--fresh]
//                                                                every agent: where it runs, its state, task, since when,
//                                                                last seen and follow link (factory_agents_ls.ts)
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_agents.ts list [--json]         who is working, idle or down, and since when (--json: cards)
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_agents.ts card <name>           one agent's card (factory_cards.ts), also for dev-manager and po
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_agents.ts sweep                 mark silent agents down, release their issues
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_agents.ts register --agent taytu [--kind dev-manager] [--cloud] [--follow URL] [--role dev-manager]
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_agents.ts ping --agent taytu [--status "working on #42"] [--force]
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_agents.ts down --agent taytu
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_agents.ts hook                  the Claude hook entry (reads the event on stdin)
//
// Every role registers the same way (#102): a dev manager or a product owner has an agent issue too, with its role in a
// second marker, `<!-- factory-role role=dev-manager -->`, on its own line so an older kit still reads the first one. An
// issue without it is a coding agent's. `FACTORY_ROLE` (set by the loop) gives hooks the role.
//
// Each ping marker carries `machine=<id>` (factory_machine.ts). `register` refuses, exit 3 and a `{code, message, fix}`
// on stderr, when the open issue of that name was pinged by another machine within `downMinutes`; a marker without a
// machine (an older kit) never blocks.
//
// Hooks never fail or slow a session: errors are ignored, and the tool-use ping runs detached.
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type Config, DEFAULTS, load, safeAgent, taskLabels, taskSource, toFloat } from "./factory_config.ts";
import { now as clockNow } from "./factory_clock.ts";
import { stateDir as claimsStateDir } from "./factory_claims.ts";
import { addLabels, comment, gh, type Issue, releaseIssue, removeLabel, taskIssues } from "./factory_issues.ts";
import { aliveHere, managed } from "./factory_heartbeat.ts";
import { machineId, refuse } from "./factory_machine.ts";
import { Message, render as renderMessage } from "./factory_messages.ts";
import { run as runLs } from "./factory_agents_ls.ts";
import { card, cards, pyRound0, row } from "./factory_cards.ts";
import { bunCmd, die, isoUtc, parseArgs, parseIso, pyDumps, pyRepr, runMain } from "./factory_lib.ts";

export const LABEL = "factory:agent";
export const DOWN_LABEL = "factory:agent-down";
const ROLE_MARK = /<!--\s*factory-role\s+role=([\w-]+)\s*-->/;
// The hidden marker on an agent's issue: <!-- factory-agent name=taytu status=waiting ping=... machine=... -->. Besides
// name, status and ping it may carry kind, task, on (what it waits on), since, hb (1: written by the heartbeat daemon),
// where, session and follow. Older markers have only the first four.
const MARK = /<!--\s*factory-agent\s+([\s\S]*?)\s*-->/;
const FIELD_CHARS = /[\w./:?=&%#~+@,-]/;
const HOUR = 3600;

type Cfg = Config | Record<string, unknown>;

/** One of the `tasks` settings, else its default. */
export function setting(cfg: Cfg, key: string): unknown {
  const tasks = (cfg.tasks || {}) as Record<string, unknown>;
  return key in tasks ? tasks[key] : (DEFAULTS.tasks as Record<string, unknown>)[key];
}

function num(v: unknown): number {
  const f = toFloat(v);
  if (f === null) throw new Error(`could not convert to float: ${pyRepr(String(v))}`);
  return f;
}

/** Now, whole seconds since 1970 (the factory clock, so a test can move it). */
export function now(): number {
  return Math.floor(clockNow());
}

/** An ISO-8601 UTC time (seconds since 1970 in, "2026-10-25T10:00:00Z" out). */
export function iso(t: number): string {
  return isoUtc(t);
}

/** Where an agent's last ping and issue number are kept: the repository's factory folder, or, when that can't be
 * written (a sandboxed hook), a private folder in the temp directory, so pings stay rate-limited either way. */
export function stampFile(agent: string): string {
  const name = `agent-${safeAgent(agent)}.json`;
  try {
    const d = claimsStateDir();
    accessSync(d, constants.W_OK);
    return join(d, name);
  } catch {
    // not writable here: the temp folder below
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  const d = join(tmpdir(), `factory-${uid}`);
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return join(d, name);
}

export type Stamp = Record<string, unknown> & {
  issue?: number | null;
  status?: string;
  detail?: string;
  started?: string;
  ping?: number;
  extra?: Record<string, unknown>;
  writes?: number[];
  cand?: { key: string; at: number } | null;
  retry?: number;
  role?: string;
};

export function remember(agent: string, kw: Stamp): Stamp {
  try {
    const path = stampFile(agent);
    let data: Stamp = {};
    if (existsSync(path)) {
      try {
        data = JSON.parse(readFileSync(path, "utf8")) as Stamp;
      } catch (e) {
        if (!(e instanceof SyntaxError)) throw e;
        data = {};
      }
    }
    Object.assign(data, kw);
    // Written whole, then moved into place: two hooks at once never leave half a file that reads as empty.
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, pyDumps(data));
    renameSync(tmp, path);
    return data;
  } catch {
    return kw;
  }
}

export function recall(agent: string): Stamp {
  try {
    const data = JSON.parse(readFileSync(stampFile(agent), "utf8")) as unknown;
    return (data && typeof data === "object" ? data : {}) as Stamp;
  } catch {
    return {};
  }
}

export function agentIssues(): Issue[] {
  return taskIssues("all", LABEL);
}

/** The key=value pairs of an agent issue's marker ({} when it has none). */
export function fields(issue: { body?: string | null }): Record<string, string> {
  const m = MARK.exec(issue.body || "");
  const out: Record<string, string> = {};
  for (const pair of m ? (m[1] as string).split(/\s+/).filter((x) => x) : []) {
    const i = pair.indexOf("=");
    if (i < 0) continue;
    const key = pair.slice(0, i);
    if (/^[a-z][\w-]*$/.test(key)) out[key] = pair.slice(i + 1);
  }
  return out;
}

/** A marker value: no spaces, no angle brackets, nothing that could close the comment. */
export function clean(value: unknown): string {
  return [...String(value)].filter((c) => FIELD_CHARS.test(c)).join("").replace(/--/g, "-");
}

/** The agent an agent issue belongs to: the marker's name, else the title's (`Agent: <name> · ...`). */
export function nameOf(issue: Issue): string | null {
  const name = fields(issue).name;
  if (name && /^[\w.-]+$/.test(name)) return name;
  const m = /^Agent: ([\w.-]+)(\s|$)/.exec(issue.title || "");
  return m ? (m[1] as string) : null;
}

function lastPing(issue: Issue): string {
  return fields(issue).ping ?? "";
}

/** An agent's issues, the one to use first: open before closed, then the newest ping, then the newest issue. */
function ranked(issues: Issue[]): Issue[] {
  const cmp = (a: Issue, b: Issue): number => {
    const oa = a.state === "open" ? 1 : 0;
    const ob = b.state === "open" ? 1 : 0;
    if (oa !== ob) return ob - oa;
    const pa = lastPing(a);
    const pb = lastPing(b);
    if (pa !== pb) return pa < pb ? 1 : -1;
    return b.number - a.number;
  };
  return [...issues].sort(cmp);
}

/** {agent: its issues, the one to use first}. Several issues for one agent are duplicates. */
export function byAgent(issues: Issue[]): Map<string, Issue[]> {
  const out = new Map<string, Issue[]>();
  for (const i of issues) {
    const name = nameOf(i);
    if (name) {
      if (!out.has(name)) out.set(name, []);
      (out.get(name) as Issue[]).push(i);
    }
  }
  for (const [name, found] of out) out.set(name, ranked(found));
  return out;
}

export function findIssue(agent: string): Issue | null {
  const found = byAgent(agentIssues()).get(agent);
  return found ? (found[0] as Issue) : null;
}

/** The role an agent issue belongs to; a coding agent's when it has no role marker (an older kit). */
export function roleOf(issue: { body?: string | null }): string {
  const m = ROLE_MARK.exec(issue.body || "");
  return m ? (m[1] as string) : "coding-agent";
}

export function render(agent: string, status: string, detail: string, started: string, ping: number | null = null,
  where: string | null = null, machine = "", extra: Record<string, unknown> | null = null, role = "coding-agent"): [string, string] {
  where = where || `slot ${process.env.FACTORY_SLOT || 1}`;
  const shownBy: Record<string, string> = { working: detail || "working", waiting: detail || "waiting", idle: "idle", down: "down",
    "input-required": detail ? `input-required (${detail})` : "input-required" };
  if (!(status in shownBy)) throw new Error(`KeyError: ${pyRepr(status)}`);
  const shown = shownBy[status] as string;
  const t = iso(ping ?? now());
  const pairs: Record<string, unknown> = { machine, ...(extra ?? {}) };
  if (status === "down") { // nothing is being done, waited on or followed any more
    for (const key of ["task", "on", "since", "session", "follow"]) delete pairs[key];
  }
  const marks = Object.entries(pairs).filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => ` ${k}=${clean(v)}`).join("");
  // The old marker stays first (older kits read only it); the envelope says the same in the shared message format:
  // the agent's status is a status message whose id is stable, because the body is rewritten on every ping.
  const envelope = renderMessage(new Message({ id: `agent-${agent}`, kind: "status", frm: agent, state: status }));
  const lines = [`<!-- factory-agent name=${agent} status=${status} ping=${t}${marks} -->`, envelope,
    `**Status:** ${shown}`, `**Last ping:** ${t}`, `**Started:** ${started}`, `**Where:** ${where}`];
  if (pairs.follow && status !== "down") lines.push(`**Follow:** ${clean(pairs.follow)}`);
  if (role && role !== "coding-agent") lines.splice(1, 0, `<!-- factory-role role=${role} -->`);
  const body = lines.join("\n") + "\n\nThis issue is kept up to date by the agent itself (see factory_agents.ts). Don't close it.";
  return [`Agent: ${agent} · ${shown}`, body];
}

/** The machine id in an agent issue's marker; null when it has none (an older kit). */
export function machineOf(issue: Issue): string | null {
  return fields(issue).machine || null;
}

/** The other machine's id when `agent`'s open issue was pinged by it within `downMinutes` and isn't down, else
 * null. A marker without a machine (an older kit), a down or silent agent and our own machine all return null. */
export function heldElsewhere(cfg: Cfg, agent: string, machine: string): string | null {
  const i = findIssue(agent);
  if (!i || i.state !== "open" || !machine) return null;
  const st = stateOf(cfg, i);
  const other = machineOf(i);
  if (!st || st[1] === "down" || st[1] === "silent" || !other || other === machine) return null;
  return other;
}

export interface UpdateOptions {
  detail?: string;
  create?: boolean;
  extra?: Record<string, unknown> | null;
  replaceExtra?: boolean;
  number?: number | null;
  role?: string | null;
}

/** Updates the agent's one issue. Only `register` (create) may open a new one, and only when the agent has
 * none at all, open or closed: a ping, a turn's end or a session's end that can't find the issue changes nothing.
 * (On 22 Oct a lookup that came back empty made every ping open another issue: 195 copies in two hours.)
 *
 * `extra` are marker fields (kind, task, on, since, hb, where, session, follow): they are added to the ones the
 * last write carried, or, with `replaceExtra`, they are the whole set (the heartbeat daemon says what is true
 * now). Every write is remembered (when, and how many in the last hour) for the daemon's write budget. */
export function update(cfg: Cfg, agent: string, status: string, opts: UpdateOptions = {}): number | null {
  const detail = opts.detail ?? "";
  const seen = recall(agent);
  let n: number | null | undefined = opts.number || seen.issue;
  if (!n) {
    const i = findIssue(agent);
    if (i) n = i.number;
    else if (!opts.create || status === "down") return null; // only a registration opens an issue, and never a down one (#194)
  }
  const started = seen.started || iso(now());
  // The machine and folder are posted to GitHub only when the project opts in (tasks.showWhere: true).
  let where = ((cfg.tasks || {}) as Record<string, unknown>).showWhere ? `${hostname()} · ${basename(process.cwd())}` : null;
  const kept: Record<string, unknown> = opts.replaceExtra ? {} : { ...(seen.extra || {}) };
  for (const [k, v] of Object.entries(opts.extra ?? {})) if (v !== null && v !== undefined && v !== "") kept[k] = v;
  if (kept.where === "cloud") where = "cloud";
  const role = opts.role || seen.role || process.env.FACTORY_ROLE || "coding-agent";
  const [title, body] = render(agent, status, detail, started, null, where, machineId(), kept, role);
  if (n) gh("PATCH", `repos/{owner}/{repo}/issues/${n}`, { title, body, state: "open" });
  else n = gh<{ number: number }>("POST", "repos/{owner}/{repo}/issues", { title, body, labels: [LABEL] }).number;
  if (status === "down") addLabels(n, [DOWN_LABEL]);
  else if (seen.status === undefined || seen.status === null || seen.status === "down") removeLabel(n, DOWN_LABEL); // a change between live states needs no label call
  const t = clockNow();
  const writes = [...(seen.writes || []).filter((w) => t - w < HOUR), t];
  remember(agent, { issue: n, status, detail, started, ping: t, extra: kept, writes, cand: null, retry: 0, role });
  return n;
}

/** Minutes without a ping after which an agent that isn't down counts as silent: `tasks.downMinutes`, or, for an
 * agent the heartbeat daemon writes for (hb=1), `tasks.heartbeatMissMinutes` (a keepalive missed twice), whichever is less. */
export function silentAfter(cfg: Cfg, f: Record<string, string>): number {
  let limit = num(setting(cfg, "downMinutes"));
  if (f.hb === "1") limit = Math.min(limit, num(setting(cfg, "heartbeatMissMinutes")));
  return limit;
}

export type AgentState = [name: string, status: string, ping: number, quietMinutes: number];

/** [name, status, last ping (seconds since 1970), minutes since] from an agent issue; a silent agent counts as down. */
export function stateOf(cfg: Cfg, issue: Issue): AgentState | null {
  const f = fields(issue);
  if (!(f.name && /^\w+$/.test(f.status || "") && f.ping)) return null;
  const t = parseIso(f.ping);
  if (t === null) throw new Error(`Invalid isoformat string: ${pyRepr(f.ping)}`);
  const quiet = (now() - t) / 60;
  let status = f.status as string;
  if (status !== "down" && quiet >= silentAfter(cfg, f)) status = "silent";
  return [f.name, status, t, quiet];
}

/** Each agent's one issue: its open issue with the newest ping. Closed ones and older copies don't count. */
export function current(issues: Issue[]): Issue[] {
  return [...byAgent(issues).values()].map((found) => found[0] as Issue).filter((i) => i.state === "open");
}

/** Closes an agent's other open issues, keeping its current one. Returns the numbers it closed. */
export function closeCopies(issues: Issue[]): number[] {
  const closed: number[] = [];
  for (const found of byAgent(issues).values()) {
    for (const extra of found.slice(1)) {
      if (extra.state === "open") {
        gh("PATCH", `repos/{owner}/{repo}/issues/${extra.number}`, { state: "closed", state_reason: "not_planned" });
        closed.push(extra.number);
      }
    }
  }
  return closed;
}

/** The numbers of the in-progress issues agent `name` holds, out of `inProgress` (all in-progress task issues). */
function heldInProgress(cfg: Cfg, name: string, inProgress: Issue[]): number[] {
  const L = taskLabels(cfg as Config);
  return inProgress.filter((x) => x.labels.some((y) => y.name === L.agentPrefix + name)).map((x) => x.number);
}

/** [[issue number, agent, status]] for in-progress task issues held by an agent that is down or silent (#191). The
 * sweep frees these after `tasks.releaseDownMinutes`; until then `factory next` skips them, so it says so. */
export function staleClaims(cfg: Cfg): [number, string, string][] {
  const L = taskLabels(cfg as Config);
  const gone = new Map<string, string>();
  for (const i of current(agentIssues())) {
    const st = stateOf(cfg, i);
    if (st && (st[1] === "down" || st[1] === "silent") && !aliveHere(st[0])) gone.set(st[0], st[1]);
  }
  const out: [number, string, string][] = [];
  for (const x of taskIssues("open", L.inProgress)) {
    for (const [name, status] of gone) {
      if (x.labels.some((y) => y.name === L.agentPrefix + name)) out.push([x.number, name, status]);
    }
  }
  return out.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0));
}

/** Close duplicate agent issues, then mark silent agents down and put their in-progress issues back to ready.
 * Only an agent's current issue counts: an old copy that went quiet must never release a live agent's work.
 *
 * Real liveness decides (#108): an agent the heartbeat daemon on this machine sees alive (working, waiting or idle)
 * is never marked down or released, whatever its issue says. An agent that is plainly `down` (the daemon, its loop
 * or its session said so) gets its in-progress issues back to ready once it has been down for
 * `tasks.releaseDownMinutes`, so a crash does not hold an issue until `factory issues stale` notices. */
export function sweep(cfg: Cfg): string[] {
  const L = taskLabels(cfg as Config);
  const issues = agentIssues();
  const done: string[] = [];
  const copies = closeCopies(issues);
  if (copies.length) {
    done.push(`closed ${copies.length} duplicate agent issue${copies.length > 1 ? "s" : ""}: ` +
      [...copies].sort((a, b) => a - b).map((n) => `#${n}`).join(", "));
  }
  let inProgress: Issue[] | null = null;
  for (const i of current(issues)) {
    const st = stateOf(cfg, i);
    if (!st) continue;
    const [name, status, t, quiet] = st;
    if (status === "down") {
      if (quiet < num(setting(cfg, "releaseDownMinutes"))) continue;
      inProgress ??= taskIssues("open", L.inProgress);
      const held = heldInProgress(cfg, name, inProgress);
      for (const n of held) releaseIssue(cfg as Config, n, `${name} has been down since ${iso(t)}`);
      if (held.length) done.push(`${name}: down for ${pyRound0(quiet)} min, released ${held.map((n) => `#${n}`).join(", ")}`);
      continue;
    }
    if (status !== "silent" || aliveHere(name)) continue;
    const old = i.body || "";
    const started = /\*\*Started:\*\* (\S+)/.exec(old)?.[1] ?? "?";
    const where = /\*\*Where:\*\* (.+)/.exec(old)?.[1] ?? "?";
    const [title, body] = render(name, "down", "", started, t, where, machineOf(i) || "", null, roleOf(i));
    gh("PATCH", `repos/{owner}/{repo}/issues/${i.number}`, { title, body });
    addLabels(i.number, [DOWN_LABEL]);
    comment(i.number, `No ping for ${(quiet / 60).toFixed(1)} h (since ${iso(t)}): marked down.`);
    const held = taskIssues("open", L.agentPrefix + name).filter((x) => x.labels.some((y) => y.name === L.inProgress)).map((x) => x.number);
    for (const n of held) releaseIssue(cfg as Config, n, `${name} went silent at ${iso(t)}`);
    done.push(`${name}: down (silent ${(quiet / 60).toFixed(1)} h)` + (held.length ? `, released ${held.map((n) => `#${n}`).join(", ")}` : ""));
  }
  return done;
}

/** Claude hook entry: PostToolUse pings (rate-limited, detached), Stop goes idle, SessionEnd goes down. While the
 * heartbeat daemon runs on this machine it does the pings and the idle (it knows better); SessionEnd still says down. */
function hook(cfg: Cfg): void {
  let event = "";
  try {
    const data = JSON.parse(readFileSync(0, "utf8")) as unknown;
    event = String((data as Record<string, unknown>).hook_event_name ?? "");
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    event = "";
  }
  const agent = process.env.FACTORY_AGENT;
  if (!agent) return;
  if ((event === "PostToolUse" || event === "Stop") && managed(agent)) return;
  const seen = recall(agent);
  if (event === "PostToolUse") {
    if (clockNow() - num(seen.ping ?? 0) < num(setting(cfg, "pingMinutes")) * 60) return; // pinged recently: no network at all
    remember(agent, { ping: clockNow() }); // claim this ping slot before the detached call
    const [exe, ...args] = bunCmd(import.meta.path);
    spawn(exe as string, [...args, "ping", "--agent", agent, "--force"], { detached: true, stdio: "ignore" }).unref();
  } else if (event === "Stop" && seen.status !== "idle") update(cfg, agent, "idle");
  else if (event === "SessionEnd" && !process.env.FACTORY_LOOP) update(cfg, agent, "down"); // under factory-loop.sh the loop says down when it exits
}

/** The marker fields the command line sets: --kind, --cloud (the agent runs in the cloud) and --follow (the link
 * to reach its session). Invalid ones stop with a `{code, message, fix}`. */
function reachArgs(a: Record<string, unknown>): Record<string, string> {
  const extra: Record<string, string> = {};
  const kind = a.kind as string | undefined;
  if (kind) {
    if (!/^[a-z][a-z-]{1,29}$/.test(kind)) {
      refuse("bad-kind", `--kind ${pyRepr(kind)} isn't a kind.`, "Use lowercase letters and dashes, for example " +
        "coding-agent, dev-manager or product-owner.");
    }
    extra.kind = kind;
  }
  if (a.cloud) extra.where = "cloud";
  const follow = a.follow as string | undefined;
  if (follow) {
    if (!/^https:\/\/[\w.-]+(\/[\w./?=&%#~+@,-]*)?$/.test(follow) || follow.includes("--")) {
      refuse("bad-follow", `--follow ${pyRepr(follow)} isn't a link I can post.`, "Pass the session's https link " +
        "(the Remote Control link, claude.ai/code/...), with no spaces.");
    }
    extra.follow = follow;
  }
  return extra;
}

const PROG = "factory_agents.ts";
const CMDS = ["register", "ping", "down", "list", "card", "ls", "sweep", "hook"];

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  if (!cmd || !CMDS.includes(cmd)) {
    process.stderr.write(`usage: ${PROG} [-h] {${CMDS.join(",")}} ...\n${PROG}: error: ` +
      (cmd ? `argument cmd: invalid choice: '${cmd}' (choose from ${CMDS.map((c) => `'${c}'`).join(", ")})` :
        "the following arguments are required: cmd") + "\n");
    return 2;
  }
  const specs: Record<string, Parameters<typeof parseArgs>[1]> = {
    register: { valued: ["--agent", "--role", "--kind", "--follow"], flags: ["--cloud"] },
    ping: { valued: ["--agent", "--role", "--kind", "--follow", "--status"], flags: ["--cloud", "--force"] },
    down: { valued: ["--agent", "--role"] },
    list: { flags: ["--json"] },
    card: { positionals: ["name"] },
    ls: { flags: ["--json", "--local", "--fresh"] },
  };
  const a = parseArgs(argv.slice(1), specs[cmd] ?? {}, `${PROG} ${cmd}`, `usage: ${PROG} ${cmd} [-h]`);
  if (["register", "ping", "down"].includes(cmd) && a.agent === undefined) a.agent = process.env.FACTORY_AGENT;
  const cfg = load();
  if (cmd === "ls") { // this machine needs no issues mode
    await runLs(cfg, Boolean(a.json), Boolean(a.local), Boolean(a.fresh));
    return 0;
  }
  if (taskSource(cfg) !== "issues") {
    if (["list", "sweep", "card"].includes(cmd)) console.log('Agent tracking needs issues mode: "tasks": {"source": "issues"} in .claude/factory.json.');
    return 0;
  }
  if (cmd === "hook") {
    try {
      hook(cfg);
    } catch {
      // a hook must never break the session
    }
    return 0;
  }
  const agent = a.agent as string | undefined;
  if (["register", "ping", "down"].includes(cmd) && !agent) die("which agent? pass --agent <name> or set FACTORY_AGENT");
  const extra = reachArgs(a);
  const role = (a.role as string | undefined) ?? null;
  if (cmd === "register") {
    const name = agent as string;
    const other = heldElsewhere(cfg, name, machineId());
    if (other) { // exit 3: factory-loop.sh stops here instead of running as a second copy of this agent
      refuse("agent-name-in-use", `${name} is already running on another machine (machine ${other}).`,
        "Start this machine's agents under names no other machine uses: " +
        "`factory machine setup <names>`, or set FACTORY_AGENTS.", 3);
    }
    remember(name, { started: iso(now()), issue: null, ...(role ? { role } : {}) });
    const n = update(cfg, name, "idle", { create: true, extra, role });
    console.log(`#${n === null ? "None" : n}`);
  } else if (cmd === "down") update(cfg, agent as string, "down", { role });
  else if (cmd === "ping") {
    const name = agent as string;
    const given = a.status as string | undefined;
    if (!a.force && managed(name)) return 0; // the daemon on this machine writes this agent's state (changes and keepalives)
    const seen = recall(name);
    let status: string;
    let detail: string;
    if (given === "input-required") { // blocked on a question: keeps what it was doing, to show and to go back to
      status = "input-required";
      detail = seen.detail || "";
    } else if (given) {
      [status, detail] = given === "idle" ? ["idle", ""] : given.startsWith("waiting") ? ["waiting", given] : ["working", given];
    } else {
      status = seen.status || "idle";
      detail = seen.detail || "";
      if (status === "down") status = "idle";
      else if (status === "input-required") status = "working"; // a tool ran since: it is not waiting any more
    }
    if (!a.force && !given && clockNow() - num(seen.ping ?? 0) < num(setting(cfg, "pingMinutes")) * 60) return 0;
    update(cfg, name, status, { detail, extra, role });
  } else if (cmd === "list") {
    const found = cards(cfg, agentIssues());
    if (a.json) console.log(pyDumps(found, { indent: 2 }));
    else for (const c of found) console.log(row(c));
    if (!found.length && !a.json) console.log("no agents have registered yet");
  } else if (cmd === "card") {
    const name = a.name as string;
    const found = cards(cfg, agentIssues()).filter((c) => c.name === name);
    console.log(pyDumps(found[0] ?? card(safeAgent(name)), { indent: 2 }));
  } else if (cmd === "sweep") for (const line of sweep(cfg)) console.log(line);
  return 0;
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
