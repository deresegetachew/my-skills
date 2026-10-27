#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// The per-machine heartbeat daemon (#108): real agent liveness, reported to GitHub cheaply.
//
// Liveness used to be a side effect of tool use: an agent pinged its issue when a tool finished. So an agent waiting
// in `factory wait` for 30 minutes looked silent, and an agent whose machine reset kept saying `working`. This daemon
// asks the machine instead. Every `tasks.heartbeatSeconds` (20) it looks, locally and for free, at each agent that
// runs here:
//
//   the claim          factory_claims.ts: the checkout claim names the agent's loop or Claude process; is that pid
//                      alive and a loop or Claude process, and does the agent hold a task?
//   what it waits on   a `factory wait ci|answer <pr>`, `wait slot|ready` or `wait_for_merge.sh <pr>` below that pid
//   the tmux session   `<repo>-<agent>` (factory resume starts it): its Remote Control link, read from the pane, and
//                      when it last showed output
//   the transcript     when Claude last wrote to the session's log
//
// and works out one state:  working | waiting | idle | down.
//   down      no live loop or Claude process holds the agent's checkout
//   waiting   alive, and a `factory wait` runs below it: deliberately blocked (a PR slot, CI, an answer, a merge)
//   working   alive and holds a task
//   idle      alive, no task
//
// What it saw goes to this machine's state file every cycle (`heartbeat.json` in the state folder, see `factory
// machine show`), which `factory agents ls` reads: instant, no network. GitHub is written (one PATCH of the agent's own
// issue, the hidden marker extended with kind, task, on, since, hb) only when the state has changed and lasted a few
// seconds (FACTORY_HEARTBEAT_CONFIRM, default 15), plus a keepalive every `tasks.pingMinutes` (5): at most 12 writes
// per agent per rolling hour, so 4 agents are about 48 edits an hour against GitHub's 5,000 requests. The one write that
// is never held back is `down`: it goes out about a cycle after the process or session disappeared. Nothing is written
// for an agent that has never reported, and nothing for `down` twice.
//
// The tmux session name, the folder, the machine name and the Remote Control link go to GitHub only with
// `tasks.showWhere` (agent issues are readable by anyone who can read the repo). Cloud agents (the dev manager)
// have no daemon: they report with `factory_agents.ts ping --cloud --follow <link>`.
//
// The first cycle after the daemon starts (a boot) marks this machine's agents that GitHub still shows alive, but that
// are not running here, as down. Stopping the daemon does not touch the agents.
//
// While the daemon runs, the agent hooks leave the pings and `idle` to it (factory_agents.ts), and the sweep never gives
// away the issue of an agent it sees alive. Without it everything works as before: pings on tool use, 30 minutes to
// silent.
//
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_heartbeat.ts run         the daemon: one cycle every few seconds, until stopped
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_heartbeat.ts once        one cycle, then print what it saw
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_heartbeat.ts status      is it installed and running, and what it last saw
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_heartbeat.ts install     keep it running: a systemd user service or a LaunchAgent
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_heartbeat.ts uninstall
//   bun --no-env-file --config=/dev/null .claude/hooks/factory_heartbeat.ts restart     run the files now on disk (`factory update` does it)
//
// `factory autostart install` installs it too (unless --no-heartbeat). One daemon runs per project and machine: a
// second `run` stops with `{code: heartbeat-running}`. A GitHub failure is retried a minute later and never stops it.
// It runs as the same user as the agents; an agent could stop it or forge its state, which is acceptable for
// well-meaning agents, as the wiki says of the gate (docs/wiki/reviews-and-gates.md).
import { ftruncateSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync,
  writeSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, join } from "node:path";
import { type Config, load, taskSource, toFloat } from "./factory_config.ts";
import { now as clockNow } from "./factory_clock.ts";
import { alive as claimAlive, type Claim, stateDir as claimsStateDir } from "./factory_claims.ts";
import { agentIssues, current, fields, nameOf, recall, remember, update } from "./factory_agents.ts";
import { installCli, restartCli, serviceText, uninstallCli } from "./factory_heartbeat_service.ts";
import { machineId, machineNames, refuse, repoKey, stateDir } from "./factory_machine.ts";
import { sessionName } from "./factory_resume.ts";
import { Exit, flock, isoUtc, pyDumps, pyRepr, run as runCmd, runMain, splitLines } from "./factory_lib.ts";

const KIND = "coding-agent";
const LOCAL_FILE = "heartbeat.json";
const WRITES_PER_HOUR = 12;
const HOUR = 3600;
const SHELLS_AND_SCRIPTS_ONLY = ["claude", "node", "nodejs", "bun"]; // their arguments hold prompts, not commands

type Cfg = Config | Record<string, unknown>;

// --- what a process is waiting on --------------------------------------------------------------------------------

const WAIT = String.raw`(?:factory_wait\.(?:py|ts)|\bfactory\s+wait)`;
const ON_PR = new RegExp(WAIT + String.raw`\s+(ci|answer)\s+#?(\d+)\b`);
const BARE = new RegExp(WAIT + String.raw`\s+(slot|ready)\b`);
const MERGE = new RegExp(String.raw`(?:wait_for_merge\.sh|` + WAIT + String.raw`)\s+#?(\d+)\b`);
const TEXT: Record<string, string> = { ci: "CI on PR #{n}", answer: "an answer on PR #{n}", merge: "the merge of PR #{n}",
  slot: "a free PR slot", ready: "a ready task" };

export interface Wait {
  kind: string;
  pr: string | null;
  on: string;
  text: string;
}

/** What a command line waits on, as {kind, pr, on, text}; null when it is not one of the factory's waits. */
export function parseWait(args: string): Wait | null {
  let kind: string;
  let pr: string | null;
  let m = ON_PR.exec(args);
  if (m) {
    kind = m[1] as string;
    pr = m[2] as string;
  } else if ((m = BARE.exec(args))) {
    kind = m[1] as string;
    pr = null;
  } else if ((m = MERGE.exec(args))) {
    kind = "merge";
    pr = m[1] as string;
  } else return null;
  return { kind, pr, on: pr ? `${kind}:${pr}` : kind, text: (TEXT[kind] as string).replace("{n}", String(pr)) };
}

export type Procs = Map<number, [number, string]>;

/** The wait a process below `root` runs ({pid: [ppid, command line]} from `ps`); null when there is none. */
export function waitsInTree(procs: Procs, root: number): Wait | null {
  const kids = new Map<number, number[]>();
  for (const [pid, [ppid]] of procs) {
    if (!kids.has(ppid)) kids.set(ppid, []);
    (kids.get(ppid) as number[]).push(pid);
  }
  const seen = new Set<number>();
  const queue = [...(kids.get(root) ?? [])];
  while (queue.length) {
    const pid = queue.shift() as number;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const args = (procs.get(pid) as [number, string])[1];
    const words = args.split(/\s+/).filter((w) => w);
    if (words.length && (!SHELLS_AND_SCRIPTS_ONLY.includes(basename(words[0] as string)) || runsWaitScript(words))) {
      const got = parseWait(args);
      if (got) return got;
    }
    queue.push(...(kids.get(pid) ?? []));
  }
  return null;
}

/** Whether `bun [flags] .../factory_wait.ts ...` runs: the ported wait runs under bun, whose other arguments (Claude
 * Code's) are prompts and never read. Only the script right after bun's own flags counts. */
function runsWaitScript(words: string[]): boolean {
  let k = 1;
  while (k < words.length && (words[k] as string).startsWith("-")) k++;
  return k < words.length && /^factory_wait\.(ts|py)$/.test(basename(words[k] as string));
}

/** {pid: [ppid, command line]} for every process, from `ps`; empty when there is no ps. */
export function processes(): Procs {
  const out: Procs = new Map();
  const p = runCmd(["ps", "-eo", "pid=,ppid=,args="], { timeoutMs: 30_000 });
  for (const line of splitLines(p.stdout)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)/.exec(line);
    if (m) out.set(Number(m[1]), [Number(m[2]), m[3] as string]);
  }
  return out;
}

// --- the tmux session and the transcript ----------------------------------------------------------------------------

function tmux(...args: string[]): string | null {
  const p = runCmd(["tmux", ...args], { timeoutMs: 15_000 });
  return p.code === 0 ? p.stdout : null;
}

/** {session name: when it last showed output (epoch seconds, or null)}; {} without tmux or sessions. */
function tmuxSessions(): Map<string, number | null> {
  const out = tmux("list-sessions", "-F", "#{session_name} #{session_activity}");
  const sessions = new Map<string, number | null>();
  for (const line of splitLines(out || "")) {
    const t = line.trim();
    const i = t.indexOf(" ");
    const name = i < 0 ? t : t.slice(0, i);
    const activity = i < 0 ? "" : t.slice(i + 1);
    if (name) sessions.set(name, /^\d+$/.test(activity.trim()) ? Number(activity) : null);
  }
  return sessions;
}

/** The Remote Control link in a pane's text (the last one), or null. Only claude.ai/code links count. */
export function followUrl(text: string | null | undefined): string | null {
  const found = [...(text || "").matchAll(/(?<![\w.-])https:\/\/claude\.ai\/code\/[A-Za-z0-9_\-/?=&%.]+/g)].map((m) => m[0]);
  return found.length ? (found[found.length - 1] as string).replace(/[.,)]+$/, "") : null;
}

/** When Claude last wrote to a session log of the project folder `path`, or null. */
function transcriptActivity(path: string | null | undefined): number | null {
  const base = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const folder = join(base, "projects", (path || "").replace(/[^A-Za-z0-9]/g, "-"));
  try {
    const times = readdirSync(folder).filter((f) => f.endsWith(".jsonl")).map((f) => statSync(join(folder, f)).mtimeMs / 1000);
    return times.length ? Math.max(...times) : null;
  } catch {
    return null;
  }
}

// --- the state ----------------------------------------------------------------------------------------------------

/** '42' for the claim key `issue-42`; any other key (a plan task like 3.2) as it is. */
function taskNumber(task: string | null | undefined): string | null {
  const m = /^issue-(\d+)$/.exec(task || "");
  return m ? (m[1] as string) : task || null;
}

export interface Derived {
  state: string;
  detail: string;
  task: string | null;
  on: string | null;
}

/** The state of one agent from what was seen: {alive, task (claim key or null), wait (parseWait or null)}. */
export function derive(inp: { alive: boolean; task: string | null; wait: Pick<Wait, "on" | "text"> | null }): Derived {
  if (!inp.alive) return { state: "down", detail: "down", task: null, on: null };
  const number = taskNumber(inp.task);
  const wait = inp.wait;
  if (wait) return { state: "waiting", detail: "waiting for " + wait.text, task: number, on: wait.on };
  if (number) {
    const shown = String(inp.task).startsWith("issue-") ? `#${number}` : number;
    return { state: "working", detail: `working on ${shown}`, task: number, on: null };
  }
  return { state: "idle", detail: "idle", task: null, on: null };
}

/** What counts as a change worth writing: the state, the task, what it waits on, and the reach fields that are
 * posted. Everything else (the since time, a new activity time) is not. */
export function keyOf(state: string, task: unknown = null, on: unknown = null, session: unknown = null, follow: unknown = null): string {
  if (state === "down") return "down";
  return [state, task || "", on || "", session || "", follow || ""].join("|");
}

/** The key of what the last write to GitHub said, from the agent's stamp file (any writer's). */
function reportedKey(stamp: Record<string, unknown>): string {
  if (!stamp.status) return "";
  const ex = (stamp.extra || {}) as Record<string, unknown>;
  return keyOf(stamp.status as string, ex.task, ex.on, ex.session, ex.follow);
}

export interface Candidate {
  key: string;
  at: number;
}

export interface Plan {
  write: boolean;
  why: string | null;
  cand: Candidate | null;
}

/** Whether to write `key` now. `rep` is {key: what GitHub last got, ping: when, writes: [times], cand: {key, at}}.
 * Returns {write, why, cand}: a change is written once it has lasted `confirm` seconds, an unchanged state as a
 * keepalive every `tasks.pingMinutes`, and neither more than 12 times in the last hour. `down` ignores the cap. */
export function plan(key: string, rep: { key?: string; ping?: number; writes?: number[]; cand?: Candidate | null },
  now: number, cfg: Cfg, confirm: number): Plan {
  const tasks = (cfg.tasks || {}) as Record<string, unknown>;
  const pingS = (toFloat("pingMinutes" in tasks ? tasks.pingMinutes : 5) ?? 5) * 60;
  const recent = (rep.writes || []).filter((t) => now - t < HOUR);
  const room = recent.length < WRITES_PER_HOUR;
  if (key === rep.key) {
    if (key !== "down" && now - Number(rep.ping || 0) >= pingS && room) return { write: true, why: "keepalive", cand: null };
    return { write: false, why: null, cand: null };
  }
  const cand = rep.cand;
  if (!cand || cand.key !== key) return { write: false, why: null, cand: { key, at: now } };
  if (now - cand.at < confirm) return { write: false, why: null, cand };
  if (key === "down" || room) return { write: true, why: "change", cand: null };
  return { write: false, why: null, cand };
}

// --- this machine's state file -----------------------------------------------------------------------------------

export interface HeartbeatRow extends Derived {
  name: string;
  kind: string;
  machine: string;
  path: string | null;
  pid: number | null;
  session: string | null;
  follow: string | null;
  activity: number | null;
  since?: string;
}

export interface LocalState {
  machine?: string;
  pid?: number;
  boot?: string | null;
  updated?: number;
  interval?: number;
  agents?: Record<string, HeartbeatRow>;
  errors?: string[];
  [key: string]: unknown;
}

function localPath(): string {
  return join(stateDir(), LOCAL_FILE);
}

export function loadLocal(): LocalState {
  try {
    const data = JSON.parse(readFileSync(localPath(), "utf8")) as unknown;
    return data && typeof data === "object" && !Array.isArray(data) ? (data as LocalState) : {};
  } catch {
    return {};
  }
}

function saveLocal(data: LocalState): void {
  const path = localPath();
  mkdirSync(stateDir(), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, pyDumps(data, { indent: 1 }));
  renameSync(tmp, path);
}

/** Whether the daemon wrote its file recently (within three cycles, at least a minute). */
export function isFresh(data: LocalState, now: number | null = null): boolean {
  const t = now === null ? clockNow() : now;
  const wait = Math.max(3 * (toFloat(data.interval || 20) ?? 20), 60);
  const age = t - Number(data.updated || 0);
  return Object.keys(data).length > 0 && age >= 0 && age <= wait;
}

/** Whether the daemon on this machine is running and looks after `agent` (so the hooks need not write). */
export function managed(agent: string): boolean {
  try {
    const data = loadLocal();
    return isFresh(data) && agent in (data.agents || {});
  } catch {
    return false;
  }
}

/** Whether the daemon on this machine sees `agent` alive (working, waiting or idle) right now. */
export function aliveHere(agent: string): boolean {
  try {
    const data = loadLocal();
    const row = (data.agents || {})[agent];
    return isFresh(data) && ["working", "waiting", "idle"].includes(row?.state ?? "");
  } catch {
    return false;
  }
}

// --- looking at the machine --------------------------------------------------------------------------------------

function iso(epoch: number): string {
  return isoUtc(epoch);
}

export function intervalSeconds(cfg: Cfg): number {
  const tasks = (cfg.tasks || {}) as Record<string, unknown>;
  const given = process.env.FACTORY_HEARTBEAT_SECONDS || ("heartbeatSeconds" in tasks ? tasks.heartbeatSeconds : 20);
  const f = toFloat(given);
  return f === null ? 20.0 : Math.max(f, 5.0);
}

function confirmSeconds(cfg: Cfg): number {
  const f = toFloat(process.env.FACTORY_HEARTBEAT_CONFIRM);
  return f === null ? Math.min(15.0, intervalSeconds(cfg)) : f;
}

/** The agents to look at: the names this machine runs, whoever holds a checkout here, and any agent whose last
 * report was not `down` (it may have crashed since). */
function knownAgents(checkouts: Record<string, Claim>): string[] {
  const names = [...machineNames(), ...Object.keys(checkouts)];
  try {
    const d = claimsStateDir();
    for (const f of readdirSync(d)) {
      const m = /^agent-([a-z0-9][a-z0-9-]*)\.json$/.exec(f);
      if (!m) continue;
      let stamp: Record<string, unknown>;
      try {
        stamp = JSON.parse(readFileSync(join(d, f), "utf8")) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (stamp.status !== undefined && stamp.status !== null && stamp.status !== "down") names.push(m[1] as string);
    }
  } catch {
    // no state folder yet
  }
  return [...new Set(names.filter((n) => /^[a-z0-9][a-z0-9-]{0,39}$/.test(n)))];
}

/** {agent: row}: what this machine shows about each agent, derived and not yet reported anywhere. */
export function observe(cfg: Cfg, procs: Procs | null = null): Record<string, HeartbeatRow> {
  const stale = toFloat(cfg.claimStaleHours ?? 6) ?? 6;
  let data: { checkouts?: Record<string, Claim>; tasks?: Record<string, Claim> } = {};
  try {
    data = JSON.parse(readFileSync(join(claimsStateDir(), "claims.json"), "utf8")) as typeof data;
  } catch {
    data = {};
  }
  const checkouts = data.checkouts || {};
  const tasks = data.tasks || {};
  const ps = procs ?? processes();
  const sessions = tmuxSessions();
  const me = machineId();
  const rows: Record<string, HeartbeatRow> = {};
  for (const name of knownAgents(checkouts)) {
    const claim = checkouts[name] || {};
    const alive = Object.keys(claim).length > 0 && claimAlive(claim, stale, true);
    const pid = alive ? Math.trunc(Number(claim.pid)) : null;
    const task = alive ? (Object.entries(tasks).find(([, c]) => c.agent === name && claimAlive(c, stale))?.[0] ?? null) : null;
    const wait = alive ? waitsInTree(ps, pid as number) : null;
    const row: HeartbeatRow = { ...derive({ alive, task, wait }), name, kind: KIND, machine: me, path: claim.path ?? null, pid,
      session: null, follow: null, activity: null };
    const session = sessionName(name);
    if (sessions.has(session)) {
      row.session = session;
      if (alive) row.follow = followUrl(tmux("capture-pane", "-p", "-J", "-S", "-300", "-t", `=${session}`));
    }
    if (alive) {
      const times = [sessions.get(session) ?? null, transcriptActivity(claim.path)].filter((t): t is number => Boolean(t));
      row.activity = times.length ? Math.max(...times) : null;
    }
    rows[name] = row;
  }
  return rows;
}

// --- reporting to GitHub -----------------------------------------------------------------------------------------

/** What goes to GitHub about where the agent runs: only with tasks.showWhere. */
function reachFields(cfg: Cfg, row: HeartbeatRow): Record<string, string | null> {
  if (!((cfg.tasks || {}) as Record<string, unknown>).showWhere) return {};
  return { where: hostname(), session: row.session, follow: row.follow };
}

/** Writes one agent's state to GitHub if `plan` says so. Returns 'change', 'keepalive' or null. */
export function report(cfg: Cfg, name: string, row: HeartbeatRow, now: number, confirm: number): string | null {
  const stamp = recall(name);
  const state = row.state;
  if (state === "down" && !stamp.status) return null; // it never reported, so there is nothing to take back
  if (now < Number(stamp.retry || 0)) return null;
  const reach = reachFields(cfg, row);
  const key = keyOf(state, row.task, row.on, reach.session, reach.follow);
  const rep = { key: reportedKey(stamp), ping: Number(stamp.ping || 0), writes: stamp.writes || [], cand: stamp.cand ?? null };
  const got = plan(key, rep, now, cfg, confirm);
  if (!got.write) {
    if (pyDumps(got.cand) !== pyDumps(stamp.cand ?? null)) remember(name, { cand: got.cand });
    return null;
  }
  const extra = { kind: row.kind, task: row.task, on: row.on, since: row.since, hb: "1", ...reach };
  try {
    update(cfg, name, state, { detail: state === "working" || state === "waiting" ? row.detail : "", create: state !== "down",
      extra, replaceExtra: true });
  } catch (e) {
    remember(name, { retry: now + 60 }); // GitHub is not answering: try again in a minute, not every cycle
    throw e;
  }
  return got.why;
}

/** At start (a boot): this machine's agents that GitHub shows alive but that are not running here are down. */
function reconcile(cfg: Cfg, rows: Record<string, HeartbeatRow>): void {
  const mine = machineId();
  for (const issue of current(agentIssues())) {
    const f = fields(issue);
    const name = nameOf(issue);
    if (!name || !mine || f.machine !== mine || f.status === "down") continue;
    if ((rows[name]?.state ?? "down") !== "down") continue;
    update(cfg, name, "down", { number: issue.number });
  }
}

/** str(e) as Python printed it for an exception or a SystemExit. */
function errText(e: unknown): string {
  if (e instanceof Exit) return e.text ?? String(e.exitCode);
  return e instanceof Error ? e.message : String(e);
}

/** One look at the machine: the rows, the state file, and the GitHub writes that are due. Returns the rows. */
export function cycle(cfg: Cfg): Record<string, HeartbeatRow> {
  const now = clockNow();
  const prev = loadLocal();
  const rows = observe(cfg);
  const before = prev.agents || {};
  for (const [name, row] of Object.entries(rows)) {
    const old = before[name];
    row.since = old && old.state === row.state && old.since ? old.since : iso(now);
  }
  const errors: string[] = [];
  let boot = prev.boot ?? null;
  if (taskSource(cfg as Config) === "issues") {
    if (boot !== String(process.pid)) {
      try {
        reconcile(cfg, rows);
        boot = String(process.pid);
      } catch (e) {
        errors.push(`start: ${errText(e).slice(0, 160)}`);
      }
    }
    const confirm = confirmSeconds(cfg);
    for (const [name, row] of Object.entries(rows)) {
      try {
        report(cfg, name, row, now, confirm);
      } catch (e) {
        errors.push(`${name}: ${errText(e).slice(0, 160)}`);
      }
    }
  } else boot = String(process.pid);
  saveLocal({ machine: machineId(), pid: process.pid, boot, updated: now, interval: intervalSeconds(cfg), agents: rows, errors });
  return rows;
}

// --- running it --------------------------------------------------------------------------------------------------

/** One daemon per project and machine; the lock goes when the process does. Returns the open file (kept open). */
function acquireLock(): number {
  mkdirSync(stateDir(), { recursive: true });
  const fd = openSync(join(stateDir(), "heartbeat.lock"), "a+");
  if (!flock(fd, false)) {
    const buf = Buffer.alloc(64);
    const n = readSync(fd, buf, 0, 64, 0);
    const pid = buf.subarray(0, n).toString().trim();
    refuse("heartbeat-running", `The heartbeat daemon already runs for this project (pid ${pid || "?"}).`,
      "Nothing to do: `factory heartbeat status` shows what it sees. To restart it: " +
      `\`systemctl --user restart ${repoKey()}-factory-heartbeat\` (Linux) or ` +
      `\`launchctl kickstart -k gui/$(id -u)/dev.software-factory.${repoKey()}-heartbeat\` (macOS).`);
  }
  ftruncateSync(fd, 0);
  writeSync(fd, String(process.pid));
  return fd;
}

async function runDaemon(once = false): Promise<void> {
  acquireLock(); // held open for as long as the process lives
  let stop = false;
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => (stop = true));
  while (!stop) {
    const cfg = load();
    try {
      cycle(cfg);
    } catch (e) { // a bad cycle must never end the daemon
      process.stderr.write(`heartbeat: ${errText(e).slice(0, 200)}\n`);
    }
    if (once) return;
    const interval = intervalSeconds(cfg);
    for (let waited = 0; waited < interval && !stop; waited += 1) await Bun.sleep(Math.min(1.0, interval - waited) * 1000);
  }
}

function describe(rows: Record<string, HeartbeatRow>): string[] {
  const lines = Object.keys(rows).sort().map((name) => {
    const r = rows[name] as HeartbeatRow;
    const doing = r.detail || r.state;
    return `  ${name.padEnd(12)} ${r.state.padEnd(8)} ${doing !== r.state ? doing : ""}`.trimEnd();
  });
  return lines.length ? lines : ["  no agents are known on this machine"];
}

function status(): void {
  const data = loadLocal();
  if (isFresh(data)) {
    const age = Math.trunc(clockNow() - Number(data.updated));
    console.log(`daemon: running (pid ${data.pid ?? "None"}, last look ${age} s ago, every ${Math.trunc(Number(data.interval || 20))} s)`);
  } else console.log("daemon: not running" + (Object.keys(data).length ? " (the last look is old)" : ""));
  console.log("service: " + serviceText());
  for (const line of describe(data.agents || {})) console.log(line);
  for (const e of data.errors || []) console.log(`  trouble: ${e}`);
}

async function main(argv: string[]): Promise<void> {
  const cmd = argv[0] ?? "status";
  if (cmd === "run") return runDaemon();
  if (cmd === "once") {
    const rows = cycle(load());
    for (const line of describe(rows)) console.log(line);
    return;
  }
  if (cmd === "status") return status();
  if (cmd === "install") return installCli();
  if (cmd === "uninstall") return uninstallCli();
  if (cmd === "restart") return restartCli();
  refuse("unknown-command", `unknown command ${pyRepr(cmd)}.`, "Use status, run, once, install, uninstall or restart.");
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
