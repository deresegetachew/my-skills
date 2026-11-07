// The dev manager's one-item sub-managers on this clone, for the commands that look at them from outside (#585): the
// heartbeat (`factory agents ls`, the web UI), `factory owner stop` and the orchestrator itself.
//
// The orchestrator keeps, in `<git-common-dir>/factory-manager/<manager>.d/`:
//   <item>.pid      the process that runs the sub-manager (the `sub` process, or the cycle itself under `loop -i`);
//                   its mtime is when the sub-manager started
//   <item>.claude   the pid of the Claude session it started (not for one in its own tmux window: that window is
//                   its session, `<repo>-<manager>-<item>`)
//   <item>.turn     touched by the Stop hook (factory_stop.ts) each time that session ends a turn
// A sub-manager is shown and stopped by the name `<manager>-<item>`.
import { readdirSync, readFileSync, statSync } from "node:fs";
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

/** The number in pid file `file` when that process is alive, else null. */
export function livePid(file: string): number | null {
  try {
    const text = readFileSync(file, "utf8").trim();
    if (!/^\d+$/.test(text)) return null;
    const pid = Number(text);
    return pid > 1 && alive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** The live sub-managers under `base` (the `factory-manager` folder), by name `<manager>-<item>`. */
export function liveSubs(base: string): Map<string, Sub> {
  const out = new Map<string, Sub>();
  let folders: string[];
  try {
    folders = readdirSync(base).filter((f) => f.endsWith(".d"));
  } catch {
    return out; // no dev manager has run here
  }
  for (const folder of folders) {
    let files: string[];
    try {
      files = readdirSync(join(base, folder)).filter((f) => f.endsWith(".pid"));
    } catch {
      continue;
    }
    for (const file of files) {
      const path = join(base, folder, file);
      const pid = livePid(path);
      if (pid === null) continue;
      const manager = folder.slice(0, -2);
      const item = file.slice(0, -4);
      let started = 0;
      try {
        started = statSync(path).mtimeMs / 1000;
      } catch {
        continue; // it ended between the listing and the look
      }
      out.set(`${manager}-${item}`, { manager, item, pid, claude: livePid(join(base, folder, `${item}.claude`)), started });
    }
  }
  return out;
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
