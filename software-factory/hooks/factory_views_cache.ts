// One cache for the GitHub views (#305): `factory prs`, `factory watch` and `factory messages ls` answer from it while
// it is fresh, so a view opens without waiting on GitHub, like `factory agents ls`.
//
// Each view and its arguments has one file, `views/<view>-<hash>.json` in this machine's state folder
// (factory_machine.ts), written to a temp file and renamed, so a reader never sees half of one. An entry is fresh for
// `views.cacheSeconds` (default 45; 0 turns the cache off). A fresh answer says how old it is; from half that age it
// also starts one refresh in the background (`<view> ... --fresh`), so the next open is fresh too. A `wx` lock next to
// the entry lets only one of several views opened at once start it. `--fresh` reads GitHub now. A file that can't be
// read, or that an older release wrote, counts as missing. Only the command line uses it: the orchestrator and the
// other modules that import a view's `collect` read GitHub as before, except what `remember` keeps (#347): a pull
// request's comments until the PR changes, and whether an issue has its thread note, in `views/memo/`.
//
// GitHub's API limit, for the loops (#347). Every agent on the owner's account shares 5,000 calls an hour. A pass whose
// GitHub call met the limit (or a secondary limit, or the network) exits GITHUB_BUSY (4, factory_lib.ts); the loop then
// runs `limit-wait` instead of counting a failed pass, and `limit-idle` to know how long an idle wait should be:
//
//   factory_views_cache.ts limit-wait --attempt N [--name AGENT]
//         the limit is used up: "GitHub limit reached; waiting until HH:MM UTC", and sleeps until the reset;
//         else (a secondary limit, a timeout): "GitHub did not answer; trying again in M min", M = 1, 2, 4, 8, 15, 15 ...
//         for the Nth busy pass in a row. Exit 0.
//   factory_views_cache.ts limit-idle MINUTES
//         the minutes an idle loop waits: MINUTES, or twice that while fewer than `github.reserve` (500) calls are left
//         this hour (said on stderr). MINUTES when the limit can't be read.
//
// Both read `gh api rate_limit` (which does not count against the limit) through one file in this machine's state folder,
// fresh for a minute, so the loops on a machine make one small read between them. With FACTORY_NOW set (a test's fake
// clock) `limit-wait` says what it would wait and does not sleep. (Here rather than in a hook of its own, so the change
// needs no new link in this repo's protected .claude/ folder.)
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { now as clockNow } from "./factory_clock.ts";
import { type Config, load, toFloat } from "./factory_config.ts";
import { stateDir } from "./factory_machine.ts";
import { die, git, isoUtc, parseArgs, pyDumps, run, runMain, sleepSync } from "./factory_lib.ts";

export const SCHEMA = 1;
export const DEFAULT_SECONDS = 45;
const LOCK_SECONDS = 180; // a refresh that started this recently is still running (or died): don't start another
const LOCK_ENV = "FACTORY_VIEWS_LOCK"; // set only for a background refresh: the lock it removes when it is done

export interface View {
  name: "prs" | "watch" | "messages";
  hook: string; // the hook's path, run again with --fresh for a background refresh
  args: string[]; // the command-line arguments that pick what is read (without --fresh)
}

export interface Answer<T> {
  data: T;
  age: number | null; // seconds, when it came from the cache
}

interface Entry {
  schema: number;
  view: string;
  args: string[];
  at: number;
  data: unknown;
}

/** `views.cacheSeconds` from the project's settings: 45 when unset or not a number, never below 0. */
export function ttl(cfg: Config): number {
  const views = cfg.views;
  const raw = typeof views === "object" && views !== null && !Array.isArray(views) ? (views as Config).cacheSeconds : undefined;
  const n = raw === undefined || raw === null ? null : toFloat(raw);
  return n === null ? DEFAULT_SECONDS : Math.max(n, 0);
}

/** The project's own folder: the state folder is named after its basename only, which two projects can share. */
function projectRoot(): string {
  const p = git(["rev-parse", "--git-common-dir"]);
  return resolve(p.code === 0 && p.stdout.trim() ? p.stdout.trim() : process.cwd());
}

function filePath(view: View): string {
  const hash = createHash("sha256").update(JSON.stringify([projectRoot(), view.name, view.args])).digest("hex").slice(0, 16);
  return join(stateDir(), "views", `${view.name}-${hash}.json`);
}

function readEntry(view: View, path: string): Entry | null {
  try {
    const e = JSON.parse(readFileSync(path, "utf8")) as Partial<Entry> | null;
    if (!e || typeof e !== "object" || e.schema !== SCHEMA || e.view !== view.name || typeof e.at !== "number" ||
      JSON.stringify(e.args) !== JSON.stringify(view.args) || !("data" in e)) return null;
    return e as Entry;
  } catch {
    return null;
  }
}

function writeEntry(view: View, path: string, data: unknown, at: number): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, pyDumps({ schema: SCHEMA, view: view.name, args: view.args, at, data }));
    renameSync(tmp, path);
  } catch {
    // the view still answers; the next one reads GitHub again
  } finally {
    rmSync(`${path}.${process.pid}.tmp`, { force: true });
  }
}

/** Starts `<hook> <args> --fresh` in the background unless one for this entry started in the last LOCK_SECONDS. */
function refreshInBackground(view: View, path: string): void {
  const lock = `${path}.lock`;
  try {
    if (Date.now() / 1000 - statSync(lock).mtimeMs / 1000 < LOCK_SECONDS) return;
    rmSync(lock, { force: true }); // left by a refresh that died
  } catch {
    // no lock: go on
  }
  try {
    writeFileSync(lock, String(process.pid), { flag: "wx" }); // atomic: of two views at once, one refreshes
    spawn(process.execPath, ["--no-env-file", "--config=/dev/null", view.hook, ...view.args, "--fresh"],
      { detached: true, stdio: "ignore", cwd: process.cwd(), env: { ...process.env, [LOCK_ENV]: lock } }).unref();
  } catch {
    // the view still answers from the cache; the next open tries again
  }
}

/** The view's data: from the cache while it is fresh (and not `fresh`), else read now with `read` and kept, unless
 * `keep` says the read failed. */
export function answer<T>(cfg: Config, view: View, fresh: boolean, read: () => T, keep: (data: T) => boolean = () => true): Answer<T> {
  const seconds = ttl(cfg);
  const path = filePath(view);
  const now = clockNow();
  if (!fresh && seconds > 0) {
    const e = readEntry(view, path);
    const age = e ? now - e.at : null;
    if (e && age !== null && age >= 0 && age < seconds) {
      if (age >= seconds / 2) refreshInBackground(view, path);
      return { data: e.data as T, age: Math.trunc(age) };
    }
  }
  try {
    const data = read();
    if (seconds > 0 && keep(data)) writeEntry(view, path, data, now);
    return { data, age: null };
  } finally {
    // only the background refresh that took this entry's lock gives it back; any other read leaves it alone
    if (process.env[LOCK_ENV] === `${path}.lock`) rmSync(`${path}.lock`, { force: true });
  }
}

const SETTLE_SECONDS = 60;

/** An `updated_at` to key `remember` on, or "" (read every time) while it is under a minute old: GitHub's times are
 * to the second, so a comment made in the same second as the read would leave the same time behind. */
export function settled(updatedAt: string | null | undefined): string {
  const t = updatedAt ? Date.parse(updatedAt) / 1000 : NaN;
  return Number.isFinite(t) && clockNow() - t >= SETTLE_SECONDS ? (updatedAt as string) : "";
}

/** `read()`, kept as `views/memo/<hash>.json` with `version` (for a pull request, its `updated_at`), and given back
 * without reading while the version is the same (#347). An empty version, or `views.cacheSeconds` 0, reads every time.
 * An answer `keep` refuses is not kept. */
export function remember<T>(cfg: Config, key: string, version: string, read: () => T, keep: (data: T) => boolean = () => true): T {
  if (!version || ttl(cfg) <= 0) return read();
  const hash = createHash("sha256").update(JSON.stringify([projectRoot(), key])).digest("hex").slice(0, 16);
  const path = join(stateDir(), "views", "memo", `${hash}.json`);
  try {
    const e = JSON.parse(readFileSync(path, "utf8")) as { schema?: unknown; key?: unknown; version?: unknown; data?: T };
    if (e.schema === SCHEMA && e.key === key && e.version === version && "data" in e) return e.data as T;
  } catch {
    // not kept yet, or unreadable: read it
  }
  const data = read();
  if (!keep(data)) return data;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.${process.pid}.tmp`, pyDumps({ schema: SCHEMA, key, version, data }));
    renameSync(`${path}.${process.pid}.tmp`, path);
  } catch {
    // the next read asks GitHub again
  } finally {
    rmSync(`${path}.${process.pid}.tmp`, { force: true });
  }
  return data;
}

/** The line that says a view came from the cache, or null when it was read now. */
export function ageNote(age: number | null): string | null {
  return age === null ? null : `(as of ${age} s ago; --fresh asks GitHub again)`;
}

/** Prints the note where it doesn't break the output: the last line in text mode, stderr with --json. */
export function sayAge(age: number | null, json: boolean): void {
  const note = ageNote(age);
  if (note === null) return;
  if (json) process.stderr.write(note + "\n");
  else console.log(note);
}

// --- GitHub's API limit (#347) -----------------------------------------------------------------------------------------

export const DEFAULT_RESERVE = 500;
const LIMIT_FRESH_SECONDS = 60;
const MAX_BACKOFF_MINUTES = 15;

export interface Limit {
  limit: number;
  remaining: number;
  reset: number; // seconds since 1970
}

/** `github.reserve` from the project's settings: 500 when unset or not a number, never below 0. */
export function reserve(cfg: Config): number {
  const g = cfg.github;
  const raw = typeof g === "object" && g !== null && !Array.isArray(g) ? (g as Config).reserve : undefined;
  const n = raw === undefined || raw === null ? null : toFloat(raw);
  return n === null ? DEFAULT_RESERVE : Math.max(n, 0);
}

function limitFile(): string {
  return join(stateDir(), "github-rate.json");
}

function asLimit(v: unknown): Limit | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const [limit, remaining, reset] = [o.limit, o.remaining, o.reset];
  return typeof limit === "number" && typeof remaining === "number" && typeof reset === "number" ? { limit, remaining, reset } : null;
}

function keptLimit(t: number): Limit | null {
  try {
    const e = JSON.parse(readFileSync(limitFile(), "utf8")) as { at?: unknown; core?: unknown };
    const age = typeof e.at === "number" ? t - e.at : -1;
    return age >= 0 && age < LIMIT_FRESH_SECONDS ? asLimit(e.core) : null;
  } catch {
    return null;
  }
}

function keepLimit(core: Limit, t: number): void {
  const path = limitFile();
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(tmp, pyDumps({ at: t, core }));
    renameSync(tmp, path);
  } catch {
    // the next read asks GitHub again
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** The core limit now: from the shared file while it is fresh, else `gh api rate_limit`. Null when it can't be read. */
export function limitStatus(): Limit | null {
  const t = clockNow();
  const hit = keptLimit(t);
  if (hit) return hit;
  const p = run(["gh", "api", "rate_limit"], { timeoutMs: 30_000 });
  if (p.code !== 0) return null;
  let core: Limit | null;
  try {
    core = asLimit((JSON.parse(p.stdout) as { resources?: { core?: unknown } }).resources?.core);
  } catch {
    return null;
  }
  if (core) keepLimit(core, t);
  return core;
}

/** Minutes to wait before the Nth busy pass in a row tries again: 1, 2, 4, 8, then 15. */
export function backoff(attempt: number): number {
  return Math.min(2 ** Math.max(attempt - 1, 0), MAX_BACKOFF_MINUTES);
}

/** [the line to print, seconds to wait] after the Nth busy pass in a row. */
export function limitPlan(attempt: number, core: Limit | null, t: number): [string, number] {
  if (core && core.remaining <= 0 && core.reset > t) {
    return [`GitHub limit reached; waiting until ${isoUtc(core.reset).slice(11, 16)} UTC`, Math.ceil(core.reset - t) + 5];
  }
  const m = backoff(attempt);
  return [`GitHub did not answer; trying again in ${m} min`, m * 60];
}

/** The minutes an idle loop waits, and a note when it waits longer because the limit runs low. */
export function idleMinutes(cfg: Config, minutes: number, core: Limit | null): [number, string | null] {
  const floor = reserve(cfg);
  if (!core || floor <= 0 || core.remaining >= floor) return [minutes, null];
  return [minutes * 2, `GitHub has ${core.remaining} of ${core.limit} calls left this hour (below github.reserve, ${floor}); ` +
    `waiting ${minutes * 2} min instead of ${minutes}.`];
}

const USAGE = "usage: factory_views_cache.ts {limit-wait --attempt N [--name AGENT] | limit-idle MINUTES}";

export function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  if (cmd === "limit-wait") {
    const a = parseArgs(rest, { valued: ["--attempt", "--name"] }, "factory_views_cache.ts limit-wait", USAGE);
    const attempt = Math.max(Math.trunc(toFloat(a.attempt ?? "1") ?? 1), 1);
    const [line, seconds] = limitPlan(attempt, limitStatus(), clockNow());
    console.log((a.name ? `[${a.name}] ` : "") + line);
    if (!(process.env.FACTORY_NOW ?? "").trim()) sleepSync(seconds);
    return 0;
  }
  if (cmd === "limit-idle") {
    const minutes = toFloat(rest[0] ?? "");
    if (minutes === null) die(USAGE);
    const [wait, note] = idleMinutes(load(), minutes, limitStatus());
    if (note) process.stderr.write(note + "\n");
    console.log(String(wait));
    return 0;
  }
  die(USAGE);
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
