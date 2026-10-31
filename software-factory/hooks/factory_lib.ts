// Shared helpers for the factory's Bun scripts: processes, errors, JSON, small Python-like utilities.
// Bun built-ins and node:* modules only; no npm package.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { dlopen, FFIType } from "bun:ffi";

/** The factory's rules for its agents (deny list, PR gate and the other hooks), in a project (#258). Claude Code never
 * loads it by itself: factory-loop.sh and `factory agent` pass it with `claude --settings` (factory_agent_settings.ts),
 * so the owner's own sessions in the project are not governed by it. */
export const AGENT_SETTINGS = ".claude/factory/settings.json";
/** Where releases before #258 put those rules. Claude Code loads it in every session in the folder. */
export const LEGACY_SETTINGS = ".claude/settings.json";

/** A stop with a message (like Python's `raise SystemExit("text")`) or a bare exit code (`SystemExit(2)`).
 * Thrown, not exited, so a caller (or a test) can catch it; `runMain` prints the message and exits. A message exits 1
 * unless `code` says otherwise. */
export class Exit extends Error {
  readonly exitCode: number;
  readonly text: string | null;
  constructor(what: string | number | null = 1, code = 1) {
    super(typeof what === "string" ? what : `exit ${what ?? 0}`);
    this.text = typeof what === "string" ? what : null;
    this.exitCode = typeof what === "string" ? code : (what ?? 0);
  }
}

/** The exit code of a command whose GitHub call met the API limit or the network, not a fault (#347): the loops wait
 * for GitHub (factory_views_cache.ts limit-wait) instead of counting a failed pass. */
export const GITHUB_BUSY = 4;

const BUSY = /API rate limit exceeded|secondary rate limit|HTTP 429|TLS handshake timeout|connection reset by peer|i\/o timeout|HTTP 50[234]\b/i;

/** True when `gh`'s answer says GitHub was busy (a rate limit, a timeout, a 502/503/504) rather than that the call is wrong. */
export function githubBusy(text: string): boolean {
  return BUSY.test(text);
}

/** An error a person can act on: printed as JSON {code, message, fix} on stderr, exit 1. */
export class FactoryError extends Error {
  readonly code: string;
  readonly fix: string;
  constructor(code: string, message: string, fix: string) {
    super(message);
    this.code = code;
    this.fix = fix;
  }
  toJSON(): { code: string; message: string; fix: string } {
    return { code: this.code, message: this.message, fix: this.fix };
  }
}

/** Stop with a message on stderr and exit code 1 (or a bare exit code). */
export function die(what: string | number = 1): never {
  throw new Exit(what);
}

/** Stop with a {code, message, fix} error. */
export function fail(code: string, message: string, fix: string): never {
  throw new FactoryError(code, message, fix);
}

/** Run a script's main function: an Exit prints its text and exits with its code, a FactoryError prints its JSON,
 * anything else prints the stack and exits 1. The returned number (if any) is the exit code.
 *
 * It sets process.exitCode and lets the process end by itself rather than calling process.exit: with stdout a pipe,
 * process.exit drops whatever is still queued past the first 64 KB (a long `factory rereview prompt` lost its end).
 * So nothing may run after it: call it last, and leave no timer or child running. */
export async function runMain(fn: () => unknown): Promise<void> {
  let code = 0;
  try {
    const r = await fn();
    if (typeof r === "number") code = r;
  } catch (e) {
    code = reportError(e);
  }
  process.exitCode = code;
}

export function reportError(e: unknown): number {
  if (e instanceof Exit) {
    if (e.text !== null) process.stderr.write(e.text.endsWith("\n") ? e.text : e.text + "\n");
    return e.exitCode;
  }
  if (e instanceof FactoryError) {
    process.stderr.write(JSON.stringify(e.toJSON()) + "\n");
    return 1;
  }
  process.stderr.write((e instanceof Error ? (e.stack ?? e.message) : String(e)) + "\n");
  return 1;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  input?: string;
  timeoutMs?: number;
  /** Let the child use this process's stdin/stdout/stderr (output is then not captured). */
  inherit?: boolean;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function cleanEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}

/** Run a command and wait for it (Python's subprocess.run with capture_output=True, text=True).
 * A missing program gives code 127 and the error in stderr instead of throwing. */
export function run(cmd: string[], opts: RunOptions = {}): RunResult {
  if (cmd[0] === "gh") countGithubCall(cmd.slice(1), opts.cwd);
  try {
    const p = Bun.spawnSync(cmd, {
      cwd: opts.cwd,
      env: cleanEnv(opts.env ?? process.env),
      stdin: opts.input !== undefined ? new TextEncoder().encode(opts.input) : opts.inherit ? "inherit" : "ignore",
      stdout: opts.inherit ? "inherit" : "pipe",
      stderr: opts.inherit ? "inherit" : "pipe",
      timeout: opts.timeoutMs,
    });
    const timedOut = Boolean(opts.timeoutMs) && p.exitCode === null;
    return {
      code: p.exitCode ?? (timedOut ? 124 : 1),
      stdout: p.stdout ? p.stdout.toString() : "",
      stderr: p.stderr ? p.stderr.toString() : "",
      timedOut,
    };
  } catch (e) {
    return { code: 127, stdout: "", stderr: e instanceof Error ? e.message : String(e), timedOut: false };
  }
}

/** Is this program on the PATH? (shutil.which) */
export function which(program: string): string | null {
  return Bun.which(program, { PATH: process.env.PATH ?? "" });
}

/** `gh <args>`; returns the result, never throws. */
export function gh(args: string[], opts: RunOptions = {}): RunResult {
  return run(["gh", ...args], opts);
}

/** `git <args>`; returns the result, never throws. */
export function git(args: string[], opts: RunOptions = {}): RunResult {
  return run(["git", ...args], opts);
}

// The factory's own GitHub calls, counted on this machine (#371), so `factory usage --github` can say which agent and
// which command spend the 5,000 calls an hour every agent on the owner's account shares. run() counts every `gh` it
// starts: one line in an hour file of the project's state folder (factory_machine.ts stateDir, rebuilt here because
// that module imports this one), `<state>/<project>-factory/github-calls/<YYYY-MM-DDTHH>.log` (UTC):
//
//   <seconds since 1970> TAB <agent or -> TAB <command> TAB <endpoint>
//
// <command> is the factory script and its first word (`factory_issues show`); <endpoint> is what was asked, without the
// repo and the numbers (`issues/:n/comments`, `POST issues/:n/comments`, `pr view`). `gh auth ...` and `gh api
// rate_limit` are not counted: GitHub does not count them. A `--paginate` call counts once, whatever its pages; `gh`
// that an agent runs in its own shell is not seen (GitHub's own count, which `factory usage --github` shows next to
// it, has both). A line is appended in one write, so loops writing at once don't mix lines. Starting a new hour file
// removes the ones older than two days. Counting never fails or stops the call.
export const GITHUB_CALLS_DIR = "github-calls";
const KEEP_HOURS = 48;
/** gh flags that take a value, so the value is not taken for the endpoint. */
const GH_VALUED = new Set(["-X", "--method", "-H", "--header", "-f", "--raw-field", "-F", "--field", "-q", "--jq", "-t",
  "--template", "--input", "--hostname", "--cache", "-R", "--repo"]);
const callsDirs = new Map<string, string>();

/** The hour file's name for a time in seconds: `2026-10-31T07.log`. */
export function hourFile(t: number): string {
  return `${new Date(t * 1000).toISOString().slice(0, 13)}.log`;
}

/** The time in seconds (FACTORY_NOW in tests, as factory_clock.ts, which imports this module). */
function clockSeconds(): number {
  const given = Number((process.env.FACTORY_NOW ?? "").trim() || NaN);
  return Number.isFinite(given) ? given : Date.now() / 1000;
}

/** What a gh call asks for, without the repo and the numbers; null for a call GitHub does not count. */
export function githubEndpoint(args: string[]): string | null {
  const words: string[] = [];
  let method = "GET";
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (GH_VALUED.has(a)) {
      if (a === "-X" || a === "--method") method = (args[i + 1] ?? "GET").toUpperCase();
      i++;
    } else if (a.startsWith("--method=")) method = a.slice(9).toUpperCase();
    else if (!a.startsWith("-")) words.push(a);
  }
  const [sub, target] = words;
  if (!sub || sub === "auth" || sub === "help" || sub === "version") return null;
  if (sub !== "api") return words.slice(0, 2).join(" ");
  const path = (target ?? "").split("?")[0]?.replace(/^\/+/, "").replace(/^repos\/[^/]+\/[^/]+\/?/, "") ?? "";
  if (path === "rate_limit") return null;
  const shape = path.split("/").map((p) => (/^\d+$/.test(p) ? ":n" : /^[0-9a-f]{40}$/.test(p) ? ":sha" : p)).join("/");
  return (method === "GET" ? "" : `${method} `) + (shape || "(none)");
}

/** `<state>/<project>-factory/github-calls` for the project `cwd` is in, worked out once per folder. */
function githubCallsDir(cwd: string): string {
  let dir = callsDirs.get(cwd);
  if (dir === undefined) {
    const p = run(["git", "rev-parse", "--git-common-dir"], { cwd });
    const common = resolve(cwd, p.code === 0 && p.stdout.trim() ? p.stdout.trim() : ".git");
    const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
    dir = join(base, `${basename(dirname(common))}-factory`, GITHUB_CALLS_DIR);
    callsDirs.set(cwd, dir);
  }
  return dir;
}

/** The running factory script and its first word: `factory_issues show`. */
function commandName(): string {
  const script = basename(process.argv[1] ?? "?").replace(/\.ts$/, "");
  const first = process.argv[2] ?? "";
  return /^[a-z][a-z-]*$/.test(first) ? `${script} ${first}` : script;
}

/** Count one `gh <args>` this process is about to run (in `cwd`). Never throws. */
function countGithubCall(args: string[], cwd: string = process.cwd()): void {
  const endpoint = githubEndpoint(args);
  if (endpoint === null) return;
  try {
    const t = clockSeconds();
    const dir = githubCallsDir(cwd);
    const file = join(dir, hourFile(t));
    const fresh = !existsSync(file);
    mkdirSync(dir, { recursive: true });
    const line = [String(Math.floor(t)), process.env.FACTORY_AGENT || "-", commandName(), endpoint]
      .map((s) => s.replace(/[\t\n]/g, " ")).join("\t") + "\n";
    appendFileSync(file, line);
    if (!fresh) return;
    const oldest = hourFile(t - KEEP_HOURS * 3600);
    for (const f of readdirSync(dir)) if (f.endsWith(".log") && f < oldest) rmSync(join(dir, f), { force: true });
  } catch {
    // counting is a measurement: a full disk or a read-only home must not stop the call
  }
}

/** The JSON in a file, or `fallback` when it is missing or not valid JSON. */
export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** The text of a file, or `fallback` when it cannot be read. */
export function readText(path: string, fallback = ""): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return fallback;
  }
}

/** Write a file whole: to a temp file next to it, then renamed over it, so a reader never sees half of it. */
export function writeAtomic(path: string, text: string, mode?: number): void {
  mkdirSync(dirname(path) || ".", { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, mode !== undefined ? { mode } : undefined);
  renameSync(tmp, path);
}

export function exists(path: string): boolean {
  return existsSync(path);
}

/** JSON text the way Python's json.dumps writes it: ", " and ": " between items (or `indent`), non-ASCII escaped
 * unless `ensureAscii` is false. Use it where a file or an output line must stay the same as before the port. */
export function pyDumps(value: unknown, opts: { indent?: number | string; sortKeys?: boolean; ensureAscii?: boolean } = {}): string {
  const ascii = opts.ensureAscii ?? true;
  // `indent` as in Python: a number of spaces, or the string to indent with (a tab).
  const unit = typeof opts.indent === "string" ? opts.indent : " ".repeat(opts.indent ?? 0);
  const str = (s: string): string => {
    const j = JSON.stringify(s);
    return ascii ? j.replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")) : j;
  };
  const enc = (v: unknown, level: number): string => {
    if (v === null || v === undefined) return "null";
    if (typeof v === "string") return str(v);
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") return Number.isFinite(v) ? String(v) : v > 0 ? "Infinity" : Number.isNaN(v) ? "NaN" : "-Infinity";
    const pad = opts.indent !== undefined ? "\n" + unit.repeat(level + 1) : "";
    const end = opts.indent !== undefined ? "\n" + unit.repeat(level) : "";
    const sep = opts.indent !== undefined ? "," : ", ";
    if (Array.isArray(v)) {
      if (!v.length) return "[]";
      return "[" + pad + v.map((x) => enc(x, level + 1)).join(sep + pad) + end + "]";
    }
    if (typeof v === "object") {
      let keys = Object.keys(v as object).filter((k) => (v as Record<string, unknown>)[k] !== undefined);
      if (opts.sortKeys) keys = keys.sort();
      if (!keys.length) return "{}";
      return "{" + pad + keys.map((k) => str(k) + ": " + enc((v as Record<string, unknown>)[k], level + 1)).join(sep + pad) + end + "}";
    }
    return "null";
  };
  return enc(value, 0);
}

/** Python's str.splitlines() for the common cases: no trailing empty line. */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Python's fnmatch.fnmatch (case-sensitive, as on POSIX): * and ? match anything including "/", [...] classes. */
export function fnmatch(name: string, pattern: string): boolean {
  let rx = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === "*") rx += ".*";
    else if (c === "?") rx += ".";
    else if (c === "[") {
      const j = pattern.indexOf("]", i + 2);
      if (j < 0) rx += "\\[";
      else {
        let body = pattern.slice(i + 1, j).replace(/\\/g, "\\\\");
        if (body.startsWith("!")) body = "^" + body.slice(1);
        rx += "[" + body + "]";
        i = j;
      }
    } else rx += c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  return new RegExp("^(?:" + rx + ")$", "s").test(name);
}

/** Seconds since the epoch, as a float (time.time()). */
export function now(): number {
  return Date.now() / 1000;
}

/** Sleep (time.sleep) without busy-waiting. */
export function sleepSync(seconds: number): void {
  if (seconds > 0) Bun.sleepSync(seconds * 1000);
}

/** An ISO-8601 UTC time without milliseconds, ending in Z (as GitHub writes them). */
export function isoUtc(seconds: number = now()): string {
  return new Date(Math.floor(seconds) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Seconds since the epoch for an ISO-8601 time ("2026-10-25T10:00:00Z" or with an offset); null when unreadable. */
export function parseIso(text: string | null | undefined): number | null {
  if (!text) return null;
  const t = Date.parse(text);
  return Number.isNaN(t) ? null : t / 1000;
}

/** A Python-style repr of a string ('text'), for messages that quoted values with !r. */
export function pyRepr(s: string): string {
  return s.includes("'") && !s.includes('"') ? `"${s}"` : `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** The shell-safe form of a word (shlex.quote). */
export function shQuote(s: string): string {
  if (s === "") return "''";
  return /^[\w@%+=:,./-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\"'\"'") + "'";
}

/** Split a command line like a POSIX shell would (shlex.split): quotes and backslashes, no expansion. */
export function shSplit(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let q: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (q === "'") {
      if (c === "'") q = null;
      else cur += c;
    } else if (q === '"') {
      if (c === '"') q = null;
      else if (c === "\\" && i + 1 < line.length && '\\"$`\n'.includes(line[i + 1] as string)) cur += line[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      q = c;
      has = true;
    } else if (c === "\\" && i + 1 < line.length) {
      cur += line[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else cur += c;
  }
  if (q) throw new Error("No closing quotation");
  if (has || cur) out.push(cur);
  return out;
}

/** The command that runs a factory script with this Bun (Python's [sys.executable, script]): .env loading off. */
export function bunCmd(script: string): string[] {
  return [process.execPath, "--no-env-file", "--config=/dev/null", script];
}

// flock(2) through bun:ffi (Bun built-in), for the lock files Python took with fcntl.flock. The lock belongs to the
// open file: it goes when the file is closed or the process ends.
const LOCK_EX = 2;
const LOCK_NB = 4;
type FlockFn = (fd: number, op: number) => number;
let flockFn: FlockFn | null = null;
function libcFlock(): FlockFn {
  if (!flockFn) {
    // glibc, then musl (Alpine) by its usual names, then macOS.
    const names = process.platform === "darwin" ? ["libSystem.B.dylib"]
      : ["libc.so.6", `libc.musl-${process.arch === "arm64" ? "aarch64" : "x86_64"}.so.1`, "libc.so"];
    let last: unknown = null;
    for (const name of names) {
      try {
        const lib = dlopen(name, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
        flockFn = (fd, op) => lib.symbols.flock(fd, op) as number;
        break;
      } catch (e) {
        last = e;
      }
    }
    if (!flockFn) {
      throw new FactoryError("no_flock", `cannot load flock(2) from the C library (${names.join(", ")}): ${String(last)}`,
        "run the factory on Linux (glibc or musl) or macOS; tell the owner which system this is.");
    }
  }
  return flockFn;
}

/** Take an exclusive lock on an open file descriptor. `wait` false: return false at once when another holds it. */
export function flock(fd: number, wait = true): boolean {
  return libcFlock()(fd, wait ? LOCK_EX : LOCK_EX | LOCK_NB) === 0;
}

/** Python's plistlib.dumps (XML, keys sorted) for the plain values a LaunchAgent needs: strings, numbers, booleans,
 * lists and dictionaries. */
export function plistDumps(value: unknown): string {
  const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const enc = (v: unknown, level: number): string[] => {
    const pad = "\t".repeat(level);
    if (typeof v === "boolean") return [pad + (v ? "<true/>" : "<false/>")];
    if (typeof v === "number") return [pad + (Number.isInteger(v) ? `<integer>${v}</integer>` : `<real>${v}</real>`)];
    if (typeof v === "string") return [pad + `<string>${esc(v)}</string>`];
    if (Array.isArray(v)) return v.length ? [pad + "<array>", ...v.flatMap((x) => enc(x, level + 1)), pad + "</array>"] : [pad + "<array/>"];
    if (v && typeof v === "object") {
      const keys = Object.keys(v).sort();
      if (!keys.length) return [pad + "<dict/>"];
      return [pad + "<dict>", ...keys.flatMap((k) => [pad + `\t<key>${esc(k)}</key>`, ...enc((v as Record<string, unknown>)[k], level + 1)]), pad + "</dict>"];
    }
    throw new Error(`plist: unsupported value ${String(v)}`);
  };
  return ['<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">', ...enc(value, 0), "</plist>", ""].join("\n");
}

export type ParsedArgs = Record<string, string | boolean | string[] | undefined>;

/** What one subcommand (or a whole script) takes, for `parseArgs`: argparse's add_argument in short.
 * `valued`: options that take a value (`--agent X` or `--agent=X`); `flags`: store_true options; `multi`: options
 * that may repeat (action="append"); `positionals`: names in order, a trailing `?` makes one optional;
 * `required`: options that must be given. Values are keyed by the option without its dashes. */
export interface ArgSpec {
  valued?: string[];
  flags?: string[];
  multi?: string[];
  positionals?: string[];
  required?: string[];
}

/** A small argparse: on a mistake it prints `usage` and `<prog>: error: ...` on stderr and exits 2, as argparse did. */
export function parseArgs(args: string[], spec: ArgSpec, prog: string, usage: string): ParsedArgs {
  const fail2 = (text: string): never => {
    process.stderr.write(`${usage}\n${prog}: error: ${text}\n`);
    throw new Exit(2);
  };
  const valued = [...(spec.valued ?? []), ...(spec.multi ?? [])];
  const out: ParsedArgs = {};
  for (const m of spec.multi ?? []) out[m.replace(/^-+/, "")] = [];
  const pos: string[] = [];
  let onlyPositionals = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (onlyPositionals) {
      pos.push(a);
      continue;
    }
    if (a === "--") {
      onlyPositionals = true;
      continue;
    }
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const key = eq > 0 ? a.slice(0, eq) : a;
    if (valued.includes(key)) {
      const v = eq > 0 ? a.slice(eq + 1) : args[++i];
      if (v === undefined) fail2(`argument ${key}: expected one argument`);
      const name = key.replace(/^-+/, "");
      if ((spec.multi ?? []).includes(key)) (out[name] as string[]).push(v as string);
      else out[name] = v;
    } else if ((spec.flags ?? []).includes(a)) out[a.replace(/^-+/, "")] = true;
    else if (a.startsWith("-") && a !== "-" && !/^-\d/.test(a)) fail2(`unrecognized arguments: ${a}`);
    else pos.push(a);
  }
  const names = spec.positionals ?? [];
  if (pos.length > names.length) fail2(`unrecognized arguments: ${pos.slice(names.length).join(" ")}`);
  names.forEach((p, i) => (out[p.replace(/\?$/, "")] = pos[i]));
  const missing = [...(spec.required ?? []).filter((r) => out[r.replace(/^-+/, "")] === undefined),
    ...names.filter((p) => !p.endsWith("?") && out[p] === undefined)];
  if (missing.length) fail2(`the following arguments are required: ${missing.join(", ")}`);
  return out;
}

/** Python's urllib.parse.quote(text, safe=""): every byte but letters, digits and _.-~ percent-encoded. */
export function pyQuote(text: string, safe = ""): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%([0-9A-F]{2})/g, (all, hex: string) => (safe.includes(String.fromCharCode(parseInt(hex, 16))) ? String.fromCharCode(parseInt(hex, 16)) : all));
}

/** Python's int() on a setting: a whole number from a number (truncated), a bool or a string of digits; null when
 * Python would raise (TypeError, ValueError). For `int(cfg.get("x") or 40)` style reads. */
export function pyInt(value: unknown): number | null {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value === "string" && /^\s*[+-]?\d+(_\d+)*\s*$/.test(value)) return Number(value.replace(/_/g, ""));
  return null;
}

/** Run a command line in a shell (subprocess.run(cmd, shell=True, capture_output=True, text=True)). */
export function shell(cmd: string, opts: RunOptions = {}): RunResult {
  return run(["/bin/sh", "-c", cmd], opts);
}
