// The factory runs unattended (#640):
//   - a loop whose folder has leftover changes stops at start and says why, on screen and to the heartbeat
//     (`down: <reason>` in `factory agents ls`), and `factory owner start --stash` saves them aside in that folder only and
//     starts it;
//   - beside an interactive (`-i`) coding agent's session, the loop types /next-task into it when its task is done but the
//     session stayed open, or when it sits at an empty prompt with no task for loop.idleNextTaskMinutes while one is ready;
//     never into a prompt that holds text, nor while a question waits in its picker.
//
// The loop runs for real with stub hooks; the reason and the watch are the real factory_loop_watch.ts in a project with
// the hooks copied and a stub next_task.ts. tmux is a fake that shows a screen from a file and logs every key it is sent.
import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, utimesSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { loopRepo, must, STUB_HOOKS } from "./loop_support.ts";
import { copyHookFolders, envWith, git, gitRepo, HOOKS, type Proc, read, sh, tmp, write, writeExe } from "./support.ts";

type Env = Record<string, string | undefined>;
const T = 90_000;
// The folders are under the run's scratch folder (tmp), which tools/run_tests.ts removes.

// --- the loop stops at start, and says why --------------------------------------------------------------------------

function loopWith(wt: (work: string, d: string) => string): { work: string; wt: string; env: Env; log: string } {
  const [d, work] = loopRepo([...STUB_HOOKS, "factory_loop_watch.ts"]);
  const dir = wt(work, d);
  writeExe(join(d, "bin", "claude"), '#!/usr/bin/env bash\necho "claude $*" >> "$LOOP_LOG"\n');
  const log = join(d, "log");
  const env: Env = { ...process.env, PATH: `${d}/bin:${process.env.PATH}`, LOOP_LOG: log, LOOP_STATE: join(d, "state"), LOOP_WT: dir,
    STUB_AGENT: "haile", FACTORY_REMOTE_CONTROL: "0" };
  for (const k of ["FACTORY_AGENT", "FACTORY_RELOAD_AGENT", "FACTORY_RELOAD_DIR", "TMUX", "TMUX_PANE"]) delete env[k];
  return { work, wt: dir, env, log };
}

function agentWorktree(work: string, d: string): string {
  const wt = join(d, "work-agents", "haile");
  must(["git", "worktree", "add", "-q", "--detach", wt, "HEAD"], work);
  return wt;
}

test("a loop whose folder has uncommitted leftovers stops at start, says why to the heartbeat, and changes nothing there", () => {
  const w = loopWith((work, d) => {
    const wt = agentWorktree(work, d);
    // main moved on since the folder was used, and the folder changed the same file: the checkout can't go ahead
    write(join(work, ".claude", "factory.json"), '{"waitMinutes": 0, "main": "moved"}');
    must(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "main moves"], work);
    must(["git", "push", "-q", "origin", "HEAD:main"], work);
    write(join(wt, ".claude", "factory.json"), '{"waitMinutes": 0, "half": "done"}'); // a tracked file changed
    must(["git", "rm", "-q", "--cached", "factory-loop.sh"], wt); // and a staged deletion, as on dev-pc
    return wt;
  });
  const p = sh(["bash", "./factory-loop.sh", "--once"], { cwd: w.work, env: w.env, timeoutMs: 60_000 });
  expect(p.code, p.out).toBe(1);
  const log = read(w.log);
  expect(log).toContain(`factory_loop_watch.ts down --agent haile --role coding-agent --code dirty_worktree --dir ${w.wt} --main main`);
  expect(log).not.toContain("next_task.ts"); // nothing claimed
  expect(log).not.toContain("claude ");
  expect(log).not.toContain("factory_loop_watch.ts up"); // it never got going
  expect(read(join(w.wt, ".claude", "factory.json"))).toContain("half"); // the leftovers are still there
  expect(sh(["git", "status", "--porcelain"], { cwd: w.wt }).stdout).toContain("D  factory-loop.sh");
}, T);

test("a loop whose folder is clean gets going and takes back an earlier reason", () => {
  const w = loopWith(agentWorktree);
  const p = sh(["bash", "./factory-loop.sh", "--once"], { cwd: w.work, env: w.env, timeoutMs: 60_000 });
  expect(p.code, p.out).toBe(0);
  const log = read(w.log);
  expect(log).toContain("factory_loop_watch.ts up --agent haile");
  expect(log).not.toContain("--code dirty_worktree");
  expect(log).not.toContain("--code exited");
}, T);

test("a clean folder that can't be brought to main says so; the loop's exit then adds its code unless a reason was given", () => {
  const w = loopWith(agentWorktree);
  must(["git", "remote", "set-url", "origin", join(w.work, "..", "gone.git")], w.work); // the fetch fails
  const p = sh(["bash", "./factory-loop.sh", "--once"], { cwd: w.work, env: w.env, timeoutMs: 60_000 });
  expect(p.code, p.out).toBe(1);
  const log = read(w.log);
  expect(log).toContain(`factory_loop_watch.ts down --agent haile --role coding-agent --code checkout_failed --dir ${w.wt} --main main`);
  // the stub writes no reason, so the exit asks for one "since the start": the real script keeps the one given
  expect(log).toMatch(/factory_loop_watch\.ts down --agent haile --role coding-agent --code exited --exit 1 --since \d+/);
}, T);

// --- the reason, the heartbeat and owner start --stash ----------------------------------------------------------------

const FAKE_TMUX = `#!/usr/bin/env bash
d="$FAKE_TMUX_DIR"; echo "$*" >>"$d/tmux.log"
case "$1" in
  -V) echo "tmux 3.4" ;;
  has-session) [ -e "$d/up" ] ;;
  list-sessions) [ -e "$d/up" ] && echo work-haile ;;
  new-session) touch "$d/up" ;;
  capture-pane) cat "$d/pane" 2>/dev/null ;;
  send-keys) if [ "$4" = "-l" ]; then echo "$6" >>"$d/keys"; else echo "$4" >>"$d/keys"; fi ;;
esac
`;

interface Proj { root: string; d: string; wt: string; env: Env; tmuxDir: string }

/** A project named "work" with the hooks copied and committed, the agents menelik and haile, haile's own folder
 * (work-agents/haile, a worktree), and fake tmux on PATH. */
function project(cfg: Record<string, unknown> = {}): Proj {
  const root = tmp();
  const d = join(root, "work");
  mkdirSync(d);
  gitRepo(d);
  mkdirSync(join(d, ".claude", "hooks"), { recursive: true });
  for (const f of readdirSync(HOOKS)) if (f.endsWith(".ts")) copyFileSync(join(HOOKS, f), join(d, ".claude", "hooks", f));
  copyHookFolders(join(d, ".claude", "hooks"));
  write(join(d, ".claude", "factory.json"), JSON.stringify({ agents: ["menelik", "haile"], ...cfg }));
  write(join(d, "notes.md"), "notes\n");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "the factory");
  const wt = join(root, "work-agents", "haile");
  git(d, "worktree", "add", "-q", "--detach", wt, "HEAD");
  const bin = join(root, "bin");
  writeExe(join(bin, "tmux"), FAKE_TMUX);
  const tmuxDir = join(root, "tmux");
  mkdirSync(tmuxDir);
  const env = envWith(bin, { FAKE_TMUX_DIR: tmuxDir, XDG_STATE_HOME: join(root, "state"), HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"),
    FACTORY_CONFIG_DIR: join(root, "config"), FACTORY_MACHINE_ID: "aaaa1111", FACTORY_AGENT: undefined, FACTORY_LOOP: undefined, FACTORY_ROLE: undefined,
    FACTORY_NAME: undefined, FACTORY_WINDOW: undefined, CLAUDECODE: undefined, CLAUDE_PROJECT_DIR: undefined, FACTORY_AGENTS: undefined,
    TMUX: undefined, FACTORY_NOW: undefined });
  return { root, d, wt, env, tmuxDir };
}

function hook(p: Proj, name: string, args: string[], env: Env = {}): Proc {
  return sh([process.execPath, "--no-env-file", "--config=/dev/null", join(p.d, ".claude", "hooks", `${name}.ts`), ...args],
    { cwd: p.d, env: { ...p.env, ...env }, timeoutMs: 60_000 });
}

function dirty(p: Proj): void {
  write(join(p.wt, "notes.md"), "half a merge\n");
  write(join(p.wt, "scratch.txt"), "untracked\n");
}

interface LsRow { name: string; state: string; detail: string; down: { code: string; message: string; fix: string; lines: string[] } | null }

function row(p: Proj, name: string): LsRow | undefined {
  const r = hook(p, "factory_agents", ["ls", "--json", "--local"]);
  expect(r.code, r.out).toBe(0);
  return (JSON.parse(r.stdout) as { agents: LsRow[] }).agents.find((a) => a.name === name);
}

test("the reason goes to the heartbeat: agents ls shows the agent down with why, the lines and the fix; up takes it back", () => {
  const p = project();
  dirty(p);
  const r = hook(p, "factory_loop_watch", ["down", "--agent", "haile", "--code", "dirty_worktree", "--dir", p.wt, "--main", "main"]);
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toContain(`[haile] can't start: leftover changes in its folder ${p.wt}.`);
  expect(r.stdout).toContain("factory owner start coding-agent haile --stash");
  const h = row(p, "haile");
  expect(h?.state).toBe("down");
  expect(h?.detail).toBe(`down: leftover changes in its folder ${p.wt}`);
  expect(h?.down?.code).toBe("dirty_worktree");
  expect(h?.down?.lines).toEqual([" M notes.md", "?? scratch.txt"]);
  // the loop's exit afterwards doesn't overwrite the reason it gave
  hook(p, "factory_loop_watch", ["down", "--agent", "haile", "--code", "exited", "--exit", "1", "--since", "0"]);
  expect(row(p, "haile")?.down?.code).toBe("dirty_worktree");
  expect(hook(p, "factory_loop_watch", ["up", "--agent", "haile"]).code).toBe(0);
  expect(row(p, "haile")?.down ?? null).toBeNull();
}, T);

test("owner start --stash saves the leftovers aside in the agent's own folder only, with the reason, then starts it", () => {
  const p = project();
  dirty(p);
  write(join(p.d, "notes.md"), "the owner's own edit\n"); // the project folder is never touched
  hook(p, "factory_loop_watch", ["down", "--agent", "haile", "--code", "dirty_worktree", "--dir", p.wt]);
  const r = hook(p, "factory_owner", ["start", "coding-agent", "haile", "--stash"]);
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toContain(`Saved the leftover changes in ${realpathSync(p.wt)} aside`);
  expect(r.stdout).toContain("Started coding-agent-haile");
  expect(sh(["git", "status", "--porcelain"], { cwd: p.wt }).stdout).toBe("");
  const stashes = git(p.d, "stash", "list");
  expect(stashes).toContain(`factory owner start --stash haile: leftover changes in its folder ${p.wt}`);
  expect(stashes.trim().split("\n")).toHaveLength(1);
  expect(git(p.d, "stash", "show", "--include-untracked", "--name-only", "stash@{0}").split("\n").filter(Boolean).sort()).toEqual(["notes.md", "scratch.txt"]);
  expect(read(join(p.d, "notes.md"))).toBe("the owner's own edit\n");
  expect(read(join(p.tmuxDir, "tmux.log"))).toContain("new-session");
  expect(row(p, "haile")?.down ?? null).toBeNull(); // the reason went with the changes
}, T);

test("owner start --stash with nothing left over just starts; a name with no folder of its own is refused, nothing started", () => {
  const p = project();
  const r = hook(p, "factory_owner", ["start", "coding-agent", "haile", "--stash"]);
  expect(r.code, r.out).toBe(0);
  expect(r.stdout).toContain("has no leftover changes; nothing to save aside");
  expect(git(p.d, "stash", "list")).toBe("");
  rmSync(join(p.tmuxDir, "up"));
  rmSync(join(p.tmuxDir, "tmux.log"));
  const none = hook(p, "factory_owner", ["start", "coding-agent", "menelik", "--stash"]);
  expect(none.code).not.toBe(0);
  const e = JSON.parse(none.stderr.trim().split("\n").pop() as string) as { code: string; fix: string };
  expect(e.code).toBe("no_folder");
  expect(read(join(p.tmuxDir, "tmux.log"))).not.toContain("new-session");
}, T);

test("owner help names --stash", () => {
  const p = project();
  expect(hook(p, "factory_owner", ["help"]).stdout).toContain("--stash");
}, T);

// --- the interactive session's watch ----------------------------------------------------------------------------------

const EMPTY = "● Task 7 done: https://github.com/o/r/pull/9.\n\n╭────────╮\n│ ❯      │\n╰────────╯\n  ? for shortcuts\n";
const UNSENT = "● Task 7 done.\n\n╭────────╮\n│ ❯ also fix the │\n╰────────╯\n";
const BUSY = "● Reading the plan\n✻ Thinking… (esc to interrupt)\n│ ❯      │\n";
const PICKER = "│ How should I scope it?\n│ ❯ 1. Split it (Recommended)\n│   2. All in one PR\nEnter to select · ↑/↓ to navigate · Esc to cancel\n";
const NEXT_STUB = `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
appendFileSync(process.env.NEXT_LOG as string, process.argv.slice(2).join(" ") + "\\n");
if (process.env.STUB_READY === "1") { console.log("issue-12 Export to CSV"); process.exit(0); }
process.exit(1);
`;

function watchProject(cfg: Record<string, unknown> = {}): Proj {
  const p = project(cfg);
  writeExe(join(p.d, ".claude", "hooks", "next_task.ts"), NEXT_STUB);
  return p;
}

function look(p: Proj, screen: string, env: Env = {}): string {
  write(join(p.tmuxDir, "pane"), screen);
  const r = hook(p, "factory_loop_watch", ["watch", "--agent", "taytu", "--pane", "%7", "--once"],
    { NEXT_LOG: join(p.root, "next.log"), ...env });
  expect(r.code, r.out).toBe(0);
  return r.stdout.trim();
}

const sent = (p: Proj): string[] => (existsSync(join(p.tmuxDir, "keys")) ? read(join(p.tmuxDir, "keys")).split("\n").filter(Boolean) : []);
const asked = (p: Proj): number => (existsSync(join(p.root, "next.log")) ? read(join(p.root, "next.log")).split("\n").filter(Boolean).length : 0);

/** The done mark of an interactive session whose task is done (`factory_claims.ts done`), `ago` seconds old. */
function doneMark(p: Proj, ago: number): string {
  const mark = join(p.d, ".git", "factory", "done-taytu");
  write(mark, "issue-7");
  const t = Date.now() / 1000 - ago;
  utimesSync(mark, t, t);
  return mark;
}

test("a done task whose session stayed open at an empty prompt gets /next-task typed in a minute later, once", () => {
  const p = watchProject();
  const mark = doneMark(p, 10);
  expect(look(p, EMPTY)).toBe("waiting"); // the Stop hook may still close it
  expect(sent(p)).toEqual([]);
  utimesSync(mark, Date.now() / 1000 - 90, Date.now() / 1000 - 90);
  expect(look(p, EMPTY)).toBe("sent-done");
  expect(sent(p)).toEqual(["/next-task", "Enter"]);
  expect(existsSync(mark)).toBe(false); // used: the next look sends nothing more
  expect(look(p, EMPTY)).toBe("waiting");
  expect(sent(p)).toEqual(["/next-task", "Enter"]);
  expect(read(join(p.tmuxDir, "tmux.log"))).toContain("send-keys -t %7 -l -- /next-task");
}, T);

test("nothing is typed into a prompt that holds text, a busy session, or one with a question open in its picker", () => {
  const p = watchProject();
  doneMark(p, 600);
  expect(look(p, UNSENT)).toBe("busy");
  expect(look(p, BUSY)).toBe("busy");
  expect(look(p, PICKER)).toBe("picker");
  expect(sent(p)).toEqual([]);
}, T);

test("a session idle at an empty prompt with no task gets /next-task after loop.idleNextTaskMinutes, when a task is ready", () => {
  const p = watchProject();
  const at = (s: number): Env => ({ FACTORY_NOW: String(1_800_000_000 + s), STUB_READY: "1" });
  expect(look(p, EMPTY, at(0))).toBe("waiting");
  expect(look(p, EMPTY, at(4 * 60))).toBe("waiting"); // 4 of the default 5 minutes
  expect(asked(p)).toBe(0);
  expect(look(p, EMPTY, at(5 * 60 + 1))).toBe("sent-idle");
  expect(sent(p)).toEqual(["/next-task", "Enter"]);
  expect(read(join(p.root, "next.log"))).toContain("--no-claim"); // it only looked: nothing was claimed for it
}, T);

test("idle with nothing ready: nothing is typed, and it asks again only after another idleNextTaskMinutes", () => {
  const p = watchProject({ loop: { idleNextTaskMinutes: 2 } });
  const at = (s: number): Env => ({ FACTORY_NOW: String(1_800_000_000 + s), STUB_READY: "0" });
  look(p, EMPTY, at(0));
  expect(look(p, EMPTY, at(121))).toBe("waiting");
  expect(look(p, EMPTY, at(150))).toBe("waiting");
  expect(asked(p)).toBe(1);
  expect(look(p, EMPTY, { ...at(242), STUB_READY: "1" })).toBe("sent-idle");
  expect(asked(p)).toBe(2);
  expect(sent(p)).toEqual(["/next-task", "Enter"]);
}, T);

test("idle but holding a task, a screen that changed in between, or loop.idleNextTaskMinutes 0: nothing is typed", () => {
  const off = watchProject({ loop: { idleNextTaskMinutes: 0 } });
  const at = (s: number): Env => ({ FACTORY_NOW: String(1_800_000_000 + s), STUB_READY: "1" });
  look(off, EMPTY, at(0));
  expect(look(off, EMPTY, at(3600))).toBe("waiting");
  expect(sent(off)).toEqual([]);
  const held = watchProject();
  write(join(held.d, ".git", "factory", "claims.json"), JSON.stringify({ checkouts: {},
    tasks: { "issue-12": { agent: "taytu", pid: process.pid, host: hostname(), at: Date.now() / 1000 } } }));
  look(held, EMPTY, at(0));
  expect(look(held, EMPTY, at(600))).toBe("waiting");
  expect(sent(held)).toEqual([]);
  const moved = watchProject();
  look(moved, EMPTY, at(0));
  look(moved, BUSY, at(200)); // it worked in between: the idle time starts again
  expect(look(moved, EMPTY, at(301))).toBe("waiting");
  expect(sent(moved)).toEqual([]);
}, T);

test("the interactive loop runs the watch beside its session in tmux, and stops it when the session ends", async () => {
  const { runOnATerminal } = await import("./loop_support.ts");
  const w = loopWith((work) => work);
  const [, out] = await runOnATerminal(w.work, { ...w.env, TMUX_PANE: "%9", LOOP_WT: undefined }, 45, ["-i", "1"]);
  const log = read(w.log);
  expect(log, out).toMatch(/factory_loop_watch\.ts watch --agent haile --pid \d+ --pane %9/);
  expect(log.indexOf("factory_loop_watch.ts watch")).toBeLessThan(log.indexOf("claude "));
}, T);
