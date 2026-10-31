// `factory agents ls`: every agent in one table (#108): name, kind, where it runs, state, what it does, since when,
// last seen and how to follow it.
//
//   factory agents ls [--json] [--local] [--fresh]
//
// This machine comes from the heartbeat daemon's state file (factory_heartbeat.ts): instant, no network, and the full
// picture (tmux session, Remote Control link). When the daemon is not running the state is worked out on the spot and
// the line says how to start it. The other machines and the cloud agents come from their agent issues on GitHub (issues
// mode), cached for FACTORY_AGENTS_CACHE_SECONDS (default 45) so a quick repeat costs nothing; `--fresh` asks again and
// `--local` never asks. What a remote agent shows is what its machine posted: the hidden marker's kind, task, wait and
// `since` (an issue with no kind, from an older release, takes its role marker's), and the tmux session and follow
// link only when its project sets `tasks.showWhere`. A name that is down here but reported from another machine shows
// that machine's row (#366). A GitHub failure shows this machine alone, with a line saying so.
//
// --json prints {agents: [...], github: {...}, daemon: {...}, machine}; every row has name, kind, where, state, detail,
// task, on, since, lastSeen, follow, session, activity, machine, source (local or github) and expected: this machine's
// names file (or FACTORY_AGENTS) names it, so the cockpit lists it even when it is down (#366).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Config, taskSource, toFloat } from "./factory_config.ts";
import { now as clockNow } from "./factory_clock.ts";
import { agentIssues, current, fields, roleOf, stateOf } from "./factory_agents.ts";
import { type HeartbeatRow, isFresh, loadLocal, observe } from "./factory_heartbeat.ts";
import type { Issue } from "./factory_issues.ts";
import { machineId, machineNames, stateDir } from "./factory_machine.ts";
import { Exit, isoUtc, parseIso, pyDumps } from "./factory_lib.ts";

const CACHE_FILE = "agents-cache.json";
const LIVE = ["working", "waiting", "idle"];

function iso(epoch: number | null | undefined): string | null {
  return epoch ? isoUtc(epoch) : null;
}

function kindText(kind: unknown): string {
  return String(kind || "coding-agent").replace(/-/g, " ");
}

export interface LsRow {
  name: string;
  kind: string;
  where: string;
  state: string;
  detail: string;
  task: string | null;
  on: string | null;
  since: string | null;
  lastSeen: string | null;
  follow: string | null;
  session: string | null;
  activity: string | null;
  machine: string | null;
  source: string;
  expected: boolean;
}

interface DaemonInfo {
  running: boolean;
  updated: string | null;
  errors: string[];
}

/** [rows, daemon info] for this machine: from the daemon's file when it is fresh, else derived now. */
function localRows(cfg: Config): [LsRow[], DaemonInfo] {
  const data = loadLocal();
  const fresh = isFresh(data);
  const agents = (fresh ? data.agents || {} : observe(cfg)) as Record<string, HeartbeatRow>;
  const seen = fresh ? (data.updated as number | undefined) : clockNow();
  const rows: LsRow[] = [];
  const names = machineNames();
  for (const name of Object.keys(agents).sort()) {
    const r = agents[name] as HeartbeatRow;
    rows.push({ name, kind: kindText(r.kind), where: "this machine", state: r.state, detail: r.detail || r.state,
      task: r.task ?? null, on: r.on ?? null, since: r.since ?? null, lastSeen: r.state !== "down" ? iso(seen) : null,
      follow: r.follow ?? null, session: r.session ?? null, activity: iso(r.activity), machine: machineId(), source: "local",
      expected: names.includes(name) });
  }
  return [rows, { running: fresh, updated: Object.keys(data).length ? iso(data.updated as number | undefined) : null,
    errors: fresh ? ((data.errors as string[] | undefined) || []) : [] }];
}

function cachePath(): string {
  return join(stateDir(), CACHE_FILE);
}

interface Cache {
  at: number;
  issues: Issue[];
}

function readCache(): Cache | null {
  try {
    const data = JSON.parse(readFileSync(cachePath(), "utf8")) as unknown;
    return data && typeof data === "object" && Array.isArray((data as Cache).issues) ? (data as Cache) : null;
  } catch {
    return null;
  }
}

function writeCache(issues: Issue[], now: number): void {
  const path = cachePath();
  mkdirSync(dirname(path), { recursive: true });
  const slim = issues.map((i) => Object.fromEntries(["number", "title", "body", "state", "labels"].map((k) => [k, i[k] ?? null])));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, pyDumps({ at: now, issues: slim }));
  renameSync(tmp, path);
}

interface GithubInfo {
  ok: boolean;
  cached?: boolean;
  age?: number;
  error?: string;
  skipped?: boolean;
}

/** [issues, info]: the agent issues, from the cache while it is young. On a failure the old cache (if any) is used
 * and the error is in info. */
function githubIssues(fresh: boolean, now: number): [Issue[], GithubInfo] {
  const ttl = toFloat(process.env.FACTORY_AGENTS_CACHE_SECONDS || 45) ?? 45;
  const cached = readCache();
  if (cached && !fresh && now - Number(cached.at || 0) >= 0 && now - Number(cached.at || 0) < ttl) {
    return [cached.issues, { ok: true, cached: true, age: Math.trunc(now - Number(cached.at)) }];
  }
  let issues: Issue[];
  try {
    issues = agentIssues();
  } catch (e) {
    const message = (e instanceof Exit ? (e.text ?? "") : e instanceof Error ? e.message : String(e)).trim() ||
      (e instanceof Exit ? "SystemExit" : e instanceof Error ? e.name : "Exception");
    const info: GithubInfo = { ok: false, error: message.slice(0, 300) };
    if (cached) return [cached.issues, { ...info, cached: true, age: Math.trunc(now - Number(cached.at || 0)) }];
    return [[], info];
  }
  writeCache(issues, now);
  return [issues, { ok: true, cached: false, age: 0 }];
}

function remoteRows(cfg: Config, issues: Issue[], localNames: Set<string>): LsRow[] {
  const mine = machineId();
  const rows: LsRow[] = [];
  for (const issue of current(issues)) {
    const st = stateOf(cfg, issue);
    if (!st) continue;
    const [name, state, ping] = st;
    if (localNames.has(name)) continue;
    const f = fields(issue);
    const cloud = f.where === "cloud";
    const machine = f.machine || null;
    const where = cloud ? "cloud" : machine && machine === mine ? "this machine" : machine ? `machine ${machine}` : "-";
    const title = issue.title || "";
    const at = title.indexOf(" · ");
    const detail = at >= 0 ? title.slice(at + 3) : state;
    // An older release reports every row as a coding agent (or with no kind): its role marker knows better.
    const kind = f.kind && f.kind !== "coding-agent" ? f.kind : roleOf(issue);
    rows.push({ name, kind: kindText(kind), where, state, detail: state !== "silent" ? detail : `${detail} (no keepalive)`,
      task: f.task ?? null, on: f.on ?? null, since: f.since || iso(ping), lastSeen: iso(ping), follow: f.follow ?? null,
      session: f.session ?? null, activity: null, machine, source: "github", expected: false });
  }
  return rows;
}

function ago(stamp: string | null, now: number): string {
  if (!stamp) return "-";
  const t = parseIso(stamp) ?? 0;
  const m = Math.max(Math.floor((now - t) / 60), 0);
  return m < 1 ? "just now" : m < 120 ? `${m} min ago` : `${Math.floor(m / 60)} h ago`;
}

function table(rows: LsRow[], now: number): string[] {
  const head = ["Name", "Kind", "Where", "State", "Doing", "Since", "Last seen", "Follow"];
  const body = rows.map((r) => [r.name, r.kind, r.where, r.state, r.detail !== r.state ? r.detail : "-",
    ago(r.since, now), ago(r.lastSeen, now), r.follow || "-"]);
  const all = [head, ...body];
  const widths = head.slice(0, -1).map((_, i) => Math.max(...all.map((x) => (x[i] as string).length)));
  return all.map((row) => row.map((c, i) => (i < widths.length ? c.padEnd(widths[i] as number) : c)).join("  ").trimEnd());
}

export async function run(cfg: Config, asJson = false, localOnly = false, fresh = false): Promise<void> {
  const now = clockNow();
  const [rows, daemon] = localRows(cfg);
  let github: GithubInfo = { ok: true, skipped: true };
  if (!localOnly && taskSource(cfg) === "issues") {
    let issues: Issue[];
    [issues, github] = githubIssues(fresh, now);
    // A name down here may run on another machine (#366): its live row from there replaces this machine's `down`.
    // One that is down or silent there too keeps this machine's row, which says whether it is expected here.
    const elsewhere = remoteRows(cfg, issues, new Set(rows.filter((r) => r.state !== "down").map((r) => r.name)))
      .filter((r) => !rows.some((l) => l.name === r.name) || (r.where !== "this machine" && LIVE.includes(r.state)));
    const replaced = new Set(elsewhere.map((r) => r.name));
    rows.splice(0, rows.length, ...rows.filter((r) => !replaced.has(r.name)), ...elsewhere);
  }
  rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (asJson) {
    console.log(pyDumps({ agents: rows, github, daemon, machine: machineId() }, { indent: 1 }));
    return;
  }
  if (rows.length) console.log(table(rows, now).join("\n"));
  else console.log("No agents known yet. `factory machine setup <names>` names this machine's agents; `factory loop -i` starts one.");
  if (!daemon.running) {
    console.log("\nThe heartbeat daemon is not running here, so this machine's rows were worked out just now and nothing " +
      "reports to GitHub while an agent waits. Start it: factory heartbeat install");
  }
  if (!github.ok) {
    console.log(`\nGitHub: can't read the other machines' agents (${github.error}).` +
      (github.cached ? ` Showing what was cached ${github.age} s ago.` : " Showing this machine only."));
  } else if (github.cached && (github.age ?? 0) >= 1) {
    console.log(`\n(other machines as of ${github.age} s ago; --fresh asks GitHub again)`);
  }
}
