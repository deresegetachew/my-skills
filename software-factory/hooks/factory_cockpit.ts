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
// alone opens the tmux cockpit (#308, US-10): see "the tmux cockpit" below.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { toFloat } from "./factory_config.ts";
import { isoUtc, parseIso, pyDumps, run, runMain, shQuote, which } from "./factory_lib.ts";
import { refuse, repoKey, stateDir } from "./factory_machine.ts";
import { tmuxTooOld } from "./factory_window.ts";

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
    step(hook("factory_prs", "--json")),
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

function status(): number {
  const ttl = toFloat(process.env.FACTORY_COCKPIT_CACHE_SECONDS || 300) ?? 300;
  const snap = readCache();
  const at = snap ? parseIso(str(snap.generatedAt)) : null;
  const age = at === null ? null : Math.max(Date.now() / 1000 - at, 0);
  if (snap === null || age === null || age >= ttl) refreshInBackground();
  console.log(statusLine(snap, age, ttl));
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

// --- the tmux cockpit ------------------------------------------------------------------------------------------------
//
// `factory cockpit` alone (#308, PRD US-10, decision 0001): one terminal window, on tmux 3.2 or newer. Read-only.
//
//   factory cockpit                 open it (or attach to the one that runs): the sidebar on the left, a session or the
//                                   welcome text on the right, the counts on top (`cockpit --status`), the keys at the bottom
//   factory cockpit --sidebar       the sidebar's list, from the cache above; --once prints it once (no keys)
//   factory cockpit --commands [q]  the command bar's list, best match of q first (a fuzzy match: q's letters in order)
//   factory cockpit --bar           the command bar (what `:` opens): type to filter, Enter runs it through less -R
//   factory cockpit --view <name>   open a view as a popup running its factory commands through less -R
//   factory cockpit --open <name>   show that session on the right: `factory follow <name>` in the right pane
//
// The cockpit is its own tmux server (`tmux -L factory-cockpit-<repo>`) with its own config, written to
// cockpit.tmux.conf in this machine's state folder: the prefix is C-a, so a tmux it runs in (over ssh, say) keeps C-b,
// and the owner's ~/.tmux.conf is not read. The right pane attaches to the agent's own tmux session (the default
// server) with TMUX unset, so it is the real Claude Code session: typing goes to it, `/` stays Claude's, and C-a goes
// back to the cockpit. Only commands that read are offered; the ones agents and the gate use never are (PRD 4.10).

const SESSION = "cockpit";
const LEFT = `${SESSION}:0.0`;
const RIGHT = `${SESSION}:0.1`;

/** The views, in the sidebar's order, and the factory commands each one runs. */
export const VIEWS: [string, string[][]][] = [
  ["Needs you", [["watch"], ["messages", "ls"]]],
  ["Pull requests", [["prs"]]],
  ["Tasks & PRD", [["prd"], ["next"]]],
  ["CI", [["ci", "status"]]],
  ["Agents & machines", [["agents", "ls"], ["machine", "show"]]],
  ["Settings", [["settings", "list"], ["settings", "diff", "--staged"]]],
  ["Health & releases", [["doctor"], ["version"], ["releases"]]],
  ["Usage & lessons", [["usage"], ["lessons", "show"]]],
];

/** What the command bar offers: the commands that only read. Actions are US-11; the commands agents and the gate use
 * (review-pass, wait, run-check, guard, rereview, manager-claims, precheck) are never offered. */
export const COMMANDS = [
  "status", "prs", "watch", "agents ls", "agents list", "follow", "messages ls", "next", "prd", "issues list", "claims",
  "reviews", "lessons show", "ci status", "doctor", "version", "releases", "usage", "report", "settings list",
  "settings diff", "settings diff --staged", "machine show", "env", "heartbeat status", "autostart status",
  "turbo status", "signoff ls", "artifacts status", "handover snapshot", "cockpit --json", "help",
];

function top(): string {
  return run(["git", "rev-parse", "--show-toplevel"]).stdout.trim() || process.cwd();
}

/** The `factory` command: the script that started us (FACTORY_SELF), else the project's own, else the shim. */
function factoryBin(): string {
  const self = process.env.FACTORY_SELF;
  if (self && existsSync(self)) return self;
  const local = join(top(), "factory");
  return existsSync(local) ? local : which("factory") ?? "factory";
}

function factoryCmd(args: string[]): string {
  return [factoryBin(), ...args].map(shQuote).join(" ");
}

function socket(): string {
  return `factory-cockpit-${repoKey().replace(/[^A-Za-z0-9_-]+/g, "-")}`;
}

function configPath(): string {
  return join(stateDir(), "cockpit.tmux.conf");
}

function tmux(args: string[], env: Record<string, string | undefined> = process.env) {
  return run(["tmux", "-L", socket(), "-f", configPath(), ...args], { env, timeoutMs: 30_000 });
}

/** How well `query` matches `text`: -1 when its letters are not all in `text` in order; higher is better. */
export function score(text: string, query: string): number {
  const t = text.toLowerCase();
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  if (t === q) return 10_000;
  if (t.startsWith(q)) return 5_000 - t.length;
  let at = 0;
  let streak = 0;
  let total = 0;
  for (const c of q) {
    const i = t.indexOf(c, at);
    if (i < 0) return -1;
    streak = i === at ? streak + 1 : 1;
    total += streak * 10 - (i - at);
    at = i + 1;
  }
  return total;
}

export function matches(query: string): string[] {
  return COMMANDS.map((c, i) => ({ c, i, s: score(c, query) })).filter((m) => m.s >= 0)
    .sort((a, b) => b.s - a.s || a.i - b.i).map((m) => m.c);
}

type Item = { kind: "heading" | "note" | "session" | "view"; text: string; name?: string };

const KIND_ORDER = ["dev manager", "product owner", "sub manager", "coding agent"];

function kindRank(kind: string): number {
  const i = KIND_ORDER.indexOf(kind.replace(/-/g, " "));
  return i < 0 ? KIND_ORDER.length : i;
}

function sessionItem(row: Obj): Item {
  const name = str(row.name) || "?";
  const state = str(row.state) || "unknown";
  return { kind: "session", name, text: `${name} ${state}${state === "waiting" ? " !" : ""}` };
}

/** The sidebar's rows: SESSIONS (dev managers, product owners, coding agents, then other machines), then VIEWS. */
export function items(snap: Obj | null): Item[] {
  const rows = Array.isArray(snap?.sessions) ? (snap.sessions as unknown[]).map(obj) : [];
  const byKind = (a: Obj, b: Obj) => kindRank(str(a.kind)) - kindRank(str(b.kind)) || str(a.name).localeCompare(str(b.name));
  const here = rows.filter((r) => r.source !== "github").sort(byKind);
  const away = rows.filter((r) => r.source === "github").sort(byKind);
  const out: Item[] = [{ kind: "heading", text: "SESSIONS" }];
  if (!rows.length) {
    out.push({ kind: "note", text: snap ? "No sessions running." : "No sessions yet: reading them." },
      { kind: "note", text: "Start one: factory loop -i" });
  }
  out.push(...here.map(sessionItem));
  if (away.length) out.push({ kind: "note", text: "other machines" }, ...away.map(sessionItem));
  out.push({ kind: "heading", text: "VIEWS" }, ...VIEWS.map(([v]): Item => ({ kind: "view", name: v, text: v })));
  return out;
}

function cut(text: string, width: number): string {
  return [...text].length <= width ? text : [...text].slice(0, Math.max(width - 1, 0)).join("") + (width > 0 ? "…" : "");
}

/** The lines on screen: each at most `width` long, at most `height` of them, the selected row always shown. */
export function frame(list: Item[], selected: number, width: number, height: number): string[] {
  const lines = list.map((it, i) => {
    const mark = it.kind === "session" || it.kind === "view" ? (i === selected ? "› " : "  ") : "";
    return cut(it.kind === "note" ? `  ${it.text}` : mark + it.text, width);
  });
  const h = Math.max(height, 1);
  const first = Math.min(Math.max(selected - h + 1, 0), Math.max(lines.length - h, 0));
  return lines.slice(first, first + h);
}

function size(): [number, number] {
  const w = process.stdout.columns || Number(process.env.COLUMNS) || 30;
  const h = process.stdout.rows || Number(process.env.LINES) || 40;
  return [w, h];
}

function selectable(list: Item[]): number[] {
  return list.flatMap((it, i) => (it.kind === "session" || it.kind === "view" ? [i] : []));
}

function choose(it: Item | undefined): void {
  if (it?.kind === "session" && it.name) openSession(it.name);
  if (it?.kind === "view" && it.name) openView(it.name);
}

function sidebar(once: boolean): number {
  let list = items(readCache());
  if (once || !process.stdin.isTTY) {
    const [w, h] = size();
    console.log(frame(list, selectable(list)[0] ?? 0, w, h).join("\n"));
    return 0;
  }
  let pos = 0;
  const draw = () => {
    const [w, h] = size();
    const at = selectable(list)[pos] ?? 0;
    process.stdout.write("\x1b[?25l\x1b[H\x1b[2J" + frame(list, at, w, h).join("\r\n"));
  };
  const reload = () => {
    list = items(readCache());
    pos = Math.min(pos, Math.max(selectable(list).length - 1, 0));
    draw();
  };
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (b: Buffer) => {
    const k = b.toString();
    const n = Math.max(selectable(list).length, 1);
    if (k === "\x1b[A" || k === "k") pos = (pos - 1 + n) % n;
    else if (k === "\x1b[B" || k === "j") pos = (pos + 1) % n;
    else if (k === "\r" || k === "\n") choose(list[selectable(list)[pos] ?? -1]);
    else if (k === ":") tmux(["display-popup", "-E", "-w", "80%", "-h", "70%", barCommand()]);
    else if (k === "r") return reload();
    else if (k === "q") tmux(["detach-client"]);
    else if (k === "\x03") process.exit(0);
    draw();
  });
  process.stdout.on("resize", draw);
  setInterval(reload, 5_000);
  draw();
  return -1; // keeps running: the keys and the timer hold the process
}

/** A shell command that runs the factory commands one after another, through less -R. */
function paged(cmds: string[][]): string {
  return `cd ${shQuote(top())} && { ${cmds.map((c) => factoryCmd(c)).join("; echo; ")}; } 2>&1 | less -R`;
}

function openView(name: string): number {
  const view = VIEWS.find(([v]) => v.toLowerCase() === name.toLowerCase());
  if (!view) {
    refuse("unknown-view", `There is no view ${JSON.stringify(name)}.`,
      `Use one of: ${VIEWS.map(([v]) => `factory cockpit --view "${v}"`).join(", ")}.`);
  }
  return tmux(["display-popup", "-E", "-w", "90%", "-h", "90%", paged(view[1])]).code === 0 ? 0 : 1;
}

/** Shows the session on the right: `factory follow` finds it on this machine or another, and attaches. */
function openSession(name: string): number {
  const cmd = `cd ${shQuote(top())} && ${factoryCmd(["follow", name])}; echo; ` +
    "printf 'The session ended or could not be shown. Press Enter to close this pane.'; read _";
  const a = tmux(["respawn-pane", "-k", "-t", RIGHT, cmd]);
  const b = tmux(["select-pane", "-t", RIGHT]);
  return a.code === 0 && b.code === 0 ? 0 : 1;
}

function barCommand(): string {
  return `cd ${shQuote(top())} && ${factoryCmd(["cockpit", "--bar"])}`;
}

function bar(): number {
  if (!process.stdin.isTTY) {
    console.log(matches("").join("\n"));
    return 0;
  }
  let query = "";
  let pos = 0;
  const draw = () => {
    const [w, h] = size();
    const rows = matches(query).slice(0, Math.max(h - 2, 1)).map((c, i) => cut(`${i === pos ? "› " : "  "}${c}`, w));
    process.stdout.write("\x1b[H\x1b[2J" + cut(`: ${query}`, w) + "\r\n" +
      cut("Enter runs it (read-only) · Esc closes", w) + "\r\n" + rows.join("\r\n"));
  };
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (b: Buffer) => {
    const k = b.toString();
    const found = matches(query);
    if (k === "\x1b" || k === "\x03") process.exit(0);
    if (k === "\r" || k === "\n") {
      const pick = found[pos];
      if (!pick) return;
      process.stdin.setRawMode(false);
      const p = Bun.spawnSync(["sh", "-c", paged([pick.split(" ")])], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      process.exit(p.exitCode ?? 0);
    }
    if (k === "\x1b[A") pos = Math.max(pos - 1, 0);
    else if (k === "\x1b[B") pos = Math.min(pos + 1, Math.max(found.length - 1, 0));
    else if (k === "\x7f") [query, pos] = [query.slice(0, -1), 0];
    else if (k.length === 1 && k >= " ") [query, pos] = [query + k, 0];
    draw();
  });
  draw();
  return -1;
}

function welcome(): number {
  console.log([
    "Factory cockpit (read-only)", "",
    "Pick a session on the left and press Enter: its Claude Code session opens here, and you type into it.",
    "Pick a view to open it as a popup (q closes it).", "",
    "  C-a C-a    back to the sidebar          C-a :   the command bar",
    "  C-a Right  to this pane                 C-a d   detach (everything keeps running)",
    "", "Inside a session, `/` is Claude's and the agent's own tmux keeps C-b.",
  ].join("\n"));
  if (!process.stdout.isTTY) return 0;
  setInterval(() => undefined, 60_000);
  return -1;
}

const KEYS_SIDEBAR = " ↑↓ move · Enter open · : commands · r reload · q detach ";
const KEYS_SESSION = " typing goes to the session · C-a C-a sidebar · C-a : commands · C-a d detach ";

/** The cockpit's own tmux config: its prefix, its keys, the counts on top and the keys at the bottom. */
function config(): string {
  const counts = `cd ${shQuote(top())} && ${factoryCmd(["cockpit", "--status"])}`;
  const q = (s: string) => `"${s.replace(/(["\\$])/g, "\\$1")}"`;
  return [
    "# Written by `factory cockpit` (#308) each time the cockpit starts, so edits here are lost.",
    "set -g prefix C-a",
    "unbind-key C-b",
    `bind-key C-a select-pane -t ${LEFT}`,
    `bind-key Left select-pane -t ${LEFT}`,
    `bind-key Right select-pane -t ${RIGHT}`,
    `bind-key : display-popup -E -w 80% -h 70% ${q(barCommand())}`,
    "set -g base-index 0",
    "set -g pane-base-index 0",
    "set -g mouse on",
    "set -g escape-time 10",
    "set -g status-position top",
    "set -g status-interval 5",
    'set -g status-left " factory cockpit "',
    "set -g status-left-length 20",
    `set -g status-right ${q(`#(${counts}) `)}`,
    "set -g status-right-length 160",
    "set -g pane-border-status bottom",
    `set -g pane-border-format ${q(`#{?#{==:#{pane_index},0},${KEYS_SIDEBAR},${KEYS_SESSION}}`)}`,
    "",
  ].join("\n");
}

function writeConfig(): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, config());
  chmodSync(path, 0o644);
}

function open(): number {
  if (!process.stdin.isTTY || !process.stdout.isTTY) { // a script or a pipe: start no tmux server nobody would see
    refuse("no-terminal", "factory cockpit opens a window in a terminal, and this is not one (a script or a pipe).",
      "Run `factory cockpit` in a terminal; from a script use `factory cockpit --json` or `--status`.", 2);
  }
  if (!which("tmux")) {
    refuse("no-tmux", "factory cockpit runs in tmux, and tmux is not installed.",
      "Install tmux 3.2 or newer (for example `sudo apt install tmux` or `brew install tmux`), then run `factory cockpit` again.");
  }
  const old = tmuxTooOld();
  if (old) {
    refuse("tmux-too-old", `factory cockpit needs tmux 3.2 or newer, and this is tmux ${old}.`,
      "Upgrade tmux to 3.2 or newer (`tmux -V` shows the version), then run `factory cockpit` again.");
  }
  writeConfig();
  const outside = { ...process.env, TMUX: undefined, TMUX_PANE: undefined };
  if (tmux(["has-session", "-t", `=${SESSION}`], outside).code !== 0) {
    const [w, h] = [process.stdout.columns || 160, process.stdout.rows || 45];
    const dir = top();
    const steps = [
      ["new-session", "-d", "-s", SESSION, "-n", SESSION, "-c", dir, "-x", String(w), "-y", String(h),
        factoryCmd(["cockpit", "--sidebar"])],
      ["split-window", "-h", "-t", `${SESSION}:0`, "-c", dir, "-l", w < 80 ? "60%" : "75%", factoryCmd(["cockpit", "--welcome"])],
      ["select-pane", "-t", LEFT],
    ];
    for (const s of steps) {
      const p = tmux(s, outside);
      if (p.code !== 0) {
        refuse("tmux-failed", `tmux could not start the cockpit: ${(p.stderr.trim().split("\n").pop() || "no reason").slice(0, 160)}`,
          `Run \`tmux -L ${socket()} ls\` to see what is there, then run \`factory cockpit\` again.`);
      }
    }
  }
  if (process.env.TMUX) console.log("You are inside tmux: the cockpit's prefix is C-a, so your tmux keeps C-b.");
  const p = Bun.spawnSync(["tmux", "-L", socket(), "-f", configPath(), "attach-session", "-t", `=${SESSION}`],
    { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: outside });
  return p.exitCode ?? 1;
}

/** `factory cockpit` and its tmux flags: the exit code, -1 for a pane that keeps running, null for another flag. */
function tmuxMain(argv: string[]): number | null {
  const [flag, ...rest] = argv;
  if (flag === undefined) return open();
  if (flag === "--sidebar" && (rest.length === 0 || (rest.length === 1 && rest[0] === "--once"))) return sidebar(rest[0] === "--once");
  if (flag === "--commands" && rest.length <= 1) {
    const found = matches(rest[0] ?? "");
    if (found.length) console.log(found.join("\n"));
    return 0;
  }
  if (flag === "--bar" && !rest.length) return bar();
  if (flag === "--welcome" && !rest.length) return welcome();
  if (flag === "--view" && rest.length === 1) return openView(rest[0] as string);
  if (flag === "--open" && rest.length === 1) return openSession(rest[0] as string);
  return null;
}

const USAGE_ERROR: Problem = {
  code: "cockpit_usage",
  message: "factory cockpit takes no flag (the cockpit), or one of --json, --status, --sidebar [--once], --commands [query], " +
    "--bar, --view <name>, --open <session>.",
  fix: "Run `factory cockpit` to open the cockpit, or `factory help` for what each flag does.",
};

export async function main(argv: string[]): Promise<number> {
  const [flag, ...rest] = argv;
  if (!["--json", "--status", "--refresh"].includes(flag ?? "")) {
    const done = tmuxMain(argv);
    if (done === -1) return new Promise<number>(() => undefined); // an interactive pane: it ends by its keys
    if (done !== null) return done;
  }
  if (rest.length || !["--json", "--status", "--refresh"].includes(flag ?? "")) {
    process.stderr.write(JSON.stringify(USAGE_ERROR) + "\n");
    return 2;
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
