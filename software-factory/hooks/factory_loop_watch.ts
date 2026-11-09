#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// What factory-loop.sh needs to run unattended (#640): it says why it could not start, and, in an interactive (`-i`)
// session, it moves on to the next task by itself.
//
//   factory_loop_watch.ts down --agent A --code C [--role R] [--dir D] [--main M] [--exit N] [--since T]
//       the loop stops at start: writes why (factory_claims.ts writeDown, `<git-common-dir>/factory/down-<A>.json`) and
//       prints one line saying so, with the fix. The heartbeat shows it as `down: <message>`, and the web UI's Needs
//       attention offers the fix. Codes: dirty_worktree (leftover changes in its folder D: `git status --short` goes
//       along), checkout_failed (its folder can't be brought to origin/M), exited (it stopped with exit N before its
//       first session; with --since T only when no reason was written since T)
//   factory_loop_watch.ts up --agent A
//       the loop got going: the reason goes
//   factory_loop_watch.ts watch --agent A --pid P [--pane T] [--once]
//       beside an interactive coding agent's session, while the loop P runs: every FACTORY_WATCH_SECONDS (20) it looks at
//       the session's screen (tmux pane T, else the session <repo>-<A>) and types `/next-task` there when
//         - the task is done (its done mark, `factory_claims.ts done`) and the session still sits at an empty prompt a
//           minute later (FACTORY_WATCH_DONE_SECONDS, 60): the Stop hook did not close it; or
//         - it has sat at an empty prompt, holding no task, for `loop.idleNextTaskMinutes` (5; 0: never) and a task is
//           ready (`next_task.ts --no-claim`), asked at most once per that time
//       It never types into a prompt box that holds text, while Claude works, or while a question waits in its picker
//       (#644: the heartbeat reports that one). --once: one look, then exit (what it saw is kept between looks).
//
// Errors are {code, message, fix}. It writes only the reason file, its own state file (watch-<A>.json) and to that pane.
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { load, toFloat } from "./factory_config.ts";
import { now } from "./factory_clock.ts";
import { alive as claimAlive, type Claims, clearDown, doneFile, readDown, stateDir, takeDone, writeDown } from "./factory_claims.ts";
import { pickerOf, promptOf } from "./factory_heartbeat.ts";
import { sessionName } from "./factory_window.ts";
import { parseArgs, run, runMain, splitLines } from "./factory_lib.ts";
import { refuse } from "./factory_machine.ts";

const PROG = "factory_loop_watch.ts";
const NEXT = "/next-task";

// --- why a loop stopped at start ---------------------------------------------------------------------------------

/** {message, fix, lines} for a code, as the loop's line and the web UI say them. */
export function reasonOf(code: string, o: { agent: string; role: string; dir: string; main: string; exit: string }): { message: string; fix: string; lines: string[] } {
  const start = `factory owner start ${o.role} ${o.agent}`;
  if (code === "dirty_worktree") {
    const st = run(["git", "-C", o.dir, "status", "--short"]);
    const lines = splitLines(st.stdout).filter((l) => l.trim()).slice(0, 20);
    return { message: `leftover changes in its folder ${o.dir}`, lines,
      fix: `Save them aside and start (the web UI's Needs attention), or \`${start} --stash\`; or commit or remove them in ${o.dir} yourself.` };
  }
  if (code === "checkout_failed") {
    return { message: `its folder ${o.dir} could not be brought to origin/${o.main}`, lines: [],
      fix: `Run \`git -C ${o.dir} fetch origin\` to see why; if the folder is broken, remove it (\`git worktree remove ${o.dir}\`) and start it again.` };
  }
  return { message: `its loop stopped at start (exit ${o.exit || "?"})`, lines: [],
    fix: `Run \`factory ${o.role} ${o.agent} loop -i\` in a terminal to see why, then \`${start}\`.` };
}

function down(a: Record<string, unknown>): number {
  const agent = String(a.agent ?? "");
  const code = String(a.code ?? "");
  if (!["dirty_worktree", "checkout_failed", "exited"].includes(code)) {
    refuse("bad_code", `${code || "no code"} isn't a reason a loop stops at start.`, "Use dirty_worktree, checkout_failed or exited.", 2);
  }
  const since = toFloat(a.since ?? "");
  const had = readDown(agent);
  if (since !== null && had && had.at >= since) return 0; // the loop already said why
  const o = { agent, role: String(a.role ?? "coding-agent"), dir: String(a.dir ?? process.cwd()), main: String(a.main ?? "main"), exit: String(a.exit ?? "") };
  const r = reasonOf(code, o);
  writeDown(agent, { code, message: r.message, fix: r.fix, dir: o.dir, lines: r.lines, at: now() });
  console.log(`[${agent}] can't start: ${r.message}. ${r.fix}`);
  for (const l of r.lines.slice(0, 10)) console.log(`[${agent}]   ${l}`);
  return 0;
}

// --- the interactive session's watch -----------------------------------------------------------------------------

interface WatchState {
  /** Since when the session has sat at an empty prompt (seconds since 1970), or null. */
  emptySince: number | null;
  /** When it last asked whether a task is ready, or null. */
  asked: number | null;
}

function statePath(agent: string): string {
  return join(stateDir(), `watch-${agent}.json`);
}

function readState(agent: string): WatchState {
  try {
    const s = JSON.parse(readFileSync(statePath(agent), "utf8")) as Partial<WatchState>;
    return { emptySince: typeof s.emptySince === "number" ? s.emptySince : null, asked: typeof s.asked === "number" ? s.asked : null };
  } catch {
    return { emptySince: null, asked: null };
  }
}

function saveState(agent: string, s: WatchState): void {
  const p = statePath(agent);
  writeFileSync(`${p}.tmp`, JSON.stringify(s) + "\n");
  renameSync(`${p}.tmp`, p);
}

function idleMinutes(): number {
  const loop = (load() as Record<string, unknown>).loop;
  const v = typeof loop === "object" && loop !== null ? (loop as Record<string, unknown>).idleNextTaskMinutes : undefined;
  const f = toFloat(v ?? 5);
  return f === null || f < 0 ? 5 : f;
}

function seconds(name: string, dflt: number): number {
  const f = toFloat(process.env[name] ?? "");
  return f === null || f < 0 ? dflt : f;
}

/** Whether `agent` holds a live task claim on this clone. */
function holdsTask(agent: string): boolean {
  try {
    const data = JSON.parse(readFileSync(join(stateDir(), "claims.json"), "utf8")) as Partial<Claims>;
    const stale = toFloat(load().claimStaleHours ?? 6) ?? 6;
    return Object.values(data.tasks ?? {}).some((c) => c.agent === agent && claimAlive(c, stale));
  } catch {
    return false;
  }
}

/** Whether a task is ready for it: `next_task.ts --no-claim` finds one (exit 0). Nothing is claimed. */
function taskReady(): boolean {
  const p = run([process.execPath, "--no-env-file", "--config=/dev/null", join(import.meta.dir, "next_task.ts"), "--no-claim"], { timeoutMs: 120_000 });
  return p.code === 0 && p.stdout.trim() !== "";
}

function screenOf(target: string): string | null {
  const p = run(["tmux", "capture-pane", "-p", "-e", "-J", "-S", "-50", "-t", target]);
  return p.code === 0 ? p.stdout : null;
}

/** Types `text` into the session and presses Enter, only while it still sits at an empty prompt with no question open. */
function send(target: string, text: string): boolean {
  const screen = screenOf(target);
  if (screen === null || pickerOf(screen) || promptOf(screen) !== "empty") return false;
  if (run(["tmux", "send-keys", "-t", target, "-l", "--", text]).code !== 0) return false;
  return run(["tmux", "send-keys", "-t", target, "Enter"]).code === 0;
}

/** One look at the session: what it did ("picker", "busy", "waiting", "sent-done", "sent-idle"). */
export function look(agent: string, target: string): string {
  const s = readState(agent);
  const t = now();
  const screen = screenOf(target);
  const at = (what: string): string => {
    saveState(agent, s);
    return what;
  };
  if (screen === null) return at("no-screen");
  if (pickerOf(screen)) { // a question waits for the owner (#644): never type into it
    s.emptySince = null;
    return at("picker");
  }
  if (promptOf(screen) !== "empty") { // working, or text sits typed in its prompt box
    s.emptySince = null;
    return at("busy");
  }
  s.emptySince ??= t;
  const mark = doneFile(agent);
  if (existsSync(mark) && !existsSync(`${mark}.closing`)) {
    const age = t - statSync(mark).mtimeMs / 1000;
    if (age < seconds("FACTORY_WATCH_DONE_SECONDS", 60)) return at("waiting");
    if (send(target, NEXT)) {
      takeDone(agent); // the mark is used: the next task's own mark closes the session later
      s.emptySince = null;
      return at("sent-done");
    }
    return at("waiting");
  }
  const minutes = idleMinutes();
  if (minutes <= 0 || t - s.emptySince < minutes * 60 || holdsTask(agent)) return at("waiting");
  if (s.asked !== null && t - s.asked < minutes * 60) return at("waiting");
  s.asked = t;
  if (!taskReady()) return at("waiting");
  if (!send(target, NEXT)) return at("waiting");
  s.emptySince = null;
  return at("sent-idle");
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function watch(a: Record<string, unknown>): Promise<number> {
  const agent = String(a.agent ?? "");
  const target = typeof a.pane === "string" && a.pane ? a.pane : `=${sessionName(agent)}:`;
  if (a.once) {
    console.log(look(agent, target));
    return 0;
  }
  const pid = Number(a.pid);
  if (!Number.isInteger(pid) || pid <= 0) refuse("bad_pid", "watch needs the loop's pid (--pid).", "factory-loop.sh starts it with --pid $$.", 2);
  saveState(agent, { emptySince: null, asked: null }); // a new session: nothing seen yet
  const every = Math.max(seconds("FACTORY_WATCH_SECONDS", 20), 0.2);
  while (pidAlive(pid)) {
    await Bun.sleep(every * 1000);
    if (!pidAlive(pid)) break;
    try {
      look(agent, target);
    } catch {
      // a bad look must never end the watch
    }
  }
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  const usage = `usage: ${PROG} {down,up,watch} ...`;
  if (cmd === "down") {
    return down(parseArgs(argv.slice(1), { valued: ["--agent", "--code", "--role", "--dir", "--main", "--exit", "--since"], required: ["--agent", "--code"] },
      `${PROG} down`, usage));
  }
  if (cmd === "up") {
    const a = parseArgs(argv.slice(1), { valued: ["--agent"], required: ["--agent"] }, `${PROG} up`, usage);
    clearDown(String(a.agent));
    return 0;
  }
  if (cmd === "watch") {
    return watch(parseArgs(argv.slice(1), { valued: ["--agent", "--pid", "--pane"], flags: ["--once"], required: ["--agent"] }, `${PROG} watch`, usage));
  }
  refuse("unknown_command", `${PROG} has no command ${JSON.stringify(cmd ?? "")}.`, "Use down, up or watch.", 2);
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
