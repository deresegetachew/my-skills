// Where `factory usage` finds Claude Code's session logs for this project (#571), and what a reply cost.
//
// Claude Code keeps each session's log in <its folder>/projects/<the session's folder with every character that isn't a
// letter or digit as ->/<session id>.jsonl, where <its folder> is $CLAUDE_CONFIG_DIR, else ~/.claude of the user that
// runs it. The factory's sessions run in several folders: the project folder, each agent's worktree
// (<project>-agents/<name>, since #572 the first agent's too), the dev manager's (its sub-managers run there) and any
// other worktree of the repository. So the logs are looked for:
//   - in each Claude Code projects folder: yours ($CLAUDE_CONFIG_DIR/projects, else ~/.claude/projects), the one of the
//     user that owns the project folder when that is someone else (the agents' own user on a sandbox), and each folder in
//     `usage.logFolders`;
//   - in every log folder named after the project folder (with its agents' folders, which start with the same name) or
//     after one of the repository's worktrees (`git worktree list`), the real path and the path as given both;
//   - and in any other log folder whose sessions ran inside one of those folders (a symlinked path gives the log folder
//     another name), which is found by reading the folder named in the first lines of one of its logs.
// Each reply is still checked: one whose folder is outside the project and its worktrees is not counted.
import { closeSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

export const PROJECT_FOLDER = "(project folder)";

/** Claude Code's name for a folder's logs: every character that isn't a letter or digit becomes -. */
export function slug(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, "-");
}

const reals = new Map<string, string>();

/** The real path (symlinks resolved), or the path as given when it can't be resolved (gone, or another machine's). */
export function real(path: string): string {
  let r = reals.get(path);
  if (r === undefined) {
    try {
      r = realpathSync(path);
    } catch {
      r = path;
    }
    reals.set(path, r);
  }
  return r;
}

function git(cwd: string, args: string[]): string | null {
  try {
    const p = Bun.spawnSync(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    return p.exitCode === 0 ? p.stdout.toString() : null;
  } catch {
    return null;
  }
}

/** The project and the folders its sessions run in. */
export interface Scope {
  /** The project folder: the main checkout, also when this runs in one of its worktrees. */
  top: string;
  /** The project folder and every worktree of the repository, real paths. */
  worktrees: string[];
  /** Other spellings of the project folder (through a symlink), as the shell or the caller gave them. */
  aliases: string[];
}

/** The project folder (the main checkout of the repository at `cwd`) and its worktrees; `cwd` alone outside git.
 * `given` are the project folder's paths as given (CLAUDE_PROJECT_DIR, PWD): a symlinked one is kept as an alias. */
export function scopeOf(cwd: string, given: string[] = []): Scope {
  const common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])?.trim();
  const top = real(common ? dirname(resolve(cwd, common)) : cwd);
  const listed = (git(cwd, ["worktree", "list", "--porcelain"]) ?? "").split("\n")
    .filter((l) => l.startsWith("worktree ")).map((l) => real(l.slice(9)));
  const aliases = [...new Set(given.filter((g) => g && g !== top && real(g) === top))];
  return { top, worktrees: [...new Set([top, ...listed])], aliases };
}

function inside(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder + sep);
}

function agentsOf(scope: Scope): string {
  return scope.top + "-agents";
}

/** A session folder from a log, as a real path: resolved when it is on this machine, else spelled from the project
 * folder's real path when it starts with one of its aliases. */
function normal(cwd: string, scope: Scope): string {
  const r = real(cwd);
  if (r !== cwd) return r;
  for (const a of scope.aliases) if (inside(cwd, a) || cwd.startsWith(a + "-agents" + sep)) return scope.top + cwd.slice(a.length);
  return cwd;
}

/** Whether a session folder (`cwd`, from a log) belongs to the project: its folder, an agent's, or another worktree. */
export function belongs(cwd: string, scope: Scope): boolean {
  const c = normal(cwd, scope);
  return inside(c, agentsOf(scope)) || scope.worktrees.some((w) => inside(c, w));
}

/** Who a session folder belongs to: <name> for <project>-agents/<name>, a worktree's folder name for another worktree,
 * else the project folder. */
export function workerOf(cwd: string, scope: Scope): string {
  const c = normal(cwd, scope);
  const agents = agentsOf(scope) + sep;
  if (c.startsWith(agents)) return c.slice(agents.length).split(sep)[0] || PROJECT_FOLDER;
  const w = scope.worktrees.filter((x) => inside(c, x)).sort((a, b) => b.length - a.length)[0];
  return !w || w === scope.top ? PROJECT_FOLDER : basename(w);
}

/** One Claude Code projects folder that was looked in. */
export interface Looked {
  dir: string;
  /** Why it was looked in. */
  why: string;
  /** read: it holds this project's logs; none: it holds none of them; missing: there is no such folder; unreadable. */
  state: "read" | "none" | "missing" | "unreadable";
  /** The log folders of this project in it. */
  folders: string[];
  /** Why it couldn't be read (unreadable only). */
  error?: string;
}

function expand(p: string): string {
  return p.replace(/^~(?=\/|$)/, process.env.HOME || homedir());
}

/** The home folder of a user id, from /etc/passwd (null when it has none: macOS keeps its users elsewhere). */
function homeOfUid(uid: number): [string, string] | null {
  let text: string;
  try {
    text = readFileSync("/etc/passwd", "utf8");
  } catch {
    return null;
  }
  for (const line of text.split("\n")) {
    const f = line.split(":");
    if (f.length >= 6 && Number(f[2]) === uid && f[5]) return [f[0] as string, f[5]];
  }
  return null;
}

/** The Claude Code projects folders to look in, each with why: `explicit` (the hidden --logs) or yours, the project
 * folder's owner's when that is another user, and each of `extra` (usage.logFolders). */
export function logBases(scope: Scope, extra: string[], explicit: string | null): Array<{ dir: string; why: string }> {
  const out: Array<{ dir: string; why: string }> = [];
  const add = (dir: string, why: string): void => {
    const d = resolve(expand(dir));
    if (!out.some((o) => real(o.dir) === real(d))) out.push({ dir: d, why });
  };
  if (explicit) add(explicit, "--logs");
  else if (process.env.CLAUDE_CONFIG_DIR) add(join(process.env.CLAUDE_CONFIG_DIR, "projects"), "CLAUDE_CONFIG_DIR");
  else add(join(process.env.HOME || homedir(), ".claude", "projects"), "your Claude Code folder");
  if (!explicit) {
    try {
      const uid = statSync(scope.top).uid;
      const me = typeof process.getuid === "function" ? process.getuid() : uid;
      const owner = uid !== me ? homeOfUid(uid) : null;
      if (owner) add(join(owner[1], ".claude", "projects"), `the Claude Code folder of ${owner[0]}, who owns the project folder`);
    } catch {
      // no project folder to look at: nothing more to add
    }
  }
  for (const d of extra) add(d, "usage.logFolders");
  return out;
}

/** The folder the first lines of a log name (`cwd`), or null. Reads at most 256 KB. */
function firstCwd(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(262_144);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const m = /"cwd":("(?:[^"\\]|\\.)*")/.exec(buf.subarray(0, n).toString("utf8"));
    if (!m) return null;
    const v: unknown = JSON.parse(m[1] as string);
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** This project's log folders in one Claude Code projects folder, and what was found there. */
export function findLogs(base: { dir: string; why: string }, scope: Scope): Looked {
  let names: string[];
  try {
    names = readdirSync(base.dir).sort();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "";
    if (code === "ENOENT" || code === "ENOTDIR") return { ...base, state: "missing", folders: [] };
    return { ...base, state: "unreadable", folders: [], error: code === "EACCES" || code === "EPERM" ? "permission denied" : String(e) };
  }
  const exact = new Set(scope.worktrees.map(slug));
  const prefixes = [...new Set([scope.top, ...scope.aliases].map(slug))];
  const folders: string[] = [];
  for (const n of names) {
    const d = join(base.dir, n);
    if (!isDir(d)) continue;
    if (exact.has(n) || prefixes.some((p) => n.startsWith(p))) {
      folders.push(d);
      continue;
    }
    const log = listLogs(d)[0];
    const cwd = log ? firstCwd(join(d, log)) : null;
    if (cwd && belongs(cwd, scope)) folders.push(d);
  }
  return { ...base, state: folders.length ? "read" : "none", folders };
}

/** The session logs (*.jsonl) directly in a folder. */
export function listLogs(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
}

export interface Problem {
  code: string;
  message: string;
  fix: string;
}

const STATE_TEXT: Record<Looked["state"], string> = {
  read: "read", none: "no log folder of this project", missing: "no such folder", unreadable: "can't be read",
};

/** What to tell the person about where the logs were looked for: a folder that can't be read, and no logs at all. */
export function problemsOf(looked: Looked[], scope: Scope): Problem[] {
  const out: Problem[] = [];
  const name = slug(scope.top);
  for (const l of looked.filter((x) => x.state === "unreadable")) {
    out.push({ code: "usage_logs_unreadable", message: `Can't read ${l.dir} (${l.why}): ${l.error ?? "unreadable"}, so its sessions aren't counted.`,
      fix: "Run `factory usage` as the user that runs the agents (for example `sudo -u <that user> -i`, then `factory usage` in the project folder), or let this user read that folder." });
  }
  if (!looked.some((l) => l.state === "read")) {
    out.push({ code: "usage_no_logs",
      message: `No Claude Code logs of ${scope.top} or its worktrees on this machine. Looked in ` +
        looked.map((l) => `${l.dir} (${l.why}: ${STATE_TEXT[l.state]})`).join("; ") +
        `, for folders named ${name}* or after a worktree, and for logs of sessions that ran in them.`,
      fix: "Claude Code writes the logs in the home folder of the user that runs it. Run `factory usage` as the user that runs " +
        "the agents, or name their folder: factory settings set usage.logFolders '[\"/home/<that user>/.claude/projects\"]'." });
  }
  return out;
}

// --- prices ------------------------------------------------------------------------------------------------------------

/** US dollars per million tokens. A cache write costs 1.25 x input (5-minute cache) unless cacheWrite says otherwise,
 * 2 x input for the 1-hour cache. */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite?: number;
  /** Another price for a reply whose prompt (input, cache writes and cache reads together) is over `above` tokens. */
  long?: { above: number; input: number; output: number; cacheRead: number };
}

/** When the prices below were last checked against Anthropic's price list. */
export const PRICES_AS_OF = "2026-10-06";

/** Anthropic's own API prices of the models whose four prices are known. Others (and fast mode, except on the Opus
 * models that state it as twice the price) are counted but not priced; `usage.prices` adds or corrects one. */
export const PRICES: Record<string, Price> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-mythos-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1 },
  "claude-mythos-5": { input: 10, output: 50, cacheRead: 1 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
  // Up to 100K tokens of prompt; beyond, $0.50 / $2.50. Cache reads at 0.1 x input, as on the other models.
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, long: { above: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05 } },
};

/** Fast mode is twice the price on these. */
const FAST_DOUBLE = new Set(["claude-opus-5-5", "claude-opus-5"]);

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** `usage.prices` as given: {model: {input, output, cacheRead, cacheWrite?}}; entries without the three numbers are left out. */
export function pricesFrom(given: unknown): Record<string, Price> {
  const out: Record<string, Price> = {};
  if (!isObj(given)) return out;
  for (const [m, p] of Object.entries(given)) {
    if (!isObj(p) || ![p.input, p.output, p.cacheRead].every((x) => typeof x === "number" && x >= 0)) continue;
    out[m] = { input: p.input as number, output: p.output as number, cacheRead: p.cacheRead as number,
      ...(typeof p.cacheWrite === "number" && p.cacheWrite >= 0 ? { cacheWrite: p.cacheWrite } : {}) };
  }
  return out;
}

/** The model id without a date (-20250929) or a context mark ([1m]). */
function baseModel(model: string): string {
  return model.replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "");
}

/** What one reply cost in US dollars, from its `usage`; null when its model's price isn't known. */
export function costOf(model: string, usage: Obj, extra: Record<string, Price>): number | null {
  const write = num(usage.cache_creation_input_tokens);
  const tokens = num(usage.input_tokens) + write + num(usage.cache_read_input_tokens) + num(usage.output_tokens);
  if (!tokens) return 0;
  const key = extra[model] ? model : baseModel(model);
  const p = extra[key] ?? PRICES[key];
  if (!p) return null;
  if (usage.speed !== "fast") return priced(p, usage, write);
  return !extra[key] && FAST_DOUBLE.has(key) ? priced(p, usage, write) * 2 : null; // fast mode: only where its price is known
}

function priced(price: Price, usage: Obj, write: number): number {
  const prompt = num(usage.input_tokens) + write + num(usage.cache_read_input_tokens);
  const p: Price = price.long && prompt > price.long.above ? { ...price.long } : price; // the long-prompt price writes at 1.25 x its input
  const split = isObj(usage.cache_creation) ? usage.cache_creation : {};
  const hour = Math.min(num(split.ephemeral_1h_input_tokens), write);
  const fiveMin = write - hour;
  return (num(usage.input_tokens) * p.input + fiveMin * (p.cacheWrite ?? p.input * 1.25) + hour * p.input * 2 +
    num(usage.cache_read_input_tokens) * p.cacheRead + num(usage.output_tokens) * p.output) / 1_000_000;
}
