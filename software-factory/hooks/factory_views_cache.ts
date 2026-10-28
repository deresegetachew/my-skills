// One cache for the GitHub views (#305): `factory prs`, `factory watch` and `factory messages ls` answer from it while
// it is fresh, so a view opens without waiting on GitHub, like `factory agents ls`.
//
// Each view and its arguments has one file, `views/<view>-<hash>.json` in this machine's state folder
// (factory_machine.ts), written to a temp file and renamed, so a reader never sees half of one. An entry is fresh for
// `views.cacheSeconds` (default 45; 0 turns the cache off). A fresh answer says how old it is; from half that age it
// also starts one refresh in the background (`<view> ... --fresh`), so the next open is fresh too. A `wx` lock next to
// the entry lets only one of several views opened at once start it. `--fresh` reads GitHub now. A file that can't be
// read, or that an older release wrote, counts as missing. Only the command line uses it: the orchestrator and the
// other modules that import a view's `collect` read GitHub as before.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { now as clockNow } from "./factory_clock.ts";
import { type Config, toFloat } from "./factory_config.ts";
import { stateDir } from "./factory_machine.ts";
import { git, pyDumps } from "./factory_lib.ts";

export const SCHEMA = 1;
export const DEFAULT_SECONDS = 45;
const LOCK_SECONDS = 180; // a refresh that started this recently is still running (or died): don't start another

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
    rmSync(`${path}.lock`, { force: true }); // a background refresh is done
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
      { detached: true, stdio: "ignore", cwd: process.cwd() }).unref();
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
  const data = read();
  if (seconds > 0 && keep(data)) writeEntry(view, path, data, now);
  else if (fresh) rmSync(`${path}.lock`, { force: true });
  return { data, age: null };
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
