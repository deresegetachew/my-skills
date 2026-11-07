// An agent that runs here shows as running in `factory agents ls --json` (and so in the web UI) with or without the
// heartbeat daemon, and a role the owner is talking to (`factory talk`) shows as working, "talking with the owner".
//
// The daemon is not running in any of these: `agents ls` works the state out on the spot. tmux is a fake that answers
// from files (the sessions, each session's pane pid and screen) and logs what it was asked; the loop is a real process
// that `ps` shows as `bash .../factory-loop.sh`, below a pane shell, as tmux runs it. No checkout claim names it: a fresh
// install where the loop's claim isn't seen still shows the agent as running.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type Proc, read, runHook, sh, tmp, write, writeExe } from "./support.ts";

const FAKE_TMUX = `#!/usr/bin/env bash
echo "$*" >>"$FAKE_TMUX_DIR/tmux.log"
t=""; prev=""; for a in "$@"; do [ "$prev" = -t ] && t="\${a#=}"; prev="$a"; done; t="\${t%%:*}"
case "$1" in
  list-sessions) [ -f "$FAKE_TMUX_DIR/sessions" ] || exit 1; cat "$FAKE_TMUX_DIR/sessions" ;;
  has-session) grep -q "^$t " "$FAKE_TMUX_DIR/sessions" 2>/dev/null ;;
  list-panes) cat "$FAKE_TMUX_DIR/$t.pid" 2>/dev/null ;;
  capture-pane) cat "$FAKE_TMUX_DIR/$t.pane" 2>/dev/null ;;
esac
`;

type Env = Record<string, string | undefined>;
const procs: Bun.Subprocess[] = [];
afterAll(() => {
  for (const p of procs) {
    try {
      process.kill(p.pid, "SIGKILL");
    } catch {
      // gone
    }
  }
});

interface World { d: string; env: Env; tmuxDir: string; state: string }

/** A project folder named proj (so sessions are proj-<name>) with taytu and menelik, a dev manager and a product owner. */
function world(names: string[] = ["taytu"]): World {
  const root = tmp();
  const d = join(root, "proj");
  mkdirSync(d);
  sh(["git", "init", "-q", "-b", "main", d]);
  write(join(d, ".claude", "factory.json"), JSON.stringify({ agents: ["menelik", "taytu"],
    roles: { "dev-manager": { names: ["haile"] }, "product-owner": { names: ["mentewab"] } } }));
  const bin = join(root, "bin");
  writeExe(join(bin, "tmux"), FAKE_TMUX);
  const tmuxDir = join(root, "tmux");
  mkdirSync(tmuxDir);
  const config = join(root, "config");
  write(join(config, "proj.json"), JSON.stringify({ agents: names })); // the names this machine runs
  const state = join(root, "state");
  const env: Env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, FAKE_TMUX_DIR: tmuxDir, FACTORY_CONFIG_DIR: config,
    XDG_STATE_HOME: state, HOME: root, CLAUDE_CONFIG_DIR: join(root, "claude"), FACTORY_MACHINE_ID: "aaaa1111" };
  for (const k of ["FACTORY_AGENT", "FACTORY_AGENTS", "FACTORY_LOOP", "FACTORY_ROLE", "CLAUDE_PROJECT_DIR", "TMUX"]) delete env[k];
  return { d, env, tmuxDir, state };
}

function spawn(argv: string[]): number {
  const p = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  procs.push(p);
  return p.pid;
}

/** A tmux session `proj-<name>` whose pane runs `inPane` (a shell line) below the pane's own shell. */
function session(w: World, name: string, inPane: string, screen = "❯ \n"): number {
  const pane = spawn(["bash", "-c", `${inPane}; true`]);
  const line = `proj-${name} ${Math.floor(Date.now() / 1000) - 600}\n`;
  write(join(w.tmuxDir, "sessions"), (existsSync(join(w.tmuxDir, "sessions")) ? read(join(w.tmuxDir, "sessions")) : "") + line);
  write(join(w.tmuxDir, `proj-${name}.pid`), `${pane}\n`);
  write(join(w.tmuxDir, `proj-${name}.pane`), screen);
  Bun.sleepSync(300); // let the pane's shell start its child
  return pane;
}

/** A pane running a factory loop, as `factory owner start` makes it (tmux runs the command under a shell). */
function loopSession(w: World, name: string): void {
  const script = writeExe(join(w.d, "..", `loop-${name}`, "factory-loop.sh"), "#!/bin/bash\nsleep 600\n");
  session(w, name, `bash ${script}`);
}

interface Row { name: string; kind: string; state: string; detail: string; runs: string; session: string | null; since: string | null }

function ls(w: World, ...args: string[]): Proc {
  return runHook("factory_agents", ["ls", ...args], { cwd: w.d, env: w.env });
}

function rows(w: World): Record<string, Row> {
  const p = ls(w, "--json", "--local");
  expect(p.code, p.out).toBe(0);
  const data = JSON.parse(p.stdout) as { agents: Row[]; daemon: { running: boolean } };
  expect(data.daemon.running).toBe(false); // no daemon in any of these
  return Object.fromEntries(data.agents.map((r) => [r.name, r]));
}

// --- 1. an agent running in its tmux session is not down, with or without a claim or the daemon ----------------------

test("an agent whose loop runs in its tmux session shows as running in agents ls, with no daemon and no claim", () => {
  const w = world();
  loopSession(w, "taytu");
  const taytu = rows(w).taytu;
  expect(taytu, JSON.stringify(rows(w))).toBeDefined();
  expect(["working", "idle", "waiting"]).toContain(taytu?.state as string);
  expect(taytu?.runs).toBe("tmux");
  expect(taytu?.session).toBe("proj-taytu");
  expect(taytu?.kind).toBe("coding agent");
  // the table says so too
  const table = ls(w, "--local");
  expect(table.code, table.out).toBe(0);
  const line = table.stdout.split("\n").find((l) => l.startsWith("taytu")) ?? "";
  expect(line).not.toContain("down");
});

test("a dev manager running in its session is found by its role's names, though this machine's names file lists only taytu", () => {
  const w = world();
  loopSession(w, "haile");
  const r = rows(w);
  expect(["working", "idle", "waiting"]).toContain(r.haile?.state as string);
  expect(r.haile?.kind).toBe("dev manager");
  expect(r.taytu?.state).toBe("down"); // expected here, and not running
});

test("a session whose pane runs no loop is still down, and an unknown session name is not listed", () => {
  const w = world();
  session(w, "taytu", "sleep 600"); // the loop ended; the pane's shell lives on
  session(w, "zzz", "sleep 600");
  const r = rows(w);
  expect(r.taytu?.state).toBe("down");
  expect(r.zzz).toBeUndefined();
});

// --- 3. a role the owner is talking to is working -------------------------------------------------------------------

function talkFile(w: World, role: string, name: string, pid: number): string {
  return write(join(w.state, "proj-factory", "talks", `${role}-${pid}.json`), JSON.stringify({ role, name, pid, at: 1_800_000_000 }));
}

test("while a talk with the product owner runs, agents ls shows it working, talking with the owner", () => {
  const w = world();
  const pid = spawn(["bash", "-c", "sleep 600; true", "factory_talk.ts"]); // ps shows it as the talk's process
  Bun.sleepSync(200);
  talkFile(w, "product-owner", "mentewab", pid);
  const po = rows(w).mentewab;
  expect([po?.state, po?.detail, po?.kind]).toEqual(["working", "talking with the owner", "product owner"]);
  expect(po?.since).toBe("2027-01-15T08:00:00Z");
});

test("a talk whose process has gone counts for nothing and its file is removed", () => {
  const w = world();
  const gone = Bun.spawnSync(["true"]).pid;
  const file = talkFile(w, "product-owner", "mentewab", gone);
  expect(rows(w).mentewab).toBeUndefined();
  expect(existsSync(file)).toBe(false);
});

test("a pid that is alive but is not a talk any more counts for nothing", () => {
  const w = world();
  const other = spawn(["sleep", "600"]);
  talkFile(w, "dev-manager", "haile", other);
  expect(rows(w).haile).toBeUndefined();
  expect(readdirSync(join(w.state, "proj-factory", "talks"))).toEqual([]);
});
