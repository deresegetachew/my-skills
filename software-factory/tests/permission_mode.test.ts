// How an unattended run gets its permissions (#179): every headless `claude -p` the factory starts carries
// `--permission-mode <permissionMode>` (default acceptEdits, so edits inside the project need no answer and the allow list
// in settings.json covers the commands), the dry runs show it, interactive sessions are left alone, the setting is
// checked, and `factory doctor` prints the mode and says `fix` when a headless run would stall.
import { expect, test } from "bun:test";
import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { calls, type Env, flag, loopProject, runOnATerminal } from "./loop_support.ts";
import { claudeCalls, factory, project } from "./roles_support.ts";
import { doctor as runDoctor, hookLine, lines, machine, project as doctorProject } from "./doctor_support.ts";
import { HOOKS, type Proc, runHook, sh, tmp, write } from "./support.ts";

/** The stub project of the MCP isolation tests, with the real role and config modules the loop asks for the flags. */
function loopProjectWithRoles(): [string, Env] {
  const [work, env] = loopProject();
  for (const name of ["factory_roles.ts", "factory_config.ts", "factory_models.ts"]) {
    copyFileSync(join(HOOKS, name), join(work, ".claude", "hooks", name));
  }
  return [work, env];
}

function loopArgs(cfg: Record<string, unknown> | null = null, ...extra: string[]): string[] {
  const [work, env] = loopProjectWithRoles();
  if (cfg !== null) writeFileSync(join(work, ".claude", "factory.json"), JSON.stringify({ waitMinutes: 0, ...cfg }));
  const p = sh(["bash", "./factory-loop.sh", ...extra, "1"], { cwd: work, env, timeoutMs: 60_000 });
  expect(p.code, p.out).toBe(0);
  const got = calls(env);
  expect(got.length, JSON.stringify(got)).toBe(1);
  return got[0] as string[];
}

test("a headless coding agent run is started in accept edits mode before the prompt", () => {
  const args = loopArgs();
  expect(flag(args, "--permission-mode")).toBe("acceptEdits");
  expect(args.indexOf("--permission-mode")).toBeLessThan(args.indexOf("-p"));
  expect(args.slice(-2)).toEqual(["-p", "/next-task 1.1"]);
});

test("the mode is a setting and default passes no flag so the user's own claude settings decide", () => {
  expect(flag(loopArgs({ permissionMode: "acceptEdits" }), "--permission-mode")).toBe("acceptEdits");
  expect(loopArgs({ permissionMode: "default" })).not.toContain("--permission-mode");
});

test("an interactive session is not given a mode", async () => {
  const [work, env] = loopProjectWithRoles();
  await runOnATerminal(work, env, 45, ["-i", "1"], "q\n");
  const got = calls(env);
  expect(got.length, JSON.stringify(got)).toBe(1);
  expect(got[0]).not.toContain("--permission-mode");
}, 90_000);

test("the coding agent dry run shows the mode", () => {
  const [work, env] = loopProjectWithRoles();
  const p = sh(["bash", "./factory-loop.sh", "--dry-run"], { cwd: work, env, timeoutMs: 60_000 });
  expect(p.code, p.out).toBe(0);
  expect(p.stdout).toContain("would run: claude -p");
  expect(p.stdout).toContain("--permission-mode acceptEdits");
  expect(existsSync(env.CLAUDE_LOG as string), "a dry run starts nothing").toBe(false);
});

const PO_WORK = { issues: [{ number: 7, title: "Pick the palette", labels: [{ name: "factory:needs-product" }] }] };
const UNREVIEWED = { pulls: [{ number: 5, title: "x", draft: false, head: { sha: "a".repeat(40) }, user: { login: "me" } }] };

test("a product owner pass and its dry run carry the mode and the setting changes it", () => {
  const [, work, env] = project({ db: PO_WORK });
  const p = factory(work, env, ["product-owner", "loop", "--once", "--dry-run"]);
  expect(p.stdout).toContain("would run: claude");
  expect(p.stdout).toContain("--permission-mode acceptEdits");
  factory(work, env, ["product-owner", "loop", "--once"]);
  const c = claudeCalls(env)[0] as string;
  expect(c).toContain("--permission-mode acceptEdits");
  expect(c.indexOf("--permission-mode")).toBeLessThan(c.indexOf(" -p "));
});

test("the dev manager's dry run shows the mode", () => {
  const [, work, env] = project({ db: UNREVIEWED });
  const p = factory(work, env, ["dev-manager", "lead", "loop", "--once", "--dry-run"]);
  expect(p.stdout).toContain("--permission-mode acceptEdits");
});

test("a bad mode is refused with the options", () => {
  const d = tmp();
  sh(["git", "init", "-q", "-b", "main", d]);
  write(join(d, ".claude", "factory.json"), JSON.stringify({ agents: ["taytu"], permissionMode: "bypassPermissions" }));
  const p = runHook("factory_settings", ["validate"], { cwd: d });
  expect(p.code).not.toBe(0);
  expect(p.out).toContain("acceptEdits");
});

const ALLOW = ["Bash(git fetch*)", "Bash(git add*)", "Bash(git commit*)", "Bash(git push*)", "Bash(gh pr *)"];

function doctor(cfg: Record<string, unknown>, allow: string[] = ALLOW, homeSettings?: unknown): Proc {
  const d = doctorProject({}, { agents: ["taytu"], ...cfg });
  write(join(d, ".claude", "settings.json"), JSON.stringify({
    hooks: { PreToolUse: [{ hooks: [{ type: "command", command: hookLine("pr-gate") }] }] }, permissions: { allow } }));
  const env = { ...machine(), FACTORY_AGENTS: "taytu" };
  if (homeSettings !== undefined) write(join(env.HOME as string, ".claude", "settings.json"), JSON.stringify(homeSettings));
  return runDoctor(d, env);
}

test("doctor prints the effective mode for unattended runs", () => {
  const p = doctor({});
  expect(lines(p, "ok").some((l) => l.includes("unattended runs") && l.includes("acceptEdits")), p.stdout).toBe(true);
  expect(lines(p, "fix").filter((l) => l.toLowerCase().includes("permission")), p.stdout).toEqual([]);
});

test("doctor says fix when the allow list lacks a command the loop needs", () => {
  let p = doctor({}, ["Bash(git fetch*)"]);
  const fixes = lines(p, "fix").filter((l) => l.includes("git commit") || l.includes("git push"));
  expect(fixes.length > 0 && fixes[0]!.includes("factory.json") && fixes[0]!.includes("permissions.allow"), p.stdout).toBe(true);
  p = doctor({ permissions: { allow: ["Bash(git commit*)", "Bash(git add*)", "Bash(git push*)", "Bash(gh pr *)"] } }, ["Bash(git fetch*)"]);
  expect(lines(p, "fix").filter((l) => l.includes("git commit")), "rules the project lists in factory.json count").toEqual([]);
});

test("doctor says fix for mode default unless the users own settings set one", () => {
  let p = doctor({ permissionMode: "default" });
  expect(lines(p, "fix").some((l) => l.includes("permissionMode") && l.includes("acceptEdits")), p.stdout).toBe(true);
  p = doctor({ permissionMode: "default" }, ALLOW, { permissions: { defaultMode: "acceptEdits" } });
  expect(lines(p, "fix").filter((l) => l.toLowerCase().includes("permission")), p.stdout).toEqual([]);
  expect(lines(p, "ok").some((l) => l.includes("unattended runs") && l.includes("acceptEdits")), p.stdout).toBe(true);
});
