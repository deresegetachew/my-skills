// This machine's maxCodingAgents (#581, #596) caps every path that starts a coding agent: `factory loop -i` (in its
// window or in place), `factory agent` (and --detach), `factory resume` (what `factory autostart` runs at boot) and
// `factory owner start` (owner_actions.test.ts). One more than the limit is refused with `too_many_agents` and its fix;
// boot starts at most the limit, in the team's order, and says which it skipped. tmux is a fake on PATH that reports
// the running sessions from files; a real tmux never runs.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hook, log, machine, machineFile, project as cloneProject, sessions } from "./autostart_support.ts";
import { claudeCalls, type Env, factory, project } from "./roles_support.ts";
import { type Proc, write, writeExe } from "./support.ts";

const FAKE_TMUX = `#!/usr/bin/env bash
echo "$*" >>"$FAKE_LOG/tmux.log"
d="$FAKE_TMUX"; mkdir -p "$d"
case "$1" in
  -V) echo "tmux 3.4" ;;
  has-session) name="\${3#=}"; [ -f "$d/$name" ] ;;
  new-session)
    shift; name=""
    while [ $# -gt 0 ]; do
      case "$1" in -s) name="$2"; shift 2 ;; -c) echo "$2" >"$d/$name.dir"; shift 2 ;; -n) shift 2 ;; -d) shift ;; *) break ;; esac
    done
    printf '%s\\n' "$*" >"$d/$name" ;;
  *) ;;
esac
`;

/** A role project named "work" (agents menelik and taytu) with the fake tmux, this machine's limit set to `max`, and
 * the tmux sessions in `up` already running. */
function capped(max: number, up: string[]): [string, Env] {
  const [d, work, env] = project();
  const log = join(d, "tmuxlog");
  mkdirSync(log, { recursive: true });
  writeExe(join(d, "bin", "tmux"), FAKE_TMUX);
  const config = join(d, "config");
  write(join(config, "work.json"), JSON.stringify({ maxCodingAgents: max }));
  Object.assign(env, { FAKE_LOG: log, FAKE_TMUX: join(d, "tmux-sessions"), FACTORY_CONFIG_DIR: config });
  delete env.TMUX;
  mkdirSync(env.FAKE_TMUX as string, { recursive: true });
  for (const s of up) write(join(env.FAKE_TMUX as string, s), "running\n");
  return [work, env];
}

const calls = (env: Env): string[] => {
  const f = join(env.FAKE_LOG as string, "tmux.log");
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : [];
};
const starts = (env: Env) => calls(env).filter((l) => l.startsWith("new-session"));

/** The `{code, message, fix}` line in some output. */
function refusal(text: string): { code: string; message: string; fix: string } {
  const line = text.split(/\r?\n/).find((l) => l.includes('"too_many_agents"'));
  expect(line, text).toBeDefined();
  return JSON.parse((line as string).slice((line as string).indexOf("{"))) as { code: string; message: string; fix: string };
}

function tooMany(text: string, busy: string, max: number): void {
  const e = refusal(text);
  expect(e.code).toBe("too_many_agents");
  expect(e.message).toContain(`at most ${max}`);
  expect(e.message).toContain(busy);
  expect(e.fix).toContain(`factory owner stop ${busy}`);
  expect(e.fix).toContain(`factory settings --local set maxCodingAgents ${max + 1}`);
}

/** Runs `factory <args>` on a pseudo-terminal: [exit code, everything it showed]. */
async function onATerminal(work: string, env: Env, args: string[]): Promise<[number, string]> {
  let shown = "";
  const p = Bun.spawn(["bash", "./factory", ...args], {
    cwd: work, env: env as Record<string, string>,
    terminal: { cols: 400, rows: 50, data(_t, d) { shown += new TextDecoder().decode(d); } },
  });
  const timer = setTimeout(() => p.kill(9), 60_000);
  const code = await p.exited;
  clearTimeout(timer);
  await Bun.sleep(50);
  p.terminal?.close();
  return [code, shown];
}

// --- factory loop -i ---------------------------------------------------------------------------------------------------

test("loop dash i on a terminal past the limit is refused with too_many_agents and starts and attaches nothing", async () => {
  const [work, env] = capped(1, ["work-taytu"]);
  const [rc, shown] = await onATerminal(work, env, ["coding-agent", "menelik", "loop", "-i"]);
  expect(rc).not.toBe(0);
  tooMany(shown, "taytu", 1);
  expect(starts(env)).toEqual([]);
  expect(calls(env).some((l) => l.startsWith("attach-session"))).toBe(false);
}, 90_000);

test("loop dash i of a coding agent that already runs is not refused at the limit: it attaches to it", async () => {
  const [work, env] = capped(1, ["work-menelik"]);
  const [rc, shown] = await onATerminal(work, env, ["coding-agent", "menelik", "loop", "-i"]);
  expect(rc, shown).toBe(0);
  expect(shown).toContain("already running");
  expect(shown).not.toContain("too_many_agents");
  expect(calls(env)).toContain("attach-session -t =work-menelik");
}, 90_000);

test("loop dash i under the limit starts, and a dev manager is not counted or capped", async () => {
  const [work, env] = capped(2, ["work-taytu", "work-lead"]);
  const [rc, shown] = await onATerminal(work, env, ["coding-agent", "menelik", "loop", "-i"]);
  expect(rc, shown).toBe(0);
  expect(starts(env)).toHaveLength(1);
  const [work2, env2] = capped(1, ["work-taytu"]);
  const [rc2, shown2] = await onATerminal(work2, env2, ["dev-manager", "lead", "loop", "-i"]);
  expect(rc2, shown2).toBe(0);
  expect(starts(env2)).toHaveLength(1);
}, 150_000);

test("a coding agent's loop run in place (no terminal) past the limit is refused and runs no task", () => {
  const [work, env] = capped(1, ["work-taytu"]);
  const p = factory(work, env, ["coding-agent", "menelik", "loop", "-i", "--once"]);
  expect(p.code).not.toBe(0);
  tooMany(p.stderr, "taytu", 1);
  expect(claudeCalls(env)).toEqual([]);
  const q = factory(work, env, ["loop", "--once"]); // unattended, unnamed: still a coding agent
  expect(q.code).not.toBe(0);
  tooMany(q.stderr, "taytu", 1);
  expect(claudeCalls(env)).toEqual([]);
}, 90_000);

// --- factory agent -----------------------------------------------------------------------------------------------------

test("factory agent past the limit is refused before it makes a folder or opens Claude", () => {
  const [work, env] = capped(1, ["work-taytu"]);
  const p = factory(work, env, ["agent", "menelik"]);
  expect(p.code).not.toBe(0);
  tooMany(p.stderr, "taytu", 1);
  expect(claudeCalls(env)).toEqual([]);
  expect(existsSync(join(dirname(work), "work-agents", "menelik"))).toBe(false);
  const n = factory(work, env, ["agent", "1"]); // by number: menelik
  expect(n.code).not.toBe(0);
  tooMany(n.stderr, "taytu", 1);
});

test("factory agent --detach past the limit is refused and asks tmux for no session", () => {
  const [work, env] = capped(1, ["work-taytu"]);
  const p = factory(work, env, ["agent", "menelik", "--detach"]);
  expect(p.code).not.toBe(0);
  tooMany(p.stderr, "taytu", 1);
  expect(starts(env)).toEqual([]);
});

test("factory agent --detach under the limit starts its session", () => {
  const [work, env] = capped(2, ["work-taytu"]);
  const p = factory(work, env, ["agent", "menelik", "--detach"]);
  expect(p.code, p.out).toBe(0);
  expect(starts(env)).toHaveLength(1);
});

// --- factory resume (what factory autostart runs at boot) ---------------------------------------------------------------

function boot(max: number, autostartAgents: string[], up: string[] = []): [string, Env] {
  const clone = cloneProject(); // agents: menelik, taytu, haile, tewodros
  const env = machine(clone);
  machineFile(env, { autostart: true, autostartAgents, maxCodingAgents: max });
  mkdirSync(env.FAKE_TMUX as string, { recursive: true });
  for (const s of up) write(join(env.FAKE_TMUX as string, s), "running\n");
  return [clone, env];
}

const resume = (clone: string, env: Env, ...a: string[]): Proc => hook("factory_resume", clone, env, ...a);

test("resume starts at most the limit, in the team's order, and says which it skipped and why", () => {
  const [clone, env] = boot(1, ["tewodros", "haile"]); // the team's order is haile, then tewodros
  const r = resume(clone, env);
  expect(r.code, r.out).toBe(0);
  expect(sessions(env)).toEqual(["proj-haile"]);
  expect(log(env, "tmux").split("new-session").length - 1).toBe(1);
  expect(r.stdout).toContain("agent haile: started");
  const skipped = r.stdout.split("\n").find((l) => l.startsWith("agent tewodros:")) ?? "";
  expect(skipped, r.stdout).toContain("not started");
  expect(skipped).toContain("maxCodingAgents");
  expect(skipped).toContain("at most 1");
  expect(skipped).toContain("factory settings --local set maxCodingAgents 2");
  expect(r.stdout).toContain("1 of 2 agents started, 1 skipped");
});

test("resume counts coding agents already running here against the limit", () => {
  const [clone, env] = boot(2, ["haile", "tewodros"], ["proj-menelik"]);
  const r = resume(clone, env);
  expect(r.code, r.out).toBe(0);
  expect(sessions(env)).toEqual(["proj-haile", "proj-menelik"]);
  expect(r.stdout).toMatch(/agent tewodros: not started.*menelik, haile/);
});

test("resume at the limit starts nothing, and an agent already running is left alone, not skipped", () => {
  const [clone, env] = boot(1, ["haile", "tewodros"], ["proj-haile"]);
  const r = resume(clone, env);
  expect(r.code, r.out).toBe(0);
  expect(log(env, "tmux")).not.toContain("new-session");
  expect(r.stdout).toContain("agent haile: already running");
  expect(r.stdout).toMatch(/agent tewodros: not started/);
});

test("resume dry run says which it would skip for the limit", () => {
  const [clone, env] = boot(1, ["haile", "tewodros"]);
  const r = resume(clone, env, "--dry-run");
  expect(r.code, r.out).toBe(0);
  expect(sessions(env)).toEqual([]);
  expect(r.stdout).toContain("agent haile: would start");
  expect(r.stdout).toMatch(/agent tewodros: would not start.*maxCodingAgents/);
});

test("autostart status says which agents the limit would leave out", () => {
  const [clone, env] = boot(1, ["tewodros", "haile"]);
  const r = hook("factory_autostart", clone, env, "status");
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toMatch(/maxCodingAgents.*1/);
  expect(r.stdout).toMatch(/would skip.*tewodros/);
  expect(sessions(env)).toEqual([]);
});
