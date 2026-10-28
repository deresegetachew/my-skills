// After rework on a PR, an interactive agent marks it done so its session closes and the loop goes on.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { KIT, read, runHook, sh, tmp, write } from "./support.ts";

const SKILL = join(KIT, ".claude", "skills", "next-task", "SKILL.md");
const REWORK = join(KIT, ".claude", "skills", "next-task", "rework.md"); // the rework step, split out of SKILL.md (#57)

function claims(cwd: string, ...args: string[]): string {
  const p = runHook("factory_claims", args, { cwd });
  expect(p.code, p.stderr).toBe(0);
  return p.stdout.trim();
}

test("a rework mark is seen by the loop", () => {
  const d = tmp();
  sh(["git", "init", "-q", d]);
  write(join(d, ".claude", "factory.json"), JSON.stringify({ agents: ["taytu"] }));
  claims(d, "done", "--agent", "taytu", "--task", "pr-118");
  expect(claims(d, "take-done", "--agent", "taytu")).toBe("pr-118"); // the loop: finished, count down, go on
  expect(claims(d, "take-done", "--agent", "taytu")).toBe(""); // taken once
});

test("the rework step tells an interactive agent to mark it done", () => {
  expect(read(SKILL)).toContain("rework.md"); // the core skill sends a pr-<n> pick there
  const rework = read(REWORK);
  expect(rework).toContain("FACTORY_INTERACTIVE=1");
  expect(rework).toContain("factory_claims.ts done --task pr-<n>`"); // FACTORY_AGENT from the environment: no variable
});
