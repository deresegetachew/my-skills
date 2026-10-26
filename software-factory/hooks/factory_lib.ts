// Shared helpers for the factory's Bun scripts: processes, errors, JSON, small Python-like utilities.
// Bun built-ins and node:* modules only; no npm package.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** A stop with a message (like Python's `raise SystemExit("text")`) or a bare exit code (`SystemExit(2)`).
 * Thrown, not exited, so a caller (or a test) can catch it; `runMain` prints the message and exits. */
export class Exit extends Error {
  readonly exitCode: number;
  readonly text: string | null;
  constructor(what: string | number | null = 1) {
    super(typeof what === "string" ? what : `exit ${what ?? 0}`);
    this.text = typeof what === "string" ? what : null;
    this.exitCode = typeof what === "string" ? 1 : (what ?? 0);
  }
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
 * anything else prints the stack and exits 1. The returned number (if any) is the exit code. */
export async function runMain(fn: () => unknown): Promise<never> {
  let code = 0;
  try {
    const r = await fn();
    if (typeof r === "number") code = r;
  } catch (e) {
    code = reportError(e);
  }
  await flush();
  process.exit(code);
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

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => (process.stdout.write("") ? resolve() : process.stdout.once("drain", resolve)));
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
  return Bun.which(program);
}

/** `gh <args>`; returns the result, never throws. */
export function gh(args: string[], opts: RunOptions = {}): RunResult {
  return run(["gh", ...args], opts);
}

/** `git <args>`; returns the result, never throws. */
export function git(args: string[], opts: RunOptions = {}): RunResult {
  return run(["git", ...args], opts);
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
export function pyDumps(value: unknown, opts: { indent?: number; sortKeys?: boolean; ensureAscii?: boolean } = {}): string {
  const ascii = opts.ensureAscii ?? true;
  const str = (s: string): string => {
    const j = JSON.stringify(s);
    return ascii ? j.replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")) : j;
  };
  const enc = (v: unknown, level: number): string => {
    if (v === null || v === undefined) return "null";
    if (typeof v === "string") return str(v);
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") return Number.isFinite(v) ? String(v) : v > 0 ? "Infinity" : Number.isNaN(v) ? "NaN" : "-Infinity";
    const pad = opts.indent !== undefined ? "\n" + " ".repeat(opts.indent * (level + 1)) : "";
    const end = opts.indent !== undefined ? "\n" + " ".repeat(opts.indent * level) : "";
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
