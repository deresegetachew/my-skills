#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// `factory cockpit --json` and `--status` (#298, PRD US-1): the core every screen reads.
//
//   factory cockpit --json     one snapshot of the factory as data, read now; it also refreshes the cache
//   factory cockpit --status   one line for tmux's status line, from the cache only (no GitHub call)
//
// The snapshot is made from the commands that already know each part, run side by side, so there is one reader of
// each: `factory agents ls --json` (sessions on every machine, the role from the heartbeat row, #299), `factory prs
// --json` (pull requests, owner asks), `factory ci status --json` (#304) and `factory doctor`. Keys: generatedAt,
// version, sessions, needsYou, pulls, ci, doctor, counts, missing. A part that can't be read is null (or what it had)
// and `missing` says why, each as {code, message, fix}; the command still exits 0.
//
// The cache is `cockpit.json` in this machine's state folder (factory_machine.ts). `--status` reads it; when it is
// missing or older than FACTORY_COCKPIT_CACHE_SECONDS (default 300: a refresh costs a few GitHub calls per open pull
// request, on the agents' token) it starts one refresh in the background and says how old the line is. `factory cockpit`
// alone opens the tmux cockpit (#308, US-10): factory_cockpit_ui.ts.
//
//   factory cockpit watch <item>   the item's sub-manager in its own tmux window, read-only (#307, PRD US-4)
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { toFloat } from "./factory_config.ts";
import { isoUtc, parseIso, pyDumps, runMain } from "./factory_lib.ts";
import { stateDir } from "./factory_machine.ts";
import { findSub, subWindow } from "./factory_orchestrator.ts";
import { checkTmux, running as sessionRunning, WindowError } from "./factory_window.ts";

const HOOKS = import.meta.dir;
const PIN = ".claude/factory/release.json";
const STEP_TIMEOUT_MS = 120_000;
const LOCK_SECONDS = 180; // a refresh that started this recently is still running (or died): don't start another

type Obj = { [key: string]: unknown };
export type Problem = { code: string; message: string; fix: string };
type Step = { code: number; stdout: string; stderr: string; timedOut: boolean };

function obj(v: unknown): Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {};
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
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

const GH_FIX = "Run `gh auth status` (and `gh auth login` if it says so); the cockpit shows the rest meanwhile.";

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
    pulls = data.pulls.map(obj).map((p) => ({ number: p.number, title: p.title, url: p.url ?? null, branch: p.branch,
      draft: Boolean(p.draft), ci: obj(p.ci).state ?? null, next: obj(p.next).action ?? null }));
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

/** What waits on the owner: unanswered owner-queue asks, and pull requests only a person merges. */
function needsYou(prs: Prs): Obj[] {
  const out: Obj[] = prs.asks.map((a) => ({ kind: "owner-ask", id: a.id, issue: a.issue, url: a.url ?? null, ageMinutes: a.ageMinutes ?? null }));
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

export async function snapshot(): Promise<Obj> {
  const [ls, prs, ciStep, doc] = await Promise.all([
    step(hook("factory_agents", "ls", "--json")),
    step(hook("factory_prs", "--json", "--fresh")), // read now: this snapshot is the cockpit's own cache
    step(["bash", join(HOOKS, "..", "ci", "ci.sh"), "status", "--json"]),
    step(hook("factory_doctor")),
  ]);
  const missing: Problem[] = [];
  const rows = sessions(ls, missing);
  const p = pullRequests(prs, missing);
  const needs = needsYou(p);
  const ciData = ci(ciStep, missing);
  const checks = doctor(doc, missing);
  const ver = version(missing);
  return {
    generatedAt: isoUtc(Date.now() / 1000), version: ver, sessions: rows ?? [], needsYou: needs, pulls: p.pulls, ci: ciData,
    doctor: checks, counts: { sessions: (rows ?? []).length, working: (rows ?? []).filter((r) => r.state === "working").length,
      pulls: (p.pulls ?? []).length, needYou: needs.length },
    missing,
  };
}

// --- the cache -------------------------------------------------------------------------------------------------------

function cachePath(): string {
  return join(stateDir(), "cockpit.json");
}

function lockPath(): string {
  return join(stateDir(), "cockpit.lock");
}

function writeCache(snap: Obj): void {
  const path = cachePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, pyDumps(snap, { indent: 1 }));
  renameSync(tmp, path);
}

export function readCache(): Obj | null {
  const data = parseJson(existsSync(cachePath()) ? readFileSync(cachePath(), "utf8") : "");
  return typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Obj) : null;
}

/** Starts `--refresh` in the background unless one started in the last LOCK_SECONDS. */
function refreshInBackground(): void {
  const lock = lockPath();
  try {
    if (Date.now() / 1000 - statSync(lock).mtimeMs / 1000 < LOCK_SECONDS) return;
    rmSync(lock, { force: true }); // left by a refresh that died
  } catch {
    // no lock: go on
  }
  try {
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, String(process.pid), { flag: "wx" }); // atomic: of two status lines at once, one refreshes
    spawn(process.execPath, ["--no-env-file", "--config=/dev/null", import.meta.path, "--refresh"],
      { detached: true, stdio: "ignore", cwd: process.cwd() }).unref();
  } catch {
    // the line still prints; the next refresh of the status line tries again
  }
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function ageText(seconds: number): string {
  return seconds < 120 ? `${Math.floor(seconds)} s` : seconds < 7200 ? `${Math.floor(seconds / 60)} min` : `${Math.floor(seconds / 3600)} h`;
}

/** The one line: counts, CI on main, "N need you", and what is old or missing. */
export function statusLine(snap: Obj | null, ageSeconds: number | null, ttl: number): string {
  if (snap === null) return "factory: no snapshot yet, reading it now";
  const c = obj(snap.counts);
  const n = (k: string): number => Number(c[k] ?? 0) || 0;
  const parts = [`factory: ${plural(n("sessions"), "session")}, ${n("working")} working`, plural(n("pulls"), "PR")];
  const main = (Array.isArray(obj(snap.ci).runs) ? (obj(snap.ci).runs as unknown[]).map(obj) : []).find((r) => r.ref === "main");
  if (main) parts.push(`CI main ${str(main.state)}`);
  parts.push(`${n("needYou")} need you`);
  const missing = Array.isArray(snap.missing) ? snap.missing.map(obj).map((m) => str(m.code)).filter(Boolean) : [];
  if (missing.length) parts.push(`can't read: ${[...new Set(missing)].join(", ")}`);
  if (ageSeconds === null) parts.push("age unknown");
  else if (ageSeconds >= ttl) parts.push(`as of ${ageText(ageSeconds)} ago`);
  return parts.join(" · ");
}

/** Starts a refresh in the background when the cache is missing or old; returns [snapshot, age in s, ttl]. */
export function refreshIfOld(): [Obj | null, number | null, number] {
  const ttl = toFloat(process.env.FACTORY_COCKPIT_CACHE_SECONDS || 300) ?? 300;
  const snap = readCache();
  const at = snap ? parseIso(str(snap.generatedAt)) : null;
  const age = at === null ? null : Math.max(Date.now() / 1000 - at, 0);
  if (snap === null || age === null || age >= ttl) refreshInBackground();
  return [snap, age, ttl];
}

function status(): number {
  console.log(statusLine(...refreshIfOld()));
  return 0;
}

async function refresh(): Promise<number> {
  try {
    writeCache(await snapshot());
  } finally {
    rmSync(lockPath(), { force: true });
  }
  return 0;
}

const USAGE_ERROR: Problem = {
  code: "cockpit_usage",
  message: "factory cockpit takes no argument, or --json, --status, --needs, --settings [--color] or watch <item>.",
  fix: "Run `factory cockpit` to open it, `factory cockpit --json` for the snapshot, `factory cockpit --status` for the " +
    "one line, `factory cockpit --settings` for the Settings view, or `factory cockpit watch <item>` to watch a sub-manager.",
};

const FLAGS = ["--json", "--status", "--refresh", "--sidebar", "--bar", "--needs", "--settings"];

function fail(p: Problem, code = 1): number {
  process.stderr.write(JSON.stringify(p) + "\n");
  return code;
}

/** `factory cockpit watch <item>` (#307, PRD US-4): the item's sub-manager in its tmux window, read-only (`attach -r`).
 * Nothing here sends keys to it. */
function watch(args: string[]): number {
  const ref = args[0] ?? "";
  if (args.length !== 1 || !/^[A-Za-z0-9_.-]+$/.test(ref)) {
    return fail({ code: "cockpit_usage", message: "factory cockpit watch needs one item, such as pr-12.",
      fix: "Run `factory cockpit watch <item>`; `factory watch` lists the items." }, 2);
  }
  const sub = findSub(ref);
  if (!sub) {
    return fail({ code: "no-sub-manager", message: `No sub-manager has run for ${ref} on this clone.`,
      fix: "`factory watch` lists what needs a manager; the dev manager's loop (`factory dev-manager loop`) starts a " +
        "sub-manager for each." });
  }
  if (!sub.live) {
    return fail({ code: "sub-manager-ended", message: `The sub-manager for ${ref} has ended, so there is nothing left to watch.`,
      fix: `Read what it did: less ${sub.out}` });
  }
  const { session, window } = subWindow(sub.name, ref);
  try {
    checkTmux();
  } catch (e) {
    if (e instanceof WindowError) return fail({ code: e.code, message: e.message, fix: e.fix });
    throw e;
  }
  if (!sessionRunning(session)) {
    return fail({ code: "no-window", message: `The sub-manager for ${ref} runs without a tmux window: its dev manager's ` +
      "loop does not run in one.", fix: `Follow its output: tail -f ${sub.out}. A dev manager started by ` +
      "`factory dev-manager loop -i` on a terminal, or by `factory resume`, gives its sub-managers windows." });
  }
  console.log(`Watching ${window} read-only; detach with your tmux prefix and d (twice inside tmux).`);
  const p = Bun.spawnSync(["tmux", "attach-session", "-r", "-t", `=${session}`], {
    stdin: "inherit", stdout: "inherit", stderr: "inherit", env: { ...process.env, TMUX: undefined },
  });
  return p.exitCode ?? 1;
}

export async function main(argv: string[]): Promise<number> {
  const [flag, ...rest] = argv;
  if (flag === "watch") return watch(rest);
  if (flag === "--settings" && rest.every((a) => a === "--color") && rest.length <= 1) {
    return (await import("./factory_cockpit_ui.ts")).settingsView(rest);
  }
  if (rest.length || (flag !== undefined && !FLAGS.includes(flag))) {
    process.stderr.write(JSON.stringify(USAGE_ERROR) + "\n");
    return 2;
  }
  if (flag === undefined || ["--sidebar", "--bar", "--needs"].includes(flag)) {
    const ui = await import("./factory_cockpit_ui.ts"); // the tmux cockpit (#308); --json and --status don't load it
    if (flag === "--sidebar") return ui.sidebar();
    if (flag === "--bar") return ui.bar();
    if (flag === "--needs") return ui.needs();
    return ui.open();
  }
  if (flag === "--status") return status();
  if (flag === "--refresh") return refresh();
  const snap = await snapshot();
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
