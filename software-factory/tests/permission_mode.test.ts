// How an unattended run gets its permissions (#179): the `permissionMode` setting, and `factory doctor` prints the mode
// and says `fix` when a headless run would stall. (The loop, dry-run, product owner and dev manager cases stay in
// test_permission_mode.py until factory_roles is ported.)
import { expect, test } from "bun:test";
import { join } from "node:path";
import { doctor as runDoctor, hookLine, lines, machine, project } from "./doctor_support.ts";
import { type Proc, runHook, sh, tmp, write } from "./support.ts";

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
  const d = project({}, { agents: ["taytu"], ...cfg });
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
