// No questions in Claude Code's picker in factory sessions (#644). An agent that asks the owner in the interactive picker
// ("❯ 1. … (Recommended)  2. …  Enter to select") waits for hours where nobody looks. So:
//   - the agents' rules and every role's settings deny the picker tool (AskUserQuestion), also when main's rules come
//     from a release without that deny, and the skills say a question for the owner is an owner ask on the board;
//   - a session still waiting at a picker shows as `waiting`, "asks the owner: <question>", with its options, in
//     `factory agents ls` (what the heartbeat and the web UI read), never as idle;
//   - `factory say <agent> --choose N` types option N into that picker, and nothing when no picker is on its screen.
//
// tmux is a fake that answers from files (sessions, each session's pane pid and screen) and logs what it was asked; the
// agent's loop and its Claude session are real processes that `ps` shows as `bash .../factory-loop.sh` and `claude`.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { calls, type Env as LoopEnv, KIT_AGENT_SETTINGS, loopProject, startedSettings } from "./loop_support.ts";
import { type Env as RoleEnv, project as roleProject, type Row } from "./roles_support.ts";
import { BUN, KIT, type Proc, read, runHook, sh, tmp, write, writeExe } from "./support.ts";

const PICKER_TOOL = "AskUserQuestion";

/** What Claude Code draws when an agent asks with AskUserQuestion (the screen seen on dev-pc, 8 Nov). */
const PICKER = [
  "● I have a question before I go on.",
  "",
  "╭──────────────────────────────────────────────────────────────╮",
  "│ ☐ Scope                                                      │",
  "│                                                              │",
  "│ How should I scope it?                                       │",
  "│                                                              │",
  "│ ❯ 1. Split it (Recommended)                                  │",
  "│      Three small pull requests, one per part                 │",
  "│   2. All in one PR                                           │",
  "│      One bigger pull request                                 │",
  "│   3. Close as mostly done                                    │",
  "│   4. Type something.                                         │",
  "╰──────────────────────────────────────────────────────────────╯",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
  "",
].join("\n");

// --- the rules deny the picker --------------------------------------------------------------------------------------

type Settings = { permissions?: { allow?: string[]; deny?: string[] } };
const denied = (s: Settings): string[] => s.permissions?.deny ?? [];

test("the kit's rules for coding agents deny the picker tool", () => {
  expect(denied(JSON.parse(read(KIT_AGENT_SETTINGS)) as Settings)).toContain(PICKER_TOOL);
});

test("a coding agent starts with the picker denied, also when main's rules come from a release without that deny", () => {
  const [work, env] = loopProject();
  const kit = JSON.parse(read(KIT_AGENT_SETTINGS)) as Settings;
  kit.permissions = { ...kit.permissions, deny: denied(kit).filter((d) => d !== PICKER_TOOL) };
  write(join(work, ".claude", "factory", "settings.json"), JSON.stringify(kit));
  for (const args of [["add", "-A"], ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "rules without the picker deny"],
    ["push", "-q", "origin", "HEAD:main"]]) expect(sh(["git", ...args], { cwd: work }).code).toBe(0);
  const p = sh(["bash", "./factory-loop.sh", "1"], { cwd: work, env: env as LoopEnv, timeoutMs: 60_000 });
  expect(p.code, p.out).toBe(0);
  expect(denied(startedSettings(calls(env as LoopEnv)[0] as string[]) as Settings)).toContain(PICKER_TOOL);
});

/** The settings `factory_roles.ts claude-flags <role>` gives a role's sessions. */
function roleSettings(work: string, env: RoleEnv, role: string): Settings {
  const p = sh([...BUN, "--config=/dev/null", join(".claude", "hooks", "factory_roles.ts"), "claude-flags", role], { cwd: work, env });
  expect(p.code, p.out).toBe(0);
  const lines = p.stdout.split("\n").filter(Boolean);
  return JSON.parse(lines[lines.indexOf("--settings") + 1] as string) as Settings;
}

test("the dev manager's and the product owner's sessions deny the picker, with or without a profile, artifacts on or off", () => {
  for (const [profile, artifacts] of [[true, true], [false, false], [true, false]] as const) {
    const po: Row = { names: ["eleni"], busyMinutes: 0, idleMinutes: 0, artifacts };
    if (profile) po.profile = ".claude/manager/settings.json";
    const [, work, env] = roleProject({ db: { issues: [] }, cfg: { roles: { "dev-manager": { names: ["lead"] }, "product-owner": po } } });
    // with artifacts on main the product owner may use the artifact tools: the picker stays denied all the same
    for (const role of ["dev-manager", "product-owner"]) expect(denied(roleSettings(work, env, role)), `${role} ${profile} ${artifacts}`).toContain(PICKER_TOOL);
  }
});

test("the next-task, manage-pass and product-pass skills say: no picker, a question for the owner is an owner ask", () => {
  const skills = join(KIT, ".claude", "skills");
  const nextTask = read(join(skills, "next-task", "SKILL.md")) + read(join(skills, "next-task", "questions.md"));
  expect(nextTask).toContain(PICKER_TOOL);
  expect(nextTask).toContain("factory_board.ts ask");
  expect(nextTask).toContain("recommended option");
  expect(nextTask).toMatch(/park (the|it)/);
  for (const s of ["manage-pass", "product-pass"]) {
    const text = read(join(skills, s, "SKILL.md"));
    expect(text, s).toContain(PICKER_TOOL);
    expect(text, s).toContain("owner ask");
    expect(text, s).toMatch(/Never ask in Claude Code's picker/);
  }
});

// --- the heartbeat sees a question waiting in the picker ------------------------------------------------------------

const FAKE_TMUX = `#!/usr/bin/env bash
d="$FAKE_TMUX_DIR"; echo "$*" >>"$d/tmux.log"
t=""; prev=""; for a in "$@"; do [ "$prev" = -t ] && t="\${a#=}"; prev="$a"; done; t="\${t%%:*}"
case "$1" in
  list-sessions) [ -f "$d/sessions" ] || exit 1; case "$*" in *session_activity*) cat "$d/sessions" ;; *) cut -d' ' -f1 "$d/sessions" ;; esac ;;
  has-session) grep -q "^$t " "$d/sessions" 2>/dev/null ;;
  list-panes) cat "$d/$t.pid" 2>/dev/null ;;
  capture-pane) cat "$d/$t.pane" 2>/dev/null ;;
  send-keys)
    if [ "$4" = "-l" ]; then key="$6"; else key="$4"; fi
    echo "$key" >>"$d/keys"
    # a picker in "select" mode chooses at once on a number; in "cursor" mode a number only moves the cursor
    if [ -f "$d/mode" ] && [ "$(cat "$d/mode")" = select ] && [ "$4" = "-l" ]; then printf '● Chose %s\\n❯ \\n' "$key" >"$d/$t.pane"; fi
    if [ -f "$d/mode" ] && [ "$(cat "$d/mode")" = cursor ] && [ "$4" = "-l" ]; then sed -i.bak -e 's/❯ \\([0-9]\\)\\./  \\1./' -e "s/  $key\\./❯ $key./" "$d/$t.pane"; fi
    if [ "$4" = Enter ] && [ -f "$d/mode" ] && [ "$(cat "$d/mode")" = cursor ]; then printf '● Chose by Enter\\n❯ \\n' >"$d/$t.pane"; fi ;;
esac
`;

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

type Env = Record<string, string | undefined>;
interface World { d: string; env: Env; tmuxDir: string }

/** A project folder named proj (sessions are proj-<name>) with the coding agent taytu, on this machine. */
function world(): World {
  const root = tmp();
  const d = join(root, "proj");
  mkdirSync(d);
  sh(["git", "init", "-q", "-b", "main", d]);
  write(join(d, ".claude", "factory.json"), JSON.stringify({ agents: ["taytu"] }));
  writeExe(join(root, "bin", "tmux"), FAKE_TMUX);
  const tmuxDir = join(root, "tmux");
  mkdirSync(tmuxDir);
  write(join(root, "config", "proj.json"), JSON.stringify({ agents: ["taytu"] }));
  const env: Env = { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`, FAKE_TMUX_DIR: tmuxDir,
    FACTORY_CONFIG_DIR: join(root, "config"), XDG_STATE_HOME: join(root, "state"), HOME: root, CLAUDE_CONFIG_DIR: join(root, "claude"),
    FACTORY_MACHINE_ID: "aaaa1111", USER: "owner" };
  for (const k of ["FACTORY_AGENT", "FACTORY_AGENTS", "FACTORY_LOOP", "FACTORY_ROLE", "CLAUDE_PROJECT_DIR", "TMUX", "CLAUDECODE"]) delete env[k];
  return { d, env, tmuxDir };
}

/** taytu's session: a factory loop whose Claude session (a process named claude) shows `screen`. */
function claudeSession(w: World, screen: string): void {
  const script = writeExe(join(w.d, "..", "loop-taytu", "factory-loop.sh"), "#!/bin/bash\n(exec -a claude sleep 600)\n");
  const pane = Bun.spawn(["bash", "-c", `bash ${script}; true`], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  procs.push(pane);
  write(join(w.tmuxDir, "sessions"), `proj-taytu ${Math.floor(Date.now() / 1000) - 600}\n`);
  write(join(w.tmuxDir, "proj-taytu.pid"), `${pane.pid}\n`);
  write(join(w.tmuxDir, "proj-taytu.pane"), screen);
  Bun.sleepSync(300);
}

interface Row2 { name: string; state: string; detail: string; on: string | null; prompt: string | null; ask: { question: string; options: { key: string; label: string }[] } | null }

function taytu(w: World): Row2 {
  const p = runHook("factory_agents", ["ls", "--json", "--local"], { cwd: w.d, env: w.env });
  expect(p.code, p.out).toBe(0);
  const row = (JSON.parse(p.stdout) as { agents: Row2[] }).agents.find((r) => r.name === "taytu");
  expect(row, p.stdout).toBeDefined();
  return row as Row2;
}

test("a session waiting at a question in its picker is waiting on the owner, with the question and its options, not idle", () => {
  const w = world();
  claudeSession(w, PICKER);
  const t = taytu(w);
  expect([t.state, t.detail, t.on]).toEqual(["waiting", "asks the owner: How should I scope it?", "owner"]);
  expect(t.ask).toEqual({ question: "How should I scope it?", options: [
    { key: "1", label: "Split it (Recommended)" }, { key: "2", label: "All in one PR" }, { key: "3", label: "Close as mostly done" }] });
  expect(t.prompt ?? null).toBeNull(); // the picker's "❯ 1." is not text typed in the prompt box
});

test("a permission prompt is a question too; a numbered line typed in the prompt box, or an old answered menu, is not", () => {
  const w = world();
  claudeSession(w, "● Bash(rm -rf dist)\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No, and tell Claude what to do differently (esc)\n");
  expect([taytu(w).state, taytu(w).detail]).toEqual(["waiting", "asks the owner: Do you want to proceed?"]);
  write(join(w.tmuxDir, "proj-taytu.pane"), "● Done.\n╭────╮\n│ ❯ 1. fix the tests │\n╰────╯\n  ? for shortcuts\n");
  expect([taytu(w).state, taytu(w).prompt, taytu(w).ask ?? null]).toEqual(["idle", "unsent", null]);
  write(join(w.tmuxDir, "proj-taytu.pane"), `${PICKER}\n● Chose 1.\n${"● Working on it.\n".repeat(10)}\n│ ❯ │\n  ? for shortcuts\n`);
  expect([taytu(w).state, taytu(w).prompt, taytu(w).ask ?? null]).toEqual(["idle", "empty", null]);
});

// --- factory say --choose -------------------------------------------------------------------------------------------

function choose(w: World, key: string): Proc {
  return runHook("factory_follow", ["say", "taytu", "--choose", key], { cwd: w.d, env: w.env, timeoutMs: 60_000 });
}

const keys = (w: World): string[] => (existsSync(join(w.tmuxDir, "keys")) ? read(join(w.tmuxDir, "keys")).split("\n").filter(Boolean) : []);
const err = (p: Proc): { code: string; message: string; fix: string } => JSON.parse(p.stderr.trim().split("\n").pop() as string);

test("say --choose types the option's number into the picker; one that chooses at once gets no Enter", () => {
  const w = world();
  claudeSession(w, PICKER);
  write(join(w.tmuxDir, "mode"), "select");
  const p = choose(w, "2");
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("Chose 2 in taytu's session");
  expect(keys(w)).toEqual(["2"]);
});

test("say --choose presses Enter when the number only moved the picker's cursor", () => {
  const w = world();
  claudeSession(w, PICKER);
  write(join(w.tmuxDir, "mode"), "cursor");
  const p = choose(w, "3");
  expect(p.code, p.out).toBe(0);
  expect(keys(w)).toEqual(["3", "Enter"]);
});

test("say --choose types nothing when no question is on the screen, or the question has no such option", () => {
  const w = world();
  claudeSession(w, "● Done.\n│ ❯ │\n  ? for shortcuts\n");
  const gone = choose(w, "1");
  expect(gone.code).not.toBe(0);
  expect(err(gone).code).toBe("say-no-question");
  expect(err(gone).fix).toContain("factory follow taytu");
  write(join(w.tmuxDir, "proj-taytu.pane"), PICKER);
  const none = choose(w, "7");
  expect(err(none).code).toBe("say-no-option");
  expect(keys(w)).toEqual([]);
  const bad = choose(w, "yes");
  expect(bad.code).toBe(2);
  expect(keys(w)).toEqual([]);
});

test("factory say's help names --choose", () => {
  expect(runHook("factory_follow", ["help"]).stdout).toContain("factory say <agent> --choose N");
});
