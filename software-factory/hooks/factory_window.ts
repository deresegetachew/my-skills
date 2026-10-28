#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// The one step that starts a factory session in its own tmux window (#300, PRD US-3). `factory loop -i`, `factory
// resume` (what `factory autostart` runs at boot) and later the cockpit all start their sessions through it.
//
//   factory_window.ts loop --role R [--name N] -- <loop arguments>
//       what `factory loop -i` runs on a terminal: start `factory loop <arguments>` as role R and name N (else the
//       first free name of R) in its window, then attach to it (`switch-client` when already inside tmux)
//
// Each session is the tmux session <repo>-<name> (what `factory follow`, `say` and the heartbeat look for) with one
// window named <role>-<name>; dots, spaces and other signs become "-". A session that is already running is left
// alone and said so. The command in the window gets FACTORY_WINDOW=<window>, so a `factory loop -i` inside it runs in
// place. Without tmux the step stops with {code, message, fix} (resume, autostart); `factory loop -i` checks first and
// runs in place instead, with a note. The cockpit needs tmux 3.2 or newer; an older tmux still
// starts the session, with a note.
//
//   factory_window.ts job <file>
//       what a sub-manager's window runs (#307, PRD US-4): the job file (mode 600, written by the orchestrator and
//       removed once read, so neither the prompt nor the environment is on tmux's command line) names the command,
//       its environment, the log and where the exit code goes. claude's stream-json output is shown as readable lines,
//       in the window and in the log.
import { appendFileSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { load, toFloat } from "./factory_config.ts";
import { freeNames } from "./factory_claims.ts";
import { refuse, repoKey } from "./factory_machine.ts";
import { run, runMain, shQuote, which } from "./factory_lib.ts";

export class WindowError extends Error {
  constructor(readonly code: string, message: string, readonly fix: string) {
    super(message);
  }
}

function safe(text: string): string {
  return text.replace(/[^A-Za-z0-9_-]+/g, "-");
}

/** The tmux session an agent runs in: <repo>-<name>. */
export function sessionName(name: string): string {
  return safe(`${repoKey()}-${name}`);
}

/** The window a session runs in: <role>-<name>. */
export function windowName(role: string, name: string): string {
  return safe(`${role}-${name}`);
}

export function running(session: string): boolean {
  return run(["tmux", "has-session", "-t", `=${session}`]).code === 0;
}

/** Throws WindowError when there is no tmux; returns a note when it is older than 3.2, else "". */
export function checkTmux(): string {
  if (!which("tmux")) {
    throw new WindowError("no-tmux", "tmux is not installed, and every factory session runs in its own tmux window.",
      "Install tmux (for example `sudo apt install tmux` or `brew install tmux`), then run the command again.");
  }
  const m = /(\d+)\.(\d+)/.exec(run(["tmux", "-V"]).stdout);
  if (m && (Number(m[1]) < 3 || (Number(m[1]) === 3 && Number(m[2]) < 2))) {
    return `Note: ${m[0]} is older than tmux 3.2: the session starts, but the cockpit needs 3.2 or newer. ` +
      "Upgrade tmux before you use `factory cockpit`.";
  }
  return "";
}

export interface Start {
  role: string;
  name: string;
  dir: string;
  argv: string[];
  env?: Record<string, string>;
}

export interface Started {
  session: string;
  window: string;
  started: boolean;
  note: string;
}

/** Starts `argv` in `dir` as its own tmux window, unless that session already runs. Throws WindowError. */
export function startWindow(s: Start): Started {
  const note = checkTmux();
  const session = sessionName(s.name);
  const window = windowName(s.role, s.name);
  if (running(session)) return { session, window, started: false, note };
  const env = { FACTORY_WINDOW: window, ...(s.env ?? {}) };
  const command = "exec env " + Object.entries(env).map(([k, v]) => shQuote(`${k}=${v}`)).join(" ") + " " +
    s.argv.map(shQuote).join(" ");
  const tmuxEnv: Record<string, string | undefined> = { ...process.env, TMUX: undefined };
  const p = run(["tmux", "new-session", "-d", "-s", session, "-c", s.dir, "-n", window, command],
    { cwd: s.dir, env: tmuxEnv, timeoutMs: 60_000 });
  if (p.code !== 0 || !running(session)) {
    const why = (p.stderr.trim().split("\n").pop() || "no session").slice(0, 160);
    throw new WindowError("tmux-failed", `tmux could not start the session ${session}: ${why}`,
      "Run `tmux ls` to see what is there, then try again.");
  }
  return { session, window, started: true, note };
}

/** What the caller's shell set that the loop needs: a running tmux server gives a new window the server's environment,
 * not the caller's. PATH, Docker's socket, and every FACTORY_ variable except the window's own and the ones that name
 * another session (FACTORY_AGENT, FACTORY_PID). */
function carried(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || ["FACTORY_WINDOW", "FACTORY_ROLE", "FACTORY_NAME", "FACTORY_AGENT", "FACTORY_PID"].includes(k)) continue;
    if (["PATH", "DOCKER_HOST", "XDG_RUNTIME_DIR"].includes(k) || k.startsWith("FACTORY_")) out[k] = v;
  }
  return out;
}

/** `factory loop -i` on a terminal: start the loop in its window, then show it here. */
function loop(argv: string[]): number {
  const cut = argv.indexOf("--");
  const own = cut < 0 ? argv : argv.slice(0, cut);
  const rest = cut < 0 ? [] : argv.slice(cut + 1);
  const value = (flag: string) => {
    const i = own.indexOf(flag);
    return i >= 0 ? own[i + 1] ?? "" : "";
  };
  const role = value("--role") || "coding-agent";
  let name = value("--name");
  const top = run(["git", "rev-parse", "--show-toplevel"]).stdout.trim();
  let s: Started;
  try {
    const note = checkTmux();
    if (note) console.log(note);
    if (!name) {
      const cfg = load();
      const free = freeNames(role, toFloat(cfg.claimStaleHours ?? 6) ?? 6);
      name = free.find((n) => !running(sessionName(n))) ?? free[0] ?? "";
    }
    if (!name) {
      refuse("no-free-name", `every ${role} name already has a live loop on this clone.`,
        `Name one: factory ${role} <name> loop -i, or stop one of them first.`);
    }
    s = startWindow({ role, name, dir: top, argv: [join(top, "factory"), "loop", ...rest],
      env: { ...carried(), FACTORY_ROLE: role, FACTORY_NAME: name } });
  } catch (e) {
    if (e instanceof WindowError) refuse(e.code, e.message, e.fix);
    throw e;
  }
  if (s.started) console.log(`Started ${s.window} in tmux session ${s.session}.`);
  else console.log(`${s.window} is already running in tmux session ${s.session}; not starting a second one.`);
  const nested = Boolean(process.env.TMUX);
  console.log(nested ? `Switching to it; come back with your tmux prefix and s.` :
    `Attaching to it; detach with Ctrl-b d, come back with: tmux attach -t ${s.session}`);
  const p = Bun.spawnSync(["tmux", nested ? "switch-client" : "attach-session", "-t", `=${s.session}`],
    { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return p.exitCode ?? 1;
}

/** What a window runs for a sub-manager: the command, its whole environment, its log and the exit code's file. */
export interface Job {
  argv: string[];
  env: Record<string, string>;
  log: string;
  rc: string;
}

function brief(input: unknown): string {
  const text = JSON.stringify(input ?? {});
  return text.length > 120 ? text.slice(0, 117) + "..." : text;
}

/** The lines a person reads for one line of claude's stream-json output: the assistant's text, one line per tool it
 * uses, the final result. Other events show nothing; a line that is not a JSON event shows as it is. */
export function readable(line: string): string[] {
  let ev: unknown;
  try {
    ev = JSON.parse(line);
  } catch {
    return [line];
  }
  if (typeof ev !== "object" || ev === null || Array.isArray(ev)) return [line];
  const e = ev as { type?: unknown; result?: unknown; message?: { content?: unknown } };
  if (e.type === "result") return typeof e.result === "string" ? [e.result] : [];
  const content = e.type === "assistant" ? e.message?.content : undefined;
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const c of content as { type?: unknown; text?: unknown; name?: unknown; input?: unknown }[]) {
    if (c.type === "text" && typeof c.text === "string" && c.text) out.push(c.text);
    else if (c.type === "tool_use") out.push(`> ${typeof c.name === "string" ? c.name : "tool"} ${brief(c.input)}`);
  }
  return out;
}

async function eachLine(stream: ReadableStream<Uint8Array>, each: (line: string) => void): Promise<void> {
  const dec = new TextDecoder();
  let rest = "";
  for await (const chunk of stream) {
    rest += dec.decode(chunk, { stream: true });
    const lines = rest.split("\n");
    rest = lines.pop() ?? "";
    lines.forEach(each);
  }
  rest += dec.decode();
  if (rest) each(rest);
}

function readJob(file: string): Job {
  const j = JSON.parse(readFileSync(file, "utf8")) as Partial<Job>;
  if (!Array.isArray(j.argv) || !j.argv.length || typeof j.log !== "string" || typeof j.rc !== "string") {
    throw new WindowError("bad-job", `the job file ${file} is not a job.`, "Let the dev manager's next cycle start it again.");
  }
  return { argv: j.argv.map(String), env: j.env ?? {}, log: j.log, rc: j.rc };
}

/** A sub-manager's window: runs the job, shows it and logs it, and leaves the exit code for the orchestrator. */
async function job(file: string): Promise<number> {
  let j: Job;
  try {
    j = readJob(file);
  } finally {
    rmSync(file, { force: true });
  }
  writeFileSync(j.log, ""); // emptied here, once this window has started, so an earlier window's log is never cut short
  const show = (text: string): void => {
    process.stdout.write(text);
    appendFileSync(j.log, text);
  };
  let rc = 127;
  try {
    const p = Bun.spawn(j.argv, { env: j.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    await Promise.all([
      eachLine(p.stdout, (l) => show(readable(l).map((x) => x + "\n").join(""))),
      eachLine(p.stderr, (l) => show(l + "\n")),
    ]);
    rc = await p.exited;
  } catch (e) {
    show(`could not start ${j.argv[0]}: ${e instanceof Error ? e.message : String(e)}\n`);
  } finally { // the orchestrator reads the file once it exists: write it whole
    writeFileSync(j.rc + ".tmp", String(rc));
    renameSync(j.rc + ".tmp", j.rc);
  }
  return rc;
}

async function main(argv: string[]): Promise<number> {
  if (argv[0] === "loop") return loop(argv.slice(1));
  if (argv[0] === "job" && argv[1]) {
    try {
      return await job(argv[1]);
    } catch (e) {
      if (e instanceof WindowError) refuse(e.code, e.message, e.fix);
      throw e;
    }
  }
  refuse("unknown-command", `unknown command ${JSON.stringify(argv[0] ?? "")}.`,
    "Use: factory_window.ts loop --role R [--name N] -- <loop arguments>, or factory_window.ts job <file>");
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
