// The hooks a coding agent's session runs are main's code, not its worktree's (#274). factory_agent_settings.ts
// unpacks `.claude/hooks/` as main has it on origin (links and submodules followed, as for the settings, #258) into
// the git folder, read-only, and names those files by absolute path in the settings it prints. So an agent that puts
// back an older gate from history (`git checkout <old> -- .claude/hooks/pr-gate.ts`, `git switch --detach <old>`)
// still runs main's gate. The deny list also refuses the git commands that restore `.claude/` paths from history.
import { expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KIT_AGENT_SETTINGS, quiet } from "./loop_support.ts";
import { allowedBy, type Permissions } from "./manager_support.ts";
import { HOOKS, read, sh, tmp, write, writeExe } from "./support.ts";

type Hooks = Record<string, { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] }[]>;
type Settings = { permissions: Permissions; hooks: Hooks };

const kit = (): Settings => JSON.parse(read(KIT_AGENT_SETTINGS)) as Settings;

// GitHub as the gate sees it: main is the default branch and has no factory.json yet (the defaults apply).
const FAKE_GH = `#!/usr/bin/env bash
case "$1 $2" in
  "repo view") echo main ;;
  *) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
esac
`;

const ALLOW_ALL = "// a gate that lets everything through\nprocess.exit(0);\n";

function commit(work: string, message: string): void {
  quiet(["git", "add", "-A"], work);
  quiet(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", message], work);
}

/** A clone of a bare origin whose main has the factory's real hooks in `.claude/hooks/` (copied, or as links into
 * `kit/hooks/` when `linked`) and the kit's agents' settings. Returns the clone. */
function project(linked = false): string {
  const d = realpathSync(tmp());
  const origin = join(d, "origin.git");
  const work = join(d, "work");
  quiet(["git", "init", "-q", "--bare", "-b", "main", origin]);
  quiet(["git", "clone", "-q", origin, work]);
  const hooks = join(work, ".claude", "hooks");
  if (linked) {
    cpSync(HOOKS, join(work, "kit", "hooks"), { recursive: true });
    write(join(hooks, ".keep"), "");
    for (const f of readdirSync(HOOKS)) symlinkSync(`../../kit/hooks/${f}`, join(hooks, f));
  } else cpSync(HOOKS, hooks, { recursive: true, dereference: true });
  write(join(work, ".claude", "factory", "settings.json"), read(KIT_AGENT_SETTINGS));
  write(join(work, ".claude", "factory.json"), JSON.stringify({ waitMinutes: 0 }));
  writeExe(join(work, "bin", "gh"), FAKE_GH);
  commit(work, "start");
  quiet(["git", "push", "-q", "origin", "HEAD:main"], work);
  return work;
}

/** Run factory_agent_settings.ts the way the loop does, from the project's folder (main's copy of the script). */
function agentSettings(work: string) {
  return sh(["bun", "--no-env-file", "--config=/dev/null", join(HOOKS, "factory_agent_settings.ts")], { cwd: work, timeoutMs: 60_000 });
}

function commands(s: Settings): string[] {
  return Object.values(s.hooks).flat().flatMap((m) => m.hooks.map((h) => h.command));
}

/** The script a hook line runs: the single-quoted absolute path the factory put in. */
function scriptOf(command: string): string {
  const m = /'(\/[^']+\.ts)'/.exec(command);
  expect(m, command).not.toBeNull();
  return (m as RegExpExecArray)[1] as string;
}

/** Hook lines with the script's folder left out, to compare the shape of a line with the kit's. */
function shape(hooks: Hooks): Hooks {
  const out = structuredClone(hooks);
  for (const m of Object.values(out).flat()) {
    for (const h of m.hooks) {
      h.command = h.command.replace(/'\/[^']+\/hooks\/([\w.-]+)'/g, "<hooks>/$1").replace(/"\$CLAUDE_PROJECT_DIR"\/\.claude\/hooks\//g, "<hooks>/");
    }
  }
  return out;
}

function started(work: string): Settings {
  const p = agentSettings(work);
  expect(p.code, p.out).toBe(0);
  return JSON.parse(read(p.stdout.trim())) as Settings;
}

/** Run a hook line the way Claude Code does: through a shell in the project, the tool call as JSON on stdin. */
function runLine(line: string, work: string, command: string) {
  return sh(["bash", "-c", line], {
    cwd: work, env: { ...process.env, PATH: `${work}/bin:${process.env.PATH}`, CLAUDE_PROJECT_DIR: work },
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }), timeoutMs: 60_000,
  });
}

function writable(path: string): boolean {
  return (statSync(path).mode & 0o222) !== 0;
}

test("every hook line runs main's script from the git folder, read-only, with the kit's line otherwise unchanged", () => {
  const work = project();
  const got = started(work);
  expect(shape(got.hooks)).toEqual(shape(kit().hooks));
  const lines = commands(got);
  expect(lines.length).toBeGreaterThan(0);
  const gitDir = realpathSync(join(work, ".git"));
  for (const line of lines) {
    expect(line).not.toContain("CLAUDE_PROJECT_DIR");
    expect(line).toMatch(/^env -u BUN_OPTIONS bun --no-env-file --config=\/dev\/null '/);
    const script = scriptOf(line);
    expect(script.startsWith(gitDir + "/"), script).toBe(true);
    expect(readFileSync(script, "utf8")).toBe(read(join(HOOKS, script.split("/").pop() as string)));
    expect(writable(script), script).toBe(false);
  }
  const gate = lines.find((l) => l.includes("/pr-gate.ts")) as string;
  expect(gate.endsWith("|| exit 2")).toBe(true);
  // the files a hook imports came along too, and nobody can add one to the folder
  const dir = scriptOf(gate).replace(/\/pr-gate\.ts$/, "");
  expect(existsSync(join(dir, "factory_lib.ts"))).toBe(true);
  expect(writable(dir)).toBe(false);
});

test("an older gate put back in the worktree does not run: main's gate still refuses", () => {
  const work = project();
  // what `git checkout <old> -- .claude/hooks/pr-gate.ts` leaves: a gate that lets everything through
  write(join(work, ".claude", "hooks", "pr-gate.ts"), ALLOW_ALL);
  const gate = commands(started(work)).find((l) => l.includes("/pr-gate.ts")) as string;
  expect(readFileSync(scriptOf(gate), "utf8")).not.toBe(ALLOW_ALL);
  const p = runLine(gate, work, "gh pr merge 12 --admin");
  expect(p.code, p.out).toBe(2);
  expect(p.stderr).toContain("--admin");
});

test("an older commit checked out in the worktree does not change the hooks either", () => {
  const work = project();
  const main = commands(started(work)).map(scriptOf);
  write(join(work, ".claude", "hooks", "pr-gate.ts"), ALLOW_ALL);
  commit(work, "an old gate, never on main");
  quiet(["git", "switch", "-q", "--detach", "HEAD"], work);
  const again = commands(started(work)).map(scriptOf);
  expect(again).toEqual(main);
  for (const s of again) expect(readFileSync(s, "utf8")).not.toBe(ALLOW_ALL);
});

test("hooks that main has as links into the same repo are followed and unpacked as files", () => {
  const work = project(true);
  const got = started(work);
  expect(shape(got.hooks)).toEqual(shape(kit().hooks));
  for (const s of commands(got).map(scriptOf)) {
    expect(readFileSync(s, "utf8")).toBe(read(join(HOOKS, s.split("/").pop() as string)));
  }
});

test("a second start reuses the unpacked hooks, and an unpacked copy that was changed is put back", () => {
  const work = project();
  const first = commands(started(work)).map(scriptOf);
  const gate = first.find((s) => s.endsWith("/pr-gate.ts")) as string;
  const before = statSync(gate).ino;
  const second = commands(started(work)).map(scriptOf);
  expect(second).toEqual(first);
  expect(statSync(gate).ino).toBe(before);
  // an agent that makes the copy writable and weakens it
  const dir = gate.replace(/\/pr-gate\.ts$/, "");
  chmodSync(dir, 0o755);
  chmodSync(gate, 0o644);
  writeFileSync(gate, ALLOW_ALL);
  const third = commands(started(work)).map(scriptOf);
  const gate3 = third.find((s) => s.endsWith("/pr-gate.ts")) as string;
  expect(readFileSync(gate3, "utf8")).toBe(read(join(HOOKS, "pr-gate.ts")));
  expect(writable(gate3)).toBe(false);
});

test("when the hooks can't be unpacked it refuses, starts nothing and leaves nothing half written", () => {
  const work = project();
  const root = join(work, ".git", "factory-hooks");
  write(join(root, ".keep"), "");
  rmSync(join(root, ".keep"));
  chmodSync(root, 0o555); // nothing can be written there
  try {
    const p = agentSettings(work);
    expect(p.code, p.out).toBe(1);
    expect(p.stdout.trim()).toBe("");
    const err = JSON.parse(p.stderr.trim()) as { code: string; message: string; fix: string };
    expect(err.code).toBe("hooks_not_unpacked");
    expect(err.message).toContain("No session was started");
    expect(err.fix.length).toBeGreaterThan(0);
    expect(readdirSync(root)).toEqual([]);
    expect(existsSync(join(work, ".git", "factory-settings.json"))).toBe(false);
  } finally {
    chmodSync(root, 0o755);
  }
});

test("main without a hooks folder is refused and no session starts", () => {
  const work = project();
  quiet(["git", "rm", "-q", "-r", ".claude/hooks"], work);
  commit(work, "no hooks");
  quiet(["git", "push", "-q", "origin", "HEAD:main"], work);
  const p = agentSettings(work);
  expect(p.code, p.out).toBe(1);
  expect(p.stdout.trim()).toBe("");
  expect((JSON.parse(p.stderr.trim()) as { code: string }).code).toBe("no_main_hooks");
});

test("the agents' settings deny restoring .claude/ from history and touching the unpacked hooks", () => {
  // denied: refused by a deny rule even when everything else is allowed
  const denyOnly: Permissions = { allow: ["Bash(*)"], deny: kit().permissions.deny };
  for (const c of [
    "git checkout HEAD~3 -- .claude/hooks/pr-gate.ts",
    "git checkout v0.1.0 .claude/hooks",
    "git checkout HEAD~1 -- ./.claude/factory/settings.json",
    "git restore --source=HEAD~3 .claude/hooks/pr-gate.ts",
    "git restore -s HEAD~3 -- .claude",
    "git restore --source HEAD~3 --staged --worktree .claude/settings.json",
    "git checkout-index -f .claude/hooks/pr-gate.ts",
    "git read-tree HEAD~3",
    "git -C . checkout HEAD~3 -- .claude/hooks",
    "git reset HEAD~3 -- .claude/hooks",
    "chmod -R u+w .git/factory-hooks",
    "rm -rf .git/factory-hooks/abc",
  ]) expect(allowedBy(denyOnly, c), c).toBe(false);
  for (const c of ["git restore src/a.ts", "git restore --source=HEAD~1 src/a.ts"]) expect(allowedBy(denyOnly, c), c).toBe(true);
  // what an agent does every task still runs without asking
  const perms = kit().permissions;
  for (const c of ["git checkout -b task/12-fix", "git checkout main", "git switch -c task/12-fix",
    "git checkout -- src/a.ts", "git show HEAD", "git status"]) expect(allowedBy(perms, c), c).toBe(true);
});
