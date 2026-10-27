// The PR gate and the manager gate fail closed (v0.2.0 audit, #43). Claude Code blocks a tool call only when a
// PreToolUse hook exits 2; any other failure (a missing or crashing script exits 1) lets the call through. So the gate's
// hook line turns every non-zero exit into 2. Every hook also starts Bun without BUN_OPTIONS, which would otherwise add
// a `--preload` that runs before the hook. And `gh pr merge --admin` is denied in the agents' settings, so it stays
// refused even when the gate is not there.
import { expect, test } from "bun:test";
import { existsSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { doctor, lines, machine, project } from "./doctor_support.ts";
import { gitRepo, HOOKS, KIT, read, sh, write, writeExe } from "./support.ts";

type Settings = { permissions?: { deny?: string[] }; hooks?: Record<string, { hooks: { command: string }[] }[]> };

const AGENTS = join(KIT, ".claude", "factory", "settings.json");
const MANAGER = join(KIT, ".claude", "manager", "settings.json");

function hookCommands(path: string): string[] {
  const s = JSON.parse(read(path)) as Settings;
  return Object.values(s.hooks ?? {}).flat().flatMap((m) => m.hooks.map((h) => h.command));
}

function gateLine(path: string, script: string): string {
  const line = hookCommands(path).find((c) => c.includes(`.claude/hooks/${script}`));
  expect(line, `${script} in ${path}`).toBeDefined();
  return line as string;
}

// GitHub as the gate sees it: main is the default branch and has no factory.json yet (the defaults apply).
const FAKE_GH = `#!/usr/bin/env bash
case "$1 $2" in
  "repo view") echo main ;;
  *) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
esac
`;

/** A git project with the factory's hooks linked into .claude/hooks, and a fake gh in its bin/. */
function linkedProject(): string {
  const d = gitRepo();
  writeExe(join(d, "bin", "gh"), FAKE_GH);
  const hooks = join(d, ".claude", "hooks");
  write(join(hooks, ".keep"), "");
  for (const f of readdirSync(HOOKS)) if (f.endsWith(".ts")) symlinkSync(join(HOOKS, f), join(hooks, f));
  return d;
}

/** Run a hook line the way Claude Code does: through a shell, the tool call as JSON on stdin. */
function runHook(line: string, d: string, command: string, env: Record<string, string> = {}) {
  return sh(["bash", "-c", line], {
    cwd: d, env: { ...process.env, PATH: `${d}/bin:${process.env.PATH}`, CLAUDE_PROJECT_DIR: d, ...env },
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }), timeoutMs: 60_000,
  });
}

test("the PR gate's hook line lets an allowed command through and refuses a refused one, with the reason", () => {
  const d = linkedProject();
  const line = gateLine(AGENTS, "pr-gate.ts");
  expect(runHook(line, d, "ls -la").code).toBe(0);
  const p = runHook(line, d, "gh pr merge 12 --admin");
  expect(p.code, p.out).toBe(2);
  expect(p.stderr).toContain("--admin");
});

for (const [name, path, script] of [["PR gate", AGENTS, "pr-gate.ts"], ["manager gate", MANAGER, "manager_gate.ts"]] as const) {
  test(`a missing ${name} script blocks the tool call instead of letting it through`, () => {
    const d = linkedProject();
    rmSync(join(d, ".claude", "hooks", script));
    const p = runHook(gateLine(path, script), d, "gh pr merge 12 --admin");
    expect(p.code, p.out).toBe(2);
  });

  test(`a ${name} script that crashes blocks the tool call`, () => {
    const d = linkedProject();
    rmSync(join(d, ".claude", "hooks", script));
    write(join(d, ".claude", "hooks", script), 'throw new Error("broken");\n');
    const p = runHook(gateLine(path, script), d, "gh pr merge 12 --admin");
    expect(p.code, p.out).toBe(2);
  });
}

test("BUN_OPTIONS in the environment cannot preload code into the PR gate", () => {
  const d = linkedProject();
  const mark = join(d, "PRELOADED");
  write(join(d, "p.ts"), `require("node:fs").writeFileSync(${JSON.stringify(mark)}, "ran"); process.exit(0);\n`);
  const p = runHook(gateLine(AGENTS, "pr-gate.ts"), d, "gh pr merge 12 --admin", { BUN_OPTIONS: `--preload=${join(d, "p.ts")}` });
  expect(existsSync(mark), "the preload never ran: " + p.out).toBe(false);
  expect(p.code, p.out).toBe(2);
});

test("every hook in the agents' and the manager's settings starts Bun without BUN_OPTIONS", () => {
  for (const path of [AGENTS, MANAGER]) {
    const commands = hookCommands(path).filter((c) => c.includes(".claude/hooks/"));
    expect(commands.length, path).toBeGreaterThan(0);
    for (const c of commands) expect(c, path).toMatch(/^env -u BUN_OPTIONS bun --no-env-file --config=\/dev\/null /);
  }
});

test("only the gates fail closed: a Stop or session hook that fails does not trap the session", () => {
  for (const path of [AGENTS, MANAGER]) {
    for (const c of hookCommands(path)) {
      const gate = /\.claude\/hooks\/(pr-gate|manager_gate)\.ts/.test(c);
      expect(c.trimEnd().endsWith("|| exit 2"), c).toBe(gate);
    }
  }
});

test("the agents' settings deny gh pr merge --admin, so it stays refused without the gate", () => {
  const deny = (JSON.parse(read(AGENTS)) as Settings).permissions?.deny ?? [];
  expect(deny).toContain("Bash(gh pr merge*--admin*)");
});

function settingsWith(d: string, command: string): void {
  write(join(d, ".claude", "factory", "settings.json"), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }] },
  }));
}

test("factory doctor says to update when the PR gate's hook line does not fail closed or keeps BUN_OPTIONS", () => {
  const env = { ...machine(), FACTORY_AGENTS: "taytu" };
  const kitGate = gateLine(AGENTS, "pr-gate.ts");
  let d = project();
  settingsWith(d, kitGate);
  let p = doctor(d, env);
  expect(lines(p, "fix").filter((l) => l.includes("hook line")), p.stdout).toEqual([]);

  d = project();
  settingsWith(d, kitGate.replace(/\s*\|\|\s*exit 2\s*$/, ""));
  p = doctor(d, env);
  expect(lines(p, "fix").some((l) => l.includes("exit 2") && l.includes("factory update")), p.stdout).toBe(true);

  d = project();
  settingsWith(d, kitGate.replace(/^env -u BUN_OPTIONS /, ""));
  p = doctor(d, env);
  expect(lines(p, "fix").some((l) => l.includes("BUN_OPTIONS") && l.includes("factory update")), p.stdout).toBe(true);
});
