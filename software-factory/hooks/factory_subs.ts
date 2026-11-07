// The dev manager's one-item sub-managers on this clone, for the commands that look at them from outside (#585): the
// heartbeat (`factory agents ls`, the web UI), `factory owner stop` and the orchestrator itself.
//
// The orchestrator keeps, in `<git-common-dir>/factory-manager/<manager>.d/`:
//   <item>.pid      the process that runs the sub-manager (the `sub` process, or the cycle itself under `loop -i`);
//                   its mtime is when the sub-manager started
//   <item>.claude   the pid of the Claude session it started (not for one in its own tmux window: that window is
//                   its session, `<repo>-<manager>-<item>`)
//   <item>.turn     touched by the Stop hook (factory_stop.ts) each time that session ends a turn
// A sub-manager is shown and stopped by the name `<manager>-<item>`. A pid in these files counts only while its process
// started before the file was written, and a `.claude` one only while it is a Claude session: after a crash the OS may
// give the number to another program, which is never signalled.
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { run } from "./factory_lib.ts";

export interface Sub {
  manager: string;
  item: string;
  /** The process that runs it, alive. */
  pid: number;
  /** Its Claude session's pid when that is alive, else null. */
  claude: number | null;
  /** When it started, seconds since 1970. */
  started: number;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Seconds in a `ps` etime, `[[dd-]hh:]mm:ss`; null when it isn't one. */
export function etimeSeconds(text: string): number | null {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (!m) return null;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

/** What `ps` says of a live pid: its command line and when it started (seconds since 1970); null when it can't tell. */
export function procOf(pid: number): { args: string; started: number } | null {
  const p = run(["ps", "-p", String(pid), "-o", "etime=,args="], { timeoutMs: 15_000 });
  const m = /^\s*(\S+)\s+(.*)$/.exec(p.stdout.split("\n").find((l) => l.trim()) ?? "");
  const secs = m ? etimeSeconds(m[1] as string) : null;
  return m && secs !== null ? { args: (m[2] as string).trim(), started: Date.now() / 1000 - secs } : null;
}

/** Whether a command line is a Claude session: one of its first words is a program named `claude` (the binary, or the
 *  script a wrapper runs), or Claude Code's package. */
export function isClaude(args: string): boolean {
  return args.split(/\s+/).slice(0, 3).some((w) => /(^|\/)claude$/.test(w) || w.includes("@anthropic-ai/claude-code"));
}

/** The pid in file `file` when that process is alive and started no later than the file was written (a pid the OS gave
 *  to a newer process after the run that wrote it ended does not count), and passes `is` on its command line; else null. */
export function livePid(file: string, is: (args: string) => boolean = () => true): number | null {
  try {
    const text = readFileSync(file, "utf8").trim();
    if (!/^\d+$/.test(text)) return null;
    const pid = Number(text);
    if (pid <= 1 || !alive(pid)) return null;
    const proc = procOf(pid);
    if (!proc) return null; // no ps, or it ended meanwhile: never trust a pid we can't check
    const written = statSync(file).mtimeMs / 1000;
    return proc.started <= written + 2 && is(proc.args) ? pid : null; // ps's start time is to the second
  } catch {
    return null;
  }
}

/** The live sub-managers under `base` (the `factory-manager` folder), by name `<manager>-<item>`. A sub-manager's
 *  `claude` is set only when its `.claude` file names a live Claude session that started before the file was written. */
export function liveSubs(base: string): Map<string, Sub> {
  const out = new Map<string, Sub>();
  for (const { manager, item, dir } of subFiles(base)) {
    const path = join(dir, `${item}.pid`);
    const pid = livePid(path);
    if (pid === null) continue;
    let started = 0;
    try {
      started = statSync(path).mtimeMs / 1000;
    } catch {
      continue; // it ended between the listing and the look
    }
    out.set(`${manager}-${item}`, { manager, item, pid, claude: livePid(join(dir, `${item}.claude`), isClaude), started });
  }
  return out;
}

/** Every sub-manager that has a `.pid` or `.claude` file under `base`, live or left behind. */
export function subFiles(base: string): { manager: string; item: string; dir: string }[] {
  const out: { manager: string; item: string; dir: string }[] = [];
  let folders: string[];
  try {
    folders = readdirSync(base).filter((f) => f.endsWith(".d"));
  } catch {
    return out; // no dev manager has run here
  }
  for (const folder of folders) {
    const dir = join(base, folder);
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    const items = new Set(files.filter((f) => f.endsWith(".pid") || f.endsWith(".claude")).map((f) => f.replace(/\.(pid|claude)$/, "")));
    for (const item of [...items].sort()) out.push({ manager: folder.slice(0, -2), item, dir });
  }
  return out;
}

/** Removes the `.pid` and `.claude` files of sub-manager `name` that no live run vouches for; what it removed. */
export function dropStale(base: string, name: string): string[] {
  const live = liveSubs(base).get(name);
  const gone: string[] = [];
  for (const { manager, item, dir } of subFiles(base)) {
    if (`${manager}-${item}` !== name) continue;
    for (const ext of live ? (live.claude === null ? [".claude"] : []) : [".pid", ".claude"]) {
      const f = join(dir, `${item}${ext}`);
      try {
        rmSync(f);
        gone.push(f);
      } catch {
        // not there
      }
    }
  }
  return gone;
}

/** The pids below `pid`, deepest last, from `ps`; empty without ps. */
export function below(pid: number): number[] {
  const p = run(["ps", "-eo", "pid=,ppid="], { timeoutMs: 15_000 });
  const kids = new Map<number, number[]>();
  for (const line of p.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)/.exec(line);
    if (!m) continue;
    const parent = Number(m[2]);
    if (!kids.has(parent)) kids.set(parent, []);
    (kids.get(parent) as number[]).push(Number(m[1]));
  }
  const out: number[] = [];
  const queue = [pid];
  while (queue.length) {
    for (const k of kids.get(queue.shift() as number) ?? []) {
      if (out.includes(k) || k === pid) continue;
      out.push(k);
      queue.push(k);
    }
  }
  return out;
}

export function signalAll(pids: number[], sig: NodeJS.Signals): void {
  for (const p of pids) {
    try {
      process.kill(p, sig);
    } catch {
      // ended meanwhile
    }
  }
}

/** Ends `pid` and everything below it: SIGTERM, then SIGKILL for what is still there after `graceMs`. */
export function endTree(pid: number, graceMs = 5000): void {
  const all = [pid, ...below(pid)];
  signalAll(all, "SIGTERM");
  const until = Date.now() + graceMs;
  while (Date.now() < until && all.some(alive)) Bun.sleepSync(100);
  signalAll(all.filter(alive), "SIGKILL");
}
