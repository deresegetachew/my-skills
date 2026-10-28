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
// place. Without tmux it stops with {code, message, fix}. The cockpit needs tmux 3.2 or newer; an older tmux still
// starts the session, with a note.
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

function main(argv: string[]): number {
  if (argv[0] === "loop") return loop(argv.slice(1));
  refuse("unknown-command", `unknown command ${JSON.stringify(argv[0] ?? "")}.`,
    "Use: factory_window.ts loop --role R [--name N] -- <loop arguments>");
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
