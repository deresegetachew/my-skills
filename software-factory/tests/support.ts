// Shared helpers for the factory's Bun tests. Not a test file.
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const SF = resolve(import.meta.dir, "..");
export const ROOT = resolve(SF, "..");
export const HOOKS = join(SF, "hooks");
export const CI = join(SF, "ci");
export const KIT = join(SF, "kit");
export const WIKI = join(SF, "docs", "wiki");
export const TOOLS = join(ROOT, "tools");

export interface Proc {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout and stderr together, stdout first. */
  out: string;
}

export interface ProcOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  input?: string;
  timeoutMs?: number;
}

function cleanEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}

/** Run a command and wait (subprocess.run with capture_output=True, text=True). */
export function sh(cmd: string[], opts: ProcOptions = {}): Proc {
  const p = Bun.spawnSync(cmd, {
    cwd: opts.cwd,
    env: cleanEnv(opts.env ?? process.env),
    stdin: opts.input !== undefined ? new TextEncoder().encode(opts.input) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: opts.timeoutMs ?? 120_000,
  });
  const stdout = p.stdout.toString();
  const stderr = p.stderr.toString();
  return { code: p.exitCode ?? 124, stdout, stderr, out: stdout + stderr };
}

/** The bun that runs these tests, with .env loading off (a project's .env must never change a hook). */
export const BUN = [process.execPath, "--no-env-file"];

/** Run a Bun script (a path) with arguments. */
export function runBun(script: string, args: string[] = [], opts: ProcOptions = {}): Proc {
  return sh([...BUN, script, ...args], opts);
}

/** The command that runs a factory script given without its extension (the .ts, with Bun). */
export function scriptCmd(pathNoExt: string): string[] {
  return [...BUN, pathNoExt.replace(/\.ts$/, "") + ".ts"];
}

/** Run hooks/<name>.ts with arguments. */
export function runHook(name: string, args: string[] = [], opts: ProcOptions = {}): Proc {
  return sh([...scriptCmd(join(HOOKS, name)), ...args], opts);
}

/** Evaluate TypeScript code in a fresh process (the port of `python3 -c "..."` in tests). */
export function runCode(code: string, opts: ProcOptions = {}): Proc {
  return sh([...BUN, "-e", code], opts);
}

/** A new empty folder under TMPDIR (removed with the run's scratch folder by tools/run_tests.ts). */
export function tmp(prefix = "factory-test-"): string {
  return mkdtempSync(join(process.env.TMPDIR || tmpdir(), prefix));
}

/** Write a file (making its folder) and return its path. */
export function write(path: string, text: string, mode?: number): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  if (mode !== undefined) chmodSync(path, mode);
  return path;
}

/** Write an executable script. */
export function writeExe(path: string, text: string): string {
  return write(path, text, 0o755);
}

export function read(path: string): string {
  return readFileSync(path, "utf8");
}

export function readJson<T = Record<string, unknown>>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** `git -C dir <args>`; throws with the output when it fails. */
export function git(dir: string, ...args: string[]): string {
  const p = sh(["git", "-C", dir, ...args]);
  if (p.code !== 0) throw new Error(`git ${args.join(" ")} failed (${p.code}): ${p.out}`);
  return p.stdout;
}

/** A new git repo with one commit on `main` and a user set. */
export function gitRepo(dir: string = tmp()): string {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}

/** The environment with `bin` first on PATH (for fake programs), plus extra variables. */
export function envWith(bin: string | null, extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const path = bin ? `${bin}:${process.env.PATH ?? ""}` : process.env.PATH;
  return { ...process.env, PATH: path, ...extra };
}

/** The README and every wiki page as one text; with a page name such as "settings.md", only that page. (#242: tests
 * that look for a phrase in the documentation read it through here, so they do not care which page holds it.) */
export function readmeAndWiki(page?: string): string {
  if (page) return readFileSync(join(WIKI, page), "utf8");
  const pages = readdirSync(WIKI).filter((f) => f.endsWith(".md")).sort();
  return [join(SF, "README.md"), ...pages.map((p) => join(WIKI, p))].map((p) => readFileSync(p, "utf8")).join("\n");
}
