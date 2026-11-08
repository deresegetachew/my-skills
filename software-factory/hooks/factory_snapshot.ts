#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// `factory snapshot` (#298, #425, PRD US-1): one snapshot of the factory as data, the core the web UI's views read.
//
//   factory snapshot     read now, print it and write it to the cache
//
// The snapshot is made from the commands that already know each part, run side by side, so there is one reader of
// each: `factory agents ls --json` (sessions on every machine, the role from the heartbeat row, #299), `factory prs
// --json` (pull requests, owner asks), `factory ci status --json` (#304), `factory doctor` and the task tracker (the
// web UI's tasks channel, #424). Keys: generatedAt, version, sessions, needsYou, pulls, ci, doctor, tasks, counts,
// missing, and projects: the other projects on this machine with their agents, from their heartbeat files (#395). An
// owner ask in needsYou carries its text. A part that can't be read is null (or what it had) and `missing` says why,
// each as {code, message, fix}; the command still exits 0.
//
// The cache is `snapshot.json` in this machine's state folder (factory_machine.ts); the web UI reads it and runs this
// command again when it is old (factory_ui_views.ts). While GitHub's hourly limit is used up (#383) a snapshot keeps the
// last one's data, says when the limit is back, and the web UI starts none until then.
//
//   factory_snapshot.ts --tasks    the tasks part alone, as JSON: what the snapshot runs, in its own process, so a
//                                  tracker that hangs costs only its time limit
//
// FACTORY_SNAPSHOT_TASKS=board (#498): `factory ui` sets it when the project's tasks come from the message board, so
// the tracker isn't read (no GitHub calls for tasks) and the tasks part is the last snapshot's.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { load, taskSource } from "./factory_config.ts";
import { isFresh, type LocalState } from "./factory_heartbeat.ts";
import { isoUtc, parseIso, pyDumps, runMain } from "./factory_lib.ts";
import { refuse, stateDir } from "./factory_machine.ts";
import { type Limit, limitStatus } from "./factory_views_cache.ts";

const HOOKS = import.meta.dir;
const PIN = ".claude/factory/release.json";
const STEP_TIMEOUT_MS = 120_000;

type Obj = { [key: string]: unknown };
export type Problem = { code: string; message: string; fix: string };
type Step = { code: number; stdout: string; stderr: string; timedOut: boolean };

function obj(v: unknown): Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {};
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** `v` as text, without escape sequences or control characters: a task title can't drive a terminal that prints it. */
function plain(v: unknown): string {
  return (typeof v === "string" ? v : typeof v === "number" ? String(v) : "")
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, "") // OSC: a window title, a link
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "") // CSI: colours, cursor moves, clearing the screen
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function lastLine(text: string): string {
  return text.trim().split(/\r?\n/).at(-1) ?? "";
}

/** Runs one command without waiting on the others; a missing program or a timeout is a result, never an exception. */
async function step(cmd: string[]): Promise<Step> {
  try {
    const p = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A grandchild (gh, doctor's probes) can hold the pipes after the kill, so the reads race the timer.
    const late = new Promise<null>((done) => {
      timer = setTimeout(() => {
        p.kill();
        done(null);
      }, STEP_TIMEOUT_MS);
    });
    const read = Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    const got = await Promise.race([read, late]);
    clearTimeout(timer);
    if (got === null) return { code: 124, stdout: "", stderr: "", timedOut: true };
    const [stdout, stderr, code] = got;
    return { code, stdout, stderr, timedOut: false };
  } catch (e) {
    return { code: 127, stdout: "", stderr: e instanceof Error ? e.message : String(e), timedOut: false };
  }
}

function hook(name: string, ...args: string[]): string[] {
  return [process.execPath, "--no-env-file", "--config=/dev/null", join(HOOKS, `${name}.ts`), ...args];
}

/** The command's own {code, message, fix} when its last line is one, else one in our words. */
function problemOf(s: Step, code: string, what: string, command: string): Problem {
  const own = obj(parseJson(lastLine(s.stderr) || lastLine(s.stdout)));
  if (typeof own.code === "string" && typeof own.message === "string" && typeof own.fix === "string") {
    return { code: own.code, message: own.message, fix: own.fix };
  }
  const why = s.timedOut ? `it took longer than ${STEP_TIMEOUT_MS / 1000} s` : lastLine(s.stderr) || `it exited ${s.code}`;
  return { code, message: `${what} could not be read (${why.slice(0, 200)}).`, fix: `Run \`${command}\` to see the whole error.` };
}

const GH_FIX = "Run `gh auth status` (and `gh auth login` if it says so); the web UI shows the rest meanwhile.";

// GitHub's answer when the account's calls are used up (a 403 or 429 saying so, #383). `gh auth status` then says
// "Failed to log in" too, so the login hint would send the owner after a login that is fine.
const LIMITED = /rate limit|x-ratelimit-remaining:\s*0\b|\bHTTP 429\b/i;

function hhmm(epoch: number): string {
  return isoUtc(epoch).slice(11, 16);
}

/** The one problem that replaces every GitHub one while the limit is reached: when it is back, from `gh api rate_limit`
 * (which does not count against the limit); `core` is null when even that can't be read. */
function limitProblem(core: Limit | null, t: number): Problem {
  const message = `${limitSentence(core, t)} The web UI shows the last snapshot meanwhile.`;
  if (usedUp(core, t)) {
    return { code: "github_limit", message, fix: `Nothing to do: the web UI reads GitHub again after ${hhmm(core.reset)} ` +
      "UTC. `factory usage --github` shows what used the calls." };
  }
  return { code: "github_limit", message, fix: "Wait a few minutes; the web UI reads GitHub again on its own. " +
    "`factory usage --github` shows what used the calls." };
}

/** "GitHub's hourly limit is used up; back at HH:MM UTC (in N min)." when `core` says so, else a limit with no time
 * (a secondary limit, or `gh api rate_limit` unreadable). */
export function limitSentence(core: Limit | null, t: number): string {
  if (!usedUp(core, t)) return "GitHub is limiting this account's calls for now.";
  return `GitHub's hourly limit is used up; back at ${hhmm(core.reset)} UTC (in ${Math.max(Math.ceil((core.reset - t) / 60), 1)} min).`;
}

/** `missing` with every GitHub problem replaced by the limit's, when one of them is the limit; else null. A problem
 * that sends the owner to `gh auth` (CI's says only that GitHub can't be read) is the limit's too. */
function limited(missing: Problem[]): { missing: Problem[]; limit: Obj } | null {
  if (!missing.some((m) => LIMITED.test(m.message))) return null;
  const t = Date.now() / 1000;
  const core = limitStatus();
  const rest = missing.filter((m) => !LIMITED.test(m.message) && !m.fix.includes("gh auth"));
  return { missing: [limitProblem(core, t), ...rest], limit: { reset: usedUp(core, t) ? core.reset : null,
    remaining: core?.remaining ?? null } };
}

/** True when the hourly limit is used up and its reset is still ahead; a secondary limit leaves calls (#385). */
function usedUp(core: Limit | null, t: number): core is Limit {
  return core !== null && core.remaining <= 0 && core.reset > t;
}

function ageText(seconds: number): string {
  return seconds < 120 ? `${Math.floor(seconds)} s` : seconds < 7200 ? `${Math.floor(seconds / 60)} min` : `${Math.floor(seconds / 3600)} h`;
}

/** What to cache: a snapshot made while the limit is reached keeps the last good one's data and time (with the limit's
 * problem and its age said), so the views show what was known rather than empty parts. */
function keepLast(snap: Obj, last: Obj | null): Obj {
  if (!snap.limit || last === null) return snap;
  const at = parseIso(str(last.generatedAt));
  const age = at === null ? "" : ` It is from ${hhmm(at)} UTC (${ageText(Math.max(Date.now() / 1000 - at, 0))} ago).`;
  const missing = (snap.missing as Problem[]).map((m) => (m.code === "github_limit" ? { ...m, message: m.message + age } : m));
  return { ...last, limit: snap.limit, missing };
}

function sessions(s: Step, missing: Problem[]): Obj[] | null {
  const data = obj(parseJson(s.stdout));
  if (!Array.isArray(data.agents)) {
    missing.push(problemOf(s, "sessions_unreadable", "The sessions", "factory agents ls"));
    return null;
  }
  const github = obj(data.github);
  if (github.ok === false) {
    missing.push({ code: "github_sessions_unreadable", message: "The other machines' sessions can't be read from GitHub " +
      `(${str(github.error).slice(0, 200)}); ` + (github.cached ? `they are as of ${String(github.age)} s ago.` : "this machine's are shown."),
      fix: GH_FIX });
  }
  return data.agents.map(obj);
}

type Prs = { pulls: Obj[] | null; asks: Obj[] };

function pullRequests(s: Step, missing: Problem[]): Prs {
  const data = obj(parseJson(s.stdout));
  if (!("pulls" in data)) {
    missing.push(problemOf(s, "pulls_unreadable", "The pull requests", "factory prs"));
    return { pulls: null, asks: [] };
  }
  let pulls: Obj[] | null = null;
  if (Array.isArray(data.pulls)) {
    // review, notGreen, protected, agent and claim are for the web UI's pull requests channel (#424); head keeps a pull
    // request's page until it changes (#453)
    pulls = data.pulls.map(obj).map((p) => ({ number: p.number, title: p.title, url: p.url ?? null, branch: p.branch,
      draft: Boolean(p.draft), createdAt: p.createdAt ?? null, ci: obj(p.ci).state ?? null, next: obj(p.next).action ?? null, nextText: obj(p.next).text ?? null,
      agent: p.agent ?? null, review: p.headMarker ?? null, gate: p.gate ?? null, head: str(obj(p.head).sha) || null,
      notGreen: Array.isArray(obj(p.ci).notGreen) ? obj(p.ci).notGreen : [], protected: typeof p.protected === "boolean" ? p.protected : null,
      claim: p.claim ?? null, rework: obj(p.rework).agent ?? null, cites: Array.isArray(p.cites) ? p.cites.map(plain).filter(Boolean) : [] }));
  } else {
    missing.push({ code: "pulls_unreadable", message: `The pull requests can't be read from GitHub (${str(obj(data.pulls).error).slice(0, 200)}).`,
      fix: GH_FIX });
  }
  const asks = Array.isArray(data.ownerAsks) ? data.ownerAsks.map(obj) : [];
  if (!Array.isArray(data.ownerAsks) && pulls !== null) {
    missing.push({ code: "owner_asks_unreadable", message: `The owner queue can't be read from GitHub (${str(obj(data.ownerAsks).error).slice(0, 200)}).`,
      fix: GH_FIX });
  }
  return { pulls, asks };
}

/** What waits on the owner: owner-queue asks nobody answered or the product owner replied to (not those still the
 * product owner's, #352), and pull requests only a person merges. */
function needsYou(prs: Prs): Obj[] {
  const out: Obj[] = prs.asks.filter((a) => !(a.forProduct === true && a.state !== "owner"))
    .map((a) => ({ kind: "owner-ask", id: a.id, issue: a.issue, url: a.url ?? null, ageMinutes: a.ageMinutes ?? null, state: a.state ?? "open",
      text: str(a.text) }));
  for (const p of prs.pulls ?? []) {
    if (p.next === "owner-merges") out.push({ kind: "owner-merges", number: p.number, title: p.title, url: p.url });
  }
  return out;
}

function ci(s: Step, missing: Problem[]): Obj | null {
  const data = parseJson(s.stdout);
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    missing.push(problemOf(s, "ci_unreadable", "CI", "factory ci status --json"));
    return null;
  }
  for (const e of Array.isArray((data as Obj).errors) ? ((data as Obj).errors as unknown[]).map(obj) : []) {
    missing.push({ code: str(e.code), message: str(e.message), fix: str(e.fix) });
  }
  return data as Obj;
}

function doctor(s: Step, missing: Problem[]): Obj | null {
  const lines = s.stdout.split(/\r?\n/);
  const kind = (k: string): string[] => lines.filter((l) => l.startsWith(`${k} `)).map((l) => l.slice(k.length).trim());
  const summary = lines.map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
  if (s.timedOut || !/^(All the checks pass\.|\d+ to fix\.)$/.test(summary)) {
    missing.push(problemOf(s, "doctor_failed", "`factory doctor`", "factory doctor"));
    return null;
  }
  const fixes = kind("fix");
  return { fixes: fixes.length, notes: kind("note").length, ok: kind("ok").length, summary, fix: fixes };
}

function version(missing: Problem[]): Obj {
  const pin = obj(parseJson(existsSync(PIN) ? readFileSync(PIN, "utf8") : ""));
  if (typeof pin.version === "string") return { installed: pin.version, source: "release" };
  const file = join(HOOKS, "..", "VERSION");
  if (existsSync(file)) return { installed: readFileSync(file, "utf8").trim() || null, source: "linked" };
  missing.push({ code: "version_unknown", message: `The factory's version can't be told: there is no ${PIN} and no VERSION file.`,
    fix: "Run `factory version` to see what is installed." });
  return { installed: null, source: null };
}

/** The project's tasks from its task tracker (#377): the GitHub issues in issues mode and the build plan otherwise, or
 *  the error that stopped the read. */
async function tasksData(): Promise<Obj> {
  const cfg = load();
  const source = taskSource(cfg);
  const base = { source, prd: plain(obj(cfg).prd) };
  try {
    const { taskTracker } = await import("./core/compose.ts");
    const tracker = taskTracker(cfg);
    const tasks = tracker.list().map((t) => ({ id: plain(t.id), title: plain(t.title), state: t.state,
      holders: t.holders.map(plain), group: plain(t.group), todos: t.todos.map((d) => ({ done: d.done })), dependsOn: t.dependsOn.map(plain),
      cites: (t.cites ?? []).map(plain), ...(t.waitsForPrd ? { waitsForPrd: plain(t.waitsForPrd) } : {}) }));
    // the epics fail on their own (#464): the tasks still show, and the epics channel says why it has none
    try {
      const epics = tracker.epics().map((e) => ({ id: plain(e.id), title: plain(e.title), stage: e.stage, prd: plain(e.prd),
        decisions: e.decisions.map(plain), summary: plain(e.summary), cites: e.cites.map(plain), tasks: e.tasks.map((t) => ({ id: plain(t.id), done: t.done })), url: e.url }));
      return { ...base, tasks, epics };
    } catch (e) {
      return { ...base, tasks, epics: [], epicsError: errorText(e, "the tracker gave no epics") };
    }
  } catch (e) {
    return { ...base, error: errorText(e, "the tracker gave no tasks") };
  }
}

function errorText(e: unknown, none: string): string {
  return plain(e instanceof Error ? e.message : String(e)) || none;
}

/** The tasks part, as `--tasks` printed it; null when it printed no data. A tracker that can't be read gives its error
 *  in the part, and the tasks channel says it. */
function tasks(s: Step): Obj | null {
  const data = parseJson(s.stdout);
  return typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Obj) : null;
}

/** The other projects that run the factory on this machine (#395), from each one's heartbeat file in its state folder
 *  (`<project>-factory/heartbeat.json`, next to this project's): its name, whether its heartbeat still reports, and its
 *  agents as that heartbeat saw them. Read from disk only, so it costs nothing. */
function otherProjects(): Obj[] {
  const mine = stateDir();
  const base = dirname(mine);
  let folders: string[];
  try {
    folders = readdirSync(base).filter((f) => f.endsWith("-factory") && join(base, f) !== mine).sort();
  } catch {
    return [];
  }
  const out: Obj[] = [];
  for (const folder of folders) {
    const data = obj(parseJson(existsSync(join(base, folder, "heartbeat.json")) ? readFileSync(join(base, folder, "heartbeat.json"), "utf8") : ""));
    if (!Object.keys(data).length) continue;
    const agents = Object.values(obj(data.agents)).map(obj).map((r) => ({ name: str(r.name), kind: str(r.kind || "coding-agent").replace(/-/g, " "),
      state: str(r.state) || "unknown", detail: str(r.detail), task: r.task ?? null, runs: str(r.runs), session: r.session ?? null,
      log: r.log ?? null })).filter((r) => r.name).sort((a, b) => a.name.localeCompare(b.name));
    out.push({ name: folder.slice(0, -"-factory".length), fresh: isFresh(data as LocalState), updated: data.updated ?? null, agents });
  }
  return out;
}

/** The snapshot. `keptTasks`: the tasks part to give without reading the tracker (FACTORY_SNAPSHOT_TASKS=board). */
export async function snapshot(keptTasks?: Obj | null): Promise<Obj> {
  const skip = keptTasks !== undefined;
  const [ls, prs, ciStep, doc, taskStep] = await Promise.all([
    step(hook("factory_agents", "ls", "--json")),
    step(hook("factory_prs", "--json", "--fresh")), // read now: this snapshot is the web UI's own cache
    step(["bash", join(HOOKS, "..", "ci", "ci.sh"), "status", "--json"]),
    step(hook("factory_doctor")),
    skip ? Promise.resolve(null) : step(hook("factory_snapshot", "--tasks")),
  ]);
  const missing: Problem[] = [];
  const rows = sessions(ls, missing);
  const p = pullRequests(prs, missing);
  const needs = needsYou(p);
  const ciData = ci(ciStep, missing);
  const checks = doctor(doc, missing);
  const ver = version(missing);
  const limit = limited(missing);
  return {
    generatedAt: isoUtc(Date.now() / 1000), version: ver, sessions: rows ?? [], projects: otherProjects(), needsYou: needs, pulls: p.pulls, ci: ciData,
    doctor: checks, tasks: taskStep ? tasks(taskStep) : keptTasks ?? null, counts: { sessions: (rows ?? []).length, working: (rows ?? []).filter((r) => r.state === "working").length,
      pulls: (p.pulls ?? []).length, needYou: needs.length },
    missing: limit?.missing ?? missing,
    ...(limit ? { limit: limit.limit } : {}),
  };
}

// --- the cache -------------------------------------------------------------------------------------------------------

function cachePath(): string {
  return join(stateDir(), "snapshot.json");
}

function writeCache(snap: Obj): void {
  const path = cachePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, pyDumps(snap, { indent: 1 }));
  renameSync(tmp, path);
}

function readCache(): Obj | null {
  const data = parseJson(existsSync(cachePath()) ? readFileSync(cachePath(), "utf8") : "");
  return typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Obj) : null;
}

export async function main(argv: string[]): Promise<number> {
  if (argv.length === 1 && argv[0] === "--tasks") {
    console.log(JSON.stringify(await tasksData()));
    return 0;
  }
  if (argv.length) {
    refuse("snapshot_usage", "factory snapshot takes no argument.",
      "Run `factory snapshot` for the snapshot as JSON, or `factory ui` to see it in a browser.", 2);
  }
  const last = readCache();
  const fromBoard = process.env.FACTORY_SNAPSHOT_TASKS === "board";
  const snap = keepLast(await snapshot(fromBoard ? (last?.tasks as Obj | null | undefined) ?? null : undefined), last);
  try {
    writeCache(snap);
  } catch (e) {
    (snap.missing as Problem[]).push({ code: "cache_unwritable", message: `The cache can't be written (${e instanceof Error ? e.message : String(e)}).`,
      fix: `Check that ${dirname(cachePath())} is writable.` });
  }
  console.log(pyDumps(snap, { indent: 1 }));
  return 0;
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
