// Every agent in the cockpit (#395): rows from the heartbeat and the claims, not only tmux. How each one runs (tmux,
// nohup, cloud), a loop waiting for GitHub's limit, the other projects on this machine (from their heartbeat files),
// and a loop outside tmux that `factory owner stop` can still stop.
import { afterEach, expect, test } from "bun:test";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import { drawDoc, sidebarOf } from "../cockpit/testing.tsx";
import { parseWait } from "../hooks/factory_heartbeat.ts";
import { setup } from "./issues_support.ts";
import { project } from "./roles_support.ts";
import { type Proc, runHook, sh, tmp, write, writeExe } from "./support.ts";

type Obj = Record<string, unknown>;
type Env = Record<string, string | undefined>;

const VIEWS = [["1", "Needs you"], ["2", "Pull requests"], ["3", "Tasks & PRD"], ["4", "CI"], ["5", "Agents & machines"],
  ["6", "Settings"], ["7", "Health & releases"], ["8", "Usage & lessons"], ["9", "Talk to the dev manager"],
  ["0", "Talk to the product owner"]].map(([key, title]) => ({ key: key as string, title: title as string }));

const local = (r: Obj): Obj => ({ where: "this machine", source: "local", machine: "aaaa1111", machineName: "dev-pc", detail: r.state, task: null,
  expected: false, kind: "coding agent", runs: "", ...r });

const SNAPSHOT: Obj = {
  generatedAt: new Date().toISOString(),
  sessions: [
    local({ name: "menelik", state: "working", task: "12", detail: "working on #12", runs: "nohup", expected: true, log: "/tmp/menelik.log" }),
    local({ name: "haile", state: "down", expected: true }),
    local({ name: "fasil", state: "idle", kind: "dev manager", runs: "tmux" }),
    local({ name: "makeda", state: "idle", kind: "product owner", runs: "tmux" }),
  ],
  projects: [
    { name: "remanual", fresh: true, agents: [{ name: "mentewab", kind: "coding agent", state: "working", task: "4", runs: "tmux", detail: "working on #4" }] },
    { name: "oldproj", fresh: false, agents: [{ name: "x1", kind: "coding agent", state: "idle", task: null, runs: "nohup", detail: "idle" }] },
  ],
  needsYou: [],
};

function lineWith(frame: string, word: string): string {
  return frame.split("\n").find((l) => l.includes(word)) ?? "";
}

// --- the list ---------------------------------------------------------------------------------------------------------

test("the list says how a session runs, keeps a down one expected here, and groups the other projects", () => {
  const s = sidebarOf({ snapshot: SNAPSHOT, views: VIEWS }, 50, 40);
  const f = s.frame();
  expect(lineWith(f, "menelik")).toContain("nohup");
  expect(lineWith(f, "haile")).toContain("down");
  expect(f).toContain("OTHER PROJECTS");
  expect(f).toContain("remanual");
  expect(lineWith(f, "mentewab")).toContain("#4");
  expect(lineWith(f, "oldproj")).toContain("not reporting");
  expect(f).toContain("9 Talk to the dev manager");
  expect(f).toContain("0 Talk to the product owner");
  s.unmount();
});

test("Enter on the dev manager or the product owner opens the talk with it; on a coding agent, its session", async () => {
  const s = sidebarOf({ snapshot: SNAPSHOT, views: VIEWS }, 50, 40);
  await s.press("\r"); // menelik, the first
  await s.press("j");
  await s.press("j");
  await s.press("\r"); // fasil
  await s.press("j");
  await s.press("\r"); // makeda
  expect(s.calls).toEqual(["session menelik", "view 9", "view 0"]);
  s.unmount();
});

test("the other projects' agents are shown, not picked: j from the last session goes to the first view", async () => {
  const s = sidebarOf({ snapshot: SNAPSHOT, views: VIEWS }, 50, 40);
  for (const _ of [1, 2, 3]) await s.press("j"); // makeda, the last session
  await s.press("j");
  await s.press("\r");
  expect(s.calls).toEqual(["view 1"]);
  s.unmount();
});

// --- the Agents & machines view ---------------------------------------------------------------------------------------

test("Agents & machines shows how each runs, a loop's log, and the other projects on this machine", () => {
  const v = drawDoc("agents", { cols: 120, rows: 60, color: false, data: SNAPSHOT, load: async () => SNAPSHOT });
  const f = v.frame();
  expect(lineWith(f, "menelik")).toContain("nohup");
  expect(f).toContain("log /tmp/menelik.log");
  expect(f).toContain("OTHER PROJECTS ON THIS MACHINE");
  expect(f).toContain("remanual");
  expect(f).toContain("mentewab");
  v.unmount();
});

// --- the snapshot: other projects ---------------------------------------------------------------------------------------

function heartbeat(agents: Obj, ageSeconds = 0): string {
  return JSON.stringify({ updated: Date.now() / 1000 - ageSeconds, interval: 20, agents });
}

test("factory cockpit --json lists the other projects on this machine from their heartbeat files, not its own", () => {
  const [d, work, env] = project();
  const state = join(d, "state");
  write(join(state, "remanual-factory", "heartbeat.json"), heartbeat({ mentewab: { name: "mentewab", kind: "coding-agent", state: "working",
    detail: "working on #4", task: "4", on: null, machine: "m1", path: null, pid: 1, session: "remanual-mentewab", follow: null,
    activity: null, runs: "tmux" } }));
  write(join(state, "stale-factory", "heartbeat.json"), heartbeat({}, 3600));
  write(join(state, `${basename(work)}-factory`, "heartbeat.json"), heartbeat({}));
  const p = sh([process.execPath, "--no-env-file", "--config=/dev/null", join(work, ".claude", "hooks", "factory_cockpit.ts"), "--json"],
    { cwd: work, env: { ...env, XDG_STATE_HOME: state }, timeoutMs: 180_000 });
  expect(p.code, p.out).toBe(0);
  const projects = (JSON.parse(p.stdout) as { projects: Obj[] }).projects;
  expect(projects.map((x) => x.name)).toEqual(["remanual", "stale"]);
  expect(projects[0]?.fresh).toBe(true);
  expect(projects[1]?.fresh).toBe(false);
  expect((projects[0]?.agents as Obj[])[0]).toMatchObject({ name: "mentewab", state: "working", task: "4", runs: "tmux", kind: "coding agent" });
}, 200_000);

// --- the heartbeat: how a loop runs, and a wait for GitHub's limit -------------------------------------------------------

const FAKE_TMUX = `#!/bin/sh
case "$1" in
  list-sessions) [ -f "$FAKE_TMUX_DIR/sessions" ] || exit 1; cat "$FAKE_TMUX_DIR/sessions" ;;
  has-session) exit 1 ;;
esac
`;

const started: { pid: number; exited: Promise<number> }[] = [];
afterEach(() => {
  for (const p of started.splice(0)) {
    try {
      process.kill(-p.pid, "SIGKILL");
    } catch {
      // gone already
    }
  }
});

/** A live process `ps` shows as factory-loop.sh, in its own process group, with `child` below it when given. */
function startLoop(child = ""): { pid: number; exited: Promise<number> } {
  const folder = tmp();
  writeExe(join(folder, "factory_views_cache.ts"), "#!/bin/sh\nsleep 600\n");
  const script = writeExe(join(folder, "factory-loop.sh"), `#!/bin/sh\nD=$(dirname "$0")\n${child}sleep 600 &\nwait\n`);
  const p = Bun.spawn(["setsid", script], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const got = { pid: p.pid, exited: p.exited };
  started.push(got);
  Bun.sleepSync(300); // let the shell start its children
  return got;
}

interface Box { d: string; env: Env; state: string; tmuxDir: string }

function box(): Box {
  const [d, , base] = setup([]);
  writeExe(join(d, "bin", "tmux"), FAKE_TMUX);
  sh(["git", "init", "-q", d]);
  const state = tmp();
  const tmuxDir = tmp();
  const env: Env = { ...base, FACTORY_MACHINE_ID: "aaaa1111", FACTORY_CONFIG_DIR: tmp(), XDG_STATE_HOME: state, FAKE_TMUX_DIR: tmuxDir,
    FACTORY_AGENTS: "taytu" };
  for (const k of ["FACTORY_AGENT", "FACTORY_LOOP", "CLAUDE_PROJECT_DIR", "FACTORY_NOW"]) delete env[k];
  return { d, env, state, tmuxDir };
}

function claim(b: Box, agent: string, pid: number): void {
  write(join(b.d, ".git", "factory", "claims.json"), JSON.stringify({ checkouts: { [agent]: { agent, pid, host: hostname(),
    at: Date.now() / 1000, path: b.d } }, tasks: {} }));
}

function localRow(b: Box, name: string): Obj {
  const p: Proc = runHook("factory_agents.ts", ["ls", "--json", "--local"], { cwd: b.d, env: b.env, timeoutMs: 60_000 });
  expect(p.code, p.out).toBe(0);
  return (JSON.parse(p.stdout) as { agents: Obj[] }).agents.find((r) => r.name === name) ?? {};
}

test("a live loop with no tmux session runs nohup; with its tmux session, tmux", () => {
  const b = box();
  claim(b, "taytu", startLoop().pid);
  expect(localRow(b, "taytu")).toMatchObject({ state: "idle", runs: "nohup" });
  write(join(b.tmuxDir, "sessions"), `${basename(b.d)}-taytu ${Math.floor(Date.now() / 1000) - 600}\n`);
  expect(localRow(b, "taytu")).toMatchObject({ runs: "tmux" });
});

test("a loop waiting for GitHub's limit is waiting, until the time the limit is back", () => {
  const b = box();
  const reset = Math.floor(Date.now() / 1000) + 1800;
  write(join(b.state, `${basename(b.d)}-factory`, "github-rate.json"), JSON.stringify({ at: Date.now() / 1000,
    core: { limit: 5000, remaining: 0, reset } }));
  claim(b, "taytu", startLoop(`"$D/factory_views_cache.ts" limit-wait --attempt 2 --name taytu &\n`).pid);
  const row = localRow(b, "taytu");
  expect(row.state).toBe("waiting");
  const hhmm = new Date(reset * 1000).toISOString().slice(11, 16);
  expect(String(row.detail)).toBe(`waiting for the GitHub limit until ${hhmm} UTC`);
});

test("the loop's limit wait under bun is read as a wait for the limit", () => {
  expect(parseWait("bun --no-env-file --config=/dev/null /x/.claude/hooks/factory_views_cache.ts limit-wait --attempt 2 --name taytu")?.on)
    .toBe("limit");
  expect(parseWait("bun /x/.claude/hooks/factory_views_cache.ts limit-idle 5")).toBeNull();
});

// --- factory owner stop: a loop outside tmux -----------------------------------------------------------------------------

function ownerStop(work: string, env: Env, name: string): Proc {
  const e: Env = { ...env };
  for (const k of ["FACTORY_AGENT", "FACTORY_LOOP", "FACTORY_ROLE", "CLAUDECODE"]) delete e[k];
  return sh([process.execPath, "--no-env-file", "--config=/dev/null", join(work, ".claude", "hooks", "factory_owner.ts"), "stop", name],
    { cwd: work, env: e });
}

test("factory owner stop ends a loop that runs outside tmux, by its claim", async () => {
  const [d, work, env] = project();
  writeExe(join(d, "bin", "tmux"), FAKE_TMUX);
  const loop = startLoop();
  write(join(work, ".git", "factory", "claims.json"), JSON.stringify({ checkouts: { menelik: { agent: "menelik", pid: loop.pid,
    host: hostname(), at: Date.now() / 1000, path: work } }, tasks: {} }));
  const p = ownerStop(work, env, "menelik");
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("Stopped menelik");
  expect(p.stdout).toContain("outside tmux");
  const ended = await Promise.race([loop.exited.then(() => true), Bun.sleep(5000).then(() => false)]);
  expect(ended).toBe(true);
});

test("factory owner stop with no session and no live loop stops nothing", () => {
  const [d, work, env] = project();
  writeExe(join(d, "bin", "tmux"), FAKE_TMUX);
  const p = ownerStop(work, env, "menelik");
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("is not running on this machine");
});
